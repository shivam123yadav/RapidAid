import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

describe('emergency status state machine', () => {
  it('applies a valid forward transition and appends to the timeline', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/emergencies/EMG-20481/status')
      .set(bearer(token))
      .send({ status: 'AT_SCENE', note: 'Crew arrived' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('AT_SCENE');
    const last = res.body.timeline[res.body.timeline.length - 1];
    expect(last).toMatchObject({ status: 'AT_SCENE', note: 'Crew arrived' });
  });

  it('rejects backwards transitions (AT_SCENE → EN_ROUTE) with 400', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/emergencies/EMG-20481/status')
      .set(bearer(token))
      .send({ status: 'EN_ROUTE' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('Invalid status transition');
  });

  it('rejects same-state updates with 400', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/emergencies/EMG-20481/status')
      .set(bearer(token))
      .send({ status: 'AT_SCENE' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('already in status');
  });

  it('terminal states are immutable (COMPLETED cannot move)', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/emergencies/EMG-20484/status')
      .set(bearer(token))
      .send({ status: 'AT_SCENE' });
    expect(res.status).toBe(400);
  });

  it('RBAC: hospital/citizen blocked (403), crew allowed', async () => {
    const hospital = await loginAs(app, 'hospital');
    const denied = await request(app)
      .patch('/api/emergencies/EMG-20482/status')
      .set(bearer(hospital))
      .send({ status: 'PATIENT_ONBOARD' });
    expect(denied.status).toBe(403);

    const citizen = await loginAs(app, 'citizen');
    const denied2 = await request(app)
      .patch('/api/emergencies/EMG-20482/status')
      .set(bearer(citizen))
      .send({ status: 'PATIENT_ONBOARD' });
    expect(denied2.status).toBe(403);

    const crew = await loginAs(app, 'crew');
    const allowed = await request(app)
      .patch('/api/emergencies/EMG-20482/status')
      .set(bearer(crew))
      .send({ status: 'PATIENT_ONBOARD' });
    expect(allowed.status).toBe(200);
  });

  it('COMPLETED releases the assigned ambulance back to AVAILABLE', async () => {
    const token = await loginAs(app, 'dispatcher');
    // EMG-20483 is PATIENT_ONBOARD — walk it to COMPLETED.
    for (const status of ['EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL', 'COMPLETED']) {
      const res = await request(app)
        .patch('/api/emergencies/EMG-20483/status')
        .set(bearer(token))
        .send({ status });
      expect(res.status).toBe(200);
    }

    const amb = await request(app).get('/api/ambulances/AMB-011').set(bearer(token));
    expect(amb.status).toBe(200);
    expect(amb.body.status).toBe('AVAILABLE');
    expect(amb.body.currentEmergency).toBeNull();
  });

  it('404s status updates for unknown or malformed emergency ids', async () => {
    const token = await loginAs(app, 'dispatcher');
    const unknown = await request(app)
      .patch('/api/emergencies/EMG-99999/status')
      .set(bearer(token))
      .send({ status: 'TRIAGED' });
    expect(unknown.status).toBe(404);

    const malformed = await request(app)
      .patch('/api/emergencies/junk/status')
      .set(bearer(token))
      .send({ status: 'TRIAGED' });
    expect(malformed.status).toBe(400);
  });
});
