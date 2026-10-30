import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_EMERGENCY,
} from '../src/validation/constants.js';

const app = createApp();
useTestDatabase(runSeed);

describe('emergencies', () => {
  it('requires authentication for list (401 without token)', async () => {
    expect((await request(app).get('/api/emergencies')).status).toBe(401);
  });

  it('lists seeded emergencies with the exact frontend shape', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app).get('/api/emergencies').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(4);

    const emg = res.body.find((e: { id: string }) => e.id === 'EMG-20481');
    expect(emg).toMatchObject({
      id: 'EMG-20481',
      status: 'EN_ROUTE',
      priority: 'CRITICAL',
      incidentType: 'VEHICLE_COLLISION',
      source: 'AI_VISION',
      assignedAmbulance: 'AMB-017',
      destinationHospital: 'HOSP-01',
    });
    expect(emg.location).toEqual({ lat: 28.6139, lng: 77.209, address: 'Connaught Place, New Delhi' });
    expect(emg.timeline).toHaveLength(5);
    expect(emg.timeline[0]).toMatchObject({ status: 'REPORTED' });
    expect(emg.aiRecommendations.reasoning.length).toBeGreaterThan(0);
    // Serialization contract: id, never _id.
    expect(emg).not.toHaveProperty('_id');
    expect(typeof emg.reportedAt).toBe('string');
  });

  it('gets a single emergency by id and 404s/400s correctly', async () => {
    const token = await loginAs(app, 'dispatcher');
    const ok = await request(app).get('/api/emergencies/EMG-20482').set(bearer(token));
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('EMG-20482');

    const missing = await request(app).get('/api/emergencies/EMG-99999').set(bearer(token));
    expect(missing.status).toBe(404);

    const malformed = await request(app).get('/api/emergencies/not-an-id').set(bearer(token));
    expect(malformed.status).toBe(400);
  });

  it('creates a new emergency (generated id, REPORTED, audit + notification)', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'MEDICAL_EMERGENCY',
        priority: 'HIGH',
        location: { lat: 28.62, lng: 77.21, address: 'Test Street, New Delhi' },
        description: 'Automated integration test emergency report',
        victimCount: 2,
        source: 'CITIZEN_REPORT',
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^EMG-\d{5}$/);
    expect(res.body.id).not.toBe('EMG-20481'); // counter is past the seeded range
    expect(res.body.status).toBe('REPORTED');
    expect(res.body.timeline).toHaveLength(1);
    expect(res.body.timeline[0].status).toBe('REPORTED');

    const adminToken = await loginAs(app, 'admin');
    const audit = await request(app).get('/api/audit').set(bearer(adminToken));
    expect(
      audit.body.some(
        (a: { action: string; resourceId: string }) =>
          a.action === 'emergency.created' && a.resourceId === res.body.id,
      ),
    ).toBe(true);

    const notifications = await request(app).get('/api/notifications').set(bearer(adminToken));
    expect(
      notifications.body.some((n: { linkedEmergency?: string }) => n.linkedEmergency === res.body.id),
    ).toBe(true);
  });

  it('rejects an invalid create payload with 400 listing the bad fields', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({ incidentType: 'NOT_A_TYPE', description: 'x', location: { lat: 999, lng: 0 } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('incidentType');
    expect(res.body.error.message).toContain('location.lat');
  });

  describe('photo attachments', () => {
    // 1×1 PNG — a real image payload, small enough to keep the test fast.
    const PNG_DATA_URL =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
    const PNG_BYTES = Buffer.from(PNG_DATA_URL.split(',')[1], 'base64');

    const report = (token: string, attachments: unknown[]) =>
      request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          incidentType: 'MEDICAL_EMERGENCY',
          priority: 'HIGH',
          location: { lat: 28.62, lng: 77.21, address: 'Photo test street' },
          description: 'Emergency report with an attached photo',
          victimCount: 1,
          source: 'CITIZEN_REPORT',
          attachments,
        });

    it('stores uploaded photos and returns them with the created incident', async () => {
      const token = await loginAs(app, 'citizen');
      const res = await report(token, [
        { name: 'scene.png', mimeType: 'image/png', dataUrl: PNG_DATA_URL },
      ]);

      expect(res.status).toBe(201);
      expect(res.body.attachments).toHaveLength(1);
      expect(res.body.attachments[0]).toMatchObject({
        name: 'scene.png',
        mimeType: 'image/png',
        dataUrl: PNG_DATA_URL,
      });
      // The server measures the decoded size, not the base64 payload length.
      expect(res.body.attachments[0].size).toBe(PNG_BYTES.length);
      expect(typeof res.body.attachments[0].uploadedAt).toBe('string');

      // Persisted (not just echoed). The list response deliberately omits the
      // base64 payload — an emergency can carry ~10 MB of photos and a list is
      // fetched far more often than a record — so it reports the count and the
      // metadata, and the detail view is where the bytes live.
      const list = await request(app).get('/api/emergencies').set(bearer(token));
      const stored = list.body.find((e: { id: string }) => e.id === res.body.id);
      expect(stored.attachmentCount).toBe(1);
      expect(stored.attachments[0]).toMatchObject({ name: 'scene.png', mimeType: 'image/png' });
      expect(stored.attachments[0].dataUrl).toBeUndefined();

      // The authorized detail read still returns the photo itself.
      const detail = await request(app).get(`/api/emergencies/${res.body.id}`).set(bearer(token));
      expect(detail.status).toBe(200);
      expect(detail.body.attachments[0].dataUrl).toBe(PNG_DATA_URL);
    });

    it('creates reports without photos as an empty attachment list', async () => {
      const token = await loginAs(app, 'citizen');
      const res = await report(token, []);
      expect(res.status).toBe(201);
      expect(res.body.attachments).toEqual([]);
    });

    it('rejects non-image payloads, mismatched mime types and oversized photos', async () => {
      const token = await loginAs(app, 'citizen');

      // A data URL that isn't one of the supported image types.
      const notAnImage = await report(token, [
        { name: 'evil.png', mimeType: 'image/png', dataUrl: 'data:application/pdf;base64,JVBER' },
      ]);
      expect(notAnImage.status).toBe(400);
      expect(notAnImage.body.error.message).toContain('data URL');

      // Correct prefix, but the bytes are "Hello" — not a PNG. The declared
      // mimeType is client-controlled, so the magic bytes have to match.
      const spoofedMime = await report(token, [
        { name: 'evil.png', mimeType: 'image/png', dataUrl: 'data:image/png;base64,SGVsbG8=' },
      ]);
      expect(spoofedMime.status).toBe(400);
      expect(spoofedMime.body.error.message).toContain('not a valid image/png image');

      // 2 MB of decoded bytes + 1, over the per-photo cap.
      const oversized = await report(token, [
        {
          name: 'huge.png',
          mimeType: 'image/png',
          dataUrl: `data:image/png;base64,${Buffer.alloc(MAX_ATTACHMENT_BYTES + 1).toString('base64')}`,
        },
      ]);
      expect(oversized.status).toBe(400);
      expect(oversized.body.error.message).toContain('2 MB');
    });

    it('rejects more photos than the per-report limit', async () => {
      const token = await loginAs(app, 'citizen');
      const res = await report(
        token,
        Array.from({ length: MAX_ATTACHMENTS_PER_EMERGENCY + 1 }, (_unused, i) => ({
          name: `photo-${i}.png`,
          mimeType: 'image/png',
          dataUrl: PNG_DATA_URL,
        })),
      );
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('at most 4 photos');
    });
  });
});
