export type UserRole = 'CITIZEN' | 'AMBULANCE_CREW' | 'DISPATCHER' | 'HOSPITAL_STAFF' | 'SUPERVISOR' | 'ANALYST' | 'AUDITOR' | 'ADMIN';

export type EmergencyStatus = 'REPORTED' | 'TRIAGED' | 'DISPATCHING' | 'AMBULANCE_ASSIGNED' | 'EN_ROUTE' | 'AT_SCENE' | 'PATIENT_ONBOARD' | 'EN_ROUTE_TO_HOSPITAL' | 'AT_HOSPITAL' | 'COMPLETED' | 'CANCELLED';

export type EmergencyPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

/** Mirrors INCIDENT_TYPES in server/src/validation/constants.ts (server re-validates). */
export type IncidentType =
  | 'VEHICLE_COLLISION'
  | 'MEDICAL_EMERGENCY'
  | 'FALL_INJURY'
  | 'CARDIAC_ARREST'
  | 'STROKE'
  | 'RESPIRATORY_DISTRESS'
  | 'SEIZURE'
  | 'POISONING'
  | 'BURN'
  | 'DROWNING'
  | 'ELECTROCUTION'
  | 'OBSTETRIC_EMERGENCY'
  | 'ASSAULT'
  | 'FIRE'
  | 'EXPLOSION'
  | 'GAS_LEAK'
  | 'STRUCTURAL_COLLAPSE'
  | 'MASS_CASUALTY'
  | 'OTHER';

export type AmbulanceStatus = 'AVAILABLE' | 'RESERVED' | 'ASSIGNED' | 'EN_ROUTE' | 'AT_SCENE' | 'TRANSPORTING' | 'AT_HOSPITAL' | 'MAINTENANCE' | 'OFFLINE';

export type HospitalStatus = 'OPERATIONAL' | 'DEGRADED' | 'OFFLINE';

export type CapacityStatus = 'AVAILABLE' | 'LIMITED' | 'FULL';

export type SystemStatus = 'OPERATIONAL' | 'DEGRADED' | 'OFFLINE';

export type NotificationCategory = 'CRITICAL' | 'WARNING' | 'INFO' | 'SUCCESS';

export type DetectionStatus = 'PENDING_REVIEW' | 'CONFIRMED' | 'REJECTED' | 'CONVERTED_TO_INCIDENT';

export type ThemeMode = 'light' | 'dark' | 'system';

export interface GeoLocation {
  lat: number;
  lng: number;
  address?: string;
}

export interface Emergency {
  id: string;
  status: EmergencyStatus;
  priority: EmergencyPriority;
  incidentType: IncidentType;
  location: GeoLocation;
  source: 'CITIZEN_REPORT' | 'AI_VISION' | 'VOICE_REPORT' | 'DISPATCHER';
  description: string;
  victimCount: number;
  reportedAt: string;
  updatedAt: string;
  assignedAmbulance?: string;
  assignedCrew?: string[];
  destinationHospital?: string;
  hospitalReservationId?: string;
  eta?: number;
  timeline: TimelineEntry[];
  /** Photos captured with the report, stored inline as base64 data URLs. */
  attachments?: EmergencyAttachment[];
  /**
   * How many photos the report carries.
   *
   * List responses (`GET /api/emergencies`) strip the base64 payloads and report
   * only this count plus the attachment metadata, because an incident can hold
   * ~10 MB of photos and a list is fetched far more often than a record. Fetch
   * `GET /api/emergencies/:id` — the same authorization applies — to view them.
   */
  attachmentCount?: number;
  aiRecommendations?: AIRecommendation;
  /**
   * The originating voice report, when the caller is in scope for it. Derived
   * server-side per request, so it reflects *this* caller's permissions rather
   * than whatever the list endpoint happened to return.
   */
  voiceReport?: EmergencyVoiceReportRef | null;
}

/** A photo attached to a report (mirrors attachmentSchema on the server). */
export interface EmergencyAttachment {
  name: string;
  mimeType: AttachmentMimeType;
  /** Decoded size in bytes (not the base64 payload length). */
  size: number;
  dataUrl: string;
  uploadedAt: string;
}

export type AttachmentMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

/**
 * A photo as sent by the client. The API stamps `uploadedAt` on save, so the
 * request shape carries no timestamp — only the response shape does.
 */
export type EmergencyAttachmentInput = Omit<EmergencyAttachment, 'uploadedAt'>;

/** POST /api/emergencies body: client-settable fields, photos optional. */
export type CreateEmergencyRequest = Omit<Partial<Emergency>, 'attachments'> & {
  attachments?: EmergencyAttachmentInput[];
};

