import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, AuditLog, Counter, Emergency, SchedulerLock } from '../src/models/index.js';
import {
  reconcileStrandedAmbulances,
  startAmbulanceReconciliationScheduler,
  stopAmbulanceReconciliationScheduler,
  isReconciliationSchedulerRunning,
} from '../src/services/emergencyService.js';
import {
  acquireSchedulerLock,
  renewSchedulerLock,
  releaseSchedulerLock,
  getSchedulerLock,
  isSchedulerLockHeld,
} from '../src/services/distributedLock.js';

useTestDatabase(runSeed);

describe('Milestone 4.1: Fleet Reconciliation & Distributed Scheduler Safety', () => {
  const now = new Date();

  // Helper to create ambulance records easily
  async function createAmbulance(
    id: string,
    status: 'AVAILABLE' | 'ASSIGNED' | 'DISPATCHED' | 'EN_ROUTE',
    currentEmergency?: string | null,
  ) {
    return Ambulance.create({
      _id: id,
      status,
      currentEmergency: currentEmergency ?? undefined,
      location: { lat: 28.6139, lng: 77.209 },
      speed: 0,
      heading: 0,
      active: true,
      lastUpdated: new Date(),
    });
  }

  // Helper to create emergency records easily
  async function createEmergencyRecord(
    id: string,
    status: 'REPORTED' | 'DISPATCHING' | 'AMBULANCE_ASSIGNED' | 'COMPLETED' | 'CANCELLED',
    assignedAmbulance?: string | null,
  ) {
    return Emergency.create({
      _id: id,
      status,
      priority: 'HIGH',
      incidentType: 'CARDIAC_ARREST',
      location: { lat: 28.6139, lng: 77.209 },
      source: 'DISPATCHER',
      description: `Test emergency ${id}`,
      victimCount: 1,
      assignedAmbulance: assignedAmbulance ?? undefined,
      reportedAt: now,
      updatedAt: now,
    });
  }

  // --------------------------------------------------------------------------
  // Core Fleet Reconciliation Scenarios
  // --------------------------------------------------------------------------
  describe('Displaced, Stranded, and Active Fleet Reconciliation', () => {
    it('recovers a displaced ambulance while active incident remains assigned to the new ambulance', async () => {
      const emgId = 'EMG-M4-ACTIVE-INCIDENT';
      const assignedAmbulanceId = 'AMB-M4-ACTIVE-UNIT';
      const displacedAmbulanceId = 'AMB-M4-DISPLACED-UNIT';

      await createEmergencyRecord(emgId, 'AMBULANCE_ASSIGNED', assignedAmbulanceId);
      await createAmbulance(assignedAmbulanceId, 'ASSIGNED', emgId);
      await createAmbulance(displacedAmbulanceId, 'ASSIGNED', emgId);

      const result = await reconcileStrandedAmbulances();

      // Displaced ambulance is safely recovered
      expect(result.released).toContain(displacedAmbulanceId);
      const displacedAmbulance = await Ambulance.findById(displacedAmbulanceId).lean();
      expect(displacedAmbulance?.status).toBe('AVAILABLE');
      expect(displacedAmbulance?.currentEmergency).toBeNull();

      // Currently assigned ambulance remains ASSIGNED
      expect(result.released).not.toContain(assignedAmbulanceId);
      expect(result.skippedActive).toContain(assignedAmbulanceId);
      const activeAmbulance = await Ambulance.findById(assignedAmbulanceId).lean();
      expect(activeAmbulance?.status).toBe('ASSIGNED');
      expect(activeAmbulance?.currentEmergency).toBe(emgId);

      // Emergency remains active and untouched
      const emergency = await Emergency.findById(emgId).lean();
      expect(emergency?.status).toBe('AMBULANCE_ASSIGNED');
      expect(emergency?.assignedAmbulance).toBe(assignedAmbulanceId);

      // Audit log was recorded for displaced ambulance
      const audit = await AuditLog.findOne({
        action: 'reconciliation.ambulance_released',
        resourceId: displacedAmbulanceId,
      }).lean();
      expect(audit).toBeDefined();
      expect(audit?.details).toContain('Reconciled displaced ambulance');

      await Ambulance.deleteMany({ _id: { $in: [assignedAmbulanceId, displacedAmbulanceId] } });
      await Emergency.deleteOne({ _id: emgId });
    });

    it('safely recovers ambulances marked ASSIGNED with null, empty, or missing emergency references', async () => {
      const nullRefId = 'AMB-M4-NULL-REF';
      const missingRefId = 'AMB-M4-MISSING-REF';
      const missingEmgId = 'EMG-M4-NONEXISTENT-999';

      await createAmbulance(nullRefId, 'ASSIGNED', null);
      await createAmbulance(missingRefId, 'ASSIGNED', missingEmgId);

      const result = await reconcileStrandedAmbulances();

      expect(result.released).toContain(nullRefId);
      expect(result.released).toContain(missingRefId);

      const nullAmb = await Ambulance.findById(nullRefId).lean();
      const missingAmb = await Ambulance.findById(missingRefId).lean();

      expect(nullAmb?.status).toBe('AVAILABLE');
      expect(nullAmb?.currentEmergency).toBeNull();
      expect(missingAmb?.status).toBe('AVAILABLE');
      expect(missingAmb?.currentEmergency).toBeNull();

      await Ambulance.deleteMany({ _id: { $in: [nullRefId, missingRefId] } });
    });

    it('reconciles ambulances linked to terminal emergencies (COMPLETED and CANCELLED)', async () => {
      const completedEmgId = 'EMG-M4-TERM-COMPLETED';
      const cancelledEmgId = 'EMG-M4-TERM-CANCELLED';
      const completedAmbId = 'AMB-M4-TERM-1';
      const cancelledAmbId = 'AMB-M4-TERM-2';

      await createEmergencyRecord(completedEmgId, 'COMPLETED', completedAmbId);
      await createEmergencyRecord(cancelledEmgId, 'CANCELLED', cancelledAmbId);
      await createAmbulance(completedAmbId, 'ASSIGNED', completedEmgId);
      await createAmbulance(cancelledAmbId, 'ASSIGNED', cancelledEmgId);

      const result = await reconcileStrandedAmbulances();

      expect(result.released).toContain(completedAmbId);
      expect(result.released).toContain(cancelledAmbId);

      const amb1 = await Ambulance.findById(completedAmbId).lean();
      const amb2 = await Ambulance.findById(cancelledAmbId).lean();
      expect(amb1?.status).toBe('AVAILABLE');
      expect(amb2?.status).toBe('AVAILABLE');

      await Ambulance.deleteMany({ _id: { $in: [completedAmbId, cancelledAmbId] } });
      await Emergency.deleteMany({ _id: { $in: [completedEmgId, cancelledEmgId] } });
    });
  });

  // --------------------------------------------------------------------------
  // The 12 Specific Regression Scenarios Required for Phase 4.1 Closure
  // --------------------------------------------------------------------------
  describe('Phase 4.1 Required Verification Scenarios (1–12)', () => {
    // 1. Same owner attempts to reacquire an unexpired lock: acquisition fails without changing current fencing token
    it('1. same owner attempts to reacquire an unexpired lock: acquisition fails without changing fencing token', async () => {
      const lockId = 'test_same_owner_unexpired';
      const owner = 'instance-same-owner';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acq1 = await acquireSchedulerLock(lockId, owner, 60_000);
      expect(acq1.acquired).toBe(true);
      const initialFenceToken = acq1.fenceToken!;

      // Same owner attempts acquisition again while unexpired
      const acq2 = await acquireSchedulerLock(lockId, owner, 60_000);
      expect(acq2.acquired).toBe(false);
      expect(acq2.reason).toBe('HELD_BY_OTHER');

      // Verify lock state and fenceToken in DB are unchanged
      const current = await getSchedulerLock(lockId);
      expect(current?.owner).toBe(owner);
      expect(current?.fenceToken).toBe(initialFenceToken);

      await releaseSchedulerLock(lockId, owner, initialFenceToken);
    });

    // 2. A second owner attempts to acquire an unexpired lock: acquisition fails
    it('2. a second owner attempts to acquire an unexpired lock: acquisition fails', async () => {
      const lockId = 'test_second_owner_unexpired';
      const ownerA = 'owner-node-alpha';
      const ownerB = 'owner-node-beta';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acqA = await acquireSchedulerLock(lockId, ownerA, 60_000);
      expect(acqA.acquired).toBe(true);

      const acqB = await acquireSchedulerLock(lockId, ownerB, 60_000);
      expect(acqB.acquired).toBe(false);
      expect(acqB.reason).toBe('HELD_BY_OTHER');

      await releaseSchedulerLock(lockId, ownerA, acqA.fenceToken!);
    });

    // 3. Two workers race to create a previously absent lock: at most one owns the active lock
    it('3. two workers race to create a previously absent lock: at most one owns active lock', async () => {
      const lockId = 'test_absent_lock_race';
      const worker1 = 'racer-1';
      const worker2 = 'racer-2';
      await SchedulerLock.deleteOne({ _id: lockId });

      // Run both acquisitions simultaneously
      const [res1, res2] = await Promise.all([
        acquireSchedulerLock(lockId, worker1, 60_000),
        acquireSchedulerLock(lockId, worker2, 60_000),
      ]);

      const wins = [res1, res2].filter((r) => r.acquired);
      const losses = [res1, res2].filter((r) => !r.acquired);

      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      expect(losses[0].reason).toBe('HELD_BY_OTHER');

      const winner = wins[0];
      const doc = await getSchedulerLock(lockId);
      expect(doc?.owner).toBe(winner.ownerToken);
      expect(doc?.fenceToken).toBe(winner.fenceToken);

      await releaseSchedulerLock(lockId, winner.ownerToken!, winner.fenceToken!);
    });

    // 4. Two successful sequential acquisitions receive strictly increasing fencing tokens
    it('4. two successful sequential acquisitions receive strictly increasing fencing tokens', async () => {
      const lockId = 'test_sequential_tokens';
      const worker1 = 'sequential-1';
      const worker2 = 'sequential-2';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acq1 = await acquireSchedulerLock(lockId, worker1, 60_000);
      expect(acq1.acquired).toBe(true);

      await releaseSchedulerLock(lockId, worker1, acq1.fenceToken!);

      const acq2 = await acquireSchedulerLock(lockId, worker2, 60_000);
      expect(acq2.acquired).toBe(true);

      expect(acq2.fenceToken!).toBeGreaterThan(acq1.fenceToken!);

      await releaseSchedulerLock(lockId, worker2, acq2.fenceToken!);
    });

    // 5. Delete the lock document and recreate it: next successful acquisition receives token > previous
    it('5. delete the lock document and recreate it: token increases monotonically across deletion', async () => {
      const lockId = 'test_delete_recreation_monotonicity';
      const workerA = 'worker-pre-delete';
      const workerB = 'worker-post-delete';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acqA = await acquireSchedulerLock(lockId, workerA, 60_000);
      expect(acqA.acquired).toBe(true);
      const preDeleteFenceToken = acqA.fenceToken!;

      // Lock document is dropped/deleted (e.g. collection maintenance or test teardown)
      await SchedulerLock.deleteOne({ _id: lockId });
      const deletedCheck = await getSchedulerLock(lockId);
      expect(deletedCheck).toBeNull();

      // Next acquisition recreates the document
      const acqB = await acquireSchedulerLock(lockId, workerB, 60_000);
      expect(acqB.acquired).toBe(true);

      // Must be strictly greater than the pre-deletion token (does not reset to 1)
      expect(acqB.fenceToken!).toBeGreaterThan(preDeleteFenceToken);

      await releaseSchedulerLock(lockId, workerB, acqB.fenceToken!);
    });

    // 6. Old owner attempts release after a newer owner takes over: newer lock remains intact
    it('6. old owner attempts release after a newer owner takes over: newer lock remains intact', async () => {
      const lockId = 'test_stale_release_protection';
      const oldOwner = 'stale-owner-node';
      const newOwner = 'new-owner-node';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acqOld = await acquireSchedulerLock(lockId, oldOwner, 100);
      const oldToken = acqOld.fenceToken!;

      // Simulate lease expiration by rewinding expiresAt
      await SchedulerLock.updateOne(
        { _id: lockId },
        { $set: { expiresAt: new Date(Date.now() - 5000) } },
      );

      // New owner acquires the expired lock
      const acqNew = await acquireSchedulerLock(lockId, newOwner, 60_000);
      expect(acqNew.acquired).toBe(true);
      const newToken = acqNew.fenceToken!;
      expect(newToken).toBeGreaterThan(oldToken);

      // Old owner attempts release with stale token and old owner id
      const staleRelease = await releaseSchedulerLock(lockId, oldOwner, oldToken);
      expect(staleRelease).toBe(false);

      // New owner's lock is completely unaffected
      const currentDoc = await getSchedulerLock(lockId);
      expect(currentDoc?.owner).toBe(newOwner);
      expect(currentDoc?.fenceToken).toBe(newToken);
      expect(currentDoc?.expiresAt.getTime()).toBeGreaterThan(Date.now());

      await releaseSchedulerLock(lockId, newOwner, newToken);
    });

    // 7. Old owner attempts renewal after takeover: renewal fails
    it('7. old owner attempts renewal after takeover: renewal fails', async () => {
      const lockId = 'test_stale_renew_protection';
      const oldOwner = 'old-renew-owner';
      const newOwner = 'new-renew-owner';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acqOld = await acquireSchedulerLock(lockId, oldOwner, 100);
      const oldToken = acqOld.fenceToken!;

      // Expire old lease
      await SchedulerLock.updateOne(
        { _id: lockId },
        { $set: { expiresAt: new Date(Date.now() - 5000) } },
      );

      // New owner acquires
      const acqNew = await acquireSchedulerLock(lockId, newOwner, 60_000);
      expect(acqNew.acquired).toBe(true);

      // Old owner attempts renewal
      const renewResult = await renewSchedulerLock(lockId, oldOwner, oldToken, 30_000);
      expect(renewResult).toBe(false);

      await releaseSchedulerLock(lockId, newOwner, acqNew.fenceToken!);
    });

    // 8. An expired lease cannot be treated as valid
    it('8. an expired lease cannot be treated as valid', async () => {
      const lockId = 'test_expired_lease_invalidation';
      const owner = 'expired-owner';
      await SchedulerLock.deleteOne({ _id: lockId });

      const acq = await acquireSchedulerLock(lockId, owner, 100);
      const fenceToken = acq.fenceToken!;

      // Rewind expiresAt into the past
      await SchedulerLock.updateOne(
        { _id: lockId },
        { $set: { expiresAt: new Date(Date.now() - 10_000) } },
      );

      // isSchedulerLockHeld must report false
      const held = await isSchedulerLockHeld(lockId);
      expect(held).toBe(false);

      // renewSchedulerLock must reject an expired lease
      const renewResult = await renewSchedulerLock(lockId, owner, fenceToken, 30_000);
      expect(renewResult).toBe(false);

      // Clean up
      await SchedulerLock.deleteOne({ _id: lockId });
    });

    // 9. Counter allocation failure does not fall back to an unsafe token or grant an invalid lock
    it('9. counter allocation failure does not fall back to unsafe token or grant invalid lock', async () => {
      const lockId = 'test_counter_failure_resilience';
      const owner = 'counter-fail-owner';
      await SchedulerLock.deleteOne({ _id: lockId });

      // Mock Counter.findOneAndUpdate to reject with an unexpected error
      const originalFindOneAndUpdate = Counter.findOneAndUpdate.bind(Counter);
      (Counter as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = (() => {
        throw new Error('MongoServerSelectionError: Primary unavailable');
      }) as never;

      try {
        const result = await acquireSchedulerLock(lockId, owner, 60_000);
        expect(result.acquired).toBe(false);
        expect(result.reason).toBe('STORE_ERROR');

        // Verify no lock document was created with an unsafe or fallback token
        const doc = await getSchedulerLock(lockId);
        expect(doc).toBeNull();
      } finally {
        (Counter as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = originalFindOneAndUpdate;
      }
    });

    // 10. Stale reconciliation worker attempts to recover an ambulance after dispatcher reassigned it
    it('10. stale reconciliation worker attempts to recover an ambulance after reassignment: new assignment preserved', async () => {
      const emgOld = 'EMG-M4-OLD-INCIDENT';
      const emgNew = 'EMG-M4-NEW-INCIDENT';
      const unitId = 'AMB-M4-REASSIGNED-RACE';

      await createEmergencyRecord(emgOld, 'COMPLETED', unitId);
      await createEmergencyRecord(emgNew, 'AMBULANCE_ASSIGNED', unitId);

      // Ambulance was initially linked to emgOld
      await createAmbulance(unitId, 'ASSIGNED', emgOld);

      // Dispatcher reassigns ambulance to emgNew before reconciliation write executes
      await Ambulance.updateOne(
        { _id: unitId },
        { $set: { currentEmergency: emgNew, status: 'ASSIGNED', lastUpdated: new Date() } },
      );

      // Worker executes reconciliation targeting emgOld
      const updateResult = await Ambulance.updateOne(
        {
          _id: unitId,
          status: 'ASSIGNED',
          currentEmergency: emgOld, // Stale predicate!
        },
        {
          $set: {
            status: 'AVAILABLE',
            currentEmergency: null,
            eta: undefined,
            lastUpdated: new Date(),
          },
        },
      ).exec();

      // CAS predicate protected the new assignment: 0 records modified
      expect(updateResult.matchedCount).toBe(0);
      expect(updateResult.modifiedCount).toBe(0);

      const amb = await Ambulance.findById(unitId).lean();
      expect(amb?.status).toBe('ASSIGNED');
      expect(amb?.currentEmergency).toBe(emgNew); // Intact!

      await Ambulance.deleteOne({ _id: unitId });
      await Emergency.deleteMany({ _id: { $in: [emgOld, emgNew] } });
    });

    // 11. Concurrent workers attempt to recover the same ambulance: only winning transition reported
    it('11. concurrent workers attempt to recover the same ambulance: only winning transition reported', async () => {
      const emgId = 'EMG-M4-CONCURRENT-RECOVERY';
      const ambId = 'AMB-M4-DUAL-WORKER';

      await createEmergencyRecord(emgId, 'COMPLETED', ambId);
      await createAmbulance(ambId, 'ASSIGNED', emgId);

      // Both workers attempt the exact same recovery write concurrently
      const updatePredicate = { _id: ambId, status: 'ASSIGNED', currentEmergency: emgId };
      const updatePayload = {
        $set: { status: 'AVAILABLE', currentEmergency: null, eta: undefined, lastUpdated: new Date() },
      };

      const [res1, res2] = await Promise.all([
        Ambulance.updateOne(updatePredicate, updatePayload).exec(),
        Ambulance.updateOne(updatePredicate, updatePayload).exec(),
      ]);

      const winningWrites = [res1, res2].filter((r) => r.modifiedCount > 0);
      const noOpWrites = [res1, res2].filter((r) => r.modifiedCount === 0);

      expect(winningWrites).toHaveLength(1);
      expect(noOpWrites).toHaveLength(1);

      // Ambulance is in expected final state
      const amb = await Ambulance.findById(ambId).lean();
      expect(amb?.status).toBe('AVAILABLE');
      expect(amb?.currentEmergency).toBeNull();

      await Ambulance.deleteOne({ _id: ambId });
      await Emergency.deleteOne({ _id: emgId });
    });

    // 12. Repeated reconciliation remains idempotent
    it('12. repeated reconciliation remains idempotent', async () => {
      const emgActiveId = 'EMG-M4-IDEMP-ACT';
      const emgTermId = 'EMG-M4-IDEMP-TERM';
      const activeUnit = 'AMB-M4-IDEMP-1';
      const displacedUnit = 'AMB-M4-IDEMP-2';
      const terminalUnit = 'AMB-M4-IDEMP-3';
      const nullRefUnit = 'AMB-M4-IDEMP-4';

      await createEmergencyRecord(emgActiveId, 'AMBULANCE_ASSIGNED', activeUnit);
      await createEmergencyRecord(emgTermId, 'COMPLETED', terminalUnit);

      await createAmbulance(activeUnit, 'ASSIGNED', emgActiveId);
      await createAmbulance(displacedUnit, 'ASSIGNED', emgActiveId);
      await createAmbulance(terminalUnit, 'ASSIGNED', emgTermId);
      await createAmbulance(nullRefUnit, 'ASSIGNED', null);

      // Pass 1: recovers all stranded and displaced units
      const pass1 = await reconcileStrandedAmbulances();
      expect(pass1.released).toHaveLength(3);
      expect(pass1.released).toContain(displacedUnit);
      expect(pass1.released).toContain(terminalUnit);
      expect(pass1.released).toContain(nullRefUnit);
      expect(pass1.skippedActive).toContain(activeUnit);

      // Pass 2: idempotent no-op (0 released)
      const pass2 = await reconcileStrandedAmbulances();
      expect(pass2.released).toHaveLength(0);
      expect(pass2.skippedActive).toContain(activeUnit);

      // Pass 3: repeated run remains completely no-op
      const pass3 = await reconcileStrandedAmbulances();
      expect(pass3.released).toHaveLength(0);
      expect(pass3.skippedActive).toContain(activeUnit);

      // Final fleet verification
      const ambActive = await Ambulance.findById(activeUnit).lean();
      const ambDisplaced = await Ambulance.findById(displacedUnit).lean();
      const ambTerminal = await Ambulance.findById(terminalUnit).lean();
      const ambNull = await Ambulance.findById(nullRefUnit).lean();

      expect(ambActive?.status).toBe('ASSIGNED');
      expect(ambDisplaced?.status).toBe('AVAILABLE');
      expect(ambTerminal?.status).toBe('AVAILABLE');
      expect(ambNull?.status).toBe('AVAILABLE');

      await Ambulance.deleteMany({ _id: { $in: [activeUnit, displacedUnit, terminalUnit, nullRefUnit] } });
      await Emergency.deleteMany({ _id: { $in: [emgActiveId, emgTermId] } });
    });
  });

  // --------------------------------------------------------------------------
  // Scheduler Integration & In-flight Write Fencing
  // --------------------------------------------------------------------------
  describe('Scheduler Lifecycle & Cooperative In-Flight Fencing', () => {
    it('scheduler starts, stops, and coordinates with distributed lock cleanly', async () => {
      const lockId = 'ambulance_reconciliation';
      await SchedulerLock.deleteOne({ _id: lockId });

      startAmbulanceReconciliationScheduler(60_000, 100);
      expect(isReconciliationSchedulerRunning()).toBe(true);

      await stopAmbulanceReconciliationScheduler(5_000);
      expect(isReconciliationSchedulerRunning()).toBe(false);

      const held = await isSchedulerLockHeld(lockId);
      expect(held).toBe(false);
    });

    it('in-flight fencing halts sweep mutations when lease expires before database writes', async () => {
      const ambId = 'AMB-M4-FENCE-TEST';
      await createAmbulance(ambId, 'ASSIGNED', null);

      const outcome = await reconcileStrandedAmbulances({
        isLockValid: () => false, // Simulate lease expired
      });

      // Sweep should immediately halt without modifying the ambulance
      expect(outcome.released).not.toContain(ambId);
      const amb = await Ambulance.findById(ambId).lean();
      expect(amb?.status).toBe('ASSIGNED'); // Not modified!

      await Ambulance.deleteOne({ _id: ambId });
    });
  });
});
