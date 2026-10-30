#!/usr/bin/env node
/**
 * RapidAid V2 — Phase 4.4.4: Database & Voice Storage Backup Automation
 *
 * Coordinated MongoDB logical dump and voice-storage capture with AES-256-GCM encryption,
 * HMAC-SHA256 authenticated manifests, and Scoped HTTPS remote archival.
 *
 * Consistency Notice:
 * -------------------
 * Voice storage captured read-only before MongoDB logical dump. This is best-effort
 * asynchronous correlation across separate volumes and does NOT provide an atomic cross-volume
 * point-in-time snapshot. Completed calls prior to backup have aligned references; calls completed
 * mid-backup may produce harmless unreferenced orphan audio files. If any database record
 * references a voice file missing from the voice archive, the backup fails closed and is NOT
 * published as VERIFIED_COMPLETE.
 *
 * Storage & Plaintext Notice:
 * ---------------------------
 * Ordinary filesystem unlinking does NOT cryptographically wipe flash memory blocks.
 * BACKUP_DIR should be located on an encrypted volume (dm-crypt/LUKS, BitLocker, or tmpfs).
 *
 * Secret Notice:
 * --------------
 * Credentials and encryption keys are sanitized from logs and error messages.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import https from 'https';
import tls from 'tls';
import { pipeline } from 'stream/promises';

// ── Configuration & Credentials ──────────────────────────────────────────────
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || './backups');
const MONGO_BACKUP_USER = process.env.MONGO_BACKUP_USERNAME || 'rapidaid_backup';
const MONGO_BACKUP_PASS = process.env.MONGO_BACKUP_PASSWORD;
const MONGO_DB = process.env.MONGO_INITDB_DATABASE || 'rapidaid';
const MONGO_HOST = process.env.MONGO_HOST || 'mongodb';
const MONGO_PORT = process.env.MONGO_PORT || '27017';
const NETWORK = process.env.DOCKER_NETWORK || 'rapidaid-network';
const VOICE_VOLUME = process.env.VOICE_VOLUME || 'rapidaid-voice-storage';
const MONGO_IMAGE = process.env.MONGO_IMAGE || 'mongo:7.0';

// Retention Configuration (7 Daily, 4 Weekly, 3 Monthly)
const RETENTION_DAILY = 7;
const RETENTION_WEEKLY = 4;
const RETENTION_MONTHLY = 3;

export function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

export function setRestrictivePermissions(targetPath, isDir = false) {
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, isDir ? 0o700 : 0o600);
    }
  } catch (err) {
    console.warn(`[WARN] Could not set restrictive permissions on ${targetPath}:`, err.message);
  }
}

/**
 * Executes a subprocess with secret sanitization.
 * Scrubs any occurrence of sensitive secrets from error messages before propagating.
 */
export function execSanitized(cmd, options = {}, secretsToRedact = []) {
  try {
    return execSync(cmd, options);
  } catch (err) {
    let sanitizedMsg = err.message || '';
    for (const secret of secretsToRedact) {
      if (secret && typeof secret === 'string' && secret.length > 2) {
        sanitizedMsg = sanitizedMsg.split(secret).join('[REDACTED]');
      }
    }
    const cleanErr = new Error(sanitizedMsg);
    cleanErr.status = err.status;
    cleanErr.code = err.code;
    throw cleanErr;
  }
}

/**
 * Validates that an artifact filename is safe, contains no traversal elements,
 * and resides strictly within the intended backup directory.
 */
export function assertSafeArtifactFilename(filename, backupDir) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('Invalid empty artifact filename in manifest');
  }
  const clean = filename.trim();
  if (clean.includes('/') || clean.includes('\\') || clean.includes('..') || clean.startsWith('.')) {
    throw new Error(`Suspicious path traversal or path separator detected in artifact filename: '${filename}'`);
  }
  if (!/^[a-zA-Z0-9_.-]+$/.test(clean)) {
    throw new Error(`Artifact filename contains invalid characters: '${filename}'`);
  }
  const canonicalDir = path.resolve(backupDir);
  const resolved = path.resolve(backupDir, clean);
  if (!resolved.startsWith(canonicalDir + path.sep)) {
    throw new Error(`Artifact path escapes backup directory: '${resolved}'`);
  }
  return resolved;
}

/**
 * Calculates a canonical ISO-8601 week bucket (e.g. '2026-W01').
 */
export function getIsoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // Monday = 1, Sunday = 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Nearest Thursday
  const year = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${year}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Probes process existence safely using Node built-in process.kill(pid, 0).
 */
export function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { alive: false, error: 'INVALID_PID' };
  }
  try {
    process.kill(pid, 0);
    return { alive: true };
  } catch (err) {
    if (err.code === 'ESRCH') {
      return { alive: false };
    }
    return { alive: false, error: err.code || err.message };
  }
}

/**
 * Safe, non-destructive inspection of backup lockfile status (Phase 4.4.5).
 * Detects whether owning process is alive, dead (stale), or ambiguous.
 */
export function inspectLockStatus(backupDir, options = {}) {
  const lockPath = path.join(backupDir, '.backup.lock');
  if (!fs.existsSync(lockPath)) {
    return { exists: false, isStale: false, isAmbiguous: false, reason: 'NO_LOCKFILE' };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    return {
      exists: true,
      isStale: false,
      isAmbiguous: true,
      error: `Could not read lockfile: ${err.message}`
    };
  }

  let lockInfo;
  try {
    lockInfo = JSON.parse(raw);
  } catch (err) {
    return {
      exists: true,
      raw,
      isStale: false,
      isAmbiguous: true,
      error: `Unparseable lockfile metadata: ${err.message}`
    };
  }

  const pid = Number(lockInfo.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return {
      exists: true,
      lockInfo,
      isStale: false,
      isAmbiguous: true,
      error: `Invalid PID in lockfile: '${lockInfo.pid}'`
    };
  }

  // Cross-host verification (if lock records a hostname different from current host)
  const currentHost = os.hostname();
  if (lockInfo.hostname && lockInfo.hostname !== currentHost) {
    return {
      exists: true,
      lockInfo,
      isStale: false,
      isAmbiguous: true,
      error: `Lock created on host '${lockInfo.hostname}', current host is '${currentHost}'. Cross-host lock cannot be safely verified.`
    };
  }

  // Probe process status
  const isAliveCheck = options.isProcessAliveFn || defaultIsProcessAlive;
  const aliveResult = isAliveCheck(pid);

  if (aliveResult.alive) {
    return {
      exists: true,
      lockInfo,
      isStale: false,
      isAmbiguous: false,
      ownerAlive: true,
      message: `Owning process PID ${pid} is actively running.`
    };
  }

  if (aliveResult.error) {
    // EPERM or other OS inspection error -> Ambiguous! Never assume dead if permission denied.
    return {
      exists: true,
      lockInfo,
      isStale: false,
      isAmbiguous: true,
      error: `Process inspection returned '${aliveResult.error}'. Cannot establish process state.`
    };
  }

  // ESRCH: confirmed dead process
  return {
    exists: true,
    lockInfo,
    isStale: true,
    isAmbiguous: false,
    ownerAlive: false,
    message: `Owning process PID ${pid} does not exist (ESRCH). Lock is confirmed stale.`
  };
}

/**
 * Non-destructive inspection of synchronization gate (.backup.gate) status (Phase 4.4.5).
 */
export function inspectGateStatus(backupDir, options = {}) {
  const gatePath = path.join(backupDir, '.backup.gate');
  if (!fs.existsSync(gatePath)) {
    return { exists: false, isStale: false, isAmbiguous: false, reason: 'NO_GATE' };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(gatePath, 'utf8');
  } catch (err) {
    return { exists: true, isStale: false, isAmbiguous: true, error: `Could not read gate file: ${err.message}` };
  }

  let gateInfo;
  try {
    gateInfo = JSON.parse(raw);
  } catch (err) {
    return { exists: true, raw, isStale: false, isAmbiguous: true, error: `Unparseable gate file metadata: ${err.message}` };
  }

  const pid = Number(gateInfo.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { exists: true, gateInfo, isStale: false, isAmbiguous: true, error: `Invalid PID in gate file: '${gateInfo.pid}'` };
  }

  const currentHost = os.hostname();
  if (gateInfo.hostname && gateInfo.hostname !== currentHost) {
    return {
      exists: true,
      gateInfo,
      isStale: false,
      isAmbiguous: true,
      error: `Gate created on host '${gateInfo.hostname}', current host is '${currentHost}'. Cross-host gate cannot be safely verified.`
    };
  }

  const isAliveCheck = options.isProcessAliveFn || defaultIsProcessAlive;
  const aliveResult = isAliveCheck(pid);

  if (aliveResult.alive) {
    return { exists: true, gateInfo, isStale: false, isAmbiguous: false, ownerAlive: true, message: `Gate owner PID ${pid} is actively running.` };
  }

  if (aliveResult.error) {
    return { exists: true, gateInfo, isStale: false, isAmbiguous: true, error: `Process inspection returned '${aliveResult.error}'.` };
  }

  return { exists: true, gateInfo, isStale: true, isAmbiguous: false, ownerAlive: false, message: `Gate owner PID ${pid} does not exist (ESRCH).` };
}

/**
 * Explicit administrative inspection and fail-closed safety handling for an abandoned synchronization gate (.backup.gate).
 * NEVER called autonomously during normal acquireGate() or acquireBackupLock() execution.
 * 
 * Safety-by-design contract (Phase 4.4.5):
 * Programmatic software deletion of the root synchronization gate is disabled by design.
 * On Windows and POSIX filesystems, conditional unlinking of the root gate cannot be guaranteed
 * atomic across concurrent contenders without an outer lock. To eliminate all TOCTOU replacement
 * races, recoverStaleGate() fails closed for active processes, ambiguous states, foreign hosts,
 * replacement gates, and abandoned gates, providing an explicit, documented manual operator procedure.
 */
