import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { Camera, nextId } from '../models/index.js';
import { hasPermission } from '../authz/access.js';
import { P } from '../authz/permissions.js';
import { recordAudit } from '../services/auditService.js';
import { cameraCreateSchema, cameraUpdateSchema } from '../validation/schemas.js';

export const camerasRouter = Router();
const CAM_ID = /^CAM-[A-Z0-9-]{1,40}$/;
function assertCameraId(id: string): void { if (!CAM_ID.test(id)) throw ApiError.badRequest('Malformed camera id'); }
function cameraProjection(auth: Express.Request['auth']): Record<string, 0> {
  return hasPermission(auth, P.CAMERA_EVIDENCE_VIEW) || hasPermission(auth, P.CAMERA_RECORDING_VIEW)
    ? {}
    : { recordingEnabled: 0, retentionDays: 0 };
}

camerasRouter.get('/', authenticate, requirePermission(P.CAMERA_LIVE_VIEW, P.CAMERA_RECORDING_VIEW, P.CAMERA_EVIDENCE_VIEW), asyncHandler(async (req, res) => {
  res.json(await Camera.find({}).select(cameraProjection(req.auth)).sort({ _id: 1 }));
}));

camerasRouter.get('/:id', authenticate, requirePermission(P.CAMERA_LIVE_VIEW, P.CAMERA_RECORDING_VIEW, P.CAMERA_EVIDENCE_VIEW), asyncHandler(async (req, res) => {
  assertCameraId(req.params.id); const camera = await Camera.findById(req.params.id).select(cameraProjection(req.auth)); if (!camera) throw ApiError.notFound(`Camera ${req.params.id} not found`); res.json(camera);
}));

camerasRouter.post('/', authenticate, requirePermission(P.CAMERA_CREATE), validateBody(cameraCreateSchema), asyncHandler(async (req, res) => {
  if (!hasPermission(req.auth, P.CAMERA_CONFIGURE)) throw ApiError.forbidden('Creating camera configuration requires camera:configure');
  const now = new Date(); const camera = await Camera.create({ _id: await nextId('camera', 'CAM', 3), ...req.body, status: 'ONLINE', createdAt: now, updatedAt: now });
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'camera.created', resource: 'Camera', resourceId: camera._id, requestId: req.requestId, newState: camera.toObject(), ip: req.ip });
  res.status(201).json(camera);
}));

camerasRouter.patch('/:id', authenticate, requirePermission(P.CAMERA_UPDATE, P.CAMERA_CONFIGURE), validateBody(cameraUpdateSchema), asyncHandler(async (req, res) => {
  assertCameraId(req.params.id); if (Object.keys(req.body).some((key) => ['retentionDays', 'recordingEnabled', 'liveEnabled'].includes(key)) && !hasPermission(req.auth, P.CAMERA_CONFIGURE)) throw ApiError.forbidden('Camera configuration requires camera:configure');
  const previous = await Camera.findById(req.params.id).lean(); if (!previous) throw ApiError.notFound(`Camera ${req.params.id} not found`);
  const camera = await Camera.findByIdAndUpdate(req.params.id, { $set: { ...req.body, updatedAt: new Date() } }, { new: true, runValidators: true }); if (!camera) throw ApiError.notFound(`Camera ${req.params.id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'camera.updated', resource: 'Camera', resourceId: camera._id, requestId: req.requestId, previousState: previous, newState: camera.toObject(), ip: req.ip });
  res.json(camera);
}));

camerasRouter.delete('/:id', authenticate, requirePermission(P.CAMERA_DELETE), asyncHandler(async (req, res) => {
  assertCameraId(req.params.id); const previous = await Camera.findByIdAndDelete(req.params.id).lean(); if (!previous) throw ApiError.notFound(`Camera ${req.params.id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'camera.deleted', resource: 'Camera', resourceId: req.params.id, requestId: req.requestId, previousState: previous, ip: req.ip });
  res.status(204).end();
}));

camerasRouter.get('/:id/evidence-export', authenticate, requirePermission(P.CAMERA_EVIDENCE_EXPORT), asyncHandler(async (req, res) => {
  assertCameraId(req.params.id); const camera = await Camera.findById(req.params.id); if (!camera) throw ApiError.notFound(`Camera ${req.params.id} not found`);
  await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'camera.evidence_exported', resource: 'Camera', resourceId: camera._id, requestId: req.requestId, ip: req.ip, userAgent: req.header('user-agent') });
  res.json({ camera, exportedAt: new Date().toISOString(), exportedBy: req.auth!.userId });
}));

