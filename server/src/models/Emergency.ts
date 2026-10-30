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
 * Safely verifies or creates the unique sparse index on Emergency.idempotencyKey.
 *
 * CRITICAL SAFETY RULES:
 * 1. Never destructively mutates or $unsets historical emergency records at boot.
 * 2. If legacy duplicate keys exist, logs an actionable warning and reports DUPLICATES_DETECTED
 *    without attempting createIndex (which would fail anyway).
 * 3. Rejects existing indexes that lack both unique: true and sparse: true.
 * 4. Logs all failures explicitly; never swallows errors silently.
 */
export async function ensureEmergencyIdempotencyIndex(): Promise<EnsureIndexResult> {
  try {
    const indexes = await Emergency.collection.indexes();
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

    // Inspect historical duplicates without modifying records
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

    // Safe to create unique sparse index
    await Emergency.collection.createIndex(
      { idempotencyKey: 1 },
      { unique: true, sparse: true, background: true, name: 'idempotencyKey_1' },
    );

    emergencyIdempotencyIndexReady = true;
    logger.info('Unique sparse index on Emergency.idempotencyKey created successfully');
    return { ready: true, status: 'CREATED' };
  } catch (err: unknown) {
    emergencyIdempotencyIndexReady = false;
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Failed to initialize Emergency.idempotencyKey index; deduplication degraded');
    return { ready: false, status: 'FAILED', details: msg };
  }
}
