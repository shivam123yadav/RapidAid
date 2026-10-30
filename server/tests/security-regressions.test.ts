import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs, DEMO_USERS } from './helpers.js';
import { Ambulance, AuditLog, Emergency, User, VoiceReport } from '../src/models/index.js';
import { hashPassword } from '../src/services/tokenService.js';

const app = createApp();
useTestDatabase(runSeed);

/** A fresh incident for the calling role to act on. */
async function createIncident(token: string): Promise<string> {
  const res = await request(app)
    .post('/api/emergencies')
    .set(bearer(token))
    .send({
      incidentType: 'MEDICAL_EMERGENCY',
      priority: 'HIGH',
      location: { lat: 28.62, lng: 77.21, address: 'Regression street' },
      description: 'Regression fixture',
      victimCount: 1,
      source: 'CITIZEN_REPORT',
    });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/**
 * Creates a free unit to dispatch. The seeded ambulances are deliberately all
 * occupied or off duty, so a test that needs two claimable units makes its own.
 */
async function freeUnit(id: string): Promise<string> {
  await Ambulance.create({
    _id: id,
    status: 'AVAILABLE',
    location: { lat: 28.62, lng: 77.21 },
    currentEmergency: null,
    capabilities: ['BLS', 'ALS'],
    equipment: ['Defibrillator'],
    crew: [],
    active: true,
    lastUpdated: new Date(),
  } as never);
  return id;
}

describe('H1: dispatching a second unit releases the one it displaces', () => {
  it('returns the previously assigned ambulance to AVAILABLE', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');
    const emergencyId = await createIncident(dispatcher);
    const unitA = await freeUnit('AMB-T01');
    const unitB = await freeUnit('AMB-T02');

    const first = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(dispatcher))
      .send({ emergencyId, ambulanceId: unitA });
    expect(first.status).toBe(201);

    // A second unit is dispatched to the same incident.
    const second = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(dispatcher))
      .send({ emergencyId, ambulanceId: unitB });
    expect(second.status).toBe(201);

    const linked = await Emergency.findById(emergencyId).lean();
    expect(linked?.assignedAmbulance).toBe(unitB);

    // The displaced unit must not be left claimed by an incident that no longer
    // points at it — that stranded it outside the available pool permanently.
    const displaced = await Ambulance.findById(unitA).lean();
    expect(displaced?.currentEmergency).toBeNull();
    expect(displaced?.status).toBe('AVAILABLE');

    const current = await Ambulance.findById(unitB).lean();
    expect(current?.currentEmergency).toBe(emergencyId);
  });
});

describe('G2: closing an incident never frees a unit serving a different one', () => {
  it('leaves a re-tasked ambulance alone', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');
    const first = await createIncident(dispatcher);
    const second = await createIncident(dispatcher);
    const unit = await freeUnit('AMB-T03');

    const assigned = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(dispatcher))
      .send({ emergencyId: first, ambulanceId: unit });
    expect(assigned.status).toBe(201);

    // The unit is moved to another incident behind the first one's back (this is
    // what a concurrent reassignment looks like to the closer).
    await Ambulance.updateOne({ _id: unit }, { $set: { currentEmergency: second } });

    const closed = await request(app)
      .patch(`/api/emergencies/${first}/status`)
      .set(bearer(dispatcher))
      .send({ status: 'COMPLETED' });
    expect(closed.status).toBe(200);

    // It is still serving `second` and must still be marked as such.
    const reloaded = await Ambulance.findById(unit).lean();
    expect(reloaded?.currentEmergency).toBe(second);
    expect(reloaded?.status).not.toBe('AVAILABLE');
  });
});


describe('G1: a voice report can only be confirmed into one emergency', () => {
  it('serialises concurrent confirmations', async () => {
    // Confirming is a reviewer action, so this runs as a DISPATCHER.
    const dispatcher = await loginAs(app, 'dispatcher');

    // A DRAFT report in that reviewer's scope, with a resolvable location.
    await VoiceReport.create({
      _id: 'VR-99001',
      ownerId: 'USR-008',
      status: 'DRAFT',
      createdAt: new Date(),
      transcript: 'There has been a serious road accident on the main road near the hospital.',
      confidence: 88,
      location: { latitude: 28.6139, longitude: 77.209, source: 'SPOKEN', address: 'Main road' },
      extractedData: { incidentType: 'VEHICLE_COLLISION', victimCount: 2, location: 'Main road' },
    } as never);

    const before = await Emergency.countDocuments({});
    const body = { location: { lat: 28.6139, lng: 77.209, address: 'Main road' } };
    const [a, b] = await Promise.all([
      request(app).post('/api/voice/reports/VR-99001/confirm').set(bearer(dispatcher)).send(body),
      request(app).post('/api/voice/reports/VR-99001/confirm').set(bearer(dispatcher)).send(body),
    ]);

    // One request wins the atomic claim; the loser is told it is already claimed.
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    // Exactly one emergency was raised from the single recording.
    expect((await Emergency.countDocuments({})) - before).toBe(1);
    const stored = await VoiceReport.findById('VR-99001').lean();
    expect(stored?.status).toBe('CONFIRMED');
  });
});

