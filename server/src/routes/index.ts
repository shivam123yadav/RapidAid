import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { emergenciesRouter } from './emergencies.routes.js';
import { ambulancesRouter } from './ambulances.routes.js';
import { hospitalsRouter } from './hospitals.routes.js';
import { visionRouter } from './vision.routes.js';
import { dispatchRouter } from './dispatch.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { auditRouter } from './audit.routes.js';
import { systemRouter, cspReportParser, cspReportHandler } from './system.routes.js';
import { cspReportLimiter } from '../middleware/rateLimit.js';
import { analyticsRouter } from './analytics.routes.js';
import { voiceRouter } from './voice.routes.js';
import { simulationsRouter } from './simulations.routes.js';
import { adminRouter } from './admin.routes.js';
import { shiftsRouter } from './shifts.routes.js';
import { maintenanceRouter } from './maintenance.routes.js';
import { camerasRouter } from './cameras.routes.js';
import { reportsRouter } from './reports.routes.js';
import { notFoundHandler } from '../middleware/errorHandler.js';

export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/emergencies', emergenciesRouter);
apiRouter.use('/ambulances', ambulancesRouter);
apiRouter.use('/hospitals', hospitalsRouter);
apiRouter.use('/vision', visionRouter);
apiRouter.use('/dispatch', dispatchRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/audit', auditRouter);
apiRouter.use('/system', systemRouter);
// Direct CSP report endpoint matching report-uri /api/csp-report
apiRouter.post('/csp-report', cspReportLimiter, cspReportParser, cspReportHandler);
apiRouter.use('/analytics', analyticsRouter);
apiRouter.use('/voice', voiceRouter);
apiRouter.use('/simulations', simulationsRouter);
apiRouter.use('/admin', adminRouter);
apiRouter.use('/shifts', shiftsRouter);
apiRouter.use('/maintenance', maintenanceRouter);
apiRouter.use('/cameras', camerasRouter);
apiRouter.use('/reports', reportsRouter);

// Any unmatched /api/* path → structured 404 (before the SPA fallback).
apiRouter.use(notFoundHandler);
