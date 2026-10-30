import { randomUUID } from 'node:crypto';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import { logger } from '../src/config/logger.js';
import { User } from '../src/models/User.js';
import { Counter, nextId } from '../src/models/Counter.js';
import { hashPassword } from '../src/services/tokenService.js';
import { recordAudit } from '../src/services/auditService.js';

export const DEFAULT_ALLOWED_STAGING_DB = 'rapidaid_staging';
export const DEFAULT_STALE_LOCK_TIMEOUT_MS = 15_000;
export const DEFAULT_WAIT_TIMEOUT_MS = 6_000;
export const DEFAULT_POLL_INTERVAL_MS = 200;

export interface BootstrapAdminOptions {
  name?: string;
  email?: string;
  password?: string;
  allowedDatabaseName?: string;
  silent?: boolean;
  staleLockTimeoutMs?: number;
  waitTimeoutMs?: number;
  pollIntervalMs?: number;
  betweenFenceAndInsert?: () => Promise<void>;
  beforeCommit?: (session: mongoose.ClientSession) => Promise<void>;
  disableHeartbeat?: boolean;
}

export interface BootstrapAdminResult {
  success: boolean;
  user?: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  reason?: 'ADMIN_ALREADY_EXISTS' | 'SUCCESS';
  message: string;
}

export interface BootstrapClaimDoc {
  _id: string;
  claimId: string;
  claimedBy: string;
  state: 'IN_PROGRESS' | 'COMPLETED';
  claimedAt: Date;
  heartbeatAt: Date;
  completedAt?: Date;
  adminUserId?: string;
}

/**
 * Validates that the connected database matches the explicitly allowed staging database.
 * Refuses execution against any other database to prevent unintended modifications.
 */
export function validateDatabaseName(
  actualDbName: string | undefined,
  expectedDbName = DEFAULT_ALLOWED_STAGING_DB,
): void {
  if (!actualDbName) {
    throw new Error('Database connection is not established or database name is unavailable.');
  }
  if (actualDbName !== expectedDbName) {
    throw new Error(
      `Database Protection Guard: Refusing to bootstrap admin. ` +
        `Target database is '${actualDbName}', but this utility is strictly restricted to '${expectedDbName}'.`,
    );
  }
}

/**
 * Atomically acquires a bootstrap claim with explicit ownership.
 *
 * Guarantees:
 * 1. Only one process can acquire the claim.
 * 2. A concurrent process waiting on an in-progress claim polls until completion
 *    and NEVER proceeds to insert merely because an admin is not yet found.
 * 3. A crashed process that died before insert is safely recovered after staleLockTimeoutMs
 *    using an atomic Compare-And-Swap (CAS).
 * 4. Completed claims immediately return ADMIN_ALREADY_EXISTS.
 */
export async function acquireBootstrapClaim(params: {
  email: string;
  claimId: string;
  actualDbName: string;
  staleLockTimeoutMs: number;
  waitTimeoutMs: number;
  pollIntervalMs: number;
  silent?: boolean;
}): Promise<
  | { acquired: true }
  | { acquired: false; reason: 'ADMIN_ALREADY_EXISTS'; message: string }
