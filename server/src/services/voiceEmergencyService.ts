import { Emergency, VoiceReport, nextId } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { emitVoiceError, emitVoiceEvent, VOICE_EVENTS } from '../utils/events.js';
import { toClientEmergency, type AuthContext } from '../authz/access.js';
import { recordAudit, pushNotification } from './auditService.js';
import { createEmergency } from './emergencyService.js';
import {
  extractEmergencyInformation,
  type ExtractedEmergencyInformation,
} from './emergencyExtractionService.js';
import {
  explicitLocation,
  geocodeSpokenLocation,
  knownPlaces,
  type GeocodeResult,
} from './geocodingService.js';
import {
  findNearestEligibleHospital,
  type HospitalCandidate,
} from './hospitalRoutingService.js';
import {
  estimateDurationSeconds,
  transcribeAudio,
  type TranscriptionResult,
} from './transcriptionService.js';
import { storeVoiceAudio, type StoredVoiceAudio } from './voiceAudioStorage.js';
import {
  normalizeUploadedAudio,
  readMimeType,
  type ServerAudioLike,
} from './audioNormalizeService.js';
import type {
  IncidentType,
  LocationSource,
  LocationStatus,
  VoiceDispatchStatus,
} from '../validation/constants.js';

/**
 * Orchestrates the end-to-end voice emergency pipeline.
 *
 *   RECORD → UPLOAD → STORE AUDIO → TRANSCRIBE → EXTRACT → EXTRACT SPOKEN
 *   LOCATION → GEOCODE → FIND ELIGIBLE HOSPITALS → SELECT NEAREST SUITABLE →
 *   CREATE/UPDATE EMERGENCY → NOTIFY DISPATCHER + HOSPITAL → AUDIT → RESPOND
 *
 * The controller stays thin; every step below delegates to a single-purpose
 * service, and each step emits a structured event.
 *
 * Two rules are load-bearing and are enforced here rather than left to chance:
 *  - an emergency is only created once a location actually resolved, so the
 *    system can never route a patient to a hospital chosen from thin air;
 *  - the recording is stored *before* anything can fail, so a transcription,
 *    geocoding or database error never destroys the citizen's audio.
 */

export interface VoiceProcessingRequest {
  auth: AuthContext;
  requestId: string;
  /** The multipart audio part (buffer + declared type) or a base64 string. */
  audio: unknown;
  /** Transcript produced on-device by the bundled Whisper model. */
  clientTranscript?: string | null;
  /** Device GPS, used only when no spoken location resolved. */
  deviceLatitude?: number | null;
  deviceLongitude?: number | null;
  deviceAccuracy?: number | null;
  /** Client-reported recording length in seconds. */
  durationSeconds?: number | null;
  ip?: string;
  userAgent?: string;
  idempotencyKey?: string;
}

export interface VoiceLocationOutcome {
  /** True only when real coordinates were produced. */
  resolved: boolean;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  spokenLocation: string | null;
  source: LocationSource;
  status: LocationStatus;
  accuracy: number | null;
  provider: string;
  error: string | null;
}

export interface VoiceProcessingResult {
  report: Record<string, unknown>;
  emergency: Record<string, unknown> | null;
  transcript: string;
  extractedInformation: ExtractedEmergencyInformation;
  location: VoiceLocationOutcome;
  hospital: HospitalCandidate | null;
  distance: number | null;
  dispatchStatus: VoiceDispatchStatus;
  hospitalNotificationSent: boolean;
  /** Message the UI should show, or null when everything succeeded. */
  warning: string | null;
}

function toLocationOutcome(
  geocode: GeocodeResult,
  spokenLocation: string | null,
): VoiceLocationOutcome {
  return {
    resolved: geocode.resolved,
    latitude: geocode.latitude,
    longitude: geocode.longitude,
    address: geocode.formattedAddress ?? spokenLocation,
    spokenLocation,
    source: geocode.source,
    status: geocode.status,
    accuracy: geocode.accuracy,
    provider: geocode.provider,
    error: geocode.error,
  };
}

