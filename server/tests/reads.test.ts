import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Hospital } from '../src/models/index.js';

const app = createApp();
useTestDatabase(runSeed);

describe('read endpoints', () => {
  it('lists ambulances with crew shaped for the frontend (id, no _id)', async () => {
    // A fleet reader (dispatcher) sees every unit. Crew are scoped to their
    // own ambulance by design — asserted separately in ambulances-rbac.test.ts.
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app).get('/api/ambulances').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(8);

    const amb = res.body.find((a: { id: string }) => a.id === 'AMB-017');
    expect(amb).toMatchObject({ status: 'EN_ROUTE', currentEmergency: 'EMG-20481', speed: 45 });
    expect(amb).not.toHaveProperty('_id');
    expect(amb.crew[0]).toEqual({
      id: 'C001',
      name: 'Dr. Sharma',
      role: 'Physician',
      certification: ['ACLS', 'Trauma'],
    });
    expect(amb.crew[0]).not.toHaveProperty('_id');
    // The internal authz link (crew seat → login) must never reach clients.
    expect(amb.crew[0]).not.toHaveProperty('userId');

    expect((await request(app).get('/api/ambulances/AMB-999').set(bearer(token))).status).toBe(404);
    expect((await request(app).get('/api/ambulances/xx').set(bearer(token))).status).toBe(400);
  });

  it('scopes hospital staff to their own facility; full-view roles see the network', async () => {
    // Hospital Staff hold only HOSPITAL_VIEW_OWN — the matrix says "Own
    // Hospital + Referrals", so the list must be exactly their facility, never
    // the network. (A full-view role still gets all four.)
    const staff = await loginAs(app, 'hospital');
    const own = await request(app).get('/api/hospitals').set(bearer(staff));
    expect(own.status).toBe(200);
    expect(own.body.length).toBe(1);
    expect(own.body[0].id).toBe('HOSP-01');

    // A direct GET of another facility's record is refused (ownership check).
    const foreign = await request(app).get('/api/hospitals/HOSP-02').set(bearer(staff));
    expect(foreign.status).toBe(403);
    expect(foreign.body.error.code).toBe('FORBIDDEN');

    // Dispatcher holds HOSPITAL_VIEW → the full network for routing decisions.
    // Asserted against the collection rather than a hardcoded number, so growing
    // the demo network (it now spans two cities) does not break the intent.
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app).get('/api/hospitals').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(await Hospital.countDocuments());
    expect(res.body.length).toBeGreaterThanOrEqual(4);
    const hosp = res.body.find((h: { id: string }) => h.id === 'HOSP-01');
    expect(hosp).toMatchObject({ name: 'AIIMS Trauma Center', emergencyCapacity: 'AVAILABLE' });
    expect(hosp.currentLoad).toBe(72);
    expect(hosp).not.toHaveProperty('_id');
    expect((await request(app).get('/api/hospitals/HOSP-999').set(bearer(token))).status).toBe(404);
  });

  it('reads analytics with all five series the dashboard expects', async () => {
    const token = await loginAs(app, 'analyst');
    const res = await request(app).get('/api/analytics').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.emergencyVolume).toHaveLength(7);
    expect(res.body.responseTimes).toHaveLength(7);
    expect(res.body.ambulanceUtilization.length).toBeGreaterThanOrEqual(7);
    expect(res.body.incidentTypes.length).toBeGreaterThan(0);
    expect(res.body.hospitalLoad).toHaveLength(await Hospital.countDocuments());
    expect(res.body.emergencyVolume[0]).toMatchObject({ date: '2026-01-09', count: 42 });
    expect(res.body.incidentTypes.map((t: { type: string }) => t.type)).toContain('Vehicle Collision');
  });

  it('reports system health with a live database ping', async () => {
    const token = await loginAs(app, 'admin');
    const res = await request(app).get('/api/system/health').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OPERATIONAL');
    const db = res.body.services.find((s: { service: string }) => s.service === 'Database');
    expect(db.status).toBe('OPERATIONAL');
    expect(typeof db.latency).toBe('number');
    expect(res.body.services.length).toBe(7);
    expect((await request(app).get('/api/system/health')).status).toBe(401);
  });
});

describe('notifications', () => {
  it('lists notifications newest-first with frontend shape', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app).get('/api/notifications').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(6);
    expect(res.body[0]).toHaveProperty('category');
    expect(res.body[0]).not.toHaveProperty('_id');
  });

  it('marks one read (idempotent), read-all clears the rest, unknown 404s', async () => {
    const token = await loginAs(app, 'dispatcher');
    const one = await request(app).patch('/api/notifications/N001/read').set(bearer(token));
    expect(one.status).toBe(200);
    expect(one.body.read).toBe(true);

    const again = await request(app).patch('/api/notifications/N001/read').set(bearer(token));
    expect(again.status).toBe(200);
    expect(again.body.read).toBe(true);

    const all = await request(app).patch('/api/notifications/read-all').set(bearer(token));
    expect(all.status).toBe(200);
    expect(all.body.success).toBe(true);

    const res = await request(app).get('/api/notifications').set(bearer(token));
    expect(res.body.every((n: { read: boolean }) => n.read)).toBe(true);

    expect(
      (await request(app).patch('/api/notifications/N999/read').set(bearer(token))).status,
    ).toBe(404);
  });
});

describe('audit RBAC', () => {
  it('full-view roles read the whole trail; own-activity roles are scoped; others get 403', async () => {
    // AUDIT_VIEW → the complete trail.
    for (const who of ['auditor', 'supervisor', 'admin', 'analyst'] as const) {
      const token = await loginAs(app, who);
      const res = await request(app).get('/api/audit').set(bearer(token));
      expect(res.status, `expected 200 for ${who}`).toBe(200);
      expect(res.body.length).toBeGreaterThanOrEqual(6);
      expect(res.body[0]).toHaveProperty('requestId');
    }

    // The matrix lists DISPATCHER under Audit as "No Access" — the guard is
    // permission-driven, so the denial is 403 FORBIDDEN (authenticated, but
    // not permitted), never 401.
    for (const who of ['dispatcher', 'citizen'] as const) {
      const token = await loginAs(app, who);
      const res = await request(app).get('/api/audit').set(bearer(token));
      expect(res.status, `expected 403 for ${who}`).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }

    // Crew / Hospital Staff hold AUDIT_VIEW_OWN: allowed, but only their own
    // actions, so the payload can never expose another actor's activity.
    for (const who of ['crew', 'hospital'] as const) {
      const token = await loginAs(app, who);
      const res = await request(app).get('/api/audit').set(bearer(token));
      expect(res.status, `expected 200 for ${who}`).toBe(200);
      const actors = new Set<string>(res.body.map((e: { actor: string }) => e.actor));
      expect(actors.size).toBeLessThanOrEqual(1);
    }
  });
});
