import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { hasPermission } from '../authz/access.js';
import { P } from '../authz/permissions.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AIDetection, Emergency, nextId } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { detectionStatusSchema } from '../validation/schemas.js';
import { recordAudit, pushNotification } from '../services/auditService.js';

import { parsePagination } from '../utils/pagination.js';

export const visionRouter = Router();

const DET_ID = /^DET-\d{1,10}$/;

/** GET /api/vision/detections — newest first (bounded pagination). */
visionRouter.get(
  '/detections',
  authenticate,
  requirePermission(P.AI_VIEW),
  asyncHandler(async (req, res) => {
    const { limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100, maxSkip: 10_000 });

    const [detections, total] = await Promise.all([
      AIDetection.find().sort({ timestamp: -1, _id: -1 }).skip(skip).limit(limit),
      AIDetection.countDocuments(),
    ]);

    res.setHeader('X-Total-Count', String(total));
    res.json(detections);
  }),
);

/** GET /api/vision/detections/:id/evidence — permission-controlled evidence export. */
visionRouter.get(
  '/detections/:id/evidence-export',
  authenticate,
  requirePermission(P.AI_EXPORT_EVIDENCE, P.CAMERA_EVIDENCE_EXPORT),
  asyncHandler(async (req, res) => {
    if (!DET_ID.test(req.params.id)) throw ApiError.badRequest(`Malformed detection id '${req.params.id}'`);
    const detection = await AIDetection.findById(req.params.id);
    if (!detection) throw ApiError.notFound(`Detection ${req.params.id} not found`);
    await recordAudit({ actor: req.auth!.name, actorId: req.auth!.userId, actorRole: req.auth!.role, action: 'vision.evidence_exported', resource: 'AIDetection', resourceId: req.params.id, requestId: req.requestId, details: 'evidence export authorized', ip: req.ip, userAgent: req.header('user-agent') });
    res.json({ export: detection.toJSON(), exportedAt: new Date().toISOString(), exportedBy: req.auth!.userId });
  }),
);

visionRouter.get(
  '/detections/:id',
  authenticate,
  requirePermission(P.AI_VIEW),
  asyncHandler(async (req, res) => {
    if (!DET_ID.test(req.params.id)) throw ApiError.badRequest(`Malformed detection id '${req.params.id}'`);
    const detection = await AIDetection.findById(req.params.id);
    if (!detection) throw ApiError.notFound(`Detection ${req.params.id} not found`);
    res.json(detection);
  }),
);

/**
 * PATCH /api/vision/detections/:id/status â€” human review of an AI
 * detection (CONFIRMED / REJECTED / CONVERTED_TO_INCIDENT).
 *
 * Safety protocol (matches the UI banner): AI detections never create
 * emergencies automatically. Only an explicit human CONVERT action here
 * creates the incident, and the audit trail records who did it.
 * Restricted to DISPATCHER, SUPERVISOR, ADMIN.
 */
visionRouter.patch(
  '/detections/:id/status',
  authenticate,
  requirePermission(P.AI_REVIEW, P.AI_CONFIRM, P.AI_REJECT, P.AI_CREATE_EMERGENCY),
  validateBody(detectionStatusSchema),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    if (!DET_ID.test(id)) throw ApiError.badRequest(`Malformed detection id '${id}'`);

    const detection = await AIDetection.findById(id);
    if (!detection) throw ApiError.notFound(`Detection ${id} not found`);
    if (detection.status === 'CONVERTED_TO_INCIDENT') {
      throw ApiError.conflict(`Detection ${id} has already been converted to an incident`);
    }

    const newStatus = req.body.status;
    const requiredPermission = newStatus === 'CONFIRMED' ? P.AI_CONFIRM : newStatus === 'REJECTED' ? P.AI_REJECT : newStatus === 'CONVERTED_TO_INCIDENT' ? P.AI_CREATE_EMERGENCY : P.AI_REVIEW;
    if (!hasPermission(req.auth, requiredPermission)) throw ApiError.forbidden('Your role cannot perform this AI review action');
    const reviewer = req.auth!.name;
    const now = new Date();

    let createdEmergencyId: string | undefined;
    if (newStatus === 'CONVERTED_TO_INCIDENT') {
      // Claim the detection with a conditional update *before* creating the
      // incident. Two reviewers clicking "convert" at once would otherwise both
      // observe a non-converted status and each raise an emergency from the same
      // detection. Exactly one caller can win this update.
      const previousDetectionStatus = detection.status;
      const claimedDetection = await AIDetection.findOneAndUpdate(
        { _id: id, status: previousDetectionStatus },
        { $set: { status: 'CONVERTED_TO_INCIDENT' } },
        { new: true },
      ).exec();
      if (!claimedDetection) throw ApiError.conflict(`Detection ${id} has already been converted to an incident`);
      try {
      // cameraLocation is mandatory on every seeded/created detection.
      const camLoc = detection.cameraLocation ?? { lat: 28.6139, lng: 77.209 };
      // Create the linked emergency explicitly (human-initiated).
      const _id = await nextId('emergency', 'EMG', 5);
      await Emergency.create({
        _id,
        status: 'REPORTED',
        priority: detection.confidence >= 90 ? 'CRITICAL' : 'HIGH',
        incidentType: 'VEHICLE_COLLISION', // current model detects collisions/falls
        location: camLoc,
        source: 'AI_VISION',
        description: `AI Vision (${detection.detectedEvent}, ${detection.confidence}% confidence) at ${detection.cameraId}${camLoc.address ? ` â€” ${camLoc.address}` : ''}. Human-reviewed and confirmed by ${reviewer}.`,
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
        timeline: [{ status: 'REPORTED', timestamp: now, note: `Converted from detection ${id} by ${reviewer}` }],
      });
      createdEmergencyId = _id;
      detection.linkedEmergency = _id;
      } catch (err) {
        // Release the claim rather than leave a detection marked converted with
        // no incident behind it. Conditional on still carrying our value.
        await AIDetection.updateOne(
          { _id: id, status: 'CONVERTED_TO_INCIDENT', linkedEmergency: { $exists: false } },
          { $set: { status: previousDetectionStatus } },
        ).exec();
        throw err;
      }
    }

    detection.status = newStatus;
    detection.reviewedBy = reviewer;
    await detection.save();

    await Promise.allSettled([
      recordAudit({
        actor: req.auth!.name,
        actorRole: req.auth!.role as never,
        action: 'vision.detection_reviewed',
        resource: 'AIDetection',
        resourceId: id,
        requestId: req.requestId,
        details: `â†’ ${newStatus}${createdEmergencyId ? `, created ${createdEmergencyId}` : ''}`,
      }),
      pushNotification({
        category: createdEmergencyId ? 'CRITICAL' : 'INFO',
        title: createdEmergencyId ? 'Detection Converted to Incident' : 'Detection Reviewed',
        message: createdEmergencyId
          ? `${id} confirmed â†’ ${createdEmergencyId} created by ${reviewer}.`
          : `${id} marked ${newStatus} by ${reviewer}.`,
        ...(createdEmergencyId ? { linkedEmergency: createdEmergencyId } : {}),
        linkedResource: id,
      }),
    ]);

    res.json({ ...detection.toJSON(), ...(createdEmergencyId ? { linkedEmergency: createdEmergencyId } : {}) });
  }),
);

