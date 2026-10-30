import { Ambulance, Emergency, Hospital, HospitalReservation, type HospitalReservationDoc, nextId, isEmergencyIdempotencyIndexReady } from '../models/index.js';
import type { EmergencyDoc } from '../models/Emergency.js';
import { ApiError } from '../utils/errors.js';
import { estimateEtaSeconds, haversineMeters } from '../utils/geo.js';
import { canTransition, type EmergencyStatus, type Priority } from '../validation/constants.js';
import {
  reserveHospitalCapacity,
  releaseHospitalReservation,
  rerouteHospitalReservation,
} from './hospitalReservationService.js';
import { recordAudit, pushNotification } from './auditService.js';
import {
  notifyCitizenOnReport,
  notifyCitizenOnAmbulanceAssignment,
  notifyCitizenOnHospitalRerouted,
  notifyDispatchersOnNewEmergency,
  notifyCrewOnAssignment,
  notifyCrewOnAssignmentCancelled,
  notifyCrewOnHospitalRerouted,
  notifySupervisorsOnOverride,
} from './notificationService.js';
import { logger } from '../config/logger.js';
import { isTest } from '../config/env.js';
import { randomUUID } from 'node:crypto';
import {
  acquireSchedulerLock,
  releaseSchedulerLock,
  type AcquireLockResult,
} from './distributedLock.js';
import {
  recordReconciliationSweep,
  recordFleetRecoveryOutcome,
  recordFleetCasNoOp,
} from '../metrics/index.js';
import {
  isAmbulanceDispatchEligible,
  formatEligibilityWarnings,
  type DispatchEligibilityWarning,
  type DispatchPolicy,
} from './dispatchService.js';

export interface TransitionResult {
  emergencyId: string;
  from: EmergencyStatus;
  to: EmergencyStatus;
}

/**
 * Validates and applies an emergency status transition.
 *
 * Rules (see validation/constants.ts canTransition):
 *  - forward-only progression (steps may be skipped)
 *  - CANCELLED allowed from any active state
 *  - terminal states (COMPLETED/CANCELLED) are immutable
 *  - same-state updates are rejected
 *
 * On terminal states (COMPLETED/CANCELLED), any assigned ambulance is released back to AVAILABLE.
 * The local MongoDB runs standalone (no replica set → no multi-document
 * transactions), so writes are strictly ordered:
 * 1. The transition is atomically claimed on Emergency first via findOneAndUpdate.
 * 2. Only the winning transition executes side effects (ambulance release, audit, notification).
 * Competing transitions that lose the atomic update fail with HTTP 409 without releasing the
 * ambulance or generating misleading audit records.
 */
export async function transitionEmergency(
  emergencyId: string,
  to: EmergencyStatus,
  opts: { note?: string; requestId: string; actor: string; actorRole: string; currentStatus?: EmergencyStatus },
): Promise<TransitionResult> {
  const emergency = await Emergency.findById(emergencyId);
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);

  const from = emergency.status;
  if (opts.currentStatus && opts.currentStatus !== from) {
    throw ApiError.conflict(
      `Concurrent transition conflict: Emergency ${emergencyId} status is '${from}', but expected '${opts.currentStatus}'`,
    );
  }
  if (from === to) {
    throw ApiError.badRequest(`Emergency is already in status '${to}'`);
  }
  if (!canTransition(from, to)) {
    throw ApiError.badRequest(`Invalid status transition: ${from} → ${to}`);
  }

  const now = new Date();
  const timelineEntry = { status: to, timestamp: now, ...(opts.note ? { note: opts.note } : {}) };

  // 1. ATOMIC CONDITIONAL CLAIM: Claim the transition on Emergency first.
  // This prevents losing concurrent transitions from prematurely releasing
  // an assigned ambulance while an active competing transition wins.
  const updated = await Emergency.findOneAndUpdate(
    { _id: emergencyId, status: from },
    {
      $set: { status: to, updatedAt: now },
      $push: { timeline: timelineEntry },
    },
    { new: true },
  ).exec();

  if (!updated) {
    recordFleetCasNoOp('emergency');
    // Transition lost or emergency was modified/deleted concurrently.
    // Zero side effects (no ambulance release, no audit, no notification) execute here.
    const fresh = await Emergency.findById(emergencyId).lean();
    if (!fresh) {
      throw ApiError.notFound(`Emergency ${emergencyId} not found`);
    }
    if (fresh.status === to) {
      throw ApiError.conflict(`Emergency ${emergencyId} was already transitioned to status '${to}'`);
    }
    throw ApiError.conflict(
      `Concurrent transition conflict: Emergency ${emergencyId} status changed from '${from}' to '${fresh.status}' while processing`,
    );
  }

  // 2. DEPENDENT SIDE EFFECTS: Only the winner of the atomic transition executes side-effects.
  const terminal = to === 'COMPLETED' || to === 'CANCELLED';
  if (terminal && updated.assignedAmbulance) {
    try {
      // The `currentEmergency` guard ensures we only free this ambulance if it is still
      // claimed by this specific incident (has not been retasked elsewhere).
      const released = await Ambulance.updateOne(
        { _id: updated.assignedAmbulance, currentEmergency: emergencyId },
        { $set: { status: 'AVAILABLE', currentEmergency: null, eta: undefined, lastUpdated: now } },
      ).exec();
      if (released.matchedCount === 0) {
        recordFleetCasNoOp('ambulance');
        await recordAudit({
          actor: opts.actor,
          actorRole: opts.actorRole as never,
          action: 'emergency.ambulance_release_skipped',
          resource: 'Ambulance',
          resourceId: updated.assignedAmbulance,
          requestId: opts.requestId,
          details: `${emergencyId} closed but the unit is no longer claimed by it; left untouched`,
          result: 'FAILURE',
        });
      }
    } catch (releaseErr) {
      // Non-fatal logging for operator reconciliation; transition itself succeeded.
      logger.error(
        { err: releaseErr, emergencyId, ambulanceId: updated.assignedAmbulance },
        'Failed to release ambulance during terminal transition; reconciliation required',
      );
      await recordAudit({
        actor: opts.actor,
        actorRole: opts.actorRole as never,
        action: 'emergency.ambulance_release_failed',
        resource: 'Ambulance',
        resourceId: updated.assignedAmbulance,
        requestId: opts.requestId,
        details: `Failed to release ambulance ${updated.assignedAmbulance} during terminal transition to ${to}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}`,
        result: 'FAILURE',
      }).catch(() => {});
    }
  }

  // Release hospital capacity reservation on terminal status
  if (terminal) {
    try {
      const activeReservations = await HospitalReservation.find({
        emergencyId,
        status: { $in: ['PENDING', 'CONFIRMED'] },
      }).lean();
      for (const res of activeReservations) {
        await releaseHospitalReservation(res._id, {
          actor: opts.actor,
          actorRole: opts.actorRole as never,
          requestId: opts.requestId,
          status: to === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED',
          reason: `EMERGENCY_${to}`,
        });
      }
    } catch (hospReleaseErr) {
      logger.error(
        { err: hospReleaseErr, emergencyId },
        'Failed to release hospital reservation during terminal transition',
      );
    }
  }

  try {
    await recordAudit({
      actor: opts.actor,
      actorRole: opts.actorRole as never,
      action: 'emergency.status_changed',
      resource: 'Emergency',
      resourceId: emergencyId,
      requestId: opts.requestId,
      details: `${from} → ${to}${opts.note ? ` (${opts.note})` : ''}`,
    });
  } catch (auditErr) {
    logger.error({ err: auditErr, emergencyId }, 'Failed to record audit log for emergency status transition');
  }

  if (to === 'COMPLETED' || to === 'CANCELLED') {
    try {
      await pushNotification({
        category: to === 'COMPLETED' ? 'SUCCESS' : 'WARNING',
        title: to === 'COMPLETED' ? 'Emergency Completed' : 'Emergency Cancelled',
        message: `${emergencyId}: incident closed with status ${to}.`,
        linkedEmergency: emergencyId,
      });
    } catch (notifErr) {
      logger.error({ err: notifErr, emergencyId }, 'Failed to push notification for closed emergency');
    }
  }

  return { emergencyId, from, to };
}