/** Where an incident originated (mirrors the server's EMERGENCY_SOURCES). */
export type EmergencySource = Emergency['source'];

export interface TimelineEntry {
  status: EmergencyStatus;
  timestamp: string;
  note?: string;
}

export interface AIRecommendation {
  ambulanceId?: string;
  ambulanceScore?: number;
  hospitalId?: string;
  hospitalScore?: number;
  reasoning: string[];
}

export interface Ambulance {
  id: string;
  status: AmbulanceStatus;
  location: GeoLocation;
  speed: number;
  heading: number;
  crew: CrewMember[];
  capabilities: string[];
  equipment: string[];
  currentEmergency?: string;
  destinationHospital?: string;
  eta?: number;
  lastUpdated: string;
  isSimulated?: boolean;
  telemetrySource?: 'HARDWARE_GPS' | 'SIMULATED';
  activeRoute?: ActiveRoute;
}

export interface ActiveRoute {
  coordinates: [number, number][];
  distanceMeters: number;
  durationSeconds: number;
  calculatedAt: string;
  destinationType: 'INCIDENT' | 'HOSPITAL';
  destinationId: string;
  destinationLocation?: GeoLocation;
  routeOrigin?: GeoLocation;
  provider: string;
  status: 'SUCCESS' | 'NO_ROUTE' | 'FAILED' | 'UNAVAILABLE';
  isStale: boolean;
  deviated: boolean;
  deviationDistanceMeters?: number;
}


export interface CrewMember {
  id: string;
  name: string;
  role: string;
  certification: string[];
  /**
   * Linked login for a roster seat. Accepted on writes (manager-only) so a
   * seat can be bound to an account; the API never returns it — see the
   * `userId` strip in the server's crew sub-schema transform.
   */
  userId?: string;
}

/** A crew seat as sent to the API (id is required; userId optional). */
export type CrewMemberInput = CrewMember;

/** POST /api/ambulances body (ADMIN / SUPERVISOR). */
export interface CreateAmbulanceRequest {
  status?: AmbulanceStatus;
  location: GeoLocation;
  capabilities?: string[];
  equipment?: string[];
  crew?: CrewMemberInput[];
}

/** PATCH /api/ambulances/:id body (ADMIN / SUPERVISOR). */
export interface UpdateAmbulanceRequest {
  status?: AmbulanceStatus;
  location?: GeoLocation;
  speed?: number;
  heading?: number;
  eta?: number;
  capabilities?: string[];
  equipment?: string[];
  currentEmergency?: string | null;
  destinationHospital?: string | null;
  crew?: CrewMemberInput[];
}

/** Availability-only status change (ADMIN / SUPERVISOR / DISPATCHER). */
export type AmbulanceAvailability = Extract<AmbulanceStatus, 'AVAILABLE' | 'MAINTENANCE' | 'OFFLINE'>;

export interface Hospital {
  id: string;
  name: string;
  status: HospitalStatus;
  location: GeoLocation;
  emergencyCapacity: CapacityStatus;
  icuCapacity: CapacityStatus;
  traumaAvailable: boolean;
  capabilities: string[];
  incomingAmbulances: number;
  currentLoad: number;
  generalBeds?: number;
  icuBeds?: number;
  traumaCapacity?: CapacityStatus;
  ventilatorAvailability?: CapacityStatus;
  operatingTheatreAvailability?: CapacityStatus;
  specialistAvailability?: CapacityStatus;
  bloodAvailability?: CapacityStatus;
  estimatedWaitingTimeMinutes?: number;
  operationalStatus?: HospitalStatus;
  phone: string;
}

export interface AIDetection {
  id: string;
  cameraId: string;
  cameraLocation: GeoLocation;
  detectedEvent: string;
  confidence: number;
  status: DetectionStatus;
  timestamp: string;
  modelName: string;
  modelVersion: string;
  boundingBoxes: BoundingBox[];
  reviewedBy?: string;
}