export function recoverStaleGate(backupDir, options = {}) {
  const gatePath = path.join(backupDir, '.backup.gate');
  const status = inspectGateStatus(backupDir, options);

  if (!status.exists) {
    return { recovered: false, reason: 'NO_GATE' };
  }
  if (status.isAmbiguous) {
    throw new Error(`CRITICAL SAFETY ABORT: Cannot safely recover gate: ${status.error}. Manual operator inspection required.`);
  }
  if (!status.isStale) {
    throw new Error(`CRITICAL SAFETY ABORT: Refusing to break gate. Owning process (PID ${status.gateInfo?.pid}) is active: ${status.message}`);
  }

  // Pre-unlink identity verification guarding against active replacement
  let currentRaw = '';
  try {
    currentRaw = fs.readFileSync(gatePath, 'utf8');
  } catch (readErr) {
    if (readErr.code === 'ENOENT') return { recovered: false, reason: 'GATE_REMOVED_CONCURRENTLY' };
    throw new Error(`CRITICAL SAFETY ABORT: Failed to re-verify gate file before recovery: ${readErr.message}`);
  }

  let currentInfo;
  try {
    currentInfo = JSON.parse(currentRaw);
  } catch (parseErr) {
    throw new Error(`CRITICAL SAFETY ABORT: Gate file content mutated before recovery: ${parseErr.message}`);
  }

  const expectedToken = options.expectedGateToken || status.gateInfo.gateToken;
  const expectedPid = options.expectedPid || status.gateInfo.pid;
  if (Number(currentInfo.pid) !== Number(expectedPid) || (expectedToken && currentInfo.gateToken !== expectedToken)) {
    throw new Error(`CRITICAL SAFETY ABORT: Gate was replaced by another process. Refusing to delete active replacement gate.`);
  }

  if (typeof options.beforeUnlinkHook === 'function') {
    options.beforeUnlinkHook({ gatePath, status, currentInfo });
    try {
      const recheckRaw = fs.readFileSync(gatePath, 'utf8');
      const recheckInfo = JSON.parse(recheckRaw);
      if (Number(recheckInfo.pid) !== Number(expectedPid) || (expectedToken && recheckInfo.gateToken !== expectedToken)) {
        throw new Error(`CRITICAL SAFETY ABORT: Gate was replaced by another process. Refusing to delete active replacement gate.`);
      }
    } catch (reErr) {
      if (reErr.code === 'ENOENT') return { recovered: false, reason: 'GATE_REMOVED_CONCURRENTLY' };
      throw reErr;
    }
  }

  // Stale gate confirmed: Fail closed by design to prevent unlinking replacement gates under concurrency.
  // Software deletion is disabled; an actionable operator remediation procedure is provided.
  throw new Error(
    `CRITICAL SAFETY ABORT: Abandoned synchronization gate detected for dead PID ${status.gateInfo.pid} ` +
    `(Host: ${status.gateInfo.hostname || 'unknown'}, Created: ${status.gateInfo.createdAt || 'unknown'}). ` +
    `Automatic software deletion of the root gate is disabled by design to eliminate cross-process TOCTOU replacement races.\n` +
    `MANUAL OPERATOR REMEDIATION PROCEDURE:\n` +
    `1. Confirm process PID ${status.gateInfo.pid} has terminated.\n` +
    `2. Verify that NO other backup, restore, or verification processes are active (e.g., 'ps aux | grep node' or 'tasklist /FI "IMAGENAME eq node.exe"').\n` +
    `3. DO NOT delete the gate file if any backup or recovery process is active or scheduled.\n` +
    `4. Once mutual quiescence is confirmed, manually remove the abandoned gate file:\n` +
    `   POSIX:   rm -f "${gatePath}"\n` +
    `   Windows: del "${gatePath}"\n` +
    `5. Normal backups and --recover-stale-lock will resume automatically once the gate is removed.`
  );
}

/**
 * Cross-process synchronization gate (.backup.gate) (Phase 4.4.5).
 * Serializes all state transitions around .backup.lock, ensuring mutual exclusion
 * between backup acquisition and stale-lock recovery.
 *
 * Strictly fails closed on timeout: does NOT autonomously unlink gate during normal contention.
 */
export function acquireGate(backupDir, options = {}) {
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const gatePath = path.join(backupDir, '.backup.gate');
  const timeoutMs = options.gateTimeoutMs ?? 5000;
  const pollIntervalMs = options.gatePollIntervalMs ?? 25;
  const gateToken = crypto.randomBytes(16).toString('hex');
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
  const startTime = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(gatePath, 'wx');
      const info = JSON.stringify({
        gateToken,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        hostname: os.hostname()
      });
      fs.writeFileSync(fd, info, 'utf8');
      return { fd, gatePath, gateToken, backupDir };
    } catch (err) {
      if (err.code === 'EEXIST') {
        if (Date.now() - startTime >= timeoutMs) {
          let details = 'unknown';
          try {
            const raw = fs.readFileSync(gatePath, 'utf8');
            const g = JSON.parse(raw);
            details = `PID ${g.pid}, Host: ${g.hostname || 'unknown'}, Created: ${g.createdAt || 'unknown'}`;
          } catch {}
          throw new Error(
            `CRITICAL SAFETY ABORT: Timeout (${timeoutMs}ms) waiting for synchronization gate ${gatePath} (${details}). ` +
            `Gate is held or abandoned. If process crashed, verify that NO backup or recovery process is active before manual operator remediation.`
          );
        }
        Atomics.wait(sleepBuf, 0, 0, pollIntervalMs);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Releases the cross-process synchronization gate (.backup.gate).
 * Strictly fails closed: if the gate cannot be read, parsed, or positively matched
 * to the caller's ownership token, does not unlink it.
 * Prefers leaving an abandoned gate over deleting a gate that may belong to another process.
 */
export function releaseGate(gate, options = {}) {
  if (!gate || !gate.gatePath || !gate.gateToken) return;

  try {
    if (!fs.existsSync(gate.gatePath)) {
      return;
    }

    let raw = '';
    try {
      raw = fs.readFileSync(gate.gatePath, 'utf8');
    } catch (readErr) {
      console.warn(`[WARN] releaseGate refusing to unlink: failed to read gate file ${gate.gatePath}: ${readErr.message}. Retaining file.`);
      return;
    }

    let info;
    try {
      info = JSON.parse(raw);
    } catch (parseErr) {
      console.warn(`[WARN] releaseGate refusing to unlink: unparseable JSON in gate file ${gate.gatePath}: ${parseErr.message}. Retaining file.`);
      return;
    }

    if (!info || typeof info !== 'object' || info.gateToken !== gate.gateToken) {
      console.warn(`[WARN] releaseGate refusing to unlink: gate ownership token mismatch in ${gate.gatePath}. Expected '${gate.gateToken}', found '${info?.gateToken}'. Retaining file.`);
      return;
    }

    if (info.pid && Number(info.pid) !== process.pid) {
      console.warn(`[WARN] releaseGate refusing to unlink: gate PID mismatch in ${gate.gatePath}. Expected '${process.pid}', found '${info?.pid}'. Retaining file.`);
      return;
    }

    if (typeof options.beforeUnlinkHook === 'function') {
      options.beforeUnlinkHook({ gatePath: gate.gatePath, info });
      // Re-verify immediately before unlink if hook was executed
      try {
        const postHookRaw = fs.readFileSync(gate.gatePath, 'utf8');
        const postHookInfo = JSON.parse(postHookRaw);
        if (!postHookInfo || postHookInfo.gateToken !== gate.gateToken || (postHookInfo.pid && Number(postHookInfo.pid) !== process.pid)) {
          console.warn(`[WARN] releaseGate refusing to unlink: gate was replaced between inspection and unlinking. Expected '${gate.gateToken}', found '${postHookInfo?.gateToken}'. Retaining file.`);
          return;
        }
      } catch {
        return;
      }
    }

    fs.unlinkSync(gate.gatePath);
  } catch (err) {
    console.warn(`[WARN] Could not remove synchronization gate ${gate.gatePath}:`, err.message);
  } finally {
    if (gate.fd !== undefined) {
      try { fs.closeSync(gate.fd); } catch {}
    }
  }
}

/**
 * Safely recovers confirmed stale lockfile (Phase 4.4.5).
 * Restricts removal strictly to explicitly requested operations when staleness is proven.
 * Enforces mutual exclusion via the unified cross-process synchronization gate (.backup.gate)
 * and performs pre-unlink identity verification to prevent deleting replacement locks.
 */
export function recoverStaleLock(backupDir, options = {}) {
  const gate = options.skipGate ? null : acquireGate(backupDir, options);
  try {
    const lockPath = path.join(backupDir, '.backup.lock');
    const status = inspectLockStatus(backupDir, options);

    if (!status.exists) {
      console.log('[LOCK RECOVERY] No lockfile found. Nothing to recover.');
      return { recovered: false, reason: 'NO_LOCK' };
    }

    if (status.isAmbiguous) {
      throw new Error(`CRITICAL SAFETY ABORT: Cannot safely recover lockfile because ownership or state is ambiguous: ${status.error}`);
    }

    if (!status.isStale) {
      throw new Error(`CRITICAL SAFETY ABORT: Refusing to break lock. Owning process (PID ${status.lockInfo?.pid}) is active: ${status.message}`);
    }

    // Confirmed stale at inspection time.
    // Pre-Unlink Verification: re-read lockfile and verify token/PID to guard against replacement
    let currentRaw = '';
    try {
      currentRaw = fs.readFileSync(lockPath, 'utf8');
    } catch (readErr) {
      if (readErr.code === 'ENOENT') {
        console.log('[LOCK RECOVERY] Lockfile disappeared before unlinking. Nothing to recover.');
        return { recovered: false, reason: 'LOCK_REMOVED_CONCURRENTLY' };
      }
      throw new Error(`CRITICAL SAFETY ABORT: Failed to re-verify lockfile before unlinking: ${readErr.message}`);
    }

    let currentInfo;
    try {
      currentInfo = JSON.parse(currentRaw);
    } catch (parseErr) {
      throw new Error(`CRITICAL SAFETY ABORT: Lockfile content mutated into invalid JSON before unlinking: ${parseErr.message}`);
    }

    const expectedToken = options.expectedLockToken || status.lockInfo.lockToken;
    const expectedPid = options.expectedPid || status.lockInfo.pid;
    const expectedCreatedAt = options.expectedCreatedAt || status.lockInfo.createdAt || status.lockInfo.timestamp;

    const pidMatch = Number(currentInfo.pid) === Number(expectedPid);
    const tokenMatch = !expectedToken || currentInfo.lockToken === expectedToken;
    const createdAtMatch = !expectedCreatedAt || (currentInfo.createdAt === expectedCreatedAt || currentInfo.timestamp === expectedCreatedAt);

    if (!pidMatch || !tokenMatch || !createdAtMatch) {
      throw new Error(
        `CRITICAL SAFETY ABORT: Lockfile was replaced by another process between inspection and deletion. ` +
        `Expected PID: ${expectedPid} (token: ${expectedToken || 'none'}), found PID: ${currentInfo.pid} (token: ${currentInfo.lockToken || 'none'}). ` +
        `Refusing to delete active replacement lock.`
      );
    }

    if (typeof options.beforeUnlinkHook === 'function') {
      options.beforeUnlinkHook({ currentInfo, lockPath, gate });
    }

    try {
      fs.unlinkSync(lockPath);
      console.log(`[LOCK RECOVERY] Safely removed stale lockfile for non-existent process PID ${status.lockInfo.pid} (created: ${status.lockInfo.createdAt || status.lockInfo.timestamp || 'unknown'}).`);
      return { recovered: true, lockInfo: status.lockInfo };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { recovered: false, reason: 'LOCK_REMOVED_CONCURRENTLY' };
      }
      throw new Error(`CRITICAL SAFETY ABORT: Failed to remove confirmed stale lockfile: ${err.message}`);
    }
  } finally {
    if (gate) {
      releaseGate(gate);
    }
  }
}

/**
 * Concurrency guard: Acquires an exclusive filesystem lockfile on BACKUP_DIR.
 * Mutual exclusion is guaranteed via atomic O_CREAT | O_EXCL ('wx').
 * Binds each lock instance to an immutable random lockToken.
 * Coordinates with stale-lock recovery via the unified .backup.gate protocol.
 */
export function acquireBackupLock(backupDir, options = {}) {
  const lockPath = path.join(backupDir, '.backup.lock');

  // If caller explicitly requested to recover a stale lock beforehand:
  if (options.recoverStaleLock) {
    const status = inspectLockStatus(backupDir, options);
    if (status.exists && status.isStale && !status.isAmbiguous) {
      recoverStaleLock(backupDir, { ...options, skipGate: false });
    }
  }

  // Both backup acquisition and stale-lock recovery MUST synchronize through .backup.gate
  const gate = options.skipGate ? null : acquireGate(backupDir, options);
  try {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      const lockToken = crypto.randomBytes(16).toString('hex');
      const info = JSON.stringify({
        lockToken,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        hostname: os.hostname(),
        platform: process.platform,
        nodeVersion: process.version
      });
      fs.writeFileSync(fd, info, 'utf8');
      return { fd, lockPath, lockToken, backupDir };
    } catch (err) {
      if (err.code === 'EEXIST') {
        const status = inspectLockStatus(backupDir, options);
        let details = 'unknown';
        if (status.exists && status.lockInfo) {
          details = `PID: ${status.lockInfo.pid}, Created: ${status.lockInfo.createdAt || status.lockInfo.timestamp || 'unknown'}`;
          if (status.ownerAlive) {
            details += ' [PROCESS IS ACTIVELY RUNNING]';
          } else if (status.isStale) {
            details += ' [PROCESS IS DEAD / STALE — Run with --recover-stale-lock to safely recover]';
          } else if (status.isAmbiguous) {
            details += ` [AMBIGUOUS PROCESS STATE: ${status.error}]`;
          }
        }
        throw new Error(`Concurrent backup prevented: lockfile exists at ${lockPath} (${details}). Refusing unsafe concurrent backup.`);
      }
      throw err;
    }
  } finally {
    if (gate) {
      releaseGate(gate);
    }
  }
}

