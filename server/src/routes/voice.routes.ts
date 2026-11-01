import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { hasPermission, toClientEmergency, type AuthContext } from '../authz/access.js';
import {
  assertVoiceAccess,
  capabilitiesFor,
  createVoiceScopeCache,
  relationsForMany,
  voiceCapabilities,
  voiceReportListFilter,
  type VoiceCapabilities,
  type VoiceRelations,
  type VoiceReportScope,
} from '../authz/voiceReportAccess.js';
import { validateBody } from '../middleware/validate.js';
import { voiceUploadLimiter } from '../middleware/rateLimit.js';
import { idempotent } from '../middleware/idempotency.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AuditLog, Emergency, VoiceReport, nextId } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { confirmVoiceSchema, voiceEditSchema, voiceRejectSchema, voiceTranscriptSchema } from '../validation/schemas.js';
import { extractFromTranscript } from '../services/voiceExtractionService.js';
import { createEmergency } from '../services/emergencyService.js';
import { recordAudit, pushNotification } from '../services/auditService.js';
import {
  notifyCitizenOnConfirmation,
  notifyCitizenOnRejection,
  notifyDispatchersOnVoiceReport,
} from '../services/notificationService.js';
import { processVoiceRecording } from '../services/voiceEmergencyService.js';
import { audioUpload } from '../middleware/audioUpload.js';
import { deleteVoiceAudio, readVoiceAudio } from '../services/voiceAudioStorage.js';
import { sendMedia } from '../utils/mediaResponse.js';
import { findNearestEligibleHospital } from '../services/hospitalRoutingService.js';
import { geocodeSpokenLocation } from '../services/geocodingService.js';
import { MAX_VOICE_AUDIO_BYTES } from '../validation/constants.js';

export const voiceRouter = Router();

const VR_ID = /^VR-\d{1,10}$/;

/**
 * Every permission that admits a caller to a voice report in *some* scope.
 * The route guards use this list; the actual scope (own / assigned / hospital /
 * relevant / historical / analytical) is decided per record by
 * `assertVoiceAccess` in authz/voiceReportAccess.ts.
 */
const VOICE_READ_PERMISSIONS = [
  P.VOICE_READ_ALL,
  P.VOICE_READ_OWN,
  P.VOICE_READ_ASSIGNED,
  P.VOICE_READ_HOSPITAL,
  P.VOICE_READ_RELEVANT,
  P.VOICE_READ_HISTORICAL,
  P.VOICE_READ_ANALYTICAL,
  P.VOICE_EVIDENCE_VIEW,
] as const;
/** The subset of a voice report needed to serialize an API response. */
interface VoiceReportRow {
  /** Lean documents carry `_id`; `toJSON()` documents carry `id`. */
  _id?: string;
  id?: string;
  ownerId?: string | null;
  hospitalId?: string | null;
  emergencyId?: string | null;
  status?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  confidence?: number | null;
  dispatchStatus?: string | null;
  transcript?: string | null;
  extractedData?: {
    incidentType?: string | null;
    location?: string | null;
    victimCount?: number | null;
    description?: string | null;
  } | null;
  extractedInformation?: unknown;
  transcription?: unknown;
  location?: {
    latitude?: number | null;
    longitude?: number | null;
    address?: string | null;
    spokenLocation?: string | null;
    source?: string;
    status?: string;
  } | null;
  hospitalRouting?: {
    hospitalId?: string | null;
    hospitalName?: string | null;
    distance?: number | null;
    etaSeconds?: number | null;
    routingReason?: string | null;
    selectedAt?: Date | string | null;
  } | null;
  audio?: {
    storageKey?: string | null;
    filename?: string | null;
    mimeType?: string | null;
    size?: number | null;
    durationSeconds?: number | null;
    checksum?: string | null;
    status?: string | null;
  } | null;
}

const asRow = (value: unknown): VoiceReportRow => value as VoiceReportRow;

/** The report id, whichever serialization shape the caller handed us. */
const reportIdOf = (report: VoiceReportRow): string => report._id ?? report.id ?? '';

/** Narrows a response row to the projection the authorizer reads. */
const asScope = (report: VoiceReportRow): VoiceReportScope => ({
  _id: reportIdOf(report),
  ownerId: report.ownerId ?? null,
  hospitalId: report.hospitalId ?? null,
  emergencyId: report.emergencyId ?? null,
  status: report.status ?? null,
  hospitalRouting: report.hospitalRouting ?? null,
  audio: report.audio ?? null,
});

/** Whether this caller may learn who filed the report. */
function maySeeOwnerIdentity(auth: AuthContext): boolean {
  return hasPermission(auth, P.VOICE_READ_ALL) || hasPermission(auth, 'voice:evidence:view');
}