> {
  const {
    email,
    claimId,
    actualDbName,
    staleLockTimeoutMs,
    waitTimeoutMs,
    pollIntervalMs,
    silent,
  } = params;

  const startTime = Date.now();

  while (true) {
    // 1. Check if an active administrator already exists
    const activeAdmin = await User.findOne({ role: 'ADMIN' }).lean();
    if (activeAdmin && activeAdmin.active !== false) {
      const msg = `An active Administrator already exists in '${actualDbName}' (ID: ${activeAdmin._id}, Email: ${activeAdmin.email}). No action taken.`;
      if (!silent) logger.info(msg);
      return { acquired: false, reason: 'ADMIN_ALREADY_EXISTS', message: msg };
    }

    const now = new Date();

    // 2. Attempt atomic insertion of the claim document
    const claimResult = await Counter.collection.findOneAndUpdate(
      { _id: 'bootstrap_admin_claim' },
      {
        $setOnInsert: {
          claimId,
          claimedBy: email,
          state: 'IN_PROGRESS',
          claimedAt: now,
          heartbeatAt: now,
        },
      },
      { upsert: true, returnDocument: 'before' },
    );

    // If claimResult is null, the document was inserted by this call -> claim acquired!
    if (!claimResult) {
      return { acquired: true };
    }

    const existingClaim = claimResult as unknown as BootstrapClaimDoc;

    // 3. If existing claim is marked COMPLETED, check for admin and exit
    if (existingClaim.state === 'COMPLETED') {
      const admin = await User.findOne({ role: 'ADMIN' }).lean();
      if (admin && admin.active !== false) {
        const msg = `An active Administrator already exists in '${actualDbName}' (ID: ${admin._id}, Email: ${admin.email}). No action taken.`;
        if (!silent) logger.info(msg);
        return { acquired: false, reason: 'ADMIN_ALREADY_EXISTS', message: msg };
      }
    }

    // 4. Existing claim is IN_PROGRESS: Check if it is active or stale
    const lastActiveTime = new Date(existingClaim.heartbeatAt || existingClaim.claimedAt).getTime();
    const ageMs = Date.now() - lastActiveTime;

    if (ageMs < staleLockTimeoutMs) {
      // Active in-progress operation by another process. Wait and poll.
      const elapsed = Date.now() - startTime;
      if (elapsed < waitTimeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      throw new Error(
        `A bootstrap operation by '${existingClaim.claimedBy}' is currently in progress. ` +
          `Refusing concurrent creation. Please retry after the active provisioning finishes.`,
      );
    }

    // 5. Stale claim: Previous process inactive for > staleLockTimeoutMs.
    // Check whether an admin was created before attempting takeover.
    const adminCheck = await User.findOne({ role: 'ADMIN' }).lean();
    if (adminCheck && adminCheck.active !== false) {
      await Counter.collection.updateOne(
        { _id: 'bootstrap_admin_claim' },
        { $set: { state: 'COMPLETED', adminUserId: adminCheck._id, completedAt: new Date() } },
      );
      const msg = `An active Administrator already exists in '${actualDbName}' (ID: ${adminCheck._id}, Email: ${adminCheck.email}). No action taken.`;
      if (!silent) logger.info(msg);
      return { acquired: false, reason: 'ADMIN_ALREADY_EXISTS', message: msg };
    }

    // Safe Stale-Claim Takeover: Atomic CAS on claimId and state
    const takeover = await Counter.collection.findOneAndUpdate(
      {
        _id: 'bootstrap_admin_claim',
        claimId: existingClaim.claimId,
        state: 'IN_PROGRESS',
      },
      {
        $set: {
          claimId,
          claimedBy: email,
          state: 'IN_PROGRESS',
          claimedAt: now,
          heartbeatAt: now,
        },
      },
      { returnDocument: 'after' },
    );

    if (takeover) {
      if (!silent) {
        logger.info(
          `Recovered stale bootstrap claim from '${existingClaim.claimedBy}' (inactive for ${Math.round(ageMs / 1000)}s).`,
        );
      }
      return { acquired: true };
    }

    // If CAS failed, another concurrent process won takeover; retry
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * Validates admin user inputs according to application domain rules.
 */
export function validateAdminInputs(name: string, email: string, password: string): void {
  if (!name || name.trim().length < 2) {
    throw new Error('Administrator name must be at least 2 characters long.');
  }
  if (name.trim().length > 100) {
    throw new Error('Administrator name cannot exceed 100 characters.');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!email || !emailRegex.test(email.trim())) {
    throw new Error('A valid email address is required.');
  }

  if (!password || password.length < 8) {
    throw new Error('Administrator password must be at least 8 characters long.');
  }
  if (password.length > 128) {
    throw new Error('Administrator password cannot exceed 128 characters.');
  }
}

/**
 * Inspects existing user IDs in the database and synchronizes the Counter
 * to ensure sequential allocation does not collide with historical records (e.g. USR-001, USR-002).
 */
export async function syncUserCounterWithExistingRecords(): Promise<number> {
  const users = await User.find({}, '_id').lean();
  let maxSeq = 0;
  for (const u of users) {
    const match = String(u._id).match(/^USR-(\d+)$/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxSeq) maxSeq = num;
    }
  }

  if (maxSeq > 0) {
    await Counter.updateOne(
      { _id: 'user' },
      { $max: { seq: maxSeq } },
      { upsert: true },
    ).exec();
  }

  return maxSeq;
}

/**
 * Prompts for input on stdout.
 */
async function promptText(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Prompts for password with masked terminal echo.
 * Input characters are masked and never echoed to stdout or logged.
 */
async function promptPassword(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const mutableStdout = new Writable({
      write(chunk, encoding, callback) {
        if (!muted) {
          process.stdout.write(chunk, encoding);
        }
        callback();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: mutableStdout,
      terminal: true,
    });

    process.stdout.write(question);
    muted = true;

    rl.question('', (answer) => {
      muted = false;
      process.stdout.write('\n');
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Executes the critical bootstrap operations strictly inside a MongoDB multi-document transaction.
 *
 * Guarantees:
 * 1. Strict Atomicity: Claim validation, existence check, ID allocation, user creation,
 *    and claim finalization succeed or fail as a single atomic unit.
 * 2. Snapshot Isolation: No candidate ADMIN record becomes visible outside the transaction before successful commit.
 * 3. Driver Retries: Automatically handles TransientTransactionError and UnknownTransactionCommitResult
 *    via session.withTransaction().
 * 4. Zero Orphaned Records: If ownership is lost or any operation fails, the transaction is aborted
 *    and the candidate user is completely rolled back by MongoDB (no compensating delete needed).
 */
export async function executeBootstrapTransaction(params: {
  claimId: string;
  name: string;
  email: string;
  passwordHash: string;
  betweenFenceAndInsert?: () => Promise<void>;
  beforeCommit?: (session: mongoose.ClientSession) => Promise<void>;
}): Promise<{ user: any; candidateId: string }> {
  const session = await mongoose.startSession();

  try {
    let resultUser: any;
    let resultCandidateId = '';

    await session.withTransaction(
      async (activeSession) => {
        // 1. Transactional Fencing: Verify we STILL hold the claim inside this transaction
        const fence = await Counter.collection.findOne(
          {
            _id: 'bootstrap_admin_claim',
            claimId: params.claimId,
            state: 'IN_PROGRESS',
          },
          { session: activeSession },
        );

        if (!fence) {
          throw new Error('Bootstrap claim ownership was lost before transaction commit. Aborting.');
        }

        // 2. Transactional Existence Guard: Verify no active admin exists
        const preInsertAdmin = await User.findOne({ role: 'ADMIN' }, null, {
          session: activeSession,
        }).lean();
        if (preInsertAdmin && preInsertAdmin.active !== false) {
          throw new Error('An active Administrator already exists. Aborting.');
        }

        // Deterministic test hook: allows simulating pauses between fence check and User.create
        if (params.betweenFenceAndInsert) {
          await params.betweenFenceAndInsert();
        }

        // 3. Transactional ID Allocation: Allocate sequence atomically within the transaction
        const counterDoc = await Counter.collection.findOneAndUpdate(
          { _id: 'user' },
          { $inc: { seq: 1 } },
          { session: activeSession, returnDocument: 'after', upsert: true },
        );
        const allocatedSeq = (counterDoc as unknown as { seq: number })?.seq ?? 1;
        let candidateId = `USR-${String(allocatedSeq).padStart(3, '0')}`;
        while (await User.exists({ _id: candidateId }).session(activeSession)) {
          const nextDoc = await Counter.collection.findOneAndUpdate(
            { _id: 'user' },
            { $inc: { seq: 1 } },
            { session: activeSession, returnDocument: 'after', upsert: true },
          );
          candidateId = `USR-${String((nextDoc as unknown as { seq: number }).seq).padStart(3, '0')}`;
        }

        // 4. Create the ADMIN account strictly inside the transaction
        const createdUsers = await User.create(
          [
            {
              _id: candidateId,
              name: params.name,
              email: params.email,
              passwordHash: params.passwordHash,
              role: 'ADMIN',
              active: true,
              emailVerified: true,
              emailVerifiedAt: new Date(),
              tokenVersion: 0,
            },
          ],
          { session: activeSession },
        );
        const user = createdUsers[0];

        // Deterministic test hook: allows simulating interruption or abort before commit
        if (params.beforeCommit) {
          await params.beforeCommit(activeSession);
        }

        // 5. Finalize the claim inside the transaction using ownership-aware CAS
        const finalizedClaim = await Counter.collection.findOneAndUpdate(
          {
            _id: 'bootstrap_admin_claim',
            claimId: params.claimId,
            state: 'IN_PROGRESS',
          },
          {
            $set: {
              state: 'COMPLETED',
              adminUserId: user._id,
              completedAt: new Date(),
            },
          },
          { session: activeSession, returnDocument: 'after' },
        );

        if (!finalizedClaim) {
          throw new Error('Bootstrap claim CAS transition failed during transaction. Aborting.');
        }

        resultUser = user;
        resultCandidateId = candidateId;
      },
      {
        readPreference: 'primary',
        readConcern: { level: 'local' },
        writeConcern: { w: 'majority' },
      },
    );

    return { user: resultUser, candidateId: resultCandidateId };
  } finally {
    await session.endSession();
  }
}

/**
 * One-time administrator bootstrap logic.
 *
 * Guarantees:
 * 1. Strictly bound to the authorized staging database name.
 * 2. Never overwrites or promotes existing user accounts.
 * 3. Exits cleanly without changes if an active ADMIN already exists.
 * 4. Allocates collision-free sequential USR-xxx ID.
 * 5. Uses standard bcrypt password hashing.
 * 6. Sets emailVerified=true for administrative provisioning.
 * 7. Never seeds synthetic domain data or mutates unrelated collections.
 */
export async function bootstrapAdmin(
  options: BootstrapAdminOptions = {},
): Promise<BootstrapAdminResult> {
  const actualDbName = mongoose.connection.name || mongoose.connection.db?.databaseName;
  const expectedDbName = options.allowedDatabaseName ?? DEFAULT_ALLOWED_STAGING_DB;

  // 1. Guard target database name
  validateDatabaseName(actualDbName, expectedDbName);

  // 2. Check if an active ADMIN already exists (or an existing admin account in any state)
  const existingAdmin = await User.findOne({ role: 'ADMIN' }).lean();
  if (existingAdmin) {
    if (existingAdmin.active !== false) {
      const msg = `An active Administrator already exists in '${actualDbName}' (ID: ${existingAdmin._id}, Email: ${existingAdmin.email}). No action taken.`;
      if (!options.silent) logger.info(msg);
      return {
        success: false,
        reason: 'ADMIN_ALREADY_EXISTS',
        message: msg,
      };
    }
    throw new Error(
      `An Administrator account already exists in '${actualDbName}' (ID: ${existingAdmin._id}, Email: ${existingAdmin.email}) but is currently inactive. ` +
        `Refusing to bootstrap a duplicate administrator.`,
    );
  }

  // 3. Resolve administrator input credentials
  let name = (options.name ?? process.env.BOOTSTRAP_ADMIN_NAME ?? '').trim();
  let email = (options.email ?? process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  let password = options.password ?? process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';

  if (!name || !email || !password) {
    if (process.stdin.isTTY) {
      if (!name) name = await promptText('Enter Administrator Name: ');
      if (!email) email = (await promptText('Enter Administrator Email: ')).toLowerCase();
      if (!password) password = await promptPassword('Enter Administrator Password (min 8 chars): ');
    } else {
      throw new Error(
        'Missing required admin credentials in non-interactive environment. ' +
          'Provide credentials via options or environment variables ' +
          '(BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD).',
      );
    }
  }

  validateAdminInputs(name, email, password);

  // 4. Verify email is not already registered (refuse to silently promote existing CITIZEN)
  const existingEmailUser = await User.findOne({ email }).lean();
  if (existingEmailUser) {
    throw new Error(
      `An account with email '${email}' already exists with role '${existingEmailUser.role}' (ID: ${existingEmailUser._id}). ` +
        `Refusing to promote or overwrite existing account.`,
    );
  }

  // 5. Atomically acquire bootstrap claim with explicit ownership fencing
  const claimId = randomUUID();
  const claimResult = await acquireBootstrapClaim({
    email,
    claimId,
    actualDbName,
    staleLockTimeoutMs: options.staleLockTimeoutMs ?? DEFAULT_STALE_LOCK_TIMEOUT_MS,
    waitTimeoutMs: options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    silent: options.silent,
  });

  if (!claimResult.acquired) {
    return {
      success: false,
      reason: claimResult.reason,
      message: claimResult.message,
    };
  }

  // Active heartbeat: Continuously refresh heartbeatAt while provisioning is actively working
  let heartbeatTimer: NodeJS.Timeout | null = null;
  if (!options.disableHeartbeat) {
    heartbeatTimer = setInterval(async () => {
      try {
        await Counter.collection.updateOne(
          { _id: 'bootstrap_admin_claim', claimId, state: 'IN_PROGRESS' },
          { $set: { heartbeatAt: new Date() } },
        );
      } catch {
        // Ignore transient heartbeat update failures
      }
    }, 1000);
  }

  try {
    // 6. Synchronize counter baseline before transaction
    await syncUserCounterWithExistingRecords();

    // 7. Hash password with bcrypt before transaction
    const passwordHash = await hashPassword(password);

    // 8. Execute critical creation strictly inside an ACID transaction
    const { user, candidateId } = await executeBootstrapTransaction({
      claimId,
      name,
      email,
      passwordHash,
      betweenFenceAndInsert: options.betweenFenceAndInsert,
      beforeCommit: options.beforeCommit,
    });

    // 9. Record audit log entry in auditlogs collection post-commit.
    // Design Note: Recorded post-commit so that an aborted transaction never produces a
    // phantom 'user.created' audit record. If audit write experiences a transient failure,
    // it is caught and logged; the committed administrator remains valid (availability first).
    try {
      await recordAudit({
        actor: name,
        actorId: user._id,
        actorRole: 'ADMIN',
        action: 'user.created',
        resource: 'User',
        resourceId: user._id,
        requestId: `bootstrap-${randomUUID()}`,
        details: 'Initial staging administrator provisioned via transactional bootstrap utility',
        newState: { id: user._id, email: user.email, role: 'ADMIN' },
      });
    } catch (auditErr) {
      logger.error(
        { err: auditErr, userId: user._id },
        'Warning: Administrator was committed successfully, but audit log write failed.',
      );
    }

    const successMsg = `Administrator '${email}' (${candidateId}) created successfully in database '${actualDbName}'.`;
    if (!options.silent) logger.info(successMsg);

    return {
      success: true,
      reason: 'SUCCESS',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      message: successMsg,
    };
  } catch (err: unknown) {
    // Release claim ONLY if user creation failed, NO admin exists, and WE own the claim
    if (!(await User.exists({ role: 'ADMIN' }))) {
      await Counter.collection.deleteOne({
        _id: 'bootstrap_admin_claim',
        claimId,
        state: 'IN_PROGRESS',
      }).catch(() => {});
    }

    const code = (err as { code?: number })?.code;
    if (code === 11000) {
      const concurrentAdmin = await User.findOne({ role: 'ADMIN' }).lean();
      if (concurrentAdmin && concurrentAdmin.active !== false) {
        return {
          success: false,
          reason: 'ADMIN_ALREADY_EXISTS',
          message: `Administrator was created concurrently by another process (ID: ${concurrentAdmin._id}, Email: ${concurrentAdmin.email}).`,
        };
      }
      throw new Error(
        `Duplicate key conflict during administrator creation: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    throw err;
  } finally {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
    }
  }
}

/** CLI Entrypoint */
async function main(): Promise<void> {
  const isDirectRun = process.argv[1]?.replace(/\\/g, '/').endsWith('bootstrap-admin.ts');
  if (!isDirectRun) return;

  await connectDB();
  try {
    const result = await bootstrapAdmin();
    if (result.success) {
      console.log(`\n✅ ${result.message}`);
      console.log(`   ID:    ${result.user?.id}`);
      console.log(`   Email: ${result.user?.email}`);
      console.log(`   Role:  ${result.user?.role}\n`);
    } else {
      console.log(`\nℹ️  ${result.message}\n`);
    }
  } finally {
    await disconnectDB();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('bootstrap-admin.ts')) {
  main().catch((err) => {
    console.error(`\n❌ Bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