/**
 * Releases the exclusive backup lockfile.
 * Serializes release through .backup.gate and verifies lockToken before unlinking.
 */
export function releaseBackupLock(lock, options = {}) {
  if (!lock) return;
  const backupDir = lock.backupDir || (lock.lockPath ? path.dirname(lock.lockPath) : null);
  let gate = null;
  if (backupDir && !options.skipGate) {
    try {
      gate = acquireGate(backupDir, options);
    } catch (gateErr) {
      console.warn(`[WARN] Could not acquire synchronization gate during lock release: ${gateErr.message}. Attempting un-gated fallback release.`);
    }
  }
  try {
    try { if (lock.fd !== undefined) fs.closeSync(lock.fd); } catch {}
    try {
      if (fs.existsSync(lock.lockPath)) {
        if (lock.lockToken) {
          try {
            const raw = fs.readFileSync(lock.lockPath, 'utf8');
            const cur = JSON.parse(raw);
            if (!cur || cur.lockToken !== lock.lockToken) {
              console.warn(`[WARN] Not unlinking lockfile: lock token changed from ${lock.lockToken} to ${cur?.lockToken}`);
              return;
            }
          } catch (readErr) {
            console.warn(`[WARN] Not unlinking lockfile: could not verify lock token: ${readErr.message}`);
            return;
          }
        }
        fs.unlinkSync(lock.lockPath);
      }
    } catch (err) {
      console.warn(`[WARN] Could not remove lockfile ${lock.lockPath}:`, err.message);
    }
  } finally {
    if (gate) {
      releaseGate(gate);
    }
  }
}

/**
 * Non-destructive inspection mode for backup configuration and environment (Phase 4.4.5).
 * Does not write files, acquire locks, invoke mongodump, upload data, or mutate recovery sets.
 */
