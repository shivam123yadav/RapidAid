import { createApp } from './app.js';
import { env, isTest } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDB, disconnectDB } from './db/connection.js';
import { seedIfEmpty } from './seed/seed.js';
import { ensureEmergencyIdempotencyIndex } from './models/index.js';
import {
  reconcileStrandedAmbulances,
  startAmbulanceReconciliationScheduler,
  stopAmbulanceReconciliationScheduler,
} from './services/emergencyService.js';
import {
  startHospitalReservationReconciliationScheduler,
  stopHospitalReservationReconciliationScheduler,
} from './services/hospitalReservationService.js';
import { reconcileVoiceConfirmations } from './services/voiceEmergencyService.js';
import { isAppShuttingDown, setAppShuttingDown } from './config/lifecycle.js';

/**
 * Process entry point: connect MongoDB (fail-fast), optional idempotent
 * seed, start HTTP server, wire graceful shutdown.
 */
async function main(): Promise<void> {
  await connectDB();

  try {
    const indexResult = await ensureEmergencyIdempotencyIndex();
    if (!indexResult.ready) {
      logger.warn(
        { indexResult },
        'Startup: Emergency idempotency unique index is not active; deduplication degraded',
      );
    }
    const recon = await reconcileStrandedAmbulances();
    if (recon.released.length > 0) {
      logger.info({ released: recon.released }, 'Startup: reconciled stranded ambulances');
    }
    const voiceRecon = await reconcileVoiceConfirmations();
    if (voiceRecon.recoveredConfirmations.length > 0) {
      logger.info(
        { recovered: voiceRecon.recoveredConfirmations },
        'Startup: reconciled interrupted voice report confirmations',
      );
    }
  } catch (reconErr) {
    logger.warn({ err: reconErr }, 'Startup: note during initial reconciliation sweep');
  }

  // Start periodic 10-minute ambulance reconciliation sweeper with initial jitter
  startAmbulanceReconciliationScheduler();

  // Start periodic hospital reservation reconciliation sweeper with jitter and staging safeguards
  startHospitalReservationReconciliationScheduler();

  if (env.SEED_IF_EMPTY) {
    await seedIfEmpty();
  }

  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () => {
    logger.info(`RapidAid API listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
  });

  // Slow-request watchdog: warn if a request takes > 10s.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;

  const shutdown = (signal: string): void => {
    if (isAppShuttingDown()) return;
    setAppShuttingDown(true);
    logger.info(`${signal} received — draining connections`);
    server.close(async () => {
      await executeGracefulShutdown();
    });
    // Force-exit if draining hangs (keep-alive sockets, stuck queries).
    setTimeout(() => {
      logger.warn('Forcing shutdown after 10s grace period');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — exiting');
    process.exit(1);
  });
}

export interface ShutdownOptions {
  drainGracePeriodMs?: number;
  disconnectDatabase?: () => Promise<void>;
  exitProcess?: (code: number) => void;
}

export async function executeGracefulShutdown(options?: ShutdownOptions): Promise<void> {
  setAppShuttingDown(true);
  const gracePeriod = options?.drainGracePeriodMs ?? 5_000;
  const disconnect = options?.disconnectDatabase ?? disconnectDB;
  const exit = options?.exitProcess ?? process.exit;

  try {
    await Promise.allSettled([
      stopAmbulanceReconciliationScheduler(gracePeriod),
      stopHospitalReservationReconciliationScheduler(gracePeriod),
    ]);
    await disconnect();
    logger.info('Shutdown complete');
    exit(0);
  } catch (err: unknown) {
    if ((err as { isDrainTimeout?: boolean })?.isDrainTimeout) {
      logger.fatal(
        'Fail-stop: Immediate exit invoked without disconnecting MongoDB to prevent query collision during active sweep',
      );
      exit(1);
      return;
    }
    logger.error({ err }, 'Error during graceful shutdown sequence');
    exit(1);
  }
}

if (!isTest) {
  main().catch((err) => {
    logger.fatal({ err }, 'failed to start server');
    process.exit(1);
  });
}

export { createApp } from './app.js';
export { executeGracefulShutdown as shutdownReconciliationAndDB };
export { isAppShuttingDown, setAppShuttingDown, resetAppShuttingDown } from './config/lifecycle.js';

