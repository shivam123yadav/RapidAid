import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, Emergency, Hospital, HospitalReservation, Shift, User, AuditLog } from '../src/models/index.js';
import { evaluateAutomatedDispatchDryRun, RACE_LIMITATIONS_NOTICE } from '../src/services/dispatchDryRunService.js';
import { env } from '../src/config/env.js';
import { ApiError } from '../src/utils/errors.js';

useTestDatabase(runSeed);

describe('Gate 3 & Gate 4 — Automated Dispatch Dry-Run Verification', () => {
  async function createTestEmergency(
    id: string,
    overrides: {
      status?: string;
      priority?: string;
      incidentType?: string;
      location?: { lat: number; lng: number; address?: string };
    } = {},
  ) {
    return Emergency.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          status: overrides.status ?? 'REPORTED',
          priority: overrides.priority ?? 'HIGH',
          incidentType: overrides.incidentType ?? 'VEHICLE_COLLISION',
          location: overrides.location ?? { lat: 28.6139, lng: 77.209, address: 'Connaught Place' },
          source: 'DISPATCHER',
          description: `Test dry-run emergency ${id}`,
          victimCount: 1,
          reportedAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true, new: true },
    );
  }

  async function ensureCrewUser(userId: string) {
    return User.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          name: `Paramedic ${userId}`,
          email: `${userId.toLowerCase()}@rapidaid.test`,
          role: 'AMBULANCE_CREW',
          active: true,
          hospitalId: undefined,
        },
      },
      { upsert: true, new: true },
    );
  }

  async function ensureShiftForAmbulance(
    shiftId: string,
    ambulanceId: string,
    crewUserIds: string[],
    overrides: { status?: 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED'; startTime?: Date; endTime?: Date } = {},
  ) {
    const now = new Date();
    return Shift.findOneAndUpdate(
      { _id: shiftId },
      {
        $set: {
          title: `Shift ${shiftId}`,
          ambulanceId,
          crewIds: crewUserIds,
          status: overrides.status ?? 'ACTIVE',
          startsAt: overrides.startTime ?? new Date(now.getTime() - 2 * 3600 * 1000),
          endsAt: overrides.endTime ?? new Date(now.getTime() + 6 * 3600 * 1000),
          createdBy: 'admin',
          createdAt: now,
          updatedAt: now,
        },
      },
      { upsert: true, new: true },
    );
  }

  async function ensureAmbulanceWithCrew(
    ambulanceId: string,
    overrides: {
      status?: string;
      lastUpdated?: Date;
      crew?: Array<{ name: string; role: string; userId: string }>;
      location?: { lat: number; lng: number };
      capabilities?: string[];
    } = {},
  ) {
    const crew = overrides.crew ?? [
      { name: 'Paramedic A', role: 'PARAMEDIC', userId: `USR-CREW-A-${ambulanceId}` },
      { name: 'Paramedic B', role: 'DRIVER', userId: `USR-CREW-B-${ambulanceId}` },
    ];

    for (const c of crew) {
      await ensureCrewUser(c.userId);
    }

    return Ambulance.findOneAndUpdate(
      { _id: ambulanceId },
      {
        $set: {
          status: overrides.status ?? 'AVAILABLE',
          currentEmergency: null,
          claimToken: null,
          lastUpdated: overrides.lastUpdated ?? new Date(),
          location: overrides.location ?? { lat: 28.615, lng: 77.21 },
          capabilities: overrides.capabilities ?? ['Basic', 'Trauma', 'Oxygen'],
          crew,
          active: true,
        },
      },
      { upsert: true, new: true },
    );
  }

  async function ensureTestHospital(
    hospitalId: string,
    overrides: {
      status?: string;
      emergencyCapacity?: string;
      icuCapacity?: string;
      icuBeds?: number;
      generalBeds?: number;
      traumaAvailable?: boolean;
    } = {},
  ) {
    return Hospital.findOneAndUpdate(
      { _id: hospitalId },
      {
        $set: {
          name: `Facility ${hospitalId}`,
          status: overrides.status ?? 'OPERATIONAL',
          emergencyCapacity: overrides.emergencyCapacity ?? 'AVAILABLE',
          icuCapacity: overrides.icuCapacity ?? 'AVAILABLE',
          icuBeds: overrides.icuBeds ?? 5,
          generalBeds: overrides.generalBeds ?? 10,
          traumaAvailable: overrides.traumaAvailable ?? true,
          incomingAmbulances: 0,
          active: true,
          location: { lat: 28.62, lng: 77.22, address: 'Hospital Ave' },
          geo: { type: 'Point', coordinates: [77.22, 28.62] },
          phone: '+91-11-23000000',
          currentLoad: 40,
        },
      },
      { upsert: true, new: true },
    );
  }

  it('1. Precondition checks: non-existent emergency throws 404', async () => {
    await expect(evaluateAutomatedDispatchDryRun('EMG-NONEXISTENT')).rejects.toThrow(ApiError);
    try {
      await evaluateAutomatedDispatchDryRun('EMG-NONEXISTENT');
    } catch (err) {
      expect((err as ApiError).status).toBe(404);
    }
  });

  it('2. Precondition checks: invalid status (e.g. COMPLETED or AMBULANCE_ASSIGNED) reports ineligible without crashing', async () => {
    const emgId = 'EMG-DRY-STATUS-1';
    await createTestEmergency(emgId, { status: 'COMPLETED' });

    const result = await evaluateAutomatedDispatchDryRun(emgId);
    expect(result.dryRun).toBe(true);
    expect(result.eligible).toBe(false);
    expect(result.preconditionErrors).toBeDefined();
    expect(result.preconditionErrors![0]).toContain('COMPLETED');
    expect(result.recommendedAmbulance).toBeNull();
    expect(result.recommendedHospital).toBeNull();
  });

  it('3. Precondition checks: invalid location coordinates rejected safely', async () => {
    const emgId = 'EMG-DRY-GEO-1';
    await createTestEmergency(emgId, {
      location: { lat: 195.0 /* invalid > 90 */, lng: 77.209, address: 'Invalid lat' },
    });

    const result = await evaluateAutomatedDispatchDryRun(emgId);
    expect(result.eligible).toBe(false);
    expect(result.preconditionErrors).toBeDefined();
    expect(result.preconditionErrors![0]).toContain('latitude');
  });

  it('4. Candidate fallback and strict revalidation: Candidate 1 has stale telemetry -> skipped with exact reason -> falls back to Candidate 2 with fresh telemetry', async () => {
    const emgId = 'EMG-DRY-FALLBACK-1';
    await createTestEmergency(emgId, { priority: 'HIGH', incidentType: 'VEHICLE_COLLISION' });

    const ambStale = 'AMB-DRY-STALE-1';
    const ambFresh = 'AMB-DRY-FRESH-2';
    const hospId = 'HOSP-DRY-1';

    await ensureTestHospital(hospId, { traumaAvailable: true, emergencyCapacity: 'AVAILABLE' });

    // Amb 1 is closer (lat 28.614) but has STALE telemetry (10 minutes old > 300s threshold)
    const staleTime = new Date(Date.now() - 600 * 1000);
    await ensureAmbulanceWithCrew(ambStale, {
      lastUpdated: staleTime,
      location: { lat: 28.614, lng: 77.209 },
      capabilities: ['Basic', 'Trauma', 'Oxygen', 'ICU'],
    });
    await ensureShiftForAmbulance(`SHIFT-${ambStale}`, ambStale, [`USR-CREW-A-${ambStale}`, `USR-CREW-B-${ambStale}`]);

    // Amb 2 is slightly further (lat 28.618) but has FRESH telemetry (10s old) and active shift
    const freshTime = new Date(Date.now() - 10 * 1000);
    await ensureAmbulanceWithCrew(ambFresh, {
      lastUpdated: freshTime,
      location: { lat: 28.618, lng: 77.21 },
      capabilities: ['Basic', 'Trauma', 'Oxygen', 'ICU'],
    });
    await ensureShiftForAmbulance(`SHIFT-${ambFresh}`, ambFresh, [`USR-CREW-A-${ambFresh}`, `USR-CREW-B-${ambFresh}`]);

    const result = await evaluateAutomatedDispatchDryRun(emgId);

    expect(result.dryRun).toBe(true);
    expect(result.eligible).toBe(true);

    // Stale candidate was skipped with recorded reason
    const skipped = result.skippedAmbulances.find((s) => s.ambulanceId === ambStale);
    expect(skipped).toBeDefined();
    expect(skipped?.disqualificationReasons.some((r) => r.includes('Telemetry ineligible'))).toBe(true);

    // Fresh candidate was selected
    expect(result.recommendedAmbulance).toBeDefined();
    expect(result.recommendedAmbulance?.ambulanceId).toBe(ambFresh);
    expect(result.recommendedHospital).toBeDefined();
    expect(result.recommendedHospital?.hospitalId).toBe(hospId);
  });

  it('5. No eligible ambulance: reports clear summary when all available units are ineligible (e.g. stale telemetry)', async () => {
    const emgId = 'EMG-DRY-NO-AMB-1';
    await createTestEmergency(emgId);

    // Mark all available ambulances in the system as stale (> 1000s)
    const staleTime = new Date(Date.now() - 1000 * 1000);
    await Ambulance.updateMany({}, { $set: { lastUpdated: staleTime } });

    await ensureTestHospital('HOSP-VALID-1', { emergencyCapacity: 'AVAILABLE' });

    const result = await evaluateAutomatedDispatchDryRun(emgId);

    expect(result.eligible).toBe(false);
    expect(result.recommendedAmbulance).toBeNull();
    expect(result.summary.toLowerCase()).toContain('no eligible ambulance');
    expect(result.skippedAmbulances.length).toBeGreaterThan(0);
  });

  it('6. No suitable hospital: reports clear summary when all hospitals are FULL or OFFLINE', async () => {
    const emgId = 'EMG-DRY-NO-HOSP-1';
    await createTestEmergency(emgId);

    const ambFresh = 'AMB-DRY-HOSP-CHECK';
    await ensureAmbulanceWithCrew(ambFresh, {
      lastUpdated: new Date(),
      capabilities: ['Basic', 'Trauma', 'Oxygen', 'ICU'],
    });
    await ensureShiftForAmbulance(`SHIFT-${ambFresh}`, ambFresh, [`USR-CREW-A-${ambFresh}`, `USR-CREW-B-${ambFresh}`]);

    // Mark all hospitals OFFLINE or FULL
    await Hospital.updateMany({}, { $set: { emergencyCapacity: 'FULL', icuCapacity: 'FULL', status: 'OFFLINE' } });

    const result = await evaluateAutomatedDispatchDryRun(emgId);

    expect(result.eligible).toBe(false);
    expect(result.recommendedHospital).toBeNull();
    expect(result.summary.toLowerCase()).toContain('no suitable hospital');
    expect(result.skippedHospitals.length).toBeGreaterThan(0);
  });

  it('7. Strict READ-ONLY guarantee: evaluation makes ZERO changes to ambulances, hospitals, emergencies, and creates ZERO reservations', async () => {
    const emgId = 'EMG-DRY-READONLY-1';
    await createTestEmergency(emgId);

    const ambId = 'AMB-DRY-READONLY';
    const hospId = 'HOSP-DRY-READONLY';

    await ensureAmbulanceWithCrew(ambId, { lastUpdated: new Date() });
    await ensureShiftForAmbulance(`SHIFT-${ambId}`, ambId, [`USR-CREW-A-${ambId}`, `USR-CREW-B-${ambId}`]);
    await ensureTestHospital(hospId, { icuBeds: 5, generalBeds: 10, emergencyCapacity: 'AVAILABLE' });

    // Snapshots before dry-run
    const ambBefore = await Ambulance.findById(ambId).lean();
    const hospBefore = await Hospital.findById(hospId).lean();
    const emgBefore = await Emergency.findById(emgId).lean();
    const resCountBefore = await HospitalReservation.countDocuments({});

    // Execute dry run
    const result = await evaluateAutomatedDispatchDryRun(emgId);
    expect(result.dryRun).toBe(true);

    // Snapshots after dry-run
    const ambAfter = await Ambulance.findById(ambId).lean();
    const hospAfter = await Hospital.findById(hospId).lean();
    const emgAfter = await Emergency.findById(emgId).lean();
    const resCountAfter = await HospitalReservation.countDocuments({});

    // 1. Ambulance unchanged
    expect(ambAfter?.status).toBe(ambBefore?.status);
    expect(ambAfter?.currentEmergency).toBe(ambBefore?.currentEmergency);
    expect(ambAfter?.claimToken).toBe(ambBefore?.claimToken);

    // 2. Hospital unchanged
    expect(hospAfter?.generalBeds).toBe(hospBefore?.generalBeds);
    expect(hospAfter?.icuBeds).toBe(hospBefore?.icuBeds);
    expect(hospAfter?.incomingAmbulances).toBe(hospBefore?.incomingAmbulances);

    // 3. Emergency unchanged
    expect(emgAfter?.status).toBe(emgBefore?.status);
    expect(emgAfter?.assignedAmbulance).toBe(emgBefore?.assignedAmbulance);
    expect(emgAfter?.destinationHospital).toBe(emgBefore?.destinationHospital);
    expect(emgAfter?.hospitalReservationId).toBe(emgBefore?.hospitalReservationId);

    // 4. Zero reservations created
    expect(resCountAfter).toBe(resCountBefore);
  });

  it('8. Duplicate dry-run requests: multiple calls produce identical, idempotent evaluations without side effects', async () => {
    const emgId = 'EMG-DRY-DUP-1';
    await createTestEmergency(emgId);

    const ambId = 'AMB-DRY-DUP-1';
    const hospId = 'HOSP-DRY-DUP-1';

    await ensureAmbulanceWithCrew(ambId, { lastUpdated: new Date() });
    await ensureShiftForAmbulance(`SHIFT-${ambId}`, ambId, [`USR-CREW-A-${ambId}`, `USR-CREW-B-${ambId}`]);
    await ensureTestHospital(hospId, { emergencyCapacity: 'AVAILABLE' });

    // Call dry-run 3 times
    const [eval1, eval2, eval3] = await Promise.all([
      evaluateAutomatedDispatchDryRun(emgId),
      evaluateAutomatedDispatchDryRun(emgId),
      evaluateAutomatedDispatchDryRun(emgId),
    ]);

    expect(eval1.eligible).toBe(eval2.eligible);
    expect(eval2.eligible).toBe(eval3.eligible);
    expect(eval1.recommendedAmbulance?.ambulanceId).toBe(eval2.recommendedAmbulance?.ambulanceId);
    expect(eval1.recommendedHospital?.hospitalId).toBe(eval2.recommendedHospital?.hospitalId);

    // Verify 0 reservations were created across all runs
    const resCount = await HospitalReservation.countDocuments({ emergencyId: emgId });
    expect(resCount).toBe(0);
  });

  it('9. Safety boundaries: AUTOMATED_DISPATCH_ENABLED is false and race limitations notice is included', async () => {
    const emgId = 'EMG-DRY-SAFETY-1';
    await createTestEmergency(emgId);

    const result = await evaluateAutomatedDispatchDryRun(emgId);

    expect(env.AUTOMATED_DISPATCH_ENABLED).toBe(false);
    expect(result.automatedDispatchEnabled).toBe(false);
    expect(result.raceLimitations).toBe(RACE_LIMITATIONS_NOTICE);
    expect(result.raceLimitations).toContain('evaluated at point-in-time and is not reserved or locked');

    // Audit log records dry-run evaluation with automated dispatch status
    const audit = await AuditLog.findOne({
      action: 'dispatch.dry_run_evaluated',
      resourceId: emgId,
    }).lean();
    expect(audit).toBeTruthy();
    expect(audit?.details).toContain('AUTOMATED_DISPATCH_ENABLED=false');
  });
});
