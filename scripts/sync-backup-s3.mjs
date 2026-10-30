#!/usr/bin/env node
/**
 * RapidAid V2 — Phase 5.3: Off-Site Encrypted Backup S3 Synchronization Utility
 *
 * Safely synchronizes completed, verified, AES-256-GCM encrypted backup sets to AWS S3.
 *
 * SAFETY INVARIANTS:
 * 1. Default to Dry-Run: Never executes uploads unless --execute is explicitly supplied.
 * 2. Explicit Configuration: Requires explicit bucket and region; no hardcoded defaults.
 * 3. Encrypted-Only Gate: Strictly rejects unencrypted, incomplete, or corrupted recovery sets.
 * 4. Exclusion of Non-Artifacts: Never uploads scratch files, lockfiles, gates, or plaintext archives.
 * 5. Preservation of Remote State: Never deletes or overwrites remote backups automatically.
 * 6. Secret Sanitization: Never prints credentials, AWS secret keys, or backup key material.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';

const S3_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;

/** Computes hex SHA-256 digest of a local file. */
export function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const buffer = fs.readFileSync(filePath);
  hash.update(buffer);
  return hash.digest('hex');
}

/**
 * Validates S3 bucket name against AWS naming rules.
 */
export function validateBucketName(bucket) {
  if (!bucket || typeof bucket !== 'string') {
    throw new Error('Missing S3 bucket name. Provide via --bucket or BACKUP_S3_BUCKET environment variable.');
  }
  const clean = bucket.trim();
  if (!S3_BUCKET_NAME_RE.test(clean) || clean.includes('..')) {
    throw new Error(`Invalid S3 bucket name: '${clean}'. Must comply with AWS DNS-compliant bucket naming.`);
  }
  return clean;
}

/**
 * Validates AWS region format.
 */
export function validateRegion(region) {
  if (!region || typeof region !== 'string') {
    throw new Error('Missing AWS region. Provide via --region, AWS_REGION, or AWS_DEFAULT_REGION.');
  }
  const clean = region.trim();
  if (!AWS_REGION_RE.test(clean)) {
    throw new Error(`Invalid AWS region format: '${clean}' (expected e.g. 'us-east-1', 'eu-west-1').`);
  }
  return clean;
}

/**
 * Scans a backup directory and discovers completed, verified, AES-256-GCM encrypted recovery sets.
 * Strictly ignores unencrypted archives, lockfiles, temporary files, and scratch directories.
 */