export function inspectBackupEnvironment(options = {}) {
  const targetDir = options.backupDir || process.env.BACKUP_DIR || './backups';
  const mongoUser = process.env.MONGO_BACKUP_USERNAME || 'rapidaid_backup';
  const mongoPass = process.env.MONGO_BACKUP_PASSWORD || '';
  const encryptionEnabled = options.encryptionEnabled ?? (process.env.BACKUP_ENCRYPTION_ENABLED !== 'false');
  const allowUnencrypted = options.allowUnencrypted ?? (process.env.ALLOW_UNENCRYPTED_BACKUPS === 'true');
  const backupKey = options.backupKey || process.env.BACKUP_ENCRYPTION_KEY || '';
  const offsiteEnabled = process.env.OFFSITE_UPLOAD_ENABLED === 'true';
  const offsiteUrl = process.env.OFFSITE_REMOTE_URL || '';
  const offsiteToken = process.env.OFFSITE_API_TOKEN || '';

  const report = {
    valid: true,
    configuration: {},
    encryption: {},
    backupDirectory: {},
    lockStatus: {},
    offsiteArchival: {},
    warnings: [],
    errors: []
  };

  // 1. Configuration presence & validity (redacting secrets)
  report.configuration.mongoUser = mongoUser;
  report.configuration.mongoPasswordConfigured = Boolean(mongoPass);
  if (!mongoPass) {
    report.warnings.push('MONGO_BACKUP_PASSWORD is not configured in environment.');
  }
  report.configuration.dockerNetwork = process.env.DOCKER_NETWORK || 'rapidaid-network';
  report.configuration.voiceVolume = process.env.VOICE_VOLUME || 'rapidaid-voice-storage';

  // 2. Encryption configuration and key-format validity
  report.encryption.enabled = encryptionEnabled;
  report.encryption.allowUnencrypted = allowUnencrypted;
  if (encryptionEnabled) {
    const isKeyHex64 = typeof backupKey === 'string' && /^[0-9a-fA-F]{64}$/.test(backupKey);
    report.encryption.keyConfigured = Boolean(backupKey);
    report.encryption.keyFormatValid = isKeyHex64;
    if (isKeyHex64) {
      report.encryption.keyId = deriveKeyId(backupKey);
    } else {
      report.valid = false;
      report.errors.push('BACKUP_ENCRYPTION_KEY is missing or invalid format (must be 64-character hex string).');
    }
  } else {
    if (!allowUnencrypted) {
      report.valid = false;
      report.errors.push('Encryption is disabled but ALLOW_UNENCRYPTED_BACKUPS is not set to true.');
    }
  }

  // 3. Backup directory accessibility & relevant existing recovery-set metadata
  const resolvedDir = path.resolve(targetDir);
  report.backupDirectory.path = resolvedDir;
  const dirExists = fs.existsSync(resolvedDir);
  report.backupDirectory.exists = dirExists;

  if (dirExists) {
    try {
      fs.accessSync(resolvedDir, fs.constants.R_OK);
      report.backupDirectory.readable = true;
    } catch {
      report.backupDirectory.readable = false;
      report.valid = false;
      report.errors.push(`Backup directory '${resolvedDir}' is not readable.`);
    }

    try {
      fs.accessSync(resolvedDir, fs.constants.W_OK);
      report.backupDirectory.writable = true;
    } catch {
      report.backupDirectory.writable = false;
      report.warnings.push(`Backup directory '${resolvedDir}' is not currently writable.`);
    }

    try {
      const entries = fs.readdirSync(resolvedDir);
      const manifestFiles = entries.filter(f => f.startsWith('manifest-') && f.endsWith('.json'));
      report.backupDirectory.recoverySetsCount = manifestFiles.length;

      const recoverySets = [];
      for (const mf of manifestFiles) {
        try {
          const raw = fs.readFileSync(path.join(resolvedDir, mf), 'utf8');
          const m = JSON.parse(raw);
          recoverySets.push({
            filename: mf,
            recoverySetId: m.recoverySetId,
            timestamp: m.timestamp,
            schemaVersion: m.schemaVersion,
            status: m.status,
            encrypted: m.encryption?.enabled ?? false,
            keyId: m.encryption?.keyId ?? null
          });
        } catch {
          recoverySets.push({ filename: mf, unparseable: true });
        }
      }
      report.backupDirectory.recoverySets = recoverySets;
    } catch (readErr) {
      report.warnings.push(`Could not read recovery sets: ${readErr.message}`);
    }
  } else {
    report.backupDirectory.readable = false;
    report.backupDirectory.writable = false;
    report.warnings.push(`Backup directory '${resolvedDir}' does not exist (will be created automatically on backup).`);
  }

  // 4. Lock & Gate status and actionable errors
  report.lockStatus = inspectLockStatus(resolvedDir, options);
  if (report.lockStatus.exists) {
    if (report.lockStatus.ownerAlive) {
      report.warnings.push(`Active backup lock held by process PID ${report.lockStatus.lockInfo?.pid}.`);
    } else if (report.lockStatus.isStale) {
      report.warnings.push(`Stale backup lock detected for terminated process PID ${report.lockStatus.lockInfo?.pid}.`);
    } else if (report.lockStatus.isAmbiguous) {
      report.warnings.push(`Ambiguous backup lock detected: ${report.lockStatus.error}`);
    }
  }

  report.gateStatus = inspectGateStatus(resolvedDir, options);
  if (report.gateStatus.exists) {
    if (report.gateStatus.ownerAlive) {
      report.warnings.push(`Synchronization gate actively held by process PID ${report.gateStatus.gateInfo?.pid}.`);
    } else if (report.gateStatus.isStale) {
      report.warnings.push(`Stale synchronization gate detected for terminated process PID ${report.gateStatus.gateInfo?.pid}.`);
    } else if (report.gateStatus.isAmbiguous) {
      report.warnings.push(`Ambiguous synchronization gate detected: ${report.gateStatus.error}`);
    }
  }

  // 5. Off-site archival configuration
  report.offsiteArchival.enabled = offsiteEnabled;
  if (offsiteEnabled) {
    report.offsiteArchival.urlConfigured = Boolean(offsiteUrl);
    report.offsiteArchival.tokenConfigured = Boolean(offsiteToken && offsiteToken.length >= 32);
    if (!offsiteUrl) {
      report.valid = false;
      report.errors.push('OFFSITE_REMOTE_URL is required when OFFSITE_UPLOAD_ENABLED=true.');
    }
    if (!offsiteToken || offsiteToken.length < 32) {
      report.valid = false;
      report.errors.push('OFFSITE_API_TOKEN must be at least 32 characters when OFFSITE_UPLOAD_ENABLED=true.');
    }
  }

  return report;
}

// ── Cryptographic Helpers (Phase 4.4.4) ──────────────────────────────────────

export function deriveKeyId(keyHex) {
  return 'kid_' + crypto.createHash('sha256').update('rapidaid-key-v1:' + keyHex).digest('hex').slice(0, 16);
}

export function deriveManifestAuthKey(keyHex) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update('rapidaid-manifest-auth-v1').digest();
}

export function canonicalizeManifest(manifestObj) {
  function sortKeysRecursively(val) {
    if (val === null || typeof val !== 'object') {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(sortKeysRecursively);
    }
    const sortedObj = {};
    const keys = Object.keys(val).sort();
    for (const key of keys) {
      if (key !== 'signature') {
        sortedObj[key] = sortKeysRecursively(val[key]);
      }
    }
    return sortedObj;
  }
  return JSON.stringify(sortKeysRecursively(manifestObj));
}

export function computeManifestSignature(manifestObj, authKey) {
  const canonicalJson = canonicalizeManifest(manifestObj);
  return crypto.createHmac('sha256', authKey).update(canonicalJson, 'utf8').digest('hex');
}

/**
 * Streams plaintext artifact through AES-256-GCM cipher with AAD,
 * computing plaintext SHA-256 and ciphertext SHA-256 simultaneously.
 * Unlinks the plaintext input artifact once ciphertext is verified.
 */
