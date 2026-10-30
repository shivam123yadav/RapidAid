import { Emergency, Hospital, Ambulance } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { env } from '../config/env.js';
import { recordAudit } from './auditService.js';
import {
  recommendAmbulances,
  isAmbulanceDispatchEligible,
  type DispatchRecommendation,
} from './dispatchService.js';
import { haversineMeters, estimateEtaSeconds, round1 } from '../utils/geo.js';
import {
  requiresCriticalCareCapability,
  requiresTraumaCapability,
} from './emergencyExtractionService.js';
import type { Role, HospitalResourceType } from '../validation/constants.js';

export const RACE_LIMITATIONS_NOTICE =
  'DRY RUN EVALUATION ONLY: Resource availability is evaluated at point-in-time and is not reserved or locked. ' +
  'Real concurrent dispatches, bed admissions, or manual interventions may alter candidate availability prior to dispatch execution.';

export interface DryRunOptions {
  requestId?: string;
  actor?: string;
  actorRole?: Role;
  telemetryThresholdSeconds?: number;
  atTime?: Date;
}

export interface CandidateAmbulanceEvaluation {
  ambulanceId: string;
  score: number;
  eta: number;
  distance: number;
  capabilities: string[];
  telemetryAgeSeconds: number | null;
  shiftId: string | null;
  reasons: string[];
}

export interface SkippedAmbulanceCandidate {
  ambulanceId: string;
  score?: number;
  disqualificationReasons: string[];
}

export interface CandidateHospitalEvaluation {
  hospitalId: string;
  name: string;
  score: number;
  eta: number;
  distance: number;
  emergencyCapacity: string;
  icuCapacity: string;
  traumaAvailable: boolean;
  generalBeds: number;
  icuBeds: number;
  incomingAmbulances: number;
  recommendedResourceType: HospitalResourceType;
  reasons: string[];
}

export interface SkippedHospitalCandidate {
  hospitalId: string;
  name?: string;
  disqualificationReasons: string[];
}

export interface DispatchDryRunResult {
  dryRun: true;
  evaluatedAt: Date;
  emergencyId: string;
  eligible: boolean;
  automatedDispatchEnabled: boolean;
  raceLimitations: string;
  summary: string;
  emergency: {
    status: string;
    priority: string;
    incidentType: string;
    location: { lat: number; lng: number; address?: string | null };
  };
  recommendedAmbulance: CandidateAmbulanceEvaluation | null;
  recommendedHospital: CandidateHospitalEvaluation | null;
  skippedAmbulances: SkippedAmbulanceCandidate[];
  skippedHospitals: SkippedHospitalCandidate[];
  preconditionErrors?: string[];
}

/**
 * Validates emergency preconditions and location coordinates.
 */
