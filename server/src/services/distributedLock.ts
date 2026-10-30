import { SchedulerLock, type SchedulerLockDoc } from '../models/SchedulerLock.js';
import { Counter } from '../models/Counter.js';
import { logger } from '../config/logger.js';
import { recordSchedulerLockOperation } from '../metrics/index.js';

export interface AcquireLockResult {
  acquired: boolean;
  lockId: string;
  ownerToken?: string;
  fenceToken?: number;
  expiresAt?: Date;
  reason?: 'HELD_BY_OTHER' | 'STORE_ERROR';
}

/**
 * Atomically allocates the next persistent, strictly increasing numeric sequence
 * for a lock key using the Counter model. Handles initial upsert races and errors safely.
 * Never falls back to a timestamp, random, or local value.
 */
export async function allocateNextFenceToken(lockId: string): Promise<number> {
  const counterKey = `scheduler_lock_fence_${lockId}`;
  try {
    const doc = await Counter.findOneAndUpdate(
      { _id: counterKey },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    ).exec();
    if (!doc || typeof doc.seq !== 'number') {
      throw new Error(`Counter allocation returned invalid document for ${counterKey}`);
    }
    return doc.seq;
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 11000) {
      // Concurrent first-time upsert race; document now exists, retry increment
      const retryDoc = await Counter.findOneAndUpdate(
        { _id: counterKey },
        { $inc: { seq: 1 } },
        { new: true },
      ).exec();
      if (retryDoc && typeof retryDoc.seq === 'number') {
        return retryDoc.seq;
      }
    }
    throw err;
  }
}

/**
 * Atomically acquires a bounded distributed lock in MongoDB using atomic operations and fencing tokens.
 *
 * Guarantees:
 * 1. Mutual Exclusion: At most one owner holds an unexpired lock. Unexpired locks cannot be reacquired
 *    by any caller, including the same owner.
 * 2. Monotonic Fencing: Every successful acquisition receives a strictly increasing fenceToken
 *    from the persistent Counter model, surviving document deletion and recreation.
 * 3. Deadlock Freedom: Locks have a bounded lease (`leaseMs`). Expired locks are atomically reclaimable.
 * 4. Fault Tolerance: Database errors fail safely without throwing unhandled exceptions.
 */
export async function acquireSchedulerLock(
  lockId: string,
  ownerToken: string,
  leaseMs: number = 60_000,
): Promise<AcquireLockResult> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + leaseMs);

  try {
    // 1. Check if the lock document already exists and is currently unexpired.
    // An unexpired lock cannot be reacquired by any caller, including the same owner.
    const existing = await SchedulerLock.findById(lockId).lean();
    if (existing && existing.expiresAt && existing.expiresAt.getTime() > now.getTime()) {
      recordSchedulerLockOperation(lockId, 'acquire', 'held_by_other');
      return { acquired: false, lockId, reason: 'HELD_BY_OTHER' };
    }

    // 2. The lock is either absent or expired. Allocate the next persistent monotonic fencing token.
    const fenceToken = await allocateNextFenceToken(lockId);

    // 3. If an expired lock document exists, attempt atomic conditional takeover.
    // Strictly requires expiresAt <= now (never matches unexpired lock).
    if (existing) {
      const updated = await SchedulerLock.findOneAndUpdate(
        {
          _id: lockId,
          expiresAt: { $lte: now },
        },
        {
          $set: {
            owner: ownerToken,
            fenceToken,
            acquiredAt: now,
            renewedAt: now,
            expiresAt,
          },
        },
        { new: true },
      ).lean();

      if (updated) {
        recordSchedulerLockOperation(lockId, 'acquire', 'acquired');
        return {
          acquired: true,
          lockId,
          ownerToken: updated.owner,
          fenceToken: updated.fenceToken,
          expiresAt: updated.expiresAt,
        };
      }

      // Another worker concurrently claimed the expired lock
      recordSchedulerLockOperation(lockId, 'acquire', 'held_by_other');
      return { acquired: false, lockId, reason: 'HELD_BY_OTHER' };
    }

    // 4. If no document existed, attempt atomic initial insertion.
    try {
      const created = await SchedulerLock.create({
        _id: lockId,
        owner: ownerToken,
        fenceToken,
        acquiredAt: now,
        renewedAt: now,
        expiresAt,
      });
      recordSchedulerLockOperation(lockId, 'acquire', 'acquired');
      return {
        acquired: true,
        lockId,
        ownerToken: created.owner,
        fenceToken: created.fenceToken,
        expiresAt: created.expiresAt,
      };
    } catch (createErr: unknown) {
      if ((createErr as { code?: number }).code === 11000) {
        // Document was created concurrently by another instance
        recordSchedulerLockOperation(lockId, 'acquire', 'held_by_other');
        return { acquired: false, lockId, reason: 'HELD_BY_OTHER' };
      }
      throw createErr;
    }
  } catch (err) {
    logger.warn({ err, lockId }, 'Failed to acquire scheduler distributed lock; failing safely');
    recordSchedulerLockOperation(lockId, 'acquire', 'store_error');
    return { acquired: false, lockId, reason: 'STORE_ERROR' };
  }
}

