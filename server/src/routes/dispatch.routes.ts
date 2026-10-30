import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { assertCanReadEmergency, toClientEmergency } from '../authz/access.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { recommendAmbulances, recommendHospitals } from '../services/dispatchService.js';
import { evaluateAutomatedDispatchDryRun } from '../services/dispatchDryRunService.js';
import { assignAmbulance } from '../services/emergencyService.js';
import { Emergency } from '../models/index.js';
import { assignSchema } from '../validation/schemas.js';
import { notifyDispatchersOnNoAmbulance } from '../services/notificationService.js';

export const dispatchRouter = Router();

const EMG_ID = /^EMG-\d{1,10}$/;

/** GET /api/dispatch/recommendations/:emergencyId â€” ranked ambulance list. */
dispatchRouter.get(
  '/recommendations/:emergencyId',
  authenticate,
  requirePermission(P.DISPATCH_VIEW),
  asyncHandler(async (req, res) => {
    if (!EMG_ID.test(req.params.emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${req.params.emergencyId}'`);
    }
    const emergency = await Emergency.findById(req.params.emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${req.params.emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);
    const recommendations = await recommendAmbulances(req.params.emergencyId);
    if (recommendations.length === 0) {
      notifyDispatchersOnNoAmbulance(req.params.emergencyId).catch(() => {});
    }
    res.json(recommendations);
  }),
);

/** GET /api/dispatch/hospital-recommendations/:emergencyId â€” ranked hospitals. */
dispatchRouter.get(
  '/hospital-recommendations/:emergencyId',
  authenticate,
  requirePermission(P.DISPATCH_VIEW),
  asyncHandler(async (req, res) => {
    if (!EMG_ID.test(req.params.emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${req.params.emergencyId}'`);
    }
    const emergency = await Emergency.findById(req.params.emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${req.params.emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);
    const recommendations = await recommendHospitals(req.params.emergencyId);
    res.json(recommendations);
  }),
);

/**
 * POST /api/dispatch/assign â€” the human decision that acts on an AI
 * recommendation (recommendation â‰  assignment). Returns 409 when the
 * unit was claimed concurrently. DISPATCHER / SUPERVISOR / ADMIN only.
 */
dispatchRouter.post(
  '/assign',
  authenticate,
  requirePermission(P.DISPATCH_ASSIGN),
  validateBody(assignSchema),
  asyncHandler(async (req, res) => {
    const emergencyId = String(req.body.emergencyId ?? '');
    if (!EMG_ID.test(emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${emergencyId}'`);
    }

    const emergency = await Emergency.findById(emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);
    // Trusted server-side dispatch policy: manual dispatch preserves permissive behavior with structured warnings
    const result = await assignAmbulance(emergencyId, req.body.ambulanceId, {
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role,
      policy: 'MANUAL',
    });

    const updated = await Emergency.findById(emergencyId);
    res.status(201).json({ success: true, ...result, emergency: toClientEmergency(req.auth!, updated!) });
  }),
);

/**
 * POST /api/dispatch/dry-run/:emergencyId — evaluates candidate ranking, telemetry,
 * crew duty, and hospital reservation capacity without committing ambulance claims or reservations.
 */
dispatchRouter.post(
  '/dry-run/:emergencyId',
  authenticate,
  requirePermission(P.DISPATCH_VIEW),
  asyncHandler(async (req, res) => {
    const emergencyId = req.params.emergencyId;
    if (!EMG_ID.test(emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${emergencyId}'`);
    }

    const emergency = await Emergency.findById(emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);

    const result = await evaluateAutomatedDispatchDryRun(emergencyId, {
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role,
    });
    res.json(result);
  }),
);

/**
 * POST /api/dispatch/dry-run — body-based dry run evaluation endpoint.
 */
dispatchRouter.post(
  '/dry-run',
  authenticate,
  requirePermission(P.DISPATCH_VIEW),
  asyncHandler(async (req, res) => {
    const emergencyId = String(req.body?.emergencyId ?? '');
    if (!EMG_ID.test(emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${emergencyId}'`);
    }

    const emergency = await Emergency.findById(emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);

    const result = await evaluateAutomatedDispatchDryRun(emergencyId, {
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role,
    });
    res.json(result);
  }),
);



