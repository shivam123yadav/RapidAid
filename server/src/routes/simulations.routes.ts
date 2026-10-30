import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { simulateGreenCorridor } from '../services/corridorService.js';
import { assertCanReadEmergency } from '../authz/access.js';
import { recordAudit } from '../services/auditService.js';
import { Emergency } from '../models/index.js';

export const simulationsRouter = Router();

const EMG_ID = /^EMG-\d{1,10}$/;

/**
 * GET /api/simulations/green-corridor/:emergencyId â€” deterministic
 * route simulation (baseline vs signal-prioritised ETA).
 */
simulationsRouter.get(
  '/green-corridor/:emergencyId',
  authenticate,
  requirePermission(P.GREEN_CORRIDOR_VIEW),
  asyncHandler(async (req, res) => {
    if (!EMG_ID.test(req.params.emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${req.params.emergencyId}'`);
    }
    const emergency = await Emergency.findById(req.params.emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${req.params.emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);
    const simulation = await simulateGreenCorridor(req.params.emergencyId);
    res.json(simulation);
  }),
);

/**
 * POST /api/simulations/green-corridor/:emergencyId/run â€” explicit
 * "Run Simulation" action; same deterministic engine, audited.
 */
simulationsRouter.post(
  '/green-corridor/:emergencyId/run',
  authenticate,
  requirePermission(P.GREEN_CORRIDOR_CONTROL),
  asyncHandler(async (req, res) => {
    if (!EMG_ID.test(req.params.emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${req.params.emergencyId}'`);
    }
    const emergency = await Emergency.findById(req.params.emergencyId);
    if (!emergency) throw ApiError.notFound(`Emergency ${req.params.emergencyId} not found`);
    await assertCanReadEmergency(req.auth!, emergency);
    const simulation = await simulateGreenCorridor(req.params.emergencyId);

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'simulation.green_corridor_run',
      resource: 'Emergency',
      resourceId: req.params.emergencyId,
      requestId: req.requestId,
      details: `saved ${simulation.timeSaved}s across ${simulation.signalsAffected} signals`,
    });

    res.json(simulation);
  }),
);



