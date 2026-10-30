import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { pingDB } from '../src/db/connection.js';
import { Ambulance, AuditLog, Emergency, IdempotencyKey, Notification, AIDetection } from '../src/models/index.js';
import { formatScopedIdempotencyKey } from '../src/middleware/idempotency.js';
import { reconcileStrandedAmbulances, createEmergency } from '../src/services/emergencyService.js';

const app = createApp();
useTestDatabase(runSeed);

describe('Milestone 2: Core Backend Correctness', () => {
  describe('Database Ping & Health Probes', () => {
    it('pingDB returns { ok: true } when connected', async () => {
      const ping = await pingDB();
      expect(ping.ok).toBe(true);
      expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('pingDB returns { ok: false } safely without throwing when ping command fails', async () => {
      const originalAdmin = mongoose.connection.db!.admin;
      mongoose.connection.db!.admin = (() => ({
        command: async () => {
          throw new Error('Database ping failed');
        },
      })) as never;

      try {
        const ping = await pingDB();
        expect(ping.ok).toBe(false);
        expect(ping.latencyMs).toBeGreaterThanOrEqual(0);
      } finally {
        mongoose.connection.db!.admin = originalAdmin;
      }
    });

    it('unauthenticated GET /healthz returns 200 ok without leaking sensitive data', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.version).toBeUndefined();
      expect(res.body.secrets).toBeUndefined();
    });

    it('unauthenticated GET /readyz returns 200 ready when database is available', async () => {
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.timestamp).toBeDefined();
    });

    it('unauthenticated GET /readyz returns 503 not_ready when database is down', async () => {
      const originalAdmin = mongoose.connection.db!.admin;
      mongoose.connection.db!.admin = (() => ({
        command: async () => {
          throw new Error('Database connection failed');
        },
      })) as never;

      try {
        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.reason).toBe('database_unavailable');
      } finally {
        mongoose.connection.db!.admin = originalAdmin;
      }
    });

    it('authenticated GET /api/system/health returns sanitized operational services with truthful states', async () => {
      const token = await loginAs(app, 'admin');
      const res = await request(app).get('/api/system/health').set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('OPERATIONAL');
      expect(Array.isArray(res.body.services)).toBe(true);
      expect(res.body.services.length).toBe(7);

      const serviceMap = new Map(res.body.services.map((s: { service: string; status: string }) => [s.service, s.status]));
      expect(serviceMap.get('API Gateway')).toBe('OPERATIONAL');
      expect(serviceMap.get('Database')).toBe('OPERATIONAL');
      expect(serviceMap.get('Real-time (WebSocket)')).toBe('OFFLINE');
      expect(serviceMap.get('AI Vision Service')).toBe('DEGRADED');
      expect(serviceMap.get('Voice AI')).toBe('OPERATIONAL');
      expect(serviceMap.get('Maps Service')).toBe('OPERATIONAL');
      expect(serviceMap.get('Notification Service')).toBe('OPERATIONAL');
    });

    it('unauthenticated GET /healthz returns 200 ok even when database ping fails', async () => {
      const originalAdmin = mongoose.connection.db!.admin;
      mongoose.connection.db!.admin = (() => ({
        command: async () => {
          throw new Error('Database connection failed');
        },
      })) as never;

      try {
        const res = await request(app).get('/healthz');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.timestamp).toBeDefined();
      } finally {
        mongoose.connection.db!.admin = originalAdmin;
      }
    });

    it('authenticated GET /api/system/health reports DEGRADED and OFFLINE database without leaking secrets when DB is down', async () => {
      const token = await loginAs(app, 'admin');
      const originalAdmin = mongoose.connection.db!.admin;
      mongoose.connection.db!.admin = (() => ({
        command: async () => {
          throw new Error('Database connection failed');
        },
      })) as never;

      try {
        const res = await request(app).get('/api/system/health').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('DEGRADED');
        expect(res.body.services.length).toBe(7);
        const dbService = res.body.services.find((s: { service: string }) => s.service === 'Database');
        expect(dbService?.status).toBe('OFFLINE');
        const jsonString = JSON.stringify(res.body);
        expect(jsonString).not.toContain('mongodb://');
        expect(jsonString).not.toContain('password');
        expect(jsonString).not.toContain('stack');
      } finally {
        mongoose.connection.db!.admin = originalAdmin;
      }
    });
  });

  describe('Bounded Pagination', () => {
    it('GET /api/vision/detections bounds query and returns X-Total-Count', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .get('/api/vision/detections?limit=2&skip=0')
        .set(bearer(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(2);
      expect(res.headers['x-total-count']).toBeDefined();
    });

    it('GET /api/ambulances bounds query and returns X-Total-Count', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .get('/api/ambulances?limit=3&skip=1')
        .set(bearer(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(3);
      expect(res.headers['x-total-count']).toBeDefined();
    });

    it('GET /api/hospitals bounds query and returns X-Total-Count', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .get('/api/hospitals?limit=2&skip=0')
        .set(bearer(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(2);
      expect(res.headers['x-total-count']).toBeDefined();
    });

    it('GET /api/notifications bounds query and returns X-Total-Count', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .get('/api/notifications?limit=2&skip=0')
        .set(bearer(token));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeLessThanOrEqual(2);
      expect(res.headers['x-total-count']).toBeDefined();
    });

    it('normalizes malformed, negative and out-of-bounds pagination parameters', async () => {
      const token = await loginAs(app, 'dispatcher');
      const resMalformed = await request(app)
        .get('/api/emergencies?limit=-10&skip=invalid')
        .set(bearer(token));
      expect(resMalformed.status).toBe(200);
      expect(Array.isArray(resMalformed.body)).toBe(true);
      expect(resMalformed.headers['x-total-count']).toBeDefined();

      const resGiant = await request(app)
        .get('/api/emergencies?limit=999999&skip=999999')
        .set(bearer(token));
      expect(resGiant.status).toBe(200);
      expect(Array.isArray(resGiant.body)).toBe(true);
      expect(resGiant.headers['x-total-count']).toBeDefined();
    });

    it('accesses older notifications and detections through subsequent pages with exact parity', async () => {
      const token = await loginAs(app, 'dispatcher');

      await Notification.insertMany([
        { _id: 'N9001', category: 'INFO', title: 'Notif 1', message: 'First test notification', timestamp: new Date(Date.now() - 4000), read: false },
        { _id: 'N9002', category: 'INFO', title: 'Notif 2', message: 'Second test notification', timestamp: new Date(Date.now() - 3000), read: false },
        { _id: 'N9003', category: 'INFO', title: 'Notif 3', message: 'Third test notification', timestamp: new Date(Date.now() - 2000), read: false },
        { _id: 'N9004', category: 'INFO', title: 'Notif 4', message: 'Fourth test notification', timestamp: new Date(Date.now() - 1000), read: false },
      ]);

      const [page1Res, page2Res] = await Promise.all([
        request(app).get('/api/notifications?limit=2&skip=0').set(bearer(token)),
        request(app).get('/api/notifications?limit=2&skip=2').set(bearer(token)),
      ]);

      expect(page1Res.status).toBe(200);
      expect(page2Res.status).toBe(200);
      expect(page1Res.body.length).toBe(2);
      expect(page2Res.body.length).toBe(2);

      const page1Ids = page1Res.body.map((n: { id: string }) => n.id);
      const page2Ids = page2Res.body.map((n: { id: string }) => n.id);
      for (const id of page1Ids) {
        expect(page2Ids).not.toContain(id);
      }
      expect(page1Res.headers['x-total-count']).toBe(page2Res.headers['x-total-count']);
      expect(Number(page1Res.headers['x-total-count'])).toBeGreaterThanOrEqual(4);

      // Verify vision detections across subsequent pages as well
      await AIDetection.insertMany([
        { _id: 'DET-9901', cameraId: 'CAM-001', cameraLocation: { lat: 28.6139, lng: 77.209 }, detectedEvent: 'VEHICLE_COLLISION', confidence: 95, status: 'PENDING_REVIEW', timestamp: new Date(Date.now() - 4000), modelName: 'RapidVision-YOLO', modelVersion: 'v2.1' },
        { _id: 'DET-9902', cameraId: 'CAM-001', cameraLocation: { lat: 28.6139, lng: 77.209 }, detectedEvent: 'VEHICLE_COLLISION', confidence: 92, status: 'PENDING_REVIEW', timestamp: new Date(Date.now() - 3000), modelName: 'RapidVision-YOLO', modelVersion: 'v2.1' },
        { _id: 'DET-9903', cameraId: 'CAM-001', cameraLocation: { lat: 28.6139, lng: 77.209 }, detectedEvent: 'VEHICLE_COLLISION', confidence: 90, status: 'PENDING_REVIEW', timestamp: new Date(Date.now() - 2000), modelName: 'RapidVision-YOLO', modelVersion: 'v2.1' },
        { _id: 'DET-9904', cameraId: 'CAM-001', cameraLocation: { lat: 28.6139, lng: 77.209 }, detectedEvent: 'VEHICLE_COLLISION', confidence: 88, status: 'PENDING_REVIEW', timestamp: new Date(Date.now() - 1000), modelName: 'RapidVision-YOLO', modelVersion: 'v2.1' },
      ]);

      const [detPage1Res, detPage2Res] = await Promise.all([
        request(app).get('/api/vision/detections?limit=2&skip=0').set(bearer(token)),
        request(app).get('/api/vision/detections?limit=2&skip=2').set(bearer(token)),
      ]);

      expect(detPage1Res.status).toBe(200);
      expect(detPage2Res.status).toBe(200);
      expect(detPage1Res.body.length).toBe(2);
      expect(detPage2Res.body.length).toBe(2);
      const detPage1Ids = detPage1Res.body.map((d: { id: string }) => d.id);
      const detPage2Ids = detPage2Res.body.map((d: { id: string }) => d.id);
      for (const id of detPage1Ids) {
        expect(detPage2Ids).not.toContain(id);
      }
      expect(detPage1Res.headers['x-total-count']).toBe(detPage2Res.headers['x-total-count']);
      expect(Number(detPage1Res.headers['x-total-count'])).toBeGreaterThanOrEqual(4);
    });
  });

  describe('Concurrency-Safe Emergency Status Transitions', () => {
    it('detects concurrent state modification and rejects with 409 Conflict', async () => {
      const token = await loginAs(app, 'dispatcher');

      // Create an emergency specifically for concurrency testing
      const createRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          priority: 'HIGH',
          incidentType: 'VEHICLE_COLLISION',
          location: { lat: 28.6139, lng: 77.209, address: 'Test Junction' },
          source: 'DISPATCHER',
          description: 'Car crash testing concurrency',
          victimCount: 1,
          attachments: [],
        });
      expect(createRes.status).toBe(201);
      const emgId = createRes.body.id;

      // Simulate concurrent race: background process modifies the status directly in DB
      await Emergency.updateOne({ _id: emgId }, { $set: { status: 'DISPATCHED' } });

      // Request attempting transition from old expected status (REPORTED) fails with 409
      const raceRes = await request(app)
        .patch(`/api/emergencies/${emgId}/status`)
        .set(bearer(token))
        .send({ status: 'AT_SCENE', currentStatus: 'REPORTED', note: 'Attempting transition from stale reported state' });

      expect(raceRes.status).toBe(409);
      expect(raceRes.body.error.message).toContain('Concurrent transition conflict');
    });

    it('rejects transition on nonexistent emergency with 404 Not Found', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .patch('/api/emergencies/EMG-9999999/status')
        .set(bearer(token))
        .send({ status: 'TRIAGED' });

      expect(res.status).toBe(404);
    });

    it('rejects invalid state transition progression with 400 Bad Request', async () => {
      const token = await loginAs(app, 'dispatcher');
      const createRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          priority: 'MEDIUM',
          incidentType: 'VEHICLE_COLLISION',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'DISPATCHER',
          description: 'Testing invalid transition progression',
          victimCount: 1,
          attachments: [],
        });
      const emgId = createRes.body.id;

      // Cannot jump backwards or execute same-state
      const sameRes = await request(app)
        .patch(`/api/emergencies/${emgId}/status`)
        .set(bearer(token))
        .send({ status: 'REPORTED' });
      expect(sameRes.status).toBe(400);
      expect(sameRes.body.error.message).toContain('already in status');
    });

    it('handles simultaneous conflicting transitions: one succeeds, one gets 409 Conflict', async () => {
      const token = await loginAs(app, 'dispatcher');
      const createRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          priority: 'HIGH',
          incidentType: 'RESPIRATORY_DISTRESS',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'DISPATCHER',
          description: 'Testing simultaneous conflicting transitions',
          victimCount: 1,
          attachments: [],
        });
      const emgId = createRes.body.id;

      // Two concurrent calls attempting to transition from REPORTED
      const [res1, res2] = await Promise.all([
        request(app)
          .patch(`/api/emergencies/${emgId}/status`)
          .set(bearer(token))
          .send({ status: 'TRIAGED', currentStatus: 'REPORTED' }),
        request(app)
          .patch(`/api/emergencies/${emgId}/status`)
          .set(bearer(token))
          .send({ status: 'CANCELLED', currentStatus: 'REPORTED' }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('deterministic ordering: competing terminal and non-terminal transitions preserve ambulance assignment for the winner', async () => {
      const token = await loginAs(app, 'dispatcher');
      const createRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          priority: 'CRITICAL',
          incidentType: 'VEHICLE_COLLISION',
          location: { lat: 28.6139, lng: 77.209, address: 'Rajiv Chowk' },
          source: 'DISPATCHER',
          description: 'Multi-car pileup testing terminal competition',
          victimCount: 2,
          attachments: [],
        });
      expect(createRes.status).toBe(201);
      const emgId = createRes.body.id;

      const ambId = 'AMB-999';
      await Ambulance.create({
        _id: ambId,
        status: 'ASSIGNED',
        currentEmergency: emgId,
        location: { lat: 28.6139, lng: 77.209 },
        speed: 0,
        heading: 0,
        active: true,
        lastUpdated: new Date(),
      });
      await Emergency.updateOne(
        { _id: emgId },
        { $set: { assignedAmbulance: ambId } },
      );

      const preAmb = await Ambulance.findById(ambId).lean();
      expect(preAmb?.status).toBe('ASSIGNED');
      expect(preAmb?.currentEmergency).toBe(emgId);

      const [resA, resB] = await Promise.all([
        request(app)
          .patch(`/api/emergencies/${emgId}/status`)
          .set(bearer(token))
          .send({ status: 'CANCELLED', currentStatus: 'REPORTED', note: 'Dispatch cancelled call' }),
        request(app)
          .patch(`/api/emergencies/${emgId}/status`)
          .set(bearer(token))
          .send({ status: 'TRIAGED', currentStatus: 'REPORTED', note: 'Paramedic triaged call' }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      expect(statuses).toEqual([200, 409]);

      const finalEmergency = await Emergency.findById(emgId).lean();
      const finalAmbulance = await Ambulance.findById(ambId).lean();

      if (resA.status === 200) {
        expect(resB.status).toBe(409);
        expect(finalEmergency?.status).toBe('CANCELLED');
        expect(finalAmbulance?.status).toBe('AVAILABLE');
        expect(finalAmbulance?.currentEmergency).toBeNull();
      } else {
        expect(resA.status).toBe(409);
        expect(resB.status).toBe(200);
        expect(finalEmergency?.status).toBe('TRIAGED');
        expect(finalAmbulance?.status).toBe('ASSIGNED');
        expect(finalAmbulance?.currentEmergency).toBe(emgId);
      }

      const statusAudits = await AuditLog.find({ resource: 'Emergency', resourceId: emgId, action: 'emergency.status_changed' });
      expect(statusAudits.length).toBe(1);
      const expectedStatus = resA.status === 200 ? 'CANCELLED' : 'TRIAGED';
      expect(statusAudits[0].details).toContain(expectedStatus);

      const skippedAudits = await AuditLog.find({ resourceId: ambId, action: 'emergency.ambulance_release_skipped' });
      expect(skippedAudits.length).toBe(0);
    });

    it('handles concurrent deletion during transition with 404 Not Found', async () => {
      const token = await loginAs(app, 'dispatcher');
      const createRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send({
          priority: 'HIGH',
          incidentType: 'RESPIRATORY_DISTRESS',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'DISPATCHER',
          description: 'Testing concurrent deletion during transition',
          victimCount: 1,
          attachments: [],
        });
      const emgId = createRes.body.id;

      // Simulate concurrent deletion right before transition update
      await Emergency.deleteOne({ _id: emgId });

      const res = await request(app)
        .patch(`/api/emergencies/${emgId}/status`)
        .set(bearer(token))
        .send({ status: 'TRIAGED', currentStatus: 'REPORTED' });

      expect(res.status).toBe(404);
    });
  });

  describe('Scoped Persistent Idempotency', () => {
    const validPayload = {
      priority: 'CRITICAL',
      incidentType: 'CARDIAC_ARREST',
      location: { lat: 28.6139, lng: 77.209, address: 'Connaught Place Block A' },
      source: 'DISPATCHER',
      description: 'Patient collapsed, unresponsive',
      victimCount: 1,
      attachments: [],
    };

    it('creates an emergency without Idempotency-Key preserving backward compatibility', async () => {
      const token = await loginAs(app, 'dispatcher');
      const res = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .send(validPayload);

      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
      expect(res.headers['idempotent-replayed']).toBeUndefined();
    });

    it('creates an emergency and caches response under Idempotency-Key', async () => {
      const token = await loginAs(app, 'dispatcher');
      const key = `idemp-${Date.now()}-1`;

      const res1 = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(validPayload);

      expect(res1.status).toBe(201);
      const emgId1 = res1.body.id;
      expect(emgId1).toBeDefined();

      // Duplicate request with identical key and payload returns cached response
      const res2 = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(validPayload);

      expect(res2.status).toBe(201);
      expect(res2.headers['idempotent-replayed']).toBe('true');
      expect(res2.body.id).toBe(emgId1);

      // Verify in DB that only one emergency was created
      const scopedKey = formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', key);
      const count = await Emergency.countDocuments({ idempotencyKey: scopedKey });
      expect(count).toBe(1);
    });

    it('rejects reused key with mismatched payload fingerprint with 409 Conflict', async () => {
      const token = await loginAs(app, 'dispatcher');
      const key = `idemp-${Date.now()}-2`;

      const res1 = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(validPayload);

      expect(res1.status).toBe(201);

      // Altered payload using the same key
      const alteredPayload = { ...validPayload, description: 'Completely different emergency description' };
      const res2 = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(alteredPayload);

      expect(res2.status).toBe(409);
      expect(res2.body.error.message).toContain('Idempotency key reuse');
    });

    it('rejects concurrent request with 409 when key is currently in progress', async () => {
      const token = await loginAs(app, 'dispatcher');
      const key = `idemp-${Date.now()}-3`;

      // Pre-seed an IN_PROGRESS idempotency key for this user with matching hash
      const payloadHash = createHash('sha256').update(JSON.stringify(validPayload)).digest('hex');
      await IdempotencyKey.create({
        key,
        scope: 'USR-001', // dispatcher user id
        endpoint: 'POST /api/emergencies',
        requestHash: payloadHash,
        status: 'IN_PROGRESS',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(validPayload);

      expect(res.status).toBe(409);
      expect(res.body.error.message).toContain('in progress');
    });

    it('handles simultaneous duplicate requests without creating duplicate emergencies', async () => {
      const token = await loginAs(app, 'dispatcher');
      const key = `idemp-simultaneous-${Date.now()}`;

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/emergencies')
          .set(bearer(token))
          .set('Idempotency-Key', key)
          .send(validPayload),
        request(app)
          .post('/api/emergencies')
          .set(bearer(token))
          .set('Idempotency-Key', key)
          .send(validPayload),
      ]);

      expect([201, 409]).toContain(res1.status);
      expect([201, 409]).toContain(res2.status);
      expect([res1.status, res2.status]).toContain(201);
      const scopedKey = formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', key);
      const createdCount = await Emergency.countDocuments({ idempotencyKey: scopedKey });
      expect(createdCount).toBe(1);
    });

    it('safely recovers unresolved IN_PROGRESS emergency after server failure without duplicate creation', async () => {
      const token = await loginAs(app, 'dispatcher');
      const key = `idemp-recovery-${Date.now()}`;
      const payloadHash = createHash('sha256').update(JSON.stringify(validPayload)).digest('hex');
      const scopedKey = formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', key);

      // 1. Simulate server failure: Emergency was created in DB with scoped idempotencyKey
      const created = await Emergency.create({
        _id: 'EMG-99999',
        status: 'REPORTED',
        priority: 'CRITICAL',
        incidentType: 'CARDIAC_ARREST',
        location: validPayload.location,
        source: 'DISPATCHER',
        description: validPayload.description,
        victimCount: 1,
        reportedAt: new Date(),
        updatedAt: new Date(),
        idempotencyKey: scopedKey,
        timeline: [{ status: 'REPORTED', timestamp: new Date(), note: 'Simulated pre-crash emergency' }],
      });

      // 2. But IdempotencyKey remained IN_PROGRESS due to simulated server crash before response caching
      await IdempotencyKey.create({
        key,
        scope: 'USR-001',
        endpoint: 'POST /api/emergencies',
        requestHash: payloadHash,
        status: 'IN_PROGRESS',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // 3. Client retries with the same Idempotency-Key
      const retryRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(token))
        .set('Idempotency-Key', key)
        .send(validPayload);

      // 4. Verifications: returns 201, replayed header, returns existing emergency, no duplicate created
      expect(retryRes.status).toBe(201);
      expect(retryRes.headers['idempotent-replayed']).toBe('true');
      expect(retryRes.body.id).toBe(created._id);

      const dbCount = await Emergency.countDocuments({ idempotencyKey: scopedKey });
      expect(dbCount).toBe(1);

      // Verify IdempotencyKey status was resolved to COMPLETED
      const resolvedKey = await IdempotencyKey.findOne({ key, scope: 'USR-001', endpoint: 'POST /api/emergencies' });
      expect(resolvedKey?.status).toBe('COMPLETED');
    });

    it('same idempotency key used independently by two users creates two distinct emergencies without collision', async () => {
      const tokenUser1 = await loginAs(app, 'dispatcher'); // USR-001
      const tokenUser2 = await loginAs(app, 'admin'); // USR-005
      const sharedKey = `shared-idemp-${Date.now()}`;

      const [res1, res2] = await Promise.all([
        request(app)
          .post('/api/emergencies')
          .set(bearer(tokenUser1))
          .set('Idempotency-Key', sharedKey)
          .send({ ...validPayload, description: 'User 1 incident' }),
        request(app)
          .post('/api/emergencies')
          .set(bearer(tokenUser2))
          .set('Idempotency-Key', sharedKey)
          .send({ ...validPayload, description: 'User 2 incident' }),
      ]);

      expect(res1.status).toBe(201);
      expect(res2.status).toBe(201);
      expect(res1.body.id).toBeDefined();
      expect(res2.body.id).toBeDefined();
      expect(res1.body.id).not.toBe(res2.body.id);

      const emg1 = await Emergency.findById(res1.body.id);
      const emg2 = await Emergency.findById(res2.body.id);
      expect(emg1?.idempotencyKey).toBe(formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', sharedKey));
      expect(emg2?.idempotencyKey).toBe(formatScopedIdempotencyKey('USR-004', 'POST /api/emergencies', sharedKey));
    });

    it('crash recovery cannot return another user emergency when keys collide', async () => {
      const tokenUser1 = await loginAs(app, 'dispatcher'); // USR-001
      const tokenUser2 = await loginAs(app, 'admin'); // USR-004
      const collisionKey = `collide-key-${Date.now()}`;

      // User 1 creates emergency with collisionKey
      const res1 = await request(app)
        .post('/api/emergencies')
        .set(bearer(tokenUser1))
        .set('Idempotency-Key', collisionKey)
        .send({ ...validPayload, description: 'User 1 private emergency' });
      expect(res1.status).toBe(201);

      // Simulate User 2 had a crash with collisionKey (IdempotencyKey IN_PROGRESS for User 2)
      const payloadHash = createHash('sha256').update(JSON.stringify(validPayload)).digest('hex');
      await IdempotencyKey.create({
        key: collisionKey,
        scope: 'USR-004',
        endpoint: 'POST /api/emergencies',
        requestHash: payloadHash,
        status: 'IN_PROGRESS',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // User 2 retries request with collisionKey
      const res2 = await request(app)
        .post('/api/emergencies')
        .set(bearer(tokenUser2))
        .set('Idempotency-Key', collisionKey)
        .send(validPayload);

      // Must NOT return User 1's emergency!
      if (res2.status === 201) {
        expect(res2.body.id).not.toBe(res1.body.id);
      } else {
        expect(res2.status).toBe(409);
      }
    });

    it('stale-lock races cannot create duplicate emergencies due to database-enforced uniqueness', async () => {
      const key = `race-key-${Date.now()}`;
      const scopedKey = formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', key);

      // 1. First insert succeeds
      const result1 = await createEmergency({
        ...validPayload,
        idempotencyKey: scopedKey,
      });
      expect(result1.id).toBeDefined();

      // 2. Second competing insert with same scoped idempotencyKey catches duplicate key and returns existing id
      const result2 = await createEmergency({
        ...validPayload,
        idempotencyKey: scopedKey,
      });
      expect(result2.id).toBe(result1.id);

      const count = await Emergency.countDocuments({ idempotencyKey: scopedKey });
      expect(count).toBe(1);
    });
  });

  describe('Stranded Ambulance Reconciliation', () => {
    it('recovers stranded ambulances linked to terminal or deleted emergencies and leaves active intact', async () => {
      const now = new Date();

      const emgCompleted = await Emergency.create({
        _id: 'EMG-RECON-1',
        status: 'COMPLETED',
        priority: 'MEDIUM',
        incidentType: 'VEHICLE_COLLISION',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Completed incident',
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
      });

      const emgActive = await Emergency.create({
        _id: 'EMG-RECON-2',
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'CARDIAC_ARREST',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Active reported incident',
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
      });

      await Ambulance.create([
        {
          _id: 'AMB-R1',
          status: 'ASSIGNED',
          currentEmergency: emgCompleted._id,
          location: { lat: 28.6139, lng: 77.209 },
          speed: 0,
          heading: 0,
          active: true,
          lastUpdated: now,
        },
        {
          _id: 'AMB-R2',
          status: 'ASSIGNED',
          currentEmergency: 'EMG-DOES-NOT-EXIST',
          location: { lat: 28.6139, lng: 77.209 },
          speed: 0,
          heading: 0,
          active: true,
          lastUpdated: now,
        },
        {
          _id: 'AMB-R3',
          status: 'ASSIGNED',
          currentEmergency: emgActive._id,
          location: { lat: 28.6139, lng: 77.209 },
          speed: 0,
          heading: 0,
          active: true,
          lastUpdated: now,
        },
      ]);

      const result = await reconcileStrandedAmbulances();

      expect(result.released).toContain('AMB-R1');
      expect(result.released).toContain('AMB-R2');
      expect(result.released).not.toContain('AMB-R3');
      expect(result.skippedActive).toContain('AMB-R3');

      const ambR1 = await Ambulance.findById('AMB-R1').lean();
      const ambR2 = await Ambulance.findById('AMB-R2').lean();
      const ambR3 = await Ambulance.findById('AMB-R3').lean();

      expect(ambR1?.status).toBe('AVAILABLE');
      expect(ambR1?.currentEmergency).toBeNull();
      expect(ambR2?.status).toBe('AVAILABLE');
      expect(ambR2?.currentEmergency).toBeNull();

      expect(ambR3?.status).toBe('ASSIGNED');
      expect(ambR3?.currentEmergency).toBe(emgActive._id);

      const audits = await AuditLog.find({ action: 'reconciliation.ambulance_released' });
      expect(audits.length).toBeGreaterThanOrEqual(2);

      const secondResult = await reconcileStrandedAmbulances();
      expect(secondResult.released.length).toBe(0);
    });
  });

  describe('Deterministic Pagination Tie-Breakers', () => {
    it('identical timestamps produce deterministic non-overlapping pages with _id: -1 tie-breaker', async () => {
      const token = await loginAs(app, 'dispatcher');
      const frozenTimestamp = new Date('2026-05-01T12:00:00.000Z');

      await Notification.insertMany([
        { _id: 'N8001', category: 'INFO', title: 'Tie 1', message: 'M1', timestamp: frozenTimestamp, read: false },
        { _id: 'N8002', category: 'INFO', title: 'Tie 2', message: 'M2', timestamp: frozenTimestamp, read: false },
        { _id: 'N8003', category: 'INFO', title: 'Tie 3', message: 'M3', timestamp: frozenTimestamp, read: false },
        { _id: 'N8004', category: 'INFO', title: 'Tie 4', message: 'M4', timestamp: frozenTimestamp, read: false },
      ]);

      const [page1Res, page2Res] = await Promise.all([
        request(app).get('/api/notifications?limit=2&skip=0').set(bearer(token)),
        request(app).get('/api/notifications?limit=2&skip=2').set(bearer(token)),
      ]);

      expect(page1Res.status).toBe(200);
      expect(page2Res.status).toBe(200);

      const page1Ids = page1Res.body.map((n: { id: string }) => n.id);
      const page2Ids = page2Res.body.map((n: { id: string }) => n.id);

      for (const id of page1Ids) {
        expect(page2Ids).not.toContain(id);
      }
    });
  });
});
