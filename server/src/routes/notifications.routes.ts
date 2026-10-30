import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { notificationScopeFilter, canReadNotification } from '../authz/access.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Notification } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { recordAudit } from '../services/auditService.js';
import { parsePagination } from '../utils/pagination.js';

export const notificationsRouter = Router();

const NOTIF_ID = /^N-?\d{1,10}$/;

/** GET /api/notifications/unread-count — fast badge counter */
notificationsRouter.get(
  '/unread-count',
  authenticate,
  requirePermission(P.ALERT_READ_ALL, P.ALERT_READ_RELEVANT, P.ALERT_READ_OWN),
  asyncHandler(async (req, res) => {
    const scope = await notificationScopeFilter(req.auth!);
    const unreadCount = await Notification.countDocuments({ ...scope, read: false });
    res.json({ unreadCount });
  }),
);

/** GET /api/notifications — newest first (drawer + alerts page). Supports ?unreadOnly=true and ?category=... */
notificationsRouter.get(
  '/',
  authenticate,
  requirePermission(P.ALERT_READ_ALL, P.ALERT_READ_RELEVANT, P.ALERT_READ_OWN),
  asyncHandler(async (req, res) => {
    const scope = await notificationScopeFilter(req.auth!);
    const filter: Record<string, unknown> = { ...scope };

    if (req.query.unreadOnly === 'true') {
      filter.read = false;
    }
    if (typeof req.query.category === 'string' && req.query.category.trim()) {
      filter.category = req.query.category.trim();
    }
    if (typeof req.query.linkedEmergency === 'string' && req.query.linkedEmergency.trim()) {
      filter.linkedEmergency = req.query.linkedEmergency.trim();
    }

    const { limit, skip } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 100, maxSkip: 10_000 });

    const [notifications, total, unreadCount] = await Promise.all([
      Notification.find(filter).sort({ timestamp: -1, _id: -1 }).skip(skip).limit(limit),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...scope, read: false }),
    ]);

    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Unread-Count', String(unreadCount));
    res.json(notifications);
  }),
);

/** PATCH /api/notifications/:id/read — mark one as read (idempotent). */
notificationsRouter.patch(
  '/:id/read',
  authenticate,
  requirePermission(P.ALERT_READ_ALL, P.ALERT_READ_RELEVANT, P.ALERT_READ_OWN),
  asyncHandler(async (req, res) => {
    if (!NOTIF_ID.test(req.params.id)) throw ApiError.badRequest(`Malformed notification id '${req.params.id}'`);
    const existing = await Notification.findById(req.params.id);
    if (!existing || !(await canReadNotification(req.auth!, existing))) {
      throw ApiError.notFound(`Notification ${req.params.id} not found`);
    }
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { read: true, readAt: new Date() },
      { new: true },
    );
    if (!notification) throw ApiError.notFound(`Notification ${req.params.id} not found`);
    res.json(notification);
  }),
);

/** POST /api/notifications/mark-all-read & PATCH /api/notifications/read-all */
const markAllReadHandler = asyncHandler(async (req, res) => {
  const scope = await notificationScopeFilter(req.auth!);
  const now = new Date();
  const result = await Notification.updateMany({ ...scope, read: false }, { read: true, readAt: now }).exec();

  await recordAudit({
    actor: req.auth!.name,
    actorRole: req.auth!.role as never,
    action: 'notifications.read_all',
    resource: 'Notification',
    resourceId: '*',
    requestId: req.requestId,
    details: `${result.modifiedCount} marked read`,
  });

  res.json({ success: true, modified: result.modifiedCount });
});

notificationsRouter.post(
  '/mark-all-read',
  authenticate,
  requirePermission(P.ALERT_READ_ALL, P.ALERT_READ_RELEVANT, P.ALERT_READ_OWN),
  markAllReadHandler,
);

notificationsRouter.patch(
  '/read-all',
  authenticate,
  requirePermission(P.ALERT_READ_ALL, P.ALERT_READ_RELEVANT, P.ALERT_READ_OWN),
  markAllReadHandler,
);
