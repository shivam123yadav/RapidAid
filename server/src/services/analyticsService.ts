import { Ambulance, DailyStat, Emergency, Hospital } from '../models/index.js';
import { INCIDENT_TYPE_LABELS, type IncidentType } from '../validation/constants.js';
import { logger } from '../config/logger.js';

export interface AnalyticsData {
  emergencyVolume: { date: string; count: number }[];
  responseTimes: { date: string; median: number; p90: number }[];
  incidentTypes: { type: string; count: number }[];
  ambulanceUtilization: { date: string; utilization: number }[];
  hospitalLoad: { hospital: string; load: number }[];
}

/**
 * Builds the AnalyticsData payload the dashboard expects.
 *  - time series come from DailyStat (seeded history + updated live)
 *  - incident mix is aggregated live from the Emergency collection
 *  - hospital load is read live from Hospital
 * Falls back to empty series (never null) so chart code can rely on arrays.
 */
export async function getAnalytics(): Promise<AnalyticsData> {
  try {
    const [daily, incidentAgg, hospitals, ambulances] = await Promise.all([
      DailyStat.find().sort({ _id: 1 }).lean(),
      Emergency.aggregate<{ _id: IncidentType; count: number }>([
        { $group: { _id: '$incidentType', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      Hospital.find({ status: { $ne: 'OFFLINE' } }).select('name currentLoad').lean(),
      Ambulance.find().select('status').lean(),
    ]);

    const busy = ambulances.filter(
      (a) => a.status !== 'AVAILABLE' && a.status !== 'MAINTENANCE' && a.status !== 'OFFLINE',
    ).length;
    const utilization =
      ambulances.length > 0 ? Math.round((busy / ambulances.length) * 100) : 0;
    const today = new Date().toISOString().slice(0, 10);

    return {
      emergencyVolume: daily.map((d) => ({ date: d._id, count: d.emergencyCount })),
      responseTimes: daily.map((d) => ({
        date: d._id,
        median: d.medianResponseSeconds,
        p90: d.p90ResponseSeconds,
      })),
      incidentTypes: incidentAgg.map((row) => ({
        type: INCIDENT_TYPE_LABELS[row._id] ?? row._id,
        count: row.count,
      })),
      ambulanceUtilization: [
        ...daily.map((d) => ({ date: d._id, utilization: d.ambulanceUtilizationPct })),
        { date: today, utilization },
      ],
      hospitalLoad: hospitals.map((h) => ({ hospital: h.name, load: h.currentLoad })),
    };
  } catch (err) {
    logger.error({ err }, 'analytics aggregation failed');
    // Degrade gracefully: empty arrays keep the charts rendering.
    return {
      emergencyVolume: [],
      responseTimes: [],
      incidentTypes: [],
      ambulanceUtilization: [],
      hospitalLoad: [],
    };
  }
}
