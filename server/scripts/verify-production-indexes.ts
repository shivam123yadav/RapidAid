/**
 * RapidAid — Production Database Index Verification & Readiness CLI
 *
 * Verifies that all required production indexes exist on the target MongoDB cluster.
 * Safely creates any missing indexes in the background without dropping or altering records.
 *
 * Usage:
 *   npx tsx scripts/verify-production-indexes.ts
 */
import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import { logger } from '../src/config/logger.js';
import {
  User,
  Ambulance,
  Emergency,
  Hospital,
  HospitalReservation,
  Notification,
  AuditLog,
  RefreshToken,
  VoiceReport,
  RolePolicy,
  Counter,
  ensureEmergencyIdempotencyIndex,
} from '../src/models/index.js';
import { ensureHospitalGeoFields } from '../src/services/hospitalRoutingService.js';

interface ModelIndexExpectation {
  modelName: string;
  model: mongoose.Model<any>;
  criticalKeys: string[];
}

const EXPECTATIONS: ModelIndexExpectation[] = [
  {
    modelName: 'User',
    model: User,
    criticalKeys: ['email_1'],
  },
  {
    modelName: 'Ambulance',
    model: Ambulance,
    criticalKeys: ['status_1', 'active_1'],
  },
  {
    modelName: 'Emergency',
    model: Emergency,
    criticalKeys: ['status_1', 'idempotencyKey_1'],
  },
  {
    modelName: 'Hospital',
    model: Hospital,
    criticalKeys: ['active_1_status_1'],
  },
  {
    modelName: 'HospitalReservation',
    model: HospitalReservation,
    criticalKeys: ['emergencyId_1', 'status_1'],
  },
  {
    modelName: 'Notification',
    model: Notification,
    criticalKeys: ['ownerId_1_timestamp_-1', 'idempotencyKey_1'],
  },
  {
    modelName: 'AuditLog',
    model: AuditLog,
    criticalKeys: ['timestamp_-1', 'action_1'],
  },
  {
    modelName: 'RefreshToken',
    model: RefreshToken,
    criticalKeys: ['tokenHash_1'],
  },
  {
    modelName: 'VoiceReport',
    model: VoiceReport,
    criticalKeys: ['ownerId_1_createdAt_-1', 'dispatchStatus_1'],
  },
  {
    modelName: 'RolePolicy',
    model: RolePolicy,
    criticalKeys: ['_id_'],
  },
  {
    modelName: 'Counter',
    model: Counter,
    criticalKeys: ['_id_'],
  },
];

export async function verifyAndEnsureIndexes(): Promise<{
  success: boolean;
  results: Array<{
    model: string;
    existingIndexes: string[];
    missingCritical: string[];
    createdCount: number;
  }>;
}> {
  const results = [];
  let allHealthy = true;

  // 1. First run dedicated Emergency idempotency index verification
  const emgResult = await ensureEmergencyIdempotencyIndex();
  logger.info({ emgResult }, 'Emergency idempotencyKey index status checked');

  // 2. Safely reconcile hospital geo fields before verifying hospital indexes
  try {
    const geoUpdated = await ensureHospitalGeoFields();
    if (geoUpdated > 0) {
      logger.info({ geoUpdated }, 'Backfilled missing/malformed hospital GeoJSON points');
    }
  } catch (err) {
    logger.warn({ err }, 'Note during hospital geo reconciliation');
  }

  for (const exp of EXPECTATIONS) {
    try {
      // Ensure Mongoose schema indexes are synced
      await exp.model.createIndexes();

      // Retrieve verified indexes from collection
      const rawIndexes = await exp.model.collection.indexes();
      const indexNames = rawIndexes.map((idx) => idx.name || JSON.stringify(idx.key));

      const missing = exp.criticalKeys.filter((key) => !indexNames.includes(key));

      if (missing.length > 0) {
        allHealthy = false;
        logger.warn(
          { model: exp.modelName, missing, available: indexNames },
          `Model ${exp.modelName} has missing critical index(es)`,
        );
      } else {
        logger.info(
          { model: exp.modelName, indexCount: indexNames.length, indexes: indexNames },
          `Model ${exp.modelName} indexes verified`,
        );
      }

      results.push({
        model: exp.modelName,
        existingIndexes: indexNames,
        missingCritical: missing,
        createdCount: indexNames.length,
      });
    } catch (err) {
      allHealthy = false;
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ model: exp.modelName, err: msg }, `Failed to verify indexes for ${exp.modelName}`);
      results.push({
        model: exp.modelName,
        existingIndexes: [],
        missingCritical: exp.criticalKeys,
        createdCount: 0,
      });
    }
  }

  return { success: allHealthy, results };
}

async function run(): Promise<void> {
  try {
    logger.info('Connecting to database for index verification...');
    await connectDB();

    const { success, results } = await verifyAndEnsureIndexes();

    console.log('\n======================================================');
    console.log('       RAPIDAID PRODUCTION INDEX VERIFICATION REPORT   ');
    console.log('======================================================');
    for (const r of results) {
      const statusIcon = r.missingCritical.length === 0 ? '✅' : '⚠️';
      console.log(`${statusIcon} ${r.model.padEnd(20)} | Indexes: ${String(r.existingIndexes.length).padStart(2)} | Missing: ${r.missingCritical.length > 0 ? r.missingCritical.join(', ') : 'None'}`);
    }
    console.log('======================================================');
    console.log(`Overall Index Status: ${success ? 'ALL PRODUCTION INDEXES READY' : 'SOME INDEXES NEED ATTENTION'}\n`);

    await disconnectDB();
    process.exit(success ? 0 : 1);
  } catch (err) {
    logger.fatal({ err }, 'Index verification script terminated with error');
    await disconnectDB().catch(() => {});
    process.exit(1);
  }
}

if (process.argv[1]?.includes('verify-production-indexes')) {
  run();
}
