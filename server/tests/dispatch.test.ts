import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Emergency } from '../src/models/index.js';

const app = createApp();
useTestDatabase(runSeed);

describe('dispatch recommendations', () => {
  it('ranks ambulances with score/eta/distance/reasons, sorted, busy units excluded', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .get('/api/dispatch/recommendations/EMG-20481')
      .set(bearer(token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);

    const rec = res.body[0];
    expect(rec).toMatchObject({ ambulanceId: expect.stringMatching(/^AMB-/) });
    expect(rec.score).toBeGreaterThan(0);
    expect(rec.score).toBeLessThanOrEqual(100);
    expect(rec.eta).toBeGreaterThan(0);
    expect(rec.distance).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(rec.capabilities)).toBe(true);
    expect(rec.reasons.length).toBeGreaterThan(0);

    for (let i = 1; i < res.body.length; i++) {
      expect(res.body[i - 1].score).toBeGreaterThanOrEqual(res.body[i].score);
    }
    const ids = res.body.map((r: { ambulanceId: string }) => r.ambulanceId);
    expect(ids).not.toContain('AMB-017'); // busy (has currentEmergency)
    expect(ids).not.toContain('AMB-042'); // maintenance
  });

  it('ranks trauma-capable hospitals for a CRITICAL collision', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .get('/api/dispatch/hospital-recommendations/EMG-20481')
      .set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    const rec = res.body[0];
    expect(rec).toMatchObject({ hospitalId: expect.stringMatching(/^HOSP-/) });
    expect(['AVAILABLE', 'LIMITED', 'FULL']).toContain(rec.emergencyCapacity);
    expect(typeof rec.traumaAvailable).toBe('boolean');
    expect(rec.reasons.length).toBeGreaterThan(0);
    for (const r of res.body) expect(r.traumaAvailable).toBe(true);
  });

  it('404s unknown emergencies, 400s malformed ids', async () => {
    const token = await loginAs(app, 'dispatcher');
    expect(
      (await request(app).get('/api/dispatch/recommendations/EMG-99999').set(bearer(token))).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/dispatch/recommendations/bogus').set(bearer(token))).status,
    ).toBe(400);
  });
});