export interface BoundingBox {
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface DispatchRecommendation {
  ambulanceId: string;
  score: number;
  eta: number;
  distance: number;
  capabilities: string[];
  reasons: string[];
}

export interface HospitalRecommendation {
  hospitalId: string;
  score: number;
  eta: number;
  distance: number;
  emergencyCapacity: CapacityStatus;
  icuCapacity: CapacityStatus;
  traumaAvailable: boolean;
  reasons: string[];
}

export interface Notification {
  id: string;
  _id?: string;
  eventType?: string;
  category: NotificationCategory;
  title: string;
  message: string;
  timestamp: string;
  read: boolean;
  readAt?: string;
  linkedEmergency?: string;
  linkedResource?: string;
  channels?: string[];
  deliveryStatus?: {
    inApp?: string;
    email?: string;
    sms?: string;
    push?: string;
  };
}

export interface AuditEntry {
  id: string;
  actor: string;
  actorRole: UserRole;
  action: string;
  resource: string;
  resourceId: string;
  timestamp: string;
  requestId: string;
  details?: string;
}

export interface SystemHealth {
  service: string;
  status: SystemStatus;
  latency?: number;
  lastChecked: string;
  details?: string;
}

export interface AnalyticsData {
  emergencyVolume: { date: string; count: number }[];
  responseTimes: { date: string; median: number; p90: number }[];
  incidentTypes: { type: string; count: number }[];
  ambulanceUtilization: { date: string; utilization: number }[];
  hospitalLoad: { hospital: string; load: number }[];
}

export type CameraStatus = 'ONLINE' | 'DEGRADED' | 'OFFLINE';
export interface Camera {
  id: string;
  name: string;
  zone: string;
  location: GeoLocation;
  status: CameraStatus;
  liveEnabled: boolean;
  /** Omitted for live-only viewers without recording/evidence scope. */
  recordingEnabled?: boolean;
  /** Omitted for live-only viewers without recording/evidence scope. */
  retentionDays?: number;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ShiftStatus = 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export interface Shift {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: ShiftStatus;
  crewIds: string[];
  ambulanceId?: string;
  createdBy: string;
  notes?: string;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type MaintenanceSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type MaintenanceStatus = 'OPEN' | 'IN_PROGRESS' | 'APPROVED' | 'RESOLVED' | 'REJECTED';
export interface MaintenanceRequest {
  id: string;
  ambulanceId: string;
  title: string;
  description: string;
  severity: MaintenanceSeverity;
  status: MaintenanceStatus;
  reportedBy: string;
  assignedTo?: string;
  resolution?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export type ReportType = 'INCIDENT_SUMMARY' | 'RESPONSE_PERFORMANCE' | 'FLEET_UTILIZATION' | 'HOSPITAL_CAPACITY' | 'MAINTENANCE' | 'CUSTOM';
export interface ReportSummary {
  totalEmergencies: number;
  activeEmergencies: number;
  completedEmergencies: number;
  cancelledEmergencies: number;
  criticalEmergencies: number;
  totalVictims: number;
  averageVictims: number;
  byPriority: Record<string, number>;
  byStatus: Record<string, number>;
}
export interface ReportRecord {
  id: string;
  title: string;
  reportType: ReportType;
  periodFrom: string;
  periodTo: string;
  status: 'GENERATING' | 'READY' | 'FAILED';
  createdBy: string;
  generatedBy?: string;
  emergencyIds: string[];
  summary: ReportSummary;
  generatedAt?: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreateReportRequest {
  title: string;
  reportType: ReportType;
  periodFrom: string;
  periodTo: string;
}
export interface ReportExportResponse {
  classification: 'SANITIZED' | 'SENSITIVE';
  report: ReportRecord;
  emergencies?: Emergency[];
  exportedAt: string;
  exportedBy: string;
}

export interface GreenCorridorSimulation {
  emergencyId: string;
  route: GeoLocation[];
  baselineETA: number;
  simulatedETA: number;
  timeSaved: number;
  signalsAffected: number;
  status: 'IDLE' | 'SIMULATING' | 'COMPLETE';
}

/** Metadata for the stored original recording. Bytes live on the server. */
export interface VoiceAudioMeta {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  durationSeconds?: number | null;
  status: 'STORED' | 'REJECTED' | 'DELETED';
}

/** Structured facts extracted from a transcript. */
export interface VoiceExtractedInformation {
  emergencyType: IncidentType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  injuredPeople: number | null;
  spokenLocation: string | null;
  landmarks: string[];
  city: string | null;
  state: string | null;
  dispatchHints: string[];
  confidence?: number;
}

/**
 * Where a voice report's coordinates came from. Never faked — an unresolved
 * location is reported as UNRESOLVED rather than guessed.
 */
export interface VoiceLocation {
  resolved: boolean;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  spokenLocation: string | null;
  source: 'SPOKEN' | 'DEVICE' | 'MANUAL' | 'UNRESOLVED';
  status: 'RESOLVED' | 'APPROXIMATE' | 'UNRESOLVED';
  accuracy: number | null;
  provider: string;
  error: string | null;
}

export interface VoiceHospitalSelection {
  hospitalId: string;
  name: string;
  distanceMeters: number;
  etaSeconds: number;
  emergencyCapacity: string;
  icuCapacity: string;
  traumaAvailable: boolean;
  status: string;
  currentLoad: number;
}

export interface VoiceReport {
  id: string;
  transcript: string;
  originalTranscript?: string;
  normalizedExtractionText?: string;
  extractedData: {
    incidentType?: IncidentType;
    location?: string;
    victimCount?: number;
    description?: string;
  };
  confidence: number;
  status: 'RECORDING' | 'PROCESSING' | 'DRAFT' | 'CONFIRMED' | 'FAILED' | 'REJECTED';
  audio?: VoiceAudioMeta;
  transcription?: {
    text: string;
    provider: string;
    status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
    durationMs?: number;
    error?: string | null;
  };
  extractedInformation?: VoiceExtractedInformation;
  location?: VoiceLocation;
  hospitalRouting?: {
    hospitalId: string | null;
    hospitalName?: string | null;
    distance?: number;
    routingReason?: string;
  };
  dispatchStatus?:
    | 'AWAITING_LOCATION'
    | 'DISPATCH_PENDING'
    | 'DISPATCHER_NOTIFIED'
    | 'BLOCKED_NO_HOSPITAL';
  emergencyId?: string;
}

/**
 * Server-derived action flags for one voice report (`capabilities` in the API).
 * The UI renders its controls from these — never from a local role table — so
 * an unauthorized action is not rendered, while the API stays the enforcer.
 */
export interface VoiceReportCapabilities {
  read: boolean;
  listen: boolean;
  transcript: boolean;
  download: boolean;
  confirm: boolean;
  reject: boolean;
  edit: boolean;
  discard: boolean;
  evidence: boolean;
  accessHistory: boolean;
  canPlayRecording: boolean;
  accessLabel: string;
}

/** Metadata-only workspace row: transcript and audio travel on their own endpoints. */
export interface VoiceReportSummary {
  id: string;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  emergencyId: string | null;
  emergencyStatus?: string | null;
  confidence: number | null;
  incidentType?: IncidentType | null;
  locationLabel: string | null;
  victimCount: number | null;
  hospitalId: string | null;
  hospitalName: string | null;
  dispatchStatus?: string | null;
  audio: VoiceAudioMeta | null;
  ownerId?: string | null;
  accessLabel: string;
  capabilities: VoiceReportCapabilities;
}

/**
 * The voice report an emergency was raised from, as attached to
 * `GET /api/emergencies/:id`.
 *
 * Absent or `null` for every caller the authorizer places out of scope, so the
 * UI renders no card at all rather than a disabled one — a hidden control is
 * never the thing standing between a caller and a recording.
 */
export interface EmergencyVoiceReportRef {
  id: string;
  status: string;
  createdAt: string | null;
  accessLabel: string;
  /** Server-derived action flags. Every control in the UI gates on these. */
  capabilities: VoiceReportCapabilities;
}

/** Full report detail: transcript is null when the caller holds no transcript grant. */
export interface VoiceReportDetail extends VoiceReportSummary {
  transcript: string | null;
  transcriptRestricted: boolean;
  extractedData: VoiceReport['extractedData'];
  extractedInformation?: VoiceExtractedInformation | null;
  transcription?: VoiceReport['transcription'];
  location?: VoiceLocation | null;
  hospitalRouting?: VoiceReport['hospitalRouting'];
}

export interface VoiceReportTranscript {
  id: string;
  transcript: string;
  transcription?: VoiceReport['transcription'];
  extractedData: VoiceReport['extractedData'];
  extractedInformation?: VoiceExtractedInformation | null;
}

export interface VoiceAccessHistoryEntry {
  id: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  action: string;
  result: string;
  reason: string | null;
  details: string | null;
}

export interface VoiceAccessHistory {
  id: string;
  entries: VoiceAccessHistoryEntry[];
}

/** Response of `POST /api/voice/reports/recording`. */
export interface VoiceRecordingResult {
  report: VoiceReport;
  transcript: string;
  originalTranscript?: string;
  normalizedExtractionText?: string;
  extractedInformation: VoiceExtractedInformation;
  location: VoiceLocation;
  hospital: VoiceHospitalSelection | null;
  distance: number | null;
  emergency: Emergency | null;
  dispatchStatus: 'AWAITING_LOCATION' | 'AWAITING_REVIEW' | 'DISPATCH_PENDING' | 'DISPATCHER_NOTIFIED' | 'BLOCKED_NO_HOSPITAL';
  hospitalNotificationSent: boolean;
  /** Non-fatal message the UI must show instead of a false success. */
  warning: string | null;
}
