import { Counter, Gauge, Histogram } from 'prom-client';
import { metricsRegistry } from './registry.js';
import { logger } from '../config/logger.js';

/**
 * MongoDB connection states matching Mongoose ConnectionStates:
 * 0: disconnected
 * 1: connected
 * 2: connecting
 * 3: disconnecting
 */
export const MongoConnectionState = {
  DISCONNECTED: 0,
  CONNECTED: 1,
  CONNECTING: 2,
  DISCONNECTING: 3,
} as const;

export type MongoConnectionStateValue =
  (typeof MongoConnectionState)[keyof typeof MongoConnectionState];

/**
 * Bounded lifecycle event labels.
 * Strictly limited to approved Mongoose/driver lifecycle events to prevent unbounded label cardinality.
 */
export const BOUNDED_LIFECYCLE_EVENTS = [
  'connected',
  'disconnected',
  'reconnected',
  'error',
] as const;

export type MongoLifecycleEvent = (typeof BOUNDED_LIFECYCLE_EVENTS)[number];

/**
 * Bounded MongoDB operation labels for latency tracking.
 */
export const BOUNDED_MONGO_OPERATIONS = ['ping'] as const;
export type MongoOperation = (typeof BOUNDED_MONGO_OPERATIONS)[number];

export const BOUNDED_MONGO_STATUSES = ['success', 'failure'] as const;
export type MongoOperationStatus = (typeof BOUNDED_MONGO_STATUSES)[number];

/**
 * Bounded connection pool states and event labels.
 */
export const BOUNDED_POOL_STATES = ['total', 'checked_out', 'idle'] as const;
export type MongoPoolState = (typeof BOUNDED_POOL_STATES)[number];

export const BOUNDED_POOL_CHECKOUT_FAILURE_REASONS = [
  'timeout',
  'connection_closed',
  'cancelled',
  'unknown',
] as const;
export type MongoPoolCheckoutFailureReason =
  (typeof BOUNDED_POOL_CHECKOUT_FAILURE_REASONS)[number];

export const BOUNDED_POOL_LIFECYCLE_EVENTS = [
  'pool_created',
  'pool_ready',
  'pool_cleared',
  'pool_closed',
] as const;
export type MongoPoolLifecycleEvent = (typeof BOUNDED_POOL_LIFECYCLE_EVENTS)[number];

// ==========================================
// METRIC DEFINITIONS (Prometheus Registry)
// ==========================================

/**
 * Gauge representing current MongoDB connection state:
 * 0: disconnected, 1: connected, 2: connecting, 3: disconnecting
 */
export const mongoConnectionStateGauge = new Gauge({
  name: 'rapidaid_mongodb_connection_state',
  help: 'Current MongoDB connection state: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting',
  registers: [metricsRegistry],
});

/**
 * Counter recording connection lifecycle events with bounded event labels.
 */
