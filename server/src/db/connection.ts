import mongoose from 'mongoose';
import { env, isTest } from '../config/env.js';
import { logger } from '../config/logger.js';
import { isAppShuttingDown } from '../config/lifecycle.js';
import {
  MongoConnectionState,
  recordMongoLifecycleEvent,
  setMongoConnectionState,
  recordMongoOperationDuration,
  setMongoPoolConnectionCounts,
  recordMongoPoolCheckoutFailure,
  recordMongoPoolEvent,
} from '../metrics/index.js';

mongoose.set('strictQuery', true);

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  fromCache?: boolean;
}

export interface PingOptions {
  bypassCache?: boolean;
  ttlMs?: number;
}

export const DEFAULT_PING_CACHE_TTL_MS = isTest ? 0 : 1000;

let cachedPingResult: PingResult | null = null;
let cachedPingTimestamp = 0;
let inFlightPing: Promise<PingResult> | null = null;

/** Clears the readiness ping cache and in-flight promise (test isolation & event invalidation). */
export function clearPingCache(): void {
  cachedPingResult = null;
  cachedPingTimestamp = 0;
  inFlightPing = null;
}

interface TelemetryListeners {
  connecting: () => void;
  connected: () => void;
  disconnecting: () => void;
  disconnected: () => void;
  reconnected: () => void;
  error: (err: unknown) => void;
}

interface PoolEventListeners {
  connectionCreated: () => void;
  connectionClosed: () => void;
  connectionCheckedOut: () => void;
  connectionCheckedIn: () => void;
  connectionCheckOutFailed: (event: { reason?: string }) => void;
  connectionPoolCreated: () => void;
  connectionPoolReady: () => void;
  connectionPoolCleared: () => void;
  connectionPoolClosed: () => void;
}

const attachedConnections = new WeakMap<object, TelemetryListeners>();
const attachedClients = new WeakMap<object, PoolEventListeners>();

let poolTotal = 0;
let poolCheckedOut = 0;

function updatePoolCounts(): void {
  const idle = Math.max(0, poolTotal - poolCheckedOut);
  setMongoPoolConnectionCounts({
    total: poolTotal,
    checkedOut: poolCheckedOut,
    idle,
  });
}

/** Resets connection pool tracking state (for test isolation). */
export function resetPoolTracking(): void {
  poolTotal = 0;
  poolCheckedOut = 0;
  updatePoolCounts();
}

/**
 * Attaches pool monitoring event listeners to an underlying MongoClient instance.
 * Idempotent via WeakMap guard.
 */
export function attachClientPoolTelemetry(client: any): void {
  if (!client || typeof client.on !== 'function' || attachedClients.has(client)) {
    return;
  }

  const poolListeners: PoolEventListeners = {
    connectionCreated: () => {
      try {
        poolTotal++;
        updatePoolCounts();
      } catch (err) {
        logger.warn({ err }, 'Error in connectionCreated pool telemetry');
      }
    },
    connectionClosed: () => {
      try {
        poolTotal = Math.max(0, poolTotal - 1);
        updatePoolCounts();
      } catch (err) {
        logger.warn({ err }, 'Error in connectionClosed pool telemetry');
      }
    },
    connectionCheckedOut: () => {
      try {
        poolCheckedOut++;
        updatePoolCounts();
      } catch (err) {
        logger.warn({ err }, 'Error in connectionCheckedOut pool telemetry');
      }
    },
    connectionCheckedIn: () => {
      try {
        poolCheckedOut = Math.max(0, poolCheckedOut - 1);
        updatePoolCounts();
      } catch (err) {
        logger.warn({ err }, 'Error in connectionCheckedIn pool telemetry');
      }
    },
    connectionCheckOutFailed: (event: { reason?: string }) => {
      try {
        let reason: 'timeout' | 'connection_closed' | 'cancelled' | 'unknown' = 'unknown';
        if (event?.reason === 'timeout') reason = 'timeout';
        else if (event?.reason === 'connectionClosed') reason = 'connection_closed';
        else if (event?.reason === 'cancelled') reason = 'cancelled';
        recordMongoPoolCheckoutFailure(reason);
      } catch (err) {
        logger.warn({ err }, 'Error in connectionCheckOutFailed pool telemetry');
      }
    },
    connectionPoolCreated: () => {
      try {
        recordMongoPoolEvent('pool_created');
      } catch (err) {
        logger.warn({ err }, 'Error in connectionPoolCreated pool telemetry');
      }
    },
    connectionPoolReady: () => {
      try {
        recordMongoPoolEvent('pool_ready');
      } catch (err) {
        logger.warn({ err }, 'Error in connectionPoolReady pool telemetry');
      }
    },
    connectionPoolCleared: () => {
      try {
        recordMongoPoolEvent('pool_cleared');
      } catch (err) {
        logger.warn({ err }, 'Error in connectionPoolCleared pool telemetry');
      }
    },
    connectionPoolClosed: () => {
      try {
        recordMongoPoolEvent('pool_closed');
        poolTotal = 0;
        poolCheckedOut = 0;
        updatePoolCounts();
      } catch (err) {
        logger.warn({ err }, 'Error in connectionPoolClosed pool telemetry');
      }
    },
  };

  client.on('connectionCreated', poolListeners.connectionCreated);
  client.on('connectionClosed', poolListeners.connectionClosed);
  client.on('connectionCheckedOut', poolListeners.connectionCheckedOut);
  client.on('connectionCheckedIn', poolListeners.connectionCheckedIn);
  client.on('connectionCheckOutFailed', poolListeners.connectionCheckOutFailed);
  client.on('connectionPoolCreated', poolListeners.connectionPoolCreated);
  client.on('connectionPoolReady', poolListeners.connectionPoolReady);
  client.on('connectionPoolCleared', poolListeners.connectionPoolCleared);
  client.on('connectionPoolClosed', poolListeners.connectionPoolClosed);

  attachedClients.set(client, poolListeners);
}