describe('H2: the emergency list is bounded and carries no photo bytes', () => {
  it('caps the page size and reports the total', async () => {
    const admin = await loginAs(app, 'admin');
    const res = await request(app).get('/api/emergencies?limit=5').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(5);
    expect(res.headers['x-total-count']).toBeDefined();
  });

  it('clamps an absurd limit rather than honouring it', async () => {
    const admin = await loginAs(app, 'admin');
    const res = await request(app).get('/api/emergencies?limit=100000').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(200);
  });
});

describe('H3: the override audit row does not copy patient photos', () => {
  it('records a bounded snapshot with a photo count', async () => {
    const admin = await loginAs(app, 'admin');
    const emergencyId = await createIncident(admin);

    // Give the incident a real (tiny) photo, then break-glass on it.
    const PNG =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    await Emergency.updateOne(
      { _id: emergencyId },
      {
        $set: {
          attachments: [
            { name: 'scene.png', mimeType: 'image/png', size: 68, dataUrl: PNG, uploadedAt: new Date() },
          ],
        },
      },
    );

    const res = await request(app)
      .post(`/api/emergencies/${emergencyId}/override`)
      .set(bearer(admin))
      .send({ action: 'ESCALATE', priority: 'CRITICAL', reason: 'Regression check' });
    expect(res.status).toBe(200);

    const row = await AuditLog.findOne({ action: 'emergency.override', resourceId: emergencyId }).lean();
    expect(row).not.toBeNull();
    // The snapshot proves how many photos exist without duplicating them.
    expect((row!.previousState as Record<string, unknown>).attachmentCount).toBe(1);
    expect((row!.newState as Record<string, unknown>).attachmentCount).toBe(1);
    expect(JSON.stringify(row!.previousState)).not.toContain('data:image');
    expect(JSON.stringify(row!.newState)).not.toContain('data:image');
  });
});

describe('D1/D3: token versioning and failed-login auditing', () => {
  it('retires outstanding access tokens when the password is reset', async () => {
    const email = 'version-probe@rapidaid.com';
    await User.create({
      _id: 'USR-990',
      name: 'Version Probe',
      email,
      passwordHash: await hashPassword('OldPassw0rd!'),
      role: 'CITIZEN',
      active: true,
      emailVerified: true,
    } as never);

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'OldPassw0rd!', role: 'CITIZEN' });
    expect(login.status).toBe(200);
    const stolen = login.body.accessToken as string;

    // The token works before the reset.
    expect((await request(app).get('/api/auth/me').set(bearer(stolen))).status).toBe(200);

    // This is exactly what reset-password does.
    await User.findByIdAndUpdate('USR-990', { $inc: { tokenVersion: 1 } });

    // ...and is dead immediately after, without waiting out its TTL.
    expect((await request(app).get('/api/auth/me').set(bearer(stolen))).status).toBe(401);
  });

  it('records rejected sign-ins so credential stuffing is visible', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: DEMO_USERS.citizen.email, password: 'definitely-wrong', role: 'CITIZEN' });
    expect(res.status).toBe(401);

    const row = await AuditLog.findOne({ action: 'auth.login_failed' }).sort({ timestamp: -1 }).lean();
    expect(row).not.toBeNull();
    expect(row?.result).toBe('FAILURE');
    expect(row?.details).toBe('bad-password');
  });
});

describe('F1: audit scoping cannot be widened by renaming yourself', () => {
  it('returns only rows whose actorId is the caller', async () => {
    const crew = await loginAs(app, 'crew');
    const other = await loginAs(app, 'hospital');

    // The hospital account acts, producing rows the crew must not see.
    await request(app).get('/api/audit').set(bearer(other));

    const res = await request(app).get('/api/audit').set(bearer(crew));
    expect(res.status).toBe(200);
    for (const entry of res.body) {
      expect(entry.actorId).toBe('USR-003');
    }
  });
});


