import { Router } from 'express';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errors.js';
import { Emergency, Report } from '../models/index.js';
import { P } from '../authz/permissions.js';
import { hasPermission } from '../authz/access.js';
import { generateReport } from '../services/reportService.js';
import { recordAudit } from '../services/auditService.js';
import { reportCreateSchema } from '../validation/schemas.js';

export const reportsRouter = Router();
const REPORT_ID = /^RPT-\d{1,10}$/;

function assertReportId(id: string): void {
  if (!REPORT_ID.test(id)) throw ApiError.badRequest('Malformed report id');
}

function canReadReport(
  auth: NonNullable<Express.Request['auth']>,
  report: { createdBy: string },
): boolean {
  return hasPermission(auth, P.REPORT_READ_ALL) || report.createdBy === auth.userId;
}

reportsRouter.get(
  '/',
  authenticate,
  requirePermission(P.REPORT_READ_ALL, P.REPORT_READ_OWN),
  asyncHandler(async (req, res) => {
    const filter = hasPermission(req.auth, P.REPORT_READ_ALL) ? {} : { createdBy: req.auth!.userId };
    res.json(await Report.find(filter).sort({ createdAt: -1 }).limit(200));
  }),
);

reportsRouter.post(
  '/',
  authenticate,
  requirePermission(P.REPORT_CREATE, P.REPORT_GENERATE),
  validateBody(reportCreateSchema),
  asyncHandler(async (req, res) => {
    const report = await generateReport(req.auth!, req.body);
    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'report.generated',
      resource: 'Report',
      resourceId: report._id,
      requestId: req.requestId,
      newState: report.toObject(),
      details: `${report.reportType}; ${report.emergencyIds.length} scoped emergencies`,
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    res.status(201).json(report);
  }),
);

reportsRouter.get(
  '/:id/export',
  authenticate,
  requirePermission(P.REPORT_EXPORT),
  asyncHandler(async (req, res) => {
    assertReportId(req.params.id);
    const report = await Report.findById(req.params.id);
    if (!report || !canReadReport(req.auth!, report)) throw ApiError.notFound(`Report ${req.params.id} not found`);
    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'report.exported',
      resource: 'Report',
      resourceId: report._id,
      requestId: req.requestId,
      details: 'sanitized aggregate export',
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    res.json({ classification: 'SANITIZED', report: report.toJSON(), exportedAt: new Date().toISOString(), exportedBy: req.auth!.userId });
  }),
);

reportsRouter.get(
  '/:id/sensitive-export',
  authenticate,
  asyncHandler(async (req, res) => {
    assertReportId(req.params.id);
    const report = await Report.findById(req.params.id);
    if (!report || !canReadReport(req.auth!, report)) throw ApiError.notFound(`Report ${req.params.id} not found`);
    const sensitiveExportAllowed =
      hasPermission(req.auth, P.REPORT_EXPORT)
      && hasPermission(req.auth, P.REPORT_EXPORT_SENSITIVE)
      && hasPermission(req.auth, P.PATIENT_EXPORT);
    if (!sensitiveExportAllowed) {
      await recordAudit({
        actor: req.auth!.name,
        actorId: req.auth!.userId,
        actorRole: req.auth!.role,
        action: 'report.sensitive_export_denied',
        resource: 'Report',
        resourceId: report._id,
        requestId: req.requestId,
        result: 'FAILURE',
        details: 'requires report:export, report:export:sensitive, and patient:export',
        ip: req.ip,
        userAgent: req.header('user-agent'),
      });
      throw ApiError.forbidden('Sensitive report export is outside your authorized scope');
    }

    const records = await Emergency.find({ _id: { $in: report.emergencyIds } }).sort({ reportedAt: 1 }).lean();
    const emergencies = records.map(({ _id, __v, ...record }) => ({ id: _id, ...record }));
    await recordAudit({
      actor: req.auth!.name,
      actorId: req.auth!.userId,
      actorRole: req.auth!.role,
      action: 'report.sensitive_exported',
      resource: 'Report',
      resourceId: report._id,
      requestId: req.requestId,
      details: `${emergencies.length} sensitive emergency records`,
      ip: req.ip,
      userAgent: req.header('user-agent'),
    });
    res.json({ classification: 'SENSITIVE', report: report.toJSON(), emergencies, exportedAt: new Date().toISOString(), exportedBy: req.auth!.userId });
  }),
);

reportsRouter.get(
  '/:id',
  authenticate,
  requirePermission(P.REPORT_READ_ALL, P.REPORT_READ_OWN),
  asyncHandler(async (req, res) => {
    assertReportId(req.params.id);
    const report = await Report.findById(req.params.id);
    if (!report || !canReadReport(req.auth!, report)) throw ApiError.notFound(`Report ${req.params.id} not found`);
    res.json(report);
  }),
);
