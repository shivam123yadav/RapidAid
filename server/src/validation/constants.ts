/** Shared domain constants mirroring the frontend types in src/types/index.ts. */

export const ROLES = [
  'CITIZEN',
  'AMBULANCE_CREW',
  'DISPATCHER',
  'HOSPITAL_STAFF',
  'SUPERVISOR',
  'ANALYST',
  'AUDITOR',
  'ADMIN',
] as const;
export type Role = (typeof ROLES)[number];

// ── Ambulance RBAC bundles ───────────────────────────────────────────────
// Single source of truth for ambulance access; mirrored by
// src/lib/permissions.ts so the UI never offers an action the API rejects.

/** Read the full fleet. Crew additionally see only their own unit. */
export const AMBULANCE_FLEET_READERS: Role[] = [
  'AMBULANCE_CREW',
  'DISPATCHER',
  'SUPERVISOR',
  'ANALYST',
  'AUDITOR',
  'ADMIN',
];

/** Read-only oversight + analysts (explicitly *not* crew/dispatch writes). */
export const AMBULANCE_READ_ONLY: Role[] = ['ANALYST', 'AUDITOR'];

/** Hospital staff: limited, arrival-relevant view — never the whole fleet. */
export const AMBULANCE_LIMITED_VIEW: Role[] = ['HOSPITAL_STAFF'];

/** Create / edit / assign ambulances (supervisor elevated per org structure). */
export const AMBULANCE_MANAGERS: Role[] = ['ADMIN', 'SUPERVISOR'];

/** Operational heartbeat on a specific unit (crew restricted to their own). */
export const AMBULANCE_TELEMETRY: Role[] = [
  'AMBULANCE_CREW',
  'DISPATCHER',
  'SUPERVISOR',
  'ADMIN',
];

export const EMERGENCY_STATUSES = [
  'REPORTED',
  'TRIAGED',
  'DISPATCHING',
  'AMBULANCE_ASSIGNED',
  'EN_ROUTE',
  'AT_SCENE',
  'PATIENT_ONBOARD',
  'EN_ROUTE_TO_HOSPITAL',
  'AT_HOSPITAL',
  'COMPLETED',
  'CANCELLED',
] as const;
export type EmergencyStatus = (typeof EMERGENCY_STATUSES)[number];

/**
 * Forward-only status progression. Moving ahead one-or-more steps is allowed
 * (a dispatcher may skip TRIAGED), CANCELLED is allowed from any active state,
 * and terminal states are immutable. Same-state updates are rejected (400).
 */
export const EMERGENCY_STATUS_ORDER: EmergencyStatus[] = [
  'REPORTED',
  'TRIAGED',
  'DISPATCHING',
  'AMBULANCE_ASSIGNED',
  'EN_ROUTE',
  'AT_SCENE',
  'PATIENT_ONBOARD',
  'EN_ROUTE_TO_HOSPITAL',
  'AT_HOSPITAL',
  'COMPLETED',
];

export const TERMINAL_STATUSES: EmergencyStatus[] = ['COMPLETED', 'CANCELLED'];

export function canTransition(from: EmergencyStatus, to: EmergencyStatus): boolean {
  if (TERMINAL_STATUSES.includes(from)) return false;
  if (to === 'CANCELLED') return true;
  const fromIdx = EMERGENCY_STATUS_ORDER.indexOf(from);
  const toIdx = EMERGENCY_STATUS_ORDER.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return false;
  return toIdx > fromIdx;
}

export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Incident vocabulary shared by the report form, zod schemas, the mongoose
 * enums, voice extraction and the analytics labels. Order drives the order of
 * the "Incident type" dropdown, so related emergencies are grouped: traffic →
 * medical → special-care → other trauma → fire/hazmat → environmental.
 */
export const INCIDENT_TYPES = [
  'VEHICLE_COLLISION',
  'MEDICAL_EMERGENCY',
  'FALL_INJURY',
  'CARDIAC_ARREST',
  'STROKE',
  'RESPIRATORY_DISTRESS',
  'SEIZURE',
  'POISONING',
  'BURN',
  'DROWNING',
  'ELECTROCUTION',
  'OBSTETRIC_EMERGENCY',
  'ASSAULT',
  'FIRE',
  'EXPLOSION',
  'GAS_LEAK',
  'STRUCTURAL_COLLAPSE',
  'MASS_CASUALTY',
  'OTHER',
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

/** Display labels used by the analytics pie chart (matches previous mock labels). */
export const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  VEHICLE_COLLISION: 'Vehicle Collision',
  MEDICAL_EMERGENCY: 'Medical Emergency',
  FALL_INJURY: 'Fall Injury',
  CARDIAC_ARREST: 'Cardiac Arrest',
  STROKE: 'Stroke',
  RESPIRATORY_DISTRESS: 'Respiratory Distress',
  SEIZURE: 'Seizure',
  POISONING: 'Poisoning / Overdose',
  BURN: 'Burn',
  DROWNING: 'Drowning',
  ELECTROCUTION: 'Electrocution',
  OBSTETRIC_EMERGENCY: 'Obstetric Emergency',
  ASSAULT: 'Assault / Violence',
  FIRE: 'Fire',
  EXPLOSION: 'Explosion',
  GAS_LEAK: 'Gas Leak',
  STRUCTURAL_COLLAPSE: 'Structural Collapse',
  MASS_CASUALTY: 'Mass Casualty Incident',
  OTHER: 'Other',
};

