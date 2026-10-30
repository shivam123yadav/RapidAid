import { Hospital } from '../models/index.js';
import { emitVoiceEvent, VOICE_EVENTS } from '../utils/events.js';
import { estimateEtaSeconds, haversineMeters } from '../utils/geo.js';
import {
  requiresCriticalCareCapability,
  requiresTraumaCapability,
} from './emergencyExtractionService.js';
import type { HospitalRoutingReason, IncidentType } from '../validation/constants.js';

/**
 * Finds the nearest hospital that can actually receive this patient.
 *
 * "Nearest" on its own is the wrong answer in an emergency: an OFFLINE or
 * full-capacity facility, or a hospital with no trauma bay for a multi-casualty
 * road accident, is not a valid destination no matter how close it is. So the
 * service works in two passes:
 *
 *   1. eligible = active, not OFFLINE, emergency capacity not FULL
 *   2. capable  = eligible ∩ (trauma / ICU requirement satisfied)
 *
 * The first hospital that satisfies both, ordered by real distance, wins. If
 * nothing is capable, the nearest *eligible* hospital is used and the reason
 * says so — silently dropping the capability requirement would be as wrong as
 * silently routing to a closed hospital.
 *
 * Distances come from MongoDB `$geoNear` when the 2dsphere index is usable, and
 * from the existing haversine helper otherwise. Hospital locations are read
 * from the database; none are hardcoded.
 */

/** Beyond this, a hospital is not a realistic destination for an ambulance. */
export const MAX_ROUTING_DISTANCE_METERS = 50_000;

export interface HospitalCandidate {
  hospitalId: string;
  name: string;
  distanceMeters: number;
  etaSeconds: number;
  emergencyCapacity: string;
  icuCapacity: string;
  traumaAvailable: boolean;
  status: string;
  currentLoad: number;
}

export interface HospitalRoute {
  hospital: HospitalCandidate;
  distanceMeters: number;
  etaSeconds: number;
  routingReason: HospitalRoutingReason;
  /** True when the capability gate had to be relaxed to find any hospital. */
  capabilityRelaxed: boolean;
  consideredCount: number;
}

export interface NoHospitalRoute {
  hospital: null;
  distanceMeters: null;
  etaSeconds: null;
  routingReason: 'NO_ELIGIBLE_HOSPITAL';
  capabilityRelaxed: false;
  consideredCount: number;
  /** Why nothing qualified, for an actionable error message. */
  reason: string;
}

export type RoutingOutcome = HospitalRoute | NoHospitalRoute;

export interface RoutingRequest {
  latitude: number;
  longitude: number;
  incidentType: IncidentType;
  severity: string;
  maxDistanceMeters?: number;
}

interface LeanHospital {
  _id: string;
  name: string;
  status: string;
  emergencyCapacity: string;
  icuCapacity: string;
  traumaAvailable: boolean;
  currentLoad: number;
  active: boolean;
  location: { lat: number; lng: number; address?: string };
  geoDistanceMeters?: number;
}

/**
 * Capability gate, driven strictly by fields the Hospital model actually has.
 * Nothing is invented: a hospital with no trauma flag has no trauma capability.
 */
function isCapable(
  hospital: LeanHospital,
  needsTrauma: boolean,
  needsCriticalCare: boolean,
): boolean {
  if (needsTrauma && !hospital.traumaAvailable) return false;
  if (needsCriticalCare && hospital.icuCapacity === 'FULL') return false;
  if (needsTrauma && hospital.emergencyCapacity === 'FULL') return false;
  return true;
}

/**
 * Backfills the GeoJSON `geo` field from `location` for any hospital that does
 * not have it yet or has malformed coordinates. Idempotent and safe to run on every boot;
 * the pipeline is additive and never touches an existing valid `geo` value.
 */
export async function ensureHospitalGeoFields(): Promise<number> {
  try {
    const result = await Hospital.updateMany(
      {
        $or: [
          { geo: { $exists: false } },
          { 'geo.coordinates.1': { $exists: false } },
          { 'geo.type': { $ne: 'Point' } },
        ],
      },
      [
        {
          $set: {
            geo: {
              $cond: [
                {
                  $and: [
                    { $ne: ['$location.lat', null] },
                    { $ne: ['$location.lng', null] },
                    { $isNumber: '$location.lat' },
                    { $isNumber: '$location.lng' },
                  ],
                },
                // GeoJSON order is [longitude, latitude] — never [lat, lng].
                { type: 'Point', coordinates: ['$location.lng', '$location.lat'] },
                '$$REMOVE',
              ],
            },
          },
        },
      ],
    );
    return result.modifiedCount ?? 0;
  } catch {
    // A missing index or unsupported pipeline stage must not stop the boot; the
    // routing service falls back to an in-process haversine scan.
    return 0;
  }
}

