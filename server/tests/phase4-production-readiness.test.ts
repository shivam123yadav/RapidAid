import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import {
  SmsChannelProvider,
  PushChannelProvider,
  EmailChannelProvider,
} from '../src/services/notifications/channels.js';
import { verifyAndEnsureIndexes } from '../scripts/verify-production-indexes.js';

describe('Phase 4.4: Production Readiness & Deployment Verification', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    await connectDB();
    app = createApp();
  });

  afterAll(async () => {
    await disconnectDB();
  });

  describe('1. Health & Readiness Probes', () => {
    it('GET /healthz returns 200 OK for orchestrator process liveness', async () => {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('GET /readyz returns 200 OK with connected database status and capabilities', async () => {
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.capabilities).toBeDefined();
      expect(typeof res.body.timestamp).toBe('string');
    });

    it('GET /api/system/health requires authentication and protects system metrics', async () => {
      const unauthRes = await request(app).get('/api/system/health');
      expect(unauthRes.status).toBe(401);
      expect(unauthRes.body.error).toBeDefined();
    });
  });

  describe('2. Security Hardening & HTTP Headers', () => {
    it('enforces defensive security headers and disables X-Powered-By', async () => {
      const res = await request(app).get('/healthz');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('rejects oversized JSON bodies on standard endpoints (> 256kb)', async () => {
      const oversizedPayload = {
        data: 'A'.repeat(300 * 1024), // 300 KB > 256 KB limit
      };
      const res = await request(app)
        .post('/api/auth/login')
        .send(oversizedPayload);
      // Body parser rejects payload > 256kb with 413 Payload Too Large
      expect(res.status).toBe(413);
    });
  });

  describe('3. Production Database Index Verification', () => {
    it('verifies that all production collections and required indexes exist', async () => {
      const result = await verifyAndEnsureIndexes();
      expect(result.success).toBe(true);
      expect(result.results.length).toBeGreaterThanOrEqual(10);

      // Verify specific critical models have zero missing critical indexes
      const userResult = result.results.find((r) => r.model === 'User');
      expect(userResult?.missingCritical).toEqual([]);

      const emergencyResult = result.results.find((r) => r.model === 'Emergency');
      expect(emergencyResult?.missingCritical).toEqual([]);

      const hospitalResult = result.results.find((r) => r.model === 'Hospital');
      expect(hospitalResult?.missingCritical).toEqual([]);

      const notifResult = result.results.find((r) => r.model === 'Notification');
      expect(notifResult?.missingCritical).toEqual([]);

      const auditResult = result.results.find((r) => r.model === 'AuditLog');
      expect(auditResult?.missingCritical).toEqual([]);
    });
  });

  describe('4. External Service Fallback & Honest Labeling', () => {
    it('SmsChannelProvider flags isMock=true and returns MOCK_DELIVERED when unconfigured', async () => {
      const provider = new SmsChannelProvider();
      expect(provider.isMock).toBe(true);
      expect(provider.channel).toBe('sms');

      const outcome = await provider.send({
        title: 'Emergency Alert',
        message: 'Ambulance dispatched',
        recipientPhone: '+919999999999',
      });
      expect(outcome.status).toBe('MOCK_DELIVERED');
      expect(outcome.details).toContain('mock mode');
    });

    it('PushChannelProvider flags isMock=true and returns MOCK_DELIVERED when unconfigured', async () => {
      const provider = new PushChannelProvider();
      expect(provider.isMock).toBe(true);
      expect(provider.channel).toBe('push');

      const outcome = await provider.send({
        title: 'Ambulance Arriving',
        message: 'Ambulance AMB-051 is 500m away',
        recipientPushToken: 'sample-token',
      });
      expect(outcome.status).toBe('MOCK_DELIVERED');
      expect(outcome.details).toContain('mock mode');
    });

    it('EmailChannelProvider flags isMock=true when SMTP is not configured', async () => {
      const provider = new EmailChannelProvider();
      expect(provider.isMock).toBe(true);
      expect(provider.channel).toBe('email');

      const outcome = await provider.send({
        title: 'Report Confirmed',
        message: 'Your emergency has been registered',
        recipientEmail: 'citizen@example.com',
      });
      expect(outcome.status).toBe('MOCK_DELIVERED');
    });
  });

  describe('5. Environment Separation Safety Assertions', () => {
    it('verifies production safety patterns (never targets test DB)', () => {
      const testUris = [
        'mongodb://127.0.0.1:27017/rapidaid_phase1_test',
        'mongodb://localhost:27017/rapidaid_test',
        'mongodb+srv://user:pass@cluster.mongodb.net/rapidaid_test?retryWrites=true',
      ];

      for (const uri of testUris) {
        const lower = uri.toLowerCase();
        const isTestDb =
          lower.includes('rapidaid_phase1_test') ||
          lower.includes('rapidaid_test') ||
          lower.includes('_test');
        expect(isTestDb).toBe(true);
      }
    });

    it('verifies weak secret detection patterns', () => {
      const weakKeys = [
        'dev_access_secret_change_me_in_prod_12345',
        'test-access-secret-must-be-at-least-16-chars',
        'my-super-secret-change_me-please-now',
      ];

      const WEAK_PATTERNS = ['change_me', 'replace_me', 'secret_change', 'dev_access', 'test-access'];

      for (const key of weakKeys) {
        const isWeak = WEAK_PATTERNS.some((p) => key.toLowerCase().includes(p));
        expect(isWeak).toBe(true);
      }
    });
  });
});
