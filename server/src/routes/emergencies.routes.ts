import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { emergencyScopeFilter, assertCanReadEmergency, canReadEmergency, hasPermission, toClientEmergency, toClientEmergencySummary } from '../authz/access.js';
import { P } from '../authz/permissions.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Emergency, VoiceReport } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import {
  createEmergency,
  transitionEmergency,
  overrideEmergency,
  syncEmergencyCrewFromAmbulance,
  syncEmergenciesCrewFromAmbulances,
} from '../services/emergencyService.js';
import { recordAudit, pushNotification } from '../services/auditService.js';
import { createEmergencySchema, updateStatusSchema, emergencyOverrideSchema } from '../validation/schemas.js';
import { createVoiceScopeCache, voiceCapabilities, type VoiceReportScope } from '../authz/voiceReportAccess.js';
import { idempotent, formatScopedIdempotencyKey } from '../middleware/idempotency.js';
import { parsePagination } from '../utils/pagination.js';
import { emergencyReportLimiter } from '../middleware/rateLimit.js';
import type { AuthContext } from '../authz/access.js';

export const emergenciesRouter = Router();

/**
 * Every permission that admits a caller to a voice report in *some* scope.
 * Mirrors the guard list in `voice.routes.ts`; a role holding none of these must
 * not even cost the lookup performed by `originatingVoiceReport`.
 */
const VOICE_LINK_PERMISSIONS = [
  P.VOICE_READ_ALL,
  P.VOICE_READ_OWN,
  P.VOICE_READ_ASSIGNED,
  P.VOICE_READ_HOSPITAL,
  P.VOICE_READ_RELEVANT,
  P.VOICE_READ_HISTORICAL,
  P.VOICE_READ_ANALYTICAL,
  P.VOICE_EVIDENCE_VIEW,
] as const;

/**
 * The voice report this emergency was raised from, or `null`.
 *
 * Crew and hospital staff must be able to reach the transcript and recording of
 * the incident they are actually working, rather than hunting for it in the
 * voice workspace. `VoiceReport.emergencyId` already points back here, so the
 * link is *derived* on read and never denormalized onto `Emergency` — a report
 * therefore cannot drift away from the emergency it produced.
 *
 * Authorization is delegated wholesale to `voiceCapabilities`, the same
 * evaluation behind `GET /api/voice/reports/:id`, so this link can never be more
 * permissive than the voice workspace itself. A caller the authorizer places out
 * of scope gets `null` rather than a 403, because the emergency itself remains
 * legitimately readable for them.
 *
 * Metadata only — no transcript, no storage key, no audio bytes. Opening the
 * report goes through the voice routes, which enforce the same scopes again and
 * supply the detail on demand.
 */
async function originatingVoiceReport(
  auth: AuthContext,
  emergency: { _id: string; status?: string | null; assignedDispatcher?: string | null; assignedCrewIds?: string[] | null; assignedAmbulance?: string | null; destinationHospital?: string | null },
): Promise<Record<string, unknown> | null> {
  if (!VOICE_LINK_PERMISSIONS.some((permission) => hasPermission(auth, permission))) return null;

  const found = await VoiceReport.findOne({ emergencyId: emergency._id }).lean();
  if (!found) return null;

  const row = found as unknown as { _id: string; status?: string | null; createdAt?: Date | string | null };
  // The emergency is already loaded, so seed the scope cache with it rather than
  // making `relationsFor` re-query the same document for one report.
  const cache = createVoiceScopeCache();
  cache.emergencies.set(emergency._id, {
    _id: emergency._id,
    status: emergency.status,
    assignedDispatcher: emergency.assignedDispatcher,
    assignedCrewIds: emergency.assignedCrewIds,
    assignedAmbulance: emergency.assignedAmbulance,
    destinationHospital: emergency.destinationHospital,
  });

  const capabilities = await voiceCapabilities(auth, found as unknown as VoiceReportScope, cache);
  if (!capabilities.read) return null;

  return {
    id: row._id,
    status: row.status ?? 'DRAFT',
    createdAt: row.createdAt ?? null,
    /** "Assigned Emergency", "Audit Evidence"… rendered as the access indicator. */
    accessLabel: capabilities.accessLabel,
    /** Server-derived action flags. Every control in the UI gates on these. */
    capabilities,
  };
}

/**
 * GET /api/emergencies â€” list all emergencies, newest reports first.
 * Authenticated (any role); the UI reads this for every operational page.
 */
emergenciesRouter.get(
  '/',
  authenticate,
  requirePermission(P.EMERGENCY_READ_ALL, P.EMERGENCY_READ_OWN, P.EMERGENCY_READ_ASSIGNED, P.EMERGENCY_READ_RELEVANT, P.EMERGENCY_READ_HISTORICAL),
  asyncHandler(async (req, res) => {
    const filter = await emergencyScopeFilter(req.auth!);

    // The collection is unbounded and each row may carry ~10.7 MB of base64
    // photos, so the list is paged and photos are summarized (see
    // `toClientEmergencySummary`). A client that needs the full record — photos
    // included — fetches `GET /api/emergencies/:id`, which enforces the same
    // scope filter plus the detailed patient rules.
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200, maxSkip: 10_000 });

    const [emergencies, total] = await Promise.all([
      Emergency.find(filter).sort({ reportedAt: -1, _id: -1 }).skip(skip).limit(limit),
      Emergency.countDocuments(filter),
    ]);

    await syncEmergenciesCrewFromAmbulances(emergencies);

    res.setHeader('X-Total-Count', String(total));
    res.json(emergencies.map((emergency) => toClientEmergencySummary(req.auth!, emergency)));
  }),
);

