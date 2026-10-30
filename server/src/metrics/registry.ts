import { Registry } from 'prom-client';

/**
 * Central Prometheus metrics registry for RapidAid V2.
 * Holds all application, database, and operational metrics.
 */
export const metricsRegistry = new Registry();

/** Clears all metric values across the registry (for test isolation). */
export function resetMetricsRegistry(): void {
  metricsRegistry.resetMetrics();
}
