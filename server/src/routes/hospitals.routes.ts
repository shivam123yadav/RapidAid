import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Hospital } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { P } from '../authz/permissions.js';
import {
  canReadHospital,
  hospitalScopeFilter,
  hasPermission,
  assertCanUpdateHospitalCapacity,
  assertCanChangeHospitalLifecycle,
  assertNoMasterDataInOperationalBody,
  type AuthContext,
} from '../authz/access.js';
import {
  createHospitalSchema,
  updateHospitalMasterDataSchema,
  updateHospitalOperationalSchema,
  deactivateHospitalSchema,
  reactivateHospitalSchema,
} from '../validation/schemas.js';
import { recordAudit } from '../services/auditService.js';
import {
  createHospital,
  updateHospitalMasterData,
  updateHospitalOperational,
  toClientHospital,
  type HospitalAuditContext,
} from '../services/hospitalService.js';
import type { Role } from '../validation/constants.js';
import { parsePagination } from '../utils/pagination.js';
import {
  releaseHospitalReservation,
  rerouteHospitalReservation,
  reconcileHospitalReservations,
} from '../services/hospitalReservationService.js';

export const hospitalsRouter = Router();

const HOSP_ID = /^HOSP-\d{1,10}$/;

/** Rejects a malformed path id before it reaches the database. */
function assertHospitalId(id: string): void {
  if (!HOSP_ID.test(id)) throw ApiError.badRequest(`Malformed hospital id '${id}'`);
}

/** True when the caller may see the full master-data record (not just live capacity). */
function canReadFullRecord(auth: AuthContext): boolean {
  return (
    hasPermission(auth, P.HOSPITAL_READ_ALL) ||
    hasPermission(auth, P.HOSPITAL_READ_HISTORICAL) ||
    hasPermission(auth, P.HOSPITAL_READ_OWN)
  );
}

/** Narrow projection for operational viewers (dispatcher, citizen, crew). */
const OPERATIONAL_PROJECTION =
  'name status location emergencyCapacity icuCapacity traumaAvailable capabilities incomingAmbulances currentLoad estimatedWaitingTimeMinutes phone';

/** Standard audit envelope (actor, role, request id, IP + user agent) for one request. */
function auditFields(req: {
  auth?: AuthContext;
  requestId: string;
  ip?: string;
  header(name: string): string | undefined;
}): { actor: string; actorId?: string; actorRole: Role; requestId: string; ip?: string; userAgent?: string } {
  return {
    actor: req.auth?.name ?? 'anonymous',
    actorId: req.auth?.userId,
    actorRole: (req.auth?.role ?? 'CITIZEN') as Role,
    requestId: req.requestId,
    ip: req.ip,
    userAgent: req.header('user-agent'),
  };
}

/** Audit-context envelope handed to the hospital service layer. */
function auditContext(req: {
  auth?: AuthContext;
  requestId: string;
  ip?: string;
  header(name: string): string | undefined;
}): HospitalAuditContext {
  return { auth: req.auth!, requestId: req.requestId, ip: req.ip, userAgent: req.header('user-agent') };
}

/** GET /api/hospitals — network capacity overview, scoped per role. */
hospitalsRouter.get(
  '/',
  authenticate,
  requirePermission(P.HOSPITAL_READ_ALL, P.HOSPITAL_READ_OWN, P.HOSPITAL_READ_RELEVANT, P.HOSPITAL_READ_HISTORICAL),
  asyncHandler(async (req, res) => {
    const fullView = canReadFullRecord(req.auth!);
    const filter = await hospitalScopeFilter(req.auth!);
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 200, maxSkip: 10_000 });

    const query = Hospital.find(filter);
    if (!fullView) query.select(OPERATIONAL_PROJECTION);
    const [hospitals, total] = await Promise.all([
      query.sort({ _id: 1 }).skip(skip).limit(limit),
      Hospital.countDocuments(filter),
    ]);
    // Centralized minimization: public/operational roles never receive
    // registration numbers, review notes or deactivation reasons.
    res.setHeader('X-Total-Count', String(total));
    res.json(hospitals.map((hospital) => toClientHospital(req.auth!, hospital)));
  }),
);

