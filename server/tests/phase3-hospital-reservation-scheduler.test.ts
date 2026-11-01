import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Hospital, Emergency, HospitalReservation, AuditLog } from '../src/models/index.js';
import {
  reserveHospitalCapacity,
  reconcileHospitalReservations,
  startHospitalReservationReconciliationScheduler,
  stopHospitalReservationReconciliationScheduler,
  isHospitalReservationSchedulerRunning,
  runHospitalReservationReconciliationSweep,
  validateStagingExclusionConfiguration,
  getEffectiveHospitalReconciliationExclusions,
  setHospitalReservationSchedulerShutdown,
} from '../src/services/hospitalReservationService.js';

useTestDatabase(runSeed);

describe('Phase 3 — Hospital Reservation Reconciliation Scheduler & Lifecycle Validation', () => {
  const originalEnvExclusions = process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES;

  beforeEach(() => {
    process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES = 'EMG-00001,EMG-20485';
    setHospitalReservationSchedulerShutdown(false);
  });

  afterEach(async () => {
    process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES = originalEnvExclusions;
    await stopHospitalReservationReconciliationScheduler();
    setHospitalReservationSchedulerShutdown(false);
    vi.restoreAllMocks();
  });

  async function createTestHospital(
    id: string,
    overrides: {
      status?: string;
      emergencyCapacity?: string;
      icuBeds?: number;
      generalBeds?: number;
      incomingAmbulances?: number;
      activeReservationIds?: string[];
    } = {},
  ) {
    return Hospital.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          name: `Facility ${id}`,
          status: overrides.status ?? 'OPERATIONAL',
          emergencyCapacity: overrides.emergencyCapacity ?? 'AVAILABLE',
          icuCapacity: 'AVAILABLE',
          icuBeds: overrides.icuBeds ?? 10,
          generalBeds: overrides.generalBeds ?? 20,
          traumaAvailable: true,
          incomingAmbulances: overrides.incomingAmbulances ?? 0,
          activeReservationIds: overrides.activeReservationIds ?? [],
          active: true,
          location: { lat: 26.2183, lng: 78.1828, address: 'Gwalior Test' },
          geo: { type: 'Point', coordinates: [78.1828, 26.2183] },
          phone: '+91-751-2000000',
          currentLoad: 30,
          capabilities: ['Trauma', 'Emergency', 'ICU'],
        },
      },
      { upsert: true, new: true },
    );
  }

  async function createTestEmergency(
    id: string,
    overrides: {
      status?: string;
      destinationHospital?: string;
    } = {},
  ) {
    return Emergency.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          callerName: 'Test Caller',
          callerPhone: '+91-9876543210',
          location: {
            lat: 26.2183,
            lng: 78.1828,
            address: 'City Center, Gwalior',
          },
          geo: { type: 'Point', coordinates: [78.1828, 26.2183] },
          incidentType: 'CARDIAC',
          priority: 'CRITICAL',
          severity: 'SEVERE',
          status: overrides.status ?? 'DISPATCHED',
          destinationHospital: overrides.destinationHospital,
          timeline: [
            {
              status: overrides.status ?? 'DISPATCHED',
              timestamp: new Date(),
              note: 'Initial test setup',
            },
          ],
        },
      },
      { upsert: true, new: true },
    );
  }

  describe('A. Scheduler Behavior & Lifecycle Control', () => {
    it('starts successfully after database readiness and registers running state', () => {
      expect(isHospitalReservationSchedulerRunning()).toBe(false);

      startHospitalReservationReconciliationScheduler({ intervalMs: 60_000 });

      expect(isHospitalReservationSchedulerRunning()).toBe(true);
    });

    it('does not start duplicate scheduler instances (idempotent startup)', () => {
      startHospitalReservationReconciliationScheduler({ intervalMs: 60_000 });
      expect(isHospitalReservationSchedulerRunning()).toBe(true);

      // Second start call must be idempotent and not create duplicate intervals
      startHospitalReservationReconciliationScheduler({ intervalMs: 60_000 });
      expect(isHospitalReservationSchedulerRunning()).toBe(true);

      stopHospitalReservationReconciliationScheduler();
      expect(isHospitalReservationSchedulerRunning()).toBe(false);
    });

    it('stops cleanly during graceful shutdown and clears timer', async () => {
      startHospitalReservationReconciliationScheduler({ intervalMs: 60_000 });
      expect(isHospitalReservationSchedulerRunning()).toBe(true);

      await stopHospitalReservationReconciliationScheduler();
      expect(isHospitalReservationSchedulerRunning()).toBe(false);

      // Redundant stop should be safe
      await stopHospitalReservationReconciliationScheduler();
      expect(isHospitalReservationSchedulerRunning()).toBe(false);
    });

    it('prevents overlapping local sweeps by reusing active in-flight sweep promise', async () => {
      let resolveFirst: (() => void) | undefined;
      const firstBlockedPromise = new Promise<void>((res) => {
        resolveFirst = res;
      });

      const originalFind = HospitalReservation.find.bind(HospitalReservation);
      let hookTriggered = false;
      vi.spyOn(HospitalReservation, 'find').mockImplementation(((...args: any[]) => {
        if (!hookTriggered) {
          hookTriggered = true;
          return {
            limit: () => ({
              lean: async () => {
                await firstBlockedPromise;
                return [];
              },
            }),
          } as any;
        }
        return originalFind(...(args as [any]));
      }) as any);

      // Start first sweep in background
      const sweep1Promise = runHospitalReservationReconciliationSweep();

      // Trigger second sweep while first is still running: must reuse active promise
      const sweep2Promise = runHospitalReservationReconciliationSweep();

      expect(sweep1Promise).toBe(sweep2Promise);

      if (resolveFirst) resolveFirst();
      const [res1, res2] = await Promise.all([sweep1Promise, sweep2Promise]);
      expect(res1).toBe(res2);
    });

    it('handles a failed reconciliation cycle without crashing the scheduler', async () => {
      startHospitalReservationReconciliationScheduler({ intervalMs: 60_000 });
      expect(isHospitalReservationSchedulerRunning()).toBe(true);

      vi.spyOn(HospitalReservation, 'find').mockImplementationOnce(() => {
        throw new Error('Simulated database transient failure');
      });

      // Direct invocation throws, but error is handled and scheduler timer remains active
      await expect(runHospitalReservationReconciliationSweep()).rejects.toThrow('Simulated database transient failure');

      expect(isHospitalReservationSchedulerRunning()).toBe(true);
    });
  });

  describe('B. Staging Exclusion Protection & Fail-Closed Safeguards', () => {
    it('correctly resolves effective exclusions from environment config', () => {
      const exclusions = getEffectiveHospitalReconciliationExclusions();
      expect(Array.isArray(exclusions)).toBe(true);
      expect(exclusions).toContain('EMG-00001');
      expect(exclusions).toContain('EMG-20485');
    });

    it('fails closed in staging when required demo emergency exclusions are missing', () => {
      // Missing mandatory demo emergencies
      const invalid = validateStagingExclusionConfiguration('rapidaid_staging', ['RANDOM-EMG']);
      expect(invalid.valid).toBe(false);
      expect(invalid.error).toContain('missing mandatory protected emergencies');

      // Empty exclusions
      const empty = validateStagingExclusionConfiguration('rapidaid_staging', []);
      expect(empty.valid).toBe(false);
      expect(empty.error).toContain('fail-closed');

      // Valid configuration
      const valid = validateStagingExclusionConfiguration('rapidaid_staging', ['EMG-00001', 'EMG-20485']);
      expect(valid.valid).toBe(true);
      expect(valid.exclusions).toContain('EMG-00001');
      expect(valid.exclusions).toContain('EMG-20485');

      // Non-staging database does not enforce demo exclusions
      const dev = validateStagingExclusionConfiguration('rapidaid_dev', []);
      expect(dev.valid).toBe(true);
    });

    it('refuses to start scheduler when connected to staging without required exclusions', () => {
      const originalName = mongoose.connection.name;
      Object.defineProperty(mongoose.connection, 'name', {
        value: 'rapidaid_staging',
        configurable: true,
      });

      const origEnv = process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES;
      delete process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES;

      try {
        startHospitalReservationReconciliationScheduler();
        // Should have refused to start
        expect(isHospitalReservationSchedulerRunning()).toBe(false);
      } finally {
        process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES = origEnv;
        Object.defineProperty(mongoose.connection, 'name', {
          value: originalName,
          configurable: true,
        });
      }
    });

    it('excludes protected emergencies from every reconciliation sweep category', async () => {
      await createTestHospital('HOSP-SCHED-EXCL', {
        incomingAmbulances: 3,
        activeReservationIds: ['RES-PROT-1', 'RES-PROT-2', 'RES-SYNTH-1'],
      });

      await createTestEmergency('EMG-00001', { destinationHospital: 'HOSP-SCHED-EXCL' });
      await createTestEmergency('EMG-20485', { destinationHospital: 'HOSP-SCHED-EXCL' });
      await createTestEmergency('EMG-SYNTH-1', { destinationHospital: 'HOSP-SCHED-EXCL' });

      const pastExpiry = new Date(Date.now() - 300_000);

      // Create expired reservations for all 3
      await HospitalReservation.create([
        {
          _id: 'RES-PROT-1',
          emergencyId: 'EMG-00001',
          hospitalId: 'HOSP-SCHED-EXCL',
          status: 'CONFIRMED',
          expiresAt: pastExpiry,
          capacityApplied: true,
          capacityCompensated: false,
          claimToken: 'clm-prot-1',
          resourceType: 'EMERGENCY_ACCEPTANCE',
          incomingAmbulanceIncremented: true,
        },
        {
          _id: 'RES-PROT-2',
          emergencyId: 'EMG-20485',
          hospitalId: 'HOSP-SCHED-EXCL',
          status: 'CONFIRMED',
          expiresAt: pastExpiry,
          capacityApplied: true,
          capacityCompensated: false,
          claimToken: 'clm-prot-2',
          resourceType: 'EMERGENCY_ACCEPTANCE',
          incomingAmbulanceIncremented: true,
        },
        {
          _id: 'RES-SYNTH-1',
          emergencyId: 'EMG-SYNTH-1',
          hospitalId: 'HOSP-SCHED-EXCL',
          status: 'CONFIRMED',
          expiresAt: pastExpiry,
          capacityApplied: true,
          capacityCompensated: false,
          claimToken: 'clm-synth-1',
          resourceType: 'EMERGENCY_ACCEPTANCE',
          incomingAmbulanceIncremented: true,
        },
      ]);

      // Run reconciliation with exclusions for EMG-00001 and EMG-20485
      const reconResult = await reconcileHospitalReservations({
        excludeEmergencyIds: ['EMG-00001', 'EMG-20485'],
        hospitalId: 'HOSP-SCHED-EXCL',
      });

      expect(reconResult.expiredCount).toBe(1); // Only EMG-SYNTH-1 processed

      // Verify protected records remained untouched
      const res1 = await HospitalReservation.findById('RES-PROT-1');
      const res2 = await HospitalReservation.findById('RES-PROT-2');
      const resSynth = await HospitalReservation.findById('RES-SYNTH-1');

      expect(res1?.status).toBe('CONFIRMED');
      expect(res2?.status).toBe('CONFIRMED');
      expect(resSynth?.status).toBe('EXPIRED');

      // Verify hospital activeReservationIds still contains protected reservations
      const updatedHosp = await Hospital.findById('HOSP-SCHED-EXCL');
      expect(updatedHosp?.activeReservationIds).toContain('RES-PROT-1');
      expect(updatedHosp?.activeReservationIds).toContain('RES-PROT-2');
      expect(updatedHosp?.activeReservationIds).not.toContain('RES-SYNTH-1');
      expect(updatedHosp?.incomingAmbulances).toBe(2); // 3 -> 2 (only synth decremented)
    });
  });

  describe('C. Synthetic Reservation Expiry Lifecycle & Capacity Compensation', () => {
    it('executes the full isolated reservation lifecycle with idempotency and capacity accounting', async () => {
      await createTestHospital('HOSP-SYNTH-LIFECYCLE', {
        incomingAmbulances: 0,
        activeReservationIds: [],
      });
      await createTestEmergency('EMG-SYNTH-LIFECYCLE');

      // Step 1: Create active reservation -> incomingAmbulances increments exactly once
      const initialReservation = await reserveHospitalCapacity(
        'EMG-SYNTH-LIFECYCLE',
        'HOSP-SYNTH-LIFECYCLE',
        'EMERGENCY_ACCEPTANCE',
        {
          actor: 'DISP-001',
          actorRole: 'DISPATCHER',
        },
      );

      expect(initialReservation.status).toBe('CONFIRMED');
      expect(initialReservation.capacityApplied).toBe(true);
      expect(initialReservation.capacityCompensated).toBe(false);

      const hospAfterCreate = await Hospital.findById('HOSP-SYNTH-LIFECYCLE');
      expect(hospAfterCreate?.incomingAmbulances).toBe(1);
      expect(hospAfterCreate?.activeReservationIds).toContain(initialReservation._id);

      // Step 2 & 3: Active reservation before expiry remains CONFIRMED during reconciliation
      const reconBeforeExpiry = await reconcileHospitalReservations({
        hospitalId: 'HOSP-SYNTH-LIFECYCLE',
      });
      expect(reconBeforeExpiry.expiredCount).toBe(0);

      const resBeforeExpiry = await HospitalReservation.findById(initialReservation._id);
      expect(resBeforeExpiry?.status).toBe('CONFIRMED');

      // Step 4: Controlled expiry by shifting expiresAt into the past
      await HospitalReservation.findByIdAndUpdate(initialReservation._id, {
        $set: { expiresAt: new Date(Date.now() - 60_000) },
      });

      // Also create a separate ACTIVE reservation to verify it remains untouched
      await createTestEmergency('EMG-SYNTH-ACTIVE');
      const activeReservation = await reserveHospitalCapacity(
        'EMG-SYNTH-ACTIVE',
        'HOSP-SYNTH-LIFECYCLE',
        'EMERGENCY_ACCEPTANCE',
        {
          actor: 'DISP-001',
          actorRole: 'DISPATCHER',
          expiryMs: 30 * 60_000,
        },
      );

      const hospBeforeSweep = await Hospital.findById('HOSP-SYNTH-LIFECYCLE');
      expect(hospBeforeSweep?.incomingAmbulances).toBe(2);

      // Step 5 & 6: Reconciliation transitions expired reservation to EXPIRED, decrements capacity, pulls ID
      const reconAfterExpiry = await reconcileHospitalReservations({
        hospitalId: 'HOSP-SYNTH-LIFECYCLE',
      });
      expect(reconAfterExpiry.expiredCount).toBe(1);

      const expiredRes = await HospitalReservation.findById(initialReservation._id);
      expect(expiredRes?.status).toBe('EXPIRED');
      expect(expiredRes?.capacityCompensated).toBe(true);

      const hospAfterSweep = await Hospital.findById('HOSP-SYNTH-LIFECYCLE');
      expect(hospAfterSweep?.incomingAmbulances).toBe(1); // 2 -> 1
      expect(hospAfterSweep?.activeReservationIds).not.toContain(initialReservation._id);
      expect(hospAfterSweep?.activeReservationIds).toContain(activeReservation._id);

      // Step 7: Repeated reconciliation does not decrement capacity again
      const repeatRecon = await reconcileHospitalReservations({
        hospitalId: 'HOSP-SYNTH-LIFECYCLE',
      });
      expect(repeatRecon.expiredCount).toBe(0);

      const hospAfterRepeat = await Hospital.findById('HOSP-SYNTH-LIFECYCLE');
      expect(hospAfterRepeat?.incomingAmbulances).toBe(1); // Still exactly 1

      // Step 8: Repeated reconciliation does not duplicate audit log entries
      const auditEntries = await AuditLog.find({
        action: 'hospital.reservation_expired',
        resourceId: initialReservation._id,
      });
      expect(auditEntries.length).toBe(1);

      // Step 9: Separate active reservation remains CONFIRMED
      const activeResCheck = await HospitalReservation.findById(activeReservation._id);
      expect(activeResCheck?.status).toBe('CONFIRMED');
    });
  });

  describe('D. Failure Recovery Paths', () => {
    it('recovers interrupted PENDING reservations', async () => {
      await createTestHospital('HOSP-RECOV-1');
      await createTestEmergency('EMG-RECOV-1');

      // Create an interrupted PENDING reservation older than grace period
      await HospitalReservation.create({
        _id: 'RES-PENDING-INTERRUPTED',
        emergencyId: 'EMG-RECOV-1',
        hospitalId: 'HOSP-RECOV-1',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 600_000),
        capacityApplied: false,
        capacityCompensated: false,
        claimToken: 'clm-pending-int',
        resourceType: 'EMERGENCY_ACCEPTANCE',
        createdAt: new Date(Date.now() - 300_000),
        updatedAt: new Date(Date.now() - 300_000),
      });

      const result = await reconcileHospitalReservations({
        hospitalId: 'HOSP-RECOV-1',
        gracePeriodMs: 60_000,
      });

      expect(result.interruptedCount).toBe(1);
      const updated = await HospitalReservation.findById('RES-PENDING-INTERRUPTED');
      expect(updated?.status).toBe('CANCELLED');
    });

    it('compensates terminal reservation with uncompensated capacity', async () => {
      await createTestHospital('HOSP-RECOV-2', {
        incomingAmbulances: 1,
        activeReservationIds: ['RES-UNCOMPENSATED'],
      });
      await createTestEmergency('EMG-RECOV-2');

      // Reservation marked CANCELLED but capacity not compensated
      await HospitalReservation.create({
        _id: 'RES-UNCOMPENSATED',
        emergencyId: 'EMG-RECOV-2',
        hospitalId: 'HOSP-RECOV-2',
        status: 'CANCELLED',
        expiresAt: new Date(Date.now() + 600_000),
        capacityApplied: true,
        capacityCompensated: false,
        claimToken: 'clm-uncomp',
        resourceType: 'EMERGENCY_ACCEPTANCE',
        incomingAmbulanceIncremented: true,
      });

      const result = await reconcileHospitalReservations({
        hospitalId: 'HOSP-RECOV-2',
      });

      expect(result.interruptedCount).toBe(1);

      const res = await HospitalReservation.findById('RES-UNCOMPENSATED');
      expect(res?.capacityCompensated).toBe(true);

      const hosp = await Hospital.findById('HOSP-RECOV-2');
      expect(hosp?.incomingAmbulances).toBe(0);
      expect(hosp?.activeReservationIds).not.toContain('RES-UNCOMPENSATED');
    });

    it('cleans up dangling hospital activeReservationIds when reservation doc does not exist', async () => {
      await createTestHospital('HOSP-RECOV-3', {
        incomingAmbulances: 1,
        activeReservationIds: ['RES-NONEXISTENT-ORPHAN'],
      });

      const result = await reconcileHospitalReservations({
        hospitalId: 'HOSP-RECOV-3',
      });

      expect(result.danglingClaimsRecoveredCount).toBe(1);

      const hosp = await Hospital.findById('HOSP-RECOV-3');
      expect(hosp?.incomingAmbulances).toBe(0);
      expect(hosp?.activeReservationIds).not.toContain('RES-NONEXISTENT-ORPHAN');
    });
  });
});