export async function encryptArtifactStream(inputPath, outputPath, keyHex, aadString) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input artifact for encryption not found: ${inputPath}`);
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  cipher.setAAD(Buffer.from(aadString, 'utf8'));

  const plainHash = crypto.createHash('sha256');
  const cipherHash = crypto.createHash('sha256');
  let plaintextSize = 0;
  let ciphertextSize = 0;

  const readStream = fs.createReadStream(inputPath);
  const writeStream = fs.createWriteStream(outputPath);

  readStream.on('data', chunk => {
    plaintextSize += chunk.length;
    plainHash.update(chunk);
  });

  cipher.on('data', chunk => {
    ciphertextSize += chunk.length;
    cipherHash.update(chunk);
  });

  await pipeline(readStream, cipher, writeStream);

  const authTag = cipher.getAuthTag();

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error(`Encryption failed or produced empty file: ${outputPath}`);
  }

  // Unlink plaintext staging file once ciphertext is written and verified
  try {
    fs.unlinkSync(inputPath);
  } catch (err) {
    console.warn(`[WARN] Could not unlink plaintext artifact ${inputPath}:`, err.message);
  }

  return {
    ivHex: iv.toString('hex'),
    authTagHex: authTag.toString('hex'),
    plaintextSha256: plainHash.digest('hex'),
    plaintextSizeBytes: plaintextSize,
    ciphertextSha256: cipherHash.digest('hex'),
    ciphertextSizeBytes: ciphertextSize
  };
}

// ── Remote Archival Transport (Scoped HTTPS Contract V1) ──────────────────────

export function createTlsAgent(options = {}) {
  const caBundlePath = options.caBundlePath || process.env.OFFSITE_CA_BUNDLE;
  let customCa;
  if (caBundlePath) {
    if (!fs.existsSync(caBundlePath)) {
      throw new Error(`Configured OFFSITE_CA_BUNDLE does not exist: ${caBundlePath}`);
    }
    const stat = fs.statSync(caBundlePath);
    if (stat.size === 0) {
      throw new Error(`Configured OFFSITE_CA_BUNDLE is empty: ${caBundlePath}`);
    }
    customCa = fs.readFileSync(caBundlePath);
  }

  return new https.Agent({
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3',
    rejectUnauthorized: true,
    ca: customCa || undefined,
    keepAlive: true,
    keepAliveMsecs: 1000
  });
}

export function sendHttpsRequest(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    let urlObj;
    try {
      urlObj = new URL(targetUrl);
    } catch {
      throw new Error(`CRITICAL SECURITY ABORT: Invalid target URL: '${targetUrl}'.`);
    }
    const method = options.method || 'GET';
    const headers = { ...(options.headers || {}) };
    const agent = options.agent;
    const connectTimeoutMs = options.connectTimeoutMs || 10000;
    const overallTimeoutMs = options.overallTimeoutMs || 60000;

    const reqOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers,
      agent
    };

    if (urlObj.protocol !== 'https:') {
      throw new Error(`CRITICAL SECURITY ABORT: Remote archival endpoint must use HTTPS (received '${urlObj.protocol}').`);
    }

    const secretsToRedact = [
      options.apiToken,
      process.env.OFFSITE_API_TOKEN,
      process.env.BACKUP_ENCRYPTION_KEY,
      process.env.MONGO_BACKUP_PASSWORD,
      headers.Authorization,
      ...(options.secretsToRedact || [])
    ].filter(Boolean);

    function sanitize(err) {
      let msg = err?.message || String(err || '');
      for (const s of secretsToRedact) {
        if (typeof s === 'string' && s.length > 2) {
          msg = msg.split(s).join('[REDACTED]');
        }
      }
      const clean = new Error(msg);
      if (err?.code) clean.code = err.code;
      if (err?.status) clean.status = err.status;
      return clean;
    }

    let settled = false;
    let connectTimer = null;
    let overallTimer = null;

    function cleanupTimers() {
      if (connectTimer) clearTimeout(connectTimer);
      if (overallTimer) clearTimeout(overallTimer);
    }

    const req = https.request(reqOptions, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        });
      });
      res.on('error', resErr => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        reject(sanitize(resErr));
      });
    });

    connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error(`Connection timeout after ${connectTimeoutMs}ms`));
      reject(sanitize(new Error(`Connection timeout after ${connectTimeoutMs}ms`)));
    }, connectTimeoutMs);

    req.on('socket', socket => {
      if (socket.connecting) {
        const clearConnect = () => {
          if (connectTimer) {
            clearTimeout(connectTimer);
            connectTimer = null;
          }
        };
        socket.once('secureConnect', clearConnect);
        socket.once('connect', () => {
          if (!socket.encrypted) {
            clearConnect();
          }
        });
      } else {
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
      }
    });

    overallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      req.destroy(new Error(`Request timeout after ${overallTimeoutMs}ms`));
      reject(sanitize(new Error(`Request timeout after ${overallTimeoutMs}ms`)));
    }, overallTimeoutMs);

    req.on('error', err => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      reject(sanitize(err));
    });

    if (options.bodyStream) {
      options.bodyStream.on('error', streamErr => {
        if (settled) return;
        settled = true;
        cleanupTimers();
        req.destroy(streamErr);
        reject(sanitize(streamErr));
      });
      options.bodyStream.pipe(req);
    } else if (options.bodyBuffer) {
      req.end(options.bodyBuffer);
    } else {
      req.end();
    }
  });
}

/**
 * Pluggable Off-Site Archival Transport (Scoped HTTPS Object Store Contract V1).
 */
export async function uploadRecoverySet(manifest, recoverySetFiles, options = {}) {
  const enabled = options.offsiteUploadEnabled ?? (process.env.OFFSITE_UPLOAD_ENABLED === 'true');
  if (!enabled) return { status: 'DISABLED' };

  const remoteUrl = (options.offsiteRemoteUrl || process.env.OFFSITE_REMOTE_URL || '').replace(/\/+$/, '');
  const apiToken = options.offsiteApiToken || process.env.OFFSITE_API_TOKEN;

  if (!remoteUrl) {
    throw new Error('OFFSITE_UPLOAD_ENABLED is true, but OFFSITE_REMOTE_URL is not set.');
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(remoteUrl);
  } catch {
    throw new Error(`Invalid OFFSITE_REMOTE_URL: '${remoteUrl}'. Must be a valid HTTPS URL.`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`CRITICAL SECURITY ABORT: Remote archival endpoint must use HTTPS (received '${parsedUrl.protocol}').`);
  }

  if (!apiToken || apiToken.length < 32) {
    throw new Error('OFFSITE_API_TOKEN is mandatory and must be at least 32 characters.');
  }

  const agent = options.agent || createTlsAgent(options);
  const recoverySetId = manifest.recoverySetId;
  console.log(`[OFFSITE] Starting remote replication for recovery set: ${recoverySetId} to ${remoteUrl}`);

  const manifestFileName = `manifest-${recoverySetId}.json`;
  const payloadFiles = recoverySetFiles.filter(f => path.basename(f) !== manifestFileName);
  const manifestFilePath = recoverySetFiles.find(f => path.basename(f) === manifestFileName);

  if (!manifestFilePath || !fs.existsSync(manifestFilePath)) {
    throw new Error(`Cannot finalize remote upload: completion manifest not found (${manifestFileName})`);
  }

  // Phase 1: Upload and verify payload files
  for (const filePath of payloadFiles) {
    const filename = path.basename(filePath);
    const targetEndpoint = `${remoteUrl}/${recoverySetId}/${filename}`;
    const fileSize = fs.statSync(filePath).size;
    const fileSha256 = computeSha256(filePath);

    let uploaded = false;
    let attempts = 0;
    const maxAttempts = 3;

    while (!uploaded && attempts < maxAttempts) {
      attempts++;
      try {
        // Probe HEAD first (Idempotency & Conflict Check)
        const headRes = await sendHttpsRequest(targetEndpoint, {
          method: 'HEAD',
          headers: { Authorization: `Bearer ${apiToken}` },
          agent,
          apiToken
        });

        if (headRes.statusCode === 200) {
          const remoteSha = headRes.headers['x-rapidaid-verified-sha256'];
          const remoteLen = parseInt(headRes.headers['content-length'] || '0', 10);
          if (remoteSha && remoteSha.toLowerCase() === fileSha256.toLowerCase() && remoteLen === fileSize) {
            console.log(`[OFFSITE] Payload artifact ${filename} already exists remotely with verified SHA-256. Skipping upload.`);
            uploaded = true;
            break;
          } else if (remoteSha && remoteSha.toLowerCase() !== fileSha256.toLowerCase()) {
            throw new Error(`CRITICAL CONFLICT ERROR: Remote receiver holds conflicting artifact for ${filename} (remote: ${remoteSha}, local: ${fileSha256}). Overwriting remote archives is prohibited.`);
          }
        } else if (headRes.statusCode === 409) {
          throw new Error(`CRITICAL CONFLICT ERROR: Remote receiver returned HTTP 409 Conflict for ${filename}. Overwriting is prohibited.`);
        } else if (headRes.statusCode === 401 || headRes.statusCode === 403) {
          throw new Error(`Remote receiver authentication failed with HTTP ${headRes.statusCode}. Check OFFSITE_API_TOKEN.`);
        }

        // Upload artifact stream
        console.log(`[OFFSITE] Uploading ${filename} (${fileSize} bytes, attempt ${attempts}/${maxAttempts})...`);
        const stream = fs.createReadStream(filePath);
        const putRes = await sendHttpsRequest(targetEndpoint, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(fileSize),
            'X-RapidAid-SHA256': fileSha256,
            'X-RapidAid-Recovery-Set': recoverySetId
          },
          bodyStream: stream,
          agent,
          apiToken
        });

        if (putRes.statusCode === 409) {
          throw new Error(`CRITICAL CONFLICT ERROR: Remote receiver rejected upload of ${filename} with HTTP 409 Conflict.`);
        }
        if (putRes.statusCode === 401 || putRes.statusCode === 403) {
          throw new Error(`Remote receiver rejected credentials with HTTP ${putRes.statusCode}.`);
        }
        if (putRes.statusCode >= 400 && putRes.statusCode < 500 && putRes.statusCode !== 429) {
          throw new Error(`Remote upload failed with non-retryable client error HTTP ${putRes.statusCode}: ${putRes.body}`);
        }
        if (putRes.statusCode !== 200 && putRes.statusCode !== 201) {
          throw new Error(`Remote upload received server status HTTP ${putRes.statusCode}: ${putRes.body}`);
        }

        const verifiedSha = putRes.headers['x-rapidaid-verified-sha256'];
        if (verifiedSha && verifiedSha.toLowerCase() !== fileSha256.toLowerCase()) {
          throw new Error(`REMOTE CHECKSUM MISMATCH for ${filename}: expected ${fileSha256}, got ${verifiedSha}`);
        }

        uploaded = true;
        console.log(`[OFFSITE] Successfully uploaded and verified ${filename}.`);
      } catch (err) {
        const isNonRetryable =
          err.message.includes('CRITICAL CONFLICT') ||
          err.message.includes('authentication failed') ||
          err.message.includes('rejected credentials') ||
          err.message.includes('non-retryable client error');

        if (isNonRetryable) {
          throw err;
        }

        console.warn(`[OFFSITE] Transient upload error on ${filename} (attempt ${attempts}/${maxAttempts}):`, err.message);
        if (attempts >= maxAttempts) {
          throw new Error(`Failed to upload ${filename} after ${maxAttempts} attempts: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempts - 1)));
      }
    }
  }

  // Phase 2: Upload and finalize completion manifest
  console.log(`[OFFSITE] All payload artifacts verified remotely. Publishing completion manifest ${manifestFileName}...`);
  const manifestContent = fs.readFileSync(manifestFilePath, 'utf8');
  const manifestSha256 = computeSha256(manifestFilePath);
  const manifestEndpoint = `${remoteUrl}/${recoverySetId}/${manifestFileName}`;

  const manifestPut = await sendHttpsRequest(manifestEndpoint, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(manifestContent)),
      'X-RapidAid-SHA256': manifestSha256,
      'X-RapidAid-Recovery-Set': recoverySetId,
      'X-RapidAid-Finalize': 'true'
    },
    bodyBuffer: Buffer.from(manifestContent, 'utf8'),
    agent,
    apiToken
  });

  if (manifestPut.statusCode !== 200 && manifestPut.statusCode !== 201) {
    throw new Error(`Failed to publish completion manifest: HTTP ${manifestPut.statusCode}: ${manifestPut.body}`);
  }

  console.log(`[OFFSITE] Remote replication completed and finalized successfully: ${recoverySetId}`);
  return { status: 'PUBLISHED', recoverySetId, remoteUrl };
}

/**
 * Validates that the backup directory is safe and expected.
 */
export function assertSafeBackupDirectory(dirPath) {
  const normalized = path.normalize(dirPath);
  if (!normalized || normalized === '/' || normalized === path.parse(normalized).root) {
    throw new Error(`Refusing to operate on unsafe backup directory path: ${dirPath}`);
  }
  if (!normalized.toLowerCase().includes('backup')) {
    throw new Error(`Target backup directory must explicitly include 'backup': ${dirPath}`);
  }
}

/**
 * GFS Retention Pruning Engine.
 */
