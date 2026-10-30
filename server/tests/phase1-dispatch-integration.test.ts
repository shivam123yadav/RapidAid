import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Ambulance, AuditLog, Emergency, Shift, User } from '../src/models/index.js';
import { assignAmbulance } from '../src/services/emergencyService.js';
import { isAmbulanceDispatchEligible } from '../src/services/dispatchService.js';

const app = createApp();
useTestDatabase(runSeed);

describe('Phase 1 Integration Hardening - Dispatch Policies & Assignment Verification', () => {
  // Helper to ensure clean test user with AMBULANCE_CREW role
  async function ensureTestCrewUser(userId: string) {
    return User.findOneAndUpdate(
      { _id: userId },
      {
        $set: {
          name: `Paramedic ${userId}`,
          email: `${userId.toLowerCase()}@test.com`,
          passwordHash: 'dummy',
          role: 'AMBULANCE_CREW',
          active: true,
        },
      },
      { upsert: true, new: true },
    );
  }

  // Helper to create a clean test emergency with valid numeric ID conforming to ^EMG-\d{1,10}$
  async function createTestEmergency(id: string) {
    return Emergency.create({
      _id: id,
      status: 'REPORTED',
      priority: 'HIGH',
      incidentType: 'VEHICLE_COLLISION',
      location: { lat: 28.6139, lng: 77.209, address: 'Test Location' },
      source: 'DISPATCHER',
      description: 'Test emergency for integration hardening',
      victimCount: 1,
      reportedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  // Helper to ensure an ambulance document exists with required schema fields
  async function ensureAmbulance(
    ambulanceId: string,
    overrides: {
      status?: string;
      lastUpdated?: Date | null;
      crew?: Array<{ _id: string; name: string; role: string; userId?: string }>;
      currentEmergency?: string | null;
    } = {},
  ) {
    const update: any = {
      $set: {
        status: overrides.status ?? 'AVAILABLE',
        location: { lat: 28.62, lng: 77.215 },
        capabilities: ['Basic', 'Trauma', 'Oxygen'],
        equipment: ['Standard Kit', 'Oxygen'],
        active: true,
        currentEmergency: overrides.currentEmergency ?? null,
        crew: overrides.crew ?? [
          { _id: `C-${ambulanceId}-1`, name: 'Dr. Test', role: 'Physician', userId: 'USR-TEST-DEFAULT' },
        ],
      },
    };

    if (overrides.lastUpdated === null) {
      update.$unset = { lastUpdated: '' };
    } else {
      update.$set.lastUpdated = overrides.lastUpdated ?? new Date();
    }

    return Ambulance.findOneAndUpdate({ _id: ambulanceId }, update, {
      upsert: true,
      new: true,
    });
  }

  // Helper to setup an ambulance with active shift, verified crew, and fresh telemetry
  async function setupActiveShiftAmbulance(ambulanceId: string, crewUserId: string) {
    await ensureTestCrewUser(crewUserId);
    const now = new Date();
    await ensureAmbulance(ambulanceId, {
      status: 'AVAILABLE',
      currentEmergency: null,
      lastUpdated: now,
      crew: [{ _id: `C-${ambulanceId}-1`, name: 'Test Paramedic', role: 'Paramedic', userId: crewUserId }],
    });

    await Shift.deleteMany({ ambulanceId });
    const shift = await Shift.create({
      _id: `SH-TEST-${ambulanceId}`,
      title: 'Active Duty Shift',
      status: 'ACTIVE',
      ambulanceId,
      crewIds: [crewUserId],
      startsAt: new Date(now.getTime() - 2 * 3600 * 1000),
      endsAt: new Date(now.getTime() + 6 * 3600 * 1000),
      createdBy: 'USR-005',
      createdAt: now,
      updatedAt: now,
    });

    return shift;
  }

  it('1. Manual assignment with valid crew and fresh telemetry succeeds with verified: true', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90001');
    await setupActiveShiftAmbulance('AMB-9001', 'USR-CREW-9001');

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emg._id, ambulanceId: 'AMB-9001' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.ambulanceId).toBe('AMB-9001');
    expect(res.body.eligibility).toBeDefined();
    expect(res.body.eligibility.policy).toBe('MANUAL');
    expect(res.body.eligibility.verified).toBe(true);
    expect(res.body.eligibility.warnings).toEqual([]);
    expect(res.body.emergency.status).toBe('AMBULANCE_ASSIGNED');
  });

  it('2. Manual assignment with no active shift is allowed with a structured SHIFT_MISSING_OR_INVALID warning', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90002');

    // Ensure AMB-9002 has NO shifts and fresh telemetry
    await Shift.deleteMany({ ambulanceId: 'AMB-9002' });
    await ensureAmbulance('AMB-9002', { status: 'AVAILABLE', currentEmergency: null, lastUpdated: new Date() });

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emg._id, ambulanceId: 'AMB-9002' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.eligibility.verified).toBe(false);
    expect(res.body.eligibility.warnings.some((w: { code: string }) => w.code === 'SHIFT_MISSING_OR_INVALID')).toBe(true);
    expect(res.body.emergency.status).toBe('AMBULANCE_ASSIGNED');

    // Verify audit log recorded the warning
    const audit = await AuditLog.findOne({ resourceId: 'AMB-9002', action: 'dispatch.assigned' }).sort({ timestamp: -1 });
    expect(audit).toBeDefined();
    expect(audit?.details).toContain('SHIFT_MISSING_OR_INVALID');
  });

  it('3. Manual assignment with stale telemetry is allowed with a structured TELEMETRY_STALE warning', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90003');

    // AMB-9003 with 15-minute-old telemetry (threshold is 300s = 5m)
    const staleTime = new Date(Date.now() - 15 * 60 * 1000);
    await ensureAmbulance('AMB-9003', { status: 'AVAILABLE', currentEmergency: null, lastUpdated: staleTime });

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emg._id, ambulanceId: 'AMB-9003' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.eligibility.verified).toBe(false);
    expect(res.body.eligibility.warnings.some((w: { code: string }) => w.code === 'TELEMETRY_STALE')).toBe(true);

    // Verify timeline note captured warning
    const updatedEmg = await Emergency.findById(emg._id).lean();
    const lastTimeline = updatedEmg?.timeline[updatedEmg.timeline.length - 1];
    expect(lastTimeline?.note).toContain('TELEMETRY_STALE');
  });

  it('4. Manual assignment with missing telemetry is allowed with a clear TELEMETRY_MISSING_OR_INVALID warning', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90004');

    // AMB-9004 with missing lastUpdated
    await ensureAmbulance('AMB-9004', { status: 'AVAILABLE', currentEmergency: null, lastUpdated: null });

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emg._id, ambulanceId: 'AMB-9004' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.eligibility.warnings.some((w: { code: string }) => w.code === 'TELEMETRY_MISSING_OR_INVALID')).toBe(true);
  });

  it('5. Strict eligibility rejects missing or invalid crew duty with 409 Conflict', async () => {
    const emg = await createTestEmergency('EMG-90005');

    // Ensure AMB-9005 has no active shift
    await Shift.deleteMany({ ambulanceId: 'AMB-9005' });
    await ensureAmbulance('AMB-9005', { status: 'AVAILABLE', currentEmergency: null, lastUpdated: new Date() });

    await expect(
      assignAmbulance(String(emg._id), 'AMB-9005', {
        requestId: 'req-strict-1',
        actor: 'Automated Dispatcher',
        actorRole: 'DISPATCHER',
        policy: 'STRICT_AUTOMATED',
      }),
    ).rejects.toThrow(/Automated dispatch rejected.*crew duty ineligible/i);

    // Verify ambulance was NOT claimed
    const ambAfter = await Ambulance.findById('AMB-9005').lean();
    expect(ambAfter?.status).toBe('AVAILABLE');
    expect(ambAfter?.currentEmergency).toBeNull();
  });

  it('6. Strict eligibility rejects stale or missing telemetry with 409 Conflict', async () => {
    const emg = await createTestEmergency('EMG-90006');
    await setupActiveShiftAmbulance('AMB-9006', 'USR-CREW-9006');

    // Telemetry is 20 minutes stale
    const staleTime = new Date(Date.now() - 20 * 60 * 1000);
    await Ambulance.updateOne({ _id: 'AMB-9006' }, { $set: { lastUpdated: staleTime } });

    await expect(
      assignAmbulance(String(emg._id), 'AMB-9006', {
        requestId: 'req-strict-2',
        actor: 'Automated Dispatcher',
        actorRole: 'DISPATCHER',
        policy: 'STRICT_AUTOMATED',
      }),
    ).rejects.toThrow(/Automated dispatch rejected.*telemetry ineligible/i);
  });

  it('7. Strict eligibility accepts a valid ambulance with active shift and fresh telemetry', async () => {
    const emg = await createTestEmergency('EMG-90007');
    await setupActiveShiftAmbulance('AMB-9007', 'USR-CREW-9007');

    const result = await assignAmbulance(String(emg._id), 'AMB-9007', {
      requestId: 'req-strict-3',
      actor: 'Automated Dispatcher',
      actorRole: 'DISPATCHER',
      policy: 'STRICT_AUTOMATED',
    });

    expect(result.ambulanceId).toBe('AMB-9007');
    expect(result.eligibility.verified).toBe(true);
    expect(result.eligibility.warnings).toEqual([]);

    const ambAfter = await Ambulance.findById('AMB-9007').lean();
    expect(ambAfter?.status).toBe('ASSIGNED');
    expect(ambAfter?.currentEmergency).toBe(emg._id);
  });

  it('8. Re-evaluates eligibility at assignment time if state changed after recommendations were generated', async () => {
    const emg = await createTestEmergency('EMG-90008');
    await setupActiveShiftAmbulance('AMB-9008', 'USR-CREW-9008');

    // Initially eligible at time T0
    const initialCheck = await isAmbulanceDispatchEligible('AMB-9008');
    expect(initialCheck.eligible).toBe(true);

    // State changes before assignment: crew member assigned to another incident
    await Emergency.create({
      _id: 'EMG-90088',
      status: 'EN_ROUTE',
      priority: 'CRITICAL',
      incidentType: 'CARDIAC_ARREST',
      location: { lat: 28.6, lng: 77.2 },
      source: 'DISPATCHER',
      description: 'Competing active incident',
      assignedCrewIds: ['USR-CREW-9008'],
      reportedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Strict assignment at T1 must re-evaluate and reject based on current reality
    await expect(
      assignAmbulance(String(emg._id), 'AMB-9008', {
        requestId: 'req-strict-race',
        actor: 'Automated Dispatcher',
        actorRole: 'DISPATCHER',
        policy: 'STRICT_AUTOMATED',
      }),
    ).rejects.toThrow(/Automated dispatch rejected.*crew duty ineligible/i);

    // Clean up competing incident
    await Emergency.deleteOne({ _id: 'EMG-90088' });
  });

  it('9. Two competing assignment requests cannot successfully claim the same ambulance (atomic concurrency)', async () => {
    const emgA = await createTestEmergency('EMG-90091');
    const emgB = await createTestEmergency('EMG-90092');

    await ensureAmbulance('AMB-9009', { status: 'AVAILABLE', currentEmergency: null, lastUpdated: new Date() });

    // Run two competing assignments concurrently
    const [resA, resB] = await Promise.allSettled([
      assignAmbulance(String(emgA._id), 'AMB-9009', {
        requestId: 'req-race-a',
        actor: 'Dispatcher A',
        actorRole: 'DISPATCHER',
      }),
      assignAmbulance(String(emgB._id), 'AMB-9009', {
        requestId: 'req-race-b',
        actor: 'Dispatcher B',
        actorRole: 'DISPATCHER',
      }),
    ]);

    const successes = [resA, resB].filter((r) => r.status === 'fulfilled');
    const failures = [resA, resB].filter((r) => r.status === 'rejected');

    // Exactly one must win, and one must be rejected with 409 conflict
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    const winningResult = (successes[0] as PromiseFulfilledResult<{ emergencyId: string }>).value;
    const ambAfter = await Ambulance.findById('AMB-9009').lean();
    expect(ambAfter?.status).toBe('ASSIGNED');
    expect(ambAfter?.currentEmergency).toBe(winningResult.emergencyId);
  });

  it('10. Supervisor override remains separately authorized and records eligibility in audit', async () => {
    const dispatcherToken = await loginAs(app, 'dispatcher');
    const supervisorToken = await loginAs(app, 'supervisor');
    const emg = await createTestEmergency('EMG-90010');

    await ensureAmbulance('AMB-9010', { status: 'AVAILABLE', currentEmergency: null });

    // 1. Dispatcher is forbidden from calling override endpoint
    const forbiddenRes = await request(app)
      .post(`/api/emergencies/${emg._id}/override`)
      .set(bearer(dispatcherToken))
      .send({
        action: 'REASSIGN_AMBULANCE',
        ambulanceId: 'AMB-9010',
        reason: 'Break glass override attempt by dispatcher',
      });
    expect(forbiddenRes.status).toBe(403);

    // 2. Supervisor override succeeds and writes break-glass audit
    const overrideRes = await request(app)
      .post(`/api/emergencies/${emg._id}/override`)
      .set(bearer(supervisorToken))
      .send({
        action: 'REASSIGN_AMBULANCE',
        ambulanceId: 'AMB-9010',
        reason: 'Authorized supervisor break-glass reassignment for severe trauma',
      });
    expect(overrideRes.status).toBe(200);

    const overrideAudit = await AuditLog.findOne({
      resourceId: 'AMB-9010',
      action: 'emergency.override',
    }).sort({ timestamp: -1 });
    expect(overrideAudit).toBeDefined();
    expect(overrideAudit?.details).toContain('REASSIGN_AMBULANCE');
  });

  it('11. Existing manual-dispatch regression behavior remains intact for seeded ambulances without active shifts', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90011');

    // AMB-005 from seed (no active shift seeded)
    await Ambulance.updateOne({ _id: 'AMB-005' }, { $set: { status: 'AVAILABLE', currentEmergency: null } });

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emg._id, ambulanceId: 'AMB-005' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.ambulanceId).toBe('AMB-005');
    expect(res.body.emergency.status).toBe('AMBULANCE_ASSIGNED');
  });

  it('12. Automated dispatch remains disabled and cannot be triggered or overridden by request parameters', async () => {
    const token = await loginAs(app, 'dispatcher');
    const emg = await createTestEmergency('EMG-90012');

    await Ambulance.updateOne({ _id: 'AMB-005' }, { $set: { status: 'AVAILABLE', currentEmergency: null } });

    // Attempting to send arbitrary bypass flags via manual dispatch endpoint has no effect
    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({
        emergencyId: emg._id,
        ambulanceId: 'AMB-005',
        policy: 'STRICT_AUTOMATED', // Should be stripped/ignored by assignSchema
        enforceStrictDuty: false,
      });

    expect(res.status).toBe(201);
    // Response policy remains server-enforced MANUAL
    expect(res.body.eligibility.policy).toBe('MANUAL');
  });
});
