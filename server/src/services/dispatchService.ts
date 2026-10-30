import { Ambulance, Emergency, Hospital } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { estimateEtaSeconds, haversineMeters, round1 } from '../utils/geo.js';
import { env } from '../config/env.js';
import { verifyAmbulanceCrewDuty, type CrewDutyVerificationResult } from './crewDutyService.js';
import type { CapacityStatus, IncidentType, Priority } from '../validation/constants.js';

export type TelemetryFreshnessReason =
  | 'MISSING_TIMESTAMP'
  | 'INVALID_TIMESTAMP'
  | 'FUTURE_TIMESTAMP'
  | 'STALE_TIMESTAMP';

export interface TelemetryFreshnessResult {
  fresh: boolean;
  ageSeconds: number | null;
  reason?: TelemetryFreshnessReason;
  thresholdSeconds: number;
}

export interface AmbulanceDispatchEligibility {
  eligible: boolean;
  ambulanceId: string;
  telemetry: TelemetryFreshnessResult;
  crewDuty: CrewDutyVerificationResult;
  disqualificationReasons: string[];
}

export interface RecommendAmbulanceOptions {
  /** If true, filters candidates whose telemetry is older than the freshness threshold. Default false to preserve manual dispatch / test compatibility. */
  filterStaleTelemetry?: boolean;
  /** If true, filters candidates whose crew duty fails verification. Default false to preserve manual dispatch / test compatibility. */
  filterInactiveCrew?: boolean;
  /** Custom telemetry freshness threshold in seconds (defaults to env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS). */
  telemetryThresholdSeconds?: number;
  /** Reference time for evaluation (defaults to now). */
  atTime?: Date;
}

/**
 * Evaluates whether an ambulance's GPS telemetry timestamp is within the freshness threshold.
 * Configured via TELEMETRY_FRESHNESS_THRESHOLD_SECONDS (default 300s).
 * Safely rejects missing, invalid, excessively future, or stale timestamps.
 * Does not invent vehicle locations.
 */
export function isAmbulanceTelemetryFresh(
  ambulance: { lastUpdated?: Date | string | number | null } | null | undefined,
  thresholdSeconds?: number,
  nowDate?: Date,
): TelemetryFreshnessResult {
  const threshold = thresholdSeconds ?? env.TELEMETRY_FRESHNESS_THRESHOLD_SECONDS;

  if (!ambulance || ambulance.lastUpdated === undefined || ambulance.lastUpdated === null) {
    return { fresh: false, ageSeconds: null, reason: 'MISSING_TIMESTAMP', thresholdSeconds: threshold };
  }

  const timestamp = new Date(ambulance.lastUpdated).getTime();
  if (Number.isNaN(timestamp)) {
    return { fresh: false, ageSeconds: null, reason: 'INVALID_TIMESTAMP', thresholdSeconds: threshold };
  }

  const now = (nowDate ?? new Date()).getTime();
  const diffMs = now - timestamp;

  // Reject future timestamps exceeding clock skew tolerance (60s)
  if (diffMs < -60000) {
    return {
      fresh: false,
      ageSeconds: Math.round(diffMs / 1000),
      reason: 'FUTURE_TIMESTAMP',
      thresholdSeconds: threshold,
    };
  }

  const ageSeconds = Math.max(0, Math.floor(diffMs / 1000));
  if (ageSeconds > threshold) {
    return {
      fresh: false,
      ageSeconds,
      reason: 'STALE_TIMESTAMP',
      thresholdSeconds: threshold,
    };
  }

  return {
    fresh: true,
    ageSeconds,
    thresholdSeconds: threshold,
  };
}

/**
 * Validates whether an ambulance satisfies candidate eligibility:
 * 1. GPS telemetry freshness within threshold.
 * 2. Active shift and crew-duty verification.
 */