/**
 * List/summary projection. Deliberately metadata-only: the transcript is a
 * separate resource and the audio bytes are never part of a list response, so
 * browsing reports can leak neither.
 */
function summarizeVoiceReport(
  auth: AuthContext,
  report: VoiceReportRow,
  capabilities: VoiceCapabilities,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    id: reportIdOf(report),
    status: report.status ?? 'DRAFT',
    createdAt: report.createdAt ?? null,
    updatedAt: report.updatedAt ?? null,
    emergencyId: report.emergencyId ?? null,
    confidence: report.confidence ?? null,
    incidentType: report.extractedData?.incidentType ?? null,
    locationLabel: report.location?.address ?? report.extractedData?.location ?? null,
    victimCount: report.extractedData?.victimCount ?? null,
    hospitalId: report.hospitalRouting?.hospitalId ?? report.hospitalId ?? null,
    hospitalName: report.hospitalRouting?.hospitalName ?? null,
    dispatchStatus: report.dispatchStatus ?? null,
    audio: report.audio?.storageKey
      ? {
          filename: report.audio.filename ?? null,
          mimeType: report.audio.mimeType ?? null,
          size: report.audio.size ?? null,
          durationSeconds: report.audio.durationSeconds ?? null,
          status: report.audio.status ?? 'STORED',
        }
      : null,
    /** Access context label ("Assigned Emergency", "Audit Evidence"…). */
    accessLabel: capabilities.accessLabel,
    /** Server-derived action flags; the UI renders its controls from these. */
    capabilities,
  };
  if (maySeeOwnerIdentity(auth) || report.ownerId === auth.userId) {
    summary.ownerId = report.ownerId ?? null;
  }
  return summary;
}

/** Full detail projection: transcript only when the caller holds that grant. */
function toVoiceReportDetail(
  auth: AuthContext,
  report: VoiceReportRow,
  capabilities: VoiceCapabilities,
): Record<string, unknown> {
  const detail = summarizeVoiceReport(auth, report, capabilities);
  detail.transcript = capabilities.transcript ? (report.transcript ?? '') : null;
  detail.originalTranscript = capabilities.transcript
    ? (((report as Record<string, unknown>).originalTranscript as string | undefined) ?? report.transcript ?? '')
    : null;
  detail.normalizedExtractionText = capabilities.transcript
    ? (((report as Record<string, unknown>).normalizedExtractionText as string | undefined) ?? report.transcript ?? '')
    : null;
  detail.transcriptRestricted = !capabilities.transcript;
  detail.extractedData = report.extractedData ?? {};
  detail.extractedInformation = report.extractedInformation ?? null;
  detail.transcription = report.transcription ?? null;
  detail.location = report.location ?? null;
  detail.hospitalRouting = report.hospitalRouting ?? null;
  return detail;
}

/** Serializes a list of reports with one relationship query per emergency. */
async function summarizeMany(
  auth: AuthContext,
  rows: unknown[],
): Promise<Record<string, unknown>[]> {
  const reports = rows.map(asRow);
  const relations = await relationsForMany(auth, reports.map(asScope), createVoiceScopeCache());
  return reports.map((report) => {
    const relation: VoiceRelations = relations.get(reportIdOf(report)) as VoiceRelations;
    return summarizeVoiceReport(auth, report, capabilitiesFor(auth, relation, asScope(report)));
  });
}


/**
 * GET /api/voice/reports/current â€” the latest draft report (the Voice
 * page shows one draft at a time). 404 when none exists.
 */
voiceRouter.get(
  '/reports/current',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    // Scope-aware: the newest report *this caller may see* — their own for a
    // citizen, an assigned emergency for a crew, the live queue for dispatch…
    const filter = await voiceReportListFilter(req.auth!);
    const latest = await VoiceReport.findOne(filter).sort({ createdAt: -1 }).lean();
    if (!latest) throw ApiError.notFound('No voice report available');
    const row = asRow(latest);
    const capabilities = await voiceCapabilities(req.auth!, asScope(row));
    res.json(toVoiceReportDetail(req.auth!, row, capabilities));
  }),
);

/**
 * GET /api/voice/reports — the caller's voice-report workspace.
 *
 * Scoped server-side (own / assigned / hospital / relevant / historical /
 * analytical) and metadata-only: transcripts and audio have their own
 * endpoints, so browsing a list can leak neither.
 */