/** MongoDB `$geoNear` when the 2dsphere index is usable, else a haversine scan. */
async function loadCandidates(
  request: RoutingRequest,
  maxDistanceMeters: number,
): Promise<LeanHospital[]> {
  const eligible: Record<string, unknown> = {
    active: { $ne: false },
    status: { $nin: ['OFFLINE'] },
    emergencyCapacity: { $ne: 'FULL' },
    location: { $exists: true },
  };

  try {
    const results = await Hospital.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [request.longitude, request.latitude] },
          distanceField: 'geoDistanceMeters',
          maxDistance: maxDistanceMeters,
          spherical: true,
          query: eligible,
        },
      },
      { $limit: 50 },
    ]).exec();
    if (results.length > 0) return results as unknown as LeanHospital[];
  } catch {
    // No 2dsphere index yet, or a standalone mongod without geo support.
  }

  const all = (await Hospital.find(eligible).lean()) as unknown as LeanHospital[];
  return all
    .map((hospital) => ({
      ...hospital,
      geoDistanceMeters: haversineMeters(
        { lat: request.latitude, lng: request.longitude },
        hospital.location,
      ),
    }))
    .filter((hospital) => (hospital.geoDistanceMeters ?? Infinity) <= maxDistanceMeters)
    .sort((a, b) => (a.geoDistanceMeters ?? 0) - (b.geoDistanceMeters ?? 0));
}

function distanceOf(hospital: LeanHospital, request: RoutingRequest): number {
  if (typeof hospital.geoDistanceMeters === 'number' && Number.isFinite(hospital.geoDistanceMeters)) {
    return hospital.geoDistanceMeters;
  }
  return haversineMeters({ lat: request.latitude, lng: request.longitude }, hospital.location);
}

/** Selects the nearest suitable destination from the live hospital network. */
export async function findNearestEligibleHospital(
  request: RoutingRequest,
): Promise<RoutingOutcome> {
  const maxDistanceMeters = request.maxDistanceMeters ?? MAX_ROUTING_DISTANCE_METERS;
  emitVoiceEvent(VOICE_EVENTS.HOSPITAL_SEARCH_STARTED, {
    incidentType: request.incidentType,
    severity: request.severity,
    maxDistanceMeters,
  });

  const candidates = await loadCandidates(request, maxDistanceMeters);
  if (candidates.length === 0) {
    emitVoiceEvent(VOICE_EVENTS.HOSPITAL_NOT_FOUND, { considered: 0 });
    return {
      hospital: null,
      distanceMeters: null,
      etaSeconds: null,
      routingReason: 'NO_ELIGIBLE_HOSPITAL',
      capabilityRelaxed: false,
      consideredCount: 0,
      reason: 'No active hospital with emergency capacity was found near the incident',
    };
  }

  const needsTrauma = requiresTraumaCapability(request.incidentType, request.severity);
  const needsCriticalCare = requiresCriticalCareCapability(request.severity);

  const scored = candidates
    .map((hospital) => ({
      hospital,
      distanceMeters: distanceOf(hospital, request),
      capable: isCapable(hospital, needsTrauma, needsCriticalCare),
    }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters);

  const best = scored.find((entry) => entry.capable) ?? scored[0];
  const capabilityRelaxed = !best.capable;
  const toCandidate = (entry: (typeof scored)[number]): HospitalCandidate => ({
    hospitalId: entry.hospital._id,
    name: entry.hospital.name,
    distanceMeters: Math.round(entry.distanceMeters),
    etaSeconds: estimateEtaSeconds(entry.distanceMeters),
    emergencyCapacity: entry.hospital.emergencyCapacity,
    icuCapacity: entry.hospital.icuCapacity,
    traumaAvailable: entry.hospital.traumaAvailable,
    status: entry.hospital.status,
    currentLoad: entry.hospital.currentLoad,
  });

  const routingReason: HospitalRoutingReason = capabilityRelaxed
    ? 'NEAREST_AFTER_CAPACITY_GATING'
    : needsTrauma || needsCriticalCare
      ? 'NEAREST_WITH_REQUIRED_CAPABILITY'
      : 'NEAREST_ELIGIBLE';

  emitVoiceEvent(VOICE_EVENTS.HOSPITAL_SELECTED, {
    hospitalId: best.hospital._id,
    distanceMeters: Math.round(best.distanceMeters),
    capabilityRelaxed,
    considered: scored.length,
  });

  return {
    hospital: toCandidate(best),
    distanceMeters: Math.round(best.distanceMeters),
    etaSeconds: estimateEtaSeconds(best.distanceMeters),
    routingReason,
    capabilityRelaxed,
    consideredCount: scored.length,
  };
}
