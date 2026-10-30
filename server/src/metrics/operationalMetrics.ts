import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from './registry.js';
import { logger } from '../config/logger.js';

/**
 * Bounded reconciliation sweep statuses.
 */
export const BOUNDED_RECONCILIATION_STATUSES = [
  'success',
  'failure',
  'skipped_locked',
] as const;
export type ReconciliationSweepStatus = (typeof BOUNDED_RECONCILIATION_STATUSES)[number];

/**
 * Bounded scheduler lock operations and outcomes.
 */
export const BOUNDED_LOCK_NAMES = [
  'ambulance_reconciliation',
  'automated_dispatch',
] as const;
export type SchedulerLockName = (typeof BOUNDED_LOCK_NAMES)[number];

export const BOUNDED_LOCK_OPERATIONS = ['acquire', 'renew', 'release'] as const;
export type SchedulerLockOperation = (typeof BOUNDED_LOCK_OPERATIONS)[number];

export const BOUNDED_LOCK_RESULTS = [
  'acquired',
  'held_by_other',
  'store_error',
  'renewed',
  'renew_failed',
  'released',
  'release_failed',
] as const;
export type SchedulerLockResult = (typeof BOUNDED_LOCK_RESULTS)[number];

/**
 * Bounded fleet recovery reasons and outcomes.
 */
export const BOUNDED_RECOVERY_REASONS = [
  'missing_emergency',
  'terminal_emergency',
  'displaced',
  'null_reference',
] as const;
export type FleetRecoveryReason = (typeof BOUNDED_RECOVERY_REASONS)[number];

export const BOUNDED_RECOVERY_OUTCOMES = ['released', 'skipped', 'failed'] as const;
export type FleetRecoveryOutcome = (typeof BOUNDED_RECOVERY_OUTCOMES)[number];

export const BOUNDED_CAS_TARGETS = ['ambulance', 'emergency'] as const;
export type FleetCasTarget = (typeof BOUNDED_CAS_TARGETS)[number];

// ==========================================
// METRIC DEFINITIONS (Prometheus Registry)
// ==========================================

/**
 * Counter recording total ambulance reconciliation sweeps by outcome.
 */
export const reconciliationSweepsCounter = new Counter({
  name: 'rapidaid_reconciliation_sweeps_total',
  help: 'Total count of ambulance reconciliation sweeps by outcome',
  labelNames: ['status'] as const,
  registers: [metricsRegistry],
});

/**
 * Histogram recording ambulance reconciliation sweep duration in seconds.
 */
