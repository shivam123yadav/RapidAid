import { AuditLog, Notification, nextId } from '../models/index.js';
import { logger } from '../config/logger.js';
import type { NotificationCategory, Role } from '../validation/constants.js';

export interface AuditInput {
  actor: string;
  actorId?: string;
  actorRole: Role;
  action: string; // e.g. 'emergency.created', 'dispatch.assigned'
  resource: string; // e.g. 'Emergency'
  resourceId: string;
  requestId: string;
  details?: string;
  /** Defaults to SUCCESS; set FAILURE for denials and rejected attempts. */
  result?: 'SUCCESS' | 'FAILURE';
  ip?: string;
  userAgent?: string;
  previousState?: unknown;
  newState?: unknown;
  reason?: string;
}

/**
 * Writes an immutable audit entry. Failures are logged but never thrown —
 * auditing must not break the primary operation (availability first),
 * yet every attempt is traced server-side.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const _id = await nextId('audit', 'A', 3);
    await AuditLog.create({ _id, ...input, timestamp: new Date() });
  } catch (err) {
    logger.error({ err, action: input.action }, 'failed to write audit entry');
  }
}

export interface NotificationInput {
  category: NotificationCategory;
  title: string;
  message: string;
  linkedEmergency?: string;
  linkedResource?: string;
  ownerId?: string;
  hospitalId?: string;
  audienceRoles?: string[];
}

/** Creates a notification row (best-effort, same policy as recordAudit). */
export async function pushNotification(input: NotificationInput): Promise<void> {
  try {
    const _id = await nextId('notification', 'N', 3);
    await Notification.create({ _id, ...input, read: false, timestamp: new Date() });
  } catch (err) {
    logger.error({ err, title: input.title }, 'failed to create notification');
  }
}
