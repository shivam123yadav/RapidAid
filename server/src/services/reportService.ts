import { Emergency, Report, nextId } from '../models/index.js';
import { emergencyScopeFilter, hasPermission, type AuthContext } from '../authz/access.js';
import { P } from '../authz/permissions.js';
import type { Priority } from '../validation/constants.js';

export interface GenerateReportInput {
  title: string;
  reportType: string;
  periodFrom: Date;
  periodTo: Date;
}

function countBy<T extends string>(values: readonly T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

/**
 * Builds a point-in-time aggregate report from emergencies visible to the
 * caller. Persisted snapshots contain ids and counts only — never descriptions,
 * locations, citizen ids, contact details, or attachment payloads.
 */
export async function generateReport(auth: AuthContext, input: GenerateReportInput) {
  const scope = hasPermission(auth, P.REPORT_READ_ALL)
    ? {}
    : await emergencyScopeFilter(auth);
  const emergencies = await Emergency.find({
    ...scope,
    reportedAt: { $gte: input.periodFrom, $lte: input.periodTo },
  })
    .select('_id status priority victimCount')
    .sort({ reportedAt: 1 })
    .lean();

  const totalVictims = emergencies.reduce((sum, emergency) => sum + emergency.victimCount, 0);
  const byPriority = countBy(emergencies.map((emergency) => emergency.priority as Priority));
  const byStatus = countBy(emergencies.map((emergency) => emergency.status));
  const now = new Date();

  return Report.create({
    _id: await nextId('report', 'RPT', 3),
    title: input.title,
    reportType: input.reportType,
    periodFrom: input.periodFrom,
    periodTo: input.periodTo,
    status: 'READY',
    createdBy: auth.userId,
    generatedBy: auth.userId,
    emergencyIds: emergencies.map((emergency) => emergency._id),
    summary: {
      totalEmergencies: emergencies.length,
      activeEmergencies: emergencies.filter((emergency) => !['COMPLETED', 'CANCELLED'].includes(emergency.status)).length,
      completedEmergencies: byStatus.COMPLETED ?? 0,
      cancelledEmergencies: byStatus.CANCELLED ?? 0,
      criticalEmergencies: byPriority.CRITICAL ?? 0,
      totalVictims,
      averageVictims: emergencies.length === 0 ? 0 : Number((totalVictims / emergencies.length).toFixed(2)),
      byPriority,
      byStatus,
    },
    generatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
}
