/**
 * Application Lifecycle & Graceful Shutdown State
 * Central source of truth for process shutdown coordination.
 */

let isShuttingDown = false;

/** Returns whether the application has initiated graceful shutdown. */
export function isAppShuttingDown(): boolean {
  return isShuttingDown;
}

/** Initiates application shutdown state. */
export function setAppShuttingDown(value: boolean = true): void {
  isShuttingDown = value;
}

/** Resets application shutdown state (used for test isolation). */
export function resetAppShuttingDown(): void {
  isShuttingDown = false;
}