export const reconciliationSweepDurationHistogram = new Histogram({
  name: 'rapidaid_reconciliation_sweep_duration_seconds',
  help: 'Ambulance reconciliation sweep duration in seconds',
  labelNames: ['status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

/**
 * Counter recording distributed scheduler lock operations and outcomes.
 */
export const schedulerLockOperationsCounter = new Counter({
  name: 'rapidaid_scheduler_lock_operations_total',
  help: 'Total count of distributed scheduler lock operations',
  labelNames: ['lock', 'operation', 'result'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter recording stranded ambulance fleet recovery outcomes.
 */
export const fleetRecoveryOutcomesCounter = new Counter({
  name: 'rapidaid_fleet_recovery_outcomes_total',
  help: 'Total count of stranded ambulance recovery evaluations by reason and outcome',
  labelNames: ['reason', 'outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Counter recording compare-and-swap operations that resulted in no modifications (no-op).
 */
export const fleetCasNoOpCounter = new Counter({
  name: 'rapidaid_fleet_cas_no_op_total',
  help: 'Total count of fleet compare-and-swap operations that resulted in no modifications',
  labelNames: ['target'] as const,
  registers: [metricsRegistry],
});

// ==========================================
// RECORDING & HELPER FUNCTIONS
// ==========================================

/**
 * Records reconciliation sweep outcome and optional execution duration in seconds.
 */
export function recordReconciliationSweep(
  status: ReconciliationSweepStatus,
  durationSeconds?: number,
): void {
  try {
    if (!BOUNDED_RECONCILIATION_STATUSES.includes(status)) {
      logger.warn({ status }, 'Attempted to record unapproved reconciliation sweep status metric');
      return;
    }
    reconciliationSweepsCounter.inc({ status });

    if (durationSeconds !== undefined && (status === 'success' || status === 'failure')) {
      const safeDuration = Math.max(0, Number.isFinite(durationSeconds) ? durationSeconds : 0);
      reconciliationSweepDurationHistogram.observe({ status }, safeDuration);
    }
  } catch (err) {
    logger.warn({ err }, 'Error recording reconciliation sweep metric');
  }
}

/**
 * Records a distributed scheduler lock operation and outcome.
 */
export function recordSchedulerLockOperation(
  lock: string,
  operation: SchedulerLockOperation,
  result: SchedulerLockResult,
): void {
  try {
    const validLock = BOUNDED_LOCK_NAMES.includes(lock as SchedulerLockName)
      ? lock
      : lock.startsWith('dispatch_')
        ? 'automated_dispatch'
        : 'ambulance_reconciliation';
    if (!BOUNDED_LOCK_OPERATIONS.includes(operation) || !BOUNDED_LOCK_RESULTS.includes(result)) {
      logger.warn({ lock, operation, result }, 'Attempted to record unapproved scheduler lock metric');
      return;
    }
    schedulerLockOperationsCounter.inc({ lock: validLock, operation, result });
  } catch (err) {
    logger.warn({ err }, 'Error recording scheduler lock metric');
  }
}

/**
 * Records a fleet recovery outcome for an evaluated ambulance.
 */
export function recordFleetRecoveryOutcome(
  reason: FleetRecoveryReason,
  outcome: FleetRecoveryOutcome,
): void {
  try {
    if (!BOUNDED_RECOVERY_REASONS.includes(reason) || !BOUNDED_RECOVERY_OUTCOMES.includes(outcome)) {
      logger.warn({ reason, outcome }, 'Attempted to record unapproved fleet recovery metric');
      return;
    }
    fleetRecoveryOutcomesCounter.inc({ reason, outcome });
  } catch (err) {
    logger.warn({ err }, 'Error recording fleet recovery outcome metric');
  }
}

/**
 * Records a compare-and-swap operation that made no changes.
 */
export function recordFleetCasNoOp(target: FleetCasTarget): void {
  try {
    if (!BOUNDED_CAS_TARGETS.includes(target)) {
      logger.warn({ target }, 'Attempted to record unapproved fleet CAS no-op metric');
      return;
    }
    fleetCasNoOpCounter.inc({ target });
  } catch (err) {
    logger.warn({ err }, 'Error recording fleet CAS no-op metric');
  }
}

// ==========================================
// TEST ISOLATION & DIAGNOSTIC GETTERS
// ==========================================

export async function getReconciliationSweepCount(status: ReconciliationSweepStatus): Promise<number> {
  const metric = await reconciliationSweepsCounter.get();
  const match = metric.values.find((v) => v.labels.status === status);
  return match?.value ?? 0;
}

export async function getSchedulerLockOperationCount(
  lock: string,
  operation: SchedulerLockOperation,
  result: SchedulerLockResult,
): Promise<number> {
  const metric = await schedulerLockOperationsCounter.get();
  const match = metric.values.find(
    (v) => v.labels.lock === lock && v.labels.operation === operation && v.labels.result === result,
  );
  return match?.value ?? 0;
}

export async function getFleetRecoveryOutcomeCount(
  reason: FleetRecoveryReason,
  outcome: FleetRecoveryOutcome,
): Promise<number> {
  const metric = await fleetRecoveryOutcomesCounter.get();
  const match = metric.values.find((v) => v.labels.reason === reason && v.labels.outcome === outcome);
  return match?.value ?? 0;
}

export async function getFleetCasNoOpCount(target: FleetCasTarget): Promise<number> {
  const metric = await fleetCasNoOpCounter.get();
  const match = metric.values.find((v) => v.labels.target === target);
  return match?.value ?? 0;
}

export function resetOperationalMetrics(): void {
  reconciliationSweepsCounter.reset();
  reconciliationSweepDurationHistogram.reset();
  schedulerLockOperationsCounter.reset();
  fleetRecoveryOutcomesCounter.reset();
  fleetCasNoOpCounter.reset();
}