/**
 * GET /api/emergencies/:id â€” single emergency detail incl. timeline.
 * :id must look like EMG-##### (guards against arbitrary Mongo queries).
 */
emergenciesRouter.get(
  '/:id',
  authenticate,
  requirePermission(P.EMERGENCY_READ_ALL, P.EMERGENCY_READ_OWN, P.EMERGENCY_READ_ASSIGNED, P.EMERGENCY_READ_RELEVANT, P.EMERGENCY_READ_HISTORICAL),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!/^EMG-\d{1,10}$/.test(id)) throw ApiError.badRequest(`Malformed emergency id '${id}'`);
    const emergency = await Emergency.findById(id);
    if (!emergency) throw ApiError.notFound(`Emergency ${id} not found`);
    await syncEmergencyCrewFromAmbulance(emergency);
    await assertCanReadEmergency(req.auth!, emergency);
    const payload = toClientEmergency(req.auth!, emergency);
    // Additive and optional: a role with no voice grant simply gets `null`, and
    // the emergency itself is never withheld because of it.
    payload.voiceReport = await originatingVoiceReport(req.auth!, emergency);
    res.json(payload);
  }),
);

/**
 * POST /api/emergencies â€” create a new incident (citizen/voice/ai sources).
 * Any authenticated role may report; status always starts at REPORTED.
 * Optional `attachments` carry base64 image data URLs (see attachmentSchema).
 */
emergenciesRouter.post(
  '/',
  authenticate,
  emergencyReportLimiter,
  requirePermission(P.EMERGENCY_CREATE),
  validateBody(createEmergencySchema),
  idempotent({ endpoint: 'POST /api/emergencies' }),
  asyncHandler(async (req, res) => {
    const rawKey = req.header('idempotency-key')?.trim() || req.header('x-idempotency-key')?.trim();
    const idempotencyKey = rawKey
      ? formatScopedIdempotencyKey(req.auth!.userId, 'POST /api/emergencies', rawKey)
      : undefined;
    const body = {
      ...req.body,
      source: req.auth!.role === 'CITIZEN' ? 'CITIZEN_REPORT' : req.body.source,
      citizenId: req.auth!.role === 'CITIZEN' ? req.auth!.userId : undefined,
      assignedDispatcher: ['DISPATCHER', 'SUPERVISOR', 'ADMIN'].includes(req.auth!.role) ? req.auth!.userId : undefined,
      idempotencyKey,
    };
    const { id } = await createEmergency(body);
    const photoCount = req.body.attachments.length;

    await Promise.allSettled([
      recordAudit({
        actor: req.auth!.name,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role as never,
        action: 'emergency.created',
        resource: 'Emergency',
        resourceId: id,
        requestId: req.requestId,
        details: `${req.body.incidentType} (${req.body.priority}) via ${req.body.source}${
          photoCount ? ` + ${photoCount} photo${photoCount === 1 ? '' : 's'}` : ''
        }`,
      }),
      pushNotification({
        category: req.body.priority === 'CRITICAL' ? 'CRITICAL' : req.body.priority === 'HIGH' ? 'WARNING' : 'INFO',
        title: `New Emergency â€” ${req.body.incidentType.replace(/_/g, ' ')}`,
        message: `${id}: new ${req.body.incidentType.replace(/_/g, ' ').toLowerCase()} report (${req.body.victimCount} affected)`,
        linkedEmergency: id,
      }),
    ]);

    const created = await Emergency.findById(id);
    res.status(201).json(toClientEmergency(req.auth!, created!));
  }),
);

/**
 * PATCH /api/emergencies/:id/status â€” state-machine validated transition.
 * Allowed: DISPATCHER, AMBULANCE_CREW (crew close out their own
 * incidents), SUPERVISOR, ADMIN. Hospital/auditor/analyst/citizen = 403.
 */
emergenciesRouter.patch(
  '/:id/status',
  authenticate,
  requirePermission(P.EMERGENCY_UPDATE, P.EMERGENCY_UPDATE_ASSIGNED, P.EMERGENCY_CLOSE),
  validateBody(updateStatusSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!/^EMG-\d{1,10}$/.test(id)) throw ApiError.badRequest(`Malformed emergency id '${id}'`);

    const emergency = await Emergency.findById(id);
    if (!emergency) throw ApiError.notFound(`Emergency ${id} not found`);
    if (hasPermission(req.auth, P.EMERGENCY_UPDATE_ASSIGNED) && !hasPermission(req.auth, P.EMERGENCY_UPDATE)) {
      if (!(await canReadEmergency(req.auth!, emergency))) throw ApiError.forbidden('You may only update your assigned emergency');
    } else {
      await assertCanReadEmergency(req.auth!, emergency);
    }
    await transitionEmergency(id, req.body.status, {
      note: req.body.note,
      currentStatus: req.body.currentStatus,
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role,
    });

    const updated = await Emergency.findById(id);
    res.json(toClientEmergency(req.auth!, updated!));
  }),
);

/** POST /api/emergencies/:id/override — controlled break-glass operations. */
emergenciesRouter.post(
  '/:id/override',
  authenticate,
  requirePermission(P.EMERGENCY_OVERRIDE),
  validateBody(emergencyOverrideSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!/^EMG-\d{1,10}$/.test(id)) throw ApiError.badRequest(`Malformed emergency id '${id}'`);
    const { previousState: _previousState, newState: _newState, ...result } = await overrideEmergency(id, req.body, { requestId: req.requestId, actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, ip: req.ip, userAgent: req.header('user-agent') });
    const emergency = await Emergency.findById(id);
    if (!emergency) throw ApiError.notFound(`Emergency ${id} not found`);
    res.json({ success: true, ...result, emergency: toClientEmergency(req.auth!, emergency) });
  }),
);