voiceRouter.get(
  '/reports',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const query = req.query;
    const options = {
      scope: typeof query.scope === 'string' ? query.scope : undefined,
      status: typeof query.status === 'string' ? query.status : undefined,
      emergencyId: typeof query.emergencyId === 'string' ? query.emergencyId : undefined,
      search: typeof query.search === 'string' ? query.search : undefined,
    };
    if (options.emergencyId && !/^EMG-\d{1,10}$/.test(options.emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${options.emergencyId}'`);
    }
    const requestedLimit = Number(query.limit);
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 200) : 100;

    const filter = await voiceReportListFilter(req.auth!, options);
    const rows = await VoiceReport.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ reports: await summarizeMany(req.auth!, rows), count: rows.length });
  }),
);

/**
 * GET /api/voice/reports/:id — one report, with its transcript only when the
 * caller holds a transcript grant. Reading a report never implies hearing it.
 */
voiceRouter.get(
  '/reports/:id',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const found = await VoiceReport.findById(id).lean();
    if (!found) throw ApiError.notFound(`Voice report ${id} not found`);
    const row = asRow(found);
    const capabilities = await assertVoiceAccess(req.auth!, asScope(row), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.report_viewed',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      details: `scope=${capabilities.accessLabel} transcript=${capabilities.transcript} emergency=${row.emergencyId ?? 'none'}`,
    });

    const detail = toVoiceReportDetail(req.auth!, row, capabilities);
    if (row.emergencyId) {
      const em = await Emergency.findById(row.emergencyId).select('status').lean();
      detail.emergencyStatus = em?.status ?? null;
    }

    res.json(detail);
  }),
);

/**
 * GET /api/voice/reports/:id/transcript — the transcript as its own resource.
 * Sister permissions are intentionally broader than the audio ones: an Analyst
 * may read the words without ever being able to play the recording.
 */
voiceRouter.get(
  '/reports/:id/transcript',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const found = await VoiceReport.findById(id).lean();
    if (!found) throw ApiError.notFound(`Voice report ${id} not found`);
    const row = asRow(found);
    await assertVoiceAccess(req.auth!, asScope(row), 'transcript', { requestId: req.requestId, ip: req.ip });

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.transcript_viewed',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      details: `emergency=${row.emergencyId ?? 'none'}`,
    });

    res.json({
      id,
      transcript: row.transcript ?? '',
      transcription: row.transcription ?? null,
      extractedData: row.extractedData ?? {},
      extractedInformation: row.extractedInformation ?? null,
    });
  }),
);

/**
 * GET /api/voice/reports/:id/access-history — traceability for sensitive
 * evidence: who looked at, played, confirmed or was denied this report.
 * Administrator / Auditor only (`voice:access-history:view`).
 */
voiceRouter.get(
  '/reports/:id/access-history',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const found = await VoiceReport.findById(id).lean();
    if (!found) throw ApiError.notFound(`Voice report ${id} not found`);
    const capabilities = await assertVoiceAccess(req.auth!, asScope(asRow(found)), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });
    if (!capabilities.accessHistory) {
      throw ApiError.forbidden('You are not authorized to view voice-report access history');
    }

    const entries = await AuditLog.find({ resource: 'VoiceReport', resourceId: id })
      .sort({ timestamp: -1 })
      .limit(200)
      .lean();
    res.json({
      id,
      entries: entries.map((entry) => ({
        id: entry._id,
        timestamp: entry.timestamp,
        actor: entry.actor,
        actorRole: entry.actorRole,
        action: entry.action,
        result: entry.result,
        reason: entry.reason ?? null,
        details: entry.details ?? null,
      })),
    });
  }),
);

/**
 * POST /api/voice/reports â€” submit a transcript for AI extraction.
 * Returns a DRAFT report; nothing is created downstream until a human
 * confirms (matches the "DRAFT â€” requires confirmation" UI warning).
 */
voiceRouter.post(
  '/reports',
  authenticate,
  requirePermission(P.VOICE_CREATE),
  validateBody(voiceTranscriptSchema),
  asyncHandler(async (req, res) => {
    const originalTranscript = req.body.transcript;
    const { normalizeExtractionText } = await import('../services/hindiNormalizationService.js');
    const normalizedExtractionText = normalizeExtractionText(originalTranscript);
    const { extractedData, confidence } = extractFromTranscript(originalTranscript);
    const _id = await nextId('voiceReport', 'VR', 3);

    const report = await VoiceReport.create({
      _id,
      ownerId: req.auth!.userId,
      hospitalId: req.auth!.hospitalId,
      transcript: originalTranscript,
      originalTranscript,
      normalizedExtractionText,
      extractedData,
      confidence,
      status: 'DRAFT',
      createdAt: new Date(),
    });

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'voice.report_created',
      resource: 'VoiceReport',
      resourceId: _id,
      requestId: req.requestId,
      details: `confidence ${confidence}%, type ${extractedData.incidentType}`,
    });

    notifyDispatchersOnVoiceReport({
      _id,
      summary: extractedData.incidentType,
      location: { address: extractedData.location },
    }).catch(() => {});

    res.status(201).json(report.toJSON());
  }),
);

