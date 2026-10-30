import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

describe('vision review workflow', () => {
  it('lists detections with bounding boxes for the overlay', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app).get('/api/vision/detections').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(3);
    const det = res.body.find((d: { id: string }) => d.id === 'DET-003');
    expect(det).toMatchObject({ status: 'PENDING_REVIEW', confidence: 91.2 });
    expect(det.boundingBoxes).toHaveLength(2);
    expect(det).not.toHaveProperty('_id');
  });

  it('rejects a detection with reviewer recorded', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/vision/detections/DET-002/status')
      .set(bearer(token))
      .send({ status: 'REJECTED' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REJECTED');
    expect(res.body.reviewedBy).toBe('Arjun Khan');
  });

  it('enforces evidence export permission independently from evidence viewing', async () => {
    const admin = await loginAs(app, 'admin');
    const auditor = await loginAs(app, 'auditor');
    const dispatcher = await loginAs(app, 'dispatcher');
    expect((await request(app).get('/api/vision/detections/DET-001/evidence-export').set(bearer(admin))).status).toBe(200);
    expect((await request(app).get('/api/vision/detections/DET-001/evidence-export').set(bearer(auditor))).status).toBe(200);
    expect((await request(app).get('/api/vision/detections/DET-001/evidence-export').set(bearer(dispatcher))).status).toBe(403);
  });
  it('converting a detection creates a linked emergency; twice → 409', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .patch('/api/vision/detections/DET-003/status')
      .set(bearer(token))
      .send({ status: 'CONVERTED_TO_INCIDENT' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CONVERTED_TO_INCIDENT');
    expect(res.body.linkedEmergency).toMatch(/^EMG-\d{5}$/);

    const emg = await request(app)
      .get(`/api/emergencies/${res.body.linkedEmergency}`)
      .set(bearer(token));
    expect(emg.status).toBe(200);
    expect(emg.body.source).toBe('AI_VISION');

    const again = await request(app)
      .patch('/api/vision/detections/DET-003/status')
      .set(bearer(token))
      .send({ status: 'CONFIRMED' });
    expect(again.status).toBe(409);
  });

  it('RBAC: crew cannot review detections (403)', async () => {
    const crew = await loginAs(app, 'crew');
    const res = await request(app)
      .patch('/api/vision/detections/DET-002/status')
      .set(bearer(crew))
      .send({ status: 'CONFIRMED' });
    expect(res.status).toBe(403);
  });

  it('404s unknown detections, 400s malformed ids', async () => {
    const token = await loginAs(app, 'dispatcher');
    expect(
      (
        await request(app)
          .patch('/api/vision/detections/DET-999/status')
          .set(bearer(token))
          .send({ status: 'CONFIRMED' })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .patch('/api/vision/detections/junk/status')
          .set(bearer(token))
          .send({ status: 'CONFIRMED' })
      ).status,
    ).toBe(400);
  });
});
