import { describe, expect, it, beforeEach, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { User, Counter, AuditLog } from '../src/models/index.js';
import { verifyPassword } from '../src/services/tokenService.js';
import {
  bootstrapAdmin,
  executeBootstrapTransaction,
  validateDatabaseName,
  validateAdminInputs,
  syncUserCounterWithExistingRecords,
  DEFAULT_ALLOWED_STAGING_DB,
} from '../scripts/bootstrap-admin.js';

createApp();

describe('Staging Administrator Bootstrap Utility (Strict ACID Transactions)', () => {
  const TEST_DB = 'rapidaid_phase1_test';
  const REPLSET_PORT = 27019;
  const REPLSET_URI = `mongodb://127.0.0.1:${REPLSET_PORT}/${TEST_DB}?directConnection=true`;

  let mongodProc: ChildProcess | null = null;
  let tempDbPath = '';

  beforeAll(async () => {
    tempDbPath = await mkdtemp(join(tmpdir(), 'mongo-rs-bootstrap-'));
    const candidatePaths = [
      process.env.MONGOD_PATH,
      'C:\\Program Files\\MongoDB\\Server\\8.0\\bin\\mongod.exe',
      'C:\\Program Files\\MongoDB\\Server\\7.0\\bin\\mongod.exe',
      'C:\\Program Files\\MongoDB\\Server\\6.0\\bin\\mongod.exe',
      'mongod',
    ].filter(Boolean) as string[];

    const mongodBinary = candidatePaths.find((p) => p === 'mongod' || existsSync(p)) || 'mongod';

    mongodProc = spawn(mongodBinary, [
      '--replSet',
      'rsBootstrapTest',
      '--port',
      String(REPLSET_PORT),
      '--dbpath',
      tempDbPath,
      '--bind_ip',
      '127.0.0.1',
    ]);

    // Poll until mongod accepts connections
    for (let i = 0; i < 40; i++) {
      try {
        await mongoose.connect(REPLSET_URI, { serverSelectionTimeoutMS: 500 });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    // Initiate single-node replica set
    try {
      await mongoose.connection.db!.admin().command({ replSetInitiate: {} });
    } catch {
      // Ignore if already initiated
    }

    // Wait until replica set primary election completes
    for (let i = 0; i < 40; i++) {
      try {
        const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
        if (hello.isWritablePrimary) break;
      } catch {
        // Retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 20000);

  afterAll(async () => {
    try {
      if (mongoose.connection.readyState !== 0) {
        await mongoose.disconnect();
      }
    } finally {
      if (mongodProc) {
        mongodProc.kill();
        await new Promise((r) => setTimeout(r, 500));
      }
      if (tempDbPath) {
        await rm(tempDbPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 10000);

  beforeEach(async () => {
    // Clear collections between tests for absolute isolation
    await User.deleteMany({});
    await Counter.deleteMany({});
    await AuditLog.deleteMany({});
  });

  // 1. Database name safety guard
  describe('1. Database Name Safety Guard', () => {
    it('strictly refuses execution against any database other than the authorized staging database', () => {
      expect(() => validateDatabaseName('rapidaid', DEFAULT_ALLOWED_STAGING_DB)).toThrow(
        /Database Protection Guard: Refusing to bootstrap admin/,
      );
      expect(() => validateDatabaseName('rapidaid_production', DEFAULT_ALLOWED_STAGING_DB)).toThrow(
        /Database Protection Guard: Refusing to bootstrap admin/,
      );
      expect(() => validateDatabaseName(TEST_DB, DEFAULT_ALLOWED_STAGING_DB)).toThrow(
        /Database Protection Guard: Refusing to bootstrap admin.*strictly restricted to 'rapidaid_staging'/,
      );
    });

    it('bootstrapAdmin throws when database does not match allowedDatabaseName', async () => {
      await expect(
        bootstrapAdmin({
          name: 'Staging Admin',
          email: 'admin@rapidaid.com',
          password: 'secure-password-123',
          allowedDatabaseName: 'rapidaid_staging',
        }),
      ).rejects.toThrow(/Database Protection Guard: Refusing to bootstrap admin/);
    });
  });

  // 2. Input validation
  describe('2. Input Validation', () => {
    it('validates name, email, and password constraints', () => {
      expect(() => validateAdminInputs('A', 'admin@rapidaid.com', 'password123')).toThrow(
        /at least 2 characters/,
      );
      expect(() => validateAdminInputs('Admin', 'invalid-email', 'password123')).toThrow(
        /valid email address/,
      );
      expect(() => validateAdminInputs('Admin', 'admin@rapidaid.com', 'short')).toThrow(
        /at least 8 characters/,
      );
    });
  });

  // 3. Existing email protection
  describe('3. Existing Email Collision Protection', () => {
    it('refuses to overwrite or silently promote an existing CITIZEN account', async () => {
      const existingEmail = 'citizen.jane@rapidaid.com';

      await User.create({
        _id: 'USR-001',
        name: 'Jane Citizen',
        email: existingEmail,
        passwordHash: 'dummyhash',
        role: 'CITIZEN',
        active: true,
      });

      await expect(
        bootstrapAdmin({
          name: 'Admin Attempt',
          email: existingEmail,
          password: 'new-password-123',
          allowedDatabaseName: TEST_DB,
          silent: true,
        }),
      ).rejects.toThrow(
        /already exists with role 'CITIZEN'.*Refusing to promote or overwrite/,
      );

      const user = await User.findById('USR-001').select('+passwordHash').lean();
      expect(user?.role).toBe('CITIZEN');
      expect(user?.passwordHash).toBe('dummyhash');
    });
  });

  // 4. Counter and ID collision handling
  describe('4. Counter Synchronization & Sequential ID Allocation', () => {
    it('accounts for existing USR-001 and USR-002 records even if Counter document was uninitialized', async () => {
      await User.create([
        {
          _id: 'USR-001',
          name: 'Citizen One',
          email: 'citizen1@rapidaid.com',
          passwordHash: 'hash1',
          role: 'CITIZEN',
          active: true,
        },
        {
          _id: 'USR-002',
          name: 'Citizen Two',
          email: 'citizen2@rapidaid.com',
          passwordHash: 'hash2',
          role: 'CITIZEN',
          active: true,
        },
      ]);

      await Counter.deleteOne({ _id: 'user' });

      const maxSeq = await syncUserCounterWithExistingRecords();
      expect(maxSeq).toBe(2);

      const counterDoc = await Counter.findById('user').lean();
      expect(counterDoc?.seq).toBe(2);

      const result = await bootstrapAdmin({
        name: 'Staging Administrator',
        email: 'admin@rapidaid.com',
        password: 'admin-password-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });

      expect(result.success).toBe(true);
      expect(result.user?.id).toBe('USR-003');

      const adminInDb = await User.findById('USR-003').lean();
      expect(adminInDb).toBeDefined();
      expect(adminInDb?.email).toBe('admin@rapidaid.com');
      expect(adminInDb?.role).toBe('ADMIN');
    });
  });

  // 5. Strict Transactional Atomicity & Recovery Tests
  describe('5. Strict Transactional Atomicity & Concurrency', () => {
    // 5.1 Successful transactional bootstrap
    it('successfully executes transactional bootstrap committing user and claim atomically', async () => {
      const result = await bootstrapAdmin({
        name: 'RapidAid Staging Admin',
        email: 'admin.staging@rapidaid.com',
        password: 'super-secure-pass-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });

      expect(result.success).toBe(true);
      expect(result.reason).toBe('SUCCESS');
      expect(result.user?.email).toBe('admin.staging@rapidaid.com');
      expect(result.user?.role).toBe('ADMIN');

      // Verify user document in DB
      const createdUser = await User.findOne({ email: 'admin.staging@rapidaid.com' }).select(
        '+passwordHash',
      );
      expect(createdUser).toBeDefined();
      expect(createdUser?.role).toBe('ADMIN');
      expect(createdUser?.active).toBe(true);
      expect(createdUser?.emailVerified).toBe(true);

      // Verify bcrypt password hash
      const isValid = await verifyPassword('super-secure-pass-123', createdUser!.passwordHash);
      expect(isValid).toBe(true);

      // Verify claim document transitioned to COMPLETED
      const claim = await Counter.collection.findOne({ _id: 'bootstrap_admin_claim' });
      expect(claim?.state).toBe('COMPLETED');
      expect(claim?.adminUserId).toBe(createdUser?._id);

      // Verify audit log write
      const audit = await AuditLog.findOne({ resourceId: createdUser?._id }).lean();
      expect(audit).toBeDefined();
      expect(audit?.action).toBe('user.created');
    });

    // 5.2 Claim ownership lost before commit
    it('aborts transaction when claim ownership is lost before commit and rolls back candidate user', async () => {
      const resA = bootstrapAdmin({
        name: 'Process A Admin',
        email: 'processa@rapidaid.com',
        password: 'password-a-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
        staleLockTimeoutMs: 50,
        disableHeartbeat: true,
        betweenFenceAndInsert: async () => {
          // Pause Process A until its claim exceeds staleLockTimeoutMs
          await new Promise((r) => setTimeout(r, 100));

          // Process B runs stale-claim recovery while Process A is paused
          const resB = await bootstrapAdmin({
            name: 'Process B Admin',
            email: 'processb@rapidaid.com',
            password: 'password-b-123',
            allowedDatabaseName: TEST_DB,
            silent: true,
            staleLockTimeoutMs: 50,
          });

          expect(resB.success).toBe(true);
          expect(resB.user?.email).toBe('processb@rapidaid.com');
        },
      });

      // Process A resumes after Process B took over, but Process A's transaction aborts
      await expect(resA).rejects.toThrow(/Bootstrap claim CAS transition failed|ownership was lost/);

      // Exactly ONE administrator exists in the entire database
      const adminUsers = await User.find({ role: 'ADMIN' });
      expect(adminUsers).toHaveLength(1);
      expect(adminUsers[0].email).toBe('processb@rapidaid.com');

      // Process A's candidate was completely rolled back by the transaction
      expect(await User.findOne({ email: 'processa@rapidaid.com' })).toBeNull();
    });

    // 5.3 Transaction abort leaves no candidate user
    it('aborts transaction on failure leaving no candidate user in database', async () => {
      const failingAttempt = bootstrapAdmin({
        name: 'Failing Admin',
        email: 'failing@rapidaid.com',
        password: 'password-failing-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
        beforeCommit: async () => {
          throw new Error('Simulated failure right before commit');
        },
      });

      await expect(failingAttempt).rejects.toThrow('Simulated failure right before commit');

      // Verify that NO admin user was persisted in the database
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(0);
      expect(await User.findOne({ email: 'failing@rapidaid.com' })).toBeNull();
    });

    // 5.4 Concurrent bootstrap attempts
    it('concurrent bootstrap attempts with different emails result in strictly one administrator', async () => {
      const [res1, res2] = await Promise.all([
        bootstrapAdmin({
          name: 'Concurrent Admin 1',
          email: 'concurrent1@rapidaid.com',
          password: 'concurrent-pass-1',
          allowedDatabaseName: TEST_DB,
          silent: true,
        }),
        bootstrapAdmin({
          name: 'Concurrent Admin 2',
          email: 'concurrent2@rapidaid.com',
          password: 'concurrent-pass-2',
          allowedDatabaseName: TEST_DB,
          silent: true,
        }),
      ]);

      const successCount = [res1, res2].filter((r) => r.success).length;
      const alreadyExistsCount = [res1, res2].filter((r) => r.reason === 'ADMIN_ALREADY_EXISTS').length;

      expect(successCount).toBe(1);
      expect(alreadyExistsCount).toBe(1);
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(1);
    });

    // 5.5 Transaction retry behavior on transient errors
    it('retries automatically on TransientTransactionError via withTransaction', async () => {
      let attempts = 0;

      const result = await bootstrapAdmin({
        name: 'Retry Admin',
        email: 'retry.admin@rapidaid.com',
        password: 'retry-password-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
        beforeCommit: async () => {
          attempts++;
          if (attempts === 1) {
            // Throw a genuine MongoServerError carrying TransientTransactionError label
            const transientErr = new mongoose.mongo.MongoServerError({
              message: 'WriteConflict error during transaction',
              errorLabels: ['TransientTransactionError'],
            });
            throw transientErr;
          }
        },
      });

      expect(result.success).toBe(true);
      expect(attempts).toBe(2); // Verified that withTransaction retried the callback!
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(1);
    });

    // 5.6 Process interruption before commit
    it('handles process interruption before commit safely rolling back transaction', async () => {
      const interruptedAttempt = bootstrapAdmin({
        name: 'Interrupted Admin',
        email: 'interrupted@rapidaid.com',
        password: 'interrupted-pass-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
        beforeCommit: async () => {
          // Explicitly simulate an unhandled process interruption / network abort
          throw new Error('Process interrupted before commit');
        },
      });

      await expect(interruptedAttempt).rejects.toThrow('Process interrupted before commit');

      // Verify that 0 users were persisted
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(0);

      // Verify that subsequent provisioning can succeed cleanly
      const cleanRun = await bootstrapAdmin({
        name: 'Clean Admin',
        email: 'clean.admin@rapidaid.com',
        password: 'clean-password-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });

      expect(cleanRun.success).toBe(true);
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(1);
    });

    // 5.7 Active admin protection & idempotency
    it('exits cleanly without modifications if an active ADMIN already exists', async () => {
      const firstResult = await bootstrapAdmin({
        name: 'Primary Admin',
        email: 'primary.admin@rapidaid.com',
        password: 'primary-pass-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });
      expect(firstResult.success).toBe(true);

      const secondResult = await bootstrapAdmin({
        name: 'Secondary Admin',
        email: 'secondary.admin@rapidaid.com',
        password: 'secondary-pass-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });

      expect(secondResult.success).toBe(false);
      expect(secondResult.reason).toBe('ADMIN_ALREADY_EXISTS');
      expect(await User.countDocuments({ role: 'ADMIN' })).toBe(1);
    });

    it('refuses to bootstrap over an inactive administrator account', async () => {
      await User.collection.insertOne({
        _id: 'USR-098',
        name: 'Deactivated Admin',
        email: 'deactivated.admin@rapidaid.com',
        passwordHash: 'dummyhash',
        role: 'ADMIN',
        active: false,
        emailVerified: true,
      });

      await expect(
        bootstrapAdmin({
          name: 'Replacement Admin',
          email: 'replacement.admin@rapidaid.com',
          password: 'replacement-pass-123',
          allowedDatabaseName: TEST_DB,
          silent: true,
        }),
      ).rejects.toThrow(/An Administrator account already exists .* but is currently inactive/);
    });

    it('repeated execution is completely idempotent', async () => {
      const res1 = await bootstrapAdmin({
        name: 'Idempotent Admin',
        email: 'idemp.admin@rapidaid.com',
        password: 'idemp-password-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });
      expect(res1.success).toBe(true);

      const res2 = await bootstrapAdmin({
        name: 'Idempotent Admin',
        email: 'idemp.admin@rapidaid.com',
        password: 'idemp-password-123',
        allowedDatabaseName: TEST_DB,
        silent: true,
      });
      expect(res2.success).toBe(false);
      expect(res2.reason).toBe('ADMIN_ALREADY_EXISTS');
    });
  });
});