describe('dispatch assignment', () => {
  it('assigns an available ambulance (201, both sides linked, audit written)', async () => {
    const token = await loginAs(app, 'dispatcher');

    const create = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'VEHICLE_COLLISION',
        priority: 'CRITICAL',
        location: { lat: 28.62, lng: 77.214, address: 'Assignment Test Crossroads' },
        description: 'Dispatch assignment integration test',
        victimCount: 1,
      });
    expect(create.status).toBe(201);
    const emgId = create.body.id;

    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emgId, ambulanceId: 'AMB-005' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ success: true, emergencyId: emgId, ambulanceId: 'AMB-005' });
    expect(res.body.emergency.status).toBe('AMBULANCE_ASSIGNED');
    expect(res.body.emergency.assignedAmbulance).toBe('AMB-005');

    const amb = await request(app).get('/api/ambulances/AMB-005').set(bearer(token));
    expect(amb.body.status).toBe('ASSIGNED');
    expect(amb.body.currentEmergency).toBe(emgId);

    const audit = await request(app).get('/api/audit').set(bearer(await loginAs(app, 'admin')));
    expect(
      audit.body.some(
        (a: { action: string; resourceId: string }) =>
          a.action === 'dispatch.assigned' && a.resourceId === 'AMB-005',
      ),
    ).toBe(true);

    // Second assignment of the same unit → 409 (no double-booking).
    const create2 = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 28.63, lng: 77.22, address: 'Conflict Test Road' },
        description: 'Double-booking guard integration test',
        victimCount: 1,
      });
    const conflict = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: create2.body.id, ambulanceId: 'AMB-005' });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.message).toContain('already assigned');
  });

  it('RBAC: crew and citizen cannot assign (403)', async () => {
    for (const who of ['crew', 'citizen'] as const) {
      const token = await loginAs(app, who);
      const res = await request(app)
        .post('/api/dispatch/assign')
        .set(bearer(token))
        .send({ emergencyId: 'EMG-20481', ambulanceId: 'AMB-031' });
      expect(res.status, `expected 403 for ${who}`).toBe(403);
    }
  });

  it('maintenance units cannot be assigned (409)', async () => {
    const token = await loginAs(app, 'admin');
    const create = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'OTHER',
        location: { lat: 28.64, lng: 77.23, address: 'Maintenance Bay' },
        description: 'Maintenance unit assignment guard test',
        victimCount: 1,
      });
    const res = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: create.body.id, ambulanceId: 'AMB-042' });
    expect(res.status).toBe(409);
  });

  it('data consistency: assigns ambulance to incident, immediately returns and persists assigned ambulance, status, crew, and timeline', async () => {
    const token = await loginAs(app, 'dispatcher');

    // Create synthetic incident
    const create = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'VEHICLE_COLLISION',
        priority: 'CRITICAL',
        location: { lat: 28.62, lng: 77.214, address: 'Connaught Place Outer Circle' },
        description: 'Synthetic incident for assignment regression test',
        victimCount: 2,
      });
    expect(create.status).toBe(201);
    const emgId = create.body.id;
    expect(create.body.status).toBe('REPORTED');
    expect(create.body.assignedAmbulance).toBeUndefined();
    expect(create.body.assignedCrew).toBeUndefined();

    // Verify assigned ambulance details beforehand
    const ambPre = await request(app).get('/api/ambulances/AMB-031').set(bearer(token));
    expect(ambPre.status).toBe(200);
    const expectedCrew = ambPre.body.crew.map((c: { name: string }) => c.name);
    expect(expectedCrew.length).toBeGreaterThan(0);

    // Assign AMB-031 to the incident
    const assignRes = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: emgId, ambulanceId: 'AMB-031' });
    expect(assignRes.status).toBe(201);

    // 1. Verify immediately after assignment from the assignment response payload
    expect(assignRes.body).toMatchObject({
      success: true,
      emergencyId: emgId,
      ambulanceId: 'AMB-031',
    });
    expect(assignRes.body.emergency.status).toBe('AMBULANCE_ASSIGNED');
    expect(assignRes.body.emergency.assignedAmbulance).toBe('AMB-031');
    expect(assignRes.body.emergency.assignedCrew).toEqual(expectedCrew);
    const immediateTimeline = assignRes.body.emergency.timeline;
    expect(immediateTimeline.some((t: { status: string }) => t.status === 'REPORTED')).toBe(true);
    expect(
      immediateTimeline.some(
        (t: { status: string; note?: string }) =>
          t.status === 'AMBULANCE_ASSIGNED' && t.note?.includes('AMB-031'),
      ),
    ).toBe(true);

    // 2. Verify after a fresh GET fetch of the incident detail
    const freshRes = await request(app)
      .get(`/api/emergencies/${emgId}`)
      .set(bearer(token));
    expect(freshRes.status).toBe(200);
    expect(freshRes.body.status).toBe('AMBULANCE_ASSIGNED');
    expect(freshRes.body.assignedAmbulance).toBe('AMB-031');
    expect(freshRes.body.assignedCrew).toEqual(expectedCrew);
    const freshTimeline = freshRes.body.timeline;
    expect(freshTimeline.some((t: { status: string }) => t.status === 'REPORTED')).toBe(true);
    expect(
      freshTimeline.some(
        (t: { status: string; note?: string }) =>
          t.status === 'AMBULANCE_ASSIGNED' && t.note?.includes('AMB-031'),
      ),
    ).toBe(true);

    // 3. Verify Emergencies list also agrees
    const listRes = await request(app).get('/api/emergencies').set(bearer(token));
    expect(listRes.status).toBe(200);
    const inList = listRes.body.find((e: { id: string }) => e.id === emgId);
    expect(inList).toBeDefined();
    expect(inList.status).toBe('AMBULANCE_ASSIGNED');
    expect(inList.assignedAmbulance).toBe('AMB-031');

    // 4. Verify ambulance fleet also agrees
    const ambFresh = await request(app).get('/api/ambulances/AMB-031').set(bearer(token));
    expect(ambFresh.body.status).toBe('ASSIGNED');
    expect(ambFresh.body.currentEmergency).toBe(emgId);
  });

  it('synchronizes and displays assigned crew on fresh fetch even if missing from legacy persisted record', async () => {
    const token = await loginAs(app, 'dispatcher');

    // Create an incident assigned to AMB-031 where assignedCrew and assignedCrewIds were stripped/missing
    const legacyEmgId = 'EMG-20499';
    await Emergency.create({
      _id: legacyEmgId,
      status: 'AMBULANCE_ASSIGNED',
      priority: 'HIGH',
      incidentType: 'VEHICLE_COLLISION',
      location: { lat: 28.62, lng: 77.214, address: 'Connaught Place' },
      source: 'DISPATCHER',
      description: 'Legacy incident with missing persisted assignedCrew',
      victimCount: 1,
      reportedAt: new Date(),
      updatedAt: new Date(),
      assignedAmbulance: 'AMB-031',
    });

    // Ensure raw document indeed has no assignedCrew
    const rawPre = await Emergency.findById(legacyEmgId).lean();
    expect(rawPre?.assignedCrew).toBeUndefined();

    // Fresh fetch GET /api/emergencies/:id
    const freshRes = await request(app).get(`/api/emergencies/${legacyEmgId}`).set(bearer(token));
    expect(freshRes.status).toBe(200);
    expect(freshRes.body.assignedAmbulance).toBe('AMB-031');
    expect(freshRes.body.assignedCrew).toEqual(['Dr. Nair', 'EMT Das']);

    // List GET /api/emergencies
    const listRes = await request(app).get('/api/emergencies').set(bearer(token));
    expect(listRes.status).toBe(200);
    const inList = listRes.body.find((e: { id: string }) => e.id === legacyEmgId);
    expect(inList).toBeDefined();
    expect(inList.assignedAmbulance).toBe('AMB-031');
    expect(inList.assignedCrew).toEqual(['Dr. Nair', 'EMT Das']);

    // Verify persisted record was healed in DB
    const rawPost = await Emergency.findById(legacyEmgId).lean();
    expect(rawPost?.assignedCrew).toEqual(['Dr. Nair', 'EMT Das']);
    expect(rawPost?.assignedCrewIds).toContain('USR-002');
  });
});