function isValidCoordinates(lat: unknown, lng: unknown): lat is number {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lng === 'number' &&
    Number.isFinite(lng) &&
    lng >= -180 &&
    lng <= 180
  );
}

function isValidAccuracy(accuracy: unknown): boolean {
  if (accuracy === null || accuracy === undefined) return true;
  return typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy > 0 && accuracy <= 10000;
}

export interface VoiceConfirmationPolicyCheck {
  canAutoCreate: boolean;
  reason?: string;
}

/**
 * Enforces the RapidAid confirmation policy for voice reports:
 * 1. Extraction confidence < 75% -> require explicit human confirmation.
 * 2. Incident type OTHER -> require explicit human confirmation.
 * 3. Ambiguous transcript or insufficient info (< 20 chars) -> retain DRAFT and request review.
 * 4. Device GPS alone does not authorize auto-creation.
 * 5. Spoken location resolution required for high-confidence creation.
 * 6. Must have participating hospital available within service boundary.
 */
export function evaluateVoiceEmergencyCreationPolicy(params: {
  confidence: number;
  incidentType: IncidentType;
  transcript: string;
  locationSource: LocationSource;
  locationResolved: boolean;
  hospitalAvailable: boolean;
}): VoiceConfirmationPolicyCheck {
  if (params.confidence < 75) {
    return {
      canAutoCreate: false,
      reason: `Extraction confidence is ${params.confidence}% (minimum 75% required for automatic creation). Explicit human confirmation required.`,
    };
  }

  if (params.incidentType === 'OTHER') {
    return {
      canAutoCreate: false,
      reason: 'Incident type is unclassified (OTHER). Explicit human review and confirmation required.',
    };
  }

  const trimmed = params.transcript.trim();
  if (trimmed.length < 20) {
    return {
      canAutoCreate: false,
      reason: 'Transcript is ambiguous or contains insufficient emergency information. Retained as draft for review.',
    };
  }

  if (params.locationSource !== 'SPOKEN' || !params.locationResolved) {
    return {
      canAutoCreate: false,
      reason: 'Device GPS availability alone does not authorize automatic emergency creation. Spoken location resolution required.',
    };
  }

  if (!params.hospitalAvailable) {
    return {
      canAutoCreate: false,
      reason: 'No eligible hospital in the participating network was found within the 50 km service boundary. Manual review required.',
    };
  }

  return { canAutoCreate: true };
}

/**
 * SPOKEN first, DEVICE second, never a guess. A spoken place always wins over
 * the phone's GPS, because the caller may be reporting for someone else.
 * Validates coordinate bounds [-90, 90] / [-180, 180] and GPS accuracy.
 */
async function resolveLocation(
  extracted: ExtractedEmergencyInformation,
  request: VoiceProcessingRequest,
): Promise<VoiceLocationOutcome> {
  if (extracted.spokenLocation) {
    emitVoiceEvent(VOICE_EVENTS.LOCATION_EXTRACTED, {
      hasSpokenLocation: true,
      hasCity: Boolean(extracted.city),
      landmarkCount: extracted.landmarks.length,
    });
    const geocoded = await geocodeSpokenLocation({
      query: extracted.spokenLocation,
      city: extracted.city,
      state: extracted.state,
      source: 'SPOKEN',
    });
    const outcome = toLocationOutcome(geocoded, extracted.spokenLocation);
    if (geocoded.resolved) return outcome;
    // Spoken location was named but could not be resolved — fall through to GPS if coordinates are valid.
    if (
      isValidCoordinates(request.deviceLatitude, request.deviceLongitude) &&
      isValidAccuracy(request.deviceAccuracy)
    ) {
      return toLocationOutcome(
        explicitLocation(
          request.deviceLatitude!,
          request.deviceLongitude!,
          'DEVICE',
          extracted.spokenLocation ?? 'Unverified device location',
          request.deviceAccuracy ?? null,
        ),
        extracted.spokenLocation,
      );
    }
    return outcome;
  }

  if (
    typeof request.deviceLatitude === 'number' ||
    typeof request.deviceLongitude === 'number'
  ) {
    if (
      isValidCoordinates(request.deviceLatitude, request.deviceLongitude) &&
      isValidAccuracy(request.deviceAccuracy)
    ) {
      const outcome = toLocationOutcome(
        explicitLocation(
          request.deviceLatitude!,
          request.deviceLongitude!,
          'DEVICE',
          'Unverified device location',
          request.deviceAccuracy ?? null,
        ),
        null,
      );
      return outcome;
    }
    return toLocationOutcome(
      {
        resolved: false,
        latitude: null,
        longitude: null,
        formattedAddress: null,
        source: 'UNRESOLVED',
        status: 'UNRESOLVED',
        accuracy: null,
        provider: 'none',
        error:
          'Device GPS coordinates or accuracy out of range. Please confirm the location manually.',
      },
      null,
    );
  }

  return toLocationOutcome(
    {
      resolved: false,
      latitude: null,
      longitude: null,
      formattedAddress: null,
      source: 'UNRESOLVED',
      status: 'UNRESOLVED',
      accuracy: null,
      provider: 'none',
      error:
        'No location was spoken and no device location was shared. Please confirm the location.',
    },
    null,
  );
}

