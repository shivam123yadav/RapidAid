import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'node:events';
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  pingDB,
  clearPingCache,
  connectDB,
  disconnectDB,
  attachClientPoolTelemetry,
  detachClientPoolTelemetry,
  isClientPoolTelemetryRegistered,
  resetPoolTracking,
} from '../src/db/connection.js';
import {
  resetDatabaseMetrics,
  getMongoOperationObservationCount,
  getMongoPoolConnectionCount,
  getMongoPoolCheckoutFailureCount,
  getMongoPoolEventCount,
  recordMongoOperationDuration,
  mongoOperationDurationHistogram,
} from '../src/metrics/index.js';
import { resetAppShuttingDown } from '../src/config/lifecycle.js';


describe('Phase 4.3.3: Database Operation Latency & Pool Telemetry (Mocked Unit Tests)', () => {
  beforeEach(() => {
    resetAppShuttingDown();
    clearPingCache();
    resetDatabaseMetrics();
    resetPoolTracking();
  });

  afterEach(() => {
    resetAppShuttingDown();
    clearPingCache();
    resetDatabaseMetrics();
    resetPoolTracking();
    vi.restoreAllMocks();
  });

  describe('1. Database Operation Latency Histogram', () => {
    it('records valid operation duration observations in Prometheus histogram', async () => {
      recordMongoOperationDuration('ping', 'success', 0.015);
      recordMongoOperationDuration('ping', 'success', 0.025);
      recordMongoOperationDuration('ping', 'failure', 0.500);

      const successCount = await getMongoOperationObservationCount('ping', 'success');
      const failureCount = await getMongoOperationObservationCount('ping', 'failure');

      expect(successCount).toBe(2);
      expect(failureCount).toBe(1);
    });

    it('rejects unapproved operation labels and statuses to prevent cardinality explosion', async () => {
      // @ts-expect-error testing runtime rejection of unapproved operation
      recordMongoOperationDuration('custom_query', 'success', 0.010);
      // @ts-expect-error testing runtime rejection of unapproved status
      recordMongoOperationDuration('ping', 'timeout', 0.010);

      const invalidOpCount = await getMongoOperationObservationCount(
        // @ts-expect-error testing retrieval
        'custom_query',
        'success',
      );
      expect(invalidOpCount).toBe(0);
    });

    it('clamps negative or non-finite durations to 0 without throwing', async () => {
      recordMongoOperationDuration('ping', 'success', -5);
      recordMongoOperationDuration('ping', 'success', NaN);

      const count = await getMongoOperationObservationCount('ping', 'success');
      expect(count).toBe(2);
    });

    it('pingDB() records latency histogram observation on successful network ping', async () => {
      const mockAdminCommand = vi.fn().mockResolvedValue({ ok: 1 });
      const conn = mongoose.connection as unknown as {
        _readyState: number;
        db: { admin: () => { command: (cmd: unknown) => Promise<unknown> } };
      };
      const origReadyState = conn._readyState;
      const origDb = conn.db;

      try {
        conn._readyState = 1;
        conn.db = { admin: () => ({ command: mockAdminCommand }) };

        const result = await pingDB({ bypassCache: true });
        expect(result.ok).toBe(true);

        const count = await getMongoOperationObservationCount('ping', 'success');
        expect(count).toBe(1);
      } finally {
        conn._readyState = origReadyState;
        conn.db = origDb;
      }
    });

    it('pingDB() records latency histogram observation on failed network ping', async () => {
      const mockAdminCommand = vi.fn().mockRejectedValue(new Error('Network socket closed'));
      const conn = mongoose.connection as unknown as {
        _readyState: number;
        db: { admin: () => { command: (cmd: unknown) => Promise<unknown> } };
      };
      const origReadyState = conn._readyState;
      const origDb = conn.db;

      try {
        conn._readyState = 1;
        conn.db = { admin: () => ({ command: mockAdminCommand }) };

        const result = await pingDB({ bypassCache: true });
        expect(result.ok).toBe(false);

        const count = await getMongoOperationObservationCount('ping', 'failure');
        expect(count).toBe(1);
      } finally {
        conn._readyState = origReadyState;
        conn.db = origDb;
      }
    });

    it('pingDB() cached response does not record a network latency observation', async () => {
      const mockAdminCommand = vi.fn().mockResolvedValue({ ok: 1 });
      const conn = mongoose.connection as unknown as {
        _readyState: number;
        db: { admin: () => { command: (cmd: unknown) => Promise<unknown> } };
      };
      const origReadyState = conn._readyState;
      const origDb = conn.db;

      try {
        conn._readyState = 1;
        conn.db = { admin: () => ({ command: mockAdminCommand }) };

        // First call populates cache
        const first = await pingDB({ ttlMs: 10_000 });
        expect(first.ok).toBe(true);
        expect(first.fromCache).toBeFalsy();

        // Second call hits cache
        const second = await pingDB({ ttlMs: 10_000 });
        expect(second.ok).toBe(true);
        expect(second.fromCache).toBe(true);

        // Only the first (network) call was observed
        const count = await getMongoOperationObservationCount('ping', 'success');
        expect(count).toBe(1);
      } finally {
        conn._readyState = origReadyState;
        conn.db = origDb;
      }
    });

    it('metric recording failure does not crash or corrupt pingDB() execution', async () => {
      vi.spyOn(mongoOperationDurationHistogram, 'observe').mockImplementationOnce(() => {
        throw new Error('Prometheus internal registry error');
      });

      const mockAdminCommand = vi.fn().mockResolvedValue({ ok: 1 });
      const conn = mongoose.connection as unknown as {
        _readyState: number;
        db: { admin: () => { command: (cmd: unknown) => Promise<unknown> } };
      };
      const origReadyState = conn._readyState;
      const origDb = conn.db;

      try {
        conn._readyState = 1;
        conn.db = { admin: () => ({ command: mockAdminCommand }) };

        // pingDB should succeed despite histogram observation error
        const result = await pingDB({ bypassCache: true });
        expect(result.ok).toBe(true);
      } finally {
        conn._readyState = origReadyState;
        conn.db = origDb;
      }
    });
  });

  describe('2. Connection Pool Telemetry Events', () => {
    it('tracks total, checked_out, and idle connections dynamically through driver events', async () => {
      const mockClient = new EventEmitter();
      attachClientPoolTelemetry(mockClient);

      expect(await getMongoPoolConnectionCount('total')).toBe(0);
      expect(await getMongoPoolConnectionCount('checked_out')).toBe(0);
      expect(await getMongoPoolConnectionCount('idle')).toBe(0);

      // 1. New connection created
      mockClient.emit('connectionCreated');
      expect(await getMongoPoolConnectionCount('total')).toBe(1);
      expect(await getMongoPoolConnectionCount('idle')).toBe(1);

      // 2. Second connection created
      mockClient.emit('connectionCreated');
      expect(await getMongoPoolConnectionCount('total')).toBe(2);
      expect(await getMongoPoolConnectionCount('idle')).toBe(2);

      // 3. Checkout connection
      mockClient.emit('connectionCheckedOut');
      expect(await getMongoPoolConnectionCount('checked_out')).toBe(1);
      expect(await getMongoPoolConnectionCount('idle')).toBe(1);

      // 4. Return connection (checkin)
      mockClient.emit('connectionCheckedIn');
      expect(await getMongoPoolConnectionCount('checked_out')).toBe(0);
      expect(await getMongoPoolConnectionCount('idle')).toBe(2);

      // 5. Close one connection
      mockClient.emit('connectionClosed');
      expect(await getMongoPoolConnectionCount('total')).toBe(1);
      expect(await getMongoPoolConnectionCount('idle')).toBe(1);

      // 6. Pool closed (resets all gauges to 0)
      mockClient.emit('connectionPoolClosed');
      expect(await getMongoPoolConnectionCount('total')).toBe(0);
      expect(await getMongoPoolConnectionCount('checked_out')).toBe(0);
      expect(await getMongoPoolConnectionCount('idle')).toBe(0);
    });

    it('records checkout failures with mapped bounded reasons', async () => {
      const mockClient = new EventEmitter();
      attachClientPoolTelemetry(mockClient);

      mockClient.emit('connectionCheckOutFailed', { reason: 'timeout' });
      mockClient.emit('connectionCheckOutFailed', { reason: 'connectionClosed' });
      mockClient.emit('connectionCheckOutFailed', { reason: 'cancelled' });
      mockClient.emit('connectionCheckOutFailed', { reason: 'unrecognized_driver_reason' });

      expect(await getMongoPoolCheckoutFailureCount('timeout')).toBe(1);
      expect(await getMongoPoolCheckoutFailureCount('connection_closed')).toBe(1);
      expect(await getMongoPoolCheckoutFailureCount('cancelled')).toBe(1);
      expect(await getMongoPoolCheckoutFailureCount('unknown')).toBe(1);
    });

    it('records pool lifecycle events', async () => {
      const mockClient = new EventEmitter();
      attachClientPoolTelemetry(mockClient);

      mockClient.emit('connectionPoolCreated');
      mockClient.emit('connectionPoolReady');
      mockClient.emit('connectionPoolCleared');
      mockClient.emit('connectionPoolClosed');

      expect(await getMongoPoolEventCount('pool_created')).toBe(1);
      expect(await getMongoPoolEventCount('pool_ready')).toBe(1);
      expect(await getMongoPoolEventCount('pool_cleared')).toBe(1);
      expect(await getMongoPoolEventCount('pool_closed')).toBe(1);
    });

    it('idempotently registers listeners on the same client instance without duplicating handlers', async () => {
      const mockClient = new EventEmitter();
      attachClientPoolTelemetry(mockClient);
      attachClientPoolTelemetry(mockClient); // duplicate call

      expect(isClientPoolTelemetryRegistered(mockClient)).toBe(true);

      mockClient.emit('connectionCreated');
      // Should increment by exactly 1, not 2
      expect(await getMongoPoolConnectionCount('total')).toBe(1);
    });

    it('safely detaches pool listeners upon teardown', async () => {
      const mockClient = new EventEmitter();
      attachClientPoolTelemetry(mockClient);
      expect(isClientPoolTelemetryRegistered(mockClient)).toBe(true);

      detachClientPoolTelemetry(mockClient);
      expect(isClientPoolTelemetryRegistered(mockClient)).toBe(false);

      mockClient.emit('connectionCreated');
      // No updates after detachment
      expect(await getMongoPoolConnectionCount('total')).toBe(0);
    });
  });
});

