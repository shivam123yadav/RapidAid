import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Hospital, Emergency, HospitalReservation, AuditLog } from '../src/models/index.js';
import {
  reserveHospitalCapacity,
  releaseHospitalReservation,
  rerouteHospitalReservation,
  reconcileHospitalReservations,
} from '../src/services/hospitalReservationService.js';
import { transitionEmergency, overrideEmergency } from '../src/services/emergencyService.js';
import { ApiError } from '../src/utils/errors.js';

useTestDatabase(runSeed);

describe('Gate 2 — Hospital Capacity & Reservation Lifecycle', () => {
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
    } = {},
  ) {
    return Hospital.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          name: `Test Facility ${id}`,
          status: overrides.status ?? 'OPERATIONAL',
          emergencyCapacity: overrides.emergencyCapacity ?? 'AVAILABLE',
          icuCapacity: overrides.icuCapacity ?? 'AVAILABLE',
          icuBeds: overrides.icuBeds ?? 5,
          generalBeds: overrides.generalBeds ?? 10,
          traumaAvailable: overrides.traumaAvailable ?? true,
          incomingAmbulances: overrides.incomingAmbulances ?? 0,
          active: overrides.active ?? true,
          location: { lat: 28.61, lng: 77.21, address: 'Test Location' },
          geo: { type: 'Point', coordinates: [77.21, 28.61] },
          phone: '+91-11-20000000',
          currentLoad: 50,
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
    } = {},
  ) {
    return Emergency.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: overrides.status ?? 'REPORTED',
          priority: overrides.priority ?? 'HIGH',
          incidentType: overrides.incidentType ?? 'VEHICLE_COLLISION',
          destinationHospital: overrides.destinationHospital,
          location: { lat: 28.612, lng: 77.215, address: 'Test Scene' },
          source: 'DISPATCHER',
          description: `Test emergency ${id}`,
          victimCount: 1,
          reportedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }

  it('1. Competing emergencies: Two emergencies competing for the last available ICU bed -> exactly one succeeds', async () => {
    const hospId = 'HOSP-COMPETE-1';
    const emg1 = 'EMG-COMP-1';
    const emg2 = 'EMG-COMP-2';

    // Set exactly 1 ICU bed available and 0 incoming ambulances
    await createTestHospital(hospId, { icuBeds: 1, incomingAmbulances: 0 });
    await createTestEmergency(emg1);
    await createTestEmergency(emg2);

    // Launch competing reservations concurrently
    const [result1, result2] = await Promise.allSettled([
      reserveHospitalCapacity(emg1, hospId, 'ICU_BED', { actor: 'dispatcher1' }),
      reserveHospitalCapacity(emg2, hospId, 'ICU_BED', { actor: 'dispatcher2' }),
    ]);

    const successes = [result1, result2].filter((r) => r.status === 'fulfilled');
    const failures = [result1, result2].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    // Verify error was 409 Conflict with capacity exhaustion details
    const failedReason = (failures[0] as PromiseRejectedResult).reason;
    expect(failedReason).toBeInstanceOf(ApiError);
    expect((failedReason as ApiError).status).toBe(409);
    expect((failedReason as ApiError).message).toContain('ICU capacity exhausted');

    // Verify hospital capacity invariants: icuBeds decremented exactly once to 0, incomingAmbulances incremented to 1
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(0);
    expect(hospital?.incomingAmbulances).toBe(1);

    // Exactly 1 reservation document created
    const reservations = await HospitalReservation.find({ hospitalId: hospId }).lean();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].status).toBe('CONFIRMED');
    expect(reservations[0].bedTypeDecremented).toBe('icuBeds');

    // Verify audit log recorded failed attempt
    const failedAudit = await AuditLog.findOne({
      action: 'hospital.reservation_failed',
      resourceId: hospId,
      result: 'FAILURE',
    }).lean();
    expect(failedAudit).toBeTruthy();
    expect(failedAudit?.details).toContain('ICU capacity exhausted');
  });

  it('2. Reservation creation idempotency: repeated calls for the same active emergency return the existing reservation without double-decrementing', async () => {
    const hospId = 'HOSP-IDEMP-1';
    const emgId = 'EMG-IDEMP-1';

    await createTestHospital(hospId, { icuBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const first = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED');
    expect(first.status).toBe('CONFIRMED');

    const second = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED');
    expect(second._id).toBe(first._id);
    expect(second.claimToken).toBe(first.claimToken);

    // Hospital counters must be adjusted only once
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(4);
    expect(hospital?.incomingAmbulances).toBe(1);

    // Only one reservation document in collection
    const count = await HospitalReservation.countDocuments({ emergencyId: emgId });
    expect(count).toBe(1);
  });

  it('3. Reservation release idempotency: releasing an already released reservation is a safe no-op without double-incrementing counters', async () => {
    const hospId = 'HOSP-REL-IDEMP-1';
    const emgId = 'EMG-REL-IDEMP-1';

    await createTestHospital(hospId, { icuBeds: 3, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const reservation = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED');

    // First release
    const release1 = await releaseHospitalReservation(reservation._id, { reason: 'TEST_RELEASE' });
    expect(release1.released).toBe(true);
    expect(release1.alreadyReleased).toBe(false);

    // Second release (idempotent call)
    const release2 = await releaseHospitalReservation(reservation._id, { reason: 'TEST_RELEASE_AGAIN' });
    expect(release2.released).toBe(false);
    expect(release2.alreadyReleased).toBe(true);

    // Counters restored exactly once: icuBeds back to 3, incomingAmbulances back to 0
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(3);
    expect(hospital?.incomingAmbulances).toBe(0);
  });

  it('4. Cancellation lifecycle: cancelling an emergency automatically releases its hospital reservation and restores capacity', async () => {
    const hospId = 'HOSP-CANCEL-1';
    const emgId = 'EMG-CANCEL-1';

    await createTestHospital(hospId, { generalBeds: 8, incomingAmbulances: 0 });
    await createTestEmergency(emgId, { status: 'DISPATCHING' });

    const reservation = await reserveHospitalCapacity(emgId, hospId, 'GENERAL_BED');
    expect(reservation.status).toBe('CONFIRMED');

    // Hospital capacity reflects the reservation
    let hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.generalBeds).toBe(7);
    expect(hospital?.incomingAmbulances).toBe(1);

    // Transition emergency to CANCELLED
    await transitionEmergency(emgId, 'CANCELLED', {
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      requestId: 'req-cancel-1',
    });

    // Verification: Reservation marked CANCELLED
    const updatedRes = await HospitalReservation.findById(reservation._id).lean();
    expect(updatedRes?.status).toBe('CANCELLED');
    expect(updatedRes?.releaseReason).toBe('EMERGENCY_CANCELLED');

    // Hospital capacity fully restored
    hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.generalBeds).toBe(8);
    expect(hospital?.incomingAmbulances).toBe(0);
  });

  it('5. Completion lifecycle: completing an emergency marks its reservation COMPLETED and restores capacity', async () => {
    const hospId = 'HOSP-COMPL-1';
    const emgId = 'EMG-COMPL-1';

    await createTestHospital(hospId, { generalBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId, { status: 'AT_HOSPITAL' });

    const reservation = await reserveHospitalCapacity(emgId, hospId, 'GENERAL_BED');

    // Transition emergency to COMPLETED
    await transitionEmergency(emgId, 'COMPLETED', {
      actor: 'dispatcher1',
      actorRole: 'DISPATCHER',
      requestId: 'req-compl-1',
    });

    const updatedRes = await HospitalReservation.findById(reservation._id).lean();
    expect(updatedRes?.status).toBe('COMPLETED');
    expect(updatedRes?.releaseReason).toBe('EMERGENCY_COMPLETED');

    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.generalBeds).toBe(5);
    expect(hospital?.incomingAmbulances).toBe(0);
  });

  it('6. Rerouting: Rerouting emergency from Hospital A to Hospital B reserves B, releases A, and updates emergency link', async () => {
    const hospA = 'HOSP-REROUTE-A';
    const hospB = 'HOSP-REROUTE-B';
    const emgId = 'EMG-REROUTE-1';

    await createTestHospital(hospA, { generalBeds: 4, incomingAmbulances: 0 });
    await createTestHospital(hospB, { generalBeds: 6, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    // Reserve at Hosp A
    const resA = await reserveHospitalCapacity(emgId, hospA, 'GENERAL_BED');
    expect(resA.status).toBe('CONFIRMED');

    // Reroute to Hosp B
    const resB = await rerouteHospitalReservation(emgId, hospB, 'GENERAL_BED');
    expect(resB.hospitalId).toBe(hospB);
    expect(resB.status).toBe('CONFIRMED');

    // Hosp A reservation released
    const updatedA = await HospitalReservation.findById(resA._id).lean();
    expect(updatedA?.status).toBe('RELEASED');
    expect(updatedA?.releaseReason).toContain('REROUTED_TO_HOSP-REROUTE-B');

    // Hosp A capacity restored
    const hospADoc = await Hospital.findById(hospA).lean();
    expect(hospADoc?.generalBeds).toBe(4);
    expect(hospADoc?.incomingAmbulances).toBe(0);

    // Hosp B capacity reserved
    const hospBDoc = await Hospital.findById(hospB).lean();
    expect(hospBDoc?.generalBeds).toBe(5);
    expect(hospBDoc?.incomingAmbulances).toBe(1);

    // Emergency reflects new destination and reservation ID
    const updatedEmg = await Emergency.findById(emgId).lean();
    expect(updatedEmg?.destinationHospital).toBe(hospB);
    expect(updatedEmg?.hospitalReservationId).toBe(resB._id);
  });

  it('7. Failed rerouting: If reservation at new hospital fails, old reservation is preserved untouched', async () => {
    const hospA = 'HOSP-FAILROUTE-A';
    const hospB = 'HOSP-FAILROUTE-B';
    const emgId = 'EMG-FAILROUTE-1';

    await createTestHospital(hospA, { generalBeds: 4, incomingAmbulances: 0 });
    // Hosp B is FULL
    await createTestHospital(hospB, { emergencyCapacity: 'FULL', generalBeds: 0 });
    await createTestEmergency(emgId);

    const resA = await reserveHospitalCapacity(emgId, hospA, 'GENERAL_BED');

    // Attempt rerouting to Hosp B (should fail with conflict)
    await expect(
      rerouteHospitalReservation(emgId, hospB, 'GENERAL_BED'),
    ).rejects.toThrow(ApiError);

    // Hosp A reservation remains CONFIRMED
    const intactA = await HospitalReservation.findById(resA._id).lean();
    expect(intactA?.status).toBe('CONFIRMED');

    // Emergency destination remains Hosp A
    const emgDoc = await Emergency.findById(emgId).lean();
    expect(emgDoc?.destinationHospital).toBe(hospA);
    expect(emgDoc?.hospitalReservationId).toBe(resA._id);
  });

  it('8. Process failure between capacity update and reservation persistence: immediate compensation restores counters', async () => {
    const hospId = 'HOSP-CRASH-1';
    const emgId = 'EMG-CRASH-1';

    await createTestHospital(hospId, { icuBeds: 3, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    // Inject failure after capacity reservation before persistence
    await expect(
      reserveHospitalCapacity(emgId, hospId, 'ICU_BED', {
        beforePersistenceHook: async () => {
          throw new Error('Simulated process crash / network drop before persistence');
        },
      }),
    ).rejects.toThrow('Simulated process crash / network drop before persistence');

    // Counters must be compensated back to original
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(3);
    expect(hospital?.incomingAmbulances).toBe(0);

    // No reservation document persisted
    const resCount = await HospitalReservation.countDocuments({ hospitalId: hospId });
    expect(resCount).toBe(0);
  });

  it('9. Expired reservation recovery: reconciliation finds expired reservation, transitions to EXPIRED, and restores capacity', async () => {
    const hospId = 'HOSP-EXPIRE-1';
    const emgId = 'EMG-EXPIRE-1';

    await createTestHospital(hospId, { icuBeds: 2, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    // Create reservation with past expiry (-10 seconds)
    const reservation = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED', {
      expiryMs: -10_000,
    });

    let hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(1);
    expect(hospital?.incomingAmbulances).toBe(1);

    // Run reconciliation scan
    const outcome = await reconcileHospitalReservations();
    expect(outcome.expiredCount).toBeGreaterThanOrEqual(1);
    expect(outcome.reconciledReservations).toContain(reservation._id);

    // Reservation updated to EXPIRED
    const resDoc = await HospitalReservation.findById(reservation._id).lean();
    expect(resDoc?.status).toBe('EXPIRED');
    expect(resDoc?.releaseReason).toBe('RESERVATION_TTL_EXPIRED');

    // Capacity restored
    hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(2);
    expect(hospital?.incomingAmbulances).toBe(0);

    // Audit log written
    const audit = await AuditLog.findOne({
      action: 'hospital.reservation_expired',
      resourceId: reservation._id,
    }).lean();
    expect(audit).toBeTruthy();
  });

  it('10. Orphaned reservation recovery: active reservation whose emergency was marked completed or deleted is reconciled', async () => {
    const hospId = 'HOSP-ORPHAN-1';
    const emgId = 'EMG-ORPHAN-1';

    await createTestHospital(hospId, { generalBeds: 5, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const reservation = await reserveHospitalCapacity(emgId, hospId, 'GENERAL_BED');

    // Simulate direct status update or out-of-band completion on emergency
    await Emergency.updateOne(
      { _id: emgId },
      { $set: { status: 'COMPLETED', updatedAt: new Date() } },
    );

    // Backdate reservation createdAt so it passes the grace period
    const pastTime = new Date(Date.now() - 120_000);
    await HospitalReservation.updateOne({ _id: reservation._id }, { $set: { createdAt: pastTime } });

    // Run reconciliation with gracePeriodMs: 0
    const outcome = await reconcileHospitalReservations({ gracePeriodMs: 0 });
    expect(outcome.orphanedCount).toBeGreaterThanOrEqual(1);
    expect(outcome.reconciledReservations).toContain(reservation._id);

    const resDoc = await HospitalReservation.findById(reservation._id).lean();
    expect(resDoc?.status).toBe('COMPLETED');
    expect(resDoc?.releaseReason).toContain('ORPHANED_EMERGENCY_COMPLETED');

    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.generalBeds).toBe(5);
    expect(hospital?.incomingAmbulances).toBe(0);
  });

  it('11. Multiple reconciliation workers: concurrent reconciliation runs execute safely without race conditions', async () => {
    const hospId = 'HOSP-WORKERS-1';
    const emgId = 'EMG-WORKERS-1';

    await createTestHospital(hospId, { icuBeds: 3, incomingAmbulances: 0 });
    await createTestEmergency(emgId);

    const reservation = await reserveHospitalCapacity(emgId, hospId, 'ICU_BED', {
      expiryMs: -5_000,
    });

    // Run two workers simultaneously
    const [w1, w2] = await Promise.all([
      reconcileHospitalReservations(),
      reconcileHospitalReservations(),
    ]);

    // Total expired count across both runs must be exactly 1
    const totalExpired = w1.expiredCount + w2.expiredCount;
    expect(totalExpired).toBe(1);

    // Final hospital capacity: exactly restored once
    const hospital = await Hospital.findById(hospId).lean();
    expect(hospital?.icuBeds).toBe(3);
    expect(hospital?.incomingAmbulances).toBe(0);

    const resDoc = await HospitalReservation.findById(reservation._id).lean();
    expect(resDoc?.status).toBe('EXPIRED');
  });

  it('12. Preserves Phase 1 manual override route: break-glass ROUTE_HOSPITAL reserves hospital and updates emergency', async () => {
    const hospId = 'HOSP-OVERRIDE-1';
    const emgId = 'EMG-OVERRIDE-1';

    await createTestHospital(hospId, { emergencyCapacity: 'AVAILABLE', incomingAmbulances: 0 });
    await createTestEmergency(emgId, { status: 'DISPATCHING' });

    await overrideEmergency(
      emgId,
      {
        action: 'ROUTE_HOSPITAL',
        hospitalId: hospId,
        reason: 'Break-glass manual hospital routing test',
      },
      {
        actor: 'supervisor1',
        actorRole: 'SUPERVISOR',
        requestId: 'req-override-hosp-1',
      },
    );

    const emg = await Emergency.findById(emgId).lean();
    expect(emg?.destinationHospital).toBe(hospId);
    expect(emg?.hospitalReservationId).toBeTruthy();

    const reservation = await HospitalReservation.findById(emg?.hospitalReservationId).lean();
    expect(reservation?.status).toBe('CONFIRMED');
    expect(reservation?.hospitalId).toBe(hospId);
  });
});