function emptyExtraction(): ExtractedEmergencyInformation {
  return {
    emergencyType: 'OTHER',
    severity: 'MEDIUM',
    priority: 'MEDIUM',
    description: '',
    injuredPeople: null,
    spokenLocation: null,
    landmarks: [],
    city: null,
    state: null,
    dispatchHints: [],
    confidence: 0,
  };
}

/**
 * Runs the whole pipeline for one uploaded recording.
 *
 * The returned `report` is always a persisted VoiceReport, even when a later
 * step failed — the audio and transcript survive every failure mode.
 */
export async function processVoiceRecording(
  request: VoiceProcessingRequest,
): Promise<VoiceProcessingResult> {
  const { auth, requestId } = request;

  // ── 0. Normalize the uploaded audio to a Node Buffer exactly once. ──────
  // Every later stage (storage, transcription, any future provider) receives
  // this same Buffer, so no stage can be handed a Blob/base64/plain object and
  // then call `.subarray()` on it.
  const normalized = normalizeUploadedAudio(request.audio as ServerAudioLike, {
    defaultMimeType: readMimeType(request.audio as ServerAudioLike) ?? undefined,
  });

  // ── 1. STORE THE AUDIO FIRST. Nothing after this point can lose it. ───────
  const stored: StoredVoiceAudio = await storeVoiceAudio({
    audio: normalized.buffer,
    ownerId: auth.userId,
    declaredMimeType: normalized.mimeType,
    durationSeconds: request.durationSeconds ?? undefined,
  });

  // ── 2. TRANSCRIBE (never fatal: the report is kept either way) ────────────
  const transcription = await transcribeAudio(
    normalized.buffer,
    stored.mimeType,
    stored.filename,
    { clientTranscript: request.clientTranscript, requestId },
  ).catch((error: unknown) => transcriptionFailure(stored, error));

  const transcript = transcription.text.trim();
  if (transcript) {
    emitVoiceEvent(VOICE_EVENTS.TRANSCRIPTION_COMPLETED, {
      requestId,
      provider: transcription.provider,
      characters: transcript.length,
    });
  }

  // ── 3. EXTRACT emergency information from the transcript ─────────────────
  const { cities, states } = await knownPlaces();
  const extracted = transcript
    ? extractEmergencyInformation(transcript, { knownCities: cities, knownStates: states })
    : emptyExtraction();

  // ── 4/5. EXTRACT + GEOCODE the location (spoken → device → unresolved) ───
  const location = await resolveLocation(extracted, request);

  // ── 6. Persist the report before any downstream step can fail ────────────
  const reportId = await nextId('voiceReport', 'VR', 3);
  const now = new Date();
  const report = await VoiceReport.create({
    _id: reportId,
    ownerId: auth.userId,
    hospitalId: auth.hospitalId,
    transcript,
    extractedData: {
      incidentType: extracted.emergencyType,
      location: extracted.spokenLocation ?? undefined,
      victimCount: extracted.injuredPeople ?? undefined,
      description: extracted.description,
    },
    confidence: extracted.confidence,
    status: transcript ? 'DRAFT' : 'FAILED',
    createdAt: now,
    audio: {
      storageKey: stored.storageKey,
      filename: stored.filename,
      mimeType: stored.mimeType,
      size: stored.size,
      durationSeconds:
        stored.durationSeconds ?? estimateDurationSeconds(stored.size, stored.mimeType),
      checksum: stored.checksum,
      status: 'STORED',
    },
    transcription: {
      text: transcript,
      provider: transcription.provider,
      status: transcription.status,
      durationMs: transcription.durationMs,
      error: transcription.error,
      createdAt: now,
    },
    extractedInformation: {
      emergencyType: extracted.emergencyType,
      severity: extracted.severity,
      description: extracted.description,
      injuredPeople: extracted.injuredPeople,
      spokenLocation: extracted.spokenLocation,
      landmarks: extracted.landmarks,
      city: extracted.city,
      state: extracted.state,
      dispatchHints: extracted.dispatchHints,
    },
    location: {
      latitude: location.latitude,
      longitude: location.longitude,
      address: location.address,
      spokenLocation: location.spokenLocation,
      source: location.source,
      status: location.status,
      accuracy: location.accuracy,
      provider: location.provider,
    },
    dispatchStatus: 'AWAITING_LOCATION',
  });

  await recordAudit({
    actor: auth.name,
    actorId: auth.userId,
    actorRole: auth.role,
    action: 'voice.report_created',
    resource: 'VoiceReport',
    resourceId: reportId,
    requestId,
    ip: request.ip,
    userAgent: request.userAgent,
    details: `${stored.mimeType} ${stored.size}B, transcript ${transcript.length} chars, type ${extracted.emergencyType}`,
  });

  // ── 7. No usable transcript → stop, keep the audio, tell the user ────────
  if (!transcript) {
    emitVoiceEvent(VOICE_EVENTS.PROCESSING_FAILED, { requestId, reportId, reason: 'no_transcript' });
    report.status = 'FAILED';
    await report.save();
    throw new ApiError(
      422,
      'TRANSCRIPTION_FAILED',
      'The recording was stored but no transcript could be produced. Play the recording and enter the details manually.',
    );
  }

  // ── 8. No location → stop before any routing decision is made ───────────
  if (!location.resolved || location.latitude === null || location.longitude === null) {
    report.dispatchStatus = 'AWAITING_LOCATION';
    await report.save();
    return {
      report: report.toJSON() as Record<string, unknown>,
      emergency: null,
      transcript,
      extractedInformation: extracted,
      location,
      hospital: null,
      distance: null,
      dispatchStatus: 'AWAITING_LOCATION',
      hospitalNotificationSent: false,
      warning:
        location.error ??
        'The location could not be identified. Please confirm the location to finish this report.',
    };
  }

  return completeVoiceEmergency({ request, report, reportId, extracted, location });
}