export async function isAmbulanceDispatchEligible(
  ambulanceId: string,
  options?: {
    thresholdSeconds?: number;
    atTime?: Date;
  },
): Promise<AmbulanceDispatchEligibility> {
  const atTime = options?.atTime ?? new Date();
  const ambulance = await Ambulance.findById(ambulanceId).lean();

  const telemetry = isAmbulanceTelemetryFresh(ambulance, options?.thresholdSeconds, atTime);
  const crewDuty = await verifyAmbulanceCrewDuty(ambulanceId, { atTime });

  const disqualificationReasons: string[] = [];
  if (!telemetry.fresh) {
    disqualificationReasons.push(
      `Telemetry ineligible: ${telemetry.reason} (age ${telemetry.ageSeconds ?? 'unknown'}s vs limit ${telemetry.thresholdSeconds}s)`,
    );
  }
  if (!crewDuty.eligible) {
    disqualificationReasons.push(
      `Crew duty ineligible: ${crewDuty.disqualificationReason} (${crewDuty.message})`,
    );
  }

  return {
    eligible: telemetry.fresh && crewDuty.eligible,
    ambulanceId,
    telemetry,
    crewDuty,
    disqualificationReasons,
  };
}

export type DispatchPolicy = 'MANUAL' | 'STRICT_AUTOMATED';

export interface DispatchEligibilityWarning {
  code:
    | 'SHIFT_MISSING_OR_INVALID'
    | 'CREW_UNVERIFIED_OR_INELIGIBLE'
    | 'TELEMETRY_STALE'
    | 'TELEMETRY_MISSING_OR_INVALID';
  message: string;
  details?: unknown;
}

/**
 * Categorizes disqualification reasons into structured Policy A warnings:
 * - Missing or invalid active shift.
 * - Unverified or ineligible crew.
 * - Stale telemetry.
 * - Missing or invalid telemetry.
 */
export function formatEligibilityWarnings(
  eligibility: AmbulanceDispatchEligibility,
): DispatchEligibilityWarning[] {
  const warnings: DispatchEligibilityWarning[] = [];

  if (!eligibility.telemetry.fresh) {
    if (eligibility.telemetry.reason === 'STALE_TIMESTAMP') {
      warnings.push({
        code: 'TELEMETRY_STALE',
        message: `Ambulance telemetry is stale (${eligibility.telemetry.ageSeconds ?? 'unknown'}s old; limit is ${eligibility.telemetry.thresholdSeconds}s).`,
        details: eligibility.telemetry,
      });
    } else {
      warnings.push({
        code: 'TELEMETRY_MISSING_OR_INVALID',
        message: `Ambulance telemetry is missing or invalid (${eligibility.telemetry.reason}).`,
        details: eligibility.telemetry,
      });
    }
  }

  if (!eligibility.crewDuty.eligible) {
    const shiftCodes = [
      'NO_ACTIVE_SHIFT',
      'SHIFT_STATUS_INVALID',
      'SHIFT_OUTSIDE_WINDOW',
      'MULTIPLE_ACTIVE_SHIFTS',
    ];
    if (shiftCodes.includes(eligibility.crewDuty.disqualificationReason ?? '')) {
      warnings.push({
        code: 'SHIFT_MISSING_OR_INVALID',
        message: `Ambulance lacks a valid active shift (${eligibility.crewDuty.disqualificationReason}): ${eligibility.crewDuty.message}`,
        details: eligibility.crewDuty,
      });
    } else {
      warnings.push({
        code: 'CREW_UNVERIFIED_OR_INELIGIBLE',
        message: `Ambulance crew cannot be verified for duty (${eligibility.crewDuty.disqualificationReason}): ${eligibility.crewDuty.message}`,
        details: eligibility.crewDuty,
      });
    }
  }

  return warnings;
}

export interface DispatchRecommendation {
  ambulanceId: string;
  score: number;
  eta: number;
  distance: number;
  capabilities: string[];
  reasons: string[];
}

export interface HospitalRecommendation {
  hospitalId: string;
  score: number;
  eta: number;
  distance: number;
  emergencyCapacity: CapacityStatus;
  icuCapacity: CapacityStatus;
  traumaAvailable: boolean;
  reasons: string[];
}

/**
 * Capabilities an ambulance must carry for a given incident type. Every name
 * here exists in the seeded fleet (see src/seed/data/ambulances*.ts) — a typo
 * would silently gate out all candidates. Priority-driven requirements
 * (Trauma/ICU) are added on top in requiredCapabilities().
 */
