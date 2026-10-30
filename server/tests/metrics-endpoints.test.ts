import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs, type DemoRole } from './helpers.js';
import { metricsRegistry, resetMetricsRegistry } from '../src/metrics/registry.js';
import { setMongoConnectionState } from '../src/metrics/databaseMetrics.js';
import {
  isStrongScraperToken,
  constantTimeTokenCompare,
} from '../src/middleware/metricsAuth.js';

// Setup database with seeded users
useTestDatabase(runSeed);

const VALID_SCRAPER_TOKEN = '0123456789abcdef0123456789abcdef'; // 32-char hex token
const DEFAULT_APP = createApp();
const ENABLED_SCRAPER_APP = createApp({
  metricsScrapeEnabled: true,
  metricsScrapeToken: VALID_SCRAPER_TOKEN,
});

describe('Phase 4.3.4: Secure Metrics Endpoints', () => {
  describe('Unit validation: Token Strength and Constant-Time Comparison', () => {
    it('isStrongScraperToken enforces length, non-placeholder, and entropy', () => {
      // Rejections
      expect(isStrongScraperToken(undefined)).toBe(false);
      expect(isStrongScraperToken(null)).toBe(false);
      expect(isStrongScraperToken('')).toBe(false);
      expect(isStrongScraperToken('short')).toBe(false);
      expect(isStrongScraperToken('123456789012345')).toBe(false); // 15 chars
      expect(isStrongScraperToken('changeme12345678')).toBe(false); // weak placeholder
      expect(isStrongScraperToken('secret-token-key-123')).toBe(false); // weak placeholder
      expect(isStrongScraperToken('password12345678')).toBe(false); // weak placeholder
      expect(isStrongScraperToken('1234567890123456')).toBe(false); // weak placeholder
      expect(isStrongScraperToken('change-me-to-a-long-random-hex-string')).toBe(false);
      expect(isStrongScraperToken('aaaaaaaaaaaaaaaa')).toBe(false); // low entropy (< 4 unique chars)
      expect(isStrongScraperToken('abababababababab')).toBe(false); // 2 unique chars

      // Acceptances
      expect(isStrongScraperToken(VALID_SCRAPER_TOKEN)).toBe(true);
      expect(isStrongScraperToken('rapidAid_prometheus_scrape_token_2026_xyz')).toBe(true);
    });

    it('constantTimeTokenCompare performs timing-safe comparison on arbitrary length strings', () => {
      // Exact matches
      expect(constantTimeTokenCompare(VALID_SCRAPER_TOKEN, VALID_SCRAPER_TOKEN)).toBe(true);
      expect(constantTimeTokenCompare('a-very-long-test-token-1234567890', 'a-very-long-test-token-1234567890')).toBe(true);

      // Mismatches
      expect(constantTimeTokenCompare(VALID_SCRAPER_TOKEN, '0123456789abcdef0123456789abcdeg')).toBe(false);
      expect(constantTimeTokenCompare(VALID_SCRAPER_TOKEN, '0123456789abcdef0123456789abcdef0')).toBe(false);
      expect(constantTimeTokenCompare(VALID_SCRAPER_TOKEN, 'short')).toBe(false);
      expect(constantTimeTokenCompare('', VALID_SCRAPER_TOKEN)).toBe(false);
      expect(constantTimeTokenCompare(VALID_SCRAPER_TOKEN, '')).toBe(false);
      expect(constantTimeTokenCompare(null as unknown as string, VALID_SCRAPER_TOKEN)).toBe(false);
    });
  });

  describe('Authenticated Admin Endpoint: GET /api/system/metrics', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(DEFAULT_APP).get('/api/system/metrics');
      expect(res.status).toBe(401);
      expect(res.body.error).toBeDefined();
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      // Must not leak metric payload in error response
      expect(typeof res.body).toBe('object');
      expect(JSON.stringify(res.body)).not.toContain('rapidaid_');
    });

    it('rejects authenticated users lacking P.SYSTEM_READ with 403', async () => {
      const nonAdminRoles: DemoRole[] = [
        'citizen',
        'dispatcher',
        'crew',
        'hospital',
        'supervisor',
        'analyst',
        'auditor',
      ];

      for (const role of nonAdminRoles) {
        const token = await loginAs(DEFAULT_APP, role);
        const res = await request(DEFAULT_APP)
          .get('/api/system/metrics')
          .set(bearer(token));

        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
        expect(res.text).not.toContain('rapidaid_mongodb_connection_state');
      }
    });

    it('authorizes ADMIN (possessing P.SYSTEM_READ) with 200 and Prometheus exposition format', async () => {
      const adminToken = await loginAs(DEFAULT_APP, 'admin');
      const res = await request(DEFAULT_APP)
        .get('/api/system/metrics')
        .set(bearer(adminToken));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['content-type']).toContain('version=0.0.4');

      // Defensive headers
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');

      // Verify registered metrics from Phases 4.3.1 - 4.3.3 are present and retain names
      expect(res.text).toContain('# HELP rapidaid_mongodb_connection_state');
      expect(res.text).toContain('# TYPE rapidaid_mongodb_connection_state gauge');
      expect(res.text).toContain('rapidaid_mongodb_connection_state');

      expect(res.text).toContain('rapidaid_mongodb_connection_events_total');
      expect(res.text).toContain('rapidaid_mongodb_operation_duration_seconds');
      expect(res.text).toContain('rapidaid_mongodb_pool_connections');
      expect(res.text).toContain('rapidaid_mongodb_pool_checkout_failures_total');
      expect(res.text).toContain('rapidaid_mongodb_pool_events_total');
      expect(res.text).toContain('rapidaid_reconciliation_sweeps_total');
      expect(res.text).toContain('rapidaid_reconciliation_sweep_duration_seconds');
      expect(res.text).toContain('rapidaid_scheduler_lock_operations_total');
      expect(res.text).toContain('rapidaid_fleet_recovery_outcomes_total');
      expect(res.text).toContain('rapidaid_fleet_cas_no_op_total');
    });

    it('does not leak internal information, queries, or credentials in metrics output', async () => {
      const adminToken = await loginAs(DEFAULT_APP, 'admin');
      const res = await request(DEFAULT_APP)
        .get('/api/system/metrics')
        .set(bearer(adminToken));

      expect(res.status).toBe(200);
      expect(res.text).not.toContain('password');
      expect(res.text).not.toContain('mongodb://');
      expect(res.text).not.toContain('JWT_');
      expect(res.text).not.toContain(VALID_SCRAPER_TOKEN);
    });
  });

  describe('Optional Scraper Endpoint: GET /metrics', () => {
    it('is disabled by default and returns 404', async () => {
      const res = await request(DEFAULT_APP).get('/metrics');
      expect(res.status).toBe(404);
    });

    it('when enabled, rejects request with missing Authorization header (401)', async () => {
      const res = await request(ENABLED_SCRAPER_APP).get('/metrics');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="metrics"');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
      expect(res.text).not.toContain('rapidaid_');
    });

    it('when enabled, rejects request with non-bearer Authorization scheme (401)', async () => {
      const res = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', 'Basic dXNlcjpwYXNz');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="metrics"');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('when enabled, rejects request with invalid bearer token (401)', async () => {
      const res = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', 'Bearer invalid-token-1234567890');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer realm="metrics"');
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    });

    it('when enabled, rejects request with partially-matching or wrong-length bearer token (401)', async () => {
      // Valid prefix but truncated
      const resTruncated = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN.slice(0, 16)}`);
      expect(resTruncated.status).toBe(401);

      // Valid token with an extra character
      const resExtended = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN}extra`);
      expect(resExtended.status).toBe(401);
    });

    it('when enabled, accepts request with valid configured bearer token (200)', async () => {
      const res = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['content-type']).toContain('version=0.0.4');

      // Defensive headers applied
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');

      // Contains metrics from the central registry
      expect(res.text).toContain('rapidaid_mongodb_connection_state');
      expect(res.text).toContain('rapidaid_mongodb_pool_connections');
      expect(res.text).toContain('rapidaid_reconciliation_sweeps_total');
    });

    it('fails closed when enabled but token configuration is missing or weak', async () => {
      // App with enabled scraper but undefined token
      const noTokenApp = createApp({
        metricsScrapeEnabled: true,
        metricsScrapeToken: undefined,
      });
      const resNoToken = await request(noTokenApp)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN}`);
      expect(resNoToken.status).toBe(401);
      expect(resNoToken.text).not.toContain('rapidaid_');

      // App with enabled scraper but weak placeholder token
      const weakTokenApp = createApp({
        metricsScrapeEnabled: true,
        metricsScrapeToken: 'changeme12345678',
      });
      const resWeakToken = await request(weakTokenApp)
        .get('/metrics')
        .set('Authorization', 'Bearer changeme12345678');
      expect(resWeakToken.status).toBe(401);
      expect(resWeakToken.text).not.toContain('rapidaid_');

      // App with enabled scraper but token shorter than 16 chars
      const shortTokenApp = createApp({
        metricsScrapeEnabled: true,
        metricsScrapeToken: 'short-token-123',
      });
      const resShortToken = await request(shortTokenApp)
        .get('/metrics')
        .set('Authorization', 'Bearer short-token-123');
      expect(resShortToken.status).toBe(401);
      expect(resShortToken.text).not.toContain('rapidaid_');
    });

    it('authentication does not leak tokens or headers in responses', async () => {
      const hostileToken = '<script>alert("token")</script>';
      const res = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${hostileToken}`);

      expect(res.status).toBe(401);
      expect(res.text).not.toContain(hostileToken);
      expect(res.text).not.toContain('alert');
      expect(res.body.error.message).toBe('Authentication required');
    });
  });

  describe('Registry Reuse & Isolation', () => {
    it('both endpoints expose the EXACT SAME centralized prom-client registry', async () => {
      // 1. Reset and mutate a metric value in the central registry
      resetMetricsRegistry();
      expect(metricsRegistry.contentType).toContain('text/plain');
      setMongoConnectionState(1);

      // 2. Query admin endpoint
      const adminToken = await loginAs(DEFAULT_APP, 'admin');
      const adminRes = await request(DEFAULT_APP)
        .get('/api/system/metrics')
        .set(bearer(adminToken));
      expect(adminRes.status).toBe(200);
      expect(adminRes.text).toContain('rapidaid_mongodb_connection_state 1');

      // 3. Query scraper endpoint
      const scraperRes = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN}`);
      expect(scraperRes.status).toBe(200);
      expect(scraperRes.text).toContain('rapidaid_mongodb_connection_state 1');

      // 4. Update the metric value again
      setMongoConnectionState(2);

      const adminRes2 = await request(DEFAULT_APP)
        .get('/api/system/metrics')
        .set(bearer(adminToken));
      expect(adminRes2.text).toContain('rapidaid_mongodb_connection_state 2');

      const scraperRes2 = await request(ENABLED_SCRAPER_APP)
        .get('/metrics')
        .set('Authorization', `Bearer ${VALID_SCRAPER_TOKEN}`);
      expect(scraperRes2.text).toContain('rapidaid_mongodb_connection_state 2');
    });

    it('health probes (/healthz and /readyz) remain operational and separate from metrics', async () => {
      const liveness = await request(DEFAULT_APP).get('/healthz');
      expect(liveness.status).toBe(200);
      expect(liveness.body.status).toBe('ok');

      const readiness = await request(DEFAULT_APP).get('/readyz');
      expect(readiness.status).toBe(200);
      expect(readiness.body.status).toBe('ready');
    });
  });
});
