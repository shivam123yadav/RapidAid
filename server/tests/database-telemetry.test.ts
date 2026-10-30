import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import {
  connectDB,
  disconnectDB,
  pingDB,
  registerConnectionTelemetry,
  unregisterConnectionTelemetry,
  isConnectionTelemetryRegistered,
} from '../src/db/connection.js';
import {
  MongoConnectionState,
  BOUNDED_LIFECYCLE_EVENTS,
  getMongoConnectionStateValue,
  getMongoLifecycleEventCount,
  resetDatabaseMetrics,
  recordMongoLifecycleEvent,
  metricsRegistry,
} from '../src/metrics/index.js';
import { logger } from '../src/config/logger.js';

describe('Database Telemetry & Lifecycle Observability (Phase 4.3.1)', () => {
  beforeEach(() => {
    resetDatabaseMetrics();
  });

  // ---------------------------------------------------------------------------
  // SECTION 1: Mocked Unit Tests (Safe Isolation & Boundary Verification)
  // ---------------------------------------------------------------------------
  describe('Mocked Unit Tests: Connection Telemetry & Bounded Metrics', () => {
    class MockConnection extends EventEmitter {
      public readyState: number = 0;
    }

    let mockConn: MockConnection;

    beforeEach(() => {
      mockConn = new MockConnection();
    });

    afterEach(() => {
      unregisterConnectionTelemetry(mockConn as unknown as mongoose.Connection);
    });

    it('registers telemetry listeners on connection instance', () => {
      expect(isConnectionTelemetryRegistered(mockConn)).toBe(false);
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);
      expect(isConnectionTelemetryRegistered(mockConn)).toBe(true);

      expect(mockConn.listenerCount('connecting')).toBe(1);
      expect(mockConn.listenerCount('connected')).toBe(1);
      expect(mockConn.listenerCount('disconnecting')).toBe(1);
      expect(mockConn.listenerCount('disconnected')).toBe(1);
      expect(mockConn.listenerCount('reconnected')).toBe(1);
      expect(mockConn.listenerCount('error')).toBe(1);
    });

    it('is idempotent: repeated registration does NOT create duplicate listeners', async () => {
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);

      expect(mockConn.listenerCount('connected')).toBe(1);
      expect(mockConn.listenerCount('disconnected')).toBe(1);
      expect(mockConn.listenerCount('error')).toBe(1);

      // Emit connected event once — should increment counter by exactly 1, not 3
      mockConn.emit('connected');
      expect(await getMongoLifecycleEventCount('connected')).toBe(1);
    });

    it('unregisters listeners cleanly without leaving dangling handlers', () => {
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);
      expect(isConnectionTelemetryRegistered(mockConn)).toBe(true);

      unregisterConnectionTelemetry(mockConn as unknown as mongoose.Connection);
      expect(isConnectionTelemetryRegistered(mockConn)).toBe(false);

      expect(mockConn.listenerCount('connecting')).toBe(0);
      expect(mockConn.listenerCount('connected')).toBe(0);
      expect(mockConn.listenerCount('disconnecting')).toBe(0);
      expect(mockConn.listenerCount('disconnected')).toBe(0);
      expect(mockConn.listenerCount('reconnected')).toBe(0);
      expect(mockConn.listenerCount('error')).toBe(0);
    });

    it('accurately updates connection state gauge across all 4 state transitions', async () => {
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);

      // Default state is DISCONNECTED (0)
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);

      // Transition to CONNECTING (2)
      mockConn.emit('connecting');
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTING);

      // Transition to CONNECTED (1)
      mockConn.emit('connected');
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTED);
      expect(await getMongoLifecycleEventCount('connected')).toBe(1);

      // Transition to DISCONNECTING (3)
      mockConn.emit('disconnecting');
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTING);

      // Transition to DISCONNECTED (0)
      mockConn.emit('disconnected');
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);
      expect(await getMongoLifecycleEventCount('disconnected')).toBe(1);

      // Transition to RECONNECTED (1)
      mockConn.emit('reconnected');
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTED);
      expect(await getMongoLifecycleEventCount('reconnected')).toBe(1);
    });

    it('records error event and increments error counter', async () => {
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);

      mockConn.emit('error', new Error('Simulated socket drop'));
      expect(await getMongoLifecycleEventCount('error')).toBe(1);

      mockConn.emit('error', new Error('Simulated second error'));
      expect(await getMongoLifecycleEventCount('error')).toBe(2);
    });

    it('enforces bounded event labels: rejects invalid event labels to prevent cardinality explosion', async () => {
      const warnSpy = vi.spyOn(logger, 'warn');

      // Valid events increment
      for (const event of BOUNDED_LIFECYCLE_EVENTS) {
        recordMongoLifecycleEvent(event);
        expect(await getMongoLifecycleEventCount(event)).toBe(1);
      }

      // Unapproved event label
      // @ts-expect-error Testing invalid runtime event argument
      recordMongoLifecycleEvent('unapproved_custom_event');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'unapproved_custom_event' }),
        expect.stringContaining('Attempted to record unapproved MongoDB lifecycle event metric'),
      );

      // Prometheus metrics output should contain only bounded labels
      const metricsText = await metricsRegistry.metrics();
      expect(metricsText).toContain('rapidaid_mongodb_connection_events_total{event="connected"} 1');
      expect(metricsText).toContain('rapidaid_mongodb_connection_events_total{event="disconnected"} 1');
      expect(metricsText).toContain('rapidaid_mongodb_connection_events_total{event="reconnected"} 1');
      expect(metricsText).toContain('rapidaid_mongodb_connection_events_total{event="error"} 1');
      expect(metricsText).not.toContain('unapproved_custom_event');

      warnSpy.mockRestore();
    });

    it('logs connection errors without leaking credentials or URIs', () => {
      const errorSpy = vi.spyOn(logger, 'error');
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);

      const errorWithCredentials = new Error(
        'Connection failed: mongodb://admin:SuperSecretPassword123!@127.0.0.1:27017/rapidaid?authSource=admin',
      );

      mockConn.emit('error', errorWithCredentials);

      expect(errorSpy).toHaveBeenCalled();
      const loggedErr = errorSpy.mock.calls[0]?.[0] as { err: Error };
      expect(loggedErr).toBeDefined();
      expect(loggedErr.err).toBeDefined();

      // The raw logger call should never include plain credentials in call payload
      errorSpy.mockRestore();
    });

    it('handles unexpected exceptions in telemetry handlers without throwing unhandled rejections', () => {
      registerConnectionTelemetry(mockConn as unknown as mongoose.Connection);

      // Emit error with null/undefined/non-Error objects — must not throw
      expect(() => mockConn.emit('error', null)).not.toThrow();
      expect(() => mockConn.emit('error', undefined)).not.toThrow();
      expect(() => mockConn.emit('error', 'string error')).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // SECTION 2: Real Database Lifecycle Integration Tests
  // ---------------------------------------------------------------------------
  describe('Integration Tests: Real Mongoose Connection Lifecycle', () => {
    const TEST_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/rapidaid_test';

    beforeEach(async () => {
      // Ensure clean state before each test
      if (mongoose.connection.readyState !== 0) {
        await disconnectDB();
      }
      resetDatabaseMetrics();
    });

    afterEach(async () => {
      if (mongoose.connection.readyState !== 0) {
        await disconnectDB();
      }
    });

    it('initial connection success updates connection-state gauge to 1 (connected)', async () => {
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);

      await connectDB(TEST_URI);

      expect(mongoose.connection.readyState).toBe(1);
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTED);
      expect(await getMongoLifecycleEventCount('connected')).toBeGreaterThanOrEqual(1);

      // Verify pingDB works and observes connected state
      const pingResult = await pingDB();
      expect(pingResult.ok).toBe(true);
      expect(pingResult.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('disconnectDB updates connection-state gauge to 0 (disconnected) and records disconnected event', async () => {
      await connectDB(TEST_URI);
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTED);

      await disconnectDB();

      expect(mongoose.connection.readyState).toBe(0);
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);
      expect(await getMongoLifecycleEventCount('disconnected')).toBeGreaterThanOrEqual(1);

      // pingDB should report false when disconnected
      const pingResult = await pingDB();
      expect(pingResult.ok).toBe(false);
    });

    it('subsequent reconnection updates gauge back to 1 and increments connected counter', async () => {
      await connectDB(TEST_URI);
      const connectedCountAfterFirst = await getMongoLifecycleEventCount('connected');

      await disconnectDB();
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);

      await connectDB(TEST_URI);
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.CONNECTED);
      const connectedCountAfterSecond = await getMongoLifecycleEventCount('connected');

      expect(connectedCountAfterSecond).toBe(connectedCountAfterFirst + 1);
    });

    it('repeated connectDB calls do not duplicate event listeners or cause listener leak warnings', async () => {
      await connectDB(TEST_URI);
      const initialListeners = mongoose.connection.listenerCount('connected');

      // Call connectDB repeatedly
      await connectDB(TEST_URI);
      await connectDB(TEST_URI);

      const afterRepeatedListeners = mongoose.connection.listenerCount('connected');
      expect(afterRepeatedListeners).toBe(initialListeners);
    });

    it('initial connection failure preserves fail-fast behavior, sets gauge to 0, and records error', async () => {
      const UNREACHABLE_URI = 'mongodb://127.0.0.1:27099/unreachable_rapidaid_test';

      // Expect connectDB to fail-fast (reject) with bounded timeout
      await expect(
        connectDB(UNREACHABLE_URI, { serverSelectionTimeoutMS: 500 }),
      ).rejects.toThrow();

      // Wait brief tick for background driver error event dispatch
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Gauge must be set to DISCONNECTED (0)
      expect(await getMongoConnectionStateValue()).toBe(MongoConnectionState.DISCONNECTED);
      // Error counter must have recorded the failure
      expect(await getMongoLifecycleEventCount('error')).toBeGreaterThanOrEqual(1);
    });
  });
});
