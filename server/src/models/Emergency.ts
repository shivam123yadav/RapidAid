import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { logger } from '../config/logger.js';
import {
  ATTACHMENT_MIME_TYPES,
  EMERGENCY_SOURCES,
  EMERGENCY_STATUSES,
  INCIDENT_TYPES,
  MAX_ATTACHMENTS_PER_EMERGENCY,
  MAX_ATTACHMENT_BYTES,
  PRIORITIES,
} from '../validation/constants.js';

const timelineEntrySchema = new Schema(
  {
    status: { type: String, enum: EMERGENCY_STATUSES, required: true },
    timestamp: { type: Date, required: true },
    note: { type: String },
  },
  { _id: false },
);

const aiRecommendationSchema = new Schema(
  {
    ambulanceId: { type: String },
    ambulanceScore: { type: Number },
    hospitalId: { type: String },
    hospitalScore: { type: Number },
    reasoning: { type: [String], default: [] },
  },
  { _id: false },
);

const attachmentSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    mimeType: { type: String, required: true, enum: ATTACHMENT_MIME_TYPES },
    /** Decoded byte size (not the base64 payload length). */
    size: { type: Number, required: true, min: 1, max: MAX_ATTACHMENT_BYTES },
    /** `data:image/jpeg;base64,…` — rendered inline by the console. */
    dataUrl: { type: String, required: true },
    uploadedAt: { type: Date, required: true },
  },
  { _id: false },
);

const emergencySchema = new Schema(
  {
    _id: { type: String, required: true }, // EMG-20481
    citizenId: { type: String, index: true },
    assignedDispatcher: { type: String, index: true },
    assignedCrewIds: { type: [String], default: [], index: true },
    status: { type: String, enum: EMERGENCY_STATUSES, required: true, default: 'REPORTED', index: true },
    priority: { type: String, enum: PRIORITIES, required: true, default: 'MEDIUM', index: true },
    assignedCrew: { type: [String], default: undefined },
    destinationHospital: { type: String, index: true },
    hospitalReservationId: { type: String, index: true },
    incidentType: { type: String, enum: INCIDENT_TYPES, required: true },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String },
    },
    source: { type: String, enum: EMERGENCY_SOURCES, required: true },
    description: { type: String, required: true },
    victimCount: { type: Number, required: true, default: 1, min: 0 },
    reportedAt: { type: Date, required: true, index: true },
    updatedAt: { type: Date, required: true },
    assignedAmbulance: { type: String, index: true },
    ambulanceClaimToken: { type: String },
    eta: { type: Number },
    timeline: { type: [timelineEntrySchema], default: [] },
    attachments: {
      type: [attachmentSchema],
      default: [],
      validate: {
        validator: (value: unknown[]) => value.length <= MAX_ATTACHMENTS_PER_EMERGENCY,
        message: `An emergency can hold at most ${MAX_ATTACHMENTS_PER_EMERGENCY} photos`,
      },
    },
    greenCorridorActive: { type: Boolean, default: false, index: true },
    greenCorridorActivatedAt: { type: Date },
    greenCorridorActivatedBy: { type: String, index: true },
    overrideCount: { type: Number, default: 0, min: 0 },
    aiRecommendations: { type: aiRecommendationSchema },
    idempotencyKey: { type: String, unique: true, sparse: true, index: true },
    /** Associated VoiceReport ID, enforced unique so one VoiceReport cannot create multiple emergencies. */
    voiceReportId: { type: String, unique: true, sparse: true },
    /** Stable operation ID during voice confirmation. */
    confirmationOperationId: { type: String, unique: true, sparse: true },
  },
  baseSchemaOptions,
);

export type EmergencyDoc = InferSchemaType<typeof emergencySchema>;
export const Emergency: Model<EmergencyDoc> = model<EmergencyDoc>('Emergency', emergencySchema);

let emergencyIdempotencyIndexReady = false;

/** Returns whether the database-level unique sparse index on Emergency.idempotencyKey is active. */
export function isEmergencyIdempotencyIndexReady(): boolean {
  return emergencyIdempotencyIndexReady;
}

/** Explicitly sets readiness state (used in testing and maintenance verification). */
export function setEmergencyIdempotencyIndexReady(ready: boolean): void {
  emergencyIdempotencyIndexReady = ready;
}

export interface EnsureIndexResult {
  ready: boolean;
  status: 'EXISTS' | 'CREATED' | 'DUPLICATES_DETECTED' | 'INVALID_EXISTING_INDEX' | 'FAILED';
  details?: string;
  duplicateCount?: number;
}

/**
 * Ensures the `emergencies` collection exists in MongoDB before index operations.
 * Safely handles fresh databases and concurrent creation across multi-instance startups.
 */