export interface CreateEmergencyResult {
  id: string;
  reportedAt: Date;
}

/** A validated photo, ready to persist (produced by createEmergencySchema). */
export interface EmergencyAttachmentInput {
  name: string;
  mimeType: string;
  size: number;
  dataUrl: string;
}

/** Creates a REPORTED emergency with its initial timeline entry. */
export async function createEmergency(input: {
  priority: string;
  incidentType: string;
  location: { lat: number; lng: number; address?: string };
  source: string;
  citizenId?: string;
  assignedDispatcher?: string;
  description: string;
  victimCount: number;
  attachments?: EmergencyAttachmentInput[];
  idempotencyKey?: string;
  voiceReportId?: string;
  confirmationOperationId?: string;
}): Promise<CreateEmergencyResult> {
  const _id = await nextId('emergency', 'EMG', 5);
  const now = new Date();

  if (input.idempotencyKey && !isEmergencyIdempotencyIndexReady()) {
    throw ApiError.serviceUnavailable(
      'Idempotent emergency creation is temporarily unavailable: database uniqueness index is unverified. Please retry shortly.',
    );
  }

  try {
    await Emergency.create({
      _id,
      status: 'REPORTED',
      priority: input.priority,
      incidentType: input.incidentType,
      location: input.location,
      source: input.source,
      citizenId: input.citizenId,
      assignedDispatcher: input.assignedDispatcher,
      description: input.description,
      victimCount: input.victimCount,
      reportedAt: now,
      updatedAt: now,
      idempotencyKey: input.idempotencyKey,
      voiceReportId: input.voiceReportId,
      confirmationOperationId: input.confirmationOperationId,
      // Photos arrive already validated (mime, base64 payload, byte size) by
      // createEmergencySchema — the service only stamps the upload time.
      attachments: (input.attachments ?? []).map((a) => ({ ...a, uploadedAt: now })),
      timeline: [
        {
          status: 'REPORTED',
          timestamp: now,
          note: `Reported via ${input.source.replace(/_/g, ' ').toLowerCase()}`,
        },
      ],
    });

    notifyCitizenOnReport({
      _id,
      citizenId: input.citizenId,
      incidentType: input.incidentType,
      priority: input.priority,
      location: input.location,
    }).catch(() => {});
    notifyDispatchersOnNewEmergency({
      _id,
      priority: input.priority,
      incidentType: input.incidentType,
      location: input.location,
    }).catch(() => {});

    return { id: _id, reportedAt: now };
  } catch (err: unknown) {
    if ((err as { code?: number }).code === 11000) {
      if (input.voiceReportId) {
        const existing = await Emergency.findOne({ voiceReportId: input.voiceReportId });
        if (existing) {
          return { id: existing._id, reportedAt: existing.reportedAt };
        }
      }
      if (input.confirmationOperationId) {
        const existing = await Emergency.findOne({ confirmationOperationId: input.confirmationOperationId });
        if (existing) {
          return { id: existing._id, reportedAt: existing.reportedAt };
        }
      }
      if (input.idempotencyKey) {
        const existing = await Emergency.findOne({ idempotencyKey: input.idempotencyKey });
        if (existing) {
          return { id: existing._id, reportedAt: existing.reportedAt };
        }
      }
    }
    throw err;
  }
}

/**
 * Assigns an ambulance to an emergency with conflict-safe ordering:
 * 1. Guarded ambulance claim (status filter is part of the update itself —
 *    if the unit was claimed concurrently, the match fails → 409, so there
 *    is no read-then-write race window).
 * 2. Emergency link + status.
 * 3. Audit + notification.
 * If step 2 fails, the claim is rolled back (compensation) so a unit is
 * never stranded on a phantom assignment.
 */
export interface AssignAmbulanceOptions {
  requestId: string;
  actor: string;
  actorRole: string;
  /**
   * Trusted server-side dispatch policy.
   * - 'MANUAL' (default): Used by human dispatchers via POST /api/dispatch/assign. Evaluates eligibility at assignment time, permits assignment with structured warnings and audit records.
   * - 'STRICT_AUTOMATED': Used by automated dispatch services. Rejects assignment with ApiError.conflict if crew duty or telemetry fails eligibility.
   */
  policy?: DispatchPolicy;
  atTime?: Date;
  telemetryThresholdSeconds?: number;
  /** Optional barrier hook for deterministic race testing (called after ambulance claim, before emergency commit). */
  beforeEmergencyCommit?: (info: { ambulanceId: string; emergencyId: string; claimToken: string }) => Promise<void> | void;
}

export interface AssignAmbulanceResult {
  emergencyId: string;
  ambulanceId: string;
  eligibility: {
    verified: boolean;
    policy: DispatchPolicy;
    warnings: DispatchEligibilityWarning[];
    telemetry: {
      fresh: boolean;
      reason?: string;
      ageSeconds: number | null;
      thresholdSeconds: number;
    };
    crewDuty: {
      eligible: boolean;
      reason?: string;
      message?: string;
      shiftId?: string | null;
      verifiedCrewIds: string[];
    };
  };
}