function transcriptionFailure(stored: StoredVoiceAudio, error: unknown): TranscriptionResult {
  emitVoiceError(VOICE_EVENTS.TRANSCRIPTION_FAILED, error, { stage: 'pipeline' });
  return {
    text: '',
    provider: 'none',
    status: 'FAILED',
    confidence: null,
    byteLength: stored.size,
    mimeType: stored.mimeType,
    filename: stored.filename,
    durationMs: 0,
    audioShape: {
      kind: 'object',
      constructorName: 'Object',
      isBuffer: true,
      isUint8Array: true,
      isArrayBuffer: false,
      isTypedArray: true,
      isString: false,
      byteLength: stored.size,
      mimeType: stored.mimeType,
    },
    error: error instanceof Error ? error.message : 'Transcription failed',
  };
}

interface CompletionContext {
  request: VoiceProcessingRequest;
  report: {
    transcript: string;
    status?: string;
    save(): Promise<unknown>;
    toJSON(): Record<string, unknown>;
    location?: unknown;
    hospitalRouting?: unknown;
    dispatchStatus?: unknown;
    emergencyId?: string | null;
  };
  reportId: string;
  extracted: ExtractedEmergencyInformation;
  location: VoiceLocationOutcome;
}

/**
 * Final stage: pick the hospital, create the emergency, associate the two,
 * notify the dispatcher and the hospital, and audit everything.
 *
 * This never performs a real-world dispatch action. RapidAid's authorised
 * workflow is: create the emergency, associate the nearest suitable hospital,
 * put it in a dispatch-pending state and notify the Dispatcher/Supervisor —
 * an authorised person then assigns the ambulance through the existing RBAC
 * route (`POST /api/dispatch/assign`).
 */
