import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// @ts-ignore - untyped .mjs script module
import {
  validateBucketName,
  validateRegion,
  scanEligibleRecoverySets,
  syncBackupsToS3,
  parseCliArgs,
  // @ts-ignore
} from '../../scripts/sync-backup-s3.mjs';

describe('Off-Site Backup S3 Synchronization Utility (scripts/sync-backup-s3.mjs)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rapidaid-s3-sync-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  function createMockEncryptedRecoverySet(setId: string, options?: {
    unencrypted?: boolean;
    incompleteStatus?: boolean;
    corruptHash?: boolean;
    missingVoice?: boolean;
  }) {
    const mongoData = `mock-encrypted-mongo-archive-${setId}`;
    const voiceData = `mock-encrypted-voice-tar-${setId}`;
    const mongoSha256 = crypto.createHash('sha256').update(mongoData).digest('hex');
    const voiceSha256 = crypto.createHash('sha256').update(voiceData).digest('hex');

    const mongoFile = `mongo-${setId}.gz.enc`;
    const voiceFile = `voice-${setId}.tar.enc`;
    const manifestFile = `manifest-${setId}.json`;
    const checksumsFile = `checksums-${setId}.sha256`;

    fs.writeFileSync(path.join(tempDir, mongoFile), mongoData);
    if (!options?.missingVoice) {
      fs.writeFileSync(path.join(tempDir, voiceFile), voiceData);
    }

    const manifest = {
      recoverySetId: setId,
      timestamp: new Date().toISOString(),
      status: options?.incompleteStatus ? 'IN_PROGRESS' : 'VERIFIED_COMPLETE',
      encryption: {
        enabled: !options?.unencrypted,
        algorithm: 'aes-256-gcm',
        keyId: 'kid_test_12345678',
      },
      artifacts: {
        mongo: {
          filename: mongoFile,
          sha256: options?.corruptHash ? '0000000000000000000000000000000000000000000000000000000000000000' : mongoSha256,
        },
        voice: {
          filename: voiceFile,
          sha256: voiceSha256,
        },
      },
    };

    fs.writeFileSync(path.join(tempDir, manifestFile), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(tempDir, checksumsFile),
      `${mongoSha256}  ${mongoFile}\n${voiceSha256}  ${voiceFile}\n`,
    );

    return { setId, mongoSha256, voiceSha256 };
  }

  describe('Validation & Parsing Rules', () => {
    it('validates compliant S3 bucket names and rejects invalid ones', () => {
      expect(validateBucketName('rapidaid-backups-bucket-2026')).toBe('rapidaid-backups-bucket-2026');
      expect(validateBucketName('backup.archive.prod')).toBe('backup.archive.prod');

      expect(() => validateBucketName('')).toThrow(/Missing S3 bucket name/);
      expect(() => validateBucketName('UPPERCASE-BUCKET')).toThrow(/Invalid S3 bucket name/);
      expect(() => validateBucketName('bucket..double-dot')).toThrow(/Invalid S3 bucket name/);
      expect(() => validateBucketName('b')).toThrow(/Invalid S3 bucket name/);
    });

    it('validates AWS region patterns and rejects invalid formats', () => {
      expect(validateRegion('us-east-1')).toBe('us-east-1');
      expect(validateRegion('eu-west-1')).toBe('eu-west-1');
      expect(validateRegion('ap-south-1')).toBe('ap-south-1');

      expect(() => validateRegion('')).toThrow(/Missing AWS region/);
      expect(() => validateRegion('invalid_region')).toThrow(/Invalid AWS region format/);
      expect(() => validateRegion('US-EAST-1')).toThrow(/Invalid AWS region format/);
    });

    it('parses CLI arguments with dry-run as default', () => {
      const defaultArgs = parseCliArgs(['--bucket', 'my-bucket', '--region', 'us-east-1']);
      expect(defaultArgs.dryRun).toBe(true);
      expect(defaultArgs.execute).toBe(false);
      expect(defaultArgs.bucket).toBe('my-bucket');
      expect(defaultArgs.region).toBe('us-east-1');

      const executeArgs = parseCliArgs(['--execute', '--bucket', 'b', '--region', 'r']);
      expect(executeArgs.execute).toBe(true);
      expect(executeArgs.dryRun).toBe(false);
    });
  });

  describe('Local Backup Eligibility Scanning (scanEligibleRecoverySets)', () => {
    it('discovers verified, complete, AES-256-GCM encrypted recovery sets', () => {
      const set1 = createMockEncryptedRecoverySet('2026-10-28T01-00-00');
      const scan = scanEligibleRecoverySets(tempDir);

      expect(scan.eligibleSets.length).toBe(1);
      expect(scan.eligibleSets[0].recoverySetId).toBe(set1.setId);
      expect(scan.eligibleSets[0].keyId).toBe('kid_test_12345678');
      expect(scan.eligibleSets[0].artifacts.length).toBe(4);
      expect(scan.rejectedSets.length).toBe(0);
    });

    it('rejects unencrypted recovery sets to prevent plaintext cloud exfiltration', () => {
      createMockEncryptedRecoverySet('unencrypted-set', { unencrypted: true });
      const scan = scanEligibleRecoverySets(tempDir);

      expect(scan.eligibleSets.length).toBe(0);
      expect(scan.rejectedSets.length).toBe(1);
      expect(scan.rejectedSets[0].reason).toContain('Refusing unencrypted backup');
    });

    it('rejects recovery sets with incomplete status (not VERIFIED_COMPLETE)', () => {
      createMockEncryptedRecoverySet('in-progress-set', { incompleteStatus: true });
      const scan = scanEligibleRecoverySets(tempDir);

      expect(scan.eligibleSets.length).toBe(0);
      expect(scan.rejectedSets.length).toBe(1);
      expect(scan.rejectedSets[0].reason).toContain('only VERIFIED_COMPLETE may be synchronized');
    });

    it('rejects recovery sets with missing artifact files', () => {
      createMockEncryptedRecoverySet('missing-voice-set', { missingVoice: true });
      const scan = scanEligibleRecoverySets(tempDir);

      expect(scan.eligibleSets.length).toBe(0);
      expect(scan.rejectedSets.length).toBe(1);
      expect(scan.rejectedSets[0].reason).toContain('Missing required artifact file');
    });

    it('rejects recovery sets where local file SHA-256 does not match the manifest', () => {
      createMockEncryptedRecoverySet('corrupted-hash-set', { corruptHash: true });
      const scan = scanEligibleRecoverySets(tempDir);

      expect(scan.eligibleSets.length).toBe(0);
      expect(scan.rejectedSets.length).toBe(1);
      expect(scan.rejectedSets[0].reason).toContain('SHA-256 mismatch');
    });

    it('ignores temporary files, lockfiles, gates, and scratch directories safely', () => {
      createMockEncryptedRecoverySet('clean-set');
      fs.writeFileSync(path.join(tempDir, '.backup.lock'), JSON.stringify({ pid: 123 }));
      fs.writeFileSync(path.join(tempDir, '.backup.gate'), 'gate-token');
      fs.writeFileSync(path.join(tempDir, 'scratch.tmp'), 'temporary');

      const scan = scanEligibleRecoverySets(tempDir);
      expect(scan.eligibleSets.length).toBe(1);
      expect(scan.eligibleSets[0].artifacts.some((a: { filename: string }) => a.filename.startsWith('.'))).toBe(false);
    });
  });

  describe('S3 Synchronization Engine (syncBackupsToS3)', () => {
    it('in dry-run mode (default), prepares upload plan with zero network/CLI invocations', async () => {
      createMockEncryptedRecoverySet('2026-10-28T02-00-00');
      const mockUploader = vi.fn();

      const result = await syncBackupsToS3({
        backupDir: tempDir,
        bucket: 'rapidaid-backups-bucket',
        region: 'us-east-1',
        prefix: 'prod-backups',
        uploader: mockUploader,
      });

      expect(result.mode).toBe('DRY_RUN');
      expect(result.eligibleSetsCount).toBe(1);
      expect(result.filesCount).toBe(4);
      expect(result.uploaded.length).toBe(0);
      expect(mockUploader).not.toHaveBeenCalled();

      // Check S3 URI formatting
      const manifestPlan = result.plan.find((p: { filename: string }) => p.filename.startsWith('manifest-'));
      expect(manifestPlan.s3Uri).toBe('s3://rapidaid-backups-bucket/prod-backups/2026-10-28T02-00-00/manifest-2026-10-28T02-00-00.json');
    });

    it('in execute mode, uploads eligible encrypted artifacts using the injected uploader', async () => {
      createMockEncryptedRecoverySet('2026-10-28T03-00-00');
      const mockUploader = vi.fn().mockResolvedValue({ ok: true });

      const result = await syncBackupsToS3({
        execute: true,
        backupDir: tempDir,
        bucket: 'rapidaid-backups-bucket',
        region: 'us-east-1',
        prefix: 'prod-backups',
        uploader: mockUploader,
      });

      expect(result.mode).toBe('EXECUTE');
      expect(result.eligibleSetsCount).toBe(1);
      expect(result.filesCount).toBe(4);
      expect(result.uploaded.length).toBe(4);
      expect(mockUploader).toHaveBeenCalledTimes(4);

      // Verify arguments passed to uploader
      const firstCall = mockUploader.mock.calls[0];
      expect(firstCall[0]).toContain('2026-10-28T03-00-00');
      expect(firstCall[1]).toContain('s3://rapidaid-backups-bucket/prod-backups/2026-10-28T03-00-00/');
      expect(firstCall[2]).toBe('us-east-1');
    });

    it('propagates uploader failures without crashing or leaking credentials', async () => {
      createMockEncryptedRecoverySet('2026-10-28T04-00-00');
      const failingUploader = vi.fn().mockRejectedValue(new Error('Network connection timeout to S3'));

      await expect(
        syncBackupsToS3({
          execute: true,
          backupDir: tempDir,
          bucket: 'rapidaid-backups-bucket',
          region: 'us-east-1',
          uploader: failingUploader,
        }),
      ).rejects.toThrow(/Network connection timeout to S3/);
    });
  });
});

