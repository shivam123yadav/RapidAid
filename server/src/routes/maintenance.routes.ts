import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { Ambulance, Maintenance, nextId } from '../models/index.js';
import { P } from '../authz/permissions.js';
import { hasPermission, isAssignedCrew } from '../authz/access.js';
import { recordAudit } from '../services/auditService.js';
import { maintenanceCreateSchema, maintenanceUpdateSchema } from '../validation/schemas.js';

export const maintenanceRouter = Router();
const MAINT_ID = /^MNT-\d{1,10}$/;
const AMB_ID = /^AMB-\d{1,10}$/;
const MAINTENANCE_TRANSITIONS: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'APPROVED', 'REJECTED'],
  IN_PROGRESS: ['APPROVED', 'RESOLVED', 'REJECTED'],
  APPROVED: ['IN_PROGRESS', 'RESOLVED', 'REJECTED'],
  RESOLVED: [],
  REJECTED: [],
};
function assertMaintenanceTransition(from: string, to: string): void {
  if (!(MAINTENANCE_TRANSITIONS[from] ?? []).includes(to)) throw ApiError.conflict(`Maintenance request cannot transition from ${from} to ${to}`);
}

maintenanceRouter.get('/', authenticate, requirePermission(P.MAINTENANCE_READ_ALL, P.MAINTENANCE_READ_OWN, P.MAINTENANCE_HISTORY), asyncHandler(async (req, res) => {
  const filter = hasPermission(req.auth, P.MAINTENANCE_READ_ALL) || hasPermission(req.auth, P.MAINTENANCE_HISTORY) ? {} : { reportedBy: req.auth!.userId };
  res.json(await Maintenance.find(filter).sort({ createdAt: -1 }).limit(200));
}));

maintenanceRouter.post('/', authenticate, requirePermission(P.MAINTENANCE_CREATE), validateBody(maintenanceCreateSchema), asyncHandler(async (req, res) => {
  if (!AMB_ID.test(req.body.ambulanceId)) throw ApiError.badRequest('Malformed ambulance id');
  if (!hasPermission(req.auth, P.MAINTENANCE_READ_ALL) && !await isAssignedCrew(req.auth!.userId, req.body.ambulanceId)) throw ApiError.forbidden('You may only report maintenance for your assigned ambulance');
  if (!await Ambulance.exists({ _id: req.body.ambulanceId, active: { $ne: false } })) throw ApiError.badRequest('Ambulance is not active');
  const now = new Date();
  const request = await Maintenance.create({ _id: await nextId('maintenance', 'MNT', 3), ...req.body, status: 'OPEN', reportedBy: req.auth!.userId, createdAt: now, updatedAt: now });
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'maintenance.reported', resource: 'Maintenance', resourceId: request._id, requestId: req.requestId, newState: request.toObject(), ip: req.ip });
  res.status(201).json(request);
}));

maintenanceRouter.patch('/:id', authenticate, requirePermission(P.MAINTENANCE_UPDATE, P.MAINTENANCE_APPROVE), validateBody(maintenanceUpdateSchema), asyncHandler(async (req, res) => {
  if (!MAINT_ID.test(req.params.id)) throw ApiError.badRequest('Malformed maintenance id');
  const previous = await Maintenance.findById(req.params.id).lean(); if (!previous) throw ApiError.notFound(`Maintenance ${req.params.id} not found`);
  const decision = req.body.status === 'APPROVED' || req.body.status === 'REJECTED';
  if (decision && !hasPermission(req.auth, P.MAINTENANCE_APPROVE)) throw ApiError.forbidden('Only a maintenance approver can approve or reject requests');
  if (!hasPermission(req.auth, P.MAINTENANCE_UPDATE) && !decision) throw ApiError.forbidden('You may only approve or reject maintenance decisions');
  if (req.body.status && req.body.status !== previous.status) assertMaintenanceTransition(previous.status, req.body.status);
  if (req.body.status === 'RESOLVED' && !(req.body.resolution ?? previous.resolution)) throw ApiError.badRequest('A resolution is required when completing maintenance');
  const request = await Maintenance.findByIdAndUpdate(req.params.id, { $set: { ...req.body, updatedAt: new Date(), ...(req.body.status === 'RESOLVED' ? { resolvedAt: new Date() } : {}) } }, { new: true, runValidators: true });
  if (!request) throw ApiError.notFound(`Maintenance ${req.params.id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'maintenance.updated', resource: 'Maintenance', resourceId: request._id, requestId: req.requestId, previousState: previous, newState: request.toObject(), reason: req.body.resolution, ip: req.ip });
  res.json(request);
}));
