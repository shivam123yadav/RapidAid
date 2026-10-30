/**
 * RapidAid Idempotency Index Migration CLI
 *
 * Operational utility for safe inspection, backup, deduplication, and
 * unique sparse index creation on the Emergency.idempotencyKey field.
 *
 * Usage:
 *   npx tsx scripts/migrate-idempotency-index.ts --inspect
 *   npx tsx scripts/migrate-idempotency-index.ts --apply --confirm
 *   npx tsx scripts/migrate-idempotency-index.ts --verify
 */

import mongoose from 'mongoose';
import { connectDB, disconnectDB } from '../src/db/connection.js';
import { logger } from '../src/config/logger.js';
import { Emergency, ensureEmergencyCollection } from '../src/models/Emergency.js';

export const BACKUP_COLLECTION_NAME = 'emergency_idempotency_backup';
export const INDEX_NAME = 'idempotencyKey_1';

export interface DuplicateGroup {
  idempotencyKey: string;
  count: number;
  records: Array<{
    id: string;
    reportedAt: Date;
    status: string;
    description: string;
  }>;
  survivingRecordId: string;
  displacedRecordIds: string[];
}

export interface InspectionReport {
  duplicateGroupsCount: number;
  totalAffectedDocuments: number;
  groups: DuplicateGroup[];
  indexStatus: {
    exists: boolean;
    name?: string;
    isUnique?: boolean;
    isSparse?: boolean;
  };
}

/**
 * Read-only inspection of Emergency collection for duplicate idempotency keys.
 * Never modifies any documents.
 */
