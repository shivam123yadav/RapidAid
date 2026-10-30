import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';

const app = createApp();
useTestDatabase(runSeed);

describe('cross-cutting behaviour', () => {
  it('unknown /api routes return the structured 404 envelope with requestId', async () => {
    const res = await request(app).get('/api/definitely-not-a-route');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.requestId).toBeTruthy();
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('malformed JSON body returns 400 INVALID_JSON', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .set('Content-Type', 'application/json')
      .send('{ this is not json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });

  it('echoes a well-formed client-supplied x-request-id for tracing', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('x-request-id', 'client-trace-123');
    expect(res.status).toBe(401); // auth still enforced…
    expect(res.headers['x-request-id']).toBe('client-trace-123'); // …but the trace id is preserved
  });

  it('sanitizes a hostile x-request-id instead of reflecting it', async () => {
    const res = await request(app)
      .get('/api/notifications')
      .set('x-request-id', '<script>alert(1)</script>');
    expect(res.headers['x-request-id']).not.toContain('<script>');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/); // replaced with a UUID
  });

  it('health endpoint requires authentication', async () => {
    expect((await request(app).get('/api/system/health')).status).toBe(401);
  });

  describe('defensive security headers', () => {
    it('applies X-Content-Type-Options and Referrer-Policy on successful probe and API responses', async () => {
      // 1. Unauthenticated liveness probe
      const livenessRes = await request(app).get('/healthz');
      expect(livenessRes.status).toBe(200);
      expect(livenessRes.headers['x-content-type-options']).toBe('nosniff');
      expect(livenessRes.headers['referrer-policy']).toBe('no-referrer');

      // 2. Unauthenticated readiness probe
      const readyRes = await request(app).get('/readyz');
      expect(readyRes.status).toBe(200);
      expect(readyRes.headers['x-content-type-options']).toBe('nosniff');
      expect(readyRes.headers['referrer-policy']).toBe('no-referrer');

      // 3. Authenticated API response (Admin reading system health)
      const adminToken = await loginAs(app, 'admin');
      const healthRes = await request(app)
        .get('/api/system/health')
        .set(bearer(adminToken));
      expect(healthRes.status).toBe(200);
      expect(healthRes.headers['x-content-type-options']).toBe('nosniff');
      expect(healthRes.headers['referrer-policy']).toBe('no-referrer');
    });

    it('applies X-Content-Type-Options and Referrer-Policy on API error responses (401, 404, 400)', async () => {
      // 1. 401 Unauthorized
      const unauthRes = await request(app).get('/api/system/health');
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.headers['x-content-type-options']).toBe('nosniff');
      expect(unauthRes.headers['referrer-policy']).toBe('no-referrer');

      // 2. 404 Not Found
      const notFoundRes = await request(app).get('/api/non-existent-endpoint');
      expect(notFoundRes.status).toBe(404);
      expect(notFoundRes.headers['x-content-type-options']).toBe('nosniff');
      expect(notFoundRes.headers['referrer-policy']).toBe('no-referrer');

      // 3. 400 Bad Request (Invalid JSON body)
      const citizenToken = await loginAs(app, 'citizen');
      const badReqRes = await request(app)
        .post('/api/emergencies')
        .set(bearer(citizenToken))
        .set('Content-Type', 'application/json')
        .send('{ invalid json payload');
      expect(badReqRes.status).toBe(400);
      expect(badReqRes.headers['x-content-type-options']).toBe('nosniff');
      expect(badReqRes.headers['referrer-policy']).toBe('no-referrer');
    });
  });
});
