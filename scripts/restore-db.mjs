#!/usr/bin/env node
/**
 * RapidAid V2 — Phase 4.4.4: Database & Voice Storage Isolated Restore Utility
 *
 * Enforces isolated, non-production restore verification drills only.
 * Multi-factor preflight target isolation, manifest HMAC-SHA256 signature verification,
 * and authenticated AES-256-GCM decryption.
 * Production restore is strictly blocked.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { assertSafeArtifactFilename } from './backup-db.mjs';

// ── Required Collections Baseline ────────────────────────────────────────────
export const REQUIRED_COLLECTIONS = [
  'users',
  'rolepolicies',
  'emergencies',
  'ambulances',
  'hospitals',
  'aidetections',
  'notifications',
  'auditlogs',
  'voicereports',
  'shifts',
  'maintenances',
  'cameras',
  'dailystats',
  'reports',
  'counters',
  'refreshtokens',
  'emailtokens',
  'idempotencykeys',
  'schedulerlocks'
];

export function computeSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

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
 * Executes a subprocess with secret sanitization.
 */
export function execSanitized(cmd, options = {}, secretsToRedact = [], customExec = execSync) {
  try {
    return customExec(cmd, options);
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
 * Multi-Factor Preflight Target Isolation Engine.
 * Verifies that the target environment is an actual disposable drill resource.
 * Prohibits connecting to production containers, networks, volumes, or databases.
 *
 * Notice on Isolation Proof:
 * -------------------------
 * Target isolation cannot be proven by labels, disposable markers, database names,
 * or hostnames alone. A real, fail-closed preflight must inspect the Docker daemon,
 * resolve exact runtime IDs (container ID, network ID, data volume ID, voice volume ID),
 * inspect live network attachments and volume mounts, verify DNS/endpoint resolution
 * inside the target network, and compare live inspection results against explicitly
 * required expected target identities.
 *
 * If any required inspection, endpoint verification, or isolation proof is
 * unavailable, inconsistent, or ambiguous, restore aborts immediately.
 */
export function assertSafeDisposableTarget(targetHostOrOptions, targetNetwork, targetVoiceVolume, targetDb, extraOptions = {}) {
  let opts = {};
  if (typeof targetHostOrOptions === 'object' && targetHostOrOptions !== null) {
    opts = { ...targetHostOrOptions };
  } else {
    opts = {
      targetHost: targetHostOrOptions,
      targetNetwork,
      targetVoiceVolume,
      targetDb,
      ...extraOptions
    };
  }

  const {
    targetHost,
    targetNetwork: net,
    targetVoiceVolume: vol,
    targetDb: db,
    targetUser = 'admin',
    targetPass,
    targetPort = '27017',
    mongoImage = 'mongo:7.0',
    skipDockerInspect = false,
    skipDbMarker = false,
    execFn = execSync
  } = opts;

  // Resolve mandatory expected target identities consistently from explicit options or environment
  const expectedContext = (opts.expectedContext ?? process.env.DRILL_EXPECTED_CONTEXT ?? '').trim();
  const expectedDaemonId = (opts.expectedDaemonId ?? process.env.DRILL_EXPECTED_DAEMON_ID ?? '').trim();
  const expectedContainerId = (opts.expectedContainerId ?? process.env.DRILL_EXPECTED_CONTAINER_ID ?? '').trim();
  const expectedNetworkId = (opts.expectedNetworkId ?? process.env.DRILL_EXPECTED_NETWORK_ID ?? '').trim();
  const expectedMongoVolumeId = (opts.expectedMongoVolumeId ?? process.env.DRILL_EXPECTED_MONGO_VOLUME_ID ?? '').trim();
  const expectedVoiceVolumeId = (opts.expectedVoiceVolumeId ?? process.env.DRILL_EXPECTED_VOICE_VOLUME_ID ?? '').trim();
  const expectedVoiceContainerId = (opts.expectedVoiceContainerId ?? process.env.DRILL_EXPECTED_VOICE_CONTAINER_ID ?? '').trim();

  const forbiddenHosts = ['mongodb', 'rapidaid-mongo', 'localhost', '127.0.0.1', '0.0.0.0', '::1', 'mongo'];
  const forbiddenNetworks = ['rapidaid-network', 'bridge', 'host', 'none', 'default'];
  const forbiddenVolumes = ['rapidaid-voice-storage', 'rapidaid-mongo-data'];

  // 1. Basic String & Blacklist Validation
  if (!targetHost || typeof targetHost !== 'string') {
    throw new Error('CRITICAL SAFETY ABORT: Missing or invalid targetHost.');
  }
  if (!net || typeof net !== 'string') {
    throw new Error('CRITICAL SAFETY ABORT: Missing or invalid targetNetwork.');
  }
  if (!vol || typeof vol !== 'string') {
    throw new Error('CRITICAL SAFETY ABORT: Missing or invalid targetVoiceVolume.');
  }

  const hLower = targetHost.toLowerCase().trim();
  const nLower = net.toLowerCase().trim();
  const vLower = vol.toLowerCase().trim();

  if (forbiddenHosts.includes(hLower) || hLower.includes('prod')) {
    throw new Error(`CRITICAL SAFETY ABORT: Refusing to restore to prohibited production host '${targetHost}'.`);
  }
  if (forbiddenNetworks.includes(nLower) || nLower.includes('prod')) {
    throw new Error(`CRITICAL SAFETY ABORT: Refusing to restore on prohibited production network '${net}'.`);
  }
  if (forbiddenVolumes.includes(vLower) || vLower.includes('prod')) {
    throw new Error(`CRITICAL SAFETY ABORT: Refusing to restore to primary production volume '${vol}'. Target must be an isolated drill volume.`);
  }

  // Positive Drill Substring Check
  const isIpHost = /^(\d{1,3}\.){3}\d{1,3}$/.test(targetHost);
  const isHostDrill = isIpHost || hLower.includes('drill');
  const isNetworkDrill = nLower.includes('drill');
  const isVolumeDrill = vLower.includes('drill');

  if (!isHostDrill || !isNetworkDrill || !isVolumeDrill) {
    throw new Error(
      `CRITICAL SAFETY ABORT: Target environment is not positively identified as an isolated disposable drill resource. ` +
      `Host ('${targetHost}' - ${isHostDrill ? 'OK' : 'INVALID'}), ` +
      `Network ('${net}' - ${isNetworkDrill ? 'OK' : 'INVALID'}), and ` +
      `Voice Volume ('${vol}' - ${isVolumeDrill ? 'OK' : 'INVALID'}) must all contain 'drill'.`
    );
  }

  if (db) {
    if (typeof db !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(db)) {
      throw new Error(`CRITICAL SAFETY ABORT: Target database name contains invalid characters: '${db}'.`);
    }
    const reservedDbs = ['admin', 'config', 'local'];
    if (reservedDbs.includes(db.toLowerCase())) {
      throw new Error(`CRITICAL SAFETY ABORT: Target database name cannot be a system database: '${db}'.`);
    }
  }

  // 2. Multi-Factor Docker Daemon & Container Inspection
  let actualDaemonId = null;
  let actualContainerId = null;
  let actualNetworkId = null;
  let actualMongoVolume = null;
  let actualVoiceVolume = null;
  let endpointIp = null;

  if (!skipDockerInspect) {
    // 2.0 Mandatory Expected Target Identities Validation
    if (!expectedContext) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedContext (DRILL_EXPECTED_CONTEXT).');
    }
    if (expectedContext.toLowerCase().includes('prod')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited production expectedContext '${expectedContext}'.`);
    }

    if (!expectedDaemonId) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedDaemonId (DRILL_EXPECTED_DAEMON_ID).');
    }
    if (expectedDaemonId.toLowerCase().includes('prod')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited production expectedDaemonId '${expectedDaemonId}'.`);
    }

    if (!expectedContainerId) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedContainerId (DRILL_EXPECTED_CONTAINER_ID).');
    }
    if (expectedContainerId.length < 12) {
      throw new Error(`CRITICAL SAFETY ABORT: Malformed expectedContainerId '${expectedContainerId}': arbitrary partial-ID prefixes are prohibited (minimum 12 characters).`);
    }
    if (expectedContainerId.toLowerCase().includes('prod')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited production expectedContainerId '${expectedContainerId}'.`);
    }

    if (!expectedNetworkId) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedNetworkId (DRILL_EXPECTED_NETWORK_ID).');
    }
    if (expectedNetworkId.length < 12) {
      throw new Error(`CRITICAL SAFETY ABORT: Malformed expectedNetworkId '${expectedNetworkId}': arbitrary partial-ID prefixes are prohibited (minimum 12 characters).`);
    }
    if (expectedNetworkId.toLowerCase().includes('prod')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited production expectedNetworkId '${expectedNetworkId}'.`);
    }

    if (!expectedMongoVolumeId) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedMongoVolumeId (DRILL_EXPECTED_MONGO_VOLUME_ID).');
    }
    const mongoExpLower = expectedMongoVolumeId.toLowerCase();
    if (forbiddenVolumes.includes(mongoExpLower) || mongoExpLower.includes('prod') || !mongoExpLower.includes('drill')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited or non-drill expectedMongoVolumeId '${expectedMongoVolumeId}'. Target must be an isolated drill volume.`);
    }

    if (!expectedVoiceVolumeId) {
      throw new Error('CRITICAL SAFETY ABORT: Missing mandatory expected target identity: expectedVoiceVolumeId (DRILL_EXPECTED_VOICE_VOLUME_ID).');
    }
    const voiceExpLower = expectedVoiceVolumeId.toLowerCase();
    if (forbiddenVolumes.includes(voiceExpLower) || voiceExpLower.includes('prod') || !voiceExpLower.includes('drill')) {
      throw new Error(`CRITICAL SAFETY ABORT: Prohibited or non-drill expectedVoiceVolumeId '${expectedVoiceVolumeId}'. Target must be an isolated drill volume.`);
    }

    // A: Docker Context & Daemon Identity Verification
    let activeContext;
    try {
      activeContext = execFn('docker context show', { encoding: 'utf8' }).trim();
      const ctxLower = activeContext.toLowerCase();
      if (ctxLower.includes('prod') || (process.env.DOCKER_HOST && process.env.DOCKER_HOST.toLowerCase().includes('prod'))) {
        throw new Error(`Active Docker context or DOCKER_HOST indicates a production daemon ('${activeContext}').`);
      }
      if (activeContext !== expectedContext) {
        throw new Error(`CRITICAL SAFETY ABORT: Docker context mismatch (expected '${expectedContext}', got '${activeContext}').`);
      }
    } catch (ctxErr) {
      if (ctxErr.message.includes('CRITICAL SAFETY ABORT')) throw ctxErr;
      throw new Error(`CRITICAL SAFETY ABORT: Could not verify Docker context: ${ctxErr.message}`);
    }

    try {
      actualDaemonId = execFn('docker info -f "{{.ID}}"', { encoding: 'utf8' }).trim();
      if (!actualDaemonId) {
        throw new Error('Docker daemon ID could not be determined. Daemon is unverified.');
      }
      if (actualDaemonId !== expectedDaemonId) {
        throw new Error(`CRITICAL SAFETY ABORT: Docker daemon ID mismatch (expected '${expectedDaemonId}', got '${actualDaemonId}').`);
      }
    } catch (daemonErr) {
      if (daemonErr.message.includes('CRITICAL SAFETY ABORT')) throw daemonErr;
      throw new Error(`CRITICAL SAFETY ABORT: Could not verify Docker daemon identity: ${daemonErr.message}`);
    }

    // B: Target Container Inspection
    let containerInfo;
    try {
      const inspectRaw = execFn(`docker inspect ${targetHost}`, { encoding: 'utf8' });
      const parsed = JSON.parse(inspectRaw);
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        throw new Error(`Ambiguous or missing inspect result for container '${targetHost}'`);
      }
      containerInfo = parsed[0];
    } catch (inspectErr) {
      if (inspectErr.message.includes('CRITICAL SAFETY ABORT')) throw inspectErr;
      throw new Error(`CRITICAL SAFETY ABORT: Target container '${targetHost}' inspection failed: ${inspectErr.message}`);
    }

    if (!containerInfo || !containerInfo.State?.Running) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container '${targetHost}' is not running.`);
    }

    actualContainerId = containerInfo.Id;
    if (!actualContainerId) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container '${targetHost}' has invalid or missing ID.`);
    }
    const isContainerIdExact = actualContainerId === expectedContainerId;
    const isContainerIdCanonicalPrefix = actualContainerId.startsWith(expectedContainerId) &&
      /^[0-9a-fA-F]{12,64}$/.test(expectedContainerId) &&
      /^[0-9a-fA-F]{64}$/.test(actualContainerId);
    if (!isContainerIdExact && !isContainerIdCanonicalPrefix) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container ID mismatch (expected '${expectedContainerId}', got '${actualContainerId}').`);
    }

    // Reject production images
    const imageTag = (containerInfo.Config?.Image || '').toLowerCase();
    if (imageTag.includes('rapidaid-backend') || imageTag.includes('rapidaid-frontend') || imageTag.includes('prod')) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container image '${imageTag}' is a production application container.`);
    }

    // C: Network Attachment Quarantine Check
    const networksMap = containerInfo.NetworkSettings?.Networks || {};
    const attachedNetworks = Object.keys(networksMap);
    if (!attachedNetworks.includes(net)) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container '${targetHost}' is not attached to target drill network '${net}'.`);
    }

    for (const attachedNet of attachedNetworks) {
      const attachedLower = attachedNet.toLowerCase();
      if (forbiddenNetworks.includes(attachedLower) || attachedLower.includes('prod')) {
        throw new Error(`CRITICAL SAFETY ABORT: Target container '${targetHost}' is attached to prohibited network '${attachedNet}'.`);
      }
    }

    if (attachedNetworks.length > 1) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container is multi-homed (${attachedNetworks.join(', ')}). Must be attached exclusively to drill network.`);
    }

    actualNetworkId = networksMap[net]?.NetworkID;
    if (!actualNetworkId) {
      throw new Error(`CRITICAL SAFETY ABORT: Could not resolve NetworkID for network '${net}'.`);
    }
    const isNetworkIdExact = actualNetworkId === expectedNetworkId;
    const isNetworkIdCanonicalPrefix = actualNetworkId.startsWith(expectedNetworkId) &&
      /^[0-9a-fA-F]{12,64}$/.test(expectedNetworkId) &&
      /^[0-9a-fA-F]{64}$/.test(actualNetworkId);
    if (!isNetworkIdExact && !isNetworkIdCanonicalPrefix) {
      throw new Error(`CRITICAL SAFETY ABORT: Target network ID mismatch (expected '${expectedNetworkId}', got '${actualNetworkId}').`);
    }

    // D: Database Endpoint Verification & DNS Resolution inside Drill Network
    let networkInfo;
    try {
      const netInspectRaw = execFn(`docker network inspect ${net}`, { encoding: 'utf8' });
      const parsedNet = JSON.parse(netInspectRaw);
      if (!Array.isArray(parsedNet) || parsedNet.length !== 1) {
        throw new Error(`Ambiguous network inspect result for '${net}'`);
      }
      networkInfo = parsedNet[0];
    } catch (netErr) {
      if (netErr.message.includes('CRITICAL SAFETY ABORT')) throw netErr;
      throw new Error(`CRITICAL SAFETY ABORT: Network '${net}' inspection failed: ${netErr.message}`);
    }

    const networkContainers = networkInfo.Containers || {};
    const matchingKey = Object.keys(networkContainers).find(cid => actualContainerId.startsWith(cid) || cid.startsWith(actualContainerId));
    if (!matchingKey) {
      throw new Error(`CRITICAL SAFETY ABORT: Target container '${actualContainerId}' is not registered in network '${net}' container endpoints.`);
    }

    const endpointEntry = networkContainers[matchingKey];
    endpointIp = (endpointEntry.IPv4Address || '').split('/')[0];
    const endpointName = (endpointEntry.Name || '').replace(/^\//, '');

    const containerSysName = (containerInfo.Name || '').replace(/^\//, '');
    if (isIpHost) {
      if (!containerSysName.toLowerCase().includes('drill')) {
        throw new Error(`CRITICAL SAFETY ABORT: Target container '${containerSysName}' for IP '${targetHost}' is not positively identified as a drill resource.`);
      }
      if (targetHost !== endpointIp) {
        throw new Error(`CRITICAL SAFETY ABORT: Endpoint IP mismatch: restore targetHost '${targetHost}' does not match container IP '${endpointIp}' in network '${net}'.`);
      }
    } else {
      if (targetHost.toLowerCase() !== endpointName.toLowerCase() && targetHost.toLowerCase() !== containerSysName.toLowerCase()) {
        throw new Error(`CRITICAL SAFETY ABORT: Endpoint hostname '${targetHost}' does not match verified container name '${endpointName}' in network '${net}'.`);
      }
    }

    // E: Mount & Volume Quarantine Inspection
    const mounts = containerInfo.Mounts || [];
    const dataMount = mounts.find(m => m.Destination === '/data/db');
    if (!dataMount) {
      throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB container '${actualContainerId}' does not mount /data/db.`);
    }
    actualMongoVolume = dataMount.Name || dataMount.Source;
    const mongoVolLower = (actualMongoVolume || '').toLowerCase();
    if (forbiddenVolumes.includes(mongoVolLower) || mongoVolLower.includes('prod') || mongoVolLower.includes('rapidaid-mongo-data')) {
      throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB container mounts production data volume '${actualMongoVolume}'.`);
    }
    if (actualMongoVolume !== expectedMongoVolumeId) {
      throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB data volume ID mismatch (expected '${expectedMongoVolumeId}', got '${actualMongoVolume}').`);
    }

    // Inspect MongoDB data volume directly
    try {
      const mVolInspectRaw = execFn(`docker volume inspect ${actualMongoVolume}`, { encoding: 'utf8' });
      const parsedMVol = JSON.parse(mVolInspectRaw);
      if (!Array.isArray(parsedMVol) || parsedMVol.length !== 1) {
        throw new Error(`Ambiguous volume inspect result for '${actualMongoVolume}'`);
      }
    } catch (mVolErr) {
      if (mVolErr.message.includes('CRITICAL SAFETY ABORT')) throw mVolErr;
      throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB volume '${actualMongoVolume}' inspection failed: ${mVolErr.message}`);
    }

    // Verify all containers mounting the MongoDB data volume
    try {
      const mongoMountedRaw = execFn(`docker ps -q --filter volume=${actualMongoVolume}`, { encoding: 'utf8' }).trim();
      if (!mongoMountedRaw) {
        throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB container '${actualContainerId}' was not found mounting volume '${actualMongoVolume}'.`);
      }
      const mongoMountingIds = mongoMountedRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const mid of mongoMountingIds) {
        const isSelf = actualContainerId === mid ||
          (actualContainerId.length === 64 && mid.length >= 12 && actualContainerId.startsWith(mid));
        if (!isSelf) {
          throw new Error(`CRITICAL SAFETY ABORT: Target MongoDB data volume '${actualMongoVolume}' is shared with another container ('${mid}'). Shared volumes are prohibited.`);
        }
      }
    } catch (mountErr) {
      if (mountErr.message.includes('CRITICAL SAFETY ABORT')) throw mountErr;
      throw new Error(`CRITICAL SAFETY ABORT: Failed to verify MongoDB volume mount quarantine: ${mountErr.message}`);
    }

    // Inspect Voice storage volume directly
    let volumeInfo;
    try {
      const volInspectRaw = execFn(`docker volume inspect ${vol}`, { encoding: 'utf8' });
      const parsedVol = JSON.parse(volInspectRaw);
      if (!Array.isArray(parsedVol) || parsedVol.length !== 1) {
        throw new Error(`Ambiguous volume inspect result for '${vol}'`);
      }
      volumeInfo = parsedVol[0];
    } catch (volErr) {
      if (volErr.message.includes('CRITICAL SAFETY ABORT')) throw volErr;
      throw new Error(`CRITICAL SAFETY ABORT: Target voice volume '${vol}' inspection failed: ${volErr.message}`);
    }

    actualVoiceVolume = volumeInfo.Name;
    if (actualVoiceVolume !== expectedVoiceVolumeId) {
      throw new Error(`CRITICAL SAFETY ABORT: Target voice volume ID mismatch (expected '${expectedVoiceVolumeId}', got '${actualVoiceVolume}').`);
    }

    // Verify which containers mount the voice storage volume
    try {
      const mountedVoiceRaw = execFn(`docker ps -q --filter volume=${vol}`, { encoding: 'utf8' }).trim();
      if (mountedVoiceRaw) {
        const voiceMountingIds = mountedVoiceRaw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        for (const mid of voiceMountingIds) {
          let isAuthorizedVoiceOwner = false;
          if (expectedVoiceContainerId) {
            isAuthorizedVoiceOwner = expectedVoiceContainerId === mid ||
              (expectedVoiceContainerId.length === 64 && mid.length >= 12 && expectedVoiceContainerId.startsWith(mid));
          }
          if (!isAuthorizedVoiceOwner) {
            throw new Error(`CRITICAL SAFETY ABORT: Target voice volume '${vol}' is mounted by unauthorized container ('${mid}'). Shared or unverified volumes are prohibited.`);
          }
        }
      }
    } catch (voiceMountErr) {
      if (voiceMountErr.message.includes('CRITICAL SAFETY ABORT')) throw voiceMountErr;
      throw new Error(`CRITICAL SAFETY ABORT: Failed to verify voice volume mount quarantine: ${voiceMountErr.message}`);
    }

    // F: Target Database Disposable Marker Fingerprint Probe
    if (!skipDbMarker && targetPass) {
      try {
        const markerScript = `
          const doc = db.getSiblingDB('admin').disposable_marker.findOne({ disposable: true });
          console.log('MARKER_PROBE:' + JSON.stringify({ isDisposable: !!doc }) + ':MARKER_PROBE_END');
        `;
        const probeCmd = `docker exec -i ${targetHost} mongosh -u ${targetUser} -p ${targetPass} --authenticationDatabase admin --quiet`;
        const probeRaw = execSanitized(probeCmd, { input: markerScript, encoding: 'utf8' }, [targetPass], execFn);
        const match = probeRaw.match(/MARKER_PROBE:(.*?):MARKER_PROBE_END/s);
        if (!match) {
          throw new Error('Target container returned malformed or empty disposable marker probe response.');
        }
        const probeData = JSON.parse(match[1]);
        if (!probeData.isDisposable) {
          throw new Error(`CRITICAL SAFETY ABORT: Target database '${targetHost}' failed disposable identity verification: missing admin.disposable_marker.`);
        }
      } catch (probeErr) {
        if (probeErr.message.includes('CRITICAL SAFETY ABORT')) throw probeErr;
        throw new Error(`CRITICAL SAFETY ABORT: Database disposable marker verification failed: ${probeErr.message}`);
      }
    }
  }

  console.log(`[SAFETY CHECK] Target confirmed as isolated disposable drill resource: host='${targetHost}', network='${net}', volume='${vol}'`);
  return {
    daemonId: actualDaemonId,
    containerId: actualContainerId,
    networkId: actualNetworkId,
    mongoVolume: actualMongoVolume,
    voiceVolume: actualVoiceVolume,
    endpointIp
  };
}

