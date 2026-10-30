import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { Ambulance, Shift, User, nextId } from '../models/index.js';
import { P } from '../authz/permissions.js';
import { hasPermission } from '../authz/access.js';
import { recordAudit } from '../services/auditService.js';
import { shiftCreateSchema, shiftStatusSchema, shiftUpdateSchema } from '../validation/schemas.js';

export const shiftsRouter = Router();
const SHIFT_ID = /^SH-\d{1,10}$/;
const noteSchema = z.object({ note: z.string().trim().min(3).max(500) });
function assertShiftId(id: string): void { if (!SHIFT_ID.test(id)) throw ApiError.badRequest('Malformed shift id'); }
async function assertCrewIds(crewIds: string[]): Promise<void> {
  const count = await User.countDocuments({ _id: { $in: crewIds }, role: 'AMBULANCE_CREW', active: { $ne: false } });
  if (count !== crewIds.length) throw ApiError.badRequest('Every shift crew id must be an active ambulance crew account');
}
function assertAssignmentPermissions(auth: Express.Request['auth'], body: { crewIds?: string[]; ambulanceId?: string }): void {
  if (body.crewIds?.length && !hasPermission(auth, P.SHIFT_ASSIGN_CREW)) throw ApiError.forbidden('Assigning shift crew requires shift:assign:crew');
  if (body.ambulanceId && !hasPermission(auth, P.SHIFT_ASSIGN_AMBULANCE)) throw ApiError.forbidden('Assigning an ambulance requires shift:assign:ambulance');
}
function assertShiftTransition(from: string, to: string): void {
  const allowed: Record<string, string[]> = {
    PLANNED: ['ACTIVE', 'CANCELLED'],
    ACTIVE: ['COMPLETED', 'CANCELLED'],
    COMPLETED: [],
    CANCELLED: [],
  };
  if (!(allowed[from] ?? []).includes(to)) throw ApiError.conflict(`Shift cannot transition from ${from} to ${to}`);
}
async function assertAmbulance(id?: string): Promise<void> {
  if (id && !await Ambulance.exists({ _id: id, active: { $ne: false } })) throw ApiError.badRequest('Assigned ambulance is not active');
}

shiftsRouter.get('/', authenticate, requirePermission(P.SHIFT_READ_ALL, P.SHIFT_READ_OWN), asyncHandler(async (req, res) => {
  const filter = hasPermission(req.auth, P.SHIFT_READ_ALL) ? {} : { $or: [{ crewIds: req.auth!.userId }, { createdBy: req.auth!.userId }] };
  res.json(await Shift.find(filter).sort({ startsAt: -1 }).limit(200));
}));

shiftsRouter.get('/:id', authenticate, requirePermission(P.SHIFT_READ_ALL, P.SHIFT_READ_OWN), asyncHandler(async (req, res) => {
  assertShiftId(req.params.id);
  const shift = await Shift.findById(req.params.id);
  if (!shift) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  if (!hasPermission(req.auth, P.SHIFT_READ_ALL) && !shift.crewIds.includes(req.auth!.userId) && shift.createdBy !== req.auth!.userId) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  res.json(shift);
}));

shiftsRouter.post('/', authenticate, requirePermission(P.SHIFT_CREATE), validateBody(shiftCreateSchema), asyncHandler(async (req, res) => {
  assertAssignmentPermissions(req.auth, req.body);
  await assertCrewIds(req.body.crewIds); await assertAmbulance(req.body.ambulanceId);
  const now = new Date();
  const shift = await Shift.create({ _id: await nextId('shift', 'SH', 3), ...req.body, createdBy: req.auth!.userId, createdAt: now, updatedAt: now });
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'shift.created', resource: 'Shift', resourceId: shift._id, requestId: req.requestId, newState: shift.toObject(), ip: req.ip, userAgent: req.header('user-agent') });
  res.status(201).json(shift);
}));

shiftsRouter.patch('/:id', authenticate, requirePermission(P.SHIFT_UPDATE), validateBody(shiftUpdateSchema), asyncHandler(async (req, res) => {
  assertShiftId(req.params.id); assertAssignmentPermissions(req.auth, req.body); if (req.body.crewIds) await assertCrewIds(req.body.crewIds); await assertAmbulance(req.body.ambulanceId);
  const previous = await Shift.findById(req.params.id).lean(); if (!previous) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  const shift = await Shift.findByIdAndUpdate(req.params.id, { $set: { ...req.body, updatedAt: new Date() } }, { new: true, runValidators: true });
  if (!shift) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'shift.updated', resource: 'Shift', resourceId: shift._id, requestId: req.requestId, previousState: previous, newState: shift.toObject(), ip: req.ip, userAgent: req.header('user-agent') });
  res.json(shift);
}));


shiftsRouter.patch('/:id/status', authenticate, validateBody(shiftStatusSchema), asyncHandler(async (req, res) => {
  assertShiftId(req.params.id);
  const permission = req.body.status === 'ACTIVE' ? P.SHIFT_START : P.SHIFT_END;
  if (!hasPermission(req.auth, permission)) throw ApiError.forbidden('Your role cannot perform this shift action');
  const shift = await Shift.findById(req.params.id); if (!shift) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  if (!hasPermission(req.auth, P.SHIFT_UPDATE) && !shift.crewIds.includes(req.auth!.userId) && shift.createdBy !== req.auth!.userId) throw ApiError.forbidden('You may only update your own shift');
  assertShiftTransition(shift.status, req.body.status);
  const previous = shift.toObject(); const now = new Date(); shift.status = req.body.status; shift.updatedAt = now;
  if (req.body.status === 'ACTIVE') shift.startedAt = now; else shift.endedAt = now;
  await shift.save();
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: `shift.${req.body.status.toLowerCase()}`, resource: 'Shift', resourceId: shift._id, requestId: req.requestId, previousState: previous, newState: shift.toObject(), ip: req.ip });
  res.json(shift);
}));

shiftsRouter.patch('/:id/unavailable', authenticate, validateBody(noteSchema), asyncHandler(async (req, res) => {
  assertShiftId(req.params.id); if (!hasPermission(req.auth, P.SHIFT_UNAVAILABLE)) throw ApiError.forbidden('Your role cannot mark shift availability');
  const shift = await Shift.findById(req.params.id); if (!shift) throw ApiError.notFound(`Shift ${req.params.id} not found`);
  if (!shift.crewIds.includes(req.auth!.userId) && !hasPermission(req.auth, P.SHIFT_UPDATE)) throw ApiError.forbidden('You may only report your own shift');
  const previous = shift.toObject(); shift.notes = req.body.note; shift.updatedAt = new Date(); await shift.save();
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'shift.unavailable_reported', resource: 'Shift', resourceId: shift._id, requestId: req.requestId, reason: req.body.note, previousState: previous, newState: shift.toObject(), ip: req.ip });
  res.json(shift);
}));