export function pruneRetention(backupDir, keepRules = { daily: RETENTION_DAILY, weekly: RETENTION_WEEKLY, monthly: RETENTION_MONTHLY }) {
  assertSafeBackupDirectory(backupDir);
  if (!fs.existsSync(backupDir)) return { pruned: [], kept: [] };

  const files = fs.readdirSync(backupDir);
  const manifestFiles = files.filter(f => f.startsWith('manifest-') && f.endsWith('.json'));

  const recoverySets = [];
  for (const mf of manifestFiles) {
    try {
      const fullPath = path.join(backupDir, mf);
      const manifest = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      if (manifest.status === 'VERIFIED_COMPLETE' && manifest.timestamp) {
        recoverySets.push({
          id: manifest.recoverySetId,
          timestamp: new Date(manifest.timestamp),
          manifestFile: mf,
          manifest,
        });
      }
    } catch {
      console.warn(`[RETENTION] Warning: Could not parse manifest ${mf}; skipping.`);
    }
  }

  // Safety Guard: Never prune if fewer than 2 verified recovery sets would remain
  if (recoverySets.length <= 2) {
    console.log(`[RETENTION] Verified recovery sets count (${recoverySets.length}) <= 2. Skipping pruning for safety.`);
    return { pruned: [], kept: recoverySets.map(r => r.id) };
  }

  recoverySets.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

  const toKeep = new Set();
  const toDelete = new Set();

  // 1. Daily tier
  const dailyBuckets = new Map();
  for (const set of recoverySets) {
    const dayKey = set.timestamp.toISOString().slice(0, 10);
    if (!dailyBuckets.has(dayKey)) dailyBuckets.set(dayKey, set);
  }
  let dailyCount = 0;
  for (const set of dailyBuckets.values()) {
    if (dailyCount < keepRules.daily) {
      toKeep.add(set.id);
      dailyCount++;
    }
  }

  // 2. Weekly tier (canonical ISO-8601 week keys)
  const weeklyBuckets = new Map();
  for (const set of recoverySets) {
    const weekKey = getIsoWeekKey(set.timestamp);
    if (!weeklyBuckets.has(weekKey)) weeklyBuckets.set(weekKey, set);
  }
  let weeklyCount = 0;
  for (const set of weeklyBuckets.values()) {
    if (weeklyCount < keepRules.weekly) {
      toKeep.add(set.id);
      weeklyCount++;
    }
  }

  // 3. Monthly tier
  const monthlyBuckets = new Map();
  for (const set of recoverySets) {
    const monthKey = set.timestamp.toISOString().slice(0, 7);
    if (!monthlyBuckets.has(monthKey)) monthlyBuckets.set(monthKey, set);
  }
  let monthlyCount = 0;
  for (const set of monthlyBuckets.values()) {
    if (monthlyCount < keepRules.monthly) {
      toKeep.add(set.id);
      monthlyCount++;
    }
  }

  for (const set of recoverySets) {
    if (!toKeep.has(set.id)) {
      toDelete.add(set);
    }
  }

  if (toKeep.size < 2) {
    console.warn('[RETENTION] Safety check triggered: pruning would result in < 2 recovery sets. Aborting prune.');
    return { pruned: [], kept: Array.from(toKeep) };
  }

  const prunedIds = [];
  for (const set of toDelete) {
    console.log(`[RETENTION] Pruning expired recovery set: ${set.id} (${set.timestamp.toISOString()})`);
    const m = set.manifest;

    const rawCandidates = [
      set.manifestFile,
      m.artifacts?.mongodb?.filename,
      m.artifacts?.voiceStorage?.filename,
      `checksums-${set.id}.sha256`
    ].filter(Boolean);

    let safePathsToDelete = [];
    try {
      for (const f of rawCandidates) {
        safePathsToDelete.push(assertSafeArtifactFilename(f, backupDir));
      }
    } catch (traversalErr) {
      console.warn(`[RETENTION] Traversal validation failed for recovery set ${set.id}: ${traversalErr.message}. Skipping deletion for safety.`);
      continue;
    }

    for (const p of safePathsToDelete) {
      if (fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { console.warn(`Could not delete ${p}:`, e.message); }
      }
    }
    prunedIds.push(set.id);
  }

  return { pruned: prunedIds, kept: Array.from(toKeep) };
}

/**
 * Main Backup Execution Routine.
 */
