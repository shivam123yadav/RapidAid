import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Ambulance, Emergency } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import {
  ambulanceTelemetrySchema,
  createAmbulanceSchema,
  updateAmbulanceSchema,
  assignAmbulanceCrewSchema,
} from '../validation/schemas.js';
import { recordAudit } from '../services/auditService.js';
import { runReconciliationSweep, isReconciliationShutdown } from '../services/emergencyService.js';
import { nextId } from '../models/Counter.js';
import { P } from '../authz/permissions.js';
import { ambulanceScopeFilter, hasPermission, assertCanReadAmbulance } from '../authz/access.js';
import { parsePagination } from '../utils/pagination.js';
import { updateAmbulanceRoute } from '../services/routing/routeService.js';
import {
  notifyCitizenOnAmbulanceEnRoute,
  notifyCitizenOnAmbulanceAtScene,
  notifyCitizenOnPatientOnboard,
  notifyCitizenOnArrivalAtHospital,
} from '../services/notificationService.js';


export const ambulancesRouter = Router();

const AMB_ID = /^AMB-\d{1,10}$/;

/**
 * The API exposes crew seats as `{ id, â€¦ }` (see the toJSON transform above)
 * but the model stores the code in `_id`, which is required. Translate on every
 * write path so a client can send the same shape it reads back.
 */
function toCrewDocs(crew: { id: string; [key: string]: unknown }[]): Record<string, unknown>[] {
  return crew.map(({ id, ...rest }) => ({ _id: id, ...rest }));
}

/**
 * True when the caller's login is rostered (crew[].userId) on this ambulance.
 * Single source of truth for "the ambulance assigned to me", used by both the
 * list filter and the telemetry ownership check.
 */
async function isAssignedCrew(userId: string, ambulanceId: string): Promise<boolean> {
  return (await Ambulance.exists({ _id: ambulanceId, 'crew.userId': userId })) !== null;
}

/** GET /api/ambulances — fleet scoped to what the role may see. */
ambulancesRouter.get(
  '/',
  authenticate,
  requirePermission(P.AMBULANCE_VIEW, P.AMBULANCE_VIEW_OWN, P.AMBULANCE_READ_INCOMING, P.TRACKING_VIEW_OWN, P.TRACKING_READ_OWN),
  asyncHandler(async (req, res) => {
    // Crew hold only :own — filter to the unit they are rostered on rather
    // than the whole fleet. CITIZEN with tracking:read:own sees only units assigned to their emergencies.
    // Retired units are omitted from the operational fleet view.
    const filter = await ambulanceScopeFilter(req.auth!);
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200, maxSkip: 10_000 });

    const [ambulances, total] = await Promise.all([
      Ambulance.find({ ...filter, active: { $ne: false } }).sort({ _id: 1 }).skip(skip).limit(limit),
      Ambulance.countDocuments({ ...filter, active: { $ne: false } }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    return res.json(ambulances);
  }),
);

/** GET /api/ambulances/:id — single unit detail, ownership-scoped for crew and citizens. */
ambulancesRouter.get(
  '/:id',
  authenticate,
  requirePermission(P.AMBULANCE_VIEW, P.AMBULANCE_VIEW_OWN, P.AMBULANCE_READ_INCOMING, P.TRACKING_VIEW_OWN, P.TRACKING_READ_OWN),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);
    // 404 rather than 403 for an unauthorized caller, so the
    // response does not reveal that an unassigned ambulance exists.
    const ambulance = await Ambulance.findById(id);
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);
    await assertCanReadAmbulance(req.auth!, ambulance);
    return res.json(ambulance);
  }),
);


/** GET /api/ambulances/:id/route — active road route and dynamic ETA */
ambulancesRouter.get(
  '/:id/route',
  authenticate,
  requirePermission(P.AMBULANCE_VIEW, P.AMBULANCE_VIEW_OWN, P.AMBULANCE_READ_INCOMING, P.TRACKING_VIEW_OWN, P.TRACKING_READ_OWN),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const ambulance = await Ambulance.findById(id);
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);
    await assertCanReadAmbulance(req.auth!, ambulance);

    if (ambulance.currentEmergency && (!ambulance.activeRoute || ambulance.activeRoute.status !== 'SUCCESS')) {
      await updateAmbulanceRoute(id, ambulance.location ?? undefined);
    }
    const fresh = await Ambulance.findById(id);
    return res.json({
      ambulanceId: id,
      activeRoute: fresh?.activeRoute ?? null,
      eta: fresh?.eta ?? null,
      lastUpdated: fresh?.lastUpdated,
    });
  }),
);