export async function inspectDuplicates(): Promise<InspectionReport> {
  await ensureEmergencyCollection();
  const indexes = await Emergency.collection.indexes();
  const existingIndex = indexes.find(
    (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
  );

  const rawDuplicates = await Emergency.aggregate([
    { $match: { idempotencyKey: { $exists: true, $ne: null } } },
    { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  const groups: DuplicateGroup[] = [];
  let totalAffected = 0;

  for (const dup of rawDuplicates) {
    const key = String(dup._id);
    const docs = await Emergency.find({ _id: { $in: dup.ids } })
      .sort({ reportedAt: 1, _id: 1 })
      .lean();

    // Deterministic survival policy: Keep oldest reported record (first created).
    // In an emergency response system, the first reported incident is the ground-truth event.
    const [survivor, ...displaced] = docs;

    totalAffected += docs.length;
    groups.push({
      idempotencyKey: key,
      count: docs.length,
      records: docs.map((d) => ({
        id: String(d._id),
        reportedAt: d.reportedAt,
        status: d.status,
        description: d.description?.slice(0, 50) ?? '',
      })),
      survivingRecordId: String(survivor._id),
      displacedRecordIds: displaced.map((d) => String(d._id)),
    });
  }

  return {
    duplicateGroupsCount: groups.length,
    totalAffectedDocuments: totalAffected,
    groups,
    indexStatus: {
      exists: Boolean(existingIndex),
      name: existingIndex?.name,
      isUnique: existingIndex?.unique === true,
      isSparse: existingIndex?.sparse === true,
    },
  };
}

/**
 * Applies migration safely:
 * 1. Backs up displaced documents into BACKUP_COLLECTION_NAME before altering.
 * 2. Unsets idempotencyKey on displaced documents.
 * 3. Builds the unique sparse index.
 */
export async function applyMigration(options: {
  confirmed: boolean;
  backupCollectionName?: string;
}): Promise<{
  success: boolean;
  backedUpCount: number;
  unsetCount: number;
  indexCreated: boolean;
}> {
  if (!options.confirmed) {
    throw new Error('Refusing to apply migration: --confirm flag is required to authorize data changes.');
  }

  const backupColName = options.backupCollectionName ?? BACKUP_COLLECTION_NAME;
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('Database connection is not initialized');
  }

  const inspection = await inspectDuplicates();

  let backedUpCount = 0;
  let unsetCount = 0;

  if (inspection.duplicateGroupsCount > 0) {
    const displacedIds = inspection.groups.flatMap((g) => g.displacedRecordIds);

    // Fetch full original documents for backup
    const documentsToBackup = await Emergency.find({ _id: { $in: displacedIds } }).lean();

    // 1. BACKUP PHASE: Abort if backup cannot be persisted
    const backupDocs = documentsToBackup.map((doc) => ({
      _id: `backup-${doc._id}-${Date.now()}`,
      originalId: doc._id,
      backedUpAt: new Date(),
      migrationName: 'idempotency-key-deduplication',
      originalDoc: doc,
    }));

    try {
      const backupInsertResult = await (db.collection(backupColName) as {
        insertMany: (docs: unknown[]) => Promise<{ insertedCount: number }>;
      }).insertMany(backupDocs);
      backedUpCount = backupInsertResult.insertedCount;
    } catch (backupErr) {
      logger.error({ err: backupErr }, 'Migration aborted: Failed to back up affected records');
      throw new Error(`Backup failed: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}. No records were modified.`);
    }

    // 2. UNSET PHASE: Clear key on displaced documents
    const unsetResult = await Emergency.updateMany(
      { _id: { $in: displacedIds } },
      { $unset: { idempotencyKey: 1 }, $set: { updatedAt: new Date() } },
    );
    unsetCount = unsetResult.modifiedCount;
  }

  // 3. INDEX CREATION PHASE
  let indexCreated = false;
  const indexes = await Emergency.collection.indexes();
  const existing = indexes.find(
    (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
  );

  if (!existing || existing.unique !== true || existing.sparse !== true) {
    if (existing) {
      logger.info({ existingIndex: existing.name }, 'Dropping invalid existing index before recreating with unique and sparse flags');
      await Emergency.collection.dropIndex(existing.name!);
    }

    await Emergency.collection.createIndex(
      { idempotencyKey: 1 },
      { unique: true, sparse: true, background: true, name: INDEX_NAME },
    );
    indexCreated = true;
  }

  return {
    success: true,
    backedUpCount,
    unsetCount,
    indexCreated,
  };
}

/**
 * Directly verifies index metadata in MongoDB.
 */
export async function verifyIndex(): Promise<{
  verified: boolean;
  indexDetails?: Record<string, unknown>;
  remainingDuplicates: number;
  message: string;
}> {
  await ensureEmergencyCollection();
  const indexes = await Emergency.collection.indexes();
  const existing = indexes.find(
    (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
  );

  const duplicateGroups = await Emergency.aggregate([
    { $match: { idempotencyKey: { $exists: true, $ne: null } } },
    { $group: { _id: '$idempotencyKey', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);

  if (!existing) {
    return {
      verified: false,
      remainingDuplicates: duplicateGroups.length,
      message: `Index on { idempotencyKey: 1 } does not exist.`,
    };
  }

  if (existing.unique !== true || existing.sparse !== true) {
    return {
      verified: false,
      indexDetails: existing,
      remainingDuplicates: duplicateGroups.length,
      message: `Index '${existing.name}' exists but has invalid flags: unique=${Boolean(existing.unique)}, sparse=${Boolean(existing.sparse)}. Expected unique=true, sparse=true.`,
    };
  }

  if (duplicateGroups.length > 0) {
    return {
      verified: false,
      indexDetails: existing,
      remainingDuplicates: duplicateGroups.length,
      message: `Index exists, but ${duplicateGroups.length} duplicate groups remain in the collection.`,
    };
  }

  return {
    verified: true,
    indexDetails: existing,
    remainingDuplicates: 0,
    message: `Verified: Unique sparse index '${existing.name}' is active and 0 duplicate keys exist.`,
  };
}

async function cliMain(): Promise<void> {
  const args = process.argv.slice(2);
  const isInspect = args.includes('--inspect');
  const isApply = args.includes('--apply');
  const isConfirm = args.includes('--confirm');
  const isVerify = args.includes('--verify');

  if (!isInspect && !isApply && !isVerify) {
    console.log(`
RapidAid Emergency Idempotency Key Migration CLI

Commands:
  --inspect          Perform read-only duplicate inspection and index verification.
  --apply --confirm  Back up duplicate records and create unique sparse index.
  --verify           Verify that the unique sparse index exists and is valid.

Rollback Instructions:
  To drop the index:
    db.emergencies.dropIndex("${INDEX_NAME}")
  To view or restore backed-up records:
    db.${BACKUP_COLLECTION_NAME}.find()
  WARNING: Dropping the index removes database-level duplicate emergency prevention.
`);
    process.exit(0);
  }

  await connectDB();

  try {
    if (isInspect) {
      console.log('\n--- Inspecting Emergency Idempotency Keys ---');
      const report = await inspectDuplicates();
      console.log(`Index exists: ${report.indexStatus.exists} (unique=${report.indexStatus.isUnique}, sparse=${report.indexStatus.isSparse})`);
      console.log(`Duplicate groups found: ${report.duplicateGroupsCount}`);
      console.log(`Total documents affected: ${report.totalAffectedDocuments}`);
      if (report.groups.length > 0) {
        console.log('\nSample Duplicate Groups:');
        for (const g of report.groups.slice(0, 5)) {
          console.log(`  Key: ${g.idempotencyKey} (${g.count} instances)`);
          console.log(`    Survivor (oldest): ${g.survivingRecordId}`);
          console.log(`    Displaced: ${g.displacedRecordIds.join(', ')}`);
        }
      }
    }

    if (isApply) {
      console.log('\n--- Applying Idempotency Index Migration ---');
      const outcome = await applyMigration({ confirmed: isConfirm });
      console.log(`Backup completed: ${outcome.backedUpCount} records backed up to '${BACKUP_COLLECTION_NAME}'`);
      console.log(`Deduplication completed: ${outcome.unsetCount} records unlinked`);
      console.log(`Index creation completed: ${outcome.indexCreated}`);
    }

    if (isVerify) {
      console.log('\n--- Verifying Index Metadata ---');
      const verification = await verifyIndex();
      console.log(verification.message);
      if (verification.indexDetails) {
        console.log(JSON.stringify(verification.indexDetails, null, 2));
      }
      if (!verification.verified) {
        process.exitCode = 1;
      }
    }
  } finally {
    await disconnectDB();
  }
}

// Auto-run if executed directly as entrypoint
if (process.argv[1]?.endsWith('migrate-idempotency-index.ts') || process.argv[1]?.endsWith('migrate-idempotency-index.js')) {
  cliMain().catch((err) => {
    console.error('Migration CLI encountered a fatal error:', err);
    process.exit(1);
  });
}