/**
 * Detaches pool monitoring event listeners from a MongoClient instance.
 */
export function detachClientPoolTelemetry(client: any): void {
  if (!client || typeof client.removeListener !== 'function') {
    return;
  }
  const listeners = attachedClients.get(client);
  if (!listeners) {
    return;
  }

  client.removeListener('connectionCreated', listeners.connectionCreated);
  client.removeListener('connectionClosed', listeners.connectionClosed);
  client.removeListener('connectionCheckedOut', listeners.connectionCheckedOut);
  client.removeListener('connectionCheckedIn', listeners.connectionCheckedIn);
  client.removeListener('connectionCheckOutFailed', listeners.connectionCheckOutFailed);
  client.removeListener('connectionPoolCreated', listeners.connectionPoolCreated);
  client.removeListener('connectionPoolReady', listeners.connectionPoolReady);
  client.removeListener('connectionPoolCleared', listeners.connectionPoolCleared);
  client.removeListener('connectionPoolClosed', listeners.connectionPoolClosed);

  attachedClients.delete(client);
}

/** Returns whether pool telemetry listeners are currently attached to a client. */
export function isClientPoolTelemetryRegistered(client: object): boolean {
  return attachedClients.has(client);
}

/**
 * Registers lifecycle telemetry listeners on a Mongoose connection instance.
 * Idempotent: repeated calls for the same connection instance are no-ops and
 * will not register duplicate event handlers.
 */
export function registerConnectionTelemetry(
  conn: {
    readyState?: number;
    getClient?: () => any;
    on: (event: string, listener: (...args: any[]) => void) => any;
    removeListener: (event: string, listener: (...args: any[]) => void) => any;
  } = mongoose.connection,
): void {
  if (attachedConnections.has(conn)) {
    return;
  }

  const listeners: TelemetryListeners = {
    connecting: () => {
      try {
        setMongoConnectionState(MongoConnectionState.CONNECTING);
      } catch (err) {
        logger.warn({ err }, 'Error in MongoDB connecting telemetry handler');
      }
    },
    connected: () => {
      try {
        setMongoConnectionState(MongoConnectionState.CONNECTED);
        recordMongoLifecycleEvent('connected');
        if (typeof conn.getClient === 'function') {
          attachClientPoolTelemetry(conn.getClient());
        }
        logger.info({ readyState: conn.readyState }, 'MongoDB connection established');
      } catch (err) {
        logger.warn({ err }, 'Error in MongoDB connected telemetry handler');
      }
    },
    disconnecting: () => {
      try {
        clearPingCache();
        setMongoConnectionState(MongoConnectionState.DISCONNECTING);
      } catch (err) {
        logger.warn({ err }, 'Error in MongoDB disconnecting telemetry handler');
      }
    },
    disconnected: () => {
      try {
        clearPingCache();
        poolTotal = 0;
        poolCheckedOut = 0;
        updatePoolCounts();
        setMongoConnectionState(MongoConnectionState.DISCONNECTED);
        recordMongoLifecycleEvent('disconnected');
        logger.warn({ readyState: conn.readyState }, 'MongoDB connection lost or disconnected');
      } catch (err) {
        logger.warn({ err }, 'Error in MongoDB disconnected telemetry handler');
      }
    },
    reconnected: () => {
      try {
        clearPingCache();
        setMongoConnectionState(MongoConnectionState.CONNECTED);
        recordMongoLifecycleEvent('reconnected');
        if (typeof conn.getClient === 'function') {
          attachClientPoolTelemetry(conn.getClient());
        }
        logger.info({ readyState: conn.readyState }, 'MongoDB connection re-established');
      } catch (err) {
        logger.warn({ err }, 'Error in MongoDB reconnected telemetry handler');
      }
    },
    error: (err: unknown) => {
      try {
        recordMongoLifecycleEvent('error');
        logger.error({ err }, 'MongoDB connection error');
      } catch (handlerErr) {
        logger.warn({ err: handlerErr }, 'Error in MongoDB error telemetry handler');
      }
    },
  };

  conn.on('connecting', listeners.connecting);
  conn.on('connected', listeners.connected);
  conn.on('disconnecting', listeners.disconnecting);
  conn.on('disconnected', listeners.disconnected);
  conn.on('reconnected', listeners.reconnected);
  conn.on('error', listeners.error);

  attachedConnections.set(conn, listeners);

  // If already connected and client is available, attach pool listeners immediately
  if (typeof conn.getClient === 'function') {
    const client = conn.getClient();
    if (client) {
      attachClientPoolTelemetry(client);
    }
  }
}