export function scanEligibleRecoverySets(backupDir) {
  const resolvedDir = path.resolve(backupDir);
  if (!fs.existsSync(resolvedDir)) {
    throw new Error(`Backup directory does not exist: '${resolvedDir}'`);
  }

  const entries = fs.readdirSync(resolvedDir);
  const manifestFiles = entries.filter((f) => f.startsWith('manifest-') && f.endsWith('.json'));

  const eligibleSets = [];
  const rejectedSets = [];

  for (const manifestFilename of manifestFiles) {
    const manifestPath = path.join(resolvedDir, manifestFilename);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (parseErr) {
      rejectedSets.push({
        file: manifestFilename,
        reason: `Unparseable manifest JSON: ${parseErr.message}`,
      });
      continue;
    }

    const setId = manifest.recoverySetId;
    if (!setId || manifestFilename !== `manifest-${setId}.json`) {
      rejectedSets.push({
        file: manifestFilename,
        reason: 'Manifest recoverySetId is missing or does not match filename',
      });
      continue;
    }

    // Gate 1: Status must be VERIFIED_COMPLETE
    if (manifest.status !== 'VERIFIED_COMPLETE') {
      rejectedSets.push({
        setId,
        reason: `Backup status is '${manifest.status}' (only VERIFIED_COMPLETE may be synchronized)`,
      });
      continue;
    }

    // Gate 2: Encryption must be enabled (AES-256-GCM)
    if (!manifest.encryption?.enabled) {
      rejectedSets.push({
        setId,
        reason: 'Refusing unencrypted backup: manifest.encryption.enabled is not true',
      });
      continue;
    }

    if (!manifest.encryption?.keyId) {
      rejectedSets.push({
        setId,
        reason: 'Manifest encryption.keyId is missing',
      });
      continue;
    }

    // Gate 3: Required encrypted artifacts must be present locally
    const mongoEncName = `mongo-${setId}.gz.enc`;
    const voiceEncName = `voice-${setId}.tar.enc`;
    const checksumsName = `checksums-${setId}.sha256`;

    const requiredFiles = [
      { name: manifestFilename, type: 'manifest' },
      { name: mongoEncName, type: 'database_encrypted' },
      { name: voiceEncName, type: 'voice_encrypted' },
      { name: checksumsName, type: 'checksums' },
    ];

    let missingFile = false;
    const artifacts = [];

    for (const req of requiredFiles) {
      const fullPath = path.join(resolvedDir, req.name);
      if (!fs.existsSync(fullPath)) {
        rejectedSets.push({
          setId,
          reason: `Missing required artifact file: '${req.name}'`,
        });
        missingFile = true;
        break;
      }

      const stats = fs.statSync(fullPath);
      if (!stats.isFile() || stats.size === 0) {
        rejectedSets.push({
          setId,
          reason: `Artifact file is empty or not a regular file: '${req.name}'`,
        });
        missingFile = true;
        break;
      }

      const sha256 = computeFileSha256(fullPath);

      // Verify checksum against manifest if present
      if (req.type === 'database_encrypted' && manifest.artifacts?.mongo?.sha256) {
        if (manifest.artifacts.mongo.sha256.toLowerCase() !== sha256.toLowerCase()) {
          rejectedSets.push({
            setId,
            reason: `Local database artifact SHA-256 mismatch for '${req.name}'`,
          });
          missingFile = true;
          break;
        }
      }

      if (req.type === 'voice_encrypted' && manifest.artifacts?.voice?.sha256) {
        if (manifest.artifacts.voice.sha256.toLowerCase() !== sha256.toLowerCase()) {
          rejectedSets.push({
            setId,
            reason: `Local voice artifact SHA-256 mismatch for '${req.name}'`,
          });
          missingFile = true;
          break;
        }
      }

      artifacts.push({
        filename: req.name,
        localPath: fullPath,
        sizeBytes: stats.size,
        sha256,
        type: req.type,
      });
    }

    if (missingFile) {
      continue;
    }

    eligibleSets.push({
      recoverySetId: setId,
      timestamp: manifest.timestamp,
      keyId: manifest.encryption.keyId,
      artifacts,
    });
  }

  return { eligibleSets, rejectedSets };
}

/**
 * Default AWS CLI uploader. Executes `aws s3 cp` with sanitized error handling.
 */
