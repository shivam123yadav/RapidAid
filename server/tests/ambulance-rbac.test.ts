import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs, type DemoRole } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

/** A unit the demo crew member (USR-002) is NOT rostered on. */
const OTHER_AMBULANCE = 'AMB-017';
/** The unit the demo crew member IS rostered on (seeded with userId: USR-002). */
const OWN_AMBULANCE = 'AMB-031';

describe('ambulance RBAC', () => {
  describe('fleet visibility', () => {
    it('gives managers, dispatch, analyst and auditor the full fleet while hospital staff see only incoming units', async () => {
      for (const who of ['admin', 'supervisor', 'dispatcher', 'analyst', 'auditor'] as DemoRole[]) {
        const res = await request(app).get('/api/ambulances').set(bearer(await loginAs(app, who)));
        expect(res.status, `${who} should read the fleet`).toBe(200);
        expect(res.body.length, `${who} should see every unit`).toBe(6);
      }
      const hospital = await request(app).get('/api/ambulances').set(bearer(await loginAs(app, 'hospital')));
      expect(hospital.status).toBe(200);
      expect(hospital.body.map((a: { id: string }) => a.id).sort()).toEqual(['AMB-005', 'AMB-017']);
    });

    it('scopes a crew member to their assigned ambulance only', async () => {
      const res = await request(app).get('/api/ambulances').set(bearer(await loginAs(app, 'crew')));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe(OWN_AMBULANCE);
    });

    it('denies a citizen any fleet access', async () => {
      const res = await request(app).get('/api/ambulances').set(bearer(await loginAs(app, 'citizen')));
      expect(res.status).toBe(403);
    });

    it('hides other units from a crew member probing by id (404, not 403)', async () => {
      const crew = await loginAs(app, 'crew');
      const own = await request(app).get(`/api/ambulances/${OWN_AMBULANCE}`).set(bearer(crew));
      expect(own.status).toBe(200);

      // 404 rather than 403 so the response does not confirm the unit exists.
      const other = await request(app).get(`/api/ambulances/${OTHER_AMBULANCE}`).set(bearer(crew));
      expect(other.status).toBe(404);
    });

    it('never leaks the internal crew userId binding', async () => {
      const admin = await loginAs(app, 'admin');
      const res = await request(app).get('/api/ambulances').set(bearer(admin));
      expect(res.status).toBe(200);
      for (const amb of res.body) {
        for (const member of amb.crew) {
          expect(member).not.toHaveProperty('userId');
        }
      }
    });
  });

  describe('adding ambulances', () => {
    const body = { location: { lat: 28.61, lng: 77.2 }, capabilities: ['Basic'] };

    it('allows admin and supervisor', async () => {
      for (const who of ['admin', 'supervisor'] as DemoRole[]) {
        const res = await request(app)
          .post('/api/ambulances')
          .set(bearer(await loginAs(app, who)))
          .send(body);
        expect(res.status, `${who} should add ambulances`).toBe(201);
        expect(res.body.id).toMatch(/^AMB-\d+$/);
        expect(res.body.status).toBe('AVAILABLE');
      }
    });

    it('denies everyone else', async () => {
      for (const who of ['dispatcher', 'crew', 'hospital', 'analyst', 'auditor', 'citizen'] as DemoRole[]) {
        const res = await request(app)
          .post('/api/ambulances')
          .set(bearer(await loginAs(app, who)))
          .send(body);
        expect(res.status, `expected 403 for ${who}`).toBe(403);
      }
    });
  });
  describe('editing ambulance records', () => {
    it('allows admin and supervisor', async () => {
      for (const who of ['admin', 'supervisor'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}`)
          .set(bearer(await loginAs(app, who)))
          .send({ capabilities: ['Basic', 'ICU'] });
        expect(res.status, `${who} should edit ambulance records`).toBe(200);
        expect(res.body.capabilities).toEqual(['Basic', 'ICU']);
      }
    });

    it('denies dispatcher — coordination is not record editing', async () => {
      const res = await request(app)
        .patch(`/api/ambulances/${OTHER_AMBULANCE}`)
        .set(bearer(await loginAs(app, 'dispatcher')))
        .send({ capabilities: ['Trauma'] });
      expect(res.status).toBe(403);
    });

    it('denies crew, hospital, analyst, auditor and citizen', async () => {
      for (const who of ['crew', 'hospital', 'analyst', 'auditor', 'citizen'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}`)
          .set(bearer(await loginAs(app, who)))
          .send({ capabilities: ['Trauma'] });
        expect(res.status, `expected 403 for ${who}`).toBe(403);
      }
    });

    it('rejects an empty patch and a malformed id', async () => {
      const admin = await loginAs(app, 'admin');
      const empty = await request(app)
        .patch(`/api/ambulances/${OTHER_AMBULANCE}`)
        .set(bearer(admin))
        .send({});
      expect(empty.status).toBe(400);

      const bad = await request(app)
        .patch('/api/ambulances/nope')
        .set(bearer(admin))
        .send({ speed: 10 });
      expect(bad.status).toBe(400);
    });
  });

  describe('assigning crew', () => {
    it('allows admin and supervisor to bind a seat to a login', async () => {
      for (const who of ['admin', 'supervisor'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}/crew`)
          .set(bearer(await loginAs(app, who)))
          .send({ crew: [{ id: 'C900', name: 'Test Medic', role: 'EMT', certification: ['BLS'] }] });
        expect(res.status, `${who} should assign crew`).toBe(200);
        expect(res.body.crew).toHaveLength(1);
        expect(res.body.crew[0].name).toBe('Test Medic');
      }
    });

    it('denies dispatcher, crew, analyst, auditor, hospital and citizen', async () => {
      for (const who of ['dispatcher', 'crew', 'analyst', 'auditor', 'hospital', 'citizen'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}/crew`)
          .set(bearer(await loginAs(app, who)))
          .send({ crew: [] });
        expect(res.status, `expected 403 for ${who}`).toBe(403);
      }
    });
  });
  describe('availability tracking', () => {
    it('allows admin, supervisor and dispatcher', async () => {
      for (const who of ['admin', 'supervisor', 'dispatcher'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}/status`)
          .set(bearer(await loginAs(app, who)))
          .send({ status: 'MAINTENANCE' });
        expect(res.status, `${who} should track availability`).toBe(200);
        expect(res.body.status).toBe('MAINTENANCE');
      }
    });

    it('denies crew, hospital, analyst, auditor and citizen', async () => {
      for (const who of ['crew', 'hospital', 'analyst', 'auditor', 'citizen'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OTHER_AMBULANCE}/status`)
          .set(bearer(await loginAs(app, who)))
          .send({ status: 'OFFLINE' });
        expect(res.status, `expected 403 for ${who}`).toBe(403);
      }
    });

    it('rejects an in-mission status that is not an availability state', async () => {
      const res = await request(app)
        .patch(`/api/ambulances/${OTHER_AMBULANCE}/status`)
        .set(bearer(await loginAs(app, 'dispatcher')))
        .send({ status: 'EN_ROUTE' });
      expect(res.status).toBe(400);
    });
  });

  describe('crew operational updates', () => {
    it('lets crew update telemetry on their own ambulance', async () => {
      const res = await request(app)
        .patch(`/api/ambulances/${OWN_AMBULANCE}/telemetry`)
        .set(bearer(await loginAs(app, 'crew')))
        .send({ status: 'EN_ROUTE', location: { lat: 28.64, lng: 77.23 }, eta: 420 });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('EN_ROUTE');
    });

    it('forbids crew from touching an ambulance they are not rostered on', async () => {
      const res = await request(app)
        .patch(`/api/ambulances/${OTHER_AMBULANCE}/telemetry`)
        .set(bearer(await loginAs(app, 'crew')))
        .send({ status: 'EN_ROUTE' });
      expect(res.status).toBe(403);
    });

    it('denies hospital staff and read-only roles', async () => {
      for (const who of ['hospital', 'analyst', 'auditor', 'citizen'] as DemoRole[]) {
        const res = await request(app)
          .patch(`/api/ambulances/${OWN_AMBULANCE}/telemetry`)
          .set(bearer(await loginAs(app, who)))
          .send({ status: 'EN_ROUTE' });
        expect(res.status, `expected 403 for ${who}`).toBe(403);
      }
    });
  });
});