/**
 * Unregisters lifecycle telemetry listeners from a connection instance (useful for test isolation).
 */
export function unregisterConnectionTelemetry(
  conn: {
    getClient?: () => any;
    removeListener: (event: string, listener: (...args: any[]) => void) => any;
  } = mongoose.connection,
): void {
  const listeners = attachedConnections.get(conn);
  if (!listeners) {
    return;
  }

  conn.removeListener('connecting', listeners.connecting);
  conn.removeListener('connected', listeners.connected);
  conn.removeListener('disconnecting', listeners.disconnecting);
  conn.removeListener('disconnected', listeners.disconnected);
  conn.removeListener('reconnected', listeners.reconnected);
  conn.removeListener('error', listeners.error);

  if (typeof conn.getClient === 'function') {
    const client = conn.getClient();
    if (client) {
      detachClientPoolTelemetry(client);
    }
  }

  attachedConnections.delete(conn);
}

/** Returns whether telemetry listeners are currently attached to the connection instance. */
export function isConnectionTelemetryRegistered(
  conn: object = mongoose.connection,
): boolean {
  return attachedConnections.has(conn);
}

/** Connect to MongoDB with bounded connection pool and 5s server selection timeout. */
export async function connectDB(
  uri: string = env.MONGODB_URI,
  options?: mongoose.ConnectOptions,
): Promise<typeof mongoose> {
  registerConnectionTelemetry(mongoose.connection);
  setMongoConnectionState(MongoConnectionState.CONNECTING);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 50,
      minPoolSize: 5,
      socketTimeoutMS: 30000,
      ...options,
    });
    setMongoConnectionState(MongoConnectionState.CONNECTED);
    logger.info('MongoDB connected');
    return mongoose;
  } catch (err) {
    clearPingCache();
    poolTotal = 0;
    poolCheckedOut = 0;
    updatePoolCounts();
    setMongoConnectionState(MongoConnectionState.DISCONNECTED);
    logger.error({ err }, 'MongoDB connection failed');
    throw err;
  }
}

export async function disconnectDB(): Promise<void> {
  clearPingCache();
  setMongoConnectionState(MongoConnectionState.DISCONNECTING);
  try {
    await mongoose.disconnect();
    logger.info('MongoDB disconnected');
  } finally {
    clearPingCache();
    poolTotal = 0;
    poolCheckedOut = 0;
    updatePoolCounts();
    setMongoConnectionState(MongoConnectionState.DISCONNECTED);
  }
}

/**
 * Readiness probe used by health endpoints — measures real round-trip latency safely.
 * Includes short-lived TTL caching (~1-2s in production, 0 in tests) and in-flight promise
 * coalescing to prevent ping request bursts against MongoDB.
 */
export async function pingDB(options?: PingOptions): Promise<PingResult> {
  const start = Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_PING_CACHE_TTL_MS;
  const bypassCache = options?.bypassCache ?? false;

  // 1. Immediately fail and clear cache if application shutdown has initiated
  if (isAppShuttingDown()) {
    clearPingCache();
    return { ok: false, latencyMs: 0 };
  }

  // 2. Immediately fail and clear cache if Mongoose is not in connected state
  if (!mongoose.connection || mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
    clearPingCache();
    return { ok: false, latencyMs: Date.now() - start };
  }

  const now = Date.now();

  // 3. Return cached healthy result if still within TTL
  if (!bypassCache && cachedPingResult && ttlMs > 0 && now - cachedPingTimestamp < ttlMs) {
    return { ...cachedPingResult, fromCache: true };
  }

  // 4. In-flight single-flight coalescing: collapse concurrent callers into one execution
  if (inFlightPing) {
    return inFlightPing;
  }

  // 5. Execute round-trip ping command against MongoDB admin db
  inFlightPing = (async () => {
    const pingStart = Date.now();
    try {
      if (!mongoose.connection || mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
        clearPingCache();
        const latencyMs = Date.now() - pingStart;
        recordMongoOperationDuration('ping', 'failure', latencyMs / 1000);
        return { ok: false, latencyMs };
      }

      await mongoose.connection.db.admin().command({ ping: 1 });
      const latencyMs = Math.max(0, Date.now() - pingStart);
      recordMongoOperationDuration('ping', 'success', latencyMs / 1000);
      const result: PingResult = { ok: true, latencyMs };

      if (ttlMs > 0 && !isAppShuttingDown() && mongoose.connection?.readyState === 1) {
        cachedPingResult = result;
        cachedPingTimestamp = Date.now();
      }

      return result;
    } catch {
      clearPingCache();
      const latencyMs = Math.max(0, Date.now() - pingStart);
      recordMongoOperationDuration('ping', 'failure', latencyMs / 1000);
      return { ok: false, latencyMs };
    } finally {
      inFlightPing = null;
    }
  })();

  return inFlightPing;
}