/** GET /api/hospitals/:id — single facility detail, own-hospital scoped. */
hospitalsRouter.get(
  '/:id',
  authenticate,
  requirePermission(P.HOSPITAL_READ_ALL, P.HOSPITAL_READ_OWN, P.HOSPITAL_READ_RELEVANT, P.HOSPITAL_READ_HISTORICAL),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertHospitalId(id);
    if (!(await canReadHospital(req.auth!, id))) {
      // 403 here is correct: the caller authenticated and the hospital exists,
      // they simply have no business reading this facility's record. Logged as
      // FAILURE evidence because a cross-hospital probe is exactly what a
      // compliance reviewer needs to see.
      void recordAudit({
        ...auditFields(req),
        action: 'permission.denied',
        resource: 'Hospital',
        resourceId: id,
        details: `role=${req.auth!.role} attempted cross-hospital read`,
        result: 'FAILURE',
      });
      throw ApiError.forbidden('You may only access your own hospital');
    }
    const fullView = canReadFullRecord(req.auth!);
    const hospital = fullView
      ? await Hospital.findById(id)
      : await Hospital.findById(id).select(OPERATIONAL_PROJECTION);
    if (!hospital) throw ApiError.notFound(`Hospital ${id} not found`);
    res.json(toClientHospital(req.auth!, hospital));
  }),
);

/** POST /api/hospitals — Administrator only (hospital:create). */
hospitalsRouter.post(
  '/',
  authenticate,
  requirePermission(P.HOSPITAL_CREATE),
  validateBody(createHospitalSchema),
  asyncHandler(async (req, res) => {
    const hospital = await createHospital(req.body, auditContext(req));
    res.status(201).json(toClientHospital(req.auth!, hospital));
  }),
);

/**
 * PATCH /api/hospitals/:id — master-data edit (name, registration, location,
 * contact). Deliberately limited to `hospital:update:all`, so operational
 * capacity cannot be smuggled through this route to bypass the ownership
 * checks on /capacity.
 */
hospitalsRouter.patch(
  '/:id',
  authenticate,
  requirePermission(P.HOSPITAL_UPDATE),
  validateBody(updateHospitalMasterDataSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertHospitalId(id);
    const { reason, ...updates } = req.body as Record<string, unknown> & { reason?: string };
    const hospital = await updateHospitalMasterData(id, updates, auditContext(req), reason);
    res.json(toClientHospital(req.auth!, hospital));
  }),
);

/**
 * PATCH /api/hospitals/:id/capacity — operational write. Admin/Supervisor may
 * write any facility; Hospital Staff only their own, proved against
 * `auth.hospitalId` (server-side identity) rather than the path id.
 */
hospitalsRouter.patch(
  '/:id/capacity',
  authenticate,
  requirePermission(P.HOSPITAL_CAPACITY_UPDATE, P.HOSPITAL_CAPACITY_UPDATE_OWN, P.HOSPITAL_UPDATE_OPERATIONAL, P.HOSPITAL_UPDATE_OWN),
  validateBody(updateHospitalOperationalSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertHospitalId(id);
    // Defence in depth: the zod schema already drops master fields, so this is
    // not what stops a hospital-staff caller editing them. It is here so a
    // smuggled master field is an explicit 403 rather than a silent drop that
    // looks like success.
    assertNoMasterDataInOperationalBody(req.auth!, req.body);
    assertCanUpdateHospitalCapacity(req.auth!, id);
    const { reason, ...updates } = req.body as Record<string, unknown> & { reason?: string };
    const hospital = await updateHospitalOperational(id, updates, auditContext(req), reason);
    res.json(toClientHospital(req.auth!, hospital));
  }),
);

hospitalsRouter.delete(
  '/:id',
  authenticate,
  requirePermission(P.HOSPITAL_DEACTIVATE),
  validateBody(deactivateHospitalSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertHospitalId(id);
    assertCanChangeHospitalLifecycle(req.auth!, 'deactivate');
    const previous = await Hospital.findById(id).lean();
    if (!previous) throw ApiError.notFound(`Hospital ${id} not found`);
    if (previous.active === false) throw ApiError.conflict(`Hospital ${id} is already deactivated`);
    const now = new Date();
    const hospital = await Hospital.findByIdAndUpdate(
      id,
      {
        $set: {
          active: false,
          status: 'OFFLINE',
          operationalStatus: 'OFFLINE',
          deactivatedAt: now,
          deactivatedBy: req.auth!.userId,
          deactivationReason: req.body.reason,
        },
      },
      { new: true, runValidators: true },
    );
    await recordAudit({ ...auditFields(req), action: 'hospital.deactivated', resource: 'Hospital', resourceId: id, reason: req.body.reason, previousState: previous, newState: hospital?.toObject() });
    // Historical emergency, ambulance and audit rows referencing this id
    // are intentionally left untouched so the facility's history survives.
    res.json({ success: true, id, active: false, deactivationReason: req.body.reason });
  }),
);