export const mongoConnectionEventsCounter = new Counter({
  name: 'rapidaid_mongodb_connection_events_total',
  help: 'Total count of MongoDB connection lifecycle events',
  labelNames: ['event'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram recording MongoDB round-trip operation duration in seconds.
 * Meaningful buckets covering sub-millisecond roundtrips up to 5s server selection timeout.
 */
export const mongoOperationDurationHistogram = new Histogram({
  name: 'rapidaid_mongodb_operation_duration_seconds',
  help: 'MongoDB database operation duration in seconds',
  labelNames: ['operation', 'status'] as const,
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

/**
 * Gauge tracking active, checked-out, and idle connections in the pool.
 */
export const mongoPoolConnectionsGauge = new Gauge({
  name: 'rapidaid_mongodb_pool_connections',
  help: 'Current count of MongoDB connections in the pool by state: total, checked_out, idle',
  labelNames: ['state'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter tracking connection pool checkout failures by bounded reason.
 */
export const mongoPoolCheckoutFailuresCounter = new Counter({
  name: 'rapidaid_mongodb_pool_checkout_failures_total',
  help: 'Total count of MongoDB connection pool checkout failures',
  labelNames: ['reason'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter tracking connection pool lifecycle events.
 */
export const mongoPoolEventsCounter = new Counter({
  name: 'rapidaid_mongodb_pool_events_total',
  help: 'Total count of MongoDB connection pool lifecycle events',
  labelNames: ['event'] as const,
  registers: [metricsRegistry],
});

// Set default initial state values
mongoConnectionStateGauge.set(MongoConnectionState.DISCONNECTED);
mongoPoolConnectionsGauge.set({ state: 'total' }, 0);
mongoPoolConnectionsGauge.set({ state: 'checked_out' }, 0);
mongoPoolConnectionsGauge.set({ state: 'idle' }, 0);

// ==========================================
// RECORDING & HELPER FUNCTIONS
// ==========================================

/** Updates the MongoDB connection state gauge. */
export function setMongoConnectionState(state: MongoConnectionStateValue): void {
  mongoConnectionStateGauge.set(state);
}

/**
 * Increments the connection events counter for an approved bounded event.
 * Discards unapproved events to prevent label cardinality explosion.
 */
export function recordMongoLifecycleEvent(event: MongoLifecycleEvent): void {
  if (!BOUNDED_LIFECYCLE_EVENTS.includes(event)) {
    logger.warn({ event }, 'Attempted to record unapproved MongoDB lifecycle event metric');
    return;
  }
  mongoConnectionEventsCounter.inc({ event });
}

/**
 * Records a database operation duration observation in seconds.
 * Validates bounded labels to prevent label cardinality explosion.
 */
export function recordMongoOperationDuration(
  operation: MongoOperation,
  status: MongoOperationStatus,
  durationSeconds: number,
): void {
  try {
    if (!BOUNDED_MONGO_OPERATIONS.includes(operation) || !BOUNDED_MONGO_STATUSES.includes(status)) {
      logger.warn({ operation, status }, 'Attempted to record unapproved MongoDB operation metric');
      return;
    }
    const safeDuration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
    mongoOperationDurationHistogram.observe({ operation, status }, safeDuration);
  } catch (err) {
    logger.warn({ err }, 'Error observing MongoDB operation duration metric');
  }
}

/**
 * Updates the connection pool gauge values for total, checked_out, and idle states.
 */
export function setMongoPoolConnectionCounts(counts: {
  total: number;
  checkedOut: number;
  idle: number;
}): void {
  try {
    mongoPoolConnectionsGauge.set({ state: 'total' }, Math.max(0, counts.total));
    mongoPoolConnectionsGauge.set({ state: 'checked_out' }, Math.max(0, counts.checkedOut));
    mongoPoolConnectionsGauge.set({ state: 'idle' }, Math.max(0, counts.idle));
  } catch (err) {
    logger.warn({ err }, 'Error updating MongoDB connection pool gauge');
  }
}

/**
 * Increments the connection checkout failure counter for a bounded reason.
 */
export function recordMongoPoolCheckoutFailure(reason: MongoPoolCheckoutFailureReason): void {
  try {
    const validReason = BOUNDED_POOL_CHECKOUT_FAILURE_REASONS.includes(reason)
      ? reason
      : 'unknown';
    mongoPoolCheckoutFailuresCounter.inc({ reason: validReason });
  } catch (err) {
    logger.warn({ err }, 'Error recording MongoDB pool checkout failure metric');
  }
}

/**
 * Increments the connection pool lifecycle event counter.
 */
export function recordMongoPoolEvent(event: MongoPoolLifecycleEvent): void {
  try {
    if (!BOUNDED_POOL_LIFECYCLE_EVENTS.includes(event)) {
      logger.warn({ event }, 'Attempted to record unapproved MongoDB pool event metric');
      return;
    }
    mongoPoolEventsCounter.inc({ event });
  } catch (err) {
    logger.warn({ err }, 'Error recording MongoDB pool event metric');
  }
}

// ==========================================
// TEST ISOLATION & DIAGNOSTIC GETTERS
// ==========================================

/** Reads the current numeric value of the connection state gauge. */
export async function getMongoConnectionStateValue(): Promise<number> {
  const metric = await mongoConnectionStateGauge.get();
  return metric.values[0]?.value ?? MongoConnectionState.DISCONNECTED;
}

/** Reads the current count for a specific bounded lifecycle event. */
export async function getMongoLifecycleEventCount(event: MongoLifecycleEvent): Promise<number> {
  const metric = await mongoConnectionEventsCounter.get();
  const match = metric.values.find((v) => v.labels.event === event);
  return match?.value ?? 0;
}

/** Reads the current numeric value of a pool connection state gauge. */
export async function getMongoPoolConnectionCount(state: MongoPoolState): Promise<number> {
  const metric = await mongoPoolConnectionsGauge.get();
  const match = metric.values.find((v) => v.labels.state === state);
  return match?.value ?? 0;
}

/** Reads the current count for a specific pool checkout failure reason. */
export async function getMongoPoolCheckoutFailureCount(
  reason: MongoPoolCheckoutFailureReason,
): Promise<number> {
  const metric = await mongoPoolCheckoutFailuresCounter.get();
  const match = metric.values.find((v) => v.labels.reason === reason);
  return match?.value ?? 0;
}

/** Reads the current count for a specific pool lifecycle event. */
export async function getMongoPoolEventCount(event: MongoPoolLifecycleEvent): Promise<number> {
  const metric = await mongoPoolEventsCounter.get();
  const match = metric.values.find((v) => v.labels.event === event);
  return match?.value ?? 0;
}

/** Reads total observations for a database operation duration status. */
export async function getMongoOperationObservationCount(
  operation: MongoOperation,
  status: MongoOperationStatus,
): Promise<number> {
  const metric = await mongoOperationDurationHistogram.get();
  // Filter for the count entry matching labels
  const match = metric.values.find(
    (v) => v.metricName === 'rapidaid_mongodb_operation_duration_seconds_count' &&
      v.labels.operation === operation &&
      v.labels.status === status,
  );
  return match?.value ?? 0;
}

/** Resets all database metrics and restores gauges to clean initial states. */
export function resetDatabaseMetrics(): void {
  mongoConnectionStateGauge.reset();
  mongoConnectionEventsCounter.reset();
  mongoOperationDurationHistogram.reset();
  mongoPoolConnectionsGauge.reset();
  mongoPoolCheckoutFailuresCounter.reset();
  mongoPoolEventsCounter.reset();

  mongoConnectionStateGauge.set(MongoConnectionState.DISCONNECTED);
  mongoPoolConnectionsGauge.set({ state: 'total' }, 0);
  mongoPoolConnectionsGauge.set({ state: 'checked_out' }, 0);
  mongoPoolConnectionsGauge.set({ state: 'idle' }, 0);
}