function validateEmergencyPreconditions(emergency: {
  _id: string;
  status: string;
  priority: string;
  incidentType: string;
  location?: { lat?: number | null; lng?: number | null; address?: string | null } | null;
}): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const validStatuses = ['REPORTED', 'TRIAGED', 'DISPATCHING'];
  if (!validStatuses.includes(emergency.status)) {
    errors.push(
      `Emergency ${emergency._id} is in status '${emergency.status}'; only [${validStatuses.join(', ')}] are eligible for dispatch evaluation`,
    );
  }

  if (!emergency.location || typeof emergency.location !== 'object') {
    errors.push(`Emergency ${emergency._id} is missing location object`);
  } else {
    const { lat, lng } = emergency.location;
    if (lat === undefined || lat === null || typeof lat !== 'number' || Number.isNaN(lat) || lat < -90 || lat > 90) {
      errors.push(`Emergency ${emergency._id} latitude '${lat}' is invalid (must be a number between -90 and 90)`);
    }
    if (lng === undefined || lng === null || typeof lng !== 'number' || Number.isNaN(lng) || lng < -180 || lng > 180) {
      errors.push(`Emergency ${emergency._id} longitude '${lng}' is invalid (must be a number between -180 and 180)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluates an automated dispatch recommendation in dry-run mode.
 * 
 * Strict Guarantees:
 * 1. Strictly read-only: No ambulance claimed, no hospital capacity reserved, no emergency document changed.
 * 2. Precondition validation: Checks incident status, coordinates, and completeness.
 * 3. Strict candidate revalidation: Disqualifies stale telemetry and unverified crew duty; falls back gracefully.
 * 4. Hospital suitability & capacity: Evaluates beds, trauma, and ICU without mutating counters.
 * 5. Deterministic reporting: Explains why candidates were selected or skipped.
 * 6. Explicitly reports race limitations and that automated dispatch is disabled.
 */
export async function evaluateAutomatedDispatchDryRun(
  emergencyId: string,
  options?: DryRunOptions,
): Promise<DispatchDryRunResult> {
  const now = options?.atTime ?? new Date();
  const requestId = options?.requestId ?? `dryrun-${Date.now()}`;
  const actor = options?.actor ?? 'dispatcher';
  const actorRole = (options?.actorRole ?? 'DISPATCHER') as Role;

  const emergency = await Emergency.findById(emergencyId).lean();
  if (!emergency) {
    throw ApiError.notFound(`Emergency ${emergencyId} not found`);
  }

  // 1. Precondition checks
  const preconditionCheck = validateEmergencyPreconditions(emergency);

  const emergencySummary = {
    status: emergency.status,
    priority: emergency.priority,
    incidentType: emergency.incidentType,
    location: {
      lat: emergency.location?.lat ?? 0,
      lng: emergency.location?.lng ?? 0,
      address: emergency.location?.address,
    },
  };

  if (!preconditionCheck.valid) {
    const summary = `Precondition check failed: ${preconditionCheck.errors.join('; ')}`;
    await recordAudit({
      actor,
      actorRole,
      action: 'dispatch.dry_run_evaluated',
      resource: 'Emergency',
      resourceId: emergencyId,
      requestId,
      result: 'FAILURE',
      details: summary,
    });

    return {
      dryRun: true,
      evaluatedAt: now,
      emergencyId,
      eligible: false,
      automatedDispatchEnabled: env.AUTOMATED_DISPATCH_ENABLED,
      raceLimitations: RACE_LIMITATIONS_NOTICE,
      summary,
      emergency: emergencySummary,
      recommendedAmbulance: null,
      recommendedHospital: null,
      skippedAmbulances: [],
      skippedHospitals: [],
      preconditionErrors: preconditionCheck.errors,
    };
  }

  // 2. Ambulance candidate evaluation with candidate fallback
  const rawAmbulanceRecommendations: DispatchRecommendation[] = await recommendAmbulances(emergencyId, {
    atTime: now,
    telemetryThresholdSeconds: options?.telemetryThresholdSeconds,
    filterStaleTelemetry: false,
    filterInactiveCrew: false,
  });

  // Also query any other available ambulances within range to ensure comprehensive fallback evaluation
  const allAvailableUnits = await Ambulance.find({
    status: { $in: ['AVAILABLE', 'RESERVED'] },
  }).lean();

  const evaluatedAmbIds = new Set<string>();
  const skippedAmbulances: SkippedAmbulanceCandidate[] = [];
  let recommendedAmbulance: CandidateAmbulanceEvaluation | null = null;

  // First check ranked recommendations
  for (const rec of rawAmbulanceRecommendations) {
    evaluatedAmbIds.add(rec.ambulanceId);
    const eligibility = await isAmbulanceDispatchEligible(rec.ambulanceId, {
      thresholdSeconds: options?.telemetryThresholdSeconds,
      atTime: now,
    });

    if (!eligibility.eligible) {
      skippedAmbulances.push({
        ambulanceId: rec.ambulanceId,
        score: rec.score,
        disqualificationReasons: eligibility.disqualificationReasons,
      });
      continue;
    }

    if (!recommendedAmbulance) {
      recommendedAmbulance = {
        ambulanceId: rec.ambulanceId,
        score: rec.score,
        eta: rec.eta,
        distance: rec.distance,
        capabilities: rec.capabilities,
        telemetryAgeSeconds: eligibility.telemetry.ageSeconds,
        shiftId: eligibility.crewDuty.shiftId ?? null,
        reasons: rec.reasons,
      };
    }
  }

  // Fallback check on any remaining available units not ranked in top recommendations
  if (!recommendedAmbulance) {
    for (const amb of allAvailableUnits) {
      if (evaluatedAmbIds.has(amb._id)) continue;
      evaluatedAmbIds.add(amb._id);

      const eligibility = await isAmbulanceDispatchEligible(amb._id, {
        thresholdSeconds: options?.telemetryThresholdSeconds,
        atTime: now,
      });

      if (!eligibility.eligible) {
        skippedAmbulances.push({
          ambulanceId: amb._id,
          disqualificationReasons: eligibility.disqualificationReasons,
        });
        continue;
      }

      const distance = haversineMeters(amb.location!, emergency.location!);
      if (distance > 20000) {
        skippedAmbulances.push({
          ambulanceId: amb._id,
          disqualificationReasons: [`Distance ${(distance / 1000).toFixed(1)} km exceeds operating perimeter`],
        });
        continue;
      }

      const eta = estimateEtaSeconds(distance);
      recommendedAmbulance = {
        ambulanceId: amb._id,
        score: 50,
        eta,
        distance: Math.round(distance),
        capabilities: amb.capabilities ?? [],
        telemetryAgeSeconds: eligibility.telemetry.ageSeconds,
        shiftId: eligibility.crewDuty.shiftId ?? null,
        reasons: ['Fallback available candidate with verified telemetry and active shift'],
      };
      break;
    }
  }

  // 3. Hospital candidate evaluation (Read-only capacity assessment)
  const needsTrauma = requiresTraumaCapability(emergency.incidentType, emergency.priority);
  const needsCriticalCare = requiresCriticalCareCapability(emergency.priority);

  const hospitals = await Hospital.find({
    active: true,
  }).lean();

  const skippedHospitals: SkippedHospitalCandidate[] = [];
  const eligibleHospitalCandidates: CandidateHospitalEvaluation[] = [];

  for (const hosp of hospitals) {
    const reasons: string[] = [];
    const disqualifications: string[] = [];

    if (hosp.status === 'OFFLINE') {
      disqualifications.push('Hospital status is OFFLINE');
    }

    const distance = haversineMeters(emergency.location!, hosp.location!);
    if (distance > 50000) {
      disqualifications.push(`Distance ${(distance / 1000).toFixed(1)} km exceeds maximum routing perimeter (50 km)`);
    }

    if (hosp.emergencyCapacity === 'FULL') {
      disqualifications.push('Hospital emergencyCapacity is FULL');
    }

    if (needsTrauma && !hosp.traumaAvailable) {
      disqualifications.push(`Trauma resuscitation bay required for ${emergency.incidentType} / ${emergency.priority}`);
    }

    if (needsCriticalCare && (hosp.icuCapacity === 'FULL' || (hosp.icuBeds ?? 0) < 1)) {
      disqualifications.push(`ICU bed required for critical care (icuBeds: ${hosp.icuBeds ?? 0}, icuCapacity: ${hosp.icuCapacity})`);
    }

    if (disqualifications.length > 0) {
      skippedHospitals.push({
        hospitalId: hosp._id,
        name: hosp.name,
        disqualificationReasons: disqualifications,
      });
      continue;
    }

    const eta = estimateEtaSeconds(distance);
    const capacityScore =
      hosp.emergencyCapacity === 'AVAILABLE' ? 1 : hosp.emergencyCapacity === 'LIMITED' ? 0.6 : 0.2;
    const icuScore = hosp.icuCapacity === 'AVAILABLE' ? 1 : hosp.icuCapacity === 'LIMITED' ? 0.6 : 0.2;
    const traumaScore = needsTrauma ? (hosp.traumaAvailable ? 1 : 0) : 0.8;
    const proximityScore = Math.max(0, 1 - distance / 30000);
    const loadScore = Math.max(0, 1 - (hosp.currentLoad ?? 50) / 100);

    const score = round1(
      (capacityScore * 0.3 + icuScore * 0.15 + traumaScore * 0.25 + proximityScore * 0.2 + loadScore * 0.1) * 100,
    );

    const recommendedResourceType: HospitalResourceType = needsCriticalCare
      ? 'ICU_BED'
      : needsTrauma
      ? 'TRAUMA_BAY'
      : (hosp.generalBeds ?? 0) > 0
      ? 'GENERAL_BED'
      : 'EMERGENCY_ACCEPTANCE';

    reasons.push(`Emergency capacity: ${hosp.emergencyCapacity}`);
    reasons.push(`ICU capacity: ${hosp.icuCapacity} (${hosp.icuBeds ?? 0} beds available)`);
    if (hosp.traumaAvailable) reasons.push('Trauma bay available');
    reasons.push(`${(distance / 1000).toFixed(1)} km away (ETA ~${Math.round(eta / 60)} min)`);
    reasons.push(`Current incoming ambulances: ${hosp.incomingAmbulances ?? 0}`);

    eligibleHospitalCandidates.push({
      hospitalId: hosp._id,
      name: hosp.name,
      score,
      eta,
      distance: Math.round(distance),
      emergencyCapacity: hosp.emergencyCapacity,
      icuCapacity: hosp.icuCapacity,
      traumaAvailable: hosp.traumaAvailable,
      generalBeds: hosp.generalBeds ?? 0,
      icuBeds: hosp.icuBeds ?? 0,
      incomingAmbulances: hosp.incomingAmbulances ?? 0,
      recommendedResourceType,
      reasons,
    });
  }

  eligibleHospitalCandidates.sort((a, b) => b.score - a.score || a.distance - b.distance);
  const recommendedHospital = eligibleHospitalCandidates[0] ?? null;

  // 4. Determine overall dry-run outcome
  const eligible = Boolean(recommendedAmbulance && recommendedHospital);

  let summary = '';
  if (eligible) {
    summary =
      `Dry-run PASS: Eligible for dispatch. Recommended ambulance ${recommendedAmbulance!.ambulanceId} ` +
      `(ETA ~${Math.round(recommendedAmbulance!.eta / 60)}m, score ${recommendedAmbulance!.score}) and ` +
      `hospital ${recommendedHospital!.name} (${recommendedHospital!.hospitalId}, ${recommendedHospital!.recommendedResourceType}).`;
  } else if (!recommendedAmbulance && !recommendedHospital) {
    summary =
      `Dry-run FAIL: No eligible ambulance AND no suitable hospital available ` +
      `(${skippedAmbulances.length} ambulance(s) skipped; ${skippedHospitals.length} hospital(s) skipped).`;
  } else if (!recommendedAmbulance) {
    summary =
      `Dry-run FAIL: No eligible ambulance available ` +
      `(${skippedAmbulances.length} candidate(s) skipped due to telemetry or crew duty constraints).`;
  } else {
    summary =
      `Dry-run FAIL: No suitable hospital available ` +
      `(${skippedHospitals.length} candidate(s) skipped due to capacity or capability constraints).`;
  }

  // 5. Record clear audit trail for human dispatchers
  await recordAudit({
    actor,
    actorRole,
    action: 'dispatch.dry_run_evaluated',
    resource: 'Emergency',
    resourceId: emergencyId,
    requestId,
    result: eligible ? 'SUCCESS' : 'FAILURE',
    details: `${summary} [AUTOMATED_DISPATCH_ENABLED=${env.AUTOMATED_DISPATCH_ENABLED}]`,
  });

  return {
    dryRun: true,
    evaluatedAt: now,
    emergencyId,
    eligible,
    automatedDispatchEnabled: env.AUTOMATED_DISPATCH_ENABLED,
    raceLimitations: RACE_LIMITATIONS_NOTICE,
    summary,
    emergency: emergencySummary,
    recommendedAmbulance,
    recommendedHospital,
    skippedAmbulances,
    skippedHospitals,
  };
}

export { evaluateAutomatedDispatchDryRun as evaluateDispatchDryRun };
