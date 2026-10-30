import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/db/connection.js';
import { Ambulance, Emergency } from '../src/models/index.js';
import {
  acquireSchedulerLock,
  releaseSchedulerLock,
} from '../src/services/distributedLock.js';
import {
  runReconciliationSweep,
} from '../src/services/emergencyService.js';
import {
  resetOperationalMetrics,
  getReconciliationSweepCount,
  getSchedulerLockOperationCount,
  getFleetRecoveryOutcomeCount,
  getFleetCasNoOpCount,
  recordReconciliationSweep,
  recordSchedulerLockOperation,
  recordFleetRecoveryOutcome,
  recordFleetCasNoOp,
  reconciliationSweepsCounter,
} from '../src/metrics/index.js';


describe('Phase 4.3.3: Reconciliation & Operational Metrics (Mocked Unit Tests)', () => {
  beforeEach(() => {
    resetOperationalMetrics();
  });

  afterEach(() => {
    resetOperationalMetrics();
    vi.restoreAllMocks();
  });

  describe('1. Reconciliation Sweeps Counter & Histogram', () => {
    it('records reconciliation sweep status counts and duration observations', async () => {
      recordReconciliationSweep('success', 0.125);
      recordReconciliationSweep('success', 0.250);
      recordReconciliationSweep('failure', 0.500);
      recordReconciliationSweep('skipped_locked');

      expect(await getReconciliationSweepCount('success')).toBe(2);
      expect(await getReconciliationSweepCount('failure')).toBe(1);
      expect(await getReconciliationSweepCount('skipped_locked')).toBe(1);
    });

    it('rejects unapproved reconciliation sweep status labels', async () => {
      // @ts-expect-error testing unapproved label
      recordReconciliationSweep('unapproved_status');
      // @ts-expect-error testing retrieval
      expect(await getReconciliationSweepCount('unapproved_status')).toBe(0);
    });

    it('recording error does not throw or corrupt application flow', async () => {
      vi.spyOn(reconciliationSweepsCounter, 'inc').mockImplementationOnce(() => {
        throw new Error('Prometheus counter error');
      });

      // Should not throw
      expect(() => recordReconciliationSweep('success')).not.toThrow();
    });
  });

  describe('2. Distributed Scheduler Lock Metrics', () => {
    it('records lock acquisition, renewal, and release operations', async () => {
      recordSchedulerLockOperation('ambulance_reconciliation', 'acquire', 'acquired');
      recordSchedulerLockOperation('ambulance_reconciliation', 'acquire', 'held_by_other');
      recordSchedulerLockOperation('ambulance_reconciliation', 'renew', 'renewed');
      recordSchedulerLockOperation('ambulance_reconciliation', 'renew', 'renew_failed');
      recordSchedulerLockOperation('ambulance_reconciliation', 'release', 'released');
      recordSchedulerLockOperation('ambulance_reconciliation', 'release', 'release_failed');

      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'acquire', 'acquired'),
      ).toBe(1);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'acquire', 'held_by_other'),
      ).toBe(1);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'renew', 'renewed'),
      ).toBe(1);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'renew', 'renew_failed'),
      ).toBe(1);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'release', 'released'),
      ).toBe(1);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'release', 'release_failed'),
      ).toBe(1);
    });
  });

  describe('3. Fleet Recovery Outcomes & CAS No-Op Metrics', () => {
    it('records fleet recovery outcomes with bounded reasons and outcomes', async () => {
      recordFleetRecoveryOutcome('missing_emergency', 'released');
      recordFleetRecoveryOutcome('terminal_emergency', 'released');
      recordFleetRecoveryOutcome('displaced', 'skipped');
      recordFleetRecoveryOutcome('null_reference', 'released');

      expect(await getFleetRecoveryOutcomeCount('missing_emergency', 'released')).toBe(1);
      expect(await getFleetRecoveryOutcomeCount('terminal_emergency', 'released')).toBe(1);
      expect(await getFleetRecoveryOutcomeCount('displaced', 'skipped')).toBe(1);
      expect(await getFleetRecoveryOutcomeCount('null_reference', 'released')).toBe(1);
    });

    it('records compare-and-swap no-op events', async () => {
      recordFleetCasNoOp('ambulance');
      recordFleetCasNoOp('emergency');
      recordFleetCasNoOp('ambulance');

      expect(await getFleetCasNoOpCount('ambulance')).toBe(2);
      expect(await getFleetCasNoOpCount('emergency')).toBe(1);
    });

    it('resets all operational metrics cleanly for test isolation', async () => {
      recordReconciliationSweep('success');
      recordSchedulerLockOperation('ambulance_reconciliation', 'acquire', 'acquired');
      recordFleetRecoveryOutcome('missing_emergency', 'released');
      recordFleetCasNoOp('ambulance');

      resetOperationalMetrics();

      expect(await getReconciliationSweepCount('success')).toBe(0);
      expect(
        await getSchedulerLockOperationCount('ambulance_reconciliation', 'acquire', 'acquired'),
      ).toBe(0);
      expect(await getFleetRecoveryOutcomeCount('missing_emergency', 'released')).toBe(0);
      expect(await getFleetCasNoOpCount('ambulance')).toBe(0);
    });
  });
});

describe('Phase 4.3.3: Reconciliation & Operational Metrics (Real MongoDB Integration Tests)', () => {
  const testPrefix = `test_p433_${Date.now()}`;

  beforeEach(async () => {
    resetOperationalMetrics();
    if (mongoose.connection.readyState === 0) {
      await connectDB(env.MONGODB_URI);
    }
  });

  afterEach(async () => {
    resetOperationalMetrics();
    if (mongoose.connection.readyState !== 0) {
      await Ambulance.deleteMany({ _id: new RegExp(`^${testPrefix}`) });
      await Emergency.deleteMany({ _id: new RegExp(`^${testPrefix}`) });
    }
  });

  it('updates scheduler lock and reconciliation sweep metrics during real execution', async () => {
    const lockId = `${testPrefix}_lock`;
    const ownerToken = 'worker-test-1';

    // 1. Acquire lock
    const lockResult = await acquireSchedulerLock(lockId, ownerToken, 30_000);
    expect(lockResult.acquired).toBe(true);

    const acquiredCount = await getSchedulerLockOperationCount(
      'ambulance_reconciliation',
      'acquire',
      'acquired',
    );
    expect(acquiredCount).toBeGreaterThanOrEqual(1);

    // 2. Competing worker fails acquisition
    const competingResult = await acquireSchedulerLock(lockId, 'worker-test-2', 30_000);
    expect(competingResult.acquired).toBe(false);
    expect(competingResult.reason).toBe('HELD_BY_OTHER');

    const heldCount = await getSchedulerLockOperationCount(
      'ambulance_reconciliation',
      'acquire',
      'held_by_other',
    );
    expect(heldCount).toBeGreaterThanOrEqual(1);

    // 3. Release lock
    if (lockResult.fenceToken !== undefined) {
      const released = await releaseSchedulerLock(lockId, ownerToken, lockResult.fenceToken);
      expect(released).toBe(true);
      const releaseCount = await getSchedulerLockOperationCount(
        'ambulance_reconciliation',
        'release',
        'released',
      );
      expect(releaseCount).toBeGreaterThanOrEqual(1);
    }

    // 4. Run real reconciliation sweep and verify sweep metric updated
    const sweepResult = await runReconciliationSweep({ useLock: false });
    expect(sweepResult).toBeDefined();

    const sweepSuccessCount = await getReconciliationSweepCount('success');
    expect(sweepSuccessCount).toBeGreaterThanOrEqual(1);
  });
});
