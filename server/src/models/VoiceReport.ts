import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import {
  HOSPITAL_ROUTING_REASONS,
  INCIDENT_TYPES,
  LOCATION_SOURCES,
  LOCATION_STATUSES,
  TRANSCRIPTION_STATUSES,
  VOICE_AUDIO_STATUSES,
  VOICE_DISPATCH_STATUSES,
  VOICE_REPORT_STATUSES,
} from '../validation/constants.js';

const extractedDataSchema = new Schema(
  {
    incidentType: { type: String, enum: [...INCIDENT_TYPES, undefined] },
    location: { type: String },
    victimCount: { type: Number, min: 0 },
    description: { type: String },
  },
  { _id: false },
);

/**
 * Metadata for the stored recording. The bytes themselves live on disk (see
 * `voiceAudioStorage`), never inside the document — an 8 MB blob would blow
 * through the 16 MB BSON limit and make every report query expensive.
 */
const audioSchema = new Schema(
  {
    /** Opaque server-generated key; the only way to read the bytes back. */
    storageKey: { type: String, index: true },
    filename: { type: String },
    /** The real container the browser produced, e.g. `audio/webm`. */
    mimeType: { type: String },
    size: { type: Number, min: 0 },
    durationSeconds: { type: Number, min: 0 },
    /** SHA-256 of the stored bytes, for integrity checks. */
    checksum: { type: String },
    status: { type: String, enum: VOICE_AUDIO_STATUSES, default: 'STORED' },
  },
  { _id: false },
);

const transcriptionSchema = new Schema(
  {
    text: { type: String, default: '' },
    provider: { type: String },
    status: { type: String, enum: TRANSCRIPTION_STATUSES, default: 'PENDING' },
    confidence: { type: Number, min: 0, max: 100 },
    durationMs: { type: Number, min: 0 },
    error: { type: String },
    createdAt: { type: Date },
  },
  { _id: false },
);

const extractedInformationSchema = new Schema(
  {
    emergencyType: { type: String, enum: INCIDENT_TYPES },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    description: { type: String },
    injuredPeople: { type: Number, min: 0 },
    /** The place the caller named, verbatim. Never invented. */
    spokenLocation: { type: String },
    landmarks: { type: [String], default: [] },
    city: { type: String },
    state: { type: String },
    dispatchHints: { type: [String], default: [] },
  },
  { _id: false },
);

const locationSchema = new Schema(
  {
    latitude: { type: Number },
    longitude: { type: Number },
    address: { type: String },
    spokenLocation: { type: String },
    /** SPOKEN | DEVICE | MANUAL | UNRESOLVED — never faked. */
    source: { type: String, enum: LOCATION_SOURCES, default: 'UNRESOLVED', index: true },
    status: { type: String, enum: LOCATION_STATUSES, default: 'UNRESOLVED' },
    /** Radius of confidence in metres, when the match was approximate. */
    accuracy: { type: Number, min: 0 },
    provider: { type: String },
  },
  { _id: false },
);

const hospitalRoutingSchema = new Schema(
  {
    hospitalId: { type: String, index: true },
    hospitalName: { type: String },
    distance: { type: Number, min: 0 },
    etaSeconds: { type: Number, min: 0 },
    routingReason: { type: String, enum: [...HOSPITAL_ROUTING_REASONS, undefined] },
    selectedAt: { type: Date },
  },
  { _id: false },
);

const voiceReportSchema = new Schema(
  {
    _id: { type: String, required: true }, // VR-001
    ownerId: { type: String, index: true },
    hospitalId: { type: String, index: true },
    // Not `required`: a report whose transcription failed legitimately has no
    // transcript yet, and the recording must still be stored and reviewable.
    transcript: { type: String, default: '' },
    /** Original transcript captured from citizen voice or edited before submission. */
    originalTranscript: { type: String, default: '' },
    /** Normalized extraction text used for deterministic rule-based NLP extraction. */
    normalizedExtractionText: { type: String, default: '' },
    extractedData: { type: extractedDataSchema, required: true, default: () => ({}) },
    confidence: { type: Number, required: true, min: 0, max: 100 },
    status: { type: String, enum: VOICE_REPORT_STATUSES, required: true, default: 'DRAFT' },
    createdAt: { type: Date, required: true, index: true },
    /** Stored original recording (metadata only — bytes live on disk). */
    audio: { type: audioSchema },
    transcription: { type: transcriptionSchema },
    extractedInformation: { type: extractedInformationSchema },
    /** Resolved coordinates plus how they were obtained. */
    location: { type: locationSchema },
    /** The hospital this report was routed to, and why. */
    hospitalRouting: { type: hospitalRoutingSchema },
    dispatchStatus: {
      type: String,
      enum: VOICE_DISPATCH_STATUSES,
      default: 'AWAITING_LOCATION',
      index: true,
    },
    /** Set when the draft produced an emergency, for traceability. */
    emergencyId: { type: String },
    /** Stable operation ID during confirmation lifecycle (DRAFT -> CONFIRMING -> CONFIRMED). */
    confirmationOperationId: { type: String },
    /** Timestamp when confirmation process claimed this report, for stale lock recovery. */
    confirmationStartedAt: { type: Date, index: true },
  },
  baseSchemaOptions,
);

voiceReportSchema.index({ ownerId: 1, createdAt: -1 });
voiceReportSchema.index({ emergencyId: 1 }, { unique: true, sparse: true });
voiceReportSchema.index({ confirmationOperationId: 1 }, { unique: true, sparse: true });

export type VoiceReportDoc = InferSchemaType<typeof voiceReportSchema>;
export const VoiceReport: Model<VoiceReportDoc> = model<VoiceReportDoc>('VoiceReport', voiceReportSchema);
