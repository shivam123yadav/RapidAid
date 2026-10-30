import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { AuditLog } from '../models/index.js';
import { toClientAudit } from '../authz/access.js';
import { P, canIn } from '../authz/permissions.js';

export const auditRouter = Router();

/**
 * GET /api/audit — newest-first audit trail (max 500 rows).
 *
 * Permission-driven rather than a role list, so it tracks the registry:
 *  - AUDIT_VIEW      (ADMIN, SUPERVISOR, ANALYST, AUDITOR) → the full trail.
 *  - AUDIT_VIEW_OWN  (CREW, HOSPITAL_STAFF)                 → own actions only.
 *  - DISPATCHER / CITIZEN hold neither → 403, per the matrix ("No Access").
 * The trail is append-only; there is no route that edits or deletes evidence.
 */
auditRouter.get(
  '/',
  authenticate,
  requirePermission(P.AUDIT_VIEW, P.AUDIT_VIEW_OWN),
  asyncHandler(async (req, res) => {
    const full = canIn(req.auth!.permissions, P.AUDIT_VIEW) || canIn(req.auth!.permissions, P.AUDIT_READ_ALL);
    // Scoped strictly on `actorId`. Matching on the display name as well let a
    // user read a colleague's trail simply by calling PATCH /auth/me to rename
    // themselves — `actor` is free text and is not unique.
    const filter = full ? {} : { actorId: req.auth!.userId };
    const entries = await AuditLog.find(filter).sort({ timestamp: -1 }).limit(500);
    res.json(entries.map((entry) => toClientAudit(req.auth!, entry)));
  }),
);