/** POST /api/hospitals/:id/reactivate — Administrator only. */
hospitalsRouter.post(
  '/:id/reactivate',
  authenticate,
  requirePermission(P.HOSPITAL_ACTIVATE),
  validateBody(reactivateHospitalSchema),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertHospitalId(id);
    assertCanChangeHospitalLifecycle(req.auth!, 'activate');
    const previous = await Hospital.findById(id).lean();
    if (!previous) throw ApiError.notFound(`Hospital ${id} not found`);
    if (previous.active !== false) throw ApiError.conflict(`Hospital ${id} is already active`);
    const now = new Date();
    const hospital = await Hospital.findByIdAndUpdate(
      id,
      {
        $set: {
          active: true,
          status: 'OPERATIONAL',
          operationalStatus: 'OPERATIONAL',
          reactivatedAt: now,
          reactivatedBy: req.auth!.userId,
          deactivatedAt: undefined,
          deactivatedBy: undefined,
          deactivationReason: undefined,
        },
      },
      { new: true, runValidators: true },
    );
    await recordAudit({ ...auditFields(req), action: 'hospital.reactivated', resource: 'Hospital', resourceId: id, reason: req.body.reason, previousState: previous, newState: hospital?.toObject() });
    res.json({ success: true, id, active: true });
  }),
);

/** POST /api/hospitals/:id/reserve — reserve capacity at a hospital */
hospitalsRouter.post(
  '/:id/reserve',
  authenticate,
  requirePermission(P.DISPATCH_ASSIGN, P.HOSPITAL_CAPACITY_UPDATE, P.HOSPITAL_CAPACITY_UPDATE_OWN),
  asyncHandler(async (req, res) => {
    assertHospitalId(req.params.id);
    const emergencyId = String(req.body?.emergencyId ?? '');
    if (!/^EMG-\d{1,10}$/.test(emergencyId)) {
      throw ApiError.badRequest(`Malformed emergency id '${emergencyId}'`);
    }
    const resourceType = req.body?.resourceType ?? 'EMERGENCY_ACCEPTANCE';
    const reservation = await rerouteHospitalReservation(emergencyId, req.params.id, resourceType, {
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role as Role,
      notes: req.body?.notes,
    });
    res.status(201).json({ success: true, reservation });
  }),
);

/** POST /api/hospitals/reservations/:id/release — release a reservation */
hospitalsRouter.post(
  '/reservations/:id/release',
  authenticate,
  requirePermission(P.DISPATCH_ASSIGN, P.HOSPITAL_CAPACITY_UPDATE, P.HOSPITAL_CAPACITY_UPDATE_OWN),
  asyncHandler(async (req, res) => {
    const reservationId = req.params.id;
    const result = await releaseHospitalReservation(reservationId, {
      requestId: req.requestId,
      actor: req.auth!.name,
      actorRole: req.auth!.role as Role,
      reason: req.body?.reason ?? 'MANUAL_API_RELEASE',
    });
    res.json({ success: true, ...result });
  }),
);

/** POST /api/hospitals/reconcile-reservations — run reservation reconciliation scan */
hospitalsRouter.post(
  '/reconcile-reservations',
  authenticate,
  requirePermission(P.DISPATCH_ASSIGN, P.SETTINGS_OPERATIONAL),
  asyncHandler(async (req, res) => {
    const outcome = await reconcileHospitalReservations({
      hospitalId: typeof req.body?.hospitalId === 'string' ? req.body.hospitalId : undefined,
      excludeEmergencyIds: Array.isArray(req.body?.excludeEmergencyIds) ? req.body.excludeEmergencyIds : undefined,
    });
    res.json({ success: true, ...outcome });
  }),
);


