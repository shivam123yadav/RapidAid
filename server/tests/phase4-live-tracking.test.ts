import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { seedGwaliorDemoResources } from '../src/seed/seedGwaliorDemo.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Ambulance } from '../src/models/Ambulance.js';
import { Emergency } from '../src/models/Emergency.js';
import { User } from '../src/models/User.js';
import { stepAmbulanceSimulation, setAmbulanceTelemetryStale } from '../src/services/gpsSimulator.js';

const app = createApp();

useTestDatabase(async () => {
  await runSeed();
  await seedGwaliorDemoResources();
});

describe('Phase 4.1: Live Ambulance GPS Tracking Integration Suite', () => {
  let dispatcherToken: string;
  let citizenToken: string;
  let unassignedCitizenToken: string;
  let assignedCrewToken: string;
  let unassignedCrewToken: string;

  beforeAll(async () => {
    // Ensure test citizen USR-008 exists and owns EMG-20485 assigned to AMB-051
    await Emergency.updateOne(
      { _id: 'EMG-20485' },
      { $set: { citizenId: 'USR-008', assignedAmbulance: 'AMB-051', status: 'AMBULANCE_ASSIGNED' } },
    );
    await Ambulance.updateOne(
      { _id: 'AMB-051' },
      { $set: { currentEmergency: 'EMG-20485', status: 'ASSIGNED' } },
    );

    // 1. Dispatcher
    dispatcherToken = await loginAs(app, 'dispatcher');

    // 2. Citizen USR-008 (owns EMG-20485)
    citizenToken = await loginAs(app, 'citizen');

    // 3. Unassigned Citizen (USR-099)
    const hash = await bcrypt.hash('demo123', 10);
    await User.updateOne(
      { _id: 'USR-099' },
      {
        $set: {
          name: 'Unassigned Citizen',
          email: 'citizen.other@rapidaid.com',
          passwordHash: hash,
          role: 'CITIZEN',
          active: true,
          emailVerified: true,
        },
      },
      { upsert: true },
    );

    const unassignedCitLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: 'citizen.other@rapidaid.com', password: 'demo123', role: 'CITIZEN' });
    unassignedCitizenToken = unassignedCitLogin.body.accessToken;

    // 4. Assigned crew on AMB-051 (USR-031 Rahul Verma)
    const crew1Login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crew-gwl-01@rapidaid.com', password: 'demo123', role: 'AMBULANCE_CREW' });
    assignedCrewToken = crew1Login.body.accessToken;

    // 5. Unassigned crew on AMB-052 (USR-033 Dr. Alok Mishra)
    const crew3Login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'crew-gwl-03@rapidaid.com', password: 'demo123', role: 'AMBULANCE_CREW' });
    unassignedCrewToken = crew3Login.body.accessToken;
  });

  describe('1. Ambulance Telemetry Ingestion & Validation', () => {
    it('accepts authenticated valid telemetry update from assigned crew', async () => {
      const now = new Date();
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(assignedCrewToken))
        .send({
          location: { lat: 26.2392, lng: 78.2185 },
          speed: 35,
          heading: 205,
          eta: 180,
          timestamp: now.toISOString(),
          isSimulated: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.id || res.body._id).toBe('AMB-051');
      expect(res.body.location.lat).toBeCloseTo(26.2392);
      expect(res.body.location.lng).toBeCloseTo(78.2185);
      expect(res.body.speed).toBe(35);
      expect(res.body.isSimulated).toBe(true);
    });

    it('rejects telemetry update if timestamp is in the future (>60s skew)', async () => {
      const futureTime = new Date(Date.now() + 120_000); // 2 minutes in the future
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          location: { lat: 26.2395, lng: 78.2186 },
          timestamp: futureTime.toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/future/i);
    });

    it('rejects telemetry update if timestamp is stale (>300s old)', async () => {
      const staleTime = new Date(Date.now() - 400_000); // 400s old
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          location: { lat: 26.2395, lng: 78.2186 },
          timestamp: staleTime.toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/stale/i);
    });

    it('rejects out-of-order timestamp older than current vehicle state', async () => {
      const t1 = new Date();
      await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          speed: 20,
          timestamp: t1.toISOString(),
        });

      const olderTime = new Date(t1.getTime() - 5000);
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          speed: 22,
          timestamp: olderTime.toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/older than current/i);
    });

    it('rejects impossible delta jumps (apparent speed > 250 km/h over >0.5km)', async () => {
      const t1 = new Date();
      await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          location: { lat: 26.2392, lng: 78.2185 },
          timestamp: t1.toISOString(),
        });

      // Jump 10 km away 2 seconds later (~18,000 km/h)
      const t2 = new Date(t1.getTime() + 2000);
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(dispatcherToken))
        .send({
          location: { lat: 26.3300, lng: 78.3000 },
          timestamp: t2.toISOString(),
        });

      expect(res.status).toBe(400);
      expect(res.body.error?.message).toMatch(/Impossible telemetry jump/i);
    });

    it('rejects crew member attempting to update telemetry for an unassigned ambulance', async () => {
      // USR-033 is rostered on AMB-052, attempting to update AMB-051
      const res = await request(app)
        .patch('/api/ambulances/AMB-051/telemetry')
        .set(bearer(unassignedCrewToken))
        .send({
          speed: 25,
        });

      expect(res.status).toBe(403);
      expect(res.body.error?.message).toMatch(/only update telemetry for your assigned ambulance/i);
    });
  });

  describe('2. Real-time Telemetry Scoping & Citizen Protection', () => {
    it('allows dispatcher to view entire operational fleet', async () => {
      const res = await request(app)
        .get('/api/ambulances')
        .set(bearer(dispatcherToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((a: { id?: string; _id?: string }) => a.id || a._id);
      expect(ids).toContain('AMB-051');
      expect(ids).toContain('AMB-052');
    });

    it('allows citizen to see only the ambulance assigned to their emergency', async () => {
      const res = await request(app)
        .get('/api/ambulances')
        .set(bearer(citizenToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((a: { id?: string; _id?: string }) => a.id || a._id);
      expect(ids).toContain('AMB-051');
      expect(ids).not.toContain('AMB-052');
    });

    it('returns empty list for citizen with no assigned emergency', async () => {
      const res = await request(app)
        .get('/api/ambulances')
        .set(bearer(unassignedCitizenToken));

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(0);
    });

    it('returns 404 when unassigned citizen probes another ambulance detail endpoint', async () => {
      const res = await request(app)
        .get('/api/ambulances/AMB-051')
        .set(bearer(unassignedCitizenToken));

      expect(res.status).toBe(404);
    });
  });

  describe('3. GPS Simulator & Telemetry Freshness in rapidaid_phase1_test', () => {
    it('simulates progressive ambulance movement along waypoints towards EMG-20485', async () => {
      const stepRes = await stepAmbulanceSimulation({ ambulanceId: 'AMB-051', stepIndex: 3 });
      expect(stepRes.waypoint.step).toBe(3);
      expect(stepRes.ambulance.speed).toBe(40);
      expect(stepRes.ambulance.isSimulated).toBe(true);

      const dbAmb = await Ambulance.findById('AMB-051').lean();
      expect(dbAmb?.location?.lat).toBe(26.2338);
      expect(dbAmb?.location?.lng).toBe(78.2158);
      expect(dbAmb?.isSimulated).toBe(true);
    });

    it('flags ambulance telemetry as stale when GPS updates stop (>300s)', async () => {
      await setAmbulanceTelemetryStale('AMB-051');
      const dbAmb = await Ambulance.findById('AMB-051').lean();
      expect(dbAmb).toBeDefined();

      const diffSec = Math.floor((Date.now() - new Date(dbAmb!.lastUpdated).getTime()) / 1000);
      expect(diffSec).toBeGreaterThanOrEqual(300);
    });
  });
});