/**
 * Conditionally renews an existing lock lease if still owned by the caller and not superseded.
 * Returns false if the lease has expired, another instance acquired it, or a store error occurs.
 */
export async function renewSchedulerLock(
  lockId: string,
  ownerToken: string,
  fenceToken: number,
  extensionMs: number = 60_000,
): Promise<boolean> {
  const now = new Date();
  const newExpiresAt = new Date(now.getTime() + extensionMs);

  try {
    const renewed = await SchedulerLock.findOneAndUpdate(
      {
        _id: lockId,
        owner: ownerToken,
        fenceToken,
        expiresAt: { $gt: now }, // Can only renew while lease is currently valid
      },
      {
        $set: {
          renewedAt: now,
          expiresAt: newExpiresAt,
        },
      },
      { new: true },
    ).lean();

    const ok = renewed !== null;
    recordSchedulerLockOperation(lockId, 'renew', ok ? 'renewed' : 'renew_failed');
    return ok;
  } catch (err) {
    logger.warn({ err, lockId, ownerToken }, 'Failed to renew scheduler lock');
    recordSchedulerLockOperation(lockId, 'renew', 'renew_failed');
    return false;
  }
}

/**
 * Safely releases a held lock using owner token and fence token validation.
 * Sets expiresAt to epoch (Date(0)) rather than deleting the document, ensuring:
 * 1. The monotonic fenceToken is strictly preserved across cycles.
 * 2. A stale owner whose lease expired and was re-acquired by a newer instance CANNOT
 *    release or overwrite the newer owner's lock.
 */
export async function releaseSchedulerLock(
  lockId: string,
  ownerToken: string,
  fenceToken: number,
): Promise<boolean> {
  try {
    const result = await SchedulerLock.updateOne(
      {
        _id: lockId,
        owner: ownerToken,
        fenceToken,
        expiresAt: { $gt: new Date(0) },
      },
      {
        $set: {
          expiresAt: new Date(0),
        },
      },
    ).exec();

    const ok = (result.modifiedCount ?? 0) > 0;
    recordSchedulerLockOperation(lockId, 'release', ok ? 'released' : 'release_failed');
    return ok;
  } catch (err) {
    logger.warn({ err, lockId, ownerToken }, 'Failed to release scheduler lock');
    recordSchedulerLockOperation(lockId, 'release', 'release_failed');
    return false;
  }
}


/** Reads the current lock state without mutating it (used in testing and diagnostics). */
export async function getSchedulerLock(lockId: string): Promise<SchedulerLockDoc | null> {
  return SchedulerLock.findById(lockId).lean();
}

/** Returns true if the specified lock is currently held by an unexpired lease. */
export async function isSchedulerLockHeld(lockId: string): Promise<boolean> {
  const lock = await getSchedulerLock(lockId);
  return Boolean(lock && lock.expiresAt && lock.expiresAt.getTime() > Date.now());
}

/**
 * Prefix used for emergency dispatch locks.
 */
export const DISPATCH_LOCK_PREFIX = 'dispatch_emergency_';

/** Formats a standardized lock ID for an emergency dispatch lock. */
export function formatDispatchLockId(emergencyId: string): string {
  return `${DISPATCH_LOCK_PREFIX}${emergencyId}`;
}

/**
 * Atomically acquires a bounded distributed lock for dispatching an emergency.
 * Ensures mutual exclusion across workers competing to dispatch the same emergency.
 */
export async function acquireDispatchLock(
  emergencyId: string,
  ownerToken: string,
  leaseMs: number = 30_000,
): Promise<AcquireLockResult> {
  const lockId = formatDispatchLockId(emergencyId);
  return acquireSchedulerLock(lockId, ownerToken, leaseMs);
}

/**
 * Safely releases an emergency dispatch lock using ownerToken and fenceToken validation.
 */
export async function releaseDispatchLock(
  emergencyId: string,
  ownerToken: string,
  fenceToken: number,
): Promise<boolean> {
  const lockId = formatDispatchLockId(emergencyId);
  return releaseSchedulerLock(lockId, ownerToken, fenceToken);
}