export const EMERGENCY_SOURCES = ['CITIZEN_REPORT', 'AI_VISION', 'VOICE_REPORT', 'DISPATCHER'] as const;
export type EmergencySource = (typeof EMERGENCY_SOURCES)[number];

/**
 * Image attachments on an emergency report. Reports travel as JSON (the API
 * contract is JSON in / JSON out), so photos are sent as base64 data URLs and
 * stored inline on the document — no object storage dependency.
 */
export const ATTACHMENT_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type AttachmentMimeType = (typeof ATTACHMENT_MIME_TYPES)[number];

/**
 * Max photos per report and max size of a single photo (2 MB).
 *
 * 4 × 2 MB = 8 MB of raw image, ~10.7 MB once base64-encoded, which keeps a
 * fully-loaded report comfortably under MongoDB's 16 MB per-document limit
 * (photos are stored inline on the Emergency document).
 */
export const MAX_ATTACHMENTS_PER_EMERGENCY = 4;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/**
 * Body-parser cap for JSON requests carrying emergency photos. Base64 inflates
 * by ~4/3, so the worst legal report (~10.7 MB) plus field overhead fits well
 * inside this; zod then rejects anything over the real per-report limits above.
 *
 * Applied to `POST /api/emergencies` only — see `app.ts`.
 */
export const EMERGENCY_UPLOAD_BODY_LIMIT = '16mb';

/**
 * Body-parser cap for every other JSON route. The largest non-photo request in
 * the system is an ambulance crew roster or a green-corridor note, both far
 * below 1 MB, so anything larger is a mistake or an attack and is rejected
 * before it is buffered in full.
 */
export const DEFAULT_JSON_BODY_LIMIT = '256kb';

export const AMBULANCE_STATUSES = [
  'AVAILABLE',
  'RESERVED',
  'ASSIGNED',
  'EN_ROUTE',
  'AT_SCENE',
  'TRANSPORTING',
  'AT_HOSPITAL',
  'MAINTENANCE',
  'OFFLINE',
] as const;
export type AmbulanceStatus = (typeof AMBULANCE_STATUSES)[number];

export const HOSPITAL_STATUSES = ['OPERATIONAL', 'DEGRADED', 'OFFLINE'] as const;
export type HospitalStatus = (typeof HOSPITAL_STATUSES)[number];
export const CAPACITY_STATUSES = ['AVAILABLE', 'LIMITED', 'FULL'] as const;
export type CapacityStatus = (typeof CAPACITY_STATUSES)[number];

export const HOSPITAL_RESOURCE_TYPES = [
  'EMERGENCY_ACCEPTANCE',
  'GENERAL_BED',
  'ICU_BED',
  'TRAUMA_BAY',
] as const;
export type HospitalResourceType = (typeof HOSPITAL_RESOURCE_TYPES)[number];