describe('Phase 4.3.3: Database Operation Latency & Pool Telemetry (Real MongoDB Integration Tests)', () => {
  beforeEach(async () => {
    resetAppShuttingDown();
    clearPingCache();
    resetDatabaseMetrics();
    resetPoolTracking();
  });

  afterEach(async () => {
    resetAppShuttingDown();
    clearPingCache();
    resetDatabaseMetrics();
    resetPoolTracking();
    if (mongoose.connection.readyState !== 0) {
      await disconnectDB();
    }
  });

  it('attaches pool listeners to real MongoClient and tracks live ping round-trip latency', async () => {
    await connectDB(env.MONGODB_URI);
    expect(mongoose.connection.readyState).toBe(1);

    const client = mongoose.connection.getClient();
    expect(client).toBeDefined();
    expect(isClientPoolTelemetryRegistered(client)).toBe(true);

    // Execute live round-trip ping command
    const pingRes = await pingDB({ bypassCache: true });
    expect(pingRes.ok).toBe(true);
    expect(pingRes.latencyMs).toBeGreaterThanOrEqual(0);

    // Verify observation recorded in Prometheus histogram
    const obsCount = await getMongoOperationObservationCount('ping', 'success');
    expect(obsCount).toBeGreaterThanOrEqual(1);

    // Disconnect and verify pool gauges reset to 0
    await disconnectDB();
    expect(await getMongoPoolConnectionCount('total')).toBe(0);
    expect(await getMongoPoolConnectionCount('checked_out')).toBe(0);
    expect(await getMongoPoolConnectionCount('idle')).toBe(0);
  });
});