export async function assignAmbulance(
  emergencyId: string,
  ambulanceId: string,
  opts: AssignAmbulanceOptions,
): Promise<AssignAmbulanceResult> {
  const emergency = await Emergency.findById(emergencyId);
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);
  if (emergency.status === 'COMPLETED' || emergency.status === 'CANCELLED') {
    throw ApiError.conflict(`Emergency ${emergencyId} is already ${emergency.status}`);
  }

  const ambulance = await Ambulance.findById(ambulanceId);
  if (!ambulance) throw ApiError.notFound(`Ambulance ${ambulanceId} not found`);
  if (ambulance.status === 'MAINTENANCE' || ambulance.status === 'OFFLINE') {
    throw ApiError.conflict(`Ambulance ${ambulanceId} is ${ambulance.status}`);
  }

  const policy: DispatchPolicy = opts.policy ?? 'MANUAL';
  const atTime = opts.atTime ?? new Date();

  // Assignment-time eligibility verification
  const eligibility = await isAmbulanceDispatchEligible(ambulanceId, {
    atTime,
    thresholdSeconds: opts.telemetryThresholdSeconds,
  });
  const warnings = formatEligibilityWarnings(eligibility);

  // Policy B: Automated dispatch requires strict eligibility
  if (policy === 'STRICT_AUTOMATED' && !eligibility.eligible) {
    const primaryReason = eligibility.disqualificationReasons[0] ?? 'Ineligible candidate';
    throw ApiError.conflict(
      `Automated dispatch rejected: Ambulance ${ambulanceId} is ineligible (${primaryReason})`,
    );
  }

  const eligibilitySummary = {
    verified: eligibility.eligible,
    policy,
    warnings,
    telemetry: {
      fresh: eligibility.telemetry.fresh,
      reason: eligibility.telemetry.reason,
      ageSeconds: eligibility.telemetry.ageSeconds,
      thresholdSeconds: eligibility.telemetry.thresholdSeconds,
    },
    crewDuty: {
      eligible: eligibility.crewDuty.eligible,
      reason: eligibility.crewDuty.disqualificationReason,
      message: eligibility.crewDuty.message,
      shiftId: eligibility.crewDuty.shiftId ?? null,
      verifiedCrewIds: eligibility.crewDuty.verifiedCrewIds ?? [],
    },
  };

  // Already linked to this same emergency → idempotent success.
  if (emergency.assignedAmbulance === ambulanceId) {
    return {
      emergencyId,
      ambulanceId,
      eligibility: eligibilitySummary,
    };
  }

  const now = new Date();
  const distance = haversineMeters(ambulance.location!, emergency.location!);
  const eta = estimateEtaSeconds(distance);
  const claimToken = `clm_${Date.now()}_${randomUUID().slice(0, 8)}`;

  // Step 1: atomic claim with unique claim token — only succeeds if the unit is still free.
  const claim = await Ambulance.findOneAndUpdate(
    {
      _id: ambulanceId,
      status: { $in: ['AVAILABLE', 'RESERVED'] },
      $or: [{ currentEmergency: null }, { currentEmergency: { $exists: false } }],
    },
    {
      $set: {
        status: 'ASSIGNED',
        currentEmergency: emergencyId,
        claimToken,
        eta,
        lastUpdated: now,
      },
    },
    { new: true },
  ).exec();

  if (!claim) {
    const current = await Ambulance.findById(ambulanceId).lean();
    if (current?.currentEmergency && current.currentEmergency !== emergencyId) {
      throw ApiError.conflict(
        `Ambulance ${ambulanceId} is already assigned to ${current.currentEmergency}`,
      );
    }
    throw ApiError.conflict(`Ambulance ${ambulanceId} is not available for assignment`);
  }

  // Deterministic race-testing barrier hook (called after ambulance claim, before emergency commit)
  if (opts.beforeEmergencyCommit) {
    await opts.beforeEmergencyCommit({ ambulanceId, emergencyId, claimToken });
  }

  // Step 2: link emergency + advance status conditionally
  const previousAmbulanceId = emergency.assignedAmbulance;
  const advanceable: EmergencyStatus[] = ['REPORTED', 'TRIAGED', 'DISPATCHING'];
  const warningSuffix =
    warnings.length > 0 ? ` [Warnings: ${warnings.map((w) => w.code).join(', ')}]` : '';
  const newStatus = advanceable.includes(emergency.status) ? 'AMBULANCE_ASSIGNED' : emergency.status;
  const timelineNote = advanceable.includes(emergency.status)
    ? `${ambulanceId} assigned (ETA ${Math.round(eta / 60)} min)${warningSuffix}`
    : `${ambulanceId} reassigned${warningSuffix}`;

  const emergencyFilter: Record<string, unknown> = {
    _id: emergencyId,
    status: { $nin: ['COMPLETED', 'CANCELLED'] },
  };
  if (!previousAmbulanceId) {
    emergencyFilter.$or = [
      { assignedAmbulance: null },
      { assignedAmbulance: { $exists: false } },
      { assignedAmbulance: '' },
    ];
  } else {
    emergencyFilter.assignedAmbulance = previousAmbulanceId;
  }

  try {
    const updatedEmergency = await Emergency.findOneAndUpdate(
      emergencyFilter,
      {
        $set: {
          assignedAmbulance: ambulanceId,
          ambulanceClaimToken: claimToken,
          assignedCrew: ambulance.crew.length > 0 ? ambulance.crew.map((c) => c.name) : undefined,
          assignedCrewIds: ambulance.crew.map((c) => c.userId).filter((id): id is string => Boolean(id)),
          eta,
          updatedAt: now,
          status: newStatus,
        },
        $push: {
          timeline: {
            status: newStatus,
            timestamp: now,
            note: timelineNote,
          },
        },
      },
      { new: true },
    ).exec();

    if (!updatedEmergency) {
      // Emergency was modified, cancelled, or reassigned concurrently while our claim was in flight
      await Ambulance.updateOne(
        { _id: ambulanceId, claimToken },
        {
          $set: {
            status: 'AVAILABLE',
            currentEmergency: null,
            claimToken: null,
            eta: undefined,
            lastUpdated: new Date(),
          },
        },
      ).exec();
      throw ApiError.conflict(
        `Emergency ${emergencyId} was concurrently modified or cancelled; assignment aborted`,
      );
    }

    // Step 2b: Mutual Fencing Verification
    // Verify that our ambulance claim was NOT reclaimed or superseded during the emergency update
    const confirmedAmbulance = await Ambulance.findOneAndUpdate(
      {
        _id: ambulanceId,
        currentEmergency: emergencyId,
        claimToken, // MUST match our exact generation
        status: 'ASSIGNED',
      },
      {
        $set: {
          lastUpdated: new Date(),
        },
      },
      { new: true },
    ).exec();

    if (!confirmedAmbulance) {
      // Our ambulance claim was superseded or reclaimed while emergency update was executing.
      // Roll back emergency link strictly guarded by our exact claimToken.
      await Emergency.updateOne(
        { _id: emergencyId, ambulanceClaimToken: claimToken },
        {
          $set: {
            status: emergency.status,
            updatedAt: new Date(),
          },
          $unset: {
            assignedAmbulance: '',
            ambulanceClaimToken: '',
            assignedCrew: '',
            assignedCrewIds: '',
            eta: '',
          },
        },
      ).exec();
      throw ApiError.conflict(
        `Assignment superseded: ambulance ${ambulanceId} claim generation expired or was reclaimed`,
      );
    }
  } catch (err) {
    // If the emergency was already conditionally updated with our claimToken, roll it back
    await Emergency.updateOne(
      { _id: emergencyId, ambulanceClaimToken: claimToken },
      {
        $set: {
          status: emergency.status,
          updatedAt: new Date(),
        },
        $unset: {
          assignedAmbulance: '',
          ambulanceClaimToken: '',
          assignedCrew: '',
          assignedCrewIds: '',
          eta: '',
        },
      },
    ).exec();

    // Compensate: release the claim we just made so the unit isn't stranded, guarded by claimToken.
    await Ambulance.updateOne(
      { _id: ambulanceId, claimToken },
      {
        $set: {
          status: 'AVAILABLE',
          currentEmergency: null,
          claimToken: null,
          eta: undefined,
          lastUpdated: new Date(),
        },
      },
    ).exec();
    throw err;
  }

  // Release the unit this incident displaces, if any. Guarded by
  // `currentEmergency` so a unit that has already been re-tasked elsewhere is
  // never pulled off a live job.
  if (previousAmbulanceId && previousAmbulanceId !== ambulanceId) {
    await Ambulance.updateOne(
      { _id: previousAmbulanceId, currentEmergency: emergencyId },
      {
        $set: {
          status: 'AVAILABLE',
          currentEmergency: null,
          claimToken: null,
          eta: undefined,
          lastUpdated: now,
        },
      },
    ).exec();
  }

  // Step 3: side effects (awaited via allSettled so they can't fail the call).
  const crewUserIds = ambulance.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
  await Promise.allSettled([
    recordAudit({
      actor: opts.actor,
      actorRole: opts.actorRole as never,
      action: 'dispatch.assigned',
      resource: 'Ambulance',
      resourceId: ambulanceId,
      requestId: opts.requestId,
      details: `Assigned to ${emergencyId}${
        warnings.length > 0
          ? ` with warnings: ${warnings.map((w) => w.code).join(', ')}`
          : ' (verified active crew & telemetry)'
      }`,
      newState: {
        emergencyId,
        ambulanceId,
        verified: eligibility.eligible,
        policy,
        warnings: warnings.map((w) => w.code),
      },
    }),
    notifyCitizenOnAmbulanceAssignment(emergencyId, emergency.citizenId, ambulanceId, eta),
    notifyCrewOnAssignment(ambulanceId, crewUserIds, {
      _id: emergency._id,
      incidentType: emergency.incidentType,
      priority: emergency.priority,
      location: emergency.location ?? undefined,
    }),
    ...(previousAmbulanceId && previousAmbulanceId !== ambulanceId
      ? [
          Ambulance.findById(previousAmbulanceId).lean().then((prev) => {
            if (prev) {
              const prevCrewIds = prev.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
              return notifyCrewOnAssignmentCancelled(previousAmbulanceId, prevCrewIds, emergencyId, `Reassigned to unit ${ambulanceId}`);
            }
          }),
        ]
      : []),
  ]);

  return { emergencyId, ambulanceId, eligibility: eligibilitySummary };
}