/**
 * POST /api/ambulances â€” register a new unit.
 * ADMIN has full control; SUPERVISOR is granted add/edit by the RBAC spec.
 */
ambulancesRouter.post(
  '/',
  authenticate,
  requirePermission(P.AMBULANCE_CREATE),
  validateBody(createAmbulanceSchema),
  asyncHandler(async (req, res) => {
    const _id = await nextId('ambulance', 'AMB', 3);
    const ambulance = await Ambulance.create({
      _id,
      status: req.body.status,
      location: req.body.location,
      speed: 0,
      heading: 0,
      crew: toCrewDocs(req.body.crew),
      capabilities: req.body.capabilities,
      equipment: req.body.equipment,
      lastUpdated: new Date(),
    });

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'ambulance.created',
      resource: 'Ambulance',
      resourceId: _id,
      requestId: req.requestId,
      details: `status=${req.body.status}, crew=${req.body.crew.length}`,
    });

    res.status(201).json(ambulance);
  }),
);

/**
 * POST /api/ambulances/reconcile — on-demand fleet reconciliation sweep.
 * Restricted to supervisors and administrators with AMBULANCE_UPDATE permission.
 */
ambulancesRouter.post(
  '/reconcile',
  authenticate,
  requirePermission(P.AMBULANCE_UPDATE),
  asyncHandler(async (req, res) => {
    if (isReconciliationShutdown()) {
      res.setHeader('Retry-After', '10');
      throw ApiError.serviceUnavailable('Ambulance reconciliation is unavailable: server is shutting down');
    }
    const outcome = await runReconciliationSweep();
    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role as never,
      action: 'ambulance.reconciled_manually',
      resource: 'Ambulance',
      resourceId: 'fleet',
      requestId: req.requestId,
      details: `Manual reconciliation executed: checked=${outcome.checked}, released=${outcome.released.length}, skippedActive=${outcome.skippedActive.length}`,
    });
    res.json(outcome);
  }),
);

/**
 * PATCH /api/ambulances/:id â€” edit ambulance information.
 * Managers only: a DISPATCHER must not be able to modify fleet records.
 */
ambulancesRouter.patch(
  '/:id',
  authenticate,
  requirePermission(P.AMBULANCE_UPDATE),
  validateBody(updateAmbulanceSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const updates: Record<string, unknown> = { lastUpdated: new Date() };
    // `currentEmergency` / `destinationHospital` are deliberately NOT writable
    // here. They are the dispatch claim, and the only code allowed to set or
    // clear them is `assignAmbulance` / `overrideEmergency`, which do so under a
    // guard that also releases whichever unit was displaced. Letting a fleet
    // editor set them directly produced the same stranded-unit state without
    // going through that guard.
    for (const key of [
      'status',
      'location',
      'speed',
      'heading',
      'eta',
      'capabilities',
      'equipment',
      'crew',
    ] as const) {
      if (req.body[key] !== undefined) {
        updates[key] = key === 'crew' ? toCrewDocs(req.body.crew) : req.body[key];
      }
    }

    const ambulance = await Ambulance.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);

    if (updates.crew && ambulance.currentEmergency) {
      await Emergency.updateOne(
        { _id: ambulance.currentEmergency, assignedAmbulance: id },
        {
          $set: {
            assignedCrew: ambulance.crew.length > 0 ? ambulance.crew.map((c) => c.name) : undefined,
            assignedCrewIds: ambulance.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid)),
          },
        },
      ).exec();
    }

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'ambulance.updated',
      resource: 'Ambulance',
      resourceId: id,
      requestId: req.requestId,
      details: Object.keys(updates).filter((k) => k !== 'lastUpdated').join(', '),
    });

    res.json(ambulance);
  }),
);

/**
 * PATCH /api/ambulances/:id/crew â€” assign or clear the crew roster.
 * Binding a seat to a login (`userId`) is what grants that crew member access
 * to the unit, so this stays manager-only.
 */
ambulancesRouter.patch(
  '/:id/crew',
  authenticate,
  requirePermission(P.AMBULANCE_ASSIGN_CREW),
  validateBody(assignAmbulanceCrewSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const ambulance = await Ambulance.findByIdAndUpdate(
      id,
      { crew: toCrewDocs(req.body.crew), lastUpdated: new Date() },
      { new: true, runValidators: true },
    );
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);

    if (ambulance.currentEmergency) {
      await Emergency.updateOne(
        { _id: ambulance.currentEmergency, assignedAmbulance: id },
        {
          $set: {
            assignedCrew: ambulance.crew.length > 0 ? ambulance.crew.map((c) => c.name) : undefined,
            assignedCrewIds: ambulance.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid)),
          },
        },
      );
    }

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'ambulance.crew_assigned',
      resource: 'Ambulance',
      resourceId: id,
      requestId: req.requestId,
      details: `crew=${req.body.crew.length}`,
    });

    res.json(ambulance);
  }),
);