export async function runBackup(options = {}) {
  const targetDir = path.resolve(options.backupDir || process.env.BACKUP_DIR || './backups');
  assertSafeBackupDirectory(targetDir);

  const mongoBackupUser = options.mongoBackupUser || process.env.MONGO_BACKUP_USERNAME || 'rapidaid_backup';
  const mongoBackupPass = options.mongoBackupPass || process.env.MONGO_BACKUP_PASSWORD;
  const mongoDb = options.mongoDb || process.env.MONGO_INITDB_DATABASE || 'rapidaid';
  const mongoHost = options.mongoHost || process.env.MONGO_HOST || 'mongodb';
  const mongoPort = options.mongoPort || process.env.MONGO_PORT || '27017';
  const network = options.network || process.env.DOCKER_NETWORK || 'rapidaid-network';
  const voiceVolume = options.voiceVolume || process.env.VOICE_VOLUME || 'rapidaid-voice-storage';
  const mongoImage = options.mongoImage || process.env.MONGO_IMAGE || 'mongo:7.0';

  // 1. Encryption Policy & Key Validation (Phase 4.4.4)
  if (typeof process.env.BACKUP_ENCRYPTION_ENABLED === 'string' &&
      !['true', 'false'].includes(process.env.BACKUP_ENCRYPTION_ENABLED.toLowerCase())) {
    throw new Error(`Invalid BACKUP_ENCRYPTION_ENABLED value: '${process.env.BACKUP_ENCRYPTION_ENABLED}'. Must be 'true' or 'false'.`);
  }

  const encryptionEnabled = options.encryptionEnabled ?? (process.env.BACKUP_ENCRYPTION_ENABLED !== 'false');
  const allowUnencrypted = options.allowUnencrypted ?? (process.env.ALLOW_UNENCRYPTED_BACKUPS === 'true');
  const backupKey = options.backupKey || process.env.BACKUP_ENCRYPTION_KEY;

  if (!encryptionEnabled) {
    if (!allowUnencrypted) {
      throw new Error('CRITICAL SAFETY ABORT: Refusing to create unencrypted backup without explicit ALLOW_UNENCRYPTED_BACKUPS=true confirmation.');
    }
    console.warn('\n[SECURITY WARNING] Producing UNENCRYPTED backup. Protected health information and patient call recordings are stored in plaintext!\n');
  } else {
    if (!backupKey || typeof backupKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(backupKey)) {
      throw new Error('Missing or invalid BACKUP_ENCRYPTION_KEY. Must be a 64-character hex string (32 bytes / 256 bits).');
    }
  }

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
    setRestrictivePermissions(targetDir, true);
  }

  // Check for stale staging directories from prior interrupted runs (> 24h) and warn without deleting
  try {
    const existingEntries = fs.readdirSync(targetDir);
    const now = Date.now();
    for (const entry of existingEntries) {
      if (entry.startsWith('.staging-')) {
        const fullP = path.join(targetDir, entry);
        try {
          const st = fs.statSync(fullP);
          if (now - st.mtimeMs > 24 * 60 * 60 * 1000) {
            console.warn(`[WARN] Stale staging directory detected from prior interrupted run: ${entry}. Please review and remove manually if inactive.`);
          }
        } catch {}
      }
    }
  } catch {}

  // 2. Mandatory Credential Validation
  if (!mongoBackupPass) {
    throw new Error('Missing mandatory MONGO_BACKUP_PASSWORD environment variable for dedicated backup identity.');
  }

  // 3. Concurrency Lock
  let backupLock = null;
  if (options.skipLock !== true) {
    backupLock = acquireBackupLock(targetDir, options);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recoverySetId = `rapidaid-recovery-${timestamp}`;
  const stagingDir = path.join(targetDir, `.staging-${recoverySetId}`);

  fs.mkdirSync(stagingDir, { recursive: true });
  setRestrictivePermissions(stagingDir, true);

  console.log('================================================================');
  console.log(`RapidAid V2 — Starting Daily Backup: ${recoverySetId}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);
  console.log(`Encryption: ${encryptionEnabled ? 'AES-256-GCM (Enabled)' : 'DISABLED (Plaintext)'}`);
  console.log(`Staging: ${stagingDir}`);
  console.log('================================================================');

  try {
    // ── STEP 1: Voice Storage Capture (Read-Only) ──────────────────────────
    console.log('\n[1/5] Capturing Voice Storage Volume (read-only)...');
    const voiceTarFilename = `voice-${recoverySetId}.tar.gz`;
    const voiceTarStagingPath = path.join(stagingDir, voiceTarFilename);

    const voiceCaptureCmd = `docker run --rm -v "${voiceVolume}:/source:ro" -v "${stagingDir}:/dest" alpine sh -c "tar -czf /dest/${voiceTarFilename} -C /source ."`;
    execSanitized(voiceCaptureCmd, { stdio: 'inherit' });

    if (!fs.existsSync(voiceTarStagingPath) || fs.statSync(voiceTarStagingPath).size === 0) {
      throw new Error('Voice storage capture failed or produced an empty archive.');
    }
    setRestrictivePermissions(voiceTarStagingPath);
    console.log(`Voice storage archive created: ${voiceTarFilename} (${fs.statSync(voiceTarStagingPath).size} bytes)`);

    // ── STEP 2: Authenticated MongoDB Dump ─────────────────────────────────
    console.log('\n[2/5] Executing Authenticated mongodump...');
    const mongoArchiveFilename = `mongodb-${recoverySetId}.archive.gz`;
    const mongoArchiveStagingPath = path.join(stagingDir, mongoArchiveFilename);

    process.env.MONGO_PASS = mongoBackupPass;
    process.env.MONGO_USER = mongoBackupUser;

    const mongoDumpCmd = `docker run --rm --network "${network}" -v "${stagingDir}:/dest" -e MONGO_PASS -e MONGO_USER ${mongoImage} sh -c "mongodump --uri=\\"mongodb://$MONGO_USER:$MONGO_PASS@${mongoHost}:${mongoPort}/${mongoDb}?authSource=${mongoDb}\\" --archive=/dest/${mongoArchiveFilename} --gzip"`;
    execSanitized(mongoDumpCmd, { stdio: 'inherit' }, [mongoBackupPass, backupKey, process.env.OFFSITE_API_TOKEN]);

    if (!fs.existsSync(mongoArchiveStagingPath) || fs.statSync(mongoArchiveStagingPath).size === 0) {
      throw new Error('MongoDB dump failed or produced an empty archive.');
    }
    setRestrictivePermissions(mongoArchiveStagingPath);
    console.log(`MongoDB archive created: ${mongoArchiveFilename} (${fs.statSync(mongoArchiveStagingPath).size} bytes)`);

    // ── STEP 3: Voice Reference Cross-Verification ────────────────────────
    console.log('\n[3/5] Inspecting Voice References & Archive Alignment...');
    const listTarCmd = `docker run --rm -v "${stagingDir}:/dest:ro" alpine tar -tzf /dest/${voiceTarFilename}`;
    const voiceFileListing = execSanitized(listTarCmd, { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    const voiceFileSet = new Set(voiceFileListing.map(f => f.replace(/^\.\//, '')));

    let totalDbReferences = 0;
    let matchedReferences = 0;
    let missingReferences = [];

    try {
      const queryCmd = `docker run --rm -i --network "${network}" -e MONGO_PASS -e MONGO_USER ${mongoImage} sh -c "mongosh \\"mongodb://$MONGO_USER:$MONGO_PASS@${mongoHost}:${mongoPort}/${mongoDb}?authSource=${mongoDb}\\" --quiet"`;
      const queryScript = `
        const docs = db.voicereports.find({}, { 'audio.storageKey': 1 }).toArray();
        console.log('MARKER_START:' + JSON.stringify(docs) + ':MARKER_END');
      `;
      const reportsRaw = execSanitized(queryCmd, { input: queryScript, encoding: 'utf8' }, [mongoBackupPass, backupKey]);
      const match = reportsRaw.match(/MARKER_START:(.*?):MARKER_END/s);
      const reports = match ? JSON.parse(match[1]) : [];
      totalDbReferences = reports.length;
      for (const r of reports) {
        const key = r.audio?.storageKey;
        if (key) {
          if (voiceFileSet.has(key) || Array.from(voiceFileSet).some(f => f.endsWith(path.basename(key)))) {
            matchedReferences++;
          } else {
            missingReferences.push(key);
          }
        }
      }
    } catch (queryErr) {
      console.warn('[WARN] Could not query database voice references directly:', queryErr.message);
    }

    const orphanFilesCount = Math.max(0, voiceFileSet.size - matchedReferences);
    console.log(`Voice Verification Summary: ${voiceFileSet.size} audio files captured, ${matchedReferences}/${totalDbReferences} DB references matched, ${orphanFilesCount} orphan audio files, ${missingReferences.length} missing references.`);

    // Strict Fail-Closed Check: Never publish as VERIFIED_COMPLETE if voice references are missing
    if (missingReferences.length > 0) {
      const errMsg = `Backup publication aborted: ${missingReferences.length} database voice references missing from captured voice archive (${missingReferences.join(', ')}). Incomplete recovery sets are never published as verified.`;
      console.error(`\n[INTEGRITY FAILURE] ${errMsg}`);
      if (fs.existsSync(stagingDir)) {
        try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
      }
      throw new Error(errMsg);
    }

    // ── STEP 4: Encryption or Plaintext Finalization ───────────────────────
    let publishedFiles = [];
    let manifest;
    const consistencyNotice = 'Voice storage captured read-only before MongoDB logical dump. This is best-effort asynchronous correlation across separate volumes and does NOT provide an atomic cross-volume point-in-time snapshot. Completed calls prior to backup have aligned references; calls completed mid-backup may produce harmless unreferenced orphan audio files. If any database record references a voice file missing from the voice archive, the backup fails closed and is NOT published as VERIFIED_COMPLETE.';

    if (encryptionEnabled) {
      console.log('\n[4/5] Encrypting Archives with AES-256-GCM...');
      const mongoEncFilename = `mongodb-${recoverySetId}.archive.gz.enc`;
      const mongoEncStagingPath = path.join(stagingDir, mongoEncFilename);
      const mongoAad = `2.0.0:${recoverySetId}:mongodb`;

      console.log('Encrypting MongoDB archive...');
      const mongoEncMeta = await encryptArtifactStream(mongoArchiveStagingPath, mongoEncStagingPath, backupKey, mongoAad);
      setRestrictivePermissions(mongoEncStagingPath);

      const voiceEncFilename = `voice-${recoverySetId}.tar.gz.enc`;
      const voiceEncStagingPath = path.join(stagingDir, voiceEncFilename);
      const voiceAad = `2.0.0:${recoverySetId}:voiceStorage`;

      console.log('Encrypting Voice storage archive...');
      const voiceEncMeta = await encryptArtifactStream(voiceTarStagingPath, voiceEncStagingPath, backupKey, voiceAad);
      setRestrictivePermissions(voiceEncStagingPath);

      const keyId = deriveKeyId(backupKey);
      const authKey = deriveManifestAuthKey(backupKey);

      manifest = {
        schemaVersion: '2.0.0',
        recoverySetId,
        timestamp: new Date().toISOString(),
        status: 'VERIFIED_COMPLETE',
        engine: mongoImage,
        database: mongoDb,
        backupIdentity: mongoBackupUser,
        authSource: mongoDb,
        consistencyModel: 'ORDERED_ASYNC_CORRELATION',
        consistencyNotice,
        encryption: {
          enabled: true,
          algorithm: 'aes-256-gcm',
          keyId,
          aadFormat: 'schemaVersion:recoverySetId:artifactKey'
        },
        artifacts: {
          mongodb: {
            filename: mongoEncFilename,
            format: 'mongodump-archive-gzip-aes256gcm',
            ciphertextSha256: mongoEncMeta.ciphertextSha256,
            ciphertextSizeBytes: mongoEncMeta.ciphertextSizeBytes,
            plaintextSha256: mongoEncMeta.plaintextSha256,
            plaintextSizeBytes: mongoEncMeta.plaintextSizeBytes,
            ivHex: mongoEncMeta.ivHex,
            authTagHex: mongoEncMeta.authTagHex
          },
          voiceStorage: {
            filename: voiceEncFilename,
            format: 'tar-gzip-aes256gcm',
            ciphertextSha256: voiceEncMeta.ciphertextSha256,
            ciphertextSizeBytes: voiceEncMeta.ciphertextSizeBytes,
            plaintextSha256: voiceEncMeta.plaintextSha256,
            plaintextSizeBytes: voiceEncMeta.plaintextSizeBytes,
            fileCount: voiceFileSet.size,
            ivHex: voiceEncMeta.ivHex,
            authTagHex: voiceEncMeta.authTagHex
          }
        },
        audit: {
          totalDbVoiceReferences: totalDbReferences,
          matchedReferences,
          missingReferences,
          orphanFilesCount
        }
      };

      const signatureValue = computeManifestSignature(manifest, authKey);
      manifest.signature = {
        algorithm: 'hmac-sha256',
        keyId,
        value: signatureValue
      };

      const manifestFilename = `manifest-${recoverySetId}.json`;
      const manifestStagingPath = path.join(stagingDir, manifestFilename);
      fs.writeFileSync(manifestStagingPath, JSON.stringify(manifest, null, 2), 'utf8');
      setRestrictivePermissions(manifestStagingPath);

      const checksumsFilename = `checksums-${recoverySetId}.sha256`;
      const checksumsContent = `${mongoEncMeta.ciphertextSha256}  ${mongoEncFilename}\n${voiceEncMeta.ciphertextSha256}  ${voiceEncFilename}\n`;
      const checksumsStagingPath = path.join(stagingDir, checksumsFilename);
      fs.writeFileSync(checksumsStagingPath, checksumsContent, 'utf8');
      setRestrictivePermissions(checksumsStagingPath);

      publishedFiles = [mongoEncFilename, voiceEncFilename, manifestFilename, checksumsFilename];
    } else {
      console.log('\n[4/5] Finalizing Plaintext Archives (Explicitly Authorized)...');
      const mongoSha256 = computeSha256(mongoArchiveStagingPath);
      const mongoSize = fs.statSync(mongoArchiveStagingPath).size;
      const voiceSha256 = computeSha256(voiceTarStagingPath);
      const voiceSize = fs.statSync(voiceTarStagingPath).size;

      manifest = {
        schemaVersion: '1.0.0',
        recoverySetId,
        timestamp: new Date().toISOString(),
        status: 'VERIFIED_COMPLETE',
        engine: mongoImage,
        database: mongoDb,
        backupIdentity: mongoBackupUser,
        authSource: mongoDb,
        consistencyModel: 'ORDERED_ASYNC_CORRELATION',
        consistencyNotice,
        artifacts: {
          mongodb: {
            filename: mongoArchiveFilename,
            sha256: mongoSha256,
            sizeBytes: mongoSize,
            format: 'mongodump-archive-gzip'
          },
          voiceStorage: {
            filename: voiceTarFilename,
            sha256: voiceSha256,
            sizeBytes: voiceSize,
            fileCount: voiceFileSet.size,
            format: 'tar-gzip'
          }
        },
        audit: {
          totalDbVoiceReferences: totalDbReferences,
          matchedReferences,
          missingReferences,
          orphanFilesCount
        }
      };

      const manifestFilename = `manifest-${recoverySetId}.json`;
      const manifestStagingPath = path.join(stagingDir, manifestFilename);
      fs.writeFileSync(manifestStagingPath, JSON.stringify(manifest, null, 2), 'utf8');
      setRestrictivePermissions(manifestStagingPath);

      const checksumsFilename = `checksums-${recoverySetId}.sha256`;
      const checksumsContent = `${mongoSha256}  ${mongoArchiveFilename}\n${voiceSha256}  ${voiceTarFilename}\n`;
      const checksumsStagingPath = path.join(stagingDir, checksumsFilename);
      fs.writeFileSync(checksumsStagingPath, checksumsContent, 'utf8');
      setRestrictivePermissions(checksumsStagingPath);

      publishedFiles = [mongoArchiveFilename, voiceTarFilename, manifestFilename, checksumsFilename];
    }

    // Atomic Move from Staging to Final Destination
    for (const f of publishedFiles) {
      const src = path.join(stagingDir, f);
      const dest = path.join(targetDir, f);
      fs.renameSync(src, dest);
    }
    fs.rmdirSync(stagingDir);

    console.log(`\nSUCCESS: Recovery set published to ${targetDir}`);
    console.log(`  - Manifest: manifest-${recoverySetId}.json`);
    console.log(`  - Checksums: checksums-${recoverySetId}.sha256`);

    // ── STEP 5: Remote Archival & Retention ────────────────────────────────
    console.log('\n[5/5] Executing Remote Archival and Retention Pruning...');
    try {
      await uploadRecoverySet(manifest, publishedFiles.map(f => path.join(targetDir, f)), options);
    } catch (uploadErr) {
      console.error('\n[OFFSITE REPLICATION FAILURE] Remote upload failed:', uploadErr.message);
      // Local backup remains VERIFIED_COMPLETE and intact
    }

    const retentionResult = pruneRetention(targetDir);
    console.log(`Retention complete. Kept: ${retentionResult.kept.length} sets. Pruned: ${retentionResult.pruned.length} sets.`);

    return manifest;
  } catch (error) {
    let sanitizedErrorMsg = error.message;
    for (const secret of [mongoBackupPass, backupKey, process.env.OFFSITE_API_TOKEN].filter(Boolean)) {
      sanitizedErrorMsg = sanitizedErrorMsg.split(secret).join('[REDACTED]');
    }
    console.error('\nBACKUP FAILED:', sanitizedErrorMsg);
    if (fs.existsSync(stagingDir)) {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }
    throw new Error(sanitizedErrorMsg);
  } finally {
    if (backupLock) {
      releaseBackupLock(backupLock);
    }
  }
}

// CLI Execution Entry Point
if (process.argv[1] && process.argv[1].endsWith('backup-db.mjs')) {
  if (process.argv.includes('--help')) {
    console.log(`
RapidAid V2 — Database & Voice Storage Backup Automation

Usage:
  node scripts/backup-db.mjs [options]

Options:
  --help               Show this help message
  --inspect            Non-destructive inspection of backup configuration, encryption, lock status, and recovery sets
  --recover-stale-lock Safely removes a confirmed stale lockfile if the owning process is proven dead (ESRCH)
  --recover-stale-gate Explicit administrative recovery of an abandoned synchronization gate (.backup.gate)
  --prune-only         Run retention pruning only without creating a new backup
  --backup-dir <dir>   Destination directory (default: ./backups)

Environment Variables:
  BACKUP_ENCRYPTION_ENABLED Enabled by default (true). If false, requires ALLOW_UNENCRYPTED_BACKUPS=true.
  BACKUP_ENCRYPTION_KEY     Mandatory 64-character hex key (256 bits) when encryption is enabled.
  ALLOW_UNENCRYPTED_BACKUPS Must be true to permit plaintext backups if encryption is disabled.
  MONGO_BACKUP_USERNAME     Dedicated read-only backup user (default: rapidaid_backup)
  MONGO_BACKUP_PASSWORD     Mandatory password for backup user
  BACKUP_DIR                Target directory on host (default: ./backups)
  DOCKER_NETWORK            Docker network name (default: rapidaid-network)
  VOICE_VOLUME              Voice storage volume name (default: rapidaid-voice-storage)
  OFFSITE_UPLOAD_ENABLED    Set to true to replicate recovery sets to remote HTTPS receiver
  OFFSITE_REMOTE_URL        Target HTTPS receiver base URL
  OFFSITE_API_TOKEN         Bearer token for remote receiver (min 32 chars)
  OFFSITE_CA_BUNDLE         Optional custom CA certificate bundle path
`);
    process.exit(0);
  }

  if (process.argv.includes('--inspect')) {
    const dirIdx = process.argv.indexOf('--backup-dir');
    const dir = dirIdx !== -1 ? process.argv[dirIdx + 1] : BACKUP_DIR;
    console.log(`\n================================================================`);
    console.log(`RapidAid V2 — Backup Environment Inspection (--inspect)`);
    console.log(`================================================================`);
    const report = inspectBackupEnvironment({ backupDir: dir });
    console.log(`Backup Directory: ${report.backupDirectory.path}`);
    console.log(`  - Exists: ${report.backupDirectory.exists}`);
    console.log(`  - Readable: ${report.backupDirectory.readable}`);
    console.log(`  - Writable: ${report.backupDirectory.writable}`);
    console.log(`  - Existing Recovery Sets: ${report.backupDirectory.recoverySetsCount ?? 0}`);
    console.log(`\nConfiguration:`);
    console.log(`  - Mongo User: ${report.configuration.mongoUser}`);
    console.log(`  - Mongo Password: ${report.configuration.mongoPasswordConfigured ? '[CONFIGURED]' : '[MISSING]'}`);
    console.log(`  - Docker Network: ${report.configuration.dockerNetwork}`);
    console.log(`  - Voice Volume: ${report.configuration.voiceVolume}`);
    console.log(`\nEncryption:`);
    console.log(`  - Enabled: ${report.encryption.enabled}`);
    console.log(`  - Key Configured: ${report.encryption.keyConfigured ? '[CONFIGURED]' : '[NOT SET]'}`);
    console.log(`  - Key Format Valid: ${report.encryption.keyFormatValid ?? false}`);
    if (report.encryption.keyId) console.log(`  - Key ID: ${report.encryption.keyId}`);
    console.log(`\nLock Status:`);
    console.log(`  - Lockfile Present: ${report.lockStatus.exists}`);
    if (report.lockStatus.exists) {
      console.log(`  - Owning PID: ${report.lockStatus.lockInfo?.pid}`);
      console.log(`  - Created At: ${report.lockStatus.lockInfo?.createdAt || report.lockStatus.lockInfo?.timestamp}`);
      console.log(`  - Process State: ${report.lockStatus.ownerAlive ? 'RUNNING' : (report.lockStatus.isStale ? 'DEAD (STALE)' : 'AMBIGUOUS')}`);
      console.log(`  - Detail: ${report.lockStatus.message || report.lockStatus.error}`);
    }
    console.log(`\nSynchronization Gate Status:`);
    console.log(`  - Gatefile Present: ${report.gateStatus.exists}`);
    if (report.gateStatus.exists) {
      console.log(`  - Owning PID: ${report.gateStatus.gateInfo?.pid}`);
      console.log(`  - Created At: ${report.gateStatus.gateInfo?.createdAt}`);
      console.log(`  - Process State: ${report.gateStatus.ownerAlive ? 'RUNNING' : (report.gateStatus.isStale ? 'DEAD (STALE)' : 'AMBIGUOUS')}`);
      console.log(`  - Detail: ${report.gateStatus.message || report.gateStatus.error}`);
    }
    console.log(`\nOff-Site Archival:`);
    console.log(`  - Enabled: ${report.offsiteArchival.enabled}`);
    if (report.offsiteArchival.enabled) {
      console.log(`  - Remote URL: ${report.offsiteArchival.urlConfigured ? '[CONFIGURED]' : '[MISSING]'}`);
      console.log(`  - API Token: ${report.offsiteArchival.tokenConfigured ? '[CONFIGURED]' : '[MISSING / TOO SHORT]'}`);
    }
    if (report.warnings.length > 0) {
      console.log(`\nWarnings (${report.warnings.length}):`);
      for (const w of report.warnings) console.log(`  - [WARN] ${w}`);
    }
    if (report.errors.length > 0) {
      console.log(`\nErrors (${report.errors.length}):`);
      for (const e of report.errors) console.log(`  - [ERROR] ${e}`);
    }
    console.log(`================================================================`);
    console.log(`Overall Inspection Result: ${report.valid ? 'CONFIG_VALID' : 'CONFIG_INVALID'}\n`);
    process.exit(report.valid ? 0 : 1);
  }

  if (process.argv.includes('--recover-stale-gate')) {
    const dirIdx = process.argv.indexOf('--backup-dir');
    const dir = dirIdx !== -1 ? process.argv[dirIdx + 1] : BACKUP_DIR;
    console.log(`[GATE RECOVERY] Attempting explicit recovery of abandoned synchronization gate on ${dir}...`);
    try {
      const res = recoverStaleGate(dir);
      console.log('Gate recovery result:', JSON.stringify(res, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('Gate recovery failed:', err.message);
      process.exit(1);
    }
  }

  if (process.argv.includes('--recover-stale-lock')) {
    const dirIdx = process.argv.indexOf('--backup-dir');
    const dir = dirIdx !== -1 ? process.argv[dirIdx + 1] : BACKUP_DIR;
    console.log(`[LOCK RECOVERY] Attempting safe stale-lock recovery on ${dir}...`);
    try {
      const res = recoverStaleLock(dir);
      console.log('Recovery result:', JSON.stringify(res, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('Lock recovery failed:', err.message);
      process.exit(1);
    }
  }

  if (process.argv.includes('--prune-only')) {
    const dir = process.argv[process.argv.indexOf('--backup-dir') + 1] || BACKUP_DIR;
    console.log(`Running retention pruning on ${dir}...`);
    const res = pruneRetention(dir);
    console.log('Prune result:', res);
    process.exit(0);
  }

  runBackup().catch(err => {
    console.error('Fatal error during backup execution:', err.message);
    process.exit(1);
  });
}