const INCIDENT_CAPABILITY_REQUIREMENTS: Partial<Record<IncidentType, string[]>> = {
  VEHICLE_COLLISION: ['Trauma'],
  STRUCTURAL_COLLAPSE: ['Trauma'],
  EXPLOSION: ['Trauma'],
  MASS_CASUALTY: ['Trauma'],
  ASSAULT: ['Trauma'],
  CARDIAC_ARREST: ['Defibrillator'],
  ELECTROCUTION: ['Defibrillator'],
  STROKE: ['ICU'],
  RESPIRATORY_DISTRESS: ['Ventilator'],
  SEIZURE: ['Medications'],
  POISONING: ['Medications'],
  OBSTETRIC_EMERGENCY: ['Medications'],
};

/** Incident/priority requirements an ambulance must satisfy to be eligible. */
function requiredCapabilities(priority: Priority, incidentType: IncidentType): string[] {
  const reqs = new Set<string>(['Oxygen']);
  for (const capability of INCIDENT_CAPABILITY_REQUIREMENTS[incidentType] ?? []) {
    reqs.add(capability);
  }
  // Life-threatening calls always need a trauma-capable, ICU-equipped unit.
  if (priority === 'CRITICAL') reqs.add('Trauma');
  if (priority === 'CRITICAL' || priority === 'HIGH') reqs.add('ICU');
  return [...reqs];
}

const CAPABILITY_WEIGHTS: Record<string, number> = {
  Trauma: 1.0,
  ICU: 1.0,
  Defibrillator: 1.0,
  Oxygen: 1.0,
  Ventilator: 0.8,
  Medications: 0.6,
  Basic: 0.3,
};

/**
 * Deterministic AI-style ambulance ranking: weighted capability match
 * (60%) + proximity (30%) + crew readiness (10%). Candidates must cover
 * at least half of the required capabilities (soft gate — a dispatcher
 * still needs to see partial matches in a resource crunch); distance
 * beyond 12 km disqualifies. Returns the top 3 sorted by score.
 */
