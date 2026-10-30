import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

describe('voice reports', () => {
  it('returns the seeded current draft with extracted data', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app).get('/api/voice/reports/current').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'VR-001', status: 'DRAFT', confidence: 89.4 });
    expect(res.body.extractedData.incidentType).toBe('VEHICLE_COLLISION');
    expect(res.body).not.toHaveProperty('_id');
  });

  it('submits a transcript and extracts incident/location/victims', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/voice/reports')
      .set(bearer(token))
      .send({
        transcript:
          'There is a crash near Karol Bagh market. Two people injured and bleeding badly, please hurry.',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^VR-\d{3}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.extractedData.incidentType).toBe('VEHICLE_COLLISION');
    expect(res.body.extractedData.victimCount).toBe(2);
    expect(res.body.extractedData.location).toContain('Karol Bagh');
    expect(res.body.confidence).toBeGreaterThan(50);
  });

  it('confirming the seeded draft creates a VOICE_REPORT emergency; twice → 409', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .post('/api/voice/reports/VR-001/confirm')
      .set(bearer(token))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.report.status).toBe('CONFIRMED');
    expect(res.body.emergency.id).toMatch(/^EMG-\d{5}$/);
    expect(res.body.emergency.source).toBe('VOICE_REPORT');
    expect(res.body.emergency.incidentType).toBe('VEHICLE_COLLISION');

    const again = await request(app)
      .post('/api/voice/reports/VR-001/confirm')
      .set(bearer(token))
      .send({});
    expect(again.status).toBe(409);
  });

  it('keeps voice confirmation operational and denies auditor access', async () => {
    const auditor = await loginAs(app, 'auditor');
    const res = await request(app).post('/api/voice/reports/VR-001/confirm').set(bearer(auditor)).send({});
    expect(res.status).toBe(403);
  });
  it('validates transcript length and malformed confirmation ids', async () => {
    const token = await loginAs(app, 'citizen');
    const short = await request(app)
      .post('/api/voice/reports')
      .set(bearer(token))
      .send({ transcript: 'help' });
    expect(short.status).toBe(400);

    expect(
      (await request(app).post('/api/voice/reports/VR-999/confirm').set(bearer(token)).send({})).status,
    ).toBe(404);
    expect(
      (await request(app).post('/api/voice/reports/xx/confirm').set(bearer(token)).send({})).status,
    ).toBe(400);
  });
});
