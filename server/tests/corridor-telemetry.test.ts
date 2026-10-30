import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

describe('green corridor simulation', () => {
  it('computes a deterministic corridor with plausible savings', async () => {
    const token = await loginAs(app, 'dispatcher');
    const res = await request(app)
      .get('/api/simulations/green-corridor/EMG-20481')
      .set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ emergencyId: 'EMG-20481', status: 'COMPLETE' });
    expect(res.body.route).toHaveLength(5);
    expect(res.body.baselineETA).toBeGreaterThan(0);
    expect(res.body.simulatedETA).toBeLessThan(res.body.baselineETA);
    expect(res.body.timeSaved).toBe(res.body.baselineETA - res.body.simulatedETA);
    expect(res.body.signalsAffected).toBeGreaterThanOrEqual(3);
    expect(res.body).not.toHaveProperty('_id');

    const res2 = await request(app)
      .get('/api/simulations/green-corridor/EMG-20481')
      .set(bearer(token));
    expect(res2.body).toEqual(res.body); // determinism
  });

  it('POST run audits the simulation; bad ids fail correctly', async () => {
    const token = await loginAs(app, 'dispatcher');
    const run = await request(app)
      .post('/api/simulations/green-corridor/EMG-20481/run')
      .set(bearer(token));
    expect(run.status).toBe(200);
    expect(run.body.status).toBe('COMPLETE');

    const adminToken = await loginAs(app, 'admin');
    const audit = await request(app).get('/api/audit').set(bearer(adminToken));
    expect(
      audit.body.some((a: { action: string }) => a.action === 'simulation.green_corridor_run'),
    ).toBe(true);

    expect(
      (await request(app).get('/api/simulations/green-corridor/EMG-99999').set(bearer(token))).status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/simulations/green-corridor/junk').set(bearer(token))).status,
    ).toBe(400);
  });
});

describe('ambulance telemetry', () => {
  it('crew can update own unit; hospital staff cannot (403)', async () => {
    const crew = await loginAs(app, 'crew');
    const res = await request(app)
      .patch('/api/ambulances/AMB-031/telemetry')
      .set(bearer(crew))
      .send({ location: { lat: 28.641, lng: 77.231 }, speed: 52, heading: 90, status: 'EN_ROUTE' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ speed: 52, heading: 90, status: 'EN_ROUTE' });
    expect(res.body.location.lat).toBeCloseTo(28.641);

    const hospital = await loginAs(app, 'hospital');
    const denied = await request(app)
      .patch('/api/ambulances/AMB-031/telemetry')
      .set(bearer(hospital))
      .send({ speed: 10 });
    expect(denied.status).toBe(403);
  });

  it('rejects empty payloads (400) and out-of-range values (400)', async () => {
    const crew = await loginAs(app, 'crew');
    expect(
      (await request(app).patch('/api/ambulances/AMB-031/telemetry').set(bearer(crew)).send({})).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch('/api/ambulances/AMB-031/telemetry')
          .set(bearer(crew))
          .send({ speed: -5 })
      ).status,
    ).toBe(400);
  });
});