/**
 * POST /api/voice/reports/:id/confirm â€” human confirms the draft â†’
 * creates a real emergency (source VOICE_REPORT) and marks the report
 * CONFIRMED. Optional body overrides for location/priority/victims.
 */
voiceRouter.post(
  '/reports/:id/confirm',
  authenticate,
  validateBody(confirmVoiceSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const report = await VoiceReport.findById(id);
    if (!report) throw ApiError.notFound(`Voice report ${id} not found`);
    if (!hasPermission(req.auth, P.VOICE_CONFIRM) && !hasPermission(req.auth, 'emergency:confirm')) {
      throw ApiError.forbidden('You may not confirm voice reports');
    }
    // …and must be inside this report's scope. Out-of-scope callers get 404 so
    // a dispatcher cannot confirm a draft belonging to another operation.
    await assertVoiceAccess(req.auth!, asScope(asRow(report.toJSON())), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });
    if (report.status === 'REJECTED') {
      throw ApiError.conflict(`Voice report ${id} was rejected and cannot be confirmed`);
    }

    // 1. Check if an Emergency is already linked and confirmed
    const wasAlreadyConfirmed = report.status === 'CONFIRMED';
    if (report.emergencyId) {
      const existing = await Emergency.findById(report.emergencyId);
      if (existing && existing.source === 'VOICE_REPORT') {
        if (!wasAlreadyConfirmed) {
          report.status = 'CONFIRMED';
          await report.save();
        } else if (!req.header('idempotency-key')) {
          throw ApiError.conflict(`Voice report ${id} already confirmed`);
        }
        return res.status(200).json({
          report: report.toJSON(),
          emergency: toClientEmergency(req.auth!, existing),
          hospital: report.hospitalRouting
            ? {
                hospitalId: report.hospitalRouting.hospitalId,
                name: report.hospitalRouting.hospitalName,
              }
            : null,
          distance: report.hospitalRouting?.distance ?? null,
          locationSource: report.location?.source ?? 'MANUAL',
        });
      }
    }

    // 2. Durable relationship check: Did an interrupted attempt already create an Emergency with voiceReportId?
    const existingByVoiceReport = await Emergency.findOne({ voiceReportId: id });
    if (existingByVoiceReport) {
      report.status = 'CONFIRMED';
      report.emergencyId = existingByVoiceReport._id;
      report.dispatchStatus = existingByVoiceReport.destinationHospital
        ? 'DISPATCH_PENDING'
        : 'BLOCKED_NO_HOSPITAL';
      await report.save();
      return res.status(200).json({
        report: report.toJSON(),
        emergency: toClientEmergency(req.auth!, existingByVoiceReport),
        hospital: report.hospitalRouting
          ? {
              hospitalId: report.hospitalRouting.hospitalId,
              name: report.hospitalRouting.hospitalName,
            }
          : null,
        distance: report.hospitalRouting?.distance ?? null,
        locationSource: report.location?.source ?? 'MANUAL',
      });
    }

    // 3. Interrupted CONFIRMED without emergency recovery:
    // If report was marked CONFIRMED but no emergency exists anywhere, heal back to DRAFT
    if (report.status === 'CONFIRMED') {
      report.status = 'DRAFT';
      await VoiceReport.updateOne({ _id: id }, { $set: { status: 'DRAFT' } });
    }

    // 4. In-progress check:
    if (report.status === 'CONFIRMING') {
      const lockAgeMs = report.confirmationStartedAt
        ? Date.now() - new Date(report.confirmationStartedAt).getTime()
        : Infinity;
      if (lockAgeMs < 10_000) {
        throw ApiError.conflict(`Voice report ${id} is currently being confirmed; please retry shortly`);
      }
      // Lock is stale from an interrupted process (>10s); will be reclaimed below.
    }

    const extracted = report.extractedData;
    const incidentType = extracted.incidentType ?? 'OTHER';
    const priority =
      req.body.priority ??
      (incidentType === 'CARDIAC_ARREST' || report.confidence >= 90 ? 'CRITICAL' : 'HIGH');
    const victimCount = req.body.victimCount ?? extracted.victimCount ?? 1;

    // Location resolution order — never a hardcoded centroid:
    //   1. an explicit `location` in the body  → MANUAL
    //   2. the location already resolved on the report (spoken or device)
    //   3. re-geocode the spoken location
    let location: { lat: number; lng: number; address?: string } | null = null;
    let locationSource: 'MANUAL' | 'SPOKEN' | 'DEVICE' = 'MANUAL';
    if (req.body.location) {
      location = req.body.location;
      locationSource = 'MANUAL';
    } else if (report.location?.latitude != null && report.location?.longitude != null) {
      const stored = report.location;
      location = {
        lat: stored.latitude as number,
        lng: stored.longitude as number,
        address: stored.address ?? report.extractedData.location ?? undefined,
      };
      locationSource = stored.source === 'DEVICE' ? 'DEVICE' : 'SPOKEN';
    } else if (report.extractedData.location) {
      const geocoded = await geocodeSpokenLocation({
        query: report.extractedData.location,
        source: 'SPOKEN',
      });
      if (geocoded.resolved && geocoded.latitude !== null && geocoded.longitude !== null) {
        location = {
          lat: geocoded.latitude,
          lng: geocoded.longitude,
          address: geocoded.formattedAddress ?? report.extractedData.location,
        };
        locationSource = 'SPOKEN';
      }
    }

    if (!location) {
      throw ApiError.badRequest(
        `Voice report ${id} has no resolvable location. Supply a location to confirm it.`,
      );
    }

    if (
      typeof location.lat !== 'number' ||
      typeof location.lng !== 'number' ||
      Number.isNaN(location.lat) ||
      Number.isNaN(location.lng) ||
      location.lat < -90 ||
      location.lat > 90 ||
      location.lng < -180 ||
      location.lng > 180
    ) {
      throw ApiError.badRequest(
        `Voice report ${id} coordinates lat=${location.lat}, lng=${location.lng} are invalid. Latitude must be between -90 and 90, and longitude between -180 and 180.`,
      );
    }

    // 5. Atomic state machine transition: DRAFT -> CONFIRMING
    // Generate durable confirmation operation ID
    const confirmationOperationId = `op_conf_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();

    const claim = await VoiceReport.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { status: 'DRAFT' },
          {
            status: 'CONFIRMING',
            $or: [
              { confirmationStartedAt: { $exists: false } },
              { confirmationStartedAt: null },
              { confirmationStartedAt: { $lt: new Date(Date.now() - 10_000) } },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'CONFIRMING',
          confirmationOperationId,
          confirmationStartedAt: now,
        },
      },
      { new: true },
    ).exec();

    if (!claim) {
      // Concurrent check: if another request won the race and created/linked an emergency, return it
      const current = await VoiceReport.findById(id).lean();
      if (current?.emergencyId) {
        const existing = await Emergency.findById(current.emergencyId);
        if (existing && existing.source === 'VOICE_REPORT') {
          return res.status(200).json({
            report: current,
            emergency: toClientEmergency(req.auth!, existing),
            hospital: current.hospitalRouting
              ? {
                  hospitalId: current.hospitalRouting.hospitalId,
                  name: current.hospitalRouting.hospitalName,
                }
              : null,
            distance: current.hospitalRouting?.distance ?? null,
            locationSource: current.location?.source ?? 'MANUAL',
          });
        }
      }
      throw ApiError.conflict(`Voice report ${id} is already being confirmed or was already confirmed`);
    }

    try {
      const { id: emergencyId } = await createEmergency({
        priority,
        incidentType,
        location,
        source: 'VOICE_REPORT',
        description: extracted.description ?? report.transcript.slice(0, 300),
        victimCount,
        voiceReportId: id,
        confirmationOperationId,
        citizenId: report.ownerId ?? undefined,
        // Whoever confirms becomes the responsible dispatcher: the report then
        // stays inside that reviewer's "handled" scope for the rest of its life.
        ...(['DISPATCHER', 'SUPERVISOR', 'ADMIN'].includes(req.auth!.role)
          ? { assignedDispatcher: req.auth!.userId }
          : {}),
      });

      // Nearest *suitable* hospital from the live database — never a hardcoded id.
      const severity = report.extractedInformation?.severity ?? 'HIGH';
      const routing = await findNearestEligibleHospital({
        latitude: location.lat,
        longitude: location.lng,
        incidentType,
        severity,
      });
      if (routing.hospital) {
        await Emergency.updateOne(
          { _id: emergencyId },
          { $set: { destinationHospital: routing.hospital.hospitalId } },
        );
        await pushNotification({
          category: priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
          title: 'Incoming emergency',
          message: `${emergencyId}: ${incidentType.replace(/_/g, ' ').toLowerCase()} inbound, ${(
            (routing.distanceMeters ?? 0) / 1000
          ).toFixed(1)} km from ${routing.hospital.name}. Ambulance not yet assigned.`,
          hospitalId: routing.hospital.hospitalId,
          linkedEmergency: emergencyId,
          linkedResource: id,
        });
      }

      // 6. Transition state machine to terminal CONFIRMED
      report.status = 'CONFIRMED';
      report.emergencyId = emergencyId;
      report.confirmationOperationId = confirmationOperationId;
      report.dispatchStatus = routing.hospital ? 'DISPATCH_PENDING' : 'BLOCKED_NO_HOSPITAL';
      if (routing.hospital) {
        report.hospitalRouting = {
          hospitalId: routing.hospital.hospitalId,
          hospitalName: routing.hospital.name,
          distance: routing.distanceMeters ?? undefined,
          etaSeconds: routing.etaSeconds ?? undefined,
          routingReason: routing.routingReason,
          selectedAt: new Date(),
        };
      }
      await report.save();

      await Promise.allSettled([
        recordAudit({
          actor: req.auth!.name,
          actorRole: req.auth!.role as never,
          action: 'voice.report_confirmed',
          resource: 'Emergency',
          resourceId: emergencyId,
          requestId: req.requestId,
          details: `from ${id}, confidence ${report.confidence}%, location ${locationSource}, hospital ${
            routing.hospital?.hospitalId ?? 'none'
          }, op ${confirmationOperationId}`,
        }),
        pushNotification({
          category: priority === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
          title: 'Voice Report Confirmed',
          message: `${id} → ${emergencyId} created from voice report.`,
          linkedEmergency: emergencyId,
          linkedResource: id,
        }),
      ]);

      notifyCitizenOnConfirmation({
        _id: emergencyId,
        citizenId: report.ownerId,
        incidentType,
        priority,
      }).catch(() => {});

      const emergency = await Emergency.findById(emergencyId);
      res.status(201).json({
        report: report.toJSON(),
        emergency: toClientEmergency(req.auth!, emergency!),
        hospital: routing.hospital,
        distance: routing.distanceMeters,
        locationSource,
      });
    } catch (err) {
      // If Emergency was NOT created, release claim back to DRAFT so it can be retried cleanly.
      // If Emergency was created before an error, leave confirmationOperationId intact so reconciliation links it.
      const emgCreated = await Emergency.findOne({ voiceReportId: id });
      if (!emgCreated) {
        await VoiceReport.updateOne(
          { _id: id, status: 'CONFIRMING', confirmationOperationId },
          {
            $set: {
              status: 'DRAFT',
              confirmationOperationId: undefined,
              confirmationStartedAt: undefined,
            },
          },
        ).exec();
      }
      throw err;
    }
  }),
);

/**
 * POST /api/voice/reports/:id/reject — a reviewer rejects a draft.
 *
 * The recording and transcript are RETAINED as evidence (status REJECTED, never
 * deleted), no emergency is created, and the reason is mandatory and audited.
 */
voiceRouter.post(
  '/reports/:id/reject',
  authenticate,
  validateBody(voiceRejectSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const report = await VoiceReport.findById(id);
    if (!report) throw ApiError.notFound(`Voice report ${id} not found`);
    if (!hasPermission(req.auth, P.VOICE_REJECT) && !hasPermission(req.auth, 'emergency:reject')) {
      throw ApiError.forbidden('You may not reject voice reports');
    }
    await assertVoiceAccess(req.auth!, asScope(asRow(report.toJSON())), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });
    if (report.status === 'CONFIRMED') {
      throw ApiError.conflict(`Voice report ${id} is confirmed and cannot be rejected`);
    }
    if (report.status === 'REJECTED') throw ApiError.conflict(`Voice report ${id} is already rejected`);

    const previousState = { status: report.status, emergencyId: report.emergencyId ?? null };
    report.status = 'REJECTED';
    await report.save();

    await Promise.allSettled([
      recordAudit({
        actor: req.auth!.name,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        action: 'voice.report_rejected',
        resource: 'VoiceReport',
        resourceId: id,
        requestId: req.requestId,
        ip: req.ip,
        reason: req.body.reason,
        previousState,
        newState: { status: 'REJECTED' },
        details: `emergency=${report.emergencyId ?? 'none'}`,
      }),
      pushNotification({
        category: 'WARNING',
        title: 'Voice report rejected',
        message: `${id} was rejected by ${req.auth!.name}: ${req.body.reason}`,
        linkedResource: id,
        ...(report.emergencyId ? { linkedEmergency: report.emergencyId } : {}),
      }),
    ]);

    notifyCitizenOnRejection(report.emergencyId || id, report.ownerId, req.body.reason).catch(() => {});

    const row = asRow(report.toJSON());
    res.json(toVoiceReportDetail(req.auth!, row, await voiceCapabilities(req.auth!, asScope(row))));
  }),
);

/**
 * PATCH /api/voice/reports/:id — authorized correction of the transcript and/or
 * AI extraction (dispatcher / supervisor / administrator). The AI draft stays
 * human-correctable, and every edit is audited with its before/after state.
 */
voiceRouter.patch(
  '/reports/:id',
  authenticate,
  requirePermission(P.VOICE_EDIT),
  validateBody(voiceEditSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const report = await VoiceReport.findById(id);
    if (!report) throw ApiError.notFound(`Voice report ${id} not found`);
    await assertVoiceAccess(req.auth!, asScope(asRow(report.toJSON())), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });

    const before = asRow(report.toJSON());
    const update: Record<string, unknown> = {};
    if (typeof req.body.transcript === 'string') update.transcript = req.body.transcript;
    if (req.body.extractedData) {
      for (const [key, value] of Object.entries(req.body.extractedData)) {
        if (value !== undefined) update[`extractedData.${key}`] = value;
      }
    }
    if (!Object.keys(update).length) {
      throw ApiError.badRequest('No editable fields supplied (transcript, extractedData)');
    }

    await VoiceReport.updateOne({ _id: id }, { $set: update });
    const updated = asRow(await VoiceReport.findById(id).lean());

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.report_edited',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      previousState: { transcript: before.transcript ?? '', extractedData: before.extractedData ?? {} },
      newState: { transcript: updated.transcript ?? '', extractedData: updated.extractedData ?? {} },
      details: `fields=${Object.keys(update).join(',')}`,
    });

    res.json(toVoiceReportDetail(req.auth!, updated, await voiceCapabilities(req.auth!, asScope(updated))));
  }),
);

/**
 * POST /api/voice/reports/recording — the full voice-emergency pipeline.
 *
 * `multipart/form-data` with:
 *   audio             (file, required) — the MediaRecorder blob, real container
 *   transcript        (text)          — produced on-device by bundled Whisper
 *   durationSeconds  (number, optional)
 *   deviceLatitude / deviceLongitude / deviceAccuracy (numbers, optional)
 *
 * The client must NOT set `Content-Type` itself: the browser appends the
 * multipart boundary. A boundary-less header is rejected with 415.
 *
 * Response mirrors the existing API conventions and adds the pipeline result:
 *   { report, transcript, extractedInformation, location, hospital, distance,
 *     emergency, dispatchStatus, hospitalNotificationSent, warning }
 */
voiceRouter.post(
  '/reports/recording',
  authenticate,
  // Runs after `authenticate` so the limiter can key on the user id.
  voiceUploadLimiter,
  requirePermission(P.VOICE_CREATE),
  audioUpload({ field: 'audio', maxBytes: MAX_VOICE_AUDIO_BYTES }),
  idempotent({ endpoint: 'POST /api/voice/reports/recording' }),
  asyncHandler(async (req, res) => {
    const file = req.files?.audio;
    if (!file) throw ApiError.badRequest('No audio file was uploaded');

    const number = (value: unknown): number | null => {
      const parsed = Number(value);
      return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : null;
    };

    const result = await processVoiceRecording({
      auth: req.auth!,
      requestId: req.requestId,
      audio: file,
      clientTranscript: typeof req.body.transcript === 'string' ? req.body.transcript : null,
      deviceLatitude: number(req.body.deviceLatitude),
      deviceLongitude: number(req.body.deviceLongitude),
      deviceAccuracy: number(req.body.deviceAccuracy),
      durationSeconds: number(req.body.durationSeconds),
      ip: req.ip,
      userAgent: req.header('user-agent'),
      idempotencyKey: req.scopedIdempotencyKey,
    });

    // 201 when an emergency was created, 202 when the report is waiting on a
    // location the reporter still has to confirm. Never a false 2xx "success".
    res.status(result.emergency ? 201 : 202).json({
      report: result.report,
      transcript: result.transcript,
      originalTranscript: result.originalTranscript,
      normalizedExtractionText: result.normalizedExtractionText,
      extractedInformation: result.extractedInformation,
      location: result.location,
      hospital: result.hospital,
      distance: result.distance,
      emergency: result.emergency,
      dispatchStatus: result.dispatchStatus,
      hospitalNotificationSent: result.hospitalNotificationSent,
      warning: result.warning,
    });
  }),
);

/**
 * GET /api/voice/reports/:id/audio — streams the stored original recording.
 *
 * Recordings are patient data, so this is never public: the caller must either
 * hold `voice:read:all` or own the report. The stored bytes are served with the
 * recorded MIME type and as an attachment-style inline response.
 */
voiceRouter.get(
  '/reports/:id/audio',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const found = await VoiceReport.findById(id).lean();
    if (!found) throw ApiError.notFound(`Voice report ${id} not found`);
    const row = asRow(found);

    // Listening is its own right. A caller outside the scope of the report gets
    // 404 (recordings cannot be enumerated); a caller who may read the report
    // but holds no listen grant (e.g. an Analyst) gets an explicit 403.
    await assertVoiceAccess(req.auth!, asScope(row), 'listen', { requestId: req.requestId, ip: req.ip });
    // Distinct, honest failure: no reference at all is NOT the same as a
    // reference whose object has been lost, and neither is ever the caller's
    // microphone failing.
    if (!row.audio?.storageKey) throw ApiError.audioNotRecorded();

    const bytes = await readVoiceAudio(row.audio.storageKey, {
      checksum: row.audio.checksum ?? null,
    });
    // Binary media response with Range support (200 / 206 / 416). Never JSON:
    // an HTML <audio> element consumes this endpoint directly, and a JSON body
    // with status 200 would present as a silent, unplayable player.
    sendMedia(req, res, {
      bytes,
      contentType: row.audio.mimeType ?? 'application/octet-stream',
      filename: row.audio.filename ?? 'recording.webm',
    });

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.report_played',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      details: `${row.audio.size ?? 0} bytes`,
    });
  }),
);

/**
 * GET /api/voice/reports/:id/audio/download — the recording as a file.
 *
 * Downloading is a *separate* right from listening: crew and hospital staff may
 * play a recording they are entitled to hear but hold no download grant, while
 * an Administrator or an Auditor with authorized-download may export it.
 */
voiceRouter.get(
  '/reports/:id/audio/download',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const found = await VoiceReport.findById(id).lean();
    if (!found) throw ApiError.notFound(`Voice report ${id} not found`);
    const row = asRow(found);

    await assertVoiceAccess(req.auth!, asScope(row), 'download', { requestId: req.requestId, ip: req.ip });
    if (!row.audio?.storageKey) throw ApiError.audioNotRecorded();

    const bytes = await readVoiceAudio(row.audio.storageKey, {
      checksum: row.audio.checksum ?? null,
    });
    const filename = row.audio.filename ?? 'recording.webm';
    sendMedia(req, res, {
      bytes,
      contentType: row.audio.mimeType ?? 'application/octet-stream',
      filename,
      disposition: 'attachment',
    });

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.report_downloaded',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      details: `${filename} (${row.audio.size ?? 0} bytes)`,
    });
  }),
);

/** DELETE /api/voice/reports/:id — discard an unconfirmed draft. */
voiceRouter.delete(
  '/reports/:id',
  authenticate,
  requirePermission(...VOICE_READ_PERMISSIONS),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!VR_ID.test(id)) throw ApiError.badRequest(`Malformed voice report id '${id}'`);
    const report = await VoiceReport.findById(id);
    if (!report) throw ApiError.notFound(`Voice report ${id} not found`);

    // Discarding is destructive, so it needs an explicit delete grant: an
    // administrator/supervisor may drop any draft (`voice:delete`), a creator
    // only their own (`voice:delete:own`). Auditors hold neither — evidence is
    // immutable for them.
    if (!hasPermission(req.auth, P.VOICE_DELETE) && !hasPermission(req.auth, 'voice:delete:own')) {
      throw ApiError.forbidden('You may not discard voice reports');
    }
    const capabilities = await assertVoiceAccess(req.auth!, asScope(asRow(report.toJSON())), 'read', {
      requestId: req.requestId,
      ip: req.ip,
    });
    if (!capabilities.discard) throw ApiError.forbidden('You may not discard this voice report');
    if (report.status === 'CONFIRMED') {
      throw ApiError.conflict(`Voice report ${id} cannot be discarded after confirmation`);
    }

    const storageKey = report.audio?.storageKey;
    const previousState = {
      id,
      status: report.status,
      ownerId: report.ownerId ?? null,
      emergencyId: report.emergencyId ?? null,
      hasRecording: Boolean(storageKey),
    };
    await report.deleteOne();
    // The recording is patient data tied to a discarded draft — remove it too.
    if (storageKey) await deleteVoiceAudio(storageKey);

    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'voice.report_deleted',
      resource: 'VoiceReport',
      resourceId: id,
      requestId: req.requestId,
      ip: req.ip,
      previousState,
      details: `discarded ${storageKey ? 'with recording' : 'without recording'}`,
    });

    res.json({ success: true });
  }),
);