export const RESERVATION_STATUSES = [
  'PENDING',
  'CONFIRMED',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
  'RELEASED',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Master-data vocabularies for onboarding. Declared once here so the model, the
 * API validation layer and the form share a single source of truth instead of
 * each hard-coding its own strings.
 */
export const HOSPITAL_TYPES = ['GOVERNMENT', 'PRIVATE', 'MUNICIPAL', 'NGO', 'MILITARY', 'MULTISPECIALITY', 'SPECIALTY'] as const;
export type HospitalType = (typeof HOSPITAL_TYPES)[number];

/**
 * Lifecycle of a facility's REGISTRATION, kept separate from `status` (the
 * operational switch): the Administrator onboards a facility and a Supervisor
 * reviews it, so approval is a distinct decision from activation. `active`
 * (Administrator lifecycle) remains the dispatch-eligibility switch.
 */
export const HOSPITAL_VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REJECTED'] as const;
export type HospitalVerificationStatus = (typeof HOSPITAL_VERIFICATION_STATUSES)[number];

/** Decisions a reviewer (hospital:approve) may record against a registration. */
export const HOSPITAL_REVIEW_DECISIONS = ['APPROVE', 'REJECT'] as const;
export type HospitalReviewDecision = (typeof HOSPITAL_REVIEW_DECISIONS)[number];

export const DETECTION_STATUSES = [
  'PENDING_REVIEW',
  'CONFIRMED',
  'REJECTED',
  'CONVERTED_TO_INCIDENT',
] as const;
export type DetectionStatus = (typeof DETECTION_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = ['CRITICAL', 'WARNING', 'INFO', 'SUCCESS'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Lifecycle of a voice report. `REJECTED` is set when a human reviewer
 * (dispatcher/supervisor) explicitly rejects a DRAFT — the recording and
 * transcript are retained as evidence, but no emergency is created from it.
 */
export const VOICE_REPORT_STATUSES = ['RECORDING', 'PROCESSING', 'DRAFT', 'CONFIRMING', 'CONFIRMED', 'REJECTED', 'FAILED'] as const;
export type VoiceReportStatus = (typeof VOICE_REPORT_STATUSES)[number];

/**
 * Lifecycle of the stored audio artefact for one voice report.
 *
 * `LOST` means the report still references a recording that the storage layer no
 * longer holds — typically because the database outlived the volume it points
 * at. It is recorded explicitly instead of being papered over, so the API can
 * answer honestly ("this recording is no longer stored") rather than advertising
 * a recording that cannot be played. The original bytes are never re-created or
 * substituted with a placeholder.
 */
export const VOICE_AUDIO_STATUSES = ['STORED', 'REJECTED', 'DELETED', 'LOST'] as const;
export type VoiceAudioStatus = (typeof VOICE_AUDIO_STATUSES)[number];

/** Lifecycle of the transcription attempt. */
export const TRANSCRIPTION_STATUSES = ['PENDING', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

/** Where the coordinates on a voice report came from. Never faked. */
export const LOCATION_SOURCES = ['SPOKEN', 'DEVICE', 'MANUAL', 'UNRESOLVED'] as const;
export type LocationSource = (typeof LOCATION_SOURCES)[number];

/** Resolution state of a voice report's location. */
export const LOCATION_STATUSES = ['RESOLVED', 'APPROXIMATE', 'UNRESOLVED'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

/** How the nearest hospital was chosen. */
export const HOSPITAL_ROUTING_REASONS = [
  'NEAREST_ELIGIBLE',
  'NEAREST_WITH_REQUIRED_CAPABILITY',
  'NEAREST_AFTER_CAPACITY_GATING',
  'NO_ELIGIBLE_HOSPITAL',
] as const;
export type HospitalRoutingReason = (typeof HOSPITAL_ROUTING_REASONS)[number];

/** Dispatch hand-off state after hospital selection. */
export const VOICE_DISPATCH_STATUSES = [
  'AWAITING_LOCATION',
  'AWAITING_REVIEW',
  'DISPATCH_PENDING',
  'DISPATCHER_NOTIFIED',
  'BLOCKED_NO_HOSPITAL',
] as const;
export type VoiceDispatchStatus = (typeof VOICE_DISPATCH_STATUSES)[number];

/**
 * Audio containers the Voice page may upload. These are exactly what
 * `MediaRecorder` can produce on a modern browser (WebM/Opus, Ogg/Opus,
 * MP4/AAC) plus the WAV/MP3 paths used by the manual "attach an audio file"
 * fallback. The server validates the *bytes* against these signatures, so a
 * renamed `.exe` cannot pass as audio.
 */
export const VOICE_AUDIO_MIME_TYPES = [
  'audio/webm',
  'audio/x-webm',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
] as const;
export type VoiceAudioMimeType = (typeof VOICE_AUDIO_MIME_TYPES)[number];

/**
 * Hard ceiling on an uploaded recording: 8 MB.
 *
 * `MediaRecorder` emits roughly 8–16 kB/s of Opus, so 8 MB is ~8–16 minutes —
 * comfortably above the 5-minute client-side recording cap, while keeping the
 * request small enough to process synchronously. The audio is stored on disk
 * (never inside MongoDB), so this bound is about request sanity, not the
 * 16 MB document limit.
 */
export const MAX_VOICE_AUDIO_BYTES = 8 * 1024 * 1024;

/** Canonical prefix for stored voice recordings. */
export const VOICE_AUDIO_FILENAME_PREFIX = 'voice-emergency-';


export const ID_PREFIXES = {
  user: 'USR',
  emergency: 'EMG',
  ambulance: 'AMB',
  hospital: 'HOSP',
  detection: 'DET',
  notification: 'N',
  audit: 'A',
  voiceReport: 'VR',
  shift: 'SH',
  maintenance: 'MNT',
  camera: 'CAM',
  report: 'RPT',
} as const;