/**
 * PATCH /api/ambulances/:id/status â€” availability tracking.
 * A DISPATCHER may mark a unit AVAILABLE / OFFLINE / MAINTENANCE so they can
 * keep the availability board accurate without gaining record-editing rights.
 * Assignment to an emergency remains the separate /api/dispatch/assign flow.
 */
ambulancesRouter.patch(
  '/:id/status',
  authenticate,
  requirePermission(P.AMBULANCE_STATUS),
  validateBody(z.object({ status: z.enum(['AVAILABLE', 'OFFLINE', 'MAINTENANCE']) })),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const ambulance = await Ambulance.findByIdAndUpdate(
      id,
      { status: req.body.status, lastUpdated: new Date() },
      { new: true },
    );
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'ambulance.status_updated',
      resource: 'Ambulance',
      resourceId: id,
      requestId: req.requestId,
      details: `status=${req.body.status}`,
    });

    res.json(ambulance);
  }),
);


/**
 * PATCH /api/ambulances/:id/telemetry â€” operational status / position / ETA
 * heartbeat (GPS). A crew member may only update the unit they are rostered
 * on; dispatch and management may update any unit.
 */
ambulancesRouter.patch(
  '/:id/telemetry',
  authenticate,
  requirePermission(P.AMBULANCE_TELEMETRY, P.AMBULANCE_STATUS),
  validateBody(ambulanceTelemetrySchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const existing = await Ambulance.findById(id);
    if (!existing) throw ApiError.notFound(`Ambulance ${id} not found`);

    // Ownership check: a crew member cannot touch a unit they are not rostered on.
    // Crew hold only :own permissions, so this applies to every crew caller.
    if (!hasPermission(req.auth, P.AMBULANCE_UPDATE) && !hasPermission(req.auth, P.AMBULANCE_UPDATE_OPERATIONAL) && !(await isAssignedCrew(req.auth!.userId, id))) {
      throw ApiError.forbidden('You can only update telemetry for your assigned ambulance');
    }

    let updateTimestamp = new Date();
    if (req.body.timestamp !== undefined) {
      const ts = new Date(req.body.timestamp);
      if (Number.isNaN(ts.getTime())) {
        throw ApiError.badRequest('Invalid telemetry timestamp');
      }
      const now = Date.now();
      const diffMs = now - ts.getTime();
      if (diffMs < -60000) {
        throw ApiError.badRequest('Telemetry timestamp cannot be in the future (exceeds 60s tolerance)');
      }
      if (diffMs > 300000) {
        throw ApiError.badRequest('Telemetry timestamp is stale (> 300s old)');
      }
      if (existing.lastUpdated && ts.getTime() < new Date(existing.lastUpdated).getTime()) {
        throw ApiError.badRequest('Telemetry timestamp is older than current vehicle state');
      }
      updateTimestamp = ts;
    }

    if (req.body.location) {
      const { lat, lng } = req.body.location;
      if (typeof lat !== 'number' || typeof lng !== 'number' || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        throw ApiError.badRequest('Invalid GPS coordinates');
      }
      if (existing.location && typeof existing.location.lat === 'number' && typeof existing.location.lng === 'number' && existing.lastUpdated) {
        const prevTime = new Date(existing.lastUpdated).getTime();
        const dtSeconds = (updateTimestamp.getTime() - prevTime) / 1000;
        if (dtSeconds > 0) {
          const R = 6371; // Earth radius in km
          const dLat = ((lat - existing.location.lat) * Math.PI) / 180;
          const dLng = ((lng - existing.location.lng) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((existing.location.lat * Math.PI) / 180) *
              Math.cos((lat * Math.PI) / 180) *
              Math.sin(dLng / 2) *
              Math.sin(dLng / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          const distanceKm = R * c;
          const apparentSpeedKmH = (distanceKm / dtSeconds) * 3600;
          if (distanceKm > 0.5 && apparentSpeedKmH > 250) {
            throw ApiError.badRequest(`Impossible telemetry jump: apparent speed (${Math.round(apparentSpeedKmH)} km/h) exceeds physical limits`);
          }
        }
      }
    }

    if (req.body.speed !== undefined && req.body.speed > 250) {
      throw ApiError.badRequest('Reported vehicle speed exceeds physical limits');
    }

    const updates: Record<string, unknown> = {};
    for (const key of ['status', 'location', 'speed', 'heading', 'eta'] as const) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (req.body.isSimulated !== undefined) updates.isSimulated = req.body.isSimulated;
    if (req.body.telemetrySource !== undefined) {
      updates.telemetrySource = req.body.telemetrySource;
    } else if (req.body.isSimulated) {
      updates.telemetrySource = 'SIMULATED';
    }

    if (Object.keys(updates).length === 0 && req.body.timestamp === undefined) {
      throw ApiError.badRequest('No updatable fields supplied');
    }
    updates.lastUpdated = updateTimestamp;

    const ambulance = await Ambulance.findByIdAndUpdate(id, updates, { new: true });
    if (!ambulance) throw ApiError.notFound(`Ambulance ${id} not found`);

    if (ambulance.currentEmergency && updates.location) {
      try {
        await updateAmbulanceRoute(id, ambulance.location ?? undefined);
        const refreshed = await Ambulance.findById(id);
        if (refreshed) {
          ambulance.set('activeRoute', refreshed.activeRoute);
          ambulance.set('eta', refreshed.eta);
        }
      } catch (routeErr) {
        // Never fail valid telemetry ingestion if routing provider experiences issues
      }
    }

    if (ambulance.currentEmergency && updates.status && updates.status !== existing.status) {
      Emergency.findById(ambulance.currentEmergency).lean().then((emergency) => {
        if (emergency) {
          if (updates.status === 'EN_ROUTE') {
            notifyCitizenOnAmbulanceEnRoute(emergency._id, emergency.citizenId, id, ambulance.eta ?? undefined).catch(() => {});
          } else if (updates.status === 'AT_SCENE') {
            notifyCitizenOnAmbulanceAtScene(emergency._id, emergency.citizenId, id).catch(() => {});
          } else if (updates.status === 'PATIENT_ONBOARD') {
            notifyCitizenOnPatientOnboard(emergency._id, emergency.citizenId, id, emergency.destinationHospital).catch(() => {});
          } else if (updates.status === 'AT_HOSPITAL') {
            notifyCitizenOnArrivalAtHospital(emergency._id, emergency.citizenId, emergency.destinationHospital || id).catch(() => {});
          }
        }
      }).catch(() => {});
    }

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: 'ambulance.telemetry_updated',
      resource: 'Ambulance',
      resourceId: id,
      requestId: req.requestId,
      details: Object.keys(updates).join(', '),
    });

    res.json(ambulance);
  }),
);