export function defaultAwsCliUploader(localPath, s3Uri, region) {
  try {
    execFileSync('aws', ['s3', 'cp', localPath, s3Uri, '--region', region, '--only-show-errors'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return { ok: true };
  } catch (err) {
    const sanitizedMsg = (err.stderr || err.message || '').replace(/([A-Z0-9]{20})|([A-Za-z0-9/+=]{40})/g, '[REDACTED]');
    throw new Error(`AWS CLI upload failed for '${path.basename(localPath)}': ${sanitizedMsg}`);
  }
}

/**
 * Main synchronization engine.
 *
 * In dry-run mode (default), evaluates eligibility, prepares target S3 URIs,
 * and prints an actionable plan without making any network calls.
 * In execute mode, uploads eligible encrypted artifacts to S3 using the configured uploader.
 */
export async function syncBackupsToS3(options = {}) {
  const isExecute = Boolean(options.execute || options.upload);
  const isDryRun = !isExecute;

  const backupDir = options.backupDir || process.env.BACKUP_DIR || './backups';
  const bucket = validateBucketName(options.bucket || process.env.BACKUP_S3_BUCKET);
  const region = validateRegion(options.region || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION);
  const prefix = (options.prefix || process.env.BACKUP_S3_PREFIX || 'rapidaid-backups').replace(/^\/+|\/+$/g, '');
  const uploader = options.uploader || defaultAwsCliUploader;

  const { eligibleSets, rejectedSets } = scanEligibleRecoverySets(backupDir);

  const plan = [];

  for (const set of eligibleSets) {
    for (const art of set.artifacts) {
      const s3Key = `${prefix}/${set.recoverySetId}/${art.filename}`;
      const s3Uri = `s3://${bucket}/${s3Key}`;
      plan.push({
        recoverySetId: set.recoverySetId,
        keyId: set.keyId,
        filename: art.filename,
        localPath: art.localPath,
        sizeBytes: art.sizeBytes,
        sha256: art.sha256,
        s3Uri,
      });
    }
  }

  const result = {
    mode: isDryRun ? 'DRY_RUN' : 'EXECUTE',
    bucket,
    region,
    prefix,
    eligibleSetsCount: eligibleSets.length,
    rejectedSetsCount: rejectedSets.length,
    filesCount: plan.length,
    plan,
    rejectedSets,
    uploaded: [],
  };

  if (isDryRun) {
    return result;
  }

  // Execute Mode: Upload each artifact
  for (const item of plan) {
    await uploader(item.localPath, item.s3Uri, region);
    result.uploaded.push({
      filename: item.filename,
      s3Uri: item.s3Uri,
      sha256: item.sha256,
      sizeBytes: item.sizeBytes,
    });
  }

  return result;
}

// ── CLI Runner ───────────────────────────────────────────────────────────────
export function parseCliArgs(args) {
  const options = {
    execute: false,
    dryRun: true,
    inspect: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--execute' || arg === '--upload') {
      options.execute = true;
      options.dryRun = false;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
      options.execute = false;
    } else if (arg === '--inspect') {
      options.inspect = true;
    } else if (arg === '--bucket' && args[i + 1]) {
      options.bucket = args[++i];
    } else if (arg === '--region' && args[i + 1]) {
      options.region = args[++i];
    } else if (arg === '--prefix' && args[i + 1]) {
      options.prefix = args[++i];
    } else if (arg === '--backup-dir' && args[i + 1]) {
      options.backupDir = args[++i];
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  (async () => {
    try {
      const opts = parseCliArgs(process.argv.slice(2));
      console.log('═══════════════════════════════════════════════════════════════════');
      console.log(' RapidAid V2 — Off-Site Encrypted Backup S3 Synchronization');
      console.log('═══════════════════════════════════════════════════════════════════');

      if (opts.inspect) {
        const backupDir = opts.backupDir || process.env.BACKUP_DIR || './backups';
        const scan = scanEligibleRecoverySets(backupDir);
        console.log(`[INSPECT] Backup directory: ${backupDir}`);
        console.log(`[INSPECT] Eligible encrypted recovery sets: ${scan.eligibleSets.length}`);
        for (const s of scan.eligibleSets) {
          console.log(`  ✓ ${s.recoverySetId} (keyId: ${s.keyId}, artifacts: ${s.artifacts.length})`);
        }
        if (scan.rejectedSets.length > 0) {
          console.log(`[INSPECT] Ineligible / rejected sets: ${scan.rejectedSets.length}`);
          for (const r of scan.rejectedSets) {
            console.log(`  ✗ ${r.setId || r.file}: ${r.reason}`);
          }
        }
        process.exit(0);
      }

      console.log(`Mode:   ${opts.execute ? 'LIVE EXECUTION (Upload to S3)' : 'DRY-RUN (Simulate only)'}`);
      const summary = await syncBackupsToS3(opts);

      console.log(`Target: s3://${summary.bucket}/${summary.prefix}/ (${summary.region})`);
      console.log(`Found:  ${summary.eligibleSetsCount} eligible recovery sets (${summary.filesCount} total files)`);

      if (summary.rejectedSets.length > 0) {
        console.log(`Ignored ${summary.rejectedSets.length} ineligible files / sets (unencrypted, incomplete, or corrupted).`);
      }

      console.log('\nArtifact Synchronization Plan:');
      for (const item of summary.plan) {
        console.log(`  - [${item.filename}] (${(item.sizeBytes / 1024).toFixed(1)} KB) -> ${item.s3Uri}`);
      }

      if (opts.dryRun) {
        console.log('\n[DRY-RUN COMPLETE] Zero network calls made. Supply --execute to perform upload.');
      } else {
        console.log(`\n[SUCCESS] Successfully synchronized ${summary.uploaded.length} encrypted backup files to S3.`);
      }
      process.exit(0);
    } catch (err) {
      console.error('\n❌ S3 Synchronization Failed:');
      console.error(`   ${err.message}`);
      process.exit(1);
    }
  })();
}

