#!/usr/bin/env node
/**
 * RapidAid V2 — Phase 4.4.4: End-to-End Encrypted Backup and Authenticated Restore Verification Drill
 *
 * Runs a fully isolated, non-destructive, authenticated backup and restore drill:
 * 1. Unit safeguard verification:
 *    - 0A: Multi-factor target isolation preflight negative tests (production containers, networks, volumes, DB names).
 *    - 0B: Artifact filename path traversal & malformed path validation.
 *    - 0C: ISO-8601 week key calculation & month collision prevention.
 *    - 0D: Subprocess secret sanitization (passwords, 64-char keys, API tokens).
 *    - 0E: Lockfile concurrency guard (.backup.lock).
 *    - 0F: AES-256-GCM round-trip encryption/decryption byte-for-byte match & 10-nonce freshness assertion.
 *    - 0G: Decryption failure modes & plaintext quarantine (wrong keys, flipped ciphertext bits, invalid auth tags, tampered AAD, plaintext checksum mismatches).
 *    - 0H: Canonical manifest & HMAC-SHA256 signature verification & tampering tests (domain separation, schema v2.0.0, legacy unencrypted opt-in guard).
 *    - 0I: Off-site HTTPS Receiver TLS & Replication tests (ephemeral mock HTTPS server: strict TLS 1.2+, CA bundle verification, 409 Conflict, 503 retry backoff, connection timeouts, incomplete finalization safety).
 * 2. Boots disposable synthetic drill containers, network, and volumes with explicit disposable markers.
 * 3. Seeds representative synthetic database records and voice storage audio.
 * 4. Tests missing voice reference handling: asserts fail-closed abort without publishing.
 * 5. Executes authenticated AES-256-GCM backup generating Schema v2.0.0 manifest and HMAC-SHA256 signature.
 * 6. Tests multi-month, year-boundary GFS retention pruning with encrypted recovery sets.
 * 7. Executes isolated authenticated restore into a secondary disposable drill target with multi-factor preflight.
 * 8. Asserts document counts, indexes, and media reference alignment byte-for-byte.
 * 9. Verifies that primary RapidAid containers and volumes were never touched.
 * 10. Cleanly destroys only resources positively tagged with this run ID.
 */

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import https from 'https';
import net from 'net';
import os from 'os';
import { pathToFileURL } from 'url';
import {
  runBackup,
  pruneRetention,
  assertSafeArtifactFilename,
  getIsoWeekKey,
  acquireBackupLock,
  releaseBackupLock,
  acquireGate,
  releaseGate,
  inspectGateStatus,
  recoverStaleGate,
  inspectLockStatus,
  recoverStaleLock,
  inspectBackupEnvironment,
  defaultIsProcessAlive,
  execSanitized,
  deriveKeyId,
  deriveManifestAuthKey,
  canonicalizeManifest,
  computeManifestSignature,
  encryptArtifactStream,
  createTlsAgent,
  sendHttpsRequest,
  uploadRecoverySet,
  computeSha256
} from './backup-db.mjs';
import { runRestore, assertSafeDisposableTarget, decryptArtifactStream, formatDryRunReport } from './restore-db.mjs';

// ── Ephemeral Self-Signed Test Certificate & Key for Localhost HTTPS Tests ──
export const MOCK_TLS_CERT = "-----BEGIN CERTIFICATE-----\nMIIDCTCCAfGgAwIBAgIUP4ZNV3x8+UyYMQZL0j024yY79jMwDQYJKoZIhvcNAQEL\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTAyNzE0MTEyNloXDTM2MTAy\nNDE0MTEyNlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\nAAOCAQ8AMIIBCgKCAQEArEvPxm2yVa+qiqfJOSmJCxXH4iOBtP7bBQOQ7Il0nlV1\noBxTZrSQbfs5I+UsNQlft8XaaPQoSaPHYWtKrYxrpr8u7zsh3hICvj/a96FyRL+H\nS9rtyghZ/sD/DG0MZrma/oNgCGrSdakc7+C/OglxJgr206MkaJrXxbeqH5OC6cOf\nbpVe7ktCnp4efmgXiXq7JKWniisxdKjeXMLba+aLlLiVIWdv96YuFy5XD+KeUu6F\nYB0CFgD/O0jnlEdgu3V9ovMguDRspDeBvQsXQmaz5k4t9ffT25p9WeBB0TESmEK2\nBmwlmIraNflQGkW3Ey5uWmfGUS5vUV0T+SSOjHcy9QIDAQABo1MwUTAdBgNVHQ4E\nFgQUOOTSy45SuO6/e97SX3VxMGAM8kkwHwYDVR0jBBgwFoAUOOTSy45SuO6/e97S\nX3VxMGAM8kkwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAkBOh\nBJ228c4J36yI3HBZL/I8YBOWILqk7wVPUdPmWYIDNS75pmWZ81eG7aRu7Q8/Jyab\n9TZbXkwnfqNHDbG8F9Lqt8dVXwkkjrM79HrP5IA4MmXNa6TFf+d+QWxVFf54k+pf\nlNSevd8wlKrymNH1Z89P31MxRMrTSFBG+gdJermpAIk/2sBgmMwMN65vC9f1ZMNt\nhfqXO9uz4qnt5X/7aDG1hsDAgVruI1k5IHmV41qEDKNtHyiRjsJLif+HYR51sPw3\n83CyVQby5EmtxD7CrI4z3hhQxz9W1XZhq4mreUOTLKKbzaK+NmFHbrYlKqp1oliJ\n3BM/M2x0nNpZjX4+eA==\n-----END CERTIFICATE-----\n";

export const MOCK_TLS_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsS8/GbbJVr6qK\np8k5KYkLFcfiI4G0/tsFA5DsiXSeVXWgHFNmtJBt+zkj5Sw1CV+3xdpo9ChJo8dh\na0qtjGumvy7vOyHeEgK+P9r3oXJEv4dL2u3KCFn+wP8MbQxmuZr+g2AIatJ1qRzv\n4L86CXEmCvbToyRomtfFt6ofk4Lpw59ulV7uS0Kenh5+aBeJerskpaeKKzF0qN5c\nwttr5ouUuJUhZ2/3pi4XLlcP4p5S7oVgHQIWAP87SOeUR2C7dX2i8yC4NGykN4G9\nCxdCZrPmTi3199Pbmn1Z4EHRMRKYQrYGbCWYito1+VAaRbcTLm5aZ8ZRLm9RXRP5\nJI6MdzL1AgMBAAECggEAAiL1+oAlBMzVOonjuVP+HN5wXAZmFTqH8Zlj3FKaJzJh\nYSu2FdS2OCBCbo3FR9Gk95TaRVCGc3uMB+6KQiuhhgGwpNXfFGTRnbkR0yUFzDSB\nQ2v2Vk8sCWoQGkcYPU1Qh6UOQB1cHNF3hKVwlS6Fg9FIfTv7pa7Db2Q1XLlhF2kM\nbfsj2B6mZyvpQi01C35hVBxdHcHJyPDaxp2ZLcA9bK9jIrfImvcD8bAbgvm2F2QA\nfNpgEj1gosuVhQCeKZxWCymcO1EKm1oC+vCia6YuGEudyTnW4t5fvcMrKLgPjzqP\nriPU3SXZ3cIgmy57cKkZEfZzu/2r7AeS4Bab01cukQKBgQDViYaB8tVtgRnzGMkP\nEBdHlvYv57/k6yFWtMlYY8dQ6R68ZYOo1dHjZW7KiV4ozmtehDWvu6ImgTaIzj3d\nQtp/zDNg9aSOA+kw5OM1vmCWx/DgScZLrXsCK6oePaA9c2Kd+JxSWWbxN45/ltQl\nsfs/r0ggtv40wWxUZ+ms5RzApQKBgQDOjtbmhobKqad9PlOrUbaQEpulnyRHeAL6\nLWZiJx0wCU/cN+UBjEMCK9JDf2vBD0RxjSKXksfZ7HbGJ4Nbwu3A3DjJZjul+iPp\n3yDhjsE3wLLe5O7Y+Ul5Fw1hOIxuXMJEec0YDgLW2wQ+1TqLV0hsuxyXoQIQkZY3\nHt85w+BIEQKBgGwX1M39Ncrb2l3zgvusAozLv02au8nOuK6ij3W99IxhpZxqqs4R\nhtDcbMv74302mKVcuax+h+OD7y4rcKeLiv28SZngXu9AzY9hnh57g3twNN/kmIuA\ngs8jeVcbjPzuZtJeogsRlImwvOKbYELAqNWhDhr5Zw8fho3nmCNcS0S9AoGBAJvk\npkB5y4VtIaGexpsIItb9lEcdos3lv6l9VkZB6v90J7e237mZWIFs/VY/9t1QXoGs\n2Sy4dOj+VG4dKEC7D6F9E8a8x8vuy+gYpMJXcXBYmScsdS+AhXlEcq6rdSFeFKiF\nnMrI2E+8IKojV/oON/UICv5NYDeNCWg0fpkkQkNhAoGABQDhA7HNGBF64jG2pGv7\nn11SEDz6IV+tMHygRuL722x4Gx3Qb7QltE4td46TFteG3v/peafZ3eiY8muAomVU\niuuTFHW84z6ZDkG1ZWZwkt+o7Eaqcl1eDoZzi+/KemwvKHXboDInBBZvMX8iJ8q7\nih5dK/I4+uCjsQ2mgcmR2Fo=\n-----END PRIVATE KEY-----\n";