async function completeVoiceEmergency(
  context: CompletionContext,
): Promise<VoiceProcessingResult> {
  const { request, report, reportId, extracted, location } = context;
  const { auth, requestId } = request;

  // ── 9. Find eligible hospitals, then the nearest suitable one ────────────
  const routing = await findNearestEligibleHospital({
    latitude: location.latitude as number,
    longitude: location.longitude as number,
    incidentType: extracted.emergencyType,
    severity: extracted.severity,
  });

  // Evaluate the confirmation policy
  const policy = evaluateVoiceEmergencyCreationPolicy({
    confidence: extracted.confidence,
    incidentType: extracted.emergencyType,
    transcript: report.transcript,
    locationSource: location.source,
    locationResolved: location.resolved,
    hospitalAvailable: routing.hospital !== null,
  });

  const distanceLabel = routing.distanceMeters
    ? `${(routing.distanceMeters / 1000).toFixed(1)} km away`
    : 'distance unknown';
  const where = location.address ?? extracted.spokenLocation ?? 'unconfirmed location';

  if (!policy.canAutoCreate) {
    // Retain report in DRAFT; do NOT create active Emergency
    report.hospitalRouting = {
      hospitalId: routing.hospital?.hospitalId ?? null,
      hospitalName: routing.hospital?.name ?? null,
      distance: routing.distanceMeters,
      etaSeconds: routing.etaSeconds,
      routingReason: routing.routingReason,
      selectedAt: new Date(),
    };
    report.status = 'DRAFT';
    report.dispatchStatus = routing.hospital ? 'AWAITING_REVIEW' : 'BLOCKED_NO_HOSPITAL';
    await report.save();

    await pushNotification({
      category: 'WARNING',
      title: routing.hospital
        ? `Voice SOS Draft — Review Required (${extracted.emergencyType.replace(/_/g, ' ')})`
        : 'Voice SOS Draft — Out of Coverage',
      message: `${reportId}: voice report at ${where} requires review. ${policy.reason}`,
      audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
      linkedResource: reportId,
    });

    await recordAudit({
      actor: auth.name,
      actorId: auth.userId,
      actorRole: auth.role,
      action: 'voice.report_review_required',
      resource: 'VoiceReport',
      resourceId: reportId,
      requestId,
      ip: request.ip,
      userAgent: request.userAgent,
      details: `${reportId}: retained as DRAFT awaiting review. Reason: ${policy.reason}`,
    });

    return {
      report: report.toJSON(),
      emergency: null,
      transcript: report.transcript,
      extractedInformation: extracted,
      location,
      hospital: routing.hospital,
      distance: routing.distanceMeters,
      dispatchStatus: report.dispatchStatus as VoiceDispatchStatus,
      hospitalNotificationSent: false,
      warning: policy.reason ?? (routing.hospital ? null : routing.reason),
    };
  }

  // ── 10. High-confidence path: Create emergency and link hospital ──────────
  let emergencyId: string;
  if (report.emergencyId) {
    emergencyId = report.emergencyId;
  } else {
    const created = await createEmergency({
      priority: extracted.priority,
      incidentType: extracted.emergencyType,
      location: {
        lat: location.latitude as number,
        lng: location.longitude as number,
        address: location.address ?? extracted.spokenLocation ?? 'Voice report',
      },
      source: 'VOICE_REPORT',
      description: extracted.description,
      victimCount: extracted.injuredPeople ?? 1,
      citizenId: auth.role === 'CITIZEN' ? auth.userId : undefined,
      assignedDispatcher: ['DISPATCHER', 'SUPERVISOR', 'ADMIN'].includes(auth.role)
        ? auth.userId
        : undefined,
      idempotencyKey: request.idempotencyKey,
    });
    emergencyId = created.id;
  }

  if (routing.hospital) {
    await Emergency.updateOne(
      { _id: emergencyId },
      { $set: { destinationHospital: routing.hospital.hospitalId } },
    );
  }

  emitVoiceEvent(VOICE_EVENTS.EMERGENCY_CREATED, {
    emergencyId,
    reportId,
    incidentType: extracted.emergencyType,
    priority: extracted.priority,
    hospitalId: routing.hospital?.hospitalId ?? null,
  });

  // ── 11. Persist routing and transition report to CONFIRMED ───────────────
  report.hospitalRouting = {
    hospitalId: routing.hospital?.hospitalId ?? null,
    hospitalName: routing.hospital?.name ?? null,
    distance: routing.distanceMeters,
    etaSeconds: routing.etaSeconds,
    routingReason: routing.routingReason,
    selectedAt: new Date(),
  };
  report.status = 'CONFIRMED';
  report.emergencyId = emergencyId;
  report.dispatchStatus = routing.hospital ? 'DISPATCH_PENDING' : 'BLOCKED_NO_HOSPITAL';
  await report.save();

  // ── 12. Notify the authorised workflow, then the hospital ──────────────
  const notifications: Array<Promise<unknown>> = [
    // Dispatcher / Supervisor: the human action queue.
    pushNotification({
      category: extracted.priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
      title: `Voice SOS — ${extracted.emergencyType.replace(/_/g, ' ')}`,
      message: `${emergencyId}: voice report ${reportId} at ${where}. ${
        extracted.injuredPeople ?? 1
      } affected. Awaiting ambulance assignment.`,
      audienceRoles: ['DISPATCHER', 'SUPERVISOR'],
      linkedEmergency: emergencyId,
      linkedResource: reportId,
    }),
  ];

  if (routing.hospital) {
    // Hospital staff receive only what a receiving facility needs — never
    // citizen identity, never the raw transcript.
    notifications.push(
      pushNotification({
        category: extracted.priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
        title: `Incoming emergency — ${extracted.emergencyType.replace(/_/g, ' ')}`,
        message: `${emergencyId}: ${extracted.injuredPeople ?? 1} affected, ${extracted.severity.toLowerCase()} severity, ${where} (${distanceLabel}). Ambulance not yet assigned.`,
        hospitalId: routing.hospital.hospitalId,
        linkedEmergency: emergencyId,
        linkedResource: reportId,
      }),
    );
    emitVoiceEvent(VOICE_EVENTS.HOSPITAL_NOTIFICATION_CREATED, {
      emergencyId,
      hospitalId: routing.hospital.hospitalId,
    });
  }

  await recordAudit({
    actor: auth.name,
    actorId: auth.userId,
    actorRole: auth.role,
    action: 'voice.emergency_created',
    resource: 'Emergency',
    resourceId: emergencyId,
    requestId,
    ip: request.ip,
    userAgent: request.userAgent,
    details: `from ${reportId}; hospital ${routing.hospital?.hospitalId ?? 'none'}; ${
      routing.distanceMeters ?? 'n/a'
    }m; reason ${routing.routingReason}`,
  });

  await Promise.allSettled(notifications);

  const emergency = await Emergency.findById(emergencyId);
  const warning = routing.hospital
    ? routing.capabilityRelaxed
      ? `No hospital with the required capability was reachable; routed to the nearest active hospital (${routing.hospital.name}).`
      : null
    : routing.reason;

  return {
    report: report.toJSON(),
    emergency: emergency
      ? (toClientEmergency(auth, emergency) as unknown as Record<string, unknown>)
      : null,
    transcript: report.transcript,
    extractedInformation: extracted,
    location,
    hospital: routing.hospital,
    distance: routing.distanceMeters,
    dispatchStatus: routing.hospital ? 'DISPATCHER_NOTIFIED' : 'BLOCKED_NO_HOSPITAL',
    hospitalNotificationSent: Boolean(routing.hospital),
    warning,
  };
}

