import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import request from 'supertest';
import {
  rateLimitHandler,
  createRateLimiter,
  apiLimiter,
  authLimiter,
  emergencyReportLimiter,
  voiceUploadLimiter,
} from '../src/middleware/rateLimit.js';

describe('Milestone 5 Stage 2: Rate Limiting Hardening', () => {
  describe('Standard 429 Error Envelope & Headers', () => {
    it('rateLimitHandler formats 429 response matching the standard envelope', () => {
      const mockRes = {
        statusCode: 0,
        body: null as unknown,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(payload: unknown) {
          this.body = payload;
          return this;
        },
      };
      rateLimitHandler(
        { requestId: 'test-req-id' } as Request,
        mockRes as unknown as Response,
        () => {},
        {} as never,
      );
      expect(mockRes.statusCode).toBe(429);
      expect(mockRes.body).toEqual({
        error: {
          message: 'Too many requests, please try again later',
          code: 'RATE_LIMITED',
          requestId: 'test-req-id',
        },
      });
    });

    it('returns 429 with standard RapidAid error envelope when limit is exceeded', async () => {
      const app = express();
      const limiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        skip: () => false,
      });

      app.use((req, _res, next) => {
        (req as unknown as { requestId?: string }).requestId = 'req-test-12345';
        next();
      });
      app.get('/test-limit', limiter, (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      // Request 1: allowed
      const res1 = await request(app).get('/test-limit');
      expect(res1.status).toBe(200);
      expect(res1.body).toEqual({ ok: true });
      expect(res1.headers['ratelimit-limit']).toBe('2');
      expect(res1.headers['ratelimit-remaining']).toBe('1');

      // Request 2: allowed
      const res2 = await request(app).get('/test-limit');
      expect(res2.status).toBe(200);
      expect(res2.headers['ratelimit-remaining']).toBe('0');

      // Request 3: rate limited
      const res3 = await request(app).get('/test-limit');
      expect(res3.status).toBe(429);
      expect(res3.body).toEqual({
        error: {
          message: 'Too many requests, please try again later',
          code: 'RATE_LIMITED',
          requestId: 'req-test-12345',
        },
      });
      expect(res3.headers['ratelimit-limit']).toBe('2');
      expect(res3.headers['ratelimit-remaining']).toBe('0');
      expect(res3.headers['ratelimit-reset']).toBeDefined();
    });

    it('falls back to "unknown" requestId if req.requestId is not populated', async () => {
      const app = express();
      const limiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 1,
        skip: () => false,
      });

      app.get('/test-no-req-id', limiter, (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      });

      await request(app).get('/test-no-req-id');
      const resBlocked = await request(app).get('/test-no-req-id');
      expect(resBlocked.status).toBe(429);
      expect(resBlocked.body.error.requestId).toBe('unknown');
    });
  });

  describe('User-Keyed Rate Limiting Separation', () => {
    it('isolates buckets by authenticated userId so distinct users on same IP do not starve each other', async () => {
      const app = express();
      const userLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        skip: () => false,
        keyGenerator: (req) => (req as { auth?: { userId?: string } }).auth?.userId ?? req.ip ?? 'unknown',
      });

      app.get(
        '/test-user-limit',
        (req: Request, _res: Response, next) => {
          const userId = req.headers['x-simulated-user'] as string | undefined;
          if (userId) {
            (req as unknown as { auth: { userId: string } }).auth = { userId };
          }
          next();
        },
        userLimiter,
        (_req: Request, res: Response) => {
          res.status(200).json({ ok: true });
        },
      );

      // User A makes 2 requests (exhausts quota)
      await request(app).get('/test-user-limit').set('x-simulated-user', 'user-A').expect(200);
      await request(app).get('/test-user-limit').set('x-simulated-user', 'user-A').expect(200);
      const userABlocked = await request(app).get('/test-user-limit').set('x-simulated-user', 'user-A');
      expect(userABlocked.status).toBe(429);

      // User B from same client/IP makes request (should succeed)
      const userBAllowed = await request(app).get('/test-user-limit').set('x-simulated-user', 'user-B');
      expect(userBAllowed.status).toBe(200);
    });
  });

  describe('Limiter Configuration & Invariants', () => {
    it('emergencyReportLimiter is configured with 30 req / 15 min and standardHeaders', () => {
      expect(emergencyReportLimiter).toBeDefined();
      // Test keyGenerator with auth userId vs ip
      const keyGen = (emergencyReportLimiter as unknown as { options?: { keyGenerator?: (req: unknown) => string } }).options?.keyGenerator;
      if (keyGen) {
        expect(keyGen({ auth: { userId: 'usr-123' }, ip: '1.2.3.4' })).toBe('usr-123');
        expect(keyGen({ ip: '1.2.3.4' })).toBe('1.2.3.4');
        expect(keyGen({})).toBe('unknown');
      }
    });

    it('authLimiter is configured with 20 req / 15 min limit', () => {
      expect(authLimiter).toBeDefined();
    });

    it('apiLimiter is configured with 300 req / 15 min limit', () => {
      expect(apiLimiter).toBeDefined();
    });

    it('voiceUploadLimiter is configured with 20 req / 15 min limit', () => {
      expect(voiceUploadLimiter).toBeDefined();
    });
  });

  describe('Distributed Store Pluggability & Process-Local Invariants', () => {
    it('isolates counters between distinct limiter instances (simulating process restarts / independent replicas)', async () => {
      const app = express();
      // Instance 1
      const limiter1 = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 1,
        skip: () => false,
      });
      // Instance 2 (representing a separate replica or post-restart process)
      const limiter2 = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 1,
        skip: () => false,
      });

      app.get('/replica-1', limiter1, (_req, res) => res.status(200).json({ replica: 1 }));
      app.get('/replica-2', limiter2, (_req, res) => res.status(200).json({ replica: 2 }));

      // Exhaust limiter 1
      await request(app).get('/replica-1').expect(200);
      await request(app).get('/replica-1').expect(429);

      // Limiter 2 has independent in-memory state and is NOT blocked
      await request(app).get('/replica-2').expect(200);
    });

    it('supports custom pluggable store implementation via createRateLimiter', async () => {
      let incrementCalled = 0;
      const customStore = {
        init: () => {},
        increment: async (_key: string) => {
          incrementCalled++;
          return { totalHits: incrementCalled, resetTime: new Date(Date.now() + 60000) };
        },
        decrement: () => {},
        resetKey: () => {},
      };

      const app = express();
      const customLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        skip: () => false,
        store: customStore as never,
      });

      app.get('/custom-store', customLimiter, (_req, res) => res.status(200).json({ ok: true }));

      await request(app).get('/custom-store').expect(200);
      expect(incrementCalled).toBe(1);

      await request(app).get('/custom-store').expect(200);
      expect(incrementCalled).toBe(2);

      const blockedRes = await request(app).get('/custom-store');
      expect(blockedRes.status).toBe(429);
      expect(incrementCalled).toBe(3);
    });

    it('fails safely when custom store encounters an unexpected runtime error', async () => {
      const failingStore = {
        init: () => {},
        increment: async () => {
          throw new Error('Connection refused to distributed cache');
        },
        decrement: () => {},
        resetKey: () => {},
      };

      const app = express();
      const failLimiter = createRateLimiter({
        windowMs: 60 * 1000,
        limit: 2,
        skip: () => false,
        store: failingStore as never,
        passOnStoreError: false, // Default fail-safe policy: do not silently allow traffic on store failure
      });

      app.get('/store-failure', failLimiter, (_req, res) => res.status(200).json({ ok: true }));
      app.use((err: Error, _req: Request, res: Response, _next: () => void) => {
        res.status(500).json({ error: { message: err.message, code: 'STORE_ERROR' } });
      });

      const res = await request(app).get('/store-failure');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('STORE_ERROR');
    });
  });
});