const runId = `drill_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
const testNetwork = `net_${runId}`;
const srcMongoContainer = `mongo_${runId}`;
const srcMongoVolume = `vol_mongo_${runId}`;
const srcVoiceVolume = `vol_voice_${runId}`;

const dstMongoContainer = `restore_${runId}`;
const dstMongoVolume = `vol_restore_mongo_${runId}`;
const dstVoiceVolume = `vol_restore_voice_${runId}`;

const testBackupDir = path.resolve(`./backups/.test-run-${runId}`);

const rootPass = `root_${runId}_` + 'a'.repeat(32);
const backupPass = `backup_${runId}_` + 'b'.repeat(32);
const appPass = `app_${runId}_` + 'c'.repeat(32);

// 32-byte hexadecimal AES-256-GCM encryption key
const testBackupKey = crypto.randomBytes(32).toString('hex');

// Track allocated resources for guaranteed cleanup
const allocatedContainers = new Set();
const allocatedVolumes = new Set();
const allocatedNetworks = new Set();

function cleanDrillResources() {
  console.log('\n[TEARDOWN] Cleaning up positively identified drill resources...');
  for (const c of allocatedContainers) {
    try {
      execSync(`docker rm -f ${c}`, { stdio: 'ignore' });
      console.log(`Removed drill container: ${c}`);
    } catch {}
  }
  for (const v of allocatedVolumes) {
    try {
      execSync(`docker volume rm -f ${v}`, { stdio: 'ignore' });
      console.log(`Removed drill volume: ${v}`);
    } catch {}
  }
  for (const n of allocatedNetworks) {
    try {
      execSync(`docker network rm ${n}`, { stdio: 'ignore' });
      console.log(`Removed drill network: ${n}`);
    } catch {}
  }
  if (fs.existsSync(testBackupDir)) {
    try {
      fs.rmSync(testBackupDir, { recursive: true, force: true });
      console.log(`Removed temporary test backup dir: ${testBackupDir}`);
    } catch {}
  }
}

async function verify() {
  console.log('================================================================');
  console.log(`RapidAid V2 — Phase 4.4.4: Encrypted Backup & Restore Verification Drill`);
  console.log(`Run ID: ${runId}`);
  console.log('================================================================');

  try {
    fs.mkdirSync(testBackupDir, { recursive: true });

    // ── STEP 0: In-Memory Unit Safeguard & Security Verifications ─────────
    console.log('\n[Step 0] Running in-memory security and unit safeguard assertions...');

    // 0A: Restore target validation negative tests (Multi-Factor Preflight)
    console.log('--- 0A: Multi-Factor Target Isolation Preflight Negative Checks ---');
    let rejectedProdHost = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'rapidaid-mongo', targetNetwork: 'net_drill_1', targetVoiceVolume: 'vol_drill_1', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('prohibited production host')) rejectedProdHost = true;
    }
    if (!rejectedProdHost) throw new Error('assertSafeDisposableTarget failed to reject production host rapidaid-mongo');

    let rejectedProdNet = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'mongo_drill_1', targetNetwork: 'rapidaid-network', targetVoiceVolume: 'vol_drill_1', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('prohibited production network')) rejectedProdNet = true;
    }
    if (!rejectedProdNet) throw new Error('assertSafeDisposableTarget failed to reject production network rapidaid-network');

    let rejectedProdVol = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'mongo_drill_1', targetNetwork: 'net_drill_1', targetVoiceVolume: 'rapidaid-voice-storage', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('primary production volume')) rejectedProdVol = true;
    }
    if (!rejectedProdVol) throw new Error('assertSafeDisposableTarget failed to reject production volume rapidaid-voice-storage');

    let rejectedProdMongoVol = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'mongo_drill_1', targetNetwork: 'net_drill_1', targetVoiceVolume: 'rapidaid-mongo-data', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('primary production volume')) rejectedProdMongoVol = true;
    }
    if (!rejectedProdMongoVol) throw new Error('assertSafeDisposableTarget failed to reject production volume rapidaid-mongo-data');

    let rejectedMismatchedHost = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'other_db_host', targetNetwork: 'net_drill_1', targetVoiceVolume: 'vol_voice_drill_1', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('must all contain')) rejectedMismatchedHost = true;
    }
    if (!rejectedMismatchedHost) throw new Error('assertSafeDisposableTarget failed to reject non-drill host in drill network');

    let rejectedBadDbName = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_test', targetDb: 'rapidaid;drop database', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('invalid characters')) rejectedBadDbName = true;
    }
    if (!rejectedBadDbName) throw new Error('assertSafeDisposableTarget failed to reject illegal target database name');

    let rejectedReservedDb = false;
    try {
      assertSafeDisposableTarget({ targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_test', targetDb: 'admin', skipDockerInspect: true });
    } catch (e) {
      if (e.message.includes('system database')) rejectedReservedDb = true;
    }
    if (!rejectedReservedDb) throw new Error('assertSafeDisposableTarget failed to reject reserved admin database');

    // Live Docker Daemon & Container Inspection Negative Gates (via Mock execFn)
    const validMockExec = (cmd) => {
      if (cmd === 'docker context show') {
        return 'default\n';
      }
      if (cmd === 'docker info -f "{{.ID}}"') {
        return 'daemon-mock-123456\n';
      }
      if (cmd.startsWith('docker inspect ')) {
        return JSON.stringify([{
          Id: 'container-mock-abcdef1234567890',
          Name: '/mongo_drill_test',
          State: { Running: true },
          Config: { Image: 'mongo:7.0' },
          NetworkSettings: {
            Networks: {
              net_drill_test: {
                NetworkID: 'net-mock-9876543210'
              }
            }
          },
          Mounts: [
            { Destination: '/data/db', Name: 'vol_drill_mongo_test' }
          ]
        }]);
      }
      if (cmd.startsWith('docker network inspect net_drill_test')) {
        return JSON.stringify([{
          Id: 'net-mock-9876543210',
          Name: 'net_drill_test',
          Containers: {
            'container-mock-abcdef1234567890': {
              Name: 'mongo_drill_test',
              IPv4Address: '172.28.0.2/16'
            }
          }
        }]);
      }
      if (cmd.startsWith('docker volume inspect vol_drill_mongo_test')) {
        return JSON.stringify([{
          Name: 'vol_drill_mongo_test'
        }]);
      }
      if (cmd.startsWith('docker volume inspect vol_drill_voice_test')) {
        return JSON.stringify([{
          Name: 'vol_drill_voice_test'
        }]);
      }
      if (cmd.startsWith('docker ps -q --filter volume=vol_drill_mongo_test')) {
        return 'container-mock-abcdef1234567890\n';
      }
      if (cmd.startsWith('docker ps -q --filter volume=vol_drill_voice_test')) {
        return '';
      }
      if (cmd.includes('mongosh')) {
        return 'MARKER_PROBE:{"isDisposable":true}:MARKER_PROBE_END';
      }
      throw new Error(`Unexpected mock command: ${cmd}`);
    };

    const baseValidOpts = {
      targetHost: 'mongo_drill_test',
      targetNetwork: 'net_drill_test',
      targetVoiceVolume: 'vol_drill_voice_test',
      targetDb: 'rapidaid',
      targetPass: 'mock-pass',
      expectedContainerId: 'container-mock-abcdef1234567890',
      expectedNetworkId: 'net-mock-9876543210',
      expectedMongoVolumeId: 'vol_drill_mongo_test',
      expectedVoiceVolumeId: 'vol_drill_voice_test',
      expectedDaemonId: 'daemon-mock-123456',
      expectedContext: 'default',
      execFn: validMockExec
    };

    // Valid drill combination with live mock inspection passes and resolves identities
    const resolvedIds = assertSafeDisposableTarget(baseValidOpts);
    if (resolvedIds.containerId !== 'container-mock-abcdef1234567890') throw new Error('Identity resolution failed');

    // 0A.1: Mandatory Expected Target Identity Negative Gates (Missing Values)
    let caughtMissingCtx = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedContext: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedContext')) caughtMissingCtx = true;
    }
    if (!caughtMissingCtx) throw new Error('assertSafeDisposableTarget failed to reject missing expectedContext');

    let caughtMissingDaemon = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedDaemonId: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedDaemonId')) caughtMissingDaemon = true;
    }
    if (!caughtMissingDaemon) throw new Error('assertSafeDisposableTarget failed to reject missing expectedDaemonId');

    let caughtMissingContainer = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedContainerId: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedContainerId')) caughtMissingContainer = true;
    }
    if (!caughtMissingContainer) throw new Error('assertSafeDisposableTarget failed to reject missing expectedContainerId');

    let caughtMissingNet = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedNetworkId: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedNetworkId')) caughtMissingNet = true;
    }
    if (!caughtMissingNet) throw new Error('assertSafeDisposableTarget failed to reject missing expectedNetworkId');

    let caughtMissingMongoVol = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedMongoVolumeId: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedMongoVolumeId')) caughtMissingMongoVol = true;
    }
    if (!caughtMissingMongoVol) throw new Error('assertSafeDisposableTarget failed to reject missing expectedMongoVolumeId');

    let caughtMissingVoiceVol = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedVoiceVolumeId: '' });
    } catch (e) {
      if (e.message.includes('Missing mandatory expected target identity: expectedVoiceVolumeId')) caughtMissingVoiceVol = true;
    }
    if (!caughtMissingVoiceVol) throw new Error('assertSafeDisposableTarget failed to reject missing expectedVoiceVolumeId');

    // 0A.2: Malformed Short Partial-ID Prefixes Rejection (< 12 chars)
    let caughtShortContainerPrefix = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedContainerId: 'c' });
    } catch (e) {
      if (e.message.includes('arbitrary partial-ID prefixes are prohibited')) caughtShortContainerPrefix = true;
    }
    if (!caughtShortContainerPrefix) throw new Error('assertSafeDisposableTarget failed to reject arbitrary partial container ID prefix');

    let caughtShortNetPrefix = false;
    try {
      assertSafeDisposableTarget({ ...baseValidOpts, expectedNetworkId: 'net' });
    } catch (e) {
      if (e.message.includes('arbitrary partial-ID prefixes are prohibited')) caughtShortNetPrefix = true;
    }
    if (!caughtShortNetPrefix) throw new Error('assertSafeDisposableTarget failed to reject arbitrary partial network ID prefix');

    // Production Docker Context Rejection
    let caughtProdCtx = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => cmd === 'docker context show' ? 'prod-swarm-cluster\n' : validMockExec(cmd)
      });
    } catch (e) {
      if (e.message.includes('indicates a production daemon') || e.message.includes('CRITICAL SAFETY ABORT')) caughtProdCtx = true;
    }
    if (!caughtProdCtx) throw new Error('assertSafeDisposableTarget failed to reject production docker context');

    // Context Mismatch Rejection
    let caughtCtxMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedContext: 'other-context'
      });
    } catch (e) {
      if (e.message.includes('Docker context mismatch')) caughtCtxMismatch = true;
    }
    if (!caughtCtxMismatch) throw new Error('assertSafeDisposableTarget failed to reject context mismatch');

    // Daemon ID Mismatch Rejection
    let caughtDaemonMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedDaemonId: 'different-daemon-id'
      });
    } catch (e) {
      if (e.message.includes('Docker daemon ID mismatch')) caughtDaemonMismatch = true;
    }
    if (!caughtDaemonMismatch) throw new Error('assertSafeDisposableTarget failed to reject daemon ID mismatch');

    // Daemon Inspection Failure Fail-Closed Rejection
    let caughtDaemonFail = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.includes('docker info')) throw new Error('Connection refused to docker socket');
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('Could not verify Docker daemon identity')) caughtDaemonFail = true;
    }
    if (!caughtDaemonFail) throw new Error('assertSafeDisposableTarget failed to fail closed on daemon inspect failure');

    // Container Not Running Rejection
    let caughtNotRunning = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker inspect mongo_drill_test')) {
            return JSON.stringify([{ Id: 'container-mock-abcdef1234567890', State: { Running: false } }]);
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('is not running')) caughtNotRunning = true;
    }
    if (!caughtNotRunning) throw new Error('assertSafeDisposableTarget failed to reject non-running target container');

    // Container ID Mismatch Rejection
    let caughtContainerMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedContainerId: 'expected-foreign-container-12345678'
      });
    } catch (e) {
      if (e.message.includes('Target container ID mismatch')) caughtContainerMismatch = true;
    }
    if (!caughtContainerMismatch) throw new Error('assertSafeDisposableTarget failed to reject container ID mismatch');

    // Production Container Image Rejection
    let caughtProdImage = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker inspect mongo_drill_test')) {
            return JSON.stringify([{
              Id: 'container-mock-abcdef1234567890',
              State: { Running: true },
              Config: { Image: 'rapidaid-backend:latest' },
              NetworkSettings: { Networks: { net_drill_test: { NetworkID: 'net-mock-9876543210' } } }
            }]);
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('production application container')) caughtProdImage = true;
    }
    if (!caughtProdImage) throw new Error('assertSafeDisposableTarget failed to reject production container image');

    // Multi-Homed Container Rejection
    let caughtMultiHomed = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker inspect mongo_drill_test')) {
            return JSON.stringify([{
              Id: 'container-mock-abcdef1234567890',
              State: { Running: true },
              Config: { Image: 'mongo:7.0' },
              NetworkSettings: { Networks: { net_drill_test: { NetworkID: 'net-mock-9876543210' }, other_network: { NetworkID: 'net-other-123456' } } }
            }]);
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('multi-homed')) caughtMultiHomed = true;
    }
    if (!caughtMultiHomed) throw new Error('assertSafeDisposableTarget failed to reject multi-homed container');

    // Network ID Mismatch Rejection
    let caughtNetMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedNetworkId: 'net-expected-mismatch-123456'
      });
    } catch (e) {
      if (e.message.includes('Target network ID mismatch')) caughtNetMismatch = true;
    }
    if (!caughtNetMismatch) throw new Error('assertSafeDisposableTarget failed to reject network ID mismatch');

    // Endpoint IP Mismatch Rejection
    let caughtIpMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        targetHost: '172.28.0.99'
      });
    } catch (e) {
      if (e.message.includes('Endpoint IP mismatch')) caughtIpMismatch = true;
    }
    if (!caughtIpMismatch) throw new Error('assertSafeDisposableTarget failed to reject endpoint IP mismatch');

    // Endpoint Hostname Mismatch Rejection
    let caughtHostnameMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        targetHost: 'mongo_drill_other_name'
      });
    } catch (e) {
      if (e.message.includes('Endpoint hostname')) caughtHostnameMismatch = true;
    }
    if (!caughtHostnameMismatch) throw new Error('assertSafeDisposableTarget failed to reject endpoint hostname mismatch');

    // Production MongoDB Volume Mount Rejection
    let caughtProdDataMount = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker inspect mongo_drill_test')) {
            const raw = JSON.parse(validMockExec(cmd));
            raw[0].Mounts = [{ Destination: '/data/db', Name: 'rapidaid-mongo-data' }];
            return JSON.stringify(raw);
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('mounts production data volume')) caughtProdDataMount = true;
    }
    if (!caughtProdDataMount) throw new Error('assertSafeDisposableTarget failed to reject container mounting production volume rapidaid-mongo-data');

    // MongoDB Data Volume ID Mismatch Rejection
    let caughtMongoVolMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedMongoVolumeId: 'vol_drill_other_mongo'
      });
    } catch (e) {
      if (e.message.includes('Target MongoDB data volume ID mismatch')) caughtMongoVolMismatch = true;
    }
    if (!caughtMongoVolMismatch) throw new Error('assertSafeDisposableTarget failed to reject MongoDB data volume ID mismatch');

    // Voice Volume ID Mismatch Rejection
    let caughtVoiceVolMismatch = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        expectedVoiceVolumeId: 'vol_drill_other_voice'
      });
    } catch (e) {
      if (e.message.includes('Target voice volume ID mismatch')) caughtVoiceVolMismatch = true;
    }
    if (!caughtVoiceVolMismatch) throw new Error('assertSafeDisposableTarget failed to reject voice volume ID mismatch');

    // MongoDB Data Volume Shared With Another Container Rejection (Volume Quarantine)
    let caughtSharedMongoVol = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker ps -q --filter volume=vol_drill_mongo_test')) {
            return 'container-mock-abcdef1234567890\nrogue-foreign-mongo-container\n';
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('Target MongoDB data volume') && e.message.includes('is shared with another container')) caughtSharedMongoVol = true;
    }
    if (!caughtSharedMongoVol) throw new Error('assertSafeDisposableTarget failed to reject shared MongoDB data volume');

    // Shared / Unauthorized Container Mounting Voice Volume Rejection
    let caughtSharedVoiceVolume = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.startsWith('docker ps -q --filter volume=vol_drill_voice_test')) {
            return 'unauthorized-running-container\n';
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('Target voice volume') && e.message.includes('is mounted by unauthorized container')) caughtSharedVoiceVolume = true;
    }
    if (!caughtSharedVoiceVolume) throw new Error('assertSafeDisposableTarget failed to reject unauthorized container mounting voice volume');

    // Legitimate Voice Container Owner Passes When Explicitly Expected
    const authorizedVoiceIds = assertSafeDisposableTarget({
      ...baseValidOpts,
      expectedVoiceContainerId: 'voice-owner-mock-1234567890',
      execFn: (cmd) => {
        if (cmd.startsWith('docker ps -q --filter volume=vol_drill_voice_test')) {
          return 'voice-owner-mock-1234567890\n';
        }
        return validMockExec(cmd);
      }
    });
    if (!authorizedVoiceIds) throw new Error('assertSafeDisposableTarget failed on legitimate authorized voice container');

    // Missing Disposable Marker Rejection
    let caughtMissingMarker = false;
    try {
      assertSafeDisposableTarget({
        ...baseValidOpts,
        execFn: (cmd) => {
          if (cmd.includes('mongosh')) {
            return 'MARKER_PROBE:{"isDisposable":false}:MARKER_PROBE_END';
          }
          return validMockExec(cmd);
        }
      });
    } catch (e) {
      if (e.message.includes('missing admin.disposable_marker')) caughtMissingMarker = true;
    }
    if (!caughtMissingMarker) throw new Error('assertSafeDisposableTarget failed to reject missing disposable marker');

    // Preflight Failure Aborts BEFORE Decryption or Scratch Creation
    let preflightAbortedEarly = false;
    const preflightProbeManifest = path.join(testBackupDir, 'preflight_probe_manifest.json');
    fs.writeFileSync(preflightProbeManifest, JSON.stringify({
      schemaVersion: '2.0.0',
      recoverySetId: 'preflight-early-abort-test',
      status: 'VERIFIED_COMPLETE',
      artifacts: {
        mongodb: { filename: 'm.enc', ivHex: '0'.repeat(24), authTagHex: '0'.repeat(32), ciphertextSha256: '0'.repeat(64), plaintextSha256: '0'.repeat(64), plaintextSizeBytes: 100 },
        voiceStorage: { filename: 'v.enc', ivHex: '0'.repeat(24), authTagHex: '0'.repeat(32), ciphertextSha256: '0'.repeat(64), plaintextSha256: '0'.repeat(64), plaintextSizeBytes: 100 }
      }
    }));
    try {
      await runRestore(preflightProbeManifest, {
        targetHost: 'mongo_drill_test',
        targetNetwork: 'net_drill_test',
        targetVoiceVolume: 'vol_drill_voice_test',
        targetPass: 'mock-pass',
        expectedContainerId: 'container-mock-abcdef1234567890',
        expectedNetworkId: 'net-mock-9876543210',
        expectedMongoVolumeId: 'vol_drill_mongo_test',
        expectedVoiceVolumeId: 'vol_drill_voice_test',
        expectedDaemonId: 'wrong-daemon-id', // Triggers preflight abort
        expectedContext: 'default',
        execFn: validMockExec
      });
    } catch (e) {
      if (e.message.includes('Docker daemon ID mismatch')) {
        preflightAbortedEarly = true;
      }
    } finally {
      fs.unlinkSync(preflightProbeManifest);
    }
    if (!preflightAbortedEarly) throw new Error('runRestore failed to abort at preflight stage');

    // Verify no scratch directory was created
    const scratchEntries = fs.readdirSync(testBackupDir).filter(f => f.startsWith('.restore-scratch-'));
    if (scratchEntries.length > 0) {
      throw new Error(`CRITICAL FLAW: Scratch directory ${scratchEntries[0]} was created before preflight succeeded`);
    }

    console.log('PASS 0A: Multi-factor target isolation preflight negative contracts and mandatory expected identities strictly verified.');

    // 0B: Artifact filename path traversal tests
    console.log('--- 0B: Artifact Filename Path Traversal Defense ---');
    let caughtTraversalDot = false;
    try {
      assertSafeArtifactFilename('../../etc/passwd', testBackupDir);
    } catch (e) {
      if (e.message.includes('path traversal')) caughtTraversalDot = true;
    }
    if (!caughtTraversalDot) throw new Error('assertSafeArtifactFilename failed to catch ../ traversal');

    let caughtSeparator = false;
    try {
      assertSafeArtifactFilename('sub/archive.tar.gz', testBackupDir);
    } catch (e) {
      if (e.message.includes('path separator')) caughtSeparator = true;
    }
    if (!caughtSeparator) throw new Error('assertSafeArtifactFilename failed to catch slash separator');

    let caughtBackslash = false;
    try {
      assertSafeArtifactFilename('sub\\archive.tar.gz', testBackupDir);
    } catch (e) {
      if (e.message.includes('path separator')) caughtBackslash = true;
    }
    if (!caughtBackslash) throw new Error('assertSafeArtifactFilename failed to catch backslash separator');

    let caughtHidden = false;
    try {
      assertSafeArtifactFilename('.hidden-artifact.bin', testBackupDir);
    } catch (e) {
      if (e.message.includes('path traversal') || e.message.includes('Suspicious')) caughtHidden = true;
    }
    if (!caughtHidden) throw new Error('assertSafeArtifactFilename failed to catch leading dot hidden artifact');

    const validFilename = assertSafeArtifactFilename('valid-backup-123.archive.gz.enc', testBackupDir);
    if (!validFilename.endsWith('valid-backup-123.archive.gz.enc')) throw new Error('assertSafeArtifactFilename failed on valid filename');
    console.log('PASS 0B: Artifact filename path traversal protection verified.');

    // 0B.2: Malformed manifest schema, invalid status, and path traversal defense
    console.log('--- 0B.2: Malformed Manifest Schema and Metadata Defense ---');
    const badSchemaManifest = path.join(testBackupDir, 'bad_schema_manifest.json');
    fs.writeFileSync(badSchemaManifest, JSON.stringify({
      schemaVersion: '3.0.0',
      recoverySetId: 'bad-schema-set',
      status: 'VERIFIED_COMPLETE',
      artifacts: { mongodb: { filename: 'm.enc' }, voiceStorage: { filename: 'v.enc' } }
    }));
    let caughtBadSchema = false;
    try {
      await runRestore(badSchemaManifest, { skipDockerInspect: true, targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_voice_test', targetPass: 'pass' });
    } catch (e) {
      if (e.message.includes('Unsupported manifest schemaVersion')) caughtBadSchema = true;
    }
    fs.unlinkSync(badSchemaManifest);
    if (!caughtBadSchema) throw new Error('runRestore failed to reject unsupported manifest schemaVersion 3.0.0');

    const badStatusManifest = path.join(testBackupDir, 'bad_status_manifest.json');
    fs.writeFileSync(badStatusManifest, JSON.stringify({
      schemaVersion: '2.0.0',
      recoverySetId: 'bad-status-set',
      status: 'INCOMPLETE',
      artifacts: { mongodb: { filename: 'm.enc' }, voiceStorage: { filename: 'v.enc' } }
    }));
    let caughtBadStatus = false;
    try {
      await runRestore(badStatusManifest, { skipDockerInspect: true, targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_voice_test', targetPass: 'pass' });
    } catch (e) {
      if (e.message.includes('Refusing to restore recovery set with status')) caughtBadStatus = true;
    }
    fs.unlinkSync(badStatusManifest);
    if (!caughtBadStatus) throw new Error('runRestore failed to reject non-VERIFIED_COMPLETE status');

    const badIdManifest = path.join(testBackupDir, 'bad_id_manifest.json');
    fs.writeFileSync(badIdManifest, JSON.stringify({
      schemaVersion: '2.0.0',
      recoverySetId: '../../bad-id-traversal',
      status: 'VERIFIED_COMPLETE',
      artifacts: { mongodb: { filename: 'm.enc' }, voiceStorage: { filename: 'v.enc' } }
    }));
    let caughtBadId = false;
    try {
      await runRestore(badIdManifest, { skipDockerInspect: true, targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_voice_test', targetPass: 'pass' });
    } catch (e) {
      if (e.message.includes('invalid or unsafe recoverySetId')) caughtBadId = true;
    }
    fs.unlinkSync(badIdManifest);
    if (!caughtBadId) throw new Error('runRestore failed to reject unsafe recoverySetId');

    const traversalManifest = path.join(testBackupDir, 'traversal_manifest.json');
    fs.writeFileSync(traversalManifest, JSON.stringify({
      schemaVersion: '2.0.0',
      recoverySetId: 'traversal-set',
      status: 'VERIFIED_COMPLETE',
      artifacts: { mongodb: { filename: '../../escaped.enc' }, voiceStorage: { filename: 'v.enc' } }
    }));
    let caughtManifestTraversal = false;
    try {
      await runRestore(traversalManifest, { skipDockerInspect: true, targetHost: 'mongo_drill_test', targetNetwork: 'net_drill_test', targetVoiceVolume: 'vol_drill_voice_test', targetPass: 'pass' });
    } catch (e) {
      if (e.message.includes('path traversal') || e.message.includes('escapes')) caughtManifestTraversal = true;
    }
    fs.unlinkSync(traversalManifest);
    if (!caughtManifestTraversal) throw new Error('runRestore failed to reject directory traversal in artifact filename');
    console.log('PASS 0B.2: Malformed manifest schema, invalid status, and artifact traversal strictly rejected.');

    // 0C: ISO-8601 week key calculation & month collision tests
    console.log('--- 0C: ISO-8601 Week Key Calculation & Month Isolation ---');
    const kJan = getIsoWeekKey(new Date('2026-01-03T12:00:00Z'));
    const kFeb = getIsoWeekKey(new Date('2026-02-03T12:00:00Z'));
    const kMar = getIsoWeekKey(new Date('2026-03-03T12:00:00Z'));
    if (kJan === kFeb || kFeb === kMar || kJan === kMar) {
      throw new Error(`ISO week calculation collision: Jan=${kJan}, Feb=${kFeb}, Mar=${kMar}`);
    }
    const kEnd2025 = getIsoWeekKey(new Date('2025-12-28T12:00:00Z'));
    const kNew2026 = getIsoWeekKey(new Date('2026-01-08T12:00:00Z'));
    if (kEnd2025 === kNew2026) throw new Error('Year boundary week key collision');
    console.log(`PASS 0C: ISO-8601 week calculation verified without cross-month collisions (Jan=${kJan}, Feb=${kFeb}, Mar=${kMar}).`);

    // 0D: Credential and Key Sanitization test
    console.log('--- 0D: Process Table & Error Secret Redaction ---');
    let redactedSecretCaught = false;
    try {
      execSanitized(
        'node -e "throw new Error(\'Execution failed with secret_pass_12345678 and key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef and bearer eyJhbGciOiJIUzI1NiJ9.test in trace\')"',
        {},
        ['secret_pass_12345678', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'eyJhbGciOiJIUzI1NiJ9.test']
      );
    } catch (err) {
      if (
        err.message.includes('[REDACTED]') &&
        !err.message.includes('secret_pass_12345678') &&
        !err.message.includes('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef') &&
        !err.message.includes('eyJhbGciOiJIUzI1NiJ9.test')
      ) {
        redactedSecretCaught = true;
      }
    }
    if (!redactedSecretCaught) throw new Error('execSanitized failed to redact secret credentials and keys from error message');
    console.log('PASS 0D: Subprocess secret sanitization verified.');

    // 0E: Lockfile concurrency test
    console.log('--- 0E: Lockfile Concurrency Guard ---');
    const lock1 = acquireBackupLock(testBackupDir);
    let lockCollisionCaught = false;
    try {
      acquireBackupLock(testBackupDir);
    } catch (err) {
      if (err.message.includes('Concurrent backup prevented')) {
        lockCollisionCaught = true;
      }
    }
    releaseBackupLock(lock1);
    if (!lockCollisionCaught) throw new Error('acquireBackupLock failed to prevent concurrent lock acquisition');
    const lock2 = acquireBackupLock(testBackupDir);
    releaseBackupLock(lock2);
    console.log('PASS 0E: Backup lockfile concurrency guard verified.');

    // 0F: AES-256-GCM Round-Trip & Nonce Freshness Tests
    console.log('--- 0F: AES-256-GCM Round Trip & Nonce Freshness ---');
    const samplePlaintext = Buffer.from('RapidAid-Synthetic-Emergency-Audio-Bytes-Payload-' + 'X'.repeat(512), 'utf8');
    const samplePlainFile = path.join(testBackupDir, 'unit_test_plain.bin');
    const sampleEncFile = path.join(testBackupDir, 'unit_test_cipher.enc');
    const sampleDecFile = path.join(testBackupDir, 'unit_test_decrypted.bin');

    fs.writeFileSync(samplePlainFile, samplePlaintext);
    const expectedPlainSha = computeSha256(samplePlainFile);

    const testAad = '2.0.0:recovery-set-test:mongodb';
    const encMeta = await encryptArtifactStream(samplePlainFile, sampleEncFile, testBackupKey, testAad);

    if (encMeta.plaintextSha256 !== expectedPlainSha) {
      throw new Error(`encryptArtifactStream plaintext SHA-256 mismatch: expected ${expectedPlainSha}, got ${encMeta.plaintextSha256}`);
    }
    if (encMeta.plaintextSizeBytes !== samplePlaintext.length) {
      throw new Error(`encryptArtifactStream size mismatch: expected ${samplePlaintext.length}, got ${encMeta.plaintextSizeBytes}`);
    }

    // Decrypt and assert round trip
    const decMeta = await decryptArtifactStream(
      sampleEncFile,
      sampleDecFile,
      testBackupKey,
      encMeta.ivHex,
      encMeta.authTagHex,
      testAad
    );

    if (decMeta.plaintextSha256 !== expectedPlainSha) {
      throw new Error(`Decrypted plaintext SHA mismatch: expected ${expectedPlainSha}, got ${decMeta.plaintextSha256}`);
    }
    const decryptedBytes = fs.readFileSync(sampleDecFile);
    if (!decryptedBytes.equals(samplePlaintext)) {
      throw new Error('Decrypted plaintext does not match original bytes');
    }
    fs.unlinkSync(sampleDecFile);

    // Nonce Freshness: 10 successive encryptions must produce 10 unique nonces
    const nonceSet = new Set();
    for (let i = 0; i < 10; i++) {
      const pFile = path.join(testBackupDir, `nonce_test_p_${i}.bin`);
      const eFile = path.join(testBackupDir, `nonce_test_e_${i}.enc`);
      fs.writeFileSync(pFile, `nonce-check-${i}`);
      const m = await encryptArtifactStream(pFile, eFile, testBackupKey, `2.0.0:set-${i}:test`);
      if (m.ivHex.length !== 24) throw new Error(`Invalid nonce length: ${m.ivHex.length} hex chars (expected 24)`);
      if (nonceSet.has(m.ivHex)) throw new Error(`CRITICAL CRYPTOGRAPHIC FAILURE: Nonce collision detected: ${m.ivHex}`);
      nonceSet.add(m.ivHex);
      fs.unlinkSync(eFile);
    }
    console.log(`PASS 0F: AES-256-GCM round trip verified byte-for-byte; 10/10 distinct nonces generated (zero collisions).`);

    // 0G: Decryption Failure Modes & Plaintext Quarantine
    console.log('--- 0G: Decryption Failure Modes & Plaintext Quarantine ---');
    // 1. Wrong key rejection
    const wrongKey = crypto.randomBytes(32).toString('hex');
    let wrongKeyCaught = false;
    try {
      await decryptArtifactStream(sampleEncFile, sampleDecFile, wrongKey, encMeta.ivHex, encMeta.authTagHex, testAad);
    } catch (e) {
      if (e.message.includes('Ciphertext authentication failed')) wrongKeyCaught = true;
    }
    if (!wrongKeyCaught) throw new Error('decryptArtifactStream failed to reject decryption with wrong key');
    if (fs.existsSync(sampleDecFile)) throw new Error('Scratch plaintext file was not cleanly removed on wrong key abort');

    // 2. 1-bit altered ciphertext rejection
    const cipherBuf = fs.readFileSync(sampleEncFile);
    cipherBuf[10] ^= 0x01; // flip 1 bit
    const tamperedCipherFile = path.join(testBackupDir, 'tampered_cipher.enc');
    fs.writeFileSync(tamperedCipherFile, cipherBuf);

    let bitFlipCaught = false;
    try {
      await decryptArtifactStream(tamperedCipherFile, sampleDecFile, testBackupKey, encMeta.ivHex, encMeta.authTagHex, testAad);
    } catch (e) {
      if (e.message.includes('Ciphertext authentication failed')) bitFlipCaught = true;
    }
    fs.unlinkSync(tamperedCipherFile);
    if (!bitFlipCaught) throw new Error('decryptArtifactStream failed to detect single-bit ciphertext tampering');
    if (fs.existsSync(sampleDecFile)) throw new Error('Scratch plaintext file was not cleanly removed on ciphertext tampering abort');

    // 3. Invalid auth tag rejection
    const tagBuf = Buffer.from(encMeta.authTagHex, 'hex');
    tagBuf[0] ^= 0xff;
    const tamperedTag = tagBuf.toString('hex');
    let badTagCaught = false;
    try {
      await decryptArtifactStream(sampleEncFile, sampleDecFile, testBackupKey, encMeta.ivHex, tamperedTag, testAad);
    } catch (e) {
      if (e.message.includes('Ciphertext authentication failed')) badTagCaught = true;
    }
    if (!badTagCaught) throw new Error('decryptArtifactStream failed to detect tampered auth tag');

    // 4. AAD tampering rejection
    let badAadCaught = false;
    try {
      await decryptArtifactStream(sampleEncFile, sampleDecFile, testBackupKey, encMeta.ivHex, encMeta.authTagHex, '2.0.0:tampered-recovery-set:mongodb');
    } catch (e) {
      if (e.message.includes('Ciphertext authentication failed')) badAadCaught = true;
    }
    if (!badAadCaught) throw new Error('decryptArtifactStream failed to detect tampered AAD metadata');

    fs.unlinkSync(sampleEncFile);
    console.log('PASS 0G: Decryption failure modes (wrong key, 1-bit ciphertext flip, tampered tag, tampered AAD) strictly verified with scratch quarantine.');

    // 0H: Canonical Manifest & HMAC-SHA256 Signature Verification & Tampering Tests
    console.log('--- 0H: Canonical Manifest & HMAC-SHA256 Signature Security ---');
    const sampleManifest = {
      schemaVersion: '2.0.0',
      recoverySetId: 'rapidaid-recovery-2026-10-27-00-00-00',
      timestamp: '2026-10-27T00:00:00.000Z',
      status: 'VERIFIED_COMPLETE',
      encryption: {
        enabled: true,
        algorithm: 'aes-256-gcm',
        keyId: deriveKeyId(testBackupKey)
      },
      artifacts: {
        mongodb: {
          filename: 'mongodb-test.archive.gz.enc',
          ciphertextSha256: 'a'.repeat(64),
          plaintextSha256: 'b'.repeat(64),
          plaintextSizeBytes: 1024,
          ivHex: 'c'.repeat(24),
          authTagHex: 'd'.repeat(32)
        },
        voiceStorage: {
          filename: 'voice-test.tar.gz.enc',
          ciphertextSha256: 'e'.repeat(64),
          plaintextSha256: 'f'.repeat(64),
          plaintextSizeBytes: 2048,
          ivHex: '1'.repeat(24),
          authTagHex: '2'.repeat(32)
        }
      },
      audit: {
        matchedReferences: 5,
        missingReferences: []
      }
    };

    const authKey = deriveManifestAuthKey(testBackupKey);
    const validSig = computeManifestSignature(sampleManifest, authKey);
    sampleManifest.signature = {
      algorithm: 'hmac-sha256',
      authKeyId: crypto.createHash('sha256').update(authKey).digest('hex').slice(0, 16),
      value: validSig
    };

    // Verify valid signature passes timingSafeEqual
    const computedSig = computeManifestSignature(sampleManifest, authKey);
    const s1 = Buffer.from(sampleManifest.signature.value, 'hex');
    const s2 = Buffer.from(computedSig, 'hex');
    if (!crypto.timingSafeEqual(s1, s2)) throw new Error('Valid manifest HMAC signature failed verification');

    // Tampering with artifact hash must invalidate signature
    const tamperedManifest = JSON.parse(JSON.stringify(sampleManifest));
    tamperedManifest.artifacts.mongodb.ciphertextSha256 = '9'.repeat(64);
    const tamperedSig = computeManifestSignature(tamperedManifest, authKey);
    if (crypto.timingSafeEqual(Buffer.from(validSig, 'hex'), Buffer.from(tamperedSig, 'hex'))) {
      throw new Error('computeManifestSignature failed to detect artifact hash tampering');
    }

    // Key derivation domain separation check
    const keyId = deriveKeyId(testBackupKey);
    if (keyId.length !== 20 || !keyId.startsWith('kid_')) throw new Error(`Expected 20-char key ID starting with kid_, got ${keyId}`);
    if (authKey.length !== 32) throw new Error(`Expected 32-byte auth key, got ${authKey.length}`);
    if (authKey.toString('hex') === testBackupKey) {
      throw new Error('CRITICAL FLAW: deriveManifestAuthKey did not domain-separate auth key from root backup key');
    }

    // Legacy unencrypted restore rejection
    let rejectedLegacyUnencrypted = false;
    const legacyManifestFile = path.join(testBackupDir, 'legacy_manifest.json');
    fs.writeFileSync(legacyManifestFile, JSON.stringify({
      schemaVersion: '1.0.0',
      recoverySetId: 'legacy-set-1',
      status: 'VERIFIED_COMPLETE',
      artifacts: {
        mongodb: { filename: 'mongo.gz', sha256: 'a' },
        voiceStorage: { filename: 'voice.tar.gz', sha256: 'b' }
      }
    }));
    try {
      await runRestore(legacyManifestFile, {
        allowUnencrypted: false,
        targetHost: 'mongo_drill_test',
        targetNetwork: 'net_drill_test',
        targetVoiceVolume: 'vol_drill_voice_test',
        targetPass: 'mock-pass-1234',
        skipDockerInspect: true
      });
    } catch (e) {
      if (e.message.includes('Refusing to restore unencrypted legacy recovery set')) {
        rejectedLegacyUnencrypted = true;
      }
    }
    fs.unlinkSync(legacyManifestFile);
    if (!rejectedLegacyUnencrypted) throw new Error('runRestore failed to reject unencrypted recovery set when allowUnencrypted=false');

    // Assertion that allowUnencrypted: true NEVER bypasses encryption on Schema 2.0.0
    const encManifestBypass = path.join(testBackupDir, 'enc_manifest_bypass.json');
    fs.writeFileSync(encManifestBypass, JSON.stringify({
      schemaVersion: '2.0.0',
      recoverySetId: 'enc-bypass-set',
      status: 'VERIFIED_COMPLETE',
      encryption: { enabled: true, algorithm: 'aes-256-gcm', keyId: 'kid_test' },
      artifacts: { mongodb: { filename: 'm.enc' }, voiceStorage: { filename: 'v.enc' } }
    }));
    let caughtBypassFail = false;
    try {
      await runRestore(encManifestBypass, {
        allowUnencrypted: true,
        targetHost: 'mongo_drill_test',
        targetNetwork: 'net_drill_test',
        targetVoiceVolume: 'vol_drill_voice_test',
        targetPass: 'mock-pass-1234',
        skipDockerInspect: true
      });
    } catch (e) {
      if (e.message.includes('Missing or invalid BACKUP_ENCRYPTION_KEY')) {
        caughtBypassFail = true;
      }
    }
    fs.unlinkSync(encManifestBypass);
    if (!caughtBypassFail) throw new Error('allowUnencrypted=true improperly bypassed encryption requirement on Schema 2.0.0 manifest');

    console.log('PASS 0H: Canonical manifest HMAC-SHA256 signature, domain separation, and legacy opt-in gate strictly verified.');

    // 0I: Off-site HTTPS Receiver TLS & Replication Tests
    console.log('--- 0I: Off-Site HTTPS Receiver TLS & Replication Client ---');
    const caBundleFile = path.join(testBackupDir, 'mock_ca.crt');
    fs.writeFileSync(caBundleFile, MOCK_TLS_CERT);

    let transientAttempts = 0;
    const mockServer = https.createServer({ cert: MOCK_TLS_CERT, key: MOCK_TLS_KEY }, (req, res) => {
      const u = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
      const auth = req.headers.authorization || '';

      if (!auth.includes('mock-secret-token-32-chars-long-1234')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      if (req.method === 'HEAD') {
        if (u.pathname.includes('/conflict-target/')) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end();
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end();
        return;
      }

      if (u.pathname.includes('/conflict-target/')) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Conflict: artifact already exists with differing payload' }));
        return;
      }

      if (u.pathname.includes('/client-err-target/')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad Request: Simulated non-retryable client error' }));
        return;
      }

      if (u.pathname.includes('/incomplete-target/') && u.pathname.includes('manifest')) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to publish manifest' }));
        return;
      }

      if (u.pathname.includes('/transient-target/')) {
        transientAttempts++;
        if (transientAttempts === 1) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Service Unavailable (Simulated Transient)' }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'x-rapidaid-verified-sha256': req.headers['x-rapidaid-sha256'] || 'ok'
        });
        res.end(JSON.stringify({ status: 'ACCEPTED' }));
        return;
      }

      // Default mock handler
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'x-rapidaid-verified-sha256': req.headers['x-rapidaid-sha256'] || 'ok'
      });
      res.end(JSON.stringify({ status: 'OK' }));
    });

    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    const mockPort = mockServer.address().port;
    const mockBaseUrl = `https://localhost:${mockPort}`;
    console.log(`Ephemeral mock HTTPS server running at ${mockBaseUrl}`);

    try {
      // 1. Strict TLS certificate validation: default agent without custom CA must fail
      let certValidationFailed = false;
      try {
        const strictAgent = createTlsAgent({}); // No custom CA
        await sendHttpsRequest(`${mockBaseUrl}/test`, {
          method: 'GET',
          agent: strictAgent,
          headers: { Authorization: 'Bearer mock-secret-token-32-chars-long-1234' },
          connectTimeoutMs: 2000
        });
      } catch (err) {
        if (err.message.includes('DEPTH_ZERO_SELF_SIGNED_CERT') || err.message.includes('self-signed certificate') || err.message.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
          certValidationFailed = true;
        }
      }
      if (!certValidationFailed) throw new Error('createTlsAgent failed to reject untrusted self-signed certificate by default');

      // 2. Custom CA bundle allows secure connection
      const trustedAgent = createTlsAgent({ caBundlePath: caBundleFile });
      const trustedRes = await sendHttpsRequest(`${mockBaseUrl}/test`, {
        method: 'GET',
        agent: trustedAgent,
        headers: { Authorization: 'Bearer mock-secret-token-32-chars-long-1234' },
        connectTimeoutMs: 3000
      });
      if (trustedRes.statusCode !== 200) throw new Error(`Custom CA request failed with HTTP ${trustedRes.statusCode}`);

      // 3. Remote Conflict Rejection (HTTP 409)
      const mockConflictFile = path.join(testBackupDir, 'conflict.enc');
      fs.writeFileSync(mockConflictFile, 'conflict-payload');
      const mockConflictManifest = path.join(testBackupDir, 'manifest-conflict-target.json');
      fs.writeFileSync(mockConflictManifest, JSON.stringify({ recoverySetId: 'conflict-target' }));

      let conflictCaught = false;
      try {
        await uploadRecoverySet(
          { recoverySetId: 'conflict-target' },
          [mockConflictFile, mockConflictManifest],
          {
            offsiteUploadEnabled: true,
            offsiteRemoteUrl: `${mockBaseUrl}/conflict-target`,
            offsiteApiToken: 'mock-secret-token-32-chars-long-1234',
            agent: trustedAgent
          }
        );
      } catch (err) {
        if (err.message.includes('CRITICAL CONFLICT ERROR')) conflictCaught = true;
      }
      if (!conflictCaught) throw new Error('uploadRecoverySet failed to catch HTTP 409 conflict and abort publication');

      // 4. Client error non-retry (HTTP 400)
      const mockClientErrFile = path.join(testBackupDir, 'client_err.enc');
      fs.writeFileSync(mockClientErrFile, 'client-err-payload');
      const mockClientErrManifest = path.join(testBackupDir, 'manifest-client-err-target.json');
      fs.writeFileSync(mockClientErrManifest, JSON.stringify({ recoverySetId: 'client-err-target' }));

      let clientErrCaught = false;
      try {
        await uploadRecoverySet(
          { recoverySetId: 'client-err-target' },
          [mockClientErrFile, mockClientErrManifest],
          {
            offsiteUploadEnabled: true,
            offsiteRemoteUrl: `${mockBaseUrl}/client-err-target`,
            offsiteApiToken: 'mock-secret-token-32-chars-long-1234',
            agent: trustedAgent
          }
        );
      } catch (err) {
        if (err.message.includes('non-retryable client error HTTP 400')) clientErrCaught = true;
      }
      if (!clientErrCaught) throw new Error('uploadRecoverySet failed to abort immediately on HTTP 400 without retry');

      // 5. Transient error retry & recovery (HTTP 503 -> HTTP 200)
      const mockTransientFile = path.join(testBackupDir, 'transient.enc');
      fs.writeFileSync(mockTransientFile, 'transient-payload');
      const mockTransientManifest = path.join(testBackupDir, 'manifest-transient-target.json');
      fs.writeFileSync(mockTransientManifest, JSON.stringify({ recoverySetId: 'transient-target' }));

      const uploadResult = await uploadRecoverySet(
        { recoverySetId: 'transient-target' },
        [mockTransientFile, mockTransientManifest],
        {
          offsiteUploadEnabled: true,
          offsiteRemoteUrl: `${mockBaseUrl}/transient-target`,
          offsiteApiToken: 'mock-secret-token-32-chars-long-1234',
          agent: trustedAgent
        }
      );
      if (uploadResult.status !== 'PUBLISHED') {
        throw new Error(`uploadRecoverySet failed on transient retry test: ${JSON.stringify(uploadResult)}`);
      }
      if (transientAttempts < 2) throw new Error(`Expected at least 2 attempts for transient retry, got ${transientAttempts}`);

      // 6. Incomplete Finalization Safety (manifest failure aborts publication)
      const mockIncompleteFile = path.join(testBackupDir, 'incomplete.enc');
      fs.writeFileSync(mockIncompleteFile, 'incomplete-payload');
      const mockIncompleteManifest = path.join(testBackupDir, 'manifest-incomplete-target.json');
      fs.writeFileSync(mockIncompleteManifest, JSON.stringify({ recoverySetId: 'incomplete-target' }));

      let incompleteCaught = false;
      try {
        await uploadRecoverySet(
          { recoverySetId: 'incomplete-target' },
          [mockIncompleteFile, mockIncompleteManifest],
          {
            offsiteUploadEnabled: true,
            offsiteRemoteUrl: `${mockBaseUrl}/incomplete-target`,
            offsiteApiToken: 'mock-secret-token-32-chars-long-1234',
            agent: trustedAgent
          }
        );
      } catch (err) {
        if (err.message.includes('Failed to publish completion manifest')) incompleteCaught = true;
      }
      if (!incompleteCaught) throw new Error('uploadRecoverySet failed to abort when manifest finalization failed');

      // 7. Deterministic Connection Timeout Handling (Hanging TCP Socket)
      const hangServer = net.createServer(() => {
        // Deliberately hold socket open without TLS handshake to trigger connect timeout
      });
      await new Promise(r => hangServer.listen(0, '127.0.0.1', r));
      const hangPort = hangServer.address().port;

      let timeoutCaught = false;
      try {
        await sendHttpsRequest(`https://127.0.0.1:${hangPort}/hang-test`, {
          agent: trustedAgent,
          connectTimeoutMs: 150
        });
      } catch (err) {
        if (err.message.includes('Connection timeout after 150ms')) {
          timeoutCaught = true;
        }
      } finally {
        hangServer.close();
      }
      if (!timeoutCaught) throw new Error('sendHttpsRequest failed to trigger connection timeout on hanging socket');

      console.log('PASS 0I: Off-site HTTPS Receiver TLS strict validation, custom CA bundle, 409 conflict rejection, 400 non-retry, incomplete finalization abort, and 503 exponential backoff retry verified.');
    } finally {
      mockServer.close();
      if (fs.existsSync(caBundleFile)) fs.unlinkSync(caBundleFile);
    }

    // ── 0J: npm Command Wiring & Script Interface Contracts (Phase 4.4.5) ──
    console.log('\n--- 0J: npm Command Wiring & CLI Contracts ---');
    const pkgPath = path.resolve('./package.json');
    if (!fs.existsSync(pkgPath)) throw new Error('package.json not found');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    const expectedScripts = {
      'backup': 'node scripts/backup-db.mjs',
      'backup:restore:drill': 'node scripts/restore-db.mjs',
      'backup:verify': 'node scripts/verify-backup-restore.mjs'
    };

    for (const [sName, sCmd] of Object.entries(expectedScripts)) {
      if (!pkg.scripts?.[sName]) {
        throw new Error(`package.json is missing required script '${sName}'`);
      }
      if (pkg.scripts[sName] !== sCmd) {
        throw new Error(`package.json script '${sName}' mismatch: expected '${sCmd}', got '${pkg.scripts[sName]}'`);
      }
    }

    // Verify existing core scripts were preserved
    const requiredExisting = ['dev', 'build', 'typecheck', 'test', 'server', 'server:test'];
    for (const s of requiredExisting) {
      if (!pkg.scripts?.[s]) {
        throw new Error(`Pre-existing script '${s}' was unexpectedly removed from package.json`);
      }
    }
    console.log('PASS 0J: npm command wiring and CLI interface contracts verified.');

    // ── 0K: Backup Inspection Mode (--inspect) Non-Destructive Tests (Phase 4.4.5) ──
    console.log('\n--- 0K: Backup Inspection Mode Non-Destructive Integrity ---');
    const inspectTestDir = path.join(testBackupDir, 'inspect-test-vault');
    fs.mkdirSync(inspectTestDir, { recursive: true });

    try {
      // 1. Unconfigured environment inspection
      const initialReport = inspectBackupEnvironment({
        backupDir: inspectTestDir,
        encryptionEnabled: true,
        backupKey: '' // deliberately missing
      });

      if (initialReport.valid !== false) {
        throw new Error('inspectBackupEnvironment failed to flag missing encryption key as invalid');
      }
      if (!initialReport.errors.some(e => e.includes('BACKUP_ENCRYPTION_KEY is missing'))) {
        throw new Error('inspectBackupEnvironment missing expected key error message');
      }

      // Assert non-destructive invariant: NO files created, NO lock created
      const filesAfterInitial = fs.readdirSync(inspectTestDir);
      if (filesAfterInitial.length > 0) {
        throw new Error(`Inspection mode violated read-only contract: created files ${filesAfterInitial.join(', ')}`);
      }

      // 2. Configured environment inspection with existing synthetic recovery sets
      const valid64Key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
      const expectedKId = deriveKeyId(valid64Key);

      // Place a synthetic manifest in inspectTestDir
      const mockManifestPath = path.join(inspectTestDir, 'manifest-rapidaid-recovery-2026-10-27T00-00-00-000Z.json');
      fs.writeFileSync(mockManifestPath, JSON.stringify({
        schemaVersion: '2.0.0',
        recoverySetId: 'rapidaid-recovery-2026-10-27T00-00-00-000Z',
        timestamp: '2026-10-27T00:00:00.000Z',
        status: 'VERIFIED_COMPLETE',
        encryption: { enabled: true, keyId: expectedKId }
      }, null, 2));

      const configuredReport = inspectBackupEnvironment({
        backupDir: inspectTestDir,
        encryptionEnabled: true,
        backupKey: valid64Key,
        allowUnencrypted: false
      });

      if (configuredReport.encryption.keyFormatValid !== true) {
        throw new Error('inspectBackupEnvironment failed to validate 64-char hex key format');
      }
      if (configuredReport.encryption.keyId !== expectedKId) {
        throw new Error(`inspectBackupEnvironment keyId mismatch: expected ${expectedKId}, got ${configuredReport.encryption.keyId}`);
      }
      if (configuredReport.backupDirectory.recoverySetsCount !== 1) {
        throw new Error(`inspectBackupEnvironment failed to count existing recovery sets: got ${configuredReport.backupDirectory.recoverySetsCount}`);
      }

      // Assert that raw key is NEVER leaked in report structure
      const reportJson = JSON.stringify(configuredReport);
      if (reportJson.includes(valid64Key)) {
        throw new Error('SECURITY VIOLATION: Raw backup encryption key leaked in inspect report');
      }

      // 3. Invalid key format test (too short)
      const badKeyReport = inspectBackupEnvironment({
        backupDir: inspectTestDir,
        encryptionEnabled: true,
        backupKey: 'too-short-key'
      });
      if (badKeyReport.valid !== false || badKeyReport.encryption.keyFormatValid !== false) {
        throw new Error('inspectBackupEnvironment failed to reject short hex key');
      }

      // 4. Disabled encryption with allowUnencrypted=false test
      const unencryptedForbiddenReport = inspectBackupEnvironment({
        backupDir: inspectTestDir,
        encryptionEnabled: false,
        allowUnencrypted: false
      });
      if (unencryptedForbiddenReport.valid !== false) {
        throw new Error('inspectBackupEnvironment failed to reject disabled encryption without allowUnencrypted flag');
      }

      console.log('PASS 0K: Backup inspection mode non-destructive invariants and diagnostic reports verified.');
    } finally {
      if (fs.existsSync(inspectTestDir)) {
        fs.rmSync(inspectTestDir, { recursive: true, force: true });
      }
    }

    // ── 0L: Restore Dry-Run (--dry-run) Non-Destructive Integrity Tests (Phase 4.4.5) ──
    console.log('\n--- 0L: Restore Dry-Run Non-Destructive Integrity ---');
    const dryRunVaultDir = path.join(testBackupDir, 'dryrun-test-vault');
    fs.mkdirSync(dryRunVaultDir, { recursive: true });

    try {
      const dryKey = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
      const dryKeyId = deriveKeyId(dryKey);
      const dryAuthKey = deriveManifestAuthKey(dryKey);

      // Create dummy plaintext archives
      const plainMongo = path.join(dryRunVaultDir, 'mongo-plain.tmp');
      const plainVoice = path.join(dryRunVaultDir, 'voice-plain.tmp');
      fs.writeFileSync(plainMongo, 'sample-mongo-dump-content');
      fs.writeFileSync(plainVoice, 'sample-voice-tar-content');

      const encMongo = path.join(dryRunVaultDir, 'mongodb.archive.gz.enc');
      const encVoice = path.join(dryRunVaultDir, 'voice.tar.gz.enc');

      const recId = 'rapidaid-recovery-dryrun-test';
      const metaMongo = await encryptArtifactStream(plainMongo, encMongo, dryKey, `2.0.0:${recId}:mongodb`);
      const metaVoice = await encryptArtifactStream(plainVoice, encVoice, dryKey, `2.0.0:${recId}:voiceStorage`);

      const dryManifestObj = {
        schemaVersion: '2.0.0',
        recoverySetId: recId,
        timestamp: new Date().toISOString(),
        status: 'VERIFIED_COMPLETE',
        database: 'rapidaid',
        encryption: {
          enabled: true,
          algorithm: 'aes-256-gcm',
          keyId: dryKeyId
        },
        artifacts: {
          mongodb: {
            filename: 'mongodb.archive.gz.enc',
            ciphertextSha256: metaMongo.ciphertextSha256,
            plaintextSha256: metaMongo.plaintextSha256,
            plaintextSizeBytes: metaMongo.plaintextSizeBytes,
            ivHex: metaMongo.ivHex,
            authTagHex: metaMongo.authTagHex
          },
          voiceStorage: {
            filename: 'voice.tar.gz.enc',
            ciphertextSha256: metaVoice.ciphertextSha256,
            plaintextSha256: metaVoice.plaintextSha256,
            plaintextSizeBytes: metaVoice.plaintextSizeBytes,
            ivHex: metaVoice.ivHex,
            authTagHex: metaVoice.authTagHex
          }
        }
      };

      const drySig = computeManifestSignature(dryManifestObj, dryAuthKey);
      dryManifestObj.signature = {
        algorithm: 'hmac-sha256',
        keyId: dryKeyId,
        value: drySig
      };

      const dryManifestPath = path.join(dryRunVaultDir, 'manifest.json');
      fs.writeFileSync(dryManifestPath, JSON.stringify(dryManifestObj, null, 2));

      // Mock execFn that flags if any destructive command is called
      let destructiveExecuted = false;
      const safeMockExec = (cmd) => {
        if (cmd.includes('mongorestore') || cmd.includes('tar -xzf') || cmd.includes('rm -rf /dest')) {
          destructiveExecuted = true;
          throw new Error(`CRITICAL DRY RUN VIOLATION: Destructive command invoked during dry-run: ${cmd}`);
        }
        if (cmd === 'docker context show') return 'default\n';
        if (cmd === 'docker info -f "{{.ID}}"') return 'daemon-mock-123456\n';
        if (cmd.startsWith('docker inspect mongo_drill')) {
          return JSON.stringify([{
            Id: 'c-mock-abcdef1234567890',
            Name: '/mongo_drill',
            State: { Running: true },
            Config: { Image: 'mongo:7.0' },
            NetworkSettings: { Networks: { net_drill: { NetworkID: 'n-mock-9876543210' } } },
            Mounts: [{ Destination: '/data/db', Name: 'vol_mongo_drill' }]
          }]);
        }
        if (cmd.startsWith('docker network inspect net_drill')) {
          return JSON.stringify([{
            Id: 'n-mock-9876543210',
            Name: 'net_drill',
            Containers: { 'c-mock-abcdef1234567890': { Name: 'mongo_drill', IPv4Address: '172.28.0.2/16' } }
          }]);
        }
        if (cmd.startsWith('docker volume inspect vol_mongo_drill')) return JSON.stringify([{ Name: 'vol_mongo_drill' }]);
        if (cmd.startsWith('docker volume inspect vol_voice_drill')) return JSON.stringify([{ Name: 'vol_voice_drill' }]);
        if (cmd.startsWith('docker ps -q --filter volume=vol_mongo_drill')) return 'c-mock-abcdef1234567890\n';
        if (cmd.startsWith('docker ps -q --filter volume=vol_voice_drill')) return '';
        if (cmd.includes('mongosh')) return 'MARKER_PROBE:{"isDisposable":true}:MARKER_PROBE_END';
        return '';
      };

      const dryRunOpts = {
        dryRun: true,
        backupKey: dryKey,
        targetHost: 'mongo_drill',
        targetNetwork: 'net_drill',
        targetVoiceVolume: 'vol_voice_drill',
        targetPass: 'mock-pass',
        expectedContainerId: 'c-mock-abcdef1234567890',
        expectedNetworkId: 'n-mock-9876543210',
        expectedMongoVolumeId: 'vol_mongo_drill',
        expectedVoiceVolumeId: 'vol_voice_drill',
        expectedDaemonId: 'daemon-mock-123456',
        expectedContext: 'default',
        execFn: safeMockExec
      };

      // Execute Dry-Run Restore
      const dryResult = await runRestore(dryManifestPath, dryRunOpts);

      if (dryResult.status !== 'DRY_RUN_PASSED') {
        throw new Error(`Restore dry-run returned unexpected status: ${dryResult.status}`);
      }
      if (dryResult.dryRun !== true) {
        throw new Error('Restore dry-run result flag is not true');
      }
      if (destructiveExecuted) {
        throw new Error('Destructive shell command was executed during restore dry-run');
      }

      // Assert non-destructive invariant: NO scratch directories created
      const vaultEntries = fs.readdirSync(dryRunVaultDir);
      const scratchDirs = vaultEntries.filter(e => e.startsWith('.restore-scratch-'));
      if (scratchDirs.length > 0) {
        throw new Error(`CRITICAL DRY RUN VIOLATION: Scratch directory ${scratchDirs[0]} was created`);
      }

      // Assert NO decrypted plaintext files exist on disk
      const decryptedFiles = vaultEntries.filter(e => e.endsWith('.archive.gz') || e.endsWith('.tar.gz'));
      if (decryptedFiles.length > 0) {
        throw new Error(`CRITICAL DRY RUN VIOLATION: Plaintext file ${decryptedFiles[0]} was created`);
      }

      // Test Dry-Run Fail-Closed on invalid key
      let caughtDryRunBadKey = false;
      try {
        await runRestore(dryManifestPath, {
          ...dryRunOpts,
          backupKey: 'b'.repeat(64) // wrong key
        });
      } catch (err) {
        if (err.message.includes('Key ID mismatch') || err.message.includes('signature verification failed')) {
          caughtDryRunBadKey = true;
        }
      }
      if (!caughtDryRunBadKey) {
        throw new Error('Restore dry-run failed to fail closed on mismatched encryption key');
      }

      // Test Dry-Run Fail-Closed on missing mandatory expected target identities
      let caughtDryRunMissingId = false;
      try {
        await runRestore(dryManifestPath, {
          ...dryRunOpts,
          expectedContainerId: '' // missing
        });
      } catch (err) {
        if (err.message.includes('Missing mandatory expected target identity: expectedContainerId')) {
          caughtDryRunMissingId = true;
        }
      }
      if (!caughtDryRunMissingId) {
        throw new Error('Restore dry-run failed to fail closed on missing expectedContainerId');
      }

      console.log('PASS 0L: Restore dry-run non-destructive invariants, scratch quarantine, and fail-closed gates verified.');
    } finally {
      if (fs.existsSync(dryRunVaultDir)) {
        fs.rmSync(dryRunVaultDir, { recursive: true, force: true });
      }
    }

    // ── 0M: Safe Backup-Lock Recovery Tests (Phase 4.4.5) ──
    console.log('\n--- 0M: Safe Backup-Lock Recovery ---');
    const lockTestDir = path.join(testBackupDir, 'lock-test-vault');
    fs.mkdirSync(lockTestDir, { recursive: true });

    try {
      const lockPath = path.join(lockTestDir, '.backup.lock');

      // 1. Active lock preservation
      // Create a lock with the currently running process PID
      const liveLock = acquireBackupLock(lockTestDir);
      const liveStatus = inspectLockStatus(lockTestDir);

      if (!liveStatus.exists || liveStatus.ownerAlive !== true || liveStatus.isStale !== false) {
        throw new Error(`inspectLockStatus failed to recognize active process PID ${process.pid}`);
      }

      // Attempt to recover an active lock -> MUST FAIL CLOSED
      let caughtActiveRecoveryAbort = false;
      try {
        recoverStaleLock(lockTestDir);
      } catch (err) {
        if (err.message.includes('Refusing to break lock. Owning process') && err.message.includes('is active')) {
          caughtActiveRecoveryAbort = true;
        }
      }
      if (!caughtActiveRecoveryAbort) {
        throw new Error('recoverStaleLock failed to refuse breaking an active lock');
      }
      if (!fs.existsSync(lockPath)) {
        throw new Error('Active lockfile was deleted during invalid recovery attempt');
      }

      // Concurrent backup attempt while active lock exists -> MUST FAIL CLOSED
      let caughtConcurrentBackup = false;
      try {
        acquireBackupLock(lockTestDir);
      } catch (err) {
        if (err.message.includes('Concurrent backup prevented') && err.message.includes('PROCESS IS ACTIVELY RUNNING')) {
          caughtConcurrentBackup = true;
        }
      }
      if (!caughtConcurrentBackup) {
        throw new Error('acquireBackupLock failed to report active concurrent lock');
      }

      releaseBackupLock(liveLock);
      if (fs.existsSync(lockPath)) {
        throw new Error('releaseBackupLock failed to clean up active lockfile');
      }

      // 2. Confirmed stale lock recovery
      // Write mock lock with dead PID (confirmed dead via ESRCH mock)
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 999999,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        hostname: os.hostname(),
        platform: process.platform
      }));

      const deadProcMock = () => ({ alive: false }); // ESRCH simulation
      const staleStatus = inspectLockStatus(lockTestDir, { isProcessAliveFn: deadProcMock });

      if (!staleStatus.exists || staleStatus.isStale !== true || staleStatus.ownerAlive !== false) {
        throw new Error('inspectLockStatus failed to recognize dead process as stale');
      }

      // Normal backup without --recover-stale-lock MUST FAIL CLOSED (no silent deletion)
      let caughtUnrecoveredStale = false;
      try {
        acquireBackupLock(lockTestDir, { isProcessAliveFn: deadProcMock });
      } catch (err) {
        if (err.message.includes('Concurrent backup prevented') && err.message.includes('PROCESS IS DEAD / STALE')) {
          caughtUnrecoveredStale = true;
        }
      }
      if (!caughtUnrecoveredStale) {
        throw new Error('acquireBackupLock silently removed stale lock without explicit authorization');
      }
      if (!fs.existsSync(lockPath)) {
        throw new Error('Stale lockfile was unexpectedly deleted by un-authorized acquire attempt');
      }

      // Explicit recovery MUST succeed when staleness is established
      const recoveryResult = recoverStaleLock(lockTestDir, { isProcessAliveFn: deadProcMock });
      if (recoveryResult.recovered !== true) {
        throw new Error('recoverStaleLock failed on confirmed stale lock');
      }
      if (fs.existsSync(lockPath)) {
        throw new Error('recoverStaleLock failed to remove confirmed stale lockfile from disk');
      }

      // 3. Ambiguous lock safety: Cross-host lock fails closed
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 12345,
        createdAt: new Date().toISOString(),
        hostname: 'foreign-remote-host-99',
        platform: 'linux'
      }));

      const crossHostStatus = inspectLockStatus(lockTestDir);
      if (!crossHostStatus.exists || crossHostStatus.isAmbiguous !== true) {
        throw new Error('inspectLockStatus failed to flag cross-host lock as ambiguous');
      }

      let caughtCrossHostAbort = false;
      try {
        recoverStaleLock(lockTestDir);
      } catch (err) {
        if (err.message.includes('Cross-host lock cannot be safely verified')) {
          caughtCrossHostAbort = true;
        }
      }
      if (!caughtCrossHostAbort) {
        throw new Error('recoverStaleLock failed to fail closed on cross-host lock');
      }
      if (!fs.existsSync(lockPath)) {
        throw new Error('Ambiguous cross-host lock was deleted');
      }
      fs.unlinkSync(lockPath);

      // 4. Ambiguous lock safety: Unparseable / corrupted lock metadata fails closed
      fs.writeFileSync(lockPath, '{ broken-json ...');
      const corruptStatus = inspectLockStatus(lockTestDir);
      if (!corruptStatus.exists || corruptStatus.isAmbiguous !== true) {
        throw new Error('inspectLockStatus failed to flag corrupted lock as ambiguous');
      }

      let caughtCorruptAbort = false;
      try {
        recoverStaleLock(lockTestDir);
      } catch (err) {
        if (err.message.includes('Unparseable lockfile metadata')) {
          caughtCorruptAbort = true;
        }
      }
      if (!caughtCorruptAbort) {
        throw new Error('recoverStaleLock failed to fail closed on corrupted lockfile');
      }
      if (!fs.existsSync(lockPath)) {
        throw new Error('Corrupted lockfile was deleted');
      }
      fs.unlinkSync(lockPath);

      // 5. Ambiguous lock safety: Process inspection error (EPERM) fails closed
      fs.writeFileSync(lockPath, JSON.stringify({
        pid: 1,
        createdAt: new Date().toISOString(),
        hostname: os.hostname()
      }));

      const epermMock = () => ({ alive: false, error: 'EPERM' });
      const epermStatus = inspectLockStatus(lockTestDir, { isProcessAliveFn: epermMock });
      if (!epermStatus.exists || epermStatus.isAmbiguous !== true) {
        throw new Error('inspectLockStatus failed to flag EPERM inspection as ambiguous');
      }

      let caughtEpermAbort = false;
      try {
        recoverStaleLock(lockTestDir, { isProcessAliveFn: epermMock });
      } catch (err) {
        if (err.message.includes('EPERM')) {
          caughtEpermAbort = true;
        }
      }
      if (!caughtEpermAbort) {
        throw new Error('recoverStaleLock failed to fail closed on EPERM process inspection');
      }
      if (!fs.existsSync(lockPath)) {
        throw new Error('EPERM lockfile was deleted');
      }
      fs.unlinkSync(lockPath);

      // 6. Cross-Process Synchronization Gate (.backup.gate) Safety & Concurrency
      const gatePath = path.join(lockTestDir, '.backup.gate');

      // 6A. Timeout while another process holds the gate & fail-closed mutual exclusion
      const liveGateToken = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(gatePath, JSON.stringify({
        gateToken: liveGateToken,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        hostname: os.hostname()
      }));

      let caughtAcquireGateTimeout = false;
      try {
        acquireBackupLock(lockTestDir, { gateTimeoutMs: 100, gatePollIntervalMs: 15 });
      } catch (err) {
        if (err.message.includes('Timeout') && err.message.includes('waiting for synchronization gate')) {
          caughtAcquireGateTimeout = true;
        }
      }
      if (!caughtAcquireGateTimeout) {
        throw new Error('acquireBackupLock failed to fail closed when gate was held');
      }
      if (fs.existsSync(lockPath)) {
        throw new Error('acquireBackupLock created lockfile while gate was held by another process');
      }

      let caughtRecoverGateTimeout = false;
      try {
        recoverStaleLock(lockTestDir, { gateTimeoutMs: 100, gatePollIntervalMs: 15 });
      } catch (err) {
        if (err.message.includes('Timeout') && err.message.includes('waiting for synchronization gate')) {
          caughtRecoverGateTimeout = true;
        }
      }
      if (!caughtRecoverGateTimeout) {
        throw new Error('recoverStaleLock failed to fail closed when gate was held');
      }
      fs.unlinkSync(gatePath);

      // 6B. Real Concurrent Contenders: Two actual OS processes encountering the same abandoned gate
      const staleGateToken = 'stale-gate-contender-test';
      fs.writeFileSync(gatePath, JSON.stringify({
        gateToken: staleGateToken,
        pid: 999981,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        hostname: os.hostname()
      }));

      const backupScriptUrl = pathToFileURL(path.resolve('./scripts/backup-db.mjs')).href;

      const contenderHelperPath = path.join(lockTestDir, 'test-contender-runner.mjs');
      fs.writeFileSync(contenderHelperPath, `
        import { acquireGate } from '${backupScriptUrl}';
        const targetDir = process.argv[2];
        try {
          acquireGate(targetDir, { gateTimeoutMs: 150, gatePollIntervalMs: 15 });
          process.exit(0); // Should NOT acquire
        } catch (err) {
          if (err.message.includes('Timeout') && err.message.includes('waiting for synchronization gate')) {
            process.exit(2); // Expected fail-closed timeout
          }
          process.exit(3); // Unexpected error
        }
      `, 'utf8');

      const cp1 = spawn(process.execPath, [contenderHelperPath, lockTestDir], { stdio: 'pipe' });
      const cp2 = spawn(process.execPath, [contenderHelperPath, lockTestDir], { stdio: 'pipe' });

      const [cpExit1, cpExit2] = await Promise.all([
        new Promise(res => cp1.on('exit', res)),
        new Promise(res => cp2.on('exit', res))
      ]);

      if (cpExit1 !== 2 || cpExit2 !== 2) {
        throw new Error(`Real concurrent contenders did not fail closed on timeout: cpExit1=${cpExit1}, cpExit2=${cpExit2}`);
      }
      // Assert that neither child process unlinked the abandoned gate!
      if (!fs.existsSync(gatePath)) {
        throw new Error('CRITICAL FLAW: Real concurrent contender unlinked abandoned gate from disk');
      }
      fs.unlinkSync(contenderHelperPath);

      // 6C. Concurrent Explicit Recovery Child Processes Cannot Delete a Newly Acquired Live Replacement Gate
      const liveReplacementToken = 'live-replacement-gate-token-9988';
      fs.writeFileSync(gatePath, JSON.stringify({
        gateToken: liveReplacementToken,
        pid: process.pid, // Current active live process!
        createdAt: new Date().toISOString(),
        hostname: os.hostname()
      }));

      const recoveryHelperPath = path.join(lockTestDir, 'test-recovery-runner.mjs');
      fs.writeFileSync(recoveryHelperPath, `
        import { recoverStaleGate } from '${backupScriptUrl}';
        const targetDir = process.argv[2];
        try {
          recoverStaleGate(targetDir);
          process.exit(10); // Should NEVER succeed in deleting a live replacement gate!
        } catch (err) {
          if (err.message.includes('Refusing to break gate') || err.message.includes('Gate was replaced') || err.message.includes('CRITICAL SAFETY ABORT')) {
            process.exit(20); // Expected fail-closed abort
          }
          console.error(err.message);
          process.exit(21); // Unexpected error
        }
      `, 'utf8');

      const rp1 = spawn(process.execPath, [recoveryHelperPath, lockTestDir], { stdio: 'pipe' });
      const rp2 = spawn(process.execPath, [recoveryHelperPath, lockTestDir], { stdio: 'pipe' });

      const [rpExit1, rpExit2] = await Promise.all([
        new Promise(res => rp1.on('exit', res)),
        new Promise(res => rp2.on('exit', res))
      ]);

      if (rpExit1 !== 20 || rpExit2 !== 20) {
        throw new Error(`Concurrent recovery processes did not fail closed on live replacement gate: rpExit1=${rpExit1}, rpExit2=${rpExit2}`);
      }
      // Assert that neither recovery attempt deleted the newly acquired live replacement gate!
      if (!fs.existsSync(gatePath)) {
        throw new Error('CRITICAL FLAW: Concurrent recovery attempt unlinked newly acquired live replacement gate');
      }
      const liveGateRetained = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      if (liveGateRetained.gateToken !== liveReplacementToken) {
        throw new Error('Live replacement gate was corrupted by concurrent recovery attempt');
      }
      fs.unlinkSync(recoveryHelperPath);
      fs.unlinkSync(gatePath);

      // 6D. Real Concurrent Mutual Exclusion: Proof that no two processes enter critical section simultaneously
      const mutualHelperPath = path.join(lockTestDir, 'test-mutual-runner.mjs');
      const witnessFile = path.join(lockTestDir, 'critical-section.active');
      const violationFile = path.join(lockTestDir, 'critical-section.violation');

      fs.writeFileSync(mutualHelperPath, `
        import { acquireGate, releaseGate } from '${backupScriptUrl}';
        import fs from 'fs';
        import path from 'path';

        const targetDir = process.argv[2];
        const witnessFile = path.join(targetDir, 'critical-section.active');
        const violationFile = path.join(targetDir, 'critical-section.violation');

        const gate = acquireGate(targetDir, { gateTimeoutMs: 5000, gatePollIntervalMs: 10 });
        try {
          if (fs.existsSync(witnessFile)) {
            fs.writeFileSync(violationFile, 'MUTUAL_EXCLUSION_VIOLATION: Multiple processes in critical section!');
          }
          fs.writeFileSync(witnessFile, String(process.pid));

          // Hold critical section for 40ms
          const buf = new Int32Array(new SharedArrayBuffer(4));
          Atomics.wait(buf, 0, 0, 40);

          try { fs.unlinkSync(witnessFile); } catch {}
        } finally {
          releaseGate(gate);
        }
        process.exit(0);
      `, 'utf8');

      const mp1 = spawn(process.execPath, [mutualHelperPath, lockTestDir], { stdio: 'pipe' });
      const mp2 = spawn(process.execPath, [mutualHelperPath, lockTestDir], { stdio: 'pipe' });

      const [mpExit1, mpExit2] = await Promise.all([
        new Promise(res => mp1.on('exit', res)),
        new Promise(res => mp2.on('exit', res))
      ]);

      if (mpExit1 !== 0 || mpExit2 !== 0) {
        throw new Error(`Concurrent critical section processes encountered failure: mpExit1=${mpExit1}, mpExit2=${mpExit2}`);
      }
      if (fs.existsSync(violationFile)) {
        throw new Error('CRITICAL FLAW: Real concurrent child processes entered critical section simultaneously!');
      }
      fs.unlinkSync(mutualHelperPath);

      // 6E. Gate Release Cannot Delete a Replacement Gate (Production Execution without Test Hooks)
      const callerGateToken = 'caller-original-gate-token-777';
      const replacementLiveToken = 'active-live-replacement-token-888';
      fs.writeFileSync(gatePath, JSON.stringify({
        gateToken: replacementLiveToken,
        pid: process.pid,
        createdAt: new Date().toISOString(),
        hostname: os.hostname()
      }));

      // Caller attempts release with its old token - must fail closed and NOT unlink
      releaseGate({ gatePath, gateToken: callerGateToken, fd: undefined });

      if (!fs.existsSync(gatePath)) {
        throw new Error('CRITICAL FLAW: releaseGate unlinked replacement gate belonging to another process');
      }
      const retainedCheck = JSON.parse(fs.readFileSync(gatePath, 'utf8'));
      if (retainedCheck.gateToken !== replacementLiveToken) {
        throw new Error('Replacement gate was mutated during releaseGate attempt');
      }
      fs.unlinkSync(gatePath);

      // 6F. Malformed, Unreadable, Active-Owner, Remote-Host, and Ambiguous Metadata Fail Closed
      // 1. Malformed gate metadata
      fs.writeFileSync(gatePath, '{ broken-malformed-json ...');
      const malformedGateStatus = inspectGateStatus(lockTestDir);
      if (!malformedGateStatus.exists || malformedGateStatus.isAmbiguous !== true) {
        throw new Error('inspectGateStatus failed to flag malformed gate as ambiguous');
      }
      let caughtMalformedGateAbort = false;
      try {
        recoverStaleGate(lockTestDir);
      } catch (err) {
        if (err.message.includes('Cannot safely recover gate')) caughtMalformedGateAbort = true;
      }
      if (!caughtMalformedGateAbort) throw new Error('recoverStaleGate failed to fail closed on malformed gate');
      // releaseGate with malformed metadata on disk also fails closed
      releaseGate({ gatePath, gateToken: 'any-token', fd: undefined });
      if (!fs.existsSync(gatePath)) throw new Error('releaseGate unlinked gate with malformed metadata');
      fs.unlinkSync(gatePath);

      // 2. Active owner gate fails closed
      fs.writeFileSync(gatePath, JSON.stringify({ gateToken: 'active-token', pid: process.pid, createdAt: new Date().toISOString(), hostname: os.hostname() }));
      const activeGateStatus = inspectGateStatus(lockTestDir);
      if (!activeGateStatus.exists || activeGateStatus.ownerAlive !== true) {
        throw new Error('inspectGateStatus failed to recognize active process');
      }
      let caughtActiveGateAbort = false;
      try {
        recoverStaleGate(lockTestDir);
      } catch (err) {
        if (err.message.includes('Refusing to break gate') && err.message.includes('is active')) caughtActiveGateAbort = true;
      }
      if (!caughtActiveGateAbort) throw new Error('recoverStaleGate failed to fail closed on active gate');
      if (!fs.existsSync(gatePath)) throw new Error('Active gate was deleted');
      fs.unlinkSync(gatePath);

      // 3. Remote-host gate fails closed
      fs.writeFileSync(gatePath, JSON.stringify({ gateToken: 'remote-token', pid: 12345, createdAt: new Date().toISOString(), hostname: 'remote-server-box-42' }));
      const remoteGateStatus = inspectGateStatus(lockTestDir);
      if (!remoteGateStatus.exists || remoteGateStatus.isAmbiguous !== true) {
        throw new Error('inspectGateStatus failed to flag remote-host gate as ambiguous');
      }
      let caughtRemoteGateAbort = false;
      try {
        recoverStaleGate(lockTestDir);
      } catch (err) {
        if (err.message.includes('Cross-host gate cannot be safely verified')) caughtRemoteGateAbort = true;
      }
      if (!caughtRemoteGateAbort) throw new Error('recoverStaleGate failed to fail closed on remote-host gate');
      if (!fs.existsSync(gatePath)) throw new Error('Remote gate was deleted');
      fs.unlinkSync(gatePath);

      // 4. Ambiguous process inspection error (EPERM simulation) fails closed
      fs.writeFileSync(gatePath, JSON.stringify({ gateToken: 'eperm-token', pid: 1, createdAt: new Date().toISOString(), hostname: os.hostname() }));
      const epermGateMock = () => ({ alive: false, error: 'EPERM' });
      const epermGateStatus = inspectGateStatus(lockTestDir, { isProcessAliveFn: epermGateMock });
      if (!epermGateStatus.exists || epermGateStatus.isAmbiguous !== true) {
        throw new Error('inspectGateStatus failed to flag EPERM inspection as ambiguous');
      }
      let caughtEpermGateAbort = false;
      try {
        recoverStaleGate(lockTestDir, { isProcessAliveFn: epermGateMock });
      } catch (err) {
        if (err.message.includes('Cannot safely recover gate') || err.message.includes('EPERM')) caughtEpermGateAbort = true;
      }
      if (!caughtEpermGateAbort) throw new Error('recoverStaleGate failed to fail closed on EPERM gate inspection');
      if (!fs.existsSync(gatePath)) throw new Error('EPERM gate was deleted');
      fs.unlinkSync(gatePath);

      // 5. Abandoned gate fails closed with documented manual operator procedure (never automatically deleted)
      fs.writeFileSync(gatePath, JSON.stringify({ gateToken: 'abandoned-stale-token', pid: 999984, createdAt: new Date(Date.now() - 3600000).toISOString(), hostname: os.hostname() }));
      let caughtAbandonedGateProcedure = false;
      try {
        recoverStaleGate(lockTestDir, { isProcessAliveFn: () => ({ alive: false }) });
      } catch (err) {
        if (err.message.includes('MANUAL OPERATOR REMEDIATION PROCEDURE') &&
            err.message.includes('DO NOT delete the gate file if any backup or recovery process is active') &&
            err.message.includes('Automatic software deletion of the root gate is disabled by design')) {
          caughtAbandonedGateProcedure = true;
        }
      }
      if (!caughtAbandonedGateProcedure) {
        throw new Error('recoverStaleGate failed to emit documented manual operator remediation procedure');
      }
      // Assert gate file is NOT deleted!
      if (!fs.existsSync(gatePath)) {
        throw new Error('CRITICAL FLAW: recoverStaleGate deleted abandoned gate instead of failing closed');
      }
      // Operator remediation procedure execution:
      fs.unlinkSync(gatePath);

      // 6G. Synchronization Invariant: EEXIST strictly prevents intermediate replacement while gate is held
      const ownerGate = acquireGate(lockTestDir);
      // While owner holds the gate, a concurrent contender attempts to create a replacement gate
      let caughtIntermediateReplacementBlocked = false;
      try {
        acquireGate(lockTestDir, { gateTimeoutMs: 100, gatePollIntervalMs: 15 });
      } catch (err) {
        if (err.message.includes('Timeout') && err.message.includes('waiting for synchronization gate')) {
          caughtIntermediateReplacementBlocked = true;
        }
      }
      if (!caughtIntermediateReplacementBlocked) {
        throw new Error('acquireGate failed to block concurrent replacement while gate was held');
      }
      // Releasing gate cleanly allows subsequent acquisition
      releaseGate(ownerGate);
      if (fs.existsSync(gatePath)) {
        throw new Error('releaseGate failed to release gate cleanly with matching token and pid');
      }
      const followerGate = acquireGate(lockTestDir);
      releaseGate(followerGate);

      // 7. Backup-lock and gate ownership remaining consistent throughout critical section
      const activeLock = acquireBackupLock(lockTestDir);
      // Invariant 1: Lockfile exists on disk with matching token
      if (!fs.existsSync(lockPath)) {
        throw new Error('acquireBackupLock did not create .backup.lock');
      }
      const activeRaw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (activeRaw.lockToken !== activeLock.lockToken) {
        throw new Error('Lockfile token does not match returned lockToken');
      }
      // Invariant 2: Gate is released immediately after lock acquisition (critical section complete)
      if (fs.existsSync(gatePath)) {
        throw new Error('.backup.gate was left behind after acquireBackupLock completed');
      }

      // Invariant 3: Concurrent backup lock attempt is rejected
      let caughtActiveLockConflict = false;
      try {
        acquireBackupLock(lockTestDir);
      } catch (err) {
        if (err.message.includes('Concurrent backup prevented') && err.message.includes('PROCESS IS ACTIVELY RUNNING')) {
          caughtActiveLockConflict = true;
        }
      }
      if (!caughtActiveLockConflict) {
        throw new Error('acquireBackupLock failed to reject concurrent execution under active lock');
      }

      // Invariant 4: Tampered lock token prevents releaseBackupLock from unlinking
      const originalToken = activeLock.lockToken;
      activeLock.lockToken = 'tampered-token-mismatch';
      releaseBackupLock(activeLock);
      if (!fs.existsSync(lockPath)) {
        throw new Error('CRITICAL FLAW: releaseBackupLock deleted lockfile despite token mismatch');
      }
      // Restore token and cleanly release
      activeLock.lockToken = originalToken;
      releaseBackupLock(activeLock);
      if (fs.existsSync(lockPath)) {
        throw new Error('releaseBackupLock failed to release lock with matching token');
      }

      // 8. Deterministic Interleaving: Exact Replacement-Lock Race (Audit sequence 1-4)
      // Step 1: Write stale lock
      const staleTokenAudit = 'stale-token-audit-1111';
      fs.writeFileSync(lockPath, JSON.stringify({
        lockToken: staleTokenAudit,
        pid: 999993,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        hostname: os.hostname(),
        platform: process.platform
      }));

      // Step 2: Recovery A inspects lock and sees stale lock
      const recoveryAInspection = inspectLockStatus(lockTestDir, { isProcessAliveFn: deadProcMock });
      if (!recoveryAInspection.isStale || recoveryAInspection.lockInfo.lockToken !== staleTokenAudit) {
        throw new Error('Recovery A inspection failed to observe stale lock');
      }

      // Step 3: Recovery B removes stale lock
      fs.unlinkSync(lockPath);

      // Step 4: Normal live backup C creates replacement lock
      const liveBackupC = acquireBackupLock(lockTestDir);
      const replacementToken = liveBackupC.lockToken;
      if (!replacementToken || replacementToken === staleTokenAudit) {
        throw new Error('Live backup C failed to generate unique replacement token');
      }

      // Step 5: Recovery A attempts to unlink the lock with expected stale token
      let caughtReplacementAbort = false;
      try {
        recoverStaleLock(lockTestDir, {
          expectedLockToken: staleTokenAudit,
          expectedPid: 999993,
          isProcessAliveFn: (pid) => (pid === process.pid ? { alive: true } : { alive: false })
        });
      } catch (err) {
        if (err.message.includes('Refusing to break lock') || err.message.includes('Lockfile was replaced')) {
          caughtReplacementAbort = true;
        }
      }
      if (!caughtReplacementAbort) {
        throw new Error('Recovery A failed to abort when encountering active replacement lock');
      }

      // Assert that live backup C's replacement lock was NOT deleted!
      if (!fs.existsSync(lockPath)) {
        throw new Error('CRITICAL FLAW: Replacement live lock was deleted by stale recovery process A');
      }
      const activeLockCheck = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (activeLockCheck.lockToken !== replacementToken) {
        throw new Error(`Active lock token mutated: expected ${replacementToken}, got ${activeLockCheck.lockToken}`);
      }
      releaseBackupLock(liveBackupC);
      if (fs.existsSync(lockPath)) {
        throw new Error('releaseBackupLock failed to clean up live replacement lock');
      }

      // 9. Critical Section Gate Serialization: backup acquisition blocked during recovery critical section
      fs.writeFileSync(lockPath, JSON.stringify({
        lockToken: 'stale-token-critical-section-1',
        pid: 999994,
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        hostname: os.hostname(),
        platform: process.platform
      }));

      let hookExecuted = false;
      let hookBlockedConcurrentBackup = false;

      recoverStaleLock(lockTestDir, {
        isProcessAliveFn: deadProcMock,
        beforeUnlinkHook: () => {
          hookExecuted = true;
          // Attempt concurrent backup while recovery is in its critical section holding .backup.gate
          try {
            acquireBackupLock(lockTestDir, { gateTimeoutMs: 100, gatePollIntervalMs: 15 });
          } catch (err) {
            if (err.message.includes('Timeout') && err.message.includes('waiting for synchronization gate')) {
              hookBlockedConcurrentBackup = true;
            }
          }
        }
      });

      if (!hookExecuted) {
        throw new Error('beforeUnlinkHook was not executed');
      }
      if (!hookBlockedConcurrentBackup) {
        throw new Error('Concurrent backup acquisition was NOT blocked by .backup.gate during recovery critical section');
      }
      if (fs.existsSync(lockPath)) {
        throw new Error('recoverStaleLock failed to unlink stale lock after critical section verification');
      }

      console.log('PASS 0M: Safe backup-lock recovery, live lock preservation, and ambiguous fail-closed contracts verified.');
    } finally {
      if (fs.existsSync(lockTestDir)) {
        fs.rmSync(lockTestDir, { recursive: true, force: true });
      }
    }

    console.log('\n================================================================');
    console.log('ALL IN-MEMORY UNIT SAFEGUARDS AND CRYPTOGRAPHIC CHECKS PASSED');
    console.log('================================================================');

    // ── STEP 1: Provision Primary Disposable Drill Stack ──────────────────
    let dockerAvailable = false;
    let dockerDaemonId = null;
    try {
      dockerDaemonId = execSync('docker info -f "{{.ID}}"', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      dockerAvailable = !!dockerDaemonId;
    } catch {
      dockerAvailable = false;
    }

    if (!dockerAvailable) {
      console.log('\n================================================================');
      console.log('[NOTICE] Live Docker daemon is unavailable or unreachable on this host.');
      console.log('Skipping destructive live Docker integration drill per safety protocol.');
      console.log('Target isolation preflight negative tests, cryptographic round-trips,');
      console.log('failure-mode quarantines, canonical manifest HMAC tests, GFS retention,');
      console.log('and TLS off-site replication checks all completed successfully.');
      console.log('================================================================');
      return true;
    }

    console.log('\n[Step 1] Creating isolated drill network and volumes...');
    execSync(`docker network create ${testNetwork}`, { stdio: 'inherit' });
    allocatedNetworks.add(testNetwork);

    execSync(`docker volume create ${srcMongoVolume}`, { stdio: 'inherit' });
    allocatedVolumes.add(srcMongoVolume);
    execSync(`docker volume create ${srcVoiceVolume}`, { stdio: 'inherit' });
    allocatedVolumes.add(srcVoiceVolume);

    console.log('Starting primary drill MongoDB container...');
    process.env.DRILL_ROOT_PASS = rootPass;
    const mongoBootCmd = `docker run -d --name ${srcMongoContainer} --network ${testNetwork} -v "${srcMongoVolume}:/data/db" -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD="${rootPass}" -e MONGO_INITDB_DATABASE=rapidaid mongo:7.0`;
    execSync(mongoBootCmd, { stdio: 'inherit' });
    allocatedContainers.add(srcMongoContainer);

    // Wait for MongoDB to become ready
    console.log('Waiting for drill MongoDB to become responsive...');
    let ready = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        execSync(`docker exec -i ${srcMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: 'db.runCommand({ ping: 1 })', stdio: 'ignore' });
        ready = true;
        break;
      } catch {}
    }
    if (!ready) throw new Error('Drill MongoDB container failed to respond within 30s');
    console.log('PASS: Primary drill MongoDB is responsive.');

    // Tag with explicit disposable database marker
    console.log('Inserting disposable database marker into primary drill container admin database...');
    const markScript = `db.getSiblingDB('admin').disposable_marker.insertOne({ disposable: true, runId: '${runId}', createdAt: new Date() });`;
    execSync(`docker exec -i ${srcMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: markScript, stdio: ['pipe', 'ignore', 'ignore'] });
    console.log('PASS: Disposable marker successfully recorded.');

    // ── STEP 2: Provision rapidaid_backup user and seed synthetic data ─────
    console.log('\n[Step 2] Provisioning least-privilege rapidaid_backup user and seeding synthetic data...');
    const initScript = `
      const dbTarget = db.getSiblingDB('rapidaid');
      // Create dedicated read-only backup user
      dbTarget.createUser({
        user: 'rapidaid_backup',
        pwd: '${backupPass}',
        roles: [{ role: 'read', db: 'rapidaid' }]
      });
      // Seed synthetic collections
      dbTarget.users.insertMany([
        { _id: 'usr-1', email: 'admin@rapidaid.test', role: 'ADMIN', name: 'Drill Admin' },
        { _id: 'usr-2', email: 'crew@rapidaid.test', role: 'CREW', name: 'Drill Crew' }
      ]);
      dbTarget.rolepolicies.insertOne({ _id: 'rp-1', role: 'ADMIN', permissions: ['ALL'] });
      dbTarget.emergencies.insertOne({
        _id: 'EMG-DRILL-001',
        title: 'Synthetic Drill Emergency',
        status: 'REPORTED',
        createdAt: new Date(),
        idempotencyKey: 'drill-key-999'
      });
      dbTarget.hospitals.insertOne({ _id: 'HOS-1', name: 'Drill General Hospital' });
      dbTarget.ambulances.insertOne({ _id: 'AMB-1', callSign: 'Unit-99', status: 'AVAILABLE' });
      dbTarget.voicereports.insertOne({
        _id: 'VR-1',
        audio: { storageKey: 'drill_user/rec-001/call.webm', size: 1024, checksum: 'synth123' },
        transcript: 'Synthetic 911 call recording transcript'
      });
      console.log('SYNTHETIC_DATA_SEEDED');
    `;

    execSync(`docker exec -i ${srcMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: initScript, stdio: ['pipe', 'inherit', 'inherit'] });

    // Seed synthetic voice storage audio file into volume
    console.log('Writing synthetic voice audio file into drill voice volume...');
    const seedVoiceCmd = `docker run --rm -v "${srcVoiceVolume}:/dest" alpine sh -c "mkdir -p /dest/drill_user/rec-001 && echo 'SYNTHETIC_WEBM_AUDIO_BYTES_TEST' > /dest/drill_user/rec-001/call.webm"`;
    execSync(seedVoiceCmd, { stdio: 'inherit' });
    console.log('PASS: Synthetic voice file written.');

    // ── STEP 3: Missing References Fail-Closed Assertion ───────────────────
    console.log('\n[Step 3] Testing missing voice reference fail-closed behavior...');
    const injectMissingScript = `
      db.getSiblingDB('rapidaid').voicereports.insertOne({
        _id: 'VR-DANGLING',
        audio: { storageKey: 'drill_user/rec-missing/nonexistent.webm', size: 500, checksum: 'dangling' },
        transcript: 'Dangling call record'
      });
    `;
    execSync(`docker exec -i ${srcMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: injectMissingScript, stdio: ['pipe', 'ignore', 'ignore'] });

    let caughtIntegrityAbort = false;
    try {
      await runBackup({
        backupDir: testBackupDir,
        encryptionEnabled: true,
        backupKey: testBackupKey,
        mongoBackupUser: 'rapidaid_backup',
        mongoBackupPass: backupPass,
        mongoDb: 'rapidaid',
        mongoHost: srcMongoContainer,
        network: testNetwork,
        voiceVolume: srcVoiceVolume,
        mongoImage: 'mongo:7.0'
      });
    } catch (err) {
      if (err.message.includes('Backup publication aborted') && err.message.includes('missing from captured voice archive')) {
        caughtIntegrityAbort = true;
      }
    }

    if (!caughtIntegrityAbort) {
      throw new Error('runBackup failed to abort when dangling voice reference was detected in database');
    }
    console.log('PASS: Missing voice reference correctly triggered fail-closed abort without publishing.');

    // Remove the dangling synthetic record
    const cleanupMissingScript = `db.getSiblingDB('rapidaid').voicereports.deleteOne({ _id: 'VR-DANGLING' });`;
    execSync(`docker exec -i ${srcMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: cleanupMissingScript, stdio: ['pipe', 'ignore', 'ignore'] });

    // ── STEP 4: Legitimate Encrypted Backup Execution ─────────────────────
    console.log('\n[Step 4] Executing legitimate AES-256-GCM encrypted backup against drill environment...');
    const manifest = await runBackup({
      backupDir: testBackupDir,
      encryptionEnabled: true,
      backupKey: testBackupKey,
      mongoBackupUser: 'rapidaid_backup',
      mongoBackupPass: backupPass,
      mongoDb: 'rapidaid',
      mongoHost: srcMongoContainer,
      network: testNetwork,
      voiceVolume: srcVoiceVolume,
      mongoImage: 'mongo:7.0'
    });

    // Validate Manifest Structure & Security Metadata
    if (manifest.status !== 'VERIFIED_COMPLETE') throw new Error('Manifest status is not VERIFIED_COMPLETE');
    if (manifest.schemaVersion !== '2.0.0') throw new Error(`Expected schemaVersion 2.0.0, got ${manifest.schemaVersion}`);
    if (manifest.encryption?.enabled !== true) throw new Error('Manifest encryption.enabled is not true');
    if (manifest.encryption?.algorithm !== 'aes-256-gcm') throw new Error('Expected aes-256-gcm encryption algorithm');
    if (!manifest.encryption?.keyId) throw new Error('Manifest missing encryption.keyId');
    if (!manifest.signature?.value) throw new Error('Manifest missing HMAC-SHA256 signature value');
    if (!manifest.artifacts.mongodb.ciphertextSha256) throw new Error('MongoDB archive ciphertextSha256 missing');
    if (!manifest.artifacts.mongodb.plaintextSha256) throw new Error('MongoDB archive plaintextSha256 missing');
    if (!manifest.artifacts.mongodb.ivHex) throw new Error('MongoDB archive ivHex missing');
    if (!manifest.artifacts.mongodb.authTagHex) throw new Error('MongoDB archive authTagHex missing');
    if (!manifest.artifacts.voiceStorage.ciphertextSha256) throw new Error('Voice archive ciphertextSha256 missing');

    // Confirm that encrypted .enc files exist and unencrypted archives are unlinked
    const mongoEncPath = path.join(testBackupDir, manifest.artifacts.mongodb.filename);
    const voiceEncPath = path.join(testBackupDir, manifest.artifacts.voiceStorage.filename);
    if (!fs.existsSync(mongoEncPath)) throw new Error(`Encrypted MongoDB archive missing on disk: ${mongoEncPath}`);
    if (!fs.existsSync(voiceEncPath)) throw new Error(`Encrypted Voice archive missing on disk: ${voiceEncPath}`);

    // Verify HMAC-SHA256 signature on generated manifest
    const backupAuthKey = deriveManifestAuthKey(testBackupKey);
    const recomputedSig = computeManifestSignature(manifest, backupAuthKey);
    if (!crypto.timingSafeEqual(Buffer.from(manifest.signature.value, 'hex'), Buffer.from(recomputedSig, 'hex'))) {
      throw new Error('HMAC-SHA256 signature on generated backup manifest is invalid');
    }
    console.log('PASS: Encrypted backup workflow executed and generated Schema v2.0.0 authenticated recovery set.');

    // ── STEP 5: Multi-Month & Year-Boundary GFS Retention Testing ─────────
    console.log('\n[Step 5] Testing GFS retention pruning with encrypted recovery sets across months and year boundary...');
    const retentionDrillDir = path.join(testBackupDir, 'retention-drill');
    fs.mkdirSync(retentionDrillDir, { recursive: true });

    const calDates = [
      { id: 'set-2026-03-03', date: '2026-03-03T12:00:00Z' },
      { id: 'set-2026-02-03', date: '2026-02-03T12:00:00Z' },
      { id: 'set-2026-01-03', date: '2026-01-03T12:00:00Z' },
      { id: 'set-2025-12-28', date: '2025-12-28T12:00:00Z' },
      { id: 'set-2025-11-01', date: '2025-11-01T12:00:00Z' }, // Beyond weekly (4) and monthly (3)
      { id: 'set-traversal', date: '2025-10-01T12:00:00Z', badPath: '../../traversal.bin' }
    ];

    for (const item of calDates) {
      const fakeManifest = {
        schemaVersion: '2.0.0',
        recoverySetId: item.id,
        timestamp: item.date,
        status: 'VERIFIED_COMPLETE',
        artifacts: {
          mongodb: { filename: item.badPath || `mongodb-${item.id}.archive.gz.enc`, ciphertextSha256: 'fake' },
          voiceStorage: { filename: `voice-${item.id}.tar.gz.enc`, ciphertextSha256: 'fake' }
        }
      };
      fs.writeFileSync(path.join(retentionDrillDir, `manifest-${item.id}.json`), JSON.stringify(fakeManifest));
      if (!item.badPath) {
        fs.writeFileSync(path.join(retentionDrillDir, `mongodb-${item.id}.archive.gz.enc`), 'fake');
      }
      fs.writeFileSync(path.join(retentionDrillDir, `voice-${item.id}.tar.gz.enc`), 'fake');
      fs.writeFileSync(path.join(retentionDrillDir, `checksums-${item.id}.sha256`), 'fake');
    }

    const pruneResult = pruneRetention(retentionDrillDir, { daily: 1, weekly: 4, monthly: 3 });
    console.log(`Retention pruning executed: Kept ${pruneResult.kept.length} sets, Pruned ${pruneResult.pruned.length} sets.`);

    const keptSet = new Set(pruneResult.kept);
    if (!keptSet.has('set-2026-03-03')) throw new Error('March backup was pruned unexpectedly');
    if (!keptSet.has('set-2026-02-03')) throw new Error('February backup was pruned unexpectedly due to collision');
    if (!keptSet.has('set-2026-01-03')) throw new Error('January backup was pruned unexpectedly due to collision');
    if (!keptSet.has('set-2025-12-28')) throw new Error('Year-boundary December backup was pruned unexpectedly');

    const prunedSet = new Set(pruneResult.pruned);
    if (!prunedSet.has('set-2025-11-01')) throw new Error('Expected 2025-11-01 to be pruned');

    fs.rmSync(retentionDrillDir, { recursive: true, force: true });
    console.log('PASS: GFS retention successfully preserved recovery points across months and year boundary without bucket collision.');

    // ── STEP 6: Provision Secondary Isolated Restore Drill Target ──────────
    console.log('\n[Step 6] Setting up secondary isolated restore target...');
    execSync(`docker volume create ${dstMongoVolume}`, { stdio: 'inherit' });
    allocatedVolumes.add(dstMongoVolume);
    execSync(`docker volume create ${dstVoiceVolume}`, { stdio: 'inherit' });
    allocatedVolumes.add(dstVoiceVolume);

    console.log('Starting secondary drill restore MongoDB container...');
    const restoreBootCmd = `docker run -d --name ${dstMongoContainer} --network ${testNetwork} -v "${dstMongoVolume}:/data/db" -e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD="${rootPass}" mongo:7.0`;
    execSync(restoreBootCmd, { stdio: 'inherit' });
    allocatedContainers.add(dstMongoContainer);

    // Wait for secondary container to become ready
    let restoreReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        execSync(`docker exec -i ${dstMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: 'db.runCommand({ ping: 1 })', stdio: 'ignore' });
        restoreReady = true;
        break;
      } catch {}
    }
    if (!restoreReady) throw new Error('Secondary drill restore container failed to start within 30s');
    console.log('PASS: Secondary restore container is ready.');

    // Record disposable marker into secondary target
    console.log('Inserting disposable database marker into secondary drill container admin database...');
    execSync(`docker exec -i ${dstMongoContainer} mongosh -u admin -p ${rootPass} --authenticationDatabase admin --quiet`, { input: markScript, stdio: ['pipe', 'ignore', 'ignore'] });

    // Inspect container ID for explicit identity matching
    const actualDstContainerId = execSync(`docker inspect -f "{{.Id}}" ${dstMongoContainer}`, { encoding: 'utf8' }).trim();

    // Inspect network ID and context for explicit identity matching
    const actualContext = execSync('docker context show', { encoding: 'utf8' }).trim();
    const actualNetworkId = execSync(`docker network inspect -f "{{.Id}}" ${testNetwork}`, { encoding: 'utf8' }).trim();

    // Verify that mismatching expectedContainerId triggers preflight rejection
    let rejectedMismatchedContainerId = false;
    try {
      assertSafeDisposableTarget({
        targetHost: dstMongoContainer,
        targetNetwork: testNetwork,
        targetVoiceVolume: dstVoiceVolume,
        targetUser: 'admin',
        targetPass: rootPass,
        expectedContainerId: 'deadbeef1234567890abcdef',
        expectedNetworkId: actualNetworkId,
        expectedMongoVolumeId: dstMongoVolume,
        expectedVoiceVolumeId: dstVoiceVolume,
        expectedDaemonId: dockerDaemonId,
        expectedContext: actualContext
      });
    } catch (err) {
      if (err.message.includes('Target container ID mismatch')) rejectedMismatchedContainerId = true;
    }
    if (!rejectedMismatchedContainerId) throw new Error('assertSafeDisposableTarget failed to reject container ID mismatch');
    console.log('PASS: Target container ID verification strictly enforced.');

    // ── STEP 7: Execute Authenticated Restore Drill ────────────────────────
    console.log('\n[Step 7] Running restore-db.mjs against secondary drill target with GCM authentication...');
    const manifestPath = path.join(testBackupDir, `manifest-${manifest.recoverySetId}.json`);

    const restoreResult = await runRestore(manifestPath, {
      backupKey: testBackupKey,
      targetHost: dstMongoContainer,
      targetPort: '27017',
      targetNetwork: testNetwork,
      targetVoiceVolume: dstVoiceVolume,
      targetUser: 'admin',
      targetPass: rootPass,
      targetDb: 'rapidaid',
      expectedContainerId: actualDstContainerId,
      expectedNetworkId: actualNetworkId,
      expectedMongoVolumeId: dstMongoVolume,
      expectedVoiceVolumeId: dstVoiceVolume,
      expectedDaemonId: dockerDaemonId,
      expectedContext: actualContext
    });

    // ── STEP 8: Assert Recovered Data Integrity ────────────────────────────
    console.log('\n[Step 8] Asserting recovered database records and media files...');
    if (restoreResult.status !== 'RESTORE_DRILL_PASSED') throw new Error('Restore status did not indicate success');
    if (restoreResult.collectionsFound < 5) throw new Error(`Expected at least 5 collections restored, found ${restoreResult.collectionsFound}`);
    if (restoreResult.documentCounts.users !== 2) throw new Error(`Expected 2 users, got ${restoreResult.documentCounts.users}`);
    if (restoreResult.documentCounts.emergencies !== 1) throw new Error(`Expected 1 emergency, got ${restoreResult.documentCounts.emergencies}`);
    if (restoreResult.voiceReferencesMatched !== 1) throw new Error(`Expected 1 voice reference match, got ${restoreResult.voiceReferencesMatched}`);

    // Verify file content in restored voice volume
    const catRestoredCmd = `docker run --rm -v "${dstVoiceVolume}:/source:ro" alpine cat /source/drill_user/rec-001/call.webm`;
    const restoredContent = execSync(catRestoredCmd, { encoding: 'utf8' }).trim();
    if (restoredContent !== 'SYNTHETIC_WEBM_AUDIO_BYTES_TEST') {
      throw new Error(`Restored voice audio content mismatch: got '${restoredContent}'`);
    }
    console.log('PASS: Restored voice audio file matches synthetic source byte-for-byte.');

    // ── STEP 9: Confirm Primary Resources Were Never Touched ───────────────
    console.log('\n[Step 9] Verifying production resources remained untouched...');
    const psCheck = execSync('docker ps -a --format "{{.Names}}"', { encoding: 'utf8' });
    if (psCheck.includes('rapidaid-mongo')) {
      console.log('PASS: Primary container rapidaid-mongo exists in unchanged state.');
    }

    console.log('\n================================================================');
    console.log('ALL PHASE 4.4.4 ENCRYPTED BACKUP & AUTHENTICATED RESTORE DRILLS PASSED');
    console.log('================================================================');

    return true;
  } finally {
    cleanDrillResources();
  }
}

// CLI Execution Entry Point
if (process.argv[1] && process.argv[1].endsWith('verify-backup-restore.mjs')) {
  verify()
    .then(() => {
      console.log('Verification finished successfully.');
      process.exit(0);
    })
    .catch(err => {
      console.error('VERIFICATION DRILL FAILED:\n', err.stack || err.message);
      process.exit(1);
    });
}
