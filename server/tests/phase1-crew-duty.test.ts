import { describe, expect, it } from 'vitest';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { Ambulance, Emergency, Shift, User } from '../src/models/index.js';
import { verifyAmbulanceCrewDuty } from '../src/services/crewDutyService.js';

useTestDatabase(runSeed);

describe('Phase 1 - Active Shift and Crew-Duty Verification Service', () => {
  const TEST_AMBULANCE_ID = 'AMB-TEST-001';
  const OTHER_AMBULANCE_ID = 'AMB-TEST-002';
  const CREW_USER_ID_1 = 'USR-TEST-CREW-1';
  const CREW_USER_ID_2 = 'USR-TEST-CREW-2';
  const INACTIVE_USER_ID = 'USR-TEST-INACTIVE';
  const NON_CREW_USER_ID = 'USR-TEST-CITIZEN';

  async function setupTestEntities() {
    const now = new Date('2026-10-29T12:00:00.000Z');

    // Create test users
    await User.create([
      {
        _id: CREW_USER_ID_1,
        name: 'Paramedic One',
        email: 'paramedic1@test.com',
        passwordHash: 'dummy',
        role: 'AMBULANCE_CREW',
        active: true,
      },
      {
        _id: CREW_USER_ID_2,
        name: 'Paramedic Two',
        email: 'paramedic2@test.com',
        passwordHash: 'dummy',
        role: 'AMBULANCE_CREW',
        active: true,
      },
      {
        _id: INACTIVE_USER_ID,
        name: 'Inactive Crew',
        email: 'inactive@test.com',
        passwordHash: 'dummy',
        role: 'AMBULANCE_CREW',
        active: false,
      },
      {
        _id: NON_CREW_USER_ID,
        name: 'Citizen Bob',
        email: 'citizenbob@test.com',
        passwordHash: 'dummy',
        role: 'CITIZEN',
        active: true,
      },
    ]);

    // Create test ambulances with explicit roster
    await Ambulance.create([
      {
        _id: TEST_AMBULANCE_ID,
        status: 'AVAILABLE',
        active: true,
        location: { lat: 28.6139, lng: 77.209 },
        speed: 0,
        heading: 0,
        crew: [
          { _id: 'C-01', name: 'Paramedic One', role: 'Driver', certification: ['ALS'], userId: CREW_USER_ID_1 },
          { _id: 'C-02', name: 'Paramedic Two', role: 'Medic', certification: ['BLS'], userId: CREW_USER_ID_2 },
        ],
        capabilities: ['Trauma', 'ICU'],
        lastUpdated: now,
      },
      {
        _id: OTHER_AMBULANCE_ID,
        status: 'AVAILABLE',
        active: true,
        location: { lat: 28.62, lng: 77.21 },
        speed: 0,
        heading: 0,
        crew: [],
        capabilities: ['Basic'],
        lastUpdated: now,
      },
    ]);

    return now;
  }

  it('disqualifies when ambulance has no active shift', async () => {
    const now = await setupTestEntities();

    // No shift created yet
    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('NO_ACTIVE_SHIFT');
  });

  it('disqualifies when shift is planned or completed rather than active', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.create({
      _id: 'SH-PLANNED-1',
      title: 'Planned Shift',
      status: 'PLANNED',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: [CREW_USER_ID_1],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('NO_ACTIVE_SHIFT');
  });

  it('disqualifies when evaluation time is outside the shift startsAt..endsAt window', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    const pastShift = await Shift.create({
      _id: 'SH-EXPIRED-1',
      title: 'Yesterday Shift',
      status: 'ACTIVE',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: [CREW_USER_ID_1],
      startsAt: new Date('2026-10-28T08:00:00.000Z'),
      endsAt: new Date('2026-10-28T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('SHIFT_OUTSIDE_WINDOW');
    expect(result.shiftId).toBe(pastShift._id);
  });

  it('disqualifies when multiple concurrent active shifts exist for the same ambulance', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.deleteMany({ ambulanceId: TEST_AMBULANCE_ID });

    await Shift.create([
      {
        _id: 'SH-CONCURRENT-1',
        title: 'Shift A',
        status: 'ACTIVE',
        ambulanceId: TEST_AMBULANCE_ID,
        crewIds: [CREW_USER_ID_1],
        startsAt: new Date('2026-10-29T08:00:00.000Z'),
        endsAt: new Date('2026-10-29T16:00:00.000Z'),
        createdBy: 'USR-001',
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: 'SH-CONCURRENT-2',
        title: 'Shift B',
        status: 'ACTIVE',
        ambulanceId: TEST_AMBULANCE_ID,
        crewIds: [CREW_USER_ID_2],
        startsAt: new Date('2026-10-29T10:00:00.000Z'),
        endsAt: new Date('2026-10-29T18:00:00.000Z'),
        createdBy: 'USR-001',
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('MULTIPLE_ACTIVE_SHIFTS');
  });

  it('disqualifies when shift crew member is not on the ambulance roster', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.deleteMany({ ambulanceId: TEST_AMBULANCE_ID });

    await Shift.create({
      _id: 'SH-UNROSTERED-1',
      title: 'Unrostered Crew Shift',
      status: 'ACTIVE',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: ['USR-FOREIGN-CREW'],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('CREW_ROSTER_MISMATCH');
  });

  it('disqualifies when crew user account is inactive or not found', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.deleteMany({ ambulanceId: TEST_AMBULANCE_ID });

    // Update roster to include inactive user
    await Ambulance.updateOne(
      { _id: TEST_AMBULANCE_ID },
      { $push: { crew: { _id: 'C-INACT', name: 'Inactive', role: 'Driver', userId: INACTIVE_USER_ID } } },
    );

    await Shift.create({
      _id: 'SH-INACTIVE-CREW',
      title: 'Inactive Shift',
      status: 'ACTIVE',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: [INACTIVE_USER_ID],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('CREW_USER_NOT_FOUND_OR_INACTIVE');
  });

  it('disqualifies when user account does not have AMBULANCE_CREW role', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.deleteMany({ ambulanceId: TEST_AMBULANCE_ID });

    // Put citizen on roster
    await Ambulance.updateOne(
      { _id: TEST_AMBULANCE_ID },
      { $push: { crew: { _id: 'C-CITIZEN', name: 'Citizen', role: 'Passenger', userId: NON_CREW_USER_ID } } },
    );

    await Shift.create({
      _id: 'SH-WRONG-ROLE',
      title: 'Wrong Role Shift',
      status: 'ACTIVE',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: [NON_CREW_USER_ID],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('CREW_ROLE_INVALID');
  });

  it('disqualifies when crew member is currently assigned to an active emergency', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    await Shift.deleteMany({ ambulanceId: TEST_AMBULANCE_ID });

    // Valid shift with CREW_USER_ID_1
    await Shift.create({
      _id: 'SH-ACTIVE-VALID',
      title: 'Duty Shift',
      status: 'ACTIVE',
      ambulanceId: TEST_AMBULANCE_ID,
      crewIds: [CREW_USER_ID_1],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    // Create an ongoing emergency assigning CREW_USER_ID_1
    const activeIncident = await Emergency.create({
      _id: 'EMG-ACTIVE-DUTY-1',
      incidentType: 'CARDIAC_ARREST',
      priority: 'CRITICAL',
      status: 'EN_ROUTE',
      source: 'DISPATCHER',
      description: 'Active emergency assignment for paramedic one',
      reportedAt: now,
      assignedCrewIds: [CREW_USER_ID_1],
      location: { lat: 28.6, lng: 77.2 },
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('CREW_ASSIGNED_TO_ACTIVE_EMERGENCY');
    expect(result.activeEmergencyId).toBe(activeIncident._id);

    // Complete the emergency -> should resolve conflict
    await Emergency.updateOne({ _id: activeIncident._id }, { $set: { status: 'COMPLETED' } });
    const clearedResult = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(clearedResult.eligible).toBe(true);
  });

  it('disqualifies when crew member is assigned to an overlapping active shift on another ambulance', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');

    // Create overlapping active shift for CREW_USER_ID_1 on OTHER_AMBULANCE_ID
    const overlapping = await Shift.create({
      _id: 'SH-OVERLAP-ANOTHER-AMB',
      title: 'Moonlighting on Amb 2',
      status: 'ACTIVE',
      ambulanceId: OTHER_AMBULANCE_ID,
      crewIds: [CREW_USER_ID_1],
      startsAt: new Date('2026-10-29T08:00:00.000Z'),
      endsAt: new Date('2026-10-29T16:00:00.000Z'),
      createdBy: 'USR-001',
      createdAt: now,
      updatedAt: now,
    });

    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(false);
    expect(result.disqualificationReason).toBe('CREW_OVERLAPPING_SHIFT_ON_OTHER_AMBULANCE');
    expect(result.conflictingShiftId).toBe(overlapping._id);

    // Remove overlapping shift
    await Shift.deleteOne({ _id: overlapping._id });
  });

  it('approves candidate when exactly one active shift has valid verified crew', async () => {
    const now = new Date('2026-10-29T12:00:00.000Z');
    const result = await verifyAmbulanceCrewDuty(TEST_AMBULANCE_ID, { atTime: now });
    expect(result.eligible).toBe(true);
    expect(result.ambulanceId).toBe(TEST_AMBULANCE_ID);
    expect(result.shiftId).toBe('SH-ACTIVE-VALID');
    expect(result.verifiedCrewIds).toEqual([CREW_USER_ID_1]);
  });
});
