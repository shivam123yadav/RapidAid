import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import {
  connectDB,
  disconnectDB,
  pingDB,
  clearPingCache,
} from '../src/db/connection.js';
import {
  isAppShuttingDown,
  setAppShuttingDown,
  resetAppShuttingDown,
} from '../src/config/lifecycle.js';
import { resetDatabaseMetrics } from '../src/metrics/index.js';

describe('Phase 4.3.2: Readiness & Database Health Hardening', () => {
  const app = createApp();

  beforeEach(() => {
    resetAppShuttingDown();
    clearPingCache();
    resetDatabaseMetrics();
  });

  afterEach(() => {
    resetAppShuttingDown();
    clearPingCache();
  });

  // ===========================================================================
  // SECTION 1: Mocked Unit & Deterministic Isolation Tests
  // (No live external database mutations required)
  // ===========================================================================
  describe('Mocked Unit & Isolation Tests', () => {
    it('readiness returns 503 shutting_down immediately when application shutdown has started', async () => {
      // Simulate active application shutdown
      setAppShuttingDown(true);
      expect(isAppShuttingDown()).toBe(true);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.reason).toBe('shutting_down');
      expect(res.body.timestamp).toBeDefined();

      // Orchestrator alias /api/system/readyz behaves identically
      const aliasRes = await request(app).get('/api/system/readyz');
      expect(aliasRes.status).toBe(503);
      expect(aliasRes.body.reason).toBe('shutting_down');
    });

    it('shutdown causes readiness 503 even if Mongoose reports connected', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number };
      const originalReadyState = conn._readyState;
      conn._readyState = 1;

      try {
        setAppShuttingDown(true);

        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.reason).toBe('shutting_down');
      } finally {
        conn._readyState = originalReadyState;
      }
    });

    it('readiness returns 503 database_unavailable when Mongoose is disconnected (readyState !== 1)', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number };
      const originalReadyState = conn._readyState;
      conn._readyState = 0;

      try {
        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.reason).toBe('database_unavailable');
      } finally {
        conn._readyState = originalReadyState;
      }
    });

    it('readiness returns 503 database_unavailable when database ping fails', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      conn.db = {
        admin: () => ({
          command: async () => {
            throw new Error('Command failed');
          },
        }),
      };

      try {
        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.reason).toBe('database_unavailable');
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });

    it('readiness returns 503 without leaking credentials or stack traces when ping throws or rejects', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      // Mock db.admin to reject with sensitive credentials in error message
      conn.db = {
        admin: () => ({
          command: async () => {
            throw new Error(
              'MongoNetworkTimeoutError: connection to mongodb://admin:SuperSecretPass123!@127.0.0.1:27017 timed out at Object.query (/internal/app.ts:99)',
            );
          },
        }),
      };

      try {
        const res = await request(app).get('/readyz');
        expect(res.status).toBe(503);
        expect(res.body.status).toBe('not_ready');
        expect(res.body.reason).toBe('database_unavailable');

        // Confirm response body contains no stack trace, credentials, or URI
        const rawJson = JSON.stringify(res.body);
        expect(rawJson).not.toContain('SuperSecretPass123!');
        expect(rawJson).not.toContain('mongodb://');
        expect(rawJson).not.toContain('MongoNetworkTimeoutError');
        expect(rawJson).not.toContain('/internal/app.ts');
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });

    it('liveness probe (/healthz) remains HTTP 200 during database outage', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number };
      const originalReadyState = conn._readyState;
      conn._readyState = 0;

      try {
        // Liveness must remain healthy: database outage does NOT mean process is dead
        const livenessRes = await request(app).get('/healthz');
        expect(livenessRes.status).toBe(200);
        expect(livenessRes.body.status).toBe('ok');
        expect(livenessRes.body.timestamp).toBeDefined();

        // Meanwhile readiness correctly reports not ready
        const readinessRes = await request(app).get('/readyz');
        expect(readinessRes.status).toBe(503);
      } finally {
        conn._readyState = originalReadyState;
      }
    });

    it('pingDB coalesces concurrent in-flight requests into a single command invocation', async () => {
      let commandCallCount = 0;
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      conn.db = {
        admin: () => ({
          command: async () => {
            commandCallCount++;
            // Simulate brief asynchronous latency
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { ok: 1 };
          },
        }),
      };

      try {
        // Launch 5 concurrent calls simultaneously
        const promises = [
          pingDB({ bypassCache: true }),
          pingDB({ bypassCache: true }),
          pingDB({ bypassCache: true }),
          pingDB({ bypassCache: true }),
          pingDB({ bypassCache: true }),
        ];

        const results = await Promise.all(promises);

        // All 5 calls succeeded
        for (const res of results) {
          expect(res.ok).toBe(true);
        }

        // Single-flight coalescing must ensure admin().command was called exactly ONCE
        expect(commandCallCount).toBe(1);
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });

    it('pingDB caches success for bounded TTL and refreshes after TTL expiry', async () => {
      let commandCallCount = 0;
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      conn.db = {
        admin: () => ({
          command: async () => {
            commandCallCount++;
            return { ok: 1 };
          },
        }),
      };

      try {
        // First call with explicit 100ms TTL: runs command
        const first = await pingDB({ ttlMs: 100 });
        expect(first.ok).toBe(true);
        expect(first.fromCache).toBeUndefined();
        expect(commandCallCount).toBe(1);

        // Immediate second call: served from cache without invoking command
        const second = await pingDB({ ttlMs: 100 });
        expect(second.ok).toBe(true);
        expect(second.fromCache).toBe(true);
        expect(commandCallCount).toBe(1);

        // Wait for TTL to expire
        await new Promise((resolve) => setTimeout(resolve, 120));

        // Third call: TTL expired, invokes command again
        const third = await pingDB({ ttlMs: 100 });
        expect(third.ok).toBe(true);
        expect(commandCallCount).toBe(2);
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });

    it('shutdown immediately invalidates cached healthy ping without waiting for TTL', async () => {
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      conn.db = {
        admin: () => ({
          command: async () => ({ ok: 1 }),
        }),
      };

      try {
        // Establish cached healthy ping with 2000ms TTL
        const healthy = await pingDB({ ttlMs: 2000 });
        expect(healthy.ok).toBe(true);

        // Initiate shutdown
        setAppShuttingDown(true);

        // Next ping must immediately report false and bypass cache
        const postShutdown = await pingDB({ ttlMs: 2000 });
        expect(postShutdown.ok).toBe(false);
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });

    it('failed ping clears cache and is never cached as healthy', async () => {
      let shouldFail = false;
      const conn = mongoose.connection as unknown as { _readyState: number; db: unknown };
      const originalReadyState = conn._readyState;
      const originalDb = conn.db;

      conn._readyState = 1;
      conn.db = {
        admin: () => ({
          command: async () => {
            if (shouldFail) {
              throw new Error('Database ping timeout');
            }
            return { ok: 1 };
          },
        }),
      };

      try {
        // 1. Initial healthy ping
        const first = await pingDB({ ttlMs: 500 });
        expect(first.ok).toBe(true);

        // 2. Database fails
        shouldFail = true;
        const failure = await pingDB({ bypassCache: true, ttlMs: 500 });
        expect(failure.ok).toBe(false);

        // 3. Subsequent check within TTL must NOT return cached healthy state
        const subsequent = await pingDB({ ttlMs: 500 });
        expect(subsequent.ok).toBe(false);

        // 4. Database recovers: immediate recovery to healthy
        shouldFail = false;
        const recovered = await pingDB({ ttlMs: 500 });
        expect(recovered.ok).toBe(true);
      } finally {
        conn._readyState = originalReadyState;
        conn.db = originalDb;
      }
    });
  });

  // ===========================================================================
  // SECTION 2: Real Database Integration Tests
  // (Requires real MongoDB instance on process.env.MONGODB_URI)
  // ===========================================================================
  describe('Real Database Integration Tests', () => {
    const TEST_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rapidaid_test';

    beforeEach(async () => {
      if (mongoose.connection.readyState === 0) {
        await connectDB(TEST_URI);
      }
      resetAppShuttingDown();
      clearPingCache();
      resetDatabaseMetrics();
    });

    afterEach(async () => {
      resetAppShuttingDown();
      clearPingCache();
    });

    it('connected database and successful ping returns HTTP 200 ready', async () => {
      expect(mongoose.connection.readyState).toBe(1);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
      expect(res.body.timestamp).toBeDefined();
      expect(res.body.capabilities).toBeDefined();
      expect(res.body.capabilities.emergencyDeduplication).toBeDefined();
    });

    it('disconnection causes readiness to immediately return HTTP 503', async () => {
      expect(mongoose.connection.readyState).toBe(1);

      // Disconnect real database
      await disconnectDB();
      expect(mongoose.connection.readyState).toBe(0);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.reason).toBe('database_unavailable');
    });

    it('reconnecting database restores readiness to HTTP 200', async () => {
      // Disconnect
      await disconnectDB();
      expect((await request(app).get('/readyz')).status).toBe(503);

      // Reconnect
      await connectDB(TEST_URI);
      expect(mongoose.connection.readyState).toBe(1);

      // Readiness restored
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ready');
    });

    it('liveness remains HTTP 200 during real database disconnection', async () => {
      await disconnectDB();
      expect(mongoose.connection.readyState).toBe(0);

      // Liveness probe (/healthz) remains 200 ok
      const liveness = await request(app).get('/healthz');
      expect(liveness.status).toBe(200);
      expect(liveness.body.status).toBe('ok');

      // Readiness probe (/readyz) is 503 not_ready
      const readiness = await request(app).get('/readyz');
      expect(readiness.status).toBe(503);

      // Restore connection
      await connectDB(TEST_URI);
    });

    it('application shutdown causes readiness 503 while database is still connected', async () => {
      expect(mongoose.connection.readyState).toBe(1);

      setAppShuttingDown(true);

      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.status).toBe('not_ready');
      expect(res.body.reason).toBe('shutting_down');

      // But live database connection itself was untouched by readiness check
      expect(mongoose.connection.readyState).toBe(1);
    });
  });
});
