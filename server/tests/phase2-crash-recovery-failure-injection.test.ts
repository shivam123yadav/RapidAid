import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Hospital, Emergency, HospitalReservation, Ambulance, AuditLog } from '../src/models/index.js';
import {
  reserveHospitalCapacity,
  releaseHospitalReservation,
  reconcileHospitalReservations,
} from '../src/services/hospitalReservationService.js';
import { evaluateDispatchDryRun } from '../src/services/dispatchDryRunService.js';
import { env } from '../src/config/env.js';

useTestDatabase(runSeed);

describe('Gate 2 & 3 — Crash-Safety Audit & Deterministic Failure Injection', () => {
  async function createTestHospital(
    id: string,
    overrides: {
      status?: string;
      emergencyCapacity?: string;
      icuCapacity?: string;
      icuBeds?: number;
      generalBeds?: number;
      traumaAvailable?: boolean;
      incomingAmbulances?: number;
      active?: boolean;
      activeReservationIds?: string[];
    } = {},
  ) {
    return Hospital.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          name: `Crash Safety Facility ${id}`,
          status: overrides.status ?? 'OPERATIONAL',
          emergencyCapacity: overrides.emergencyCapacity ?? 'AVAILABLE',
          icuCapacity: overrides.icuCapacity ?? 'AVAILABLE',
          icuBeds: overrides.icuBeds ?? 5,
          generalBeds: overrides.generalBeds ?? 10,
          traumaAvailable: overrides.traumaAvailable ?? true,
          incomingAmbulances: overrides.incomingAmbulances ?? 0,
          activeReservationIds: overrides.activeReservationIds ?? [],
          active: overrides.active ?? true,
          location: { lat: 28.61, lng: 77.21, address: 'Test Hospital Street' },
          geo: { type: 'Point', coordinates: [77.21, 28.61] },
          phone: '+91-11-21111111',
          currentLoad: 40,
          capabilities: ['Trauma', 'Cardiac', 'ICU'],
        },
      },
      { upsert: true, new: true },
    );
  }

  async function createTestEmergency(
    id: string,
    overrides: {
      status?: string;
      priority?: string;
      incidentType?: string;
      destinationHospital?: string;
      hospitalReservationId?: string;
    } = {},
  ) {
    return Emergency.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: overrides.status ?? 'REPORTED',
          priority: overrides.priority ?? 'CRITICAL',
          incidentType: overrides.incidentType ?? 'CARDIAC_ARREST',
          destinationHospital: overrides.destinationHospital,
          hospitalReservationId: overrides.hospitalReservationId,
          location: { lat: 28.615, lng: 77.218, address: 'Crash Incident Scene' },
          source: 'DISPATCHER',
          description: `Crash safety test emergency ${id}`,
          victimCount: 1,
          reportedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }

  it('1. Crash Boundary A: Interruption between PENDING pre-allocation and Hospital CAS (0 counters touched)', async () => {
    const hospId = 'HOSP-FI-A';
    const emgId = 'EMG-FI-A';

    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    // Inject abrupt failure right before Hospital CAS
    await expect(
      reserveHospitalCapacity(emgId, hospId, 'ICU_BED', {
        beforeHospitalCasHook: async () => {
          throw new Error('SIMULATED_SIGKILL_BEFORE_HOSPITAL_CAS');
        },
      }),
    ).rejects.toThrow('SIMULATED_SIGKILL_BEFORE_HOSPITAL_CAS');

    // Hospital counters must be completely untouched
    const hospBeforeRecon = await Hospital.findById(hospId).lean();
    expect(hospBeforeRecon?.icuBeds).toBe(5);
    expect(hospBeforeRecon?.incomingAmbulances).toBe(0);
    expect(hospBeforeRecon?.activeReservationIds).toHaveLength(0);

    // Reservation was pre-allocated in PENDING state; run reconciliation
    const recon = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(recon.interruptedCount).toBeGreaterThanOrEqual(1);

    // Hospital counters remain unchanged and non-negative
    const hospAfterRecon = await Hospital.findById(hospId).lean();
    expect(hospAfterRecon?.icuBeds).toBe(5);
    expect(hospAfterRecon?.incomingAmbulances).toBe(0);
    expect(hospAfterRecon?.activeReservationIds).toHaveLength(0);
  });

  it('2. Crash Boundary B: Node dies after Hospital CAS succeeded before reservation CONFIRMED', async () => {
    const hospId = 'HOSP-FI-B';
    const emgId = 'EMG-FI-B';
    const reservationId = 'RES-ICU_BED-FI-B-UNCONFIRMED';

    // Simulate database state if Node.js died abruptly after Hospital CAS without executing catch block:
    // Hospital has claimed capacity, but reservation was left PENDING
    await createTestHospital(hospId, {
      icuBeds: 4, // 5 - 1
      incomingAmbulances: 1, // 0 + 1
      activeReservationIds: [reservationId],
    });
    await createTestEmergency(emgId);

    await HospitalReservation.create({
      _id: reservationId,
      emergencyId: emgId,
      hospitalId: hospId,
      resourceType: 'ICU_BED',
      status: 'PENDING',
      capacityApplied: false,
      capacityCompensated: false,
      allocatedUnits: 1,
      bedTypeDecremented: 'icuBeds',
      incomingAmbulanceIncremented: true,
      claimToken: 'clm-b-crash',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 5_000),
    });

    // Run reconciliation scan
    const recon = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(recon.interruptedCount).toBeGreaterThanOrEqual(1);

    // Hospital counters MUST be restored back to original baseline (5 beds, 0 incoming)
    const restoredHosp = await Hospital.findById(hospId).lean();
    expect(restoredHosp?.icuBeds).toBe(5);
    expect(restoredHosp?.incomingAmbulances).toBe(0);
    expect(restoredHosp?.activeReservationIds).not.toContain(reservationId);

    // Reservation document must be EXPIRED / CANCELLED with compensation flagged
    const resDoc = await HospitalReservation.findById(reservationId).lean();
    expect(['EXPIRED', 'CANCELLED']).toContain(resDoc?.status);
    expect(resDoc?.capacityCompensated).toBe(true);
  });

  it('3. Crash Boundary C: Applied capacity with NO persisted reservation document', async () => {
    const hospId = 'HOSP-FI-C';
    const orphanClaimId = 'RES-ICU_BED-DANGLING-999';

    // Hospital doc has the active claim recorded, but the reservation doc was NEVER persisted or was lost
    await createTestHospital(hospId, {
      icuBeds: 2, // Was 3, decremented by dangling claim
      incomingAmbulances: 1, // Was 0, incremented by dangling claim
      activeReservationIds: [orphanClaimId],
    });

    // Verify no reservation document exists
    const exists = await HospitalReservation.exists({ _id: orphanClaimId });
    expect(exists).toBeNull();

    // Run reconciliation
    const recon = await reconcileHospitalReservations();
    expect(recon.danglingClaimsRecoveredCount).toBeGreaterThanOrEqual(1);
    expect(recon.reconciledReservations).toContain(orphanClaimId);

    // Hospital counters MUST be restored: icuBeds restored to 3, incomingAmbulances decremented to 0
    const restoredHosp = await Hospital.findById(hospId).lean();
    expect(restoredHosp?.icuBeds).toBe(3);
    expect(restoredHosp?.incomingAmbulances).toBe(0);
    expect(restoredHosp?.activeReservationIds).not.toContain(orphanClaimId);

    // Audit log was recorded
    const audit = await AuditLog.findOne({
      action: 'hospital.dangling_claim_recovered',
      resourceId: hospId,
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit?.details).toContain(orphanClaimId);
  });

  it('4. Crash Boundary D: Node dies after reservation CONFIRMED before Emergency linkage', async () => {
    const hospId = 'HOSP-FI-D';
    const emgId = 'EMG-FI-D';
    const reservationId = 'RES-ICU_BED-FI-D-UNLINKED';

    await createTestHospital(hospId, {
      icuBeds: 3, // Capacity was decremented
      incomingAmbulances: 1,
      activeReservationIds: [reservationId],
    });
    // Emergency was created but never linked to this reservation
    await createTestEmergency(emgId, { destinationHospital: undefined, hospitalReservationId: undefined });

    await HospitalReservation.create({
      _id: reservationId,
      emergencyId: emgId,
      hospitalId: hospId,
      resourceType: 'ICU_BED',
      status: 'CONFIRMED',
      capacityApplied: true,
      capacityCompensated: false,
      allocatedUnits: 1,
      bedTypeDecremented: 'icuBeds',
      incomingAmbulanceIncremented: true,
      claimToken: 'clm-d-unlinked',
      expiresAt: new Date(Date.now() + 100_000),
      createdAt: new Date(Date.now() - 10_000),
    });

    // Run reconciliation scan
    const recon = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(recon.orphanedCount).toBeGreaterThanOrEqual(1);

    // Hospital counters MUST be restored
    const restoredHosp = await Hospital.findById(hospId).lean();
    expect(restoredHosp?.icuBeds).toBe(4);
    expect(restoredHosp?.incomingAmbulances).toBe(0);
    expect(restoredHosp?.activeReservationIds).not.toContain(reservationId);

    // Reservation is marked RELEASED
    const resDoc = await HospitalReservation.findById(reservationId).lean();
    expect(resDoc?.status).toBe('RELEASED');
    expect(resDoc?.capacityCompensated).toBe(true);
  });

  it('5. Crash Boundary E: Node dies after reservation marked terminal before Hospital capacity compensation', async () => {
    const hospId = 'HOSP-FI-E';
    const emgId = 'EMG-FI-E';
    const reservationId = 'RES-ICU_BED-FI-E-UNCOMPENSATED';

    // Simulate reservation marked CANCELLED / RELEASED, but process crashed before Hospital CAS executed
    await createTestHospital(hospId, {
      icuBeds: 4,
      incomingAmbulances: 1,
      activeReservationIds: [reservationId],
    });
    await createTestEmergency(emgId);

    await HospitalReservation.create({
      _id: reservationId,
      emergencyId: emgId,
      hospitalId: hospId,
      resourceType: 'ICU_BED',
      status: 'CANCELLED',
      capacityApplied: true,
      capacityCompensated: false, // Uncompensated!
      allocatedUnits: 1,
      bedTypeDecremented: 'icuBeds',
      incomingAmbulanceIncremented: true,
      claimToken: 'clm-e-uncompensated',
      expiresAt: new Date(Date.now() + 100_000),
    });

    // Run reconciliation scan
    const recon = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(recon.interruptedCount).toBeGreaterThanOrEqual(1);

    // Hospital capacity counters MUST now be compensated
    const restoredHosp = await Hospital.findById(hospId).lean();
    expect(restoredHosp?.icuBeds).toBe(5);
    expect(restoredHosp?.incomingAmbulances).toBe(0);
    expect(restoredHosp?.activeReservationIds).not.toContain(reservationId);

    // Reservation document now has capacityCompensated: true
    const resDoc = await HospitalReservation.findById(reservationId).lean();
    expect(resDoc?.capacityCompensated).toBe(true);
  });

  it('6. Concurrency Safety: Multiple concurrent reconciliation workers never double-compensate', async () => {
    const hospId = 'HOSP-FI-CONC-1';
    const emgId = 'EMG-FI-CONC-1';
    const reservationId = 'RES-ICU_BED-CONC-MULTI';

    // 1 bed decremented, 1 incoming ambulance
    await createTestHospital(hospId, {
      icuBeds: 2,
      incomingAmbulances: 1,
      activeReservationIds: [reservationId],
    });
    await createTestEmergency(emgId);

    await HospitalReservation.create({
      _id: reservationId,
      emergencyId: emgId,
      hospitalId: hospId,
      resourceType: 'ICU_BED',
      status: 'EXPIRED',
      capacityApplied: true,
      capacityCompensated: false,
      allocatedUnits: 1,
      bedTypeDecremented: 'icuBeds',
      incomingAmbulanceIncremented: true,
      claimToken: 'clm-conc',
      expiresAt: new Date(Date.now() - 10_000),
    });

    // Launch 5 reconciliation runs concurrently
    const results = await Promise.all([
      reconcileHospitalReservations({ gracePeriodMs: 0 }),
      reconcileHospitalReservations({ gracePeriodMs: 0 }),
      reconcileHospitalReservations({ gracePeriodMs: 0 }),
      reconcileHospitalReservations({ gracePeriodMs: 0 }),
      reconcileHospitalReservations({ gracePeriodMs: 0 }),
    ]);

    // Counters must have been compensated EXACTLY once (icuBeds 2 -> 3, incomingAmbulances 1 -> 0)
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(3);
    expect(hospital?.incomingAmbulances).toBe(0);
    expect(hospital?.activeReservationIds).not.toContain(reservationId);

    // Total interrupted/reconciled count across all workers must be exactly 1
    const totalReconciled = results.reduce(
      (sum, r) => sum + r.interruptedCount + r.expiredCount + r.orphanedCount,
      0,
    );
    expect(totalReconciled).toBe(1);
  });

  it('7. Duplicate Release Safety: Multiple release calls return alreadyReleased and never mutate counters', async () => {
    const hospId = 'HOSP-FI-DUPREL';
    const emgId = 'EMG-FI-DUPREL';

    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const res = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED');
    expect(res.status).toBe('CONFIRMED');

    // First release
    const rel1 = await releaseHospitalReservation(res._id, { reason: 'FIRST_RELEASE' });
    expect(rel1.released).toBe(true);
    expect(rel1.alreadyReleased).toBe(false);

    // Second release (sequential)
    const rel2 = await releaseHospitalReservation(res._id, { reason: 'SECOND_RELEASE' });
    expect(rel2.released).toBe(false);
    expect(rel2.alreadyReleased).toBe(true);

    // Concurrent duplicate releases
    const [rel3, rel4] = await Promise.all([
      releaseHospitalReservation(res._id, { reason: 'CONCURRENT_1' }),
      releaseHospitalReservation(res._id, { reason: 'CONCURRENT_2' }),
    ]);
    expect(rel3.released).toBe(false);
    expect(rel3.alreadyReleased).toBe(true);
    expect(rel4.released).toBe(false);
    expect(rel4.alreadyReleased).toBe(true);

    // Final hospital counters must exactly match initial state: 5 beds, 0 incoming
    const finalHosp = await Hospital.findById(hospId).lean();
    expect(finalHosp?.icuBeds).toBe(5);
    expect(finalHosp?.incomingAmbulances).toBe(0);
  });

  it('8. Duplicate Reservation Safety: Idempotent reservation requests do not double-decrement capacity', async () => {
    const hospId = 'HOSP-FI-DUPRES';
    const emgId = 'EMG-FI-DUPRES';

    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const [res1, res2] = await Promise.all([
      reserveHospitalCapacity(emgId, hospId, 'ICU_BED', { idempotencyKey: 'idemp-key-dup' }),
      reserveHospitalCapacity(emgId, hospId, 'ICU_BED', { idempotencyKey: 'idemp-key-dup' }),
    ]);

    expect(res1._id).toBe(res2._id);

    // Capacity must have been decremented exactly once
    const hosp = await Hospital.findById(hospId).lean();
    expect(hosp?.icuBeds).toBe(4);
    expect(hosp?.incomingAmbulances).toBe(1);
    expect(hosp?.activeReservationIds).toHaveLength(1);
  });

  it('9. Invariant Protection: Never restore unreserved capacity or allow negative counters', async () => {
    const hospId = 'HOSP-FI-INVAR';

    // Hospital with 0 incoming ambulances
    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0, activeReservationIds: [] });

    // Attempt to release an unreserved / non-existent reservation ID
    const dummyRelease = await releaseHospitalReservation('RES-FI-NONEXISTENT', { reason: 'MALICIOUS_PROBE' });
    expect(dummyRelease.released).toBe(false);

    // Counters must be completely unchanged
    const hosp = await Hospital.findById(hospId).lean();
    expect(hosp?.icuBeds).toBe(5);
    expect(hosp?.incomingAmbulances).toBe(0);
  });

  it('10. Dry-Run Isolation: Dispatch dry-run evaluation never mutates database state', async () => {
    const hospId = 'HOSP-DRYRUN-ISOL';
    const emgId = 'EMG-DRYRUN-ISOL';
    const ambId = 'AMB-DRYRUN-ISOL';

    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    await Ambulance.findOneAndUpdate(
      { _id: ambId },
      {
        $set: {
          licensePlate: 'DL-01-DRY-99',
          status: 'AVAILABLE',
          type: 'ALS',
          active: true,
          location: { lat: 28.614, lng: 77.216, address: 'Ambulance Post' },
          geo: { type: 'Point', coordinates: [77.216, 28.614] },
          lastLocationUpdate: new Date(),
          equipment: ['Defibrillator', 'Ventilator'],
        },
      },
      { upsert: true, new: true },
    );

    // Snapshot state before dry-run
    const emgBefore = await Emergency.findById(emgId).lean();
    const hospBefore = await Hospital.findById(hospId).lean();
    const ambBefore = await Ambulance.findById(ambId).lean();
    const resCountBefore = await HospitalReservation.countDocuments({});

    // Execute dry run
    const dryRunResult = await evaluateDispatchDryRun(emgId);

    expect(dryRunResult.dryRun).toBe(true);
    expect(dryRunResult.automatedDispatchEnabled).toBe(false);
    expect(env.AUTOMATED_DISPATCH_ENABLED).toBe(false);
    expect(dryRunResult.raceLimitations).toBeDefined();

    // Snapshot state after dry run
    const emgAfter = await Emergency.findById(emgId).lean();
    const hospAfter = await Hospital.findById(hospId).lean();
    const ambAfter = await Ambulance.findById(ambId).lean();
    const resCountAfter = await HospitalReservation.countDocuments({});

    // Invariants: ZERO mutations to emergency, hospital, ambulance, or reservations
    expect(emgAfter?.status).toBe(emgBefore?.status);
    expect(emgAfter?.destinationHospital).toBe(emgBefore?.destinationHospital);
    expect(emgAfter?.assignedAmbulance).toBe(emgBefore?.assignedAmbulance);

    expect(hospAfter?.icuBeds).toBe(hospBefore?.icuBeds);
    expect(hospAfter?.incomingAmbulances).toBe(hospBefore?.incomingAmbulances);
    expect(hospAfter?.activeReservationIds).toEqual(hospBefore?.activeReservationIds);

    expect(ambAfter?.status).toBe(ambBefore?.status);
    expect(ambAfter?.currentEmergencyId).toBe(ambBefore?.currentEmergencyId);

    expect(resCountAfter).toBe(resCountBefore);
  });

  it('11. Dangling Claim Recovery: Verifies all 4 resource types reverse exact counters without phantom bed restorations', async () => {
    const hospId = 'HOSP-ALL-4-TYPES';
    const claimIcu = 'RES-ICU_BED-DANGLING-ICU';
    const claimGen = 'RES-GENERAL_BED-DANGLING-GEN';
    const claimTrauma = 'RES-TRAUMA_BAY-DANGLING-TRM';
    const claimEmerg = 'RES-EMERGENCY_ACCEPTANCE-DANGLING-EMG';

    // Baseline: Hospital has 4 incoming ambulances, 2 ICU beds (was 3), 9 General beds (was 10)
    // Trauma bay and Emergency acceptance never decremented beds.
    await createTestHospital(hospId, {
      icuBeds: 2,
      generalBeds: 9,
      incomingAmbulances: 4,
      activeReservationIds: [claimIcu, claimGen, claimTrauma, claimEmerg],
    });

    // Run reconciliation sweep
    const recon = await reconcileHospitalReservations();
    expect(recon.danglingClaimsRecoveredCount).toBe(4);
    expect(recon.reconciledReservations).toContain(claimIcu);
    expect(recon.reconciledReservations).toContain(claimGen);
    expect(recon.reconciledReservations).toContain(claimTrauma);
    expect(recon.reconciledReservations).toContain(claimEmerg);

    // Verify exact counter restoration:
    // - incomingAmbulances: 4 -> 0 (-4)
    // - icuBeds: 2 -> 3 (+1)
    // - generalBeds: 9 -> 10 (+1)
    // - activeReservationIds: all 4 claims removed
    const hospAfter = await Hospital.findById(hospId).lean();
    expect(hospAfter?.incomingAmbulances).toBe(0);
    expect(hospAfter?.icuBeds).toBe(3);
    expect(hospAfter?.generalBeds).toBe(10);
    expect(hospAfter?.activeReservationIds).toHaveLength(0);
  });

  it('12. Inconsistency Self-Healing: Heals capacityCompensated when claim is already absent from activeReservationIds', async () => {
    const hospId = 'HOSP-HEAL-COMP';
    const emgId = 'EMG-HEAL-COMP';
    const resId = 'RES-ICU_BED-HEAL-RACE';

    // Simulate scenario: Thread A previously removed resId from activeReservationIds and compensated Hospital,
    // but crashed before setting capacityCompensated: true on HospitalReservation.
    await createTestHospital(hospId, {
      icuBeds: 5,
      incomingAmbulances: 0,
      activeReservationIds: [], // resId is already absent!
    });
    await createTestEmergency(emgId);

    await HospitalReservation.create({
      _id: resId,
      emergencyId: emgId,
      hospitalId: hospId,
      resourceType: 'ICU_BED',
      status: 'RELEASED',
      capacityApplied: true,
      capacityCompensated: false, // Inconsistent with Hospital.activeReservationIds!
      allocatedUnits: 1,
      bedTypeDecremented: 'icuBeds',
      incomingAmbulanceIncremented: true,
      claimToken: 'clm-heal-race',
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Run reconciliation
    const recon = await reconcileHospitalReservations({ gracePeriodMs: 0 });

    // Reservation document must now have capacityCompensated: true (self-healed)
    const resDoc = await HospitalReservation.findById(resId).lean();
    expect(resDoc?.capacityCompensated).toBe(true);

    // Hospital counters must NOT have been double-compensated (remains 5 beds, 0 incoming)
    const hospDoc = await Hospital.findById(hospId).lean();
    expect(hospDoc?.icuBeds).toBe(5);
    expect(hospDoc?.incomingAmbulances).toBe(0);

    // Subsequent reconciliation sweep sees 0 uncompensated items (no infinite loop)
    const recon2 = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(recon2.interruptedCount).toBe(0);
  });

  it('13. TRAUMA_BAY and EMERGENCY_ACCEPTANCE lifecycle: only modifies incomingAmbulances, never beds', async () => {
    const hospId = 'HOSP-TRAUMA-EMG-LIFE';
    const emg1 = 'EMG-LIFE-TRAUMA';
    const emg2 = 'EMG-LIFE-ACCEPT';

    await createTestHospital(hospId, {
      icuBeds: 5,
      generalBeds: 10,
      incomingAmbulances: 0,
    });
    await createTestEmergency(emg1);
    await createTestEmergency(emg2);

    // Reserve TRAUMA_BAY
    const resTrauma = await reserveHospitalCapacity(emg1, hospId, 'TRAUMA_BAY');
    expect(resTrauma.status).toBe('CONFIRMED');
    expect(resTrauma.bedTypeDecremented).toBeNull();

    // Reserve EMERGENCY_ACCEPTANCE
    const resAccept = await reserveHospitalCapacity(emg2, hospId, 'EMERGENCY_ACCEPTANCE');
    expect(resAccept.status).toBe('CONFIRMED');
    expect(resAccept.bedTypeDecremented).toBeNull();

    // Check counters: incomingAmbulances = 2, beds untouched
    const hospMid = await Hospital.findById(hospId).lean();
    expect(hospMid?.incomingAmbulances).toBe(2);
    expect(hospMid?.icuBeds).toBe(5);
    expect(hospMid?.generalBeds).toBe(10);
    expect(hospMid?.activeReservationIds).toContain(resTrauma._id);
    expect(hospMid?.activeReservationIds).toContain(resAccept._id);

    // Release both
    const rel1 = await releaseHospitalReservation(resTrauma._id);
    const rel2 = await releaseHospitalReservation(resAccept._id);
    expect(rel1.released).toBe(true);
    expect(rel2.released).toBe(true);

    // Final counters: incomingAmbulances = 0, beds untouched
    const hospFinal = await Hospital.findById(hospId).lean();
    expect(hospFinal?.incomingAmbulances).toBe(0);
    expect(hospFinal?.icuBeds).toBe(5);
    expect(hospFinal?.generalBeds).toBe(10);
    expect(hospFinal?.activeReservationIds).toHaveLength(0);
  });
});
