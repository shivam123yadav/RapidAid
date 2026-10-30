import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { P } from '../authz/permissions.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getAnalytics } from '../services/analyticsService.js';

export const analyticsRouter = Router();

/** GET /api/analytics — dashboard time series + aggregates. */
analyticsRouter.get(
  '/',
  authenticate,
  requirePermission(P.REPORT_GENERATE, P.REPORT_READ_ALL),
  asyncHandler(async (_req, res) => {
    res.json(await getAnalytics());
  }),
);