/**
 * Ensures an emergency linked to an ambulance has its assigned crew and
 * crew userIds synchronized from the active ambulance roster.
 *
 * If the emergency has an assigned ambulance but its denormalized `assignedCrew`
 * is missing or empty, this fetches the ambulance, populates the fields, and
 * asynchronously updates the database record.
 */
export async function syncEmergencyCrewFromAmbulance(emergency: EmergencyDoc): Promise<void> {
  if (!emergency.assignedAmbulance) return;
  if (emergency.assignedCrew && emergency.assignedCrew.length > 0) return;

  const amb = await Ambulance.findById(emergency.assignedAmbulance).lean();
  if (amb && amb.crew && amb.crew.length > 0) {
    emergency.assignedCrew = amb.crew.map((c) => c.name);
    emergency.assignedCrewIds = amb.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid));
    await Emergency.updateOne(
      { _id: emergency._id, $or: [{ assignedCrew: { $exists: false } }, { assignedCrew: { $size: 0 } }] },
      { $set: { assignedCrew: emergency.assignedCrew, assignedCrewIds: emergency.assignedCrewIds } },
    ).exec();
  }
}

/**
 * Batched synchronization for multiple emergencies (e.g. queue listing).
 */
export async function syncEmergenciesCrewFromAmbulances(emergencies: EmergencyDoc[]): Promise<void> {
  const unlinked = emergencies.filter(
    (e) => e.assignedAmbulance && (!e.assignedCrew || e.assignedCrew.length === 0),
  );
  if (unlinked.length === 0) return;

  const ambIds = [...new Set(unlinked.map((e) => e.assignedAmbulance!))];
  const ambulances = await Ambulance.find({ _id: { $in: ambIds } }).lean();
  const ambMap = new Map(ambulances.map((a) => [a._id, a]));

  for (const e of unlinked) {
    const amb = ambMap.get(e.assignedAmbulance!);
    if (amb && amb.crew && amb.crew.length > 0) {
      e.assignedCrew = amb.crew.map((c) => c.name);
      e.assignedCrewIds = amb.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid));
      void Emergency.updateOne(
        { _id: e._id, $or: [{ assignedCrew: { $exists: false } }, { assignedCrew: { $size: 0 } }] },
        { $set: { assignedCrew: e.assignedCrew, assignedCrewIds: e.assignedCrewIds } },
      ).exec();
    }
  }
}

export type OverrideAction = 'REASSIGN_AMBULANCE' | 'ESCALATE' | 'ROUTE_HOSPITAL' | 'ACTIVATE_GREEN_CORRIDOR';

/**
 * Builds a bounded, auditable snapshot of an emergency.
 *
 * `Emergency.toObject()` includes `attachments[].dataUrl` — up to four 2 MB
 * photos as base64, ~10.7 MB per snapshot. Storing that twice per override
 * inflated the audit collection by gigabytes, made `GET /api/audit` (500 rows)
 * an unbounded response, and copied patient photographs into a collection whose
 * retention and access model is entirely different from the incident record's.
 *
 * The snapshot therefore records what actually matters for proving *what
 * changed*: identity, routing, status, and a photo **count** (not contents).
 * `toClientAudit` still applies patient-scope sanitization on read.
 */
function auditSnapshot(emergency: { toObject(): Record<string, unknown> }): Record<string, unknown> {
  const raw = emergency.toObject() as Record<string, unknown>;
  const attachments = Array.isArray(raw.attachments) ? raw.attachments : [];
  return {
    status: raw.status,
    priority: raw.priority,
    incidentType: raw.incidentType,
    destinationHospital: raw.destinationHospital,
    assignedAmbulance: raw.assignedAmbulance,
    greenCorridorActive: raw.greenCorridorActive,
    eta: raw.eta,
    overrideCount: raw.overrideCount,
    attachmentCount: attachments.length,
    updatedAt: raw.updatedAt,
  };
}

export interface EmergencyOverrideInput {
  reason: string;
  action: OverrideAction;
  ambulanceId?: string;
  hospitalId?: string;
  priority?: Priority;
}