export async function ensureEmergencyCollection(): Promise<void> {
  const nativeDb = Emergency.db?.db;
  if (!nativeDb) {
    throw new Error('Database connection is not available; cannot ensure Emergency collection exists');
  }

  const collName = Emergency.collection.collectionName;
  const collections = await nativeDb
    .listCollections({ name: collName }, { nameOnly: true })
    .toArray();

  if (collections.length === 0) {
    try {
      await nativeDb.createCollection(collName);
      logger.info({ collection: collName }, 'Created Emergency collection on fresh database');
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      const codeName = (err as { codeName?: string })?.codeName;
      const msg = err instanceof Error ? err.message : String(err);
      // MongoDB code 48 is NamespaceExists (concurrent collection creation race)
      if (
        code === 48 ||
        codeName === 'NamespaceExists' ||
        /collection.*already exists|namespace.*already exists/i.test(msg)
      ) {
        logger.debug(
          { collection: collName },
          'Emergency collection was created concurrently by another startup process',
        );
      } else {
        throw err;
      }
    }
  }
}

/**
 * Safely verifies or creates the unique sparse index on Emergency.idempotencyKey.
 *
 * CRITICAL SAFETY RULES:
 * 1. Ensures the collection exists before attempting index inspection or creation.
 * 2. Safely handles concurrent startup and MongoDB namespace-already-exists errors.
 * 3. Never destructively mutates or $unsets historical emergency records at boot.
 * 4. If legacy duplicate keys exist, logs an actionable warning and reports DUPLICATES_DETECTED
 *    without attempting createIndex (which would fail anyway).
 * 5. Rejects existing indexes that lack both unique: true and sparse: true.
 * 6. Explicitly verifies index presence and properties before reporting successful initialization.
 * 7. Logs all failures explicitly; never swallows errors silently.
 */
export async function ensureEmergencyIdempotencyIndex(): Promise<EnsureIndexResult> {
  try {
    // 1. Ensure collection exists before inspecting or creating indexes
    await ensureEmergencyCollection();

    // 2. Fetch existing indexes safely (resilient to namespace race conditions)
    let indexes: Array<{ key?: unknown; name?: string; unique?: boolean; sparse?: boolean }>;
    try {
      indexes = await Emergency.collection.indexes();
    } catch (indexErr: unknown) {
      const code = (indexErr as { code?: number })?.code;
      const msg = indexErr instanceof Error ? indexErr.message : String(indexErr);
      if (code === 26 || /ns does not exist/i.test(msg)) {
        await ensureEmergencyCollection();
        indexes = [];
      } else {
        throw indexErr;
      }
    }

    const existingIndex = indexes.find(
      (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
    );

    if (existingIndex) {
      if (existingIndex.unique === true && existingIndex.sparse === true) {
        emergencyIdempotencyIndexReady = true;
        logger.info(
          { indexName: existingIndex.name },
          'Unique sparse index on Emergency.idempotencyKey is verified and active',
        );
        return { ready: true, status: 'EXISTS' };
      } else {
        emergencyIdempotencyIndexReady = false;
        logger.error(
          { existingIndex },
          'Emergency.idempotencyKey index exists but lacks required unique=true and sparse=true flags; duplicate protection degraded',
        );
        return {
          ready: false,
          status: 'INVALID_EXISTING_INDEX',
          details: `Index exists with unique=${Boolean(existingIndex.unique)}, sparse=${Boolean(existingIndex.sparse)}; expected unique=true, sparse=true`,
        };
      }
    }

    // 3. Inspect historical duplicates without modifying records
    const duplicates = await Emergency.aggregate([
      { $match: { idempotencyKey: { $exists: true, $ne: null } } },
      { $group: { _id: '$idempotencyKey', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
    ]);

    if (duplicates.length > 0) {
      emergencyIdempotencyIndexReady = false;
      const sample = duplicates.slice(0, 3).map((d) => ({
        key: d._id,
        count: d.count,
        ids: (d.ids as string[]).slice(0, 3),
      }));
      logger.warn(
        { duplicateCount: duplicates.length, sample },
        'Historical duplicate idempotency keys detected; skipping automatic index creation. Run migration CLI.',
      );
      return {
        ready: false,
        status: 'DUPLICATES_DETECTED',
        duplicateCount: duplicates.length,
        details: `${duplicates.length} duplicate idempotencyKey groups found in collection`,
      };
    }

    // 4. Safe to create unique sparse index
    await Emergency.collection.createIndex(
      { idempotencyKey: 1 },
      { unique: true, sparse: true, background: true, name: 'idempotencyKey_1' },
    );

    // 5. Explicitly verify the index was created and is active with required flags
    const postCreationIndexes = await Emergency.collection.indexes();
    const verifiedIndex = postCreationIndexes.find(
      (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
    );

    if (!verifiedIndex || verifiedIndex.unique !== true || verifiedIndex.sparse !== true) {
      emergencyIdempotencyIndexReady = false;
      logger.error(
        { verifiedIndex },
        'Emergency.idempotencyKey index creation verification failed; index not found with required unique and sparse flags',
      );
      return {
        ready: false,
        status: 'FAILED',
        details: 'Index creation completed but subsequent verification failed to confirm active unique sparse index',
      };
    }

    emergencyIdempotencyIndexReady = true;
    logger.info(
      { indexName: verifiedIndex.name },
      'Unique sparse index on Emergency.idempotencyKey created and verified successfully',
    );
    return { ready: true, status: 'CREATED' };
  } catch (err: unknown) {
    emergencyIdempotencyIndexReady = false;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to initialize Emergency.idempotencyKey index; deduplication degraded');
    return { ready: false, status: 'FAILED', details: msg };
  }
}