export async function recommendAmbulances(
  emergencyId: string,
  options?: RecommendAmbulanceOptions,
): Promise<DispatchRecommendation[]> {
  const emergency = await Emergency.findById(emergencyId).lean();
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);

  if (
    !emergency.location ||
    typeof emergency.location.lat !== 'number' ||
    typeof emergency.location.lng !== 'number' ||
    !Number.isFinite(emergency.location.lat) ||
    !Number.isFinite(emergency.location.lng)
  ) {
    return [];
  }

  const required = requiredCapabilities(emergency.priority, emergency.incidentType);
  const candidates = await Ambulance.find({
    status: { $in: ['AVAILABLE', 'RESERVED'] },
  }).lean();

  const scored: DispatchRecommendation[] = [];

  for (const amb of candidates) {
    if (
      !amb.location ||
      typeof amb.location.lat !== 'number' ||
      typeof amb.location.lng !== 'number' ||
      !Number.isFinite(amb.location.lat) ||
      !Number.isFinite(amb.location.lng)
    ) {
      continue;
    }

    if (options?.filterStaleTelemetry) {
      const telemetry = isAmbulanceTelemetryFresh(amb, options.telemetryThresholdSeconds, options.atTime);
      if (!telemetry.fresh) continue;
    }

    if (options?.filterInactiveCrew) {
      const crewDuty = await verifyAmbulanceCrewDuty(amb._id, { atTime: options.atTime });
      if (!crewDuty.eligible) continue;
    }

    const distance = haversineMeters(amb.location, emergency.location);
    if (distance > 12000) continue; // too far to be useful

    const matched = required.filter((cap) => amb.capabilities.includes(cap));
    if (matched.length / required.length < 0.5) continue; // soft capability gate

    const missing = required.filter((cap) => !matched.includes(cap));
    const capScore =
      matched.reduce((sum, cap) => sum + (CAPABILITY_WEIGHTS[cap] ?? 0.5), 0) /
      required.reduce((sum, cap) => sum + (CAPABILITY_WEIGHTS[cap] ?? 0.5), 0);
    const proximityScore = Math.max(0, 1 - distance / 12000);
    const crewScore = amb.crew.length >= 2 ? 1 : amb.crew.length === 1 ? 0.5 : 0;
    const score = round1((capScore * 0.6 + proximityScore * 0.3 + crewScore * 0.1) * 100);

    const reasons: string[] = [`Matches required capabilities: ${matched.join(', ')}`];
    if (missing.length > 0) reasons.push(`Missing capabilities: ${missing.join(', ')}`);
    reasons.push(`${(distance / 1000).toFixed(1)} km from scene`);
    if (crewScore === 1) reasons.push('Full crew on board (2 members)');
    else if (crewScore === 0.5) reasons.push('Single crew member — may need backup');
    if (amb.status === 'AVAILABLE') reasons.push('Currently available (idle)');

    scored.push({
      ambulanceId: amb._id,
      score,
      eta: estimateEtaSeconds(distance),
      distance: Math.round(distance),
      capabilities: amb.capabilities,
      reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  return scored.slice(0, 3);
}

/**
 * Deterministic hospital ranking: capacity (40%) + trauma match (25%)
 * + proximity (25%) + low load (10%). OFFLINE hospitals are excluded;
 * FULL emergency capacity disqualifies. Returns top 3.
 */
export async function recommendHospitals(emergencyId: string): Promise<HospitalRecommendation[]> {
  const emergency = await Emergency.findById(emergencyId).lean();
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);

  if (
    !emergency.location ||
    typeof emergency.location.lat !== 'number' ||
    typeof emergency.location.lng !== 'number' ||
    !Number.isFinite(emergency.location.lat) ||
    !Number.isFinite(emergency.location.lng)
  ) {
    return [];
  }

  const needsTrauma =
    emergency.priority === 'CRITICAL' ||
    emergency.incidentType === 'VEHICLE_COLLISION' ||
    emergency.incidentType === 'STRUCTURAL_COLLAPSE' ||
    emergency.incidentType === 'EXPLOSION' ||
    emergency.incidentType === 'MASS_CASUALTY' ||
    emergency.incidentType === 'ASSAULT';

  const hospitals = await Hospital.find({ status: { $ne: 'OFFLINE' } }).lean();
  const scored: HospitalRecommendation[] = [];

  for (const hosp of hospitals) {
    if (hosp.emergencyCapacity === 'FULL') continue;
    if (
      !hosp.location ||
      typeof hosp.location.lat !== 'number' ||
      typeof hosp.location.lng !== 'number' ||
      !Number.isFinite(hosp.location.lat) ||
      !Number.isFinite(hosp.location.lng)
    ) {
      continue;
    }

    const distance = haversineMeters(emergency.location, hosp.location);
    if (distance > 15000) continue;

    const capacityScore =
      hosp.emergencyCapacity === 'AVAILABLE' ? 1 : hosp.emergencyCapacity === 'LIMITED' ? 0.55 : 0.1;
    const icuScore = hosp.icuCapacity === 'AVAILABLE' ? 1 : hosp.icuCapacity === 'LIMITED' ? 0.55 : 0.1;
    const traumaScore = needsTrauma ? (hosp.traumaAvailable ? 1 : 0) : 0.7;
    const proximityScore = Math.max(0, 1 - distance / 15000);
    const loadScore = Math.max(0, 1 - hosp.currentLoad / 100);

    if (needsTrauma && !hosp.traumaAvailable) continue; // hard gate

    const score = round1(
      (capacityScore * 0.3 + icuScore * 0.1 + traumaScore * 0.25 + proximityScore * 0.25 + loadScore * 0.1) * 100,
    );

    const reasons: string[] = [];
    reasons.push(`Emergency capacity: ${hosp.emergencyCapacity}`);
    reasons.push(`ICU capacity: ${hosp.icuCapacity}`);
    if (needsTrauma) reasons.push(hosp.traumaAvailable ? 'Trauma bay available' : 'No trauma bay');
    reasons.push(`${(distance / 1000).toFixed(1)} km away`);
    reasons.push(`Current load: ${hosp.currentLoad}%`);

    scored.push({
      hospitalId: hosp._id,
      score,
      eta: estimateEtaSeconds(distance),
      distance: Math.round(distance),
      emergencyCapacity: hosp.emergencyCapacity,
      icuCapacity: hosp.icuCapacity,
      traumaAvailable: hosp.traumaAvailable,
      reasons,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.distance - b.distance);
  return scored.slice(0, 3);
}