/** Applies a controlled break-glass change and records the complete state delta. */
export async function overrideEmergency(
  emergencyId: string,
  input: EmergencyOverrideInput,
  opts: { requestId: string; actor: string; actorId: string; actorRole: string; ip?: string; userAgent?: string },
): Promise<{ emergency: EmergencyDoc; resourceId: string; previousState: Record<string, unknown>; newState: Record<string, unknown> }> {
  const emergency = await Emergency.findById(emergencyId);
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);
  if (emergency.status === 'COMPLETED' || emergency.status === 'CANCELLED') throw ApiError.conflict(`Emergency ${emergencyId} is already ${emergency.status}`);

  const previousState = auditSnapshot(emergency);
  const now = new Date();
  let resourceId = emergencyId;
  let replacementClaimed = false;
  let overrideWarningSuffix = '';

  if (input.action === 'REASSIGN_AMBULANCE') {
    if (!input.ambulanceId) throw ApiError.badRequest('ambulanceId is required for ambulance reassignment');
    const ambulance = await Ambulance.findById(input.ambulanceId);
    if (!ambulance || ambulance.active === false) throw ApiError.notFound(`Ambulance ${input.ambulanceId} not found`);
    if (ambulance.status === 'MAINTENANCE' || ambulance.status === 'OFFLINE') throw ApiError.conflict(`Ambulance ${input.ambulanceId} is ${ambulance.status}`);
    const previousAmbulanceId = emergency.assignedAmbulance;
    const overrideEligibility = await isAmbulanceDispatchEligible(input.ambulanceId, { atTime: now });
    const overrideWarnings = formatEligibilityWarnings(overrideEligibility);
    if (overrideWarnings.length > 0) {
      overrideWarningSuffix = ` [Warnings: ${overrideWarnings.map((w) => w.code).join(', ')}]`;
    }

    let claimToken: string | undefined;
    if (input.ambulanceId !== previousAmbulanceId) {
      claimToken = `clm_${Date.now()}_${randomUUID().slice(0, 8)}`;
      const claimed = await Ambulance.findOneAndUpdate(
        { _id: input.ambulanceId, status: { $in: ['AVAILABLE', 'RESERVED'] }, $or: [{ currentEmergency: null }, { currentEmergency: { $exists: false } }] },
        { $set: { status: 'ASSIGNED', currentEmergency: emergencyId, claimToken, lastUpdated: now } },
        { new: true },
      );
      if (!claimed) throw ApiError.conflict(`Ambulance ${input.ambulanceId} is not available for override reassignment`);
      replacementClaimed = true;
      emergency.assignedAmbulance = input.ambulanceId;
      emergency.ambulanceClaimToken = claimToken;
      emergency.assignedCrew = ambulance.crew.length > 0 ? ambulance.crew.map((c) => c.name) : undefined;
      emergency.assignedCrewIds = ambulance.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
    }
    resourceId = input.ambulanceId;
    if (!['AMBULANCE_ASSIGNED', 'EN_ROUTE', 'AT_SCENE', 'PATIENT_ONBOARD', 'EN_ROUTE_TO_HOSPITAL', 'AT_HOSPITAL'].includes(emergency.status)) emergency.status = 'AMBULANCE_ASSIGNED';
    if (previousAmbulanceId && previousAmbulanceId !== input.ambulanceId) {
      try {
        await emergency.save();
        await Ambulance.updateOne({ _id: previousAmbulanceId, currentEmergency: emergencyId }, { $set: { status: 'AVAILABLE', currentEmergency: null, claimToken: null, eta: undefined, lastUpdated: now } });
      } catch (error) {
        if (replacementClaimed) await Ambulance.updateOne({ _id: input.ambulanceId, currentEmergency: emergencyId, ...(claimToken ? { claimToken } : {}) }, { $set: { status: 'AVAILABLE', currentEmergency: null, claimToken: null, lastUpdated: now } });
        throw error;
      }
    }
  } else if (input.action === 'ESCALATE') {
    emergency.priority = input.priority ?? 'CRITICAL';
  } else if (input.action === 'ROUTE_HOSPITAL') {
    if (!input.hospitalId) throw ApiError.badRequest('hospitalId is required for hospital routing');
    const hospital = await Hospital.findById(input.hospitalId);
    if (!hospital || hospital.active === false) throw ApiError.notFound(`Hospital ${input.hospitalId} not found`);
    if (hospital.status === 'OFFLINE') throw ApiError.conflict(`Hospital ${input.hospitalId} is OFFLINE`);

    // Atomically reserve capacity or reroute existing reservation
    const previousHospitalId = emergency.destinationHospital;
    let reservationDoc: HospitalReservationDoc | undefined;
    if (previousHospitalId && previousHospitalId !== input.hospitalId) {
      reservationDoc = await rerouteHospitalReservation(emergencyId, input.hospitalId, 'EMERGENCY_ACCEPTANCE', {
        actor: opts.actor,
        actorRole: opts.actorRole as never,
        requestId: opts.requestId,
      });
    } else {
      reservationDoc = await reserveHospitalCapacity(emergencyId, input.hospitalId, 'EMERGENCY_ACCEPTANCE', {
        actor: opts.actor,
        actorRole: opts.actorRole as never,
        requestId: opts.requestId,
      });
    }

    emergency.destinationHospital = input.hospitalId;
    if (reservationDoc) {
      emergency.hospitalReservationId = reservationDoc._id;
    }
    if (emergency.assignedAmbulance) await Ambulance.updateOne({ _id: emergency.assignedAmbulance, currentEmergency: emergencyId }, { $set: { destinationHospital: input.hospitalId, lastUpdated: now } });
    resourceId = input.hospitalId;
  } else {
    if (!emergency.assignedAmbulance || !emergency.destinationHospital) throw ApiError.conflict('Green Corridor override requires an assigned ambulance and destination hospital');
    const [ambulance, hospital] = await Promise.all([Ambulance.findById(emergency.assignedAmbulance).lean(), Hospital.findById(emergency.destinationHospital).lean()]);
    if (!ambulance || ambulance.active === false) throw ApiError.conflict('Assigned ambulance is not active');
    if (!hospital || hospital.active === false || hospital.status === 'OFFLINE') throw ApiError.conflict('Destination hospital is not available');
    emergency.greenCorridorActive = true;
    emergency.greenCorridorActivatedAt = now;
    emergency.greenCorridorActivatedBy = opts.actorId;
    resourceId = emergency.assignedAmbulance;
  }

  emergency.updatedAt = now;
  emergency.overrideCount = (emergency.overrideCount ?? 0) + 1;
  emergency.timeline.push({ status: emergency.status, timestamp: now, note: `Break-glass ${input.action}: ${input.reason}${overrideWarningSuffix}` });
  await emergency.save();
  const newState = auditSnapshot(emergency);
  await recordAudit({ actor: opts.actor, actorId: opts.actorId, actorRole: opts.actorRole as never, action: 'emergency.override', resource: 'Emergency', resourceId, requestId: opts.requestId, reason: input.reason, previousState, newState, ip: opts.ip, userAgent: opts.userAgent, details: input.action });

  notifySupervisorsOnOverride(emergencyId, opts.actor, input.action, input.reason).catch(() => {});

  if (input.action === 'ROUTE_HOSPITAL' && input.hospitalId) {
    notifyCitizenOnHospitalRerouted(emergencyId, emergency.citizenId, input.hospitalId).catch(() => {});
    if (emergency.assignedAmbulance) {
      Ambulance.findById(emergency.assignedAmbulance).lean().then((amb) => {
        if (amb) {
          const crewIds = amb.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
          notifyCrewOnHospitalRerouted(emergency.assignedAmbulance!, crewIds, emergencyId, input.hospitalId!).catch(() => {});
        }
      }).catch(() => {});
    }
  } else if (input.action === 'REASSIGN_AMBULANCE' && input.ambulanceId) {
    notifyCitizenOnAmbulanceAssignment(emergencyId, emergency.citizenId, input.ambulanceId).catch(() => {});
    Ambulance.findById(input.ambulanceId).lean().then((amb) => {
      if (amb) {
        const crewIds = amb.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
        notifyCrewOnAssignment(input.ambulanceId!, crewIds, {
          _id: emergency._id,
          incidentType: emergency.incidentType,
          priority: emergency.priority,
          location: emergency.location ?? undefined,
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  return { emergency, resourceId, previousState, newState };
}

export interface ReconcileAmbulanceResult {
  checked: number;
  released: string[];
  skippedActive: string[];
}

export const DEFAULT_IN_FLIGHT_ASSIGNMENT_GRACE_MS = 10_000;

export interface ReconcileAmbulanceOptions {
  isCancelled?: () => boolean;
  isLockValid?: () => boolean;
  gracePeriodMs?: number;
}

/**
 * Idempotently reconciles ambulances marked ASSIGNED whose linked emergency
 * is missing, terminal (COMPLETED or CANCELLED), null, or displaced by reassignment
 * or interrupted before emergency save completed.
 *
 * Uses conditional atomic updates (`Ambulance.updateOne({ _id, status: 'ASSIGNED', currentEmergency })`)
 * so an ambulance concurrently retasked or moved to maintenance is never disturbed.
 * Ambulances currently assigned to active emergencies are left untouched.
 */
export async function reconcileStrandedAmbulances(
  opts?: ReconcileAmbulanceOptions,
): Promise<ReconcileAmbulanceResult> {
  if (opts?.isCancelled?.() || (opts?.isLockValid && !opts.isLockValid())) {
    logger.info('Ambulance reconciliation sweep cancelled or lock invalid before querying assigned ambulances');
    return { checked: 0, released: [], skippedActive: [] };
  }

  // Find all ambulances currently in ASSIGNED status
  const assignedAmbulances = await Ambulance.find({
    status: 'ASSIGNED',
  }).lean();

  const released: string[] = [];
  const skippedActive: string[] = [];

  for (const amb of assignedAmbulances) {
    if (opts?.isCancelled?.() || (opts?.isLockValid && !opts.isLockValid())) {
      logger.warn(
        { checkedSoFar: released.length + skippedActive.length, total: assignedAmbulances.length },
        'Ambulance reconciliation sweep halted between items: cancelled or lock lease expired',
      );
      break;
    }

    const isFencedOrCancelled = () =>
      Boolean(opts?.isCancelled?.() || (opts?.isLockValid && !opts.isLockValid()));

    try {
      // 1. Ambulance marked ASSIGNED with null, empty, or missing currentEmergency reference
      if (!amb.currentEmergency) {
        if (isFencedOrCancelled()) {
          logger.warn(
            { ambulanceId: amb._id },
            'Halting reconciliation: lock lease expired or cancellation requested before null-reference update',
          );
          break;
        }

        const casFilter: Record<string, unknown> = {
          _id: amb._id,
          status: 'ASSIGNED',
          $or: [{ currentEmergency: null }, { currentEmergency: { $exists: false } }, { currentEmergency: '' }],
        };
        if (amb.claimToken) casFilter.claimToken = amb.claimToken;
        if (amb.lastUpdated) casFilter.lastUpdated = amb.lastUpdated;

        const updateResult = await Ambulance.updateOne(
          casFilter,
          {
            $set: {
              status: 'AVAILABLE',
              currentEmergency: null,
              claimToken: null,
              eta: undefined,
              lastUpdated: new Date(),
            },
          },
        ).exec();

        if (updateResult.modifiedCount > 0) {
          released.push(amb._id);
          recordFleetRecoveryOutcome('null_reference', 'released');
          await recordAudit({
            actor: 'system.reconcile',
            actorRole: 'ADMIN' as never,
            action: 'reconciliation.ambulance_released',
            resource: 'Ambulance',
            resourceId: amb._id,
            requestId: `reconcile-${Date.now()}`,
            details: `Reconciled stranded ambulance ${amb._id} marked ASSIGNED with null or missing emergency reference`,
          });
        } else {
          recordFleetRecoveryOutcome('null_reference', 'skipped');
          recordFleetCasNoOp('ambulance');
        }
        continue;
      }

      // 2. Ambulance marked ASSIGNED with a currentEmergency reference
      const emergency = await Emergency.findById(amb.currentEmergency).lean();

      // 2a. Linked emergency is missing from database
      if (!emergency) {
        if (isFencedOrCancelled()) {
          logger.warn(
            { ambulanceId: amb._id, currentEmergency: amb.currentEmergency },
            'Halting reconciliation: lock lease expired or cancellation requested before missing-emergency update',
          );
          break;
        }

        const casFilter: Record<string, unknown> = {
          _id: amb._id,
          status: 'ASSIGNED',
          currentEmergency: amb.currentEmergency,
        };
        if (amb.claimToken) casFilter.claimToken = amb.claimToken;
        if (amb.lastUpdated) casFilter.lastUpdated = amb.lastUpdated;

        const updateResult = await Ambulance.updateOne(
          casFilter,
          {
            $set: {
              status: 'AVAILABLE',
              currentEmergency: null,
              claimToken: null,
              eta: undefined,
              lastUpdated: new Date(),
            },
          },
        ).exec();

        if (updateResult.modifiedCount > 0) {
          released.push(amb._id);
          recordFleetRecoveryOutcome('missing_emergency', 'released');
          await recordAudit({
            actor: 'system.reconcile',
            actorRole: 'ADMIN' as never,
            action: 'reconciliation.ambulance_released',
            resource: 'Ambulance',
            resourceId: amb._id,
            requestId: `reconcile-${Date.now()}`,
            details: `Reconciled stranded ambulance ${amb._id} linked to missing emergency ${amb.currentEmergency}`,
          });
        } else {
          recordFleetRecoveryOutcome('missing_emergency', 'skipped');
          recordFleetCasNoOp('ambulance');
        }
        continue;
      }

      // 2b. Linked emergency is in terminal status (COMPLETED or CANCELLED)
      const isTerminal = emergency.status === 'COMPLETED' || emergency.status === 'CANCELLED';
      if (isTerminal) {
        if (isFencedOrCancelled()) {
          logger.warn(
            { ambulanceId: amb._id, currentEmergency: amb.currentEmergency },
            'Halting reconciliation: lock lease expired or cancellation requested before terminal-emergency update',
          );
          break;
        }

        const casFilter: Record<string, unknown> = {
          _id: amb._id,
          status: 'ASSIGNED',
          currentEmergency: amb.currentEmergency,
        };
        if (amb.claimToken) casFilter.claimToken = amb.claimToken;
        if (amb.lastUpdated) casFilter.lastUpdated = amb.lastUpdated;

        const updateResult = await Ambulance.updateOne(
          casFilter,
          {
            $set: {
              status: 'AVAILABLE',
              currentEmergency: null,
              claimToken: null,
              eta: undefined,
              lastUpdated: new Date(),
            },
          },
        ).exec();

        if (updateResult.modifiedCount > 0) {
          released.push(amb._id);
          recordFleetRecoveryOutcome('terminal_emergency', 'released');
          await recordAudit({
            actor: 'system.reconcile',
            actorRole: 'ADMIN' as never,
            action: 'reconciliation.ambulance_released',
            resource: 'Ambulance',
            resourceId: amb._id,
            requestId: `reconcile-${Date.now()}`,
            details: `Reconciled stranded ambulance ${amb._id} linked to terminal emergency ${amb.currentEmergency} (${emergency.status})`,
          });
        } else {
          recordFleetRecoveryOutcome('terminal_emergency', 'skipped');
          recordFleetCasNoOp('ambulance');
        }
        continue;
      }

      // 2c. Linked emergency is active, but its assignedAmbulance does not match this ambulance:
      // Either:
      // - The incident was reassigned to another ambulance (displaced by reassignment)
      // - Or an assignment claim was interrupted before emergency.save() linked the ambulance (unlinked claim)
      const isLinkedToThisAmbulance =
        emergency.assignedAmbulance === amb._id &&
        (!emergency.ambulanceClaimToken || !amb.claimToken || emergency.ambulanceClaimToken === amb.claimToken);

      if (!isLinkedToThisAmbulance) {
        const isDisplacedByOther = Boolean(
          emergency.assignedAmbulance && emergency.assignedAmbulance !== amb._id,
        );

        // If the emergency has no assignedAmbulance set at all, check if this is an in-flight assignment within grace period
        if (!emergency.assignedAmbulance) {
          const claimAgeMs = amb.lastUpdated
            ? Math.max(0, Date.now() - new Date(amb.lastUpdated).getTime())
            : Infinity;
          const gracePeriodMs = opts?.gracePeriodMs ?? DEFAULT_IN_FLIGHT_ASSIGNMENT_GRACE_MS;

          if (claimAgeMs < gracePeriodMs) {
            // Within grace period: could be an in-flight assignAmbulance execution right now. Protect it!
            logger.debug(
              { ambulanceId: amb._id, emergencyId: amb.currentEmergency, claimAgeMs, gracePeriodMs },
              'Ambulance claim is within in-flight grace period; preserving potential active assignment',
            );
            skippedActive.push(amb._id);
            continue;
          }
        }

        // Concurrency safeguard: recheck fresh emergency state before mutation.
        const freshEmergency = await Emergency.findById(amb.currentEmergency).lean();
        if (!freshEmergency) {
          // Emergency vanished between checks: skip mutation and emit structured log
          logger.warn(
            { ambulanceId: amb._id, currentEmergency: amb.currentEmergency },
            'Emergency vanished between initial check and recheck; skipping mutation to establish consistency safely',
          );
          continue;
        }

        // If fresh emergency was legitimately linked to this ambulance in the meantime, do not release
        const freshIsLinked =
          freshEmergency.assignedAmbulance === amb._id &&
          (!freshEmergency.ambulanceClaimToken || !amb.claimToken || freshEmergency.ambulanceClaimToken === amb.claimToken);

        if (freshIsLinked) {
          skippedActive.push(amb._id);
          continue;
        }

        if (isFencedOrCancelled()) {
          logger.warn(
            { ambulanceId: amb._id, currentEmergency: amb.currentEmergency },
            'Halting reconciliation: lock lease expired or cancellation requested before ambulance release',
          );
          break;
        }

        // Recheck confirmed: unit is either displaced by another unit or its claim was interrupted.
        // CAS guard on status, currentEmergency, claimToken, and lastUpdated guarantees we never overwrite concurrent updates.
        const casFilter: Record<string, unknown> = {
          _id: amb._id,
          status: 'ASSIGNED',
          currentEmergency: amb.currentEmergency,
        };
        if (amb.claimToken) {
          casFilter.claimToken = amb.claimToken;
        }
        if (amb.lastUpdated) {
          casFilter.lastUpdated = amb.lastUpdated;
        }

        const updateResult = await Ambulance.updateOne(
          casFilter,
          {
            $set: {
              status: 'AVAILABLE',
              currentEmergency: null,
              claimToken: null,
              eta: undefined,
              lastUpdated: new Date(),
            },
          },
        ).exec();

        if (updateResult.modifiedCount > 0) {
          released.push(amb._id);
          recordFleetRecoveryOutcome('displaced', 'released');
          await recordAudit({
            actor: 'system.reconcile',
            actorRole: 'ADMIN' as never,
            action: 'reconciliation.ambulance_released',
            resource: 'Ambulance',
            resourceId: amb._id,
            requestId: `reconcile-${Date.now()}`,
            details: isDisplacedByOther
              ? `Reconciled displaced ambulance ${amb._id} linked to active emergency ${amb.currentEmergency} (incident assigned to: ${freshEmergency.assignedAmbulance})`
              : `Reconciled stranded unlinked ambulance ${amb._id} linked to active emergency ${amb.currentEmergency} whose assignment was interrupted`,
          });
        } else {
          recordFleetRecoveryOutcome('displaced', 'skipped');
          recordFleetCasNoOp('ambulance');
        }
        continue;
      }

      // 2d. Linked emergency is active and this ambulance is its assigned unit (or active link)
      skippedActive.push(amb._id);
      if (
        emergency.assignedAmbulance === amb._id &&
        (!emergency.assignedCrew || emergency.assignedCrew.length === 0) &&
        amb.crew &&
        amb.crew.length > 0
      ) {
        const assignedCrew = amb.crew.map((c) => c.name);
        const assignedCrewIds = amb.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid));
        await Emergency.updateOne(
          { _id: emergency._id, $or: [{ assignedCrew: { $exists: false } }, { assignedCrew: { $size: 0 } }] },
          { $set: { assignedCrew, assignedCrewIds } },
        ).exec();
      }
    } catch (err) {
      recordFleetRecoveryOutcome('missing_emergency', 'failed');
      logger.error(
        { err, ambulanceId: amb._id, currentEmergency: amb.currentEmergency },
        'Transient failure during stranded ambulance reconciliation; can be retried safely',
      );
    }
  }

  return { checked: assignedAmbulances.length, released, skippedActive };
}

let reconciliationIntervalTimer: NodeJS.Timeout | null = null;
let reconciliationInitialTimer: NodeJS.Timeout | null = null;
let activeSweepPromise: Promise<ReconcileAmbulanceResult> | null = null;
let isReconciliationShuttingDown = false;
let cancelSweepRequested = false;
let reconciliationShutdownPromise: Promise<void> | null = null;

/** Returns whether the periodic ambulance reconciliation scheduler is currently active. */
export function isReconciliationSchedulerRunning(): boolean {
  return reconciliationIntervalTimer !== null || reconciliationInitialTimer !== null;
}

/** Returns whether the reconciliation subsystem has entered shutdown state. */
export function isReconciliationShutdown(): boolean {
  return isReconciliationShuttingDown;
}

/** Explicitly sets reconciliation shutdown state (used in testing and maintenance). */
export function setReconciliationShutdown(shuttingDown: boolean): void {
  if (!shuttingDown && !isTest && isReconciliationShuttingDown) {
    logger.warn('Ignoring attempt to reverse reconciliation shutdown state in production environment');
    return;
  }
  isReconciliationShuttingDown = shuttingDown;
  if (shuttingDown) {
    cancelSweepRequested = true;
  } else {
    cancelSweepRequested = false;
    reconciliationShutdownPromise = null;
  }
}

export interface RunReconciliationSweepOptions {
  useLock?: boolean;
  leaseMs?: number;
  ownerToken?: string;
  gracePeriodMs?: number;
}

/**
 * Executes a single reconciliation sweep with distributed lock coordination,
 * overlap protection, cooperative cancellation, and structured metrics.
 * Rejects immediately if shutdown has begun.
 */
export function runReconciliationSweep(
  opts?: RunReconciliationSweepOptions,
): Promise<ReconcileAmbulanceResult> {
  if (isReconciliationShuttingDown) {
    const err = ApiError.serviceUnavailable('Ambulance reconciliation is unavailable: server is shutting down');
    return Promise.reject(err);
  }

  if (activeSweepPromise) {
    logger.warn('Ambulance reconciliation sweep already in progress; reusing active sweep');
    return activeSweepPromise;
  }

  cancelSweepRequested = false;
  const startTime = Date.now();
  const useLock = opts?.useLock ?? !isTest;
  const ownerToken = opts?.ownerToken ?? `inst-${process.pid}-${randomUUID().slice(0, 8)}`;
  const leaseMs = opts?.leaseMs ?? 60_000;

  const sweep = (async (): Promise<ReconcileAmbulanceResult> => {
    let lock: AcquireLockResult | null = null;
    try {
      if (useLock) {
        lock = await acquireSchedulerLock('ambulance_reconciliation', ownerToken, leaseMs);
        if (!lock.acquired) {
          recordReconciliationSweep('skipped_locked');
          if (lock.reason === 'HELD_BY_OTHER') {
            logger.debug(
              { lockId: 'ambulance_reconciliation' },
              'Scheduled reconciliation sweep skipped: lock held by another instance',
            );
          } else {
            logger.warn(
              { lockId: 'ambulance_reconciliation', reason: lock.reason },
              'Scheduled reconciliation sweep skipped: lock store error',
            );
          }
          return { checked: 0, released: [], skippedActive: [] };
        }
      }

      let lockExpired = false;
      const outcome = await reconcileStrandedAmbulances({
        isCancelled: () => cancelSweepRequested || isReconciliationShuttingDown || lockExpired,
        isLockValid: () => {
          if (!lock || !lock.expiresAt) return true;
          if (Date.now() >= lock.expiresAt.getTime()) {
            lockExpired = true;
            return false;
          }
          return true;
        },
        gracePeriodMs: opts?.gracePeriodMs,
      });

      const durationMs = Date.now() - startTime;
      recordReconciliationSweep('success', Math.max(0, durationMs / 1000));
      logger.info(
        {
          durationMs,
          checked: outcome.checked,
          releasedCount: outcome.released.length,
          releasedIds: outcome.released,
          skippedActiveCount: outcome.skippedActive.length,
        },
        'Ambulance reconciliation sweep completed successfully',
      );
      return outcome;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      recordReconciliationSweep('failure', Math.max(0, durationMs / 1000));
      logger.error(
        { err, durationMs },
        'Ambulance reconciliation sweep encountered an error; will retry on next schedule',
      );
      throw err;
    } finally {
      if (lock && lock.acquired && lock.ownerToken && lock.fenceToken !== undefined) {
        await releaseSchedulerLock('ambulance_reconciliation', lock.ownerToken, lock.fenceToken);
      }
      activeSweepPromise = null;
    }
  })();

  activeSweepPromise = sweep;
  return sweep;
}

/**
 * Starts a retryable scheduled ambulance reconciliation sweeper.
 *
 * @param intervalMs Cycle interval (defaults to 10 minutes: 600,000 ms).
 * @param initialJitterMs Initial random delay (defaults to 0-30s) to prevent cross-instance thundering herd.
 */
export function startAmbulanceReconciliationScheduler(
  intervalMs = 10 * 60 * 1000,
  initialJitterMs?: number,
): void {
  if (isReconciliationShuttingDown && !isTest) {
    logger.warn('Cannot start ambulance reconciliation scheduler: server is in shutdown state');
    return;
  }
  isReconciliationShuttingDown = false;
  cancelSweepRequested = false;
  reconciliationShutdownPromise = null;

  // Clear any existing active schedule
  if (reconciliationInitialTimer) {
    clearTimeout(reconciliationInitialTimer);
    reconciliationInitialTimer = null;
  }
  if (reconciliationIntervalTimer) {
    clearInterval(reconciliationIntervalTimer);
    reconciliationIntervalTimer = null;
  }

  const jitter = initialJitterMs !== undefined ? initialJitterMs : Math.floor(Math.random() * 30_000);

  reconciliationInitialTimer = setTimeout(() => {
    reconciliationInitialTimer = null;
    if (isReconciliationShuttingDown) return;

    runReconciliationSweep({ useLock: true }).catch((err) => {
      logger.error({ err }, 'Initial scheduled ambulance reconciliation sweep failed');
    });

    reconciliationIntervalTimer = setInterval(() => {
      if (isReconciliationShuttingDown) return;
      runReconciliationSweep({ useLock: true }).catch((err) => {
        logger.error({ err }, 'Periodic scheduled ambulance reconciliation sweep failed');
      });
    }, intervalMs);

    if (typeof reconciliationIntervalTimer.unref === 'function') {
      reconciliationIntervalTimer.unref();
    }
  }, jitter);

  if (typeof reconciliationInitialTimer.unref === 'function') {
    reconciliationInitialTimer.unref();
  }

  logger.info(
    { intervalMs, initialJitterMs: jitter },
    'Periodic ambulance reconciliation scheduler initialized',
  );
}

export interface DrainTimeoutError extends Error {
  isDrainTimeout: true;
}

/**
 * Gracefully stops the reconciliation scheduler, signals cooperative cancellation to active sweeps,
 * and awaits in-flight work. If the sweep fails to drain within gracePeriodMs, it throws a DrainTimeoutError
 * so the process lifecycle executes a safe fail-stop policy rather than disconnecting MongoDB under active queries.
 */
export function stopAmbulanceReconciliationScheduler(gracePeriodMs = 5_000): Promise<void> {
  if (reconciliationShutdownPromise) {
    return reconciliationShutdownPromise;
  }

  reconciliationShutdownPromise = (async () => {
    isReconciliationShuttingDown = true;
    cancelSweepRequested = true;

    if (reconciliationInitialTimer) {
      clearTimeout(reconciliationInitialTimer);
      reconciliationInitialTimer = null;
    }
    if (reconciliationIntervalTimer) {
      clearInterval(reconciliationIntervalTimer);
      reconciliationIntervalTimer = null;
    }

    if (activeSweepPromise) {
      logger.info('Awaiting in-flight ambulance reconciliation sweep to drain before shutdown');

      let timedOut = false;
      let timerHandle: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => {
        timerHandle = setTimeout(() => {
          timedOut = true;
          resolve('TIMEOUT');
        }, gracePeriodMs);
      });

      const winner = await Promise.race([
        activeSweepPromise.then(() => 'DRAINED' as const).catch(() => 'DRAINED' as const),
        timeoutPromise,
      ]);

      if (timerHandle) {
        clearTimeout(timerHandle);
      }

      if (winner === 'TIMEOUT' || timedOut) {
        logger.fatal(
          { gracePeriodMs },
          'CRITICAL: In-flight ambulance reconciliation sweep did not drain within grace period; fail-stop invoked to prevent database disconnect while queries run',
        );
        const drainError = new Error(`Reconciliation sweep drain timed out after ${gracePeriodMs}ms`) as DrainTimeoutError;
        drainError.isDrainTimeout = true;
        throw drainError;
      }

      logger.info('In-flight ambulance reconciliation sweep drained successfully');
    }

    logger.info('Periodic ambulance reconciliation scheduler stopped');
  })();

  return reconciliationShutdownPromise;
}


