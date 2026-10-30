import { describe, expect, it, vi } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, AuditLog, Emergency, SchedulerLock } from '../src/models/index.js';
import {
  reconcileStrandedAmbulances,
  runReconciliationSweep,
  DEFAULT_IN_FLIGHT_ASSIGNMENT_GRACE_MS,
} from '../src/services/emergencyService.js';
import {
  acquireDispatchLock,
  releaseDispatchLock,
  formatDispatchLockId,
  getSchedulerLock,
  isSchedulerLockHeld,
} from '../src/services/distributedLock.js';

useTestDatabase(runSeed);

describe('Phase 2 Gate 1 - Recovery & Locking Verification', () => {
  // Helper to create a test emergency
  async function createTestEmergency(id: string, overrides: Partial<Record<string, unknown>> = {}) {
    return Emergency.create({
      _id: id,
      status: 'REPORTED',
      priority: 'HIGH',
      incidentType: 'VEHICLE_COLLISION',
      location: { lat: 28.6139, lng: 77.209, address: 'Test Location' },
      source: 'DISPATCHER',
      description: 'Test emergency for Gate 1 reconciliation',
      victimCount: 1,
      reportedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    });
  }

  // Helper to ensure an ambulance exists with defined status and references
  async function ensureAmbulance(
    ambulanceId: string,
    overrides: {
      status?: string;
      currentEmergency?: string | null;
      lastUpdated?: Date;
    } = {},
  ) {
    return Ambulance.findOneAndUpdate(
      { _id: ambulanceId },
      {
        $set: {
          status: overrides.status ?? 'AVAILABLE',
          currentEmergency: overrides.currentEmergency ?? null,
          lastUpdated: overrides.lastUpdated ?? new Date(),
          location: { lat: 28.62, lng: 77.215 },
          capabilities: ['Basic', 'Trauma'],
          active: true,
        },
      },
      { upsert: true, new: true },
    );
  }

  describe('1. Interrupted Assignment Crash Recovery & In-Flight Protection', () => {
    it('protects legitimate in-flight assignment from premature release within grace period', async () => {
      const emgId = 'EMG-70001';
      const ambId = 'AMB-7001';
      await createTestEmergency(emgId, { assignedAmbulance: null });

      // Simulate recent claim (3 seconds old) with default 10s grace period
      const recentClaimTime = new Date(Date.now() - 3_000);
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgId,
        lastUpdated: recentClaimTime,
      });

      // Run reconciliation with default 10s grace period
      const result = await reconcileStrandedAmbulances();

      // Ambulance should NOT be released because it is within grace period
      expect(result.released).not.toContain(ambId);
      expect(result.skippedActive).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('ASSIGNED');
      expect(ambAfter?.currentEmergency).toBe(emgId);
    });

    it('safely recovers and releases stranded ambulance after grace period expires', async () => {
      const emgId = 'EMG-70002';
      const ambId = 'AMB-7002';
      await createTestEmergency(emgId, { assignedAmbulance: null });

      // Simulate interrupted claim (30 seconds old, well past 10s grace period)
      const expiredClaimTime = new Date(Date.now() - 30_000);
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgId,
        lastUpdated: expiredClaimTime,
      });

      const result = await reconcileStrandedAmbulances();

      // Ambulance was unlinked and past grace period -> released!
      expect(result.released).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('AVAILABLE');
      expect(ambAfter?.currentEmergency).toBeNull();

      // Verify audit trail recorded reconciliation
      const audit = await AuditLog.findOne({
        resourceId: ambId,
        action: 'reconciliation.ambulance_released',
      }).sort({ timestamp: -1 });
      expect(audit).toBeDefined();
      expect(audit?.details).toContain('Reconciled stranded unlinked ambulance');
    });

    it('custom gracePeriodMs option is respected by reconciliation', async () => {
      const emgId = 'EMG-70003';
      const ambId = 'AMB-7003';
      await createTestEmergency(emgId, { assignedAmbulance: null });

      // Claim is 2 seconds old
      const claimTime = new Date(Date.now() - 2_000);
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgId,
        lastUpdated: claimTime,
      });

      // When gracePeriodMs is 5s: preserved
      const res1 = await reconcileStrandedAmbulances({ gracePeriodMs: 5_000 });
      expect(res1.released).not.toContain(ambId);

      // When gracePeriodMs is 1s: released
      const res2 = await reconcileStrandedAmbulances({ gracePeriodMs: 1_000 });
      expect(res2.released).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('AVAILABLE');
    });
  });

  describe('2. Emergency State Discrepancy Recovery', () => {
    it('recovers ambulance linked to missing emergency', async () => {
      const ambId = 'AMB-7004';
      await Emergency.deleteOne({ _id: 'EMG-NONEXISTENT' });

      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: 'EMG-NONEXISTENT',
      });

      const result = await reconcileStrandedAmbulances();
      expect(result.released).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('AVAILABLE');
      expect(ambAfter?.currentEmergency).toBeNull();
    });

    it('recovers ambulance linked to terminal emergency (COMPLETED or CANCELLED)', async () => {
      const emgCompleted = 'EMG-70005';
      const ambCompleted = 'AMB-7005';
      await createTestEmergency(emgCompleted, { status: 'COMPLETED', assignedAmbulance: ambCompleted });
      await ensureAmbulance(ambCompleted, { status: 'ASSIGNED', currentEmergency: emgCompleted });

      const emgCancelled = 'EMG-70006';
      const ambCancelled = 'AMB-7006';
      await createTestEmergency(emgCancelled, { status: 'CANCELLED', assignedAmbulance: ambCancelled });
      await ensureAmbulance(ambCancelled, { status: 'ASSIGNED', currentEmergency: emgCancelled });

      const result = await reconcileStrandedAmbulances();
      expect(result.released).toContain(ambCompleted);
      expect(result.released).toContain(ambCancelled);

      const ambA = await Ambulance.findById(ambCompleted).lean();
      const ambB = await Ambulance.findById(ambCancelled).lean();
      expect(ambA?.status).toBe('AVAILABLE');
      expect(ambB?.status).toBe('AVAILABLE');
    });

    it('recovers displaced ambulance whose emergency was reassigned to another unit', async () => {
      const emgId = 'EMG-70007';
      const ambOld = 'AMB-7007-OLD';
      const ambNew = 'AMB-7007-NEW';

      // Emergency currently points to ambNew
      await createTestEmergency(emgId, { status: 'AMBULANCE_ASSIGNED', assignedAmbulance: ambNew });
      await ensureAmbulance(ambNew, { status: 'ASSIGNED', currentEmergency: emgId });

      // ambOld still points to emgId (displaced)
      await ensureAmbulance(ambOld, { status: 'ASSIGNED', currentEmergency: emgId });

      const result = await reconcileStrandedAmbulances();
      expect(result.released).toContain(ambOld);
      expect(result.released).not.toContain(ambNew);
      expect(result.skippedActive).toContain(ambNew);

      const ambOldAfter = await Ambulance.findById(ambOld).lean();
      const ambNewAfter = await Ambulance.findById(ambNew).lean();
      expect(ambOldAfter?.status).toBe('AVAILABLE');
      expect(ambNewAfter?.status).toBe('ASSIGNED');
    });

    it('preserves legitimate active assignment matching emergency', async () => {
      const emgId = 'EMG-70008';
      const ambId = 'AMB-7008';

      await createTestEmergency(emgId, {
        status: 'EN_ROUTE',
        assignedAmbulance: ambId,
      });
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgId,
      });

      const result = await reconcileStrandedAmbulances();
      expect(result.released).not.toContain(ambId);
      expect(result.skippedActive).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('ASSIGNED');
      expect(ambAfter?.currentEmergency).toBe(emgId);
    });
  });

  describe('3. Reconciliation Idempotency & CAS Concurrency Safety', () => {
    it('repeated reconciliation sweeps are idempotent', async () => {
      const ambId = 'AMB-7009';
      await ensureAmbulance(ambId, { status: 'ASSIGNED', currentEmergency: 'EMG-NONEXISTENT' });

      const sweep1 = await reconcileStrandedAmbulances();
      expect(sweep1.released).toContain(ambId);

      // Second sweep on now-available unit should find nothing to release
      const sweep2 = await reconcileStrandedAmbulances();
      expect(sweep2.released).not.toContain(ambId);
    });

    it('preserves concurrent assignment if ambulance was legitimately assigned to another active emergency', async () => {
      const emgId = 'EMG-70010';
      const ambId = 'AMB-7010';
      await createTestEmergency(emgId, { assignedAmbulance: null });

      const emgConcurrent = 'EMG-70010-CONC';
      await createTestEmergency(emgConcurrent, { status: 'AMBULANCE_ASSIGNED', assignedAmbulance: ambId });

      // Ambulance was claimed by emgConcurrent with fresh lastUpdated
      const newTime = new Date();
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgConcurrent,
        lastUpdated: newTime,
      });

      const result = await reconcileStrandedAmbulances();
      expect(result.released).not.toContain(ambId);
      expect(result.skippedActive).toContain(ambId);

      const ambAfter = await Ambulance.findById(ambId).lean();
      expect(ambAfter?.status).toBe('ASSIGNED');
      expect(ambAfter?.currentEmergency).toBe(emgConcurrent);
    });

    it('CAS update fails safely and records no-op when ambulance lastUpdated changed concurrently', async () => {
      const emgId = 'EMG-70011';
      const ambId = 'AMB-7011';
      await createTestEmergency(emgId, { assignedAmbulance: null });

      const staleTime = new Date(Date.now() - 30_000);
      await ensureAmbulance(ambId, {
        status: 'ASSIGNED',
        currentEmergency: emgId,
        lastUpdated: staleTime,
      });

      // Hook Ambulance.updateOne once to simulate concurrent mutation before CAS execution
      const originalUpdateOne = Ambulance.updateOne.bind(Ambulance);
      let simulated = false;
      const spy = vi.spyOn(Ambulance, 'updateOne').mockImplementation(async function (filter: any, update: any, options: any) {
        if (!simulated && filter?._id === ambId && filter?.lastUpdated) {
          simulated = true;
          // Concurrently update the ambulance in the DB before the CAS query runs
          await originalUpdateOne(
            { _id: ambId },
            { $set: { lastUpdated: new Date() } },
          );
        }
        return originalUpdateOne(filter, update, options);
      });

      const result = await reconcileStrandedAmbulances();
      spy.mockRestore();

      // Because lastUpdated changed in DB, CAS filter matched 0 documents -> not released
      expect(result.released).not.toContain(ambId);
    });
  });

  describe('4. Dispatch Lock Behavior & Mutual Exclusion', () => {
    const testEmergencyId = 'EMG-LOCK-001';
    const lockId = formatDispatchLockId(testEmergencyId);

    it('acquires dispatch lock with monotonic fencing token', async () => {
      await SchedulerLock.deleteOne({ _id: lockId });

      const acq1 = await acquireDispatchLock(testEmergencyId, 'worker-dispatch-1', 10_000);
      expect(acq1.acquired).toBe(true);
      expect(acq1.ownerToken).toBe('worker-dispatch-1');
      expect(typeof acq1.fenceToken).toBe('number');
      expect(acq1.fenceToken).toBeGreaterThan(0);

      // Verify DB lock state
      const isHeld = await isSchedulerLockHeld(lockId);
      expect(isHeld).toBe(true);

      await releaseDispatchLock(testEmergencyId, 'worker-dispatch-1', acq1.fenceToken!);
    });

    it('rejects concurrent acquisition on the same emergency with HELD_BY_OTHER', async () => {
      await SchedulerLock.deleteOne({ _id: lockId });

      const acqA = await acquireDispatchLock(testEmergencyId, 'worker-alpha', 30_000);
      expect(acqA.acquired).toBe(true);

      const acqB = await acquireDispatchLock(testEmergencyId, 'worker-beta', 30_000);
      expect(acqB.acquired).toBe(false);
      expect(acqB.reason).toBe('HELD_BY_OTHER');

      // Cleanup
      await releaseDispatchLock(testEmergencyId, 'worker-alpha', acqA.fenceToken!);
    });

    it('two workers racing to acquire dispatch lock simultaneously: exactly one wins', async () => {
      await SchedulerLock.deleteOne({ _id: lockId });

      const [res1, res2] = await Promise.all([
        acquireDispatchLock(testEmergencyId, 'racer-1', 30_000),
        acquireDispatchLock(testEmergencyId, 'racer-2', 30_000),
      ]);

      const winners = [res1, res2].filter((r) => r.acquired);
      const losers = [res1, res2].filter((r) => !r.acquired);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(losers[0].reason).toBe('HELD_BY_OTHER');

      const winningWorker = winners[0];
      await releaseDispatchLock(testEmergencyId, winningWorker.ownerToken!, winningWorker.fenceToken!);
    });

    it('releases lock cleanly and allows subsequent acquisition with higher fencing token', async () => {
      await SchedulerLock.deleteOne({ _id: lockId });

      const acq1 = await acquireDispatchLock(testEmergencyId, 'worker-first', 30_000);
      expect(acq1.acquired).toBe(true);
      const fence1 = acq1.fenceToken!;

      const released = await releaseDispatchLock(testEmergencyId, 'worker-first', fence1);
      expect(released).toBe(true);

      const isHeldAfterRelease = await isSchedulerLockHeld(lockId);
      expect(isHeldAfterRelease).toBe(false);

      // Second worker acquires after release
      const acq2 = await acquireDispatchLock(testEmergencyId, 'worker-second', 30_000);
      expect(acq2.acquired).toBe(true);
      const fence2 = acq2.fenceToken!;

      // Monotonic fencing guarantee
      expect(fence2).toBeGreaterThan(fence1);

      await releaseDispatchLock(testEmergencyId, 'worker-second', fence2);
    });

    it('expired dispatch lock is reclaimable by a new worker; expired owner cannot release it', async () => {
      await SchedulerLock.deleteOne({ _id: lockId });

      // Worker 1 acquires lock with short 100ms lease
      const acqOld = await acquireDispatchLock(testEmergencyId, 'worker-old', 100);
      expect(acqOld.acquired).toBe(true);

      // Wait 150ms for lease expiry
      await new Promise((r) => setTimeout(r, 150));

      // Worker 2 takes over the expired lock
      const acqNew = await acquireDispatchLock(testEmergencyId, 'worker-new', 30_000);
      expect(acqNew.acquired).toBe(true);
      expect(acqNew.ownerToken).toBe('worker-new');
      expect(acqNew.fenceToken!).toBeGreaterThan(acqOld.fenceToken!);

      // Old worker attempts late release using expired ownerToken and old fenceToken
      const lateReleaseSuccess = await releaseDispatchLock(
        testEmergencyId,
        'worker-old',
        acqOld.fenceToken!,
      );
      // Late release must fail and not disturb the new owner
      expect(lateReleaseSuccess).toBe(false);

      const currentLock = await getSchedulerLock(lockId);
      expect(currentLock?.owner).toBe('worker-new');
      expect(currentLock?.fenceToken).toBe(acqNew.fenceToken);

      // Clean release by new owner
      await releaseDispatchLock(testEmergencyId, 'worker-new', acqNew.fenceToken!);
    });
  });
});