/**
 * Stream-decrypts an encrypted artifact into a private scratch location,
 * evaluating GCM authentication tag and verifying plaintext SHA-256 before use.
 */
export async function decryptArtifactStream(encryptedPath, scratchPlaintextPath, keyHex, ivHex, authTagHex, aadString) {
  if (!fs.existsSync(encryptedPath)) {
    throw new Error(`Encrypted artifact not found: ${encryptedPath}`);
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  decipher.setAAD(Buffer.from(aadString, 'utf8'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  const readStream = fs.createReadStream(encryptedPath);
  const writeStream = fs.createWriteStream(scratchPlaintextPath);

  // Gate 1: GCM Authentication Tag Evaluation
  try {
    await pipeline(readStream, decipher, writeStream);
  } catch (err) {
    if (fs.existsSync(scratchPlaintextPath)) {
      try { fs.unlinkSync(scratchPlaintextPath); } catch {}
    }
    throw new Error(`CRITICAL SECURITY ABORT: Ciphertext authentication failed (${err.message}). Data is corrupt or tampered.`);
  }

  if (!fs.existsSync(scratchPlaintextPath)) {
    throw new Error(`Decryption failed: scratch file missing: ${scratchPlaintextPath}`);
  }

  // Gate 2: Plaintext SHA-256 and Size Verification
  const plainHash = crypto.createHash('sha256');
  const buf = fs.readFileSync(scratchPlaintextPath);
  plainHash.update(buf);
  const computedSha256 = plainHash.digest('hex');
  const sizeBytes = buf.length;

  return {
    scratchPath: scratchPlaintextPath,
    plaintextSha256: computedSha256,
    plaintextSizeBytes: sizeBytes
  };
}

/**
 * Builds and logs structured report for non-destructive restore dry-run (Phase 4.4.5).
 */
export function formatDryRunReport(manifest, isEncrypted, mongoArtifact, voiceArtifact, dockerSkippedReason = null) {
  console.log('\n================================================================');
  console.log('[RESTORE DRY-RUN REPORT] Read-Only Preflight Verification');
  console.log('================================================================');
  console.log('[CHECK PASSED] Manifest schema and metadata structure valid.');
  console.log(`[CHECK PASSED] Recovery Set ID: ${manifest.recoverySetId}`);
  if (isEncrypted) {
    console.log(`[CHECK PASSED] Encryption Key ID matches manifest: ${manifest.encryption.keyId}`);
    console.log('[CHECK PASSED] Manifest HMAC-SHA256 signature verified via timingSafeEqual.');
    console.log('[CHECK PASSED] Encrypted MongoDB and Voice archives ciphertext SHA-256 verified.');
  } else {
    console.log('[CHECK PASSED] Legacy unencrypted recovery set SHA-256 checksums verified.');
  }
  console.log('[CHECK PASSED] Target isolation parameters and disposable drill identities validated.');
  console.log('----------------------------------------------------------------');
  if (dockerSkippedReason) {
    console.log(`[CHECK SKIPPED] Live Docker daemon inspection: ${dockerSkippedReason}`);
  }
  console.log('[CHECK SKIPPED] Artifact decryption (AES-256-GCM) — zero scratch files created.');
  console.log('[CHECK SKIPPED] Voice storage volume extraction (tar) — target volume untouched.');
  console.log('[CHECK SKIPPED] MongoDB database restore (mongorestore --drop) — target database untouched.');
  console.log('[CHECK SKIPPED] Post-restore collection and document count audit.');
  console.log('----------------------------------------------------------------');
  console.log('STATUS: DRY_RUN_PASSED.');
  console.log('DISCLAIMER: Dry-run validation confirms manifest integrity, cryptographic');
  console.log('authenticity, checksums, and disposable target configuration.');
  console.log('A successful dry run does NOT guarantee that a live restore will succeed.');
  console.log('================================================================\n');

  const checksSkipped = [
    'artifact-decryption',
    'scratch-directory-creation',
    'voice-volume-tar-extraction',
    'mongorestore-drop-execution',
    'post-restore-audit'
  ];
  if (dockerSkippedReason) {
    checksSkipped.push('live-docker-daemon-inspection');
  }

  return {
    status: 'DRY_RUN_PASSED',
    dryRun: true,
    recoverySetId: manifest.recoverySetId,
    schemaVersion: manifest.schemaVersion,
    isEncrypted,
    keyId: manifest.encryption?.keyId ?? null,
    artifacts: {
      mongodb: mongoArtifact.filename,
      voiceStorage: voiceArtifact.filename
    },
    checksCompleted: [
      'manifest-schema-and-metadata',
      'encryption-key-and-hmac-signature',
      'artifact-ciphertext-checksums',
      'target-disposable-identities'
    ],
    checksSkipped
  };
}

/**
 * Main Restore Execution Routine.
 */
export async function runRestore(manifestPath, options = {}) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${err.message}`);
  }

  const backupDir = path.dirname(path.resolve(manifestPath));

  // Validate manifest schema and metadata structure
  const supportedSchemas = ['1.0.0', '2.0.0'];
  if (!manifest.schemaVersion || !supportedSchemas.includes(manifest.schemaVersion)) {
    throw new Error(`CRITICAL SECURITY ABORT: Unsupported manifest schemaVersion: '${manifest.schemaVersion}'.`);
  }

  if (!manifest.recoverySetId || typeof manifest.recoverySetId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(manifest.recoverySetId)) {
    throw new Error(`CRITICAL SECURITY ABORT: Manifest contains invalid or unsafe recoverySetId: '${manifest.recoverySetId}'.`);
  }

  if (manifest.status !== 'VERIFIED_COMPLETE') {
    throw new Error(`CRITICAL SAFETY ABORT: Refusing to restore recovery set with status '${manifest.status}'. Only VERIFIED_COMPLETE sets may be restored.`);
  }

  const mongoArtifact = manifest.artifacts?.mongodb;
  const voiceArtifact = manifest.artifacts?.voiceStorage;

  if (!mongoArtifact || !voiceArtifact) {
    throw new Error('CRITICAL SECURITY ABORT: Manifest is malformed: missing mongodb or voiceStorage artifact definitions.');
  }

  // Validate safe filenames (no directory traversal, no path separators, no leading dots)
  assertSafeArtifactFilename(mongoArtifact.filename, backupDir);
  assertSafeArtifactFilename(voiceArtifact.filename, backupDir);

  console.log('================================================================');
  console.log(`RapidAid V2 — Starting Isolated Restore Drill: ${manifest.recoverySetId}`);
  console.log(`Backup Timestamp: ${manifest.timestamp}`);
  console.log(`Schema Version: ${manifest.schemaVersion}`);
  console.log('================================================================');

  // 1. Target Environment Resolution & Preflight Safety Verification
  const targetHost = options.targetHost || process.env.DRILL_MONGO_HOST;
  const targetPort = options.targetPort || process.env.DRILL_MONGO_PORT || '27017';
  const targetNetwork = options.targetNetwork || process.env.DRILL_NETWORK;
  const targetVoiceVolume = options.targetVoiceVolume || process.env.DRILL_VOICE_VOLUME;
  const targetUser = options.targetUser || process.env.DRILL_MONGO_USER || 'admin';
  const targetPass = options.targetPass || process.env.DRILL_MONGO_PASSWORD;
  const targetDb = options.targetDb || manifest.database || 'rapidaid';
  const mongoImage = options.mongoImage || 'mongo:7.0';

  const expectedContainerId = options.expectedContainerId || process.env.DRILL_EXPECTED_CONTAINER_ID;
  const expectedNetworkId = options.expectedNetworkId || process.env.DRILL_EXPECTED_NETWORK_ID;
  const expectedMongoVolumeId = options.expectedMongoVolumeId || process.env.DRILL_EXPECTED_MONGO_VOLUME_ID;
  const expectedVoiceVolumeId = options.expectedVoiceVolumeId || process.env.DRILL_EXPECTED_VOICE_VOLUME_ID;
  const expectedDaemonId = options.expectedDaemonId || process.env.DRILL_EXPECTED_DAEMON_ID;
  const expectedContext = options.expectedContext || process.env.DRILL_EXPECTED_CONTEXT;
  const expectedVoiceContainerId = options.expectedVoiceContainerId || process.env.DRILL_EXPECTED_VOICE_CONTAINER_ID;

  if (!targetHost || !targetNetwork || !targetVoiceVolume || !targetPass) {
    throw new Error('Missing mandatory drill target parameters (targetHost, targetNetwork, targetVoiceVolume, targetPass).');
  }

  const preflightOpts = {
    targetHost,
    targetNetwork,
    targetVoiceVolume,
    targetDb,
    targetUser,
    targetPass,
    targetPort,
    mongoImage,
    expectedContainerId,
    expectedNetworkId,
    expectedMongoVolumeId,
    expectedVoiceVolumeId,
    expectedDaemonId,
    expectedContext,
    expectedVoiceContainerId,
    skipDockerInspect: options.skipDockerInspect,
    skipDbMarker: options.skipDbMarker,
    execFn: options.execFn
  };

  // Multi-Factor Target Isolation Preflight (Executed BEFORE decrypting or running destructive actions)
  let dockerInspectionSkippedReason = null;
  try {
    assertSafeDisposableTarget(preflightOpts);
  } catch (preflightErr) {
    if (options.dryRun && (preflightErr.message.includes('Could not verify Docker context') || preflightErr.message.includes('Could not verify Docker daemon'))) {
      dockerInspectionSkippedReason = preflightErr.message;
      console.log(`[DRY-RUN NOTE] Live Docker daemon inspection skipped: ${preflightErr.message}`);
    } else {
      throw preflightErr;
    }
  }

  // 2. Encryption Key & Manifest Authenticity Verification
  const isEncrypted = manifest.schemaVersion === '2.0.0' && manifest.encryption?.enabled === true;
  const allowUnencrypted = options.allowUnencrypted ?? (process.env.RESTORE_UNENCRYPTED_ALLOWED === 'true');
  const backupKey = options.backupKey || process.env.BACKUP_ENCRYPTION_KEY;

  if (isEncrypted) {
    if (!backupKey || typeof backupKey !== 'string' || !/^[0-9a-fA-F]{64}$/.test(backupKey)) {
      throw new Error('CRITICAL SECURITY ABORT: Missing or invalid BACKUP_ENCRYPTION_KEY. 64-char hex key required to restore encrypted recovery set.');
    }

    const suppliedKeyId = deriveKeyId(backupKey);
    if (manifest.encryption.keyId && suppliedKeyId !== manifest.encryption.keyId) {
      throw new Error(`CRITICAL SECURITY ABORT: Key ID mismatch. Manifest requires key '${manifest.encryption.keyId}', but supplied key produces '${suppliedKeyId}'.`);
    }

    // Verify HMAC-SHA256 Manifest Signature
    if (!manifest.signature || manifest.signature.algorithm !== 'hmac-sha256' || !manifest.signature.value) {
      throw new Error('CRITICAL SECURITY ABORT: Manifest missing mandatory HMAC-SHA256 signature.');
    }

    const authKey = deriveManifestAuthKey(backupKey);
    const expectedSig = computeManifestSignature(manifest, authKey);

    const sigBuf = Buffer.from(manifest.signature.value, 'hex');
    const expBuf = Buffer.from(expectedSig, 'hex');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('CRITICAL SECURITY ABORT: Manifest signature verification failed. Manifest is forged, tampered, or uses wrong key.');
    }
    console.log('PASS: Manifest HMAC-SHA256 signature verified with client secret key.');
  } else {
    if (!allowUnencrypted) {
      throw new Error('CRITICAL SAFETY ABORT: Refusing to restore unencrypted legacy recovery set when RESTORE_UNENCRYPTED_ALLOWED=false.');
    }
    console.warn('\n[AUDIT WARNING] Restoring unencrypted legacy Phase 4.4.3 recovery set. Encryption and signature checks bypassed by explicit operator authorization.\n');
  }

  // 3. Artifact Checksum & Path Verification Prior to Decryption
  console.log('\n[1/4] Verifying Recovery Set Artifacts & Checksums...');
  const mongoFilePath = path.join(backupDir, mongoArtifact.filename);
  const voiceFilePath = path.join(backupDir, voiceArtifact.filename);

  if (!fs.existsSync(mongoFilePath)) throw new Error(`MongoDB archive missing: ${mongoFilePath}`);
  if (!fs.existsSync(voiceFilePath)) throw new Error(`Voice storage archive missing: ${voiceFilePath}`);

  const runId = `restore_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
  const scratchDir = path.resolve(backupDir, `.restore-scratch-${runId}`);
  let mongoPlaintextRestorePath = mongoFilePath;
  let voicePlaintextRestorePath = voiceFilePath;

  try {
    if (isEncrypted) {
      // Validate metadata hex lengths and presence
      if (!mongoArtifact.ivHex || mongoArtifact.ivHex.length !== 24 || !mongoArtifact.authTagHex || mongoArtifact.authTagHex.length !== 32) {
        throw new Error('CRITICAL SECURITY ABORT: MongoDB artifact metadata has invalid IV or authTag format.');
      }
      if (!voiceArtifact.ivHex || voiceArtifact.ivHex.length !== 24 || !voiceArtifact.authTagHex || voiceArtifact.authTagHex.length !== 32) {
        throw new Error('CRITICAL SECURITY ABORT: Voice artifact metadata has invalid IV or authTag format.');
      }
      if (!mongoArtifact.ciphertextSha256 || mongoArtifact.ciphertextSha256.length !== 64 || !voiceArtifact.ciphertextSha256 || voiceArtifact.ciphertextSha256.length !== 64) {
        throw new Error('CRITICAL SECURITY ABORT: Manifest artifact ciphertextSha256 metadata is invalid or missing.');
      }

      // Ciphertext on-disk integrity checks
      console.log('Computing SHA-256 for encrypted MongoDB archive...');
      const actualMongoCipherSha = computeSha256(mongoFilePath);
      if (actualMongoCipherSha !== mongoArtifact.ciphertextSha256) {
        throw new Error(`CHECKSUM MISMATCH for encrypted MongoDB archive: expected ${mongoArtifact.ciphertextSha256}, got ${actualMongoCipherSha}`);
      }

      console.log('Computing SHA-256 for encrypted Voice storage archive...');
      const actualVoiceCipherSha = computeSha256(voiceFilePath);
      if (actualVoiceCipherSha !== voiceArtifact.ciphertextSha256) {
        throw new Error(`CHECKSUM MISMATCH for encrypted Voice storage archive: expected ${voiceArtifact.ciphertextSha256}, got ${actualVoiceCipherSha}`);
      }

      // Restore Dry-Run early exit (Phase 4.4.5: Read-only verification without scratch creation or decryption)
      if (options.dryRun) {
        return formatDryRunReport(manifest, isEncrypted, mongoArtifact, voiceArtifact, dockerInspectionSkippedReason);
      }

      // Create isolated scratch directory with restrictive permissions (0700)
      fs.mkdirSync(scratchDir, { recursive: true });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(scratchDir, 0o700); } catch {}
      }

      const mongoScratchPath = path.join(scratchDir, `mongodb-${runId}.archive.gz`);
      const voiceScratchPath = path.join(scratchDir, `voice-${runId}.tar.gz`);

      console.log('\nDecrypting and authenticating MongoDB archive with AES-256-GCM...');
      const mongoAad = `2.0.0:${manifest.recoverySetId}:mongodb`;
      const mongoDecMeta = await decryptArtifactStream(
        mongoFilePath,
        mongoScratchPath,
        backupKey,
        mongoArtifact.ivHex,
        mongoArtifact.authTagHex,
        mongoAad
      );

      // Gate 2 Check: Plaintext Hash & Size
      if (mongoDecMeta.plaintextSha256 !== mongoArtifact.plaintextSha256) {
        throw new Error(`PLAINTEXT HASH MISMATCH for MongoDB archive: expected ${mongoArtifact.plaintextSha256}, got ${mongoDecMeta.plaintextSha256}`);
      }
      if (mongoDecMeta.plaintextSizeBytes !== mongoArtifact.plaintextSizeBytes) {
        throw new Error(`PLAINTEXT SIZE MISMATCH for MongoDB archive: expected ${mongoArtifact.plaintextSizeBytes}, got ${mongoDecMeta.plaintextSizeBytes}`);
      }
      console.log('PASS: MongoDB archive GCM authenticated and plaintext checksum verified.');

      console.log('Decrypting and authenticating Voice storage archive with AES-256-GCM...');
      const voiceAad = `2.0.0:${manifest.recoverySetId}:voiceStorage`;
      const voiceDecMeta = await decryptArtifactStream(
        voiceFilePath,
        voiceScratchPath,
        backupKey,
        voiceArtifact.ivHex,
        voiceArtifact.authTagHex,
        voiceAad
      );

      // Gate 2 Check: Plaintext Hash & Size
      if (voiceDecMeta.plaintextSha256 !== voiceArtifact.plaintextSha256) {
        throw new Error(`PLAINTEXT HASH MISMATCH for Voice storage archive: expected ${voiceArtifact.plaintextSha256}, got ${voiceDecMeta.plaintextSha256}`);
      }
      if (voiceDecMeta.plaintextSizeBytes !== voiceArtifact.plaintextSizeBytes) {
        throw new Error(`PLAINTEXT SIZE MISMATCH for Voice storage archive: expected ${voiceArtifact.plaintextSizeBytes}, got ${voiceDecMeta.plaintextSizeBytes}`);
      }
      console.log('PASS: Voice storage archive GCM authenticated and plaintext checksum verified.');

      mongoPlaintextRestorePath = mongoScratchPath;
      voicePlaintextRestorePath = voiceScratchPath;
    } else {
      // Legacy unencrypted checksum verification
      console.log('Computing SHA-256 for legacy MongoDB archive...');
      const computedMongoSha = computeSha256(mongoFilePath);
      if (computedMongoSha !== mongoArtifact.sha256) {
        throw new Error(`CHECKSUM MISMATCH for MongoDB archive: expected ${mongoArtifact.sha256}, got ${computedMongoSha}`);
      }

      console.log('Computing SHA-256 for legacy Voice storage archive...');
      const computedVoiceSha = computeSha256(voiceFilePath);
      if (computedVoiceSha !== voiceArtifact.sha256) {
        throw new Error(`CHECKSUM MISMATCH for Voice storage archive: expected ${voiceArtifact.sha256}, got ${computedVoiceSha}`);
      }

      // Restore Dry-Run early exit for legacy unencrypted recovery sets
      if (options.dryRun) {
        return formatDryRunReport(manifest, isEncrypted, mongoArtifact, voiceArtifact, dockerInspectionSkippedReason);
      }
    }

    // 3.5 Re-validate Target Isolation State Immediately Prior to Destructive Actions (TOCTOU Mitigation)
    console.log('\n[SAFETY CHECK] Re-verifying target isolation state immediately prior to destructive execution...');
    assertSafeDisposableTarget(preflightOpts);

    // 4. Restore Voice Storage into Disposable Target Volume
    console.log('\n[2/4] Restoring Voice Storage into Isolated Drill Volume...');
    const voiceRestoreCmd = `docker run --rm -v "${voicePlaintextRestorePath}:/archive.tar.gz:ro" -v "${targetVoiceVolume}:/dest" alpine sh -c "rm -rf /dest/* && tar -xzf /archive.tar.gz -C /dest"`;
    execSanitized(voiceRestoreCmd, { stdio: 'inherit' }, [targetPass, backupKey]);
    console.log('PASS: Voice storage archive extracted into target volume.');

    // 5. Restore MongoDB into Disposable Target Database
    console.log('\n[3/4] Restoring MongoDB Database via mongorestore...');
    process.env.MONGO_PASS = targetPass;
    process.env.MONGO_USER = targetUser;

    const mongoRestoreCmd = `docker run --rm --network "${targetNetwork}" -v "${mongoPlaintextRestorePath}:/archive.gz:ro" -e MONGO_PASS -e MONGO_USER ${mongoImage} sh -c "mongorestore --uri=\\"mongodb://$MONGO_USER:$MONGO_PASS@${targetHost}:${targetPort}/?authSource=admin\\" --archive=/archive.gz --gzip --drop --nsInclude=\\"${targetDb}.*\\""`;
    execSanitized(mongoRestoreCmd, { stdio: 'inherit' }, [targetPass, backupKey]);
    console.log('PASS: mongorestore completed successfully.');

    // 6. Post-Restore Validation Audit
    console.log('\n[4/4] Executing Post-Restore Verification Audit...');
    const auditScript = `
      const dbTarget = db.getSiblingDB('${targetDb}');
      const cols = dbTarget.getCollectionNames();
      const stats = {};
      for (const c of cols) {
        stats[c] = dbTarget.getCollection(c).countDocuments();
      }
      const idxInfo = dbTarget.getCollection('emergencies').getIndexes();
      const reports = dbTarget.getCollection('voicereports').find({}, { 'audio.storageKey': 1 }).toArray();
      console.log('AUDIT_START:' + JSON.stringify({ collections: cols, documentCounts: stats, emergencyIndexes: idxInfo.length, reports }) + ':AUDIT_END');
    `;

    const verifyCmd = `docker run --rm -i --network "${targetNetwork}" -e MONGO_PASS -e MONGO_USER ${mongoImage} sh -c "mongosh \\"mongodb://$MONGO_USER:$MONGO_PASS@${targetHost}:${targetPort}/admin?authSource=admin\\" --quiet"`;
    const auditRaw = execSanitized(verifyCmd, { input: auditScript, encoding: 'utf8' }, [targetPass, backupKey]);
    const auditMatch = auditRaw.match(/AUDIT_START:(.*?):AUDIT_END/s);
    if (!auditMatch) throw new Error(`Could not parse post-restore audit output from mongosh: ${auditRaw}`);
    const audit = JSON.parse(auditMatch[1]);

    console.log(`Restored Collections (${audit.collections.length}):`, audit.collections.join(', '));
    console.log('Document Counts:', JSON.stringify(audit.documentCounts, null, 2));

    const listTargetVoiceCmd = `docker run --rm -v "${targetVoiceVolume}:/source:ro" alpine find /source -type f`;
    const restoredVoiceFiles = execSanitized(listTargetVoiceCmd, { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .map(f => f.replace(/^\/source\//, '').replace(/^\.\//, ''));
    const restoredVoiceSet = new Set(restoredVoiceFiles);

    let verifiedVoiceMatches = 0;
    let missingVoiceRefs = [];
    for (const r of audit.reports || []) {
      const key = r.audio?.storageKey;
      if (key) {
        if (restoredVoiceSet.has(key) || Array.from(restoredVoiceSet).some(f => f.endsWith(path.basename(key)))) {
          verifiedVoiceMatches++;
        } else {
          missingVoiceRefs.push(key);
        }
      }
    }

    console.log(`Voice Integrity Audit: ${verifiedVoiceMatches}/${audit.reports?.length || 0} voice references resolved on disk. Missing: ${missingVoiceRefs.length}.`);

    return {
      status: 'RESTORE_DRILL_PASSED',
      recoverySetId: manifest.recoverySetId,
      collectionsFound: audit.collections.length,
      documentCounts: audit.documentCounts,
      emergencyIndexesCount: audit.emergencyIndexes,
      voiceReferencesTotal: audit.reports?.length || 0,
      voiceReferencesMatched: verifiedVoiceMatches,
      missingVoiceRefs
    };
  } catch (error) {
    let sanitizedMsg = error.message;
    for (const sec of [targetPass, backupKey].filter(Boolean)) {
      sanitizedMsg = sanitizedMsg.split(sec).join('[REDACTED]');
    }
    console.error('\nRESTORE FAILED:', sanitizedMsg);
    throw new Error(sanitizedMsg);
  } finally {
    // Scratch Cleanup (Unlinks private scratch buffer files)
    if (fs.existsSync(scratchDir)) {
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[WARN] Could not clean scratch directory ${scratchDir}:`, err.message);
      }
    }
  }
}

// CLI Execution Entry Point
if (process.argv[1] && process.argv[1].endsWith('restore-db.mjs')) {
  const isHelp = process.argv.includes('--help');
  const isDryRun = process.argv.includes('--dry-run');
  const nonOptionArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));

  if (isHelp || nonOptionArgs.length === 0) {
    console.log(`
RapidAid V2 — Isolated Database Restore Drill Utility

Usage:
  node scripts/restore-db.mjs <path-to-manifest.json> [options]

Notice:
  Restoring over production is strictly blocked. This tool only connects
  to target environments positively identified as disposable drill targets.

Options:
  --help                      Show this help message
  --dry-run                   Perform read-only preflight validation of manifest, HMAC,
                              checksums, and target parameters without creating scratch
                              files, decrypting, or modifying the target database/volumes

Required Environment Variables:
  DRILL_MONGO_HOST            Target isolated MongoDB host
  DRILL_NETWORK               Docker network connecting to drill target
  DRILL_VOICE_VOLUME          Isolated drill volume for voice storage
  DRILL_MONGO_PASSWORD        Administrative password for drill target
  DRILL_EXPECTED_CONTEXT      Mandatory expected Docker context (e.g. default)
  DRILL_EXPECTED_DAEMON_ID    Mandatory expected Docker daemon ID
  DRILL_EXPECTED_CONTAINER_ID Mandatory expected target MongoDB container ID
  DRILL_EXPECTED_NETWORK_ID   Mandatory expected drill network ID
  DRILL_EXPECTED_MONGO_VOLUME_ID Mandatory expected drill MongoDB data volume ID
  DRILL_EXPECTED_VOICE_VOLUME_ID Mandatory expected drill voice storage volume ID
  DRILL_EXPECTED_VOICE_CONTAINER_ID Optional expected voice storage owner container ID
  BACKUP_ENCRYPTION_KEY       Mandatory 64-character hex key for encrypted v2 manifests
  RESTORE_UNENCRYPTED_ALLOWED Explicitly set to 'true' to permit legacy unencrypted restore
`);
    process.exit(0);
  }

  const manifestArg = nonOptionArgs[0];
  runRestore(manifestArg, { dryRun: isDryRun }).catch(err => {
    console.error('Fatal error during restore execution:', err.message);
    process.exit(1);
  });
}