/**
 * DELETE /api/ambulances/:id â€” retire a unit from the fleet.
 *
 * ADMIN only (the spec gives supervisor edit/assign but not deactivation).
 * Soft-delete by default: the document is flagged inactive + OFFLINE and
 * hidden from fleet reads, because emergency timelines and audit records still
 * reference this _id and a hard delete would orphan that history. Pass
 * `?purge=true` to remove the document outright (admin-only escape hatch for
 * records created in error).
 */
ambulancesRouter.delete(
  '/:id',
  authenticate,
  requirePermission(P.AMBULANCE_DELETE),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!AMB_ID.test(id)) throw ApiError.badRequest(`Malformed ambulance id '${id}'`);

    const existing = await Ambulance.findById(id).lean();
    if (!existing) throw ApiError.notFound(`Ambulance ${id} not found`);

    // A unit mid-incident must not vanish from an active response.
    if (existing.status !== 'AVAILABLE' && existing.status !== 'OFFLINE' && existing.status !== 'MAINTENANCE') {
      throw ApiError.conflict(
        `Ambulance ${id} is ${existing.status} and cannot be retired; release it from its emergency first`,
      );
    }

    const purge = req.query.purge === 'true';
    if (purge) {
      await Ambulance.findByIdAndDelete(id);
    } else {
      await Ambulance.findByIdAndUpdate(id, { active: false, status: 'OFFLINE' });
    }

    await recordAudit({
      actor: req.auth!.name,
      actorRole: req.auth!.role as never,
      action: purge ? 'ambulance.purged' : 'ambulance.deactivated',
      resource: 'Ambulance',
      resourceId: id,
      requestId: req.requestId,
      details: purge ? 'purged' : `retired from status ${existing.status}`,
    });

    if (purge) {
      res.status(204).end();
      return;
    }
    res.json({ success: true, id, active: false });
  }),
);