export interface ReconcileVoiceConfirmationsResult {
  linkedEmergencies: string[];
  revertedToDraft: string[];
  recoveredConfirmations: string[];
}

/**
 * Reconciles VoiceReports interrupted during the confirmation lifecycle:
 *
 * State machine: DRAFT -> CONFIRMING -> CONFIRMED
 *
 * Scenarios handled:
 * 1. Report is CONFIRMING (or CONFIRMED without emergencyId) AND an Emergency with voiceReportId already exists:
 *    -> Link emergencyId, transition report to CONFIRMED.
 * 2. Report is CONFIRMING, confirmationStartedAt is stale (> staleTimeoutMs, default 15s), and NO Emergency was created:
 *    -> Revert status to DRAFT so human review/confirmation can be completed cleanly.
 * 3. Report is CONFIRMED, but emergencyId is unset or invalid, and NO Emergency was created:
 *    -> Revert status to DRAFT so human review/confirmation can be completed cleanly.
 */
export async function reconcileVoiceConfirmations(options?: {
  staleTimeoutMs?: number;
}): Promise<ReconcileVoiceConfirmationsResult> {
  const staleTimeoutMs = options?.staleTimeoutMs ?? 15_000;
  const staleThreshold = new Date(Date.now() - staleTimeoutMs);

  const result: ReconcileVoiceConfirmationsResult = {
    linkedEmergencies: [],
    revertedToDraft: [],
    recoveredConfirmations: [],
  };

  // Find reports that were left in CONFIRMING or CONFIRMED without a valid emergencyId
  const pendingReports = await VoiceReport.find({
    $or: [
      { status: 'CONFIRMING' },
      {
        status: 'CONFIRMED',
        $or: [{ emergencyId: { $exists: false } }, { emergencyId: null }, { emergencyId: '' }],
      },
    ],
  });

  for (const report of pendingReports) {
    // Check if an Emergency was already created for this VoiceReport by durable voiceReportId
    const existingEmergency = await Emergency.findOne({ voiceReportId: report._id });

    if (existingEmergency) {
      // Emergency was created before crash! Link it and confirm
      await VoiceReport.updateOne(
        { _id: report._id },
        {
          $set: {
            status: 'CONFIRMED',
            emergencyId: existingEmergency._id,
            dispatchStatus: existingEmergency.destinationHospital ? 'DISPATCH_PENDING' : 'BLOCKED_NO_HOSPITAL',
          },
        },
      );
      result.linkedEmergencies.push(report._id);
      result.recoveredConfirmations.push(report._id);
      continue;
    }

    // No emergency exists. Check if confirmation lock has expired (or report was left as CONFIRMED with no emergency)
    const isStale = !report.confirmationStartedAt || report.confirmationStartedAt < staleThreshold;
    if (isStale || report.status === 'CONFIRMED') {
      // Revert to DRAFT so confirmation can be retried safely
      await VoiceReport.updateOne(
        { _id: report._id },
        {
          $set: {
            status: 'DRAFT',
            confirmationOperationId: undefined,
            confirmationStartedAt: undefined,
          },
        },
      );
      result.revertedToDraft.push(report._id);
      result.recoveredConfirmations.push(report._id);
    }
  }

  // Also sweep any orphan Emergency records created with voiceReportId that are not linked
  const orphanEmergencies = await Emergency.find({
    source: 'VOICE_REPORT',
    voiceReportId: { $exists: true, $ne: null },
  });

  for (const emg of orphanEmergencies) {
    if (emg.voiceReportId) {
      const vr = await VoiceReport.findById(emg.voiceReportId);
      if (vr && (vr.emergencyId !== emg._id || vr.status !== 'CONFIRMED')) {
        await VoiceReport.updateOne(
          { _id: vr._id },
          {
            $set: {
              status: 'CONFIRMED',
              emergencyId: emg._id,
            },
          },
        );
        if (!result.linkedEmergencies.includes(vr._id)) {
          result.linkedEmergencies.push(vr._id);
          result.recoveredConfirmations.push(vr._id);
        }
      }
    }
  }

  return result;
}

