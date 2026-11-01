import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { Hospital, HospitalReservation, Emergency, Ambulance, type HospitalReservationDoc } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { recordAudit } from './auditService.js';
import { acquireSchedulerLock, releaseSchedulerLock } from './distributedLock.js';
import type { Role, HospitalResourceType, ReservationStatus } from '../validation/constants.js';
import { logger } from '../config/logger.js';
import { env, isTest } from '../config/env.js';
import {
  notifyCitizenOnHospitalRerouted,
  notifyCrewOnHospitalRerouted,
  notifyDispatchersOnHospitalReservationFailure,
} from './notificationService.js';

export const DEFAULT_RESERVATION_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes
export const DEFAULT_IN_FLIGHT_RESERVATION_GRACE_MS = 60 * 1000; // 1 minute

export interface ReserveHospitalCapacityOptions {
  requestId?: string;
  actor?: string;
  actorRole?: Role;
  expiryMs?: number;
  idempotencyKey?: string;
  notes?: string;
  /** Injected barrier hook: crash after capacity claim / before persistence (or before confirmation) */
  beforePersistenceHook?: (context: {
    reservationId: string;
    hospitalId: string;
    emergencyId: string;
  }) => Promise<void>;
  /** Injected barrier hook: crash after reservation doc is persisted, before Hospital CAS */
  beforeHospitalCasHook?: (context: {
    reservationId: string;
    hospitalId: string;
    emergencyId: string;
  }) => Promise<void>;
  /** Injected barrier hook: crash after Hospital CAS succeeded, before reservation updated to CONFIRMED */
  beforeConfirmHook?: (context: {
    reservationId: string;
    hospitalId: string;
    emergencyId: string;
  }) => Promise<void>;
  /** Injected barrier hook: crash after reservation is CONFIRMED, before Emergency linkage */
  beforeEmergencyCommitHook?: (context: {
    reservationId: string;
    hospitalId: string;
    emergencyId: string;
  }) => Promise<void>;
}

export interface ReleaseReservationOptions {
  requestId?: string;
  actor?: string;
  actorRole?: Role;
  status?: 'RELEASED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED';
  reason?: string;
  /** Injected barrier hook: crash after reservation marked terminal, before Hospital compensation */
  beforeHospitalReleaseHook?: (context: {
    reservationId: string;
    hospitalId: string;
  }) => Promise<void>;
}

export interface ReleaseReservationResult {
  released: boolean;
  alreadyReleased: boolean;
  reservationId: string;
  hospitalId?: string;
  status?: ReservationStatus;
  reason?: string;
}

export interface HospitalReconciliationOptions {
  batchSize?: number;
  gracePeriodMs?: number;
  hospitalId?: string;
  excludeEmergencyIds?: string[];
}
export type ReconciliationOptions = HospitalReconciliationOptions;

export interface ReconciliationResult {
  expiredCount: number;
  orphanedCount: number;
  interruptedCount: number;
  danglingClaimsRecoveredCount: number;
  reconciledReservations: string[];
  skippedActive: string[];
}

/**
 * Parses the resource type encoded into a reservation identity string if present.
 */
export function parseResourceTypeFromReservationId(reservationId: string): HospitalResourceType | null {
  if (reservationId.startsWith('RES-ICU_BED-') || reservationId.includes('-ICU_BED-')) return 'ICU_BED';
  if (reservationId.startsWith('RES-GENERAL_BED-') || reservationId.includes('-GENERAL_BED-')) return 'GENERAL_BED';
  if (reservationId.startsWith('RES-TRAUMA_BAY-') || reservationId.includes('-TRAUMA_BAY-')) return 'TRAUMA_BAY';
  if (reservationId.startsWith('RES-EMERGENCY_ACCEPTANCE-') || reservationId.includes('-EMERGENCY_ACCEPTANCE-')) return 'EMERGENCY_ACCEPTANCE';
  return null;
}

/**
 * Validates hospital resource eligibility and returns the atomic CAS query + update
 * for conditional single-document reservation on the Hospital collection.
 */
function buildHospitalCasUpdate(resourceType: HospitalResourceType) {
  const baseFilter: Record<string, unknown> = {
    status: { $in: ['OPERATIONAL', 'DEGRADED'] },
    active: true,
    emergencyCapacity: { $ne: 'FULL' },
  };

  const incUpdate: Record<string, number> = {
    incomingAmbulances: 1,
  };

  let bedTypeDecremented: 'icuBeds' | 'generalBeds' | null = null;

  switch (resourceType) {
    case 'ICU_BED':
      baseFilter.icuCapacity = { $ne: 'FULL' };
      baseFilter.icuBeds = { $gte: 1 };
      incUpdate.icuBeds = -1;
      bedTypeDecremented = 'icuBeds';
      break;

    case 'GENERAL_BED':
      baseFilter.generalBeds = { $gte: 1 };
      incUpdate.generalBeds = -1;
      bedTypeDecremented = 'generalBeds';
      break;

    case 'TRAUMA_BAY':
      baseFilter.traumaAvailable = true;
      bedTypeDecremented = null;
      break;

    case 'EMERGENCY_ACCEPTANCE':
      // Emergency intake capacity is conditioned on emergencyCapacity !== 'FULL'
      bedTypeDecremented = null;
      break;

    default:
      throw ApiError.badRequest(`Unsupported hospital resource type '${resourceType}'`);
  }

  return { filter: baseFilter, inc: incUpdate, bedTypeDecremented };
}

/**
 * Atomically reserves hospital capacity for an emergency using single-document CAS.
 * 
 * Guarantees under standalone MongoDB:
 * 1. Mutual Exclusion / Capacity Bounds: Two emergencies competing for the last resource cannot both succeed.
 * 2. Durable State Machine: Pre-allocates reservation in PENDING state before hospital CAS;
 *    unconfirmed reservations can be identified and recovered even if Node dies abruptly.
 * 3. Exact Compensation: Uses activeReservationIds on Hospital to ensure capacity is compensated at most once.
 * 4. Never decrements occupied beds or restores unallocated capacity.
 */
export async function reserveHospitalCapacity(
  emergencyId: string,
  hospitalId: string,
  resourceType: HospitalResourceType,
  options?: ReserveHospitalCapacityOptions,
): Promise<HospitalReservationDoc> {
  const now = new Date();
  const requestId = options?.requestId ?? `req-res-${Date.now()}`;
  const actor = options?.actor ?? 'system';
  const actorRole = (options?.actorRole ?? 'DISPATCHER') as Role;
  const expiryMs = options?.expiryMs ?? DEFAULT_RESERVATION_EXPIRY_MS;
  const expiresAt = new Date(now.getTime() + expiryMs);

  // 1. Idempotency check: if an active unexpired reservation already exists for this emergency, reuse it
  const activeExisting = await HospitalReservation.findOne({
    emergencyId,
    hospitalId,
    resourceType,
    status: { $in: ['PENDING', 'CONFIRMED'] },
    expiresAt: { $gt: now },
  }).exec();

  if (activeExisting) {
    return activeExisting;
  }

  // Also check idempotencyKey if provided
  if (options?.idempotencyKey) {
    const keyed = await HospitalReservation.findOne({
      idempotencyKey: options.idempotencyKey,
    }).exec();
    if (keyed) {
      return keyed;
    }
  }

  // 2. Build atomic conditional query for Hospital single-document update
  const { filter, inc, bedTypeDecremented } = buildHospitalCasUpdate(resourceType);
  const claimToken = `clm_hosp_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const reservationId = options?.idempotencyKey
    ? `RES-${resourceType}-${options.idempotencyKey}`
    : `RES-${resourceType}-${Date.now()}-${randomUUID().slice(0, 8)}`;

  // Step 1: Pre-allocate durable reservation in PENDING state
  let reservation: HospitalReservationDoc;
  try {
    reservation = await HospitalReservation.create({
      _id: reservationId,
      emergencyId,
      hospitalId,
      resourceType,
      status: 'PENDING',
      capacityApplied: false,
      capacityCompensated: false,
      allocatedUnits: 1,
      bedTypeDecremented,
      incomingAmbulanceIncremented: true,
      claimToken,
      expiresAt,
      idempotencyKey: options?.idempotencyKey,
      notes: options?.notes,
    });
  } catch (createErr: unknown) {
    if ((createErr as { code?: number })?.code === 11000) {
      // Concurrent duplicate request caught by unique index on idempotencyKey or _id
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await HospitalReservation.findOne({
          $or: [
            ...(options?.idempotencyKey ? [{ idempotencyKey: options.idempotencyKey }] : []),
            { _id: reservationId },
            { emergencyId, hospitalId, resourceType, status: { $in: ['PENDING', 'CONFIRMED'] } },
          ],
        }).exec();
        if (existing && existing.status === 'CONFIRMED') {
          return existing;
        }
        if (existing && attempt === 9) {
          return existing;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    throw createErr;
  }

  // Crash barrier hook 1: Simulated crash between reservation pre-allocation and Hospital CAS
  if (options?.beforeHospitalCasHook) {
    await options.beforeHospitalCasHook({ reservationId, hospitalId, emergencyId });
  }

  // Step 2: Atomic single-document CAS update on Hospital
  // Both adjusts counters and records reservationId in activeReservationIds atomically
  const updatedHospital = await Hospital.findOneAndUpdate(
    {
      _id: hospitalId,
      ...filter,
    },
    {
      $inc: inc,
      $push: { activeReservationIds: reservationId },
      $set: { updatedAt: now },
    },
    { new: true },
  ).exec();

  if (!updatedHospital) {
    // Capacity claim failed: delete pre-allocated reservation so no phantom doc remains
    await HospitalReservation.deleteOne({ _id: reservationId }).exec();

    const hospital = await Hospital.findById(hospitalId).lean();
    let failureDetail = `Hospital ${hospitalId} is not eligible or capacity is exhausted for ${resourceType}`;
    if (!hospital || hospital.active === false) {
      failureDetail = `Hospital ${hospitalId} not found or deactivated`;
    } else if (hospital.status === 'OFFLINE') {
      failureDetail = `Hospital ${hospitalId} is OFFLINE`;
    } else if (hospital.emergencyCapacity === 'FULL') {
      failureDetail = `Hospital ${hospitalId} emergencyCapacity is FULL`;
    } else if (resourceType === 'ICU_BED' && (hospital.icuCapacity === 'FULL' || (hospital.icuBeds ?? 0) < 1)) {
      failureDetail = `Hospital ${hospitalId} ICU capacity exhausted (icuBeds: ${hospital.icuBeds ?? 0})`;
    } else if (resourceType === 'GENERAL_BED' && (hospital.generalBeds ?? 0) < 1) {
      failureDetail = `Hospital ${hospitalId} general beds exhausted (generalBeds: ${hospital.generalBeds ?? 0})`;
    } else if (resourceType === 'TRAUMA_BAY' && !hospital.traumaAvailable) {
      failureDetail = `Hospital ${hospitalId} has no trauma bay available`;
    }

    await recordAudit({
      actor,
      actorRole,
      action: 'hospital.reservation_failed',
      resource: 'Hospital',
      resourceId: hospitalId,
      requestId,
      result: 'FAILURE',
      details: `${failureDetail} (emergency: ${emergencyId})`,
    });

    notifyDispatchersOnHospitalReservationFailure(emergencyId, hospitalId, failureDetail).catch(() => {});

    throw ApiError.conflict(failureDetail);
  }

  const reverseInc: Record<string, number> = {};
  if (inc.incomingAmbulances) reverseInc.incomingAmbulances = -inc.incomingAmbulances;
  if (bedTypeDecremented) reverseInc[bedTypeDecremented] = 1;

  try {
    // Crash barrier hooks: simulated failure after hospital capacity updated, before persistence/confirmation
    if (options?.beforePersistenceHook) {
      await options.beforePersistenceHook({ reservationId, hospitalId, emergencyId });
    }
    if (options?.beforeConfirmHook) {
      await options.beforeConfirmHook({ reservationId, hospitalId, emergencyId });
    }

    // Step 3: Transition reservation from PENDING to CONFIRMED
    const confirmedReservation = await HospitalReservation.findOneAndUpdate(
      { _id: reservationId, status: 'PENDING' },
      {
        $set: {
          status: 'CONFIRMED',
          capacityApplied: true,
          confirmedAt: now,
          updatedAt: now,
        },
      },
      { new: true },
    ).exec();

    if (confirmedReservation) {
      reservation = confirmedReservation;
    }
  } catch (confirmErr) {
    // If hook or confirmation threw within Node.js, perform immediate compensation
    await Hospital.updateOne(
      { _id: hospitalId, activeReservationIds: reservationId },
      {
        $pull: { activeReservationIds: reservationId },
        $inc: reverseInc,
        $set: { updatedAt: now },
      },
    ).exec();
    await HospitalReservation.deleteOne({ _id: reservationId }).exec();
    throw confirmErr;
  }

  // Crash barrier hook 3: Simulated crash between reservation confirmation and emergency linkage
  if (options?.beforeEmergencyCommitHook) {
    await options.beforeEmergencyCommitHook({ reservationId, hospitalId, emergencyId });
  }

  // Step 4: Link emergency document if active
  try {
    const updatedEmergency = await Emergency.findOneAndUpdate(
      {
        _id: emergencyId,
        status: { $nin: ['COMPLETED', 'CANCELLED'] },
      },
      {
        $set: {
          destinationHospital: hospitalId,
          hospitalReservationId: reservationId,
          updatedAt: now,
        },
      },
      { new: true },
    ).exec();

    if (!updatedEmergency) {
      // Emergency was terminal or concurrent modification occurred -> rollback reservation
      await releaseHospitalReservation(reservationId, {
        status: 'CANCELLED',
        reason: 'EMERGENCY_TERMINAL_OR_MODIFIED',
        actor,
        actorRole,
        requestId,
      });
      throw ApiError.conflict(
        `Emergency ${emergencyId} was cancelled or closed; reservation aborted`,
      );
    }
  } catch (emgErr) {
    if (emgErr instanceof ApiError) throw emgErr;
    await releaseHospitalReservation(reservationId, {
      status: 'CANCELLED',
      reason: 'EMERGENCY_LINK_FAILED',
      actor,
      actorRole,
      requestId,
    });
    throw emgErr;
  }

  // Step 5: Record success audit log
  await recordAudit({
    actor,
    actorRole,
    action: 'hospital.capacity_reserved',
    resource: 'HospitalReservation',
    resourceId: reservationId,
    requestId,
    result: 'SUCCESS',
    details: `Reserved ${resourceType} at hospital ${hospitalId} for emergency ${emergencyId}`,
    newState: JSON.parse(JSON.stringify(reservation)),
  });

  Emergency.findById(emergencyId).lean().then((emg) => {
    if (emg) {
      notifyCitizenOnHospitalRerouted(emergencyId, emg.citizenId, hospitalId).catch(() => {});
      if (emg.assignedAmbulance) {
        Ambulance.findById(emg.assignedAmbulance).lean().then((amb) => {
          if (amb) {
            const crewIds = amb.crew.map((c) => c.userId).filter((id): id is string => Boolean(id));
            notifyCrewOnHospitalRerouted(emg.assignedAmbulance!, crewIds, emergencyId, hospitalId).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  }).catch(() => {});

  return reservation;
}

/**
 * Releases a hospital reservation idempotently.
 * 
 * Strict Guarantees:
 * 1. Only releases the specific resource held by this reservation.
 * 2. Uses single-document CAS on Hospital conditioned on activeReservationIds containing reservationId.
 * 3. Never double-compensates even when called repeatedly or concurrently by multiple workers.
 * 4. Recovers interrupted terminal reservations where status was set but Hospital was not yet compensated.
 */
export async function releaseHospitalReservation(
  reservationId: string,
  options?: ReleaseReservationOptions,
): Promise<ReleaseReservationResult> {
  const now = new Date();
  const requestId = options?.requestId ?? `req-rel-${Date.now()}`;
  const actor = options?.actor ?? 'system';
  const actorRole = (options?.actorRole ?? 'DISPATCHER') as Role;
  const targetStatus = options?.status ?? 'RELEASED';
  const reason = options?.reason ?? 'MANUAL_RELEASE';

  // 1. Atomically transition reservation document from active status
  let reservation = await HospitalReservation.findOneAndUpdate(
    {
      _id: reservationId,
      status: { $in: ['PENDING', 'CONFIRMED'] },
      capacityCompensated: false,
    },
    {
      $set: {
        status: targetStatus,
        releasedAt: now,
        releaseReason: reason,
        updatedAt: now,
      },
    },
    { new: true },
  ).exec();

  // If not matched, check if reservation was marked terminal previously without capacity compensation
  let uncompensatedDoc: HospitalReservationDoc | null = null;
  if (!reservation) {
    uncompensatedDoc = await HospitalReservation.findOne({
      _id: reservationId,
      capacityCompensated: false,
    }).exec();
  }

  const targetDoc = reservation ?? uncompensatedDoc;

  if (!targetDoc) {
    // Already released and compensated, or non-existent -> idempotent return
    const current = await HospitalReservation.findById(reservationId).lean();
    return {
      released: false,
      alreadyReleased: Boolean(current && !['PENDING', 'CONFIRMED'].includes(current.status)),
      reservationId,
      hospitalId: current?.hospitalId,
      status: current?.status,
      reason: current?.releaseReason ?? undefined,
    };
  }

  // Crash barrier hook 4: Simulated crash between reservation transition and Hospital compensation
  if (options?.beforeHospitalReleaseHook) {
    await options.beforeHospitalReleaseHook({ reservationId, hospitalId: targetDoc.hospitalId });
  }

  // 2. Atomically compensate Hospital counters — strictly guarded by activeReservationIds containing reservationId!
  const reverseInc: Record<string, number> = {};
  if (targetDoc.incomingAmbulanceIncremented) {
    reverseInc.incomingAmbulances = -1;
  }
  if (targetDoc.bedTypeDecremented) {
    reverseInc[targetDoc.bedTypeDecremented] = 1;
  }

  // Attempt atomic compensation guarded by activeReservationIds
  const compResult = await Hospital.updateOne(
    {
      _id: targetDoc.hospitalId,
      activeReservationIds: reservationId, // MUST match! Guarantees at-most-once execution
    },
    {
      $pull: { activeReservationIds: reservationId },
      $inc: reverseInc,
      $set: { updatedAt: now },
    },
  ).exec();

  const didCompensate = (compResult.modifiedCount ?? 0) > 0;
  const isNewlyTerminal = Boolean(reservation);

  // Check if hospital already has this claim removed
  const hospWithClaim = didCompensate
    ? null
    : await Hospital.findOne({ _id: targetDoc.hospitalId, activeReservationIds: reservationId }).lean();

  // If compensation matched, or capacity was never applied, or hospital activeReservationIds no longer contains this reservation
  if (didCompensate || !targetDoc.capacityApplied || !hospWithClaim) {
    await HospitalReservation.updateOne(
      { _id: reservationId },
      { $set: { capacityCompensated: true } },
    ).exec();
  }

  // Guard against negative incomingAmbulances bound
  await Hospital.updateOne(
    { _id: targetDoc.hospitalId, incomingAmbulances: { $lt: 0 } },
    { $set: { incomingAmbulances: 0 } },
  ).exec();

  const actuallyReleased = isNewlyTerminal || didCompensate;

  // 3. Record audit log
  if (actuallyReleased) {
    await recordAudit({
      actor,
      actorRole,
      action: targetStatus === 'EXPIRED' ? 'hospital.reservation_expired' : 'hospital.reservation_released',
      resource: 'HospitalReservation',
      resourceId: reservationId,
      requestId,
      result: 'SUCCESS',
      details: `Released ${targetDoc.resourceType} reservation for emergency ${targetDoc.emergencyId} (reason: ${reason})`,
    });
  }

  return {
    released: actuallyReleased,
    alreadyReleased: !actuallyReleased,
    reservationId,
    hospitalId: targetDoc.hospitalId,
    status: targetDoc.status,
    reason,
  };
}

/**
 * Handles hospital rerouting for an emergency:
 * Atomically reserves at newHospitalId, then releases at old hospital.
 * If reservation at new hospital fails, old reservation is preserved untouched.
 */
export async function rerouteHospitalReservation(
  emergencyId: string,
  newHospitalId: string,
  resourceType: HospitalResourceType,
  options?: ReserveHospitalCapacityOptions,
): Promise<HospitalReservationDoc> {
  const emergency = await Emergency.findById(emergencyId).lean();
  if (!emergency) {
    throw ApiError.notFound(`Emergency ${emergencyId} not found`);
  }

  const oldHospitalId = emergency.destinationHospital;
  const oldReservationId = emergency.hospitalReservationId;

  // 1. Reserve at new hospital first
  const newReservation = await reserveHospitalCapacity(emergencyId, newHospitalId, resourceType, options);

  // 2. Release old reservation at old hospital if different
  if (oldReservationId && oldReservationId !== newReservation._id) {
    await releaseHospitalReservation(oldReservationId, {
      requestId: options?.requestId,
      actor: options?.actor,
      actorRole: options?.actorRole,
      status: 'RELEASED',
      reason: `REROUTED_TO_${newHospitalId}`,
    });
  } else if (oldHospitalId && oldHospitalId !== newHospitalId) {
    // Release any remaining active reservation at the old hospital for this emergency
    const oldReservations = await HospitalReservation.find({
      emergencyId,
      hospitalId: oldHospitalId,
      status: { $in: ['PENDING', 'CONFIRMED'] },
    }).lean();

    for (const oldRes of oldReservations) {
      await releaseHospitalReservation(oldRes._id, {
        requestId: options?.requestId,
        actor: options?.actor,
        actorRole: options?.actorRole,
        status: 'RELEASED',
        reason: `REROUTED_TO_${newHospitalId}`,
      });
    }
  }

  return newReservation;
}

/**
 * Resolves effective excluded emergency IDs from explicit options or environment configuration.
 */
export function getEffectiveHospitalReconciliationExclusions(explicitExclusions?: string[]): string[] {
  if (explicitExclusions && explicitExclusions.length > 0) {
    return [...new Set(explicitExclusions.filter((id) => typeof id === 'string' && /^EMG-\d{1,10}$/.test(id.trim())))];
  }
  const envVal = process.env.RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES;
  if (envVal) {
    return [...new Set(envVal.split(',').map((id) => id.trim()).filter((id) => /^EMG-\d{1,10}$/.test(id)))];
  }
  return [];
}

/**
 * Validates staging environment configuration.
 * In rapidaid_staging, fail closed if RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES
 * is missing or does not protect the required demo emergencies.
 */
export function validateStagingExclusionConfiguration(
  dbName?: string | null,
  customExclusions?: string[],
): {
  valid: boolean;
  exclusions: string[];
  error?: string;
} {
  const currentDb = dbName ?? (mongoose.connection?.readyState === 1 ? mongoose.connection.name : null);
  const isStaging = currentDb === 'rapidaid_staging';
  const exclusions = customExclusions ?? getEffectiveHospitalReconciliationExclusions();

  if (isStaging) {
    if (exclusions.length === 0) {
      return {
        valid: false,
        exclusions: [],
        error: 'RAPIDAID_HOSPITAL_RECONCILIATION_EXCLUDED_EMERGENCIES must be configured in rapidaid_staging (fail-closed)',
      };
    }
    const required = ['EMG-00001', 'EMG-20485'];
    const missing = required.filter((r) => !exclusions.includes(r));
    if (missing.length > 0) {
      return {
        valid: false,
        exclusions,
        error: `Staging exclusions missing mandatory protected emergencies: ${missing.join(', ')}`,
      };
    }
  }

  return { valid: true, exclusions };
}

/**
 * Reconciles expired, orphaned, and interrupted hospital reservations.
 * 
 * Concurrency Safe: Uses single-document atomic CAS so multiple reconciliation
 * workers can run simultaneously without race conditions or double-compensation.
 */
export async function reconcileHospitalReservations(
  options?: HospitalReconciliationOptions,
): Promise<ReconciliationResult> {
  const currentDb = mongoose.connection?.readyState === 1 ? mongoose.connection.name : null;
  const validation = validateStagingExclusionConfiguration(currentDb);
  if (!validation.valid) {
    logger.error(
      { error: validation.error, database: currentDb },
      'Safety violation: Hospital reconciliation aborted due to invalid staging exclusion configuration',
    );
    throw ApiError.serviceUnavailable(`Hospital reconciliation safety block: ${validation.error}`);
  }

  const effectiveOptions: HospitalReconciliationOptions = {
    ...options,
    excludeEmergencyIds: options?.excludeEmergencyIds ?? validation.exclusions,
  };

  const lockId = 'hospital_reconciliation_lock';
  const ownerToken = `worker_${process.pid}_${randomUUID().slice(0, 6)}`;

  // Bounded distributed lock to prevent worker thundering herd, with atomic CAS fallback
  const lock = await acquireSchedulerLock(lockId, ownerToken, 30_000);
  if (!lock.acquired) {
    return {
      expiredCount: 0,
      orphanedCount: 0,
      interruptedCount: 0,
      danglingClaimsRecoveredCount: 0,
      reconciledReservations: [],
      skippedActive: [],
    };
  }

  try {
    return await executeReconciliationScan(effectiveOptions);
  } finally {
    if (lock.fenceToken) {
      await releaseSchedulerLock(lockId, ownerToken, lock.fenceToken);
    }
  }
}

/**
 * Core reconciliation scan execution with scoping support.
 */
async function executeReconciliationScan(options?: HospitalReconciliationOptions): Promise<ReconciliationResult> {
  const now = new Date();
  const batchSize = options?.batchSize ?? 100;
  const gracePeriodMs = options?.gracePeriodMs ?? DEFAULT_IN_FLIGHT_RESERVATION_GRACE_MS;
  const activeCutoff = new Date(now.getTime() - gracePeriodMs);

  const effectiveExclusions = options?.excludeEmergencyIds ?? [];
  const hospitalScope = options?.hospitalId;

  const reconciledReservations: string[] = [];
  const skippedActive: string[] = [];
  let expiredCount = 0;
  let orphanedCount = 0;
  let interruptedCount = 0;
  let danglingClaimsRecoveredCount = 0;

  // 1. Expired reservations: status PENDING/CONFIRMED and expiresAt <= now
  const expiredFilter: Record<string, unknown> = {
    status: { $in: ['PENDING', 'CONFIRMED'] },
    expiresAt: { $lte: now },
  };
  if (hospitalScope) expiredFilter.hospitalId = hospitalScope;
  if (effectiveExclusions.length > 0) expiredFilter.emergencyId = { $nin: effectiveExclusions };

  const expiredDocs = await HospitalReservation.find(expiredFilter)
    .limit(batchSize)
    .lean();

  for (const doc of expiredDocs) {
    const res = await releaseHospitalReservation(doc._id, {
      status: 'EXPIRED',
      reason: 'RESERVATION_TTL_EXPIRED',
    });
    if (res.released) {
      expiredCount++;
      reconciledReservations.push(doc._id);
    }
  }

  // 2. Interrupted uncompensated terminal reservations:
  // (Process died after reservation marked terminal, before Hospital compensation finished)
  const uncompensatedFilter: Record<string, unknown> = {
    status: { $in: ['RELEASED', 'CANCELLED', 'COMPLETED', 'EXPIRED'] },
    capacityApplied: true,
    capacityCompensated: false,
  };
  if (hospitalScope) uncompensatedFilter.hospitalId = hospitalScope;
  if (effectiveExclusions.length > 0) uncompensatedFilter.emergencyId = { $nin: effectiveExclusions };

  const uncompensatedTerminals = await HospitalReservation.find(uncompensatedFilter)
    .limit(batchSize)
    .lean();

  for (const doc of uncompensatedTerminals) {
    const res = await releaseHospitalReservation(doc._id, {
      status: doc.status as 'RELEASED' | 'CANCELLED' | 'COMPLETED' | 'EXPIRED',
      reason: `RECOVER_UNCOMPENSATED_${doc.status}`,
    });
    if (res.released) {
      interruptedCount++;
      reconciledReservations.push(doc._id);
    }
  }

  // 3. Interrupted PENDING reservations:
  // (Process died during reservation creation before CONFIRMED)
  const pendingFilter: Record<string, unknown> = {
    status: 'PENDING',
    createdAt: { $lte: activeCutoff },
  };
  if (hospitalScope) pendingFilter.hospitalId = hospitalScope;
  if (effectiveExclusions.length > 0) pendingFilter.emergencyId = { $nin: effectiveExclusions };

  const pendingDocs = await HospitalReservation.find(pendingFilter)
    .limit(batchSize)
    .lean();

  for (const doc of pendingDocs) {
    // Check if the capacity was claimed on Hospital
    const hospWithClaim = await Hospital.findOne({
      _id: doc.hospitalId,
      activeReservationIds: doc._id,
    }).lean();

    if (hospWithClaim) {
      // Capacity was claimed on hospital before crash -> release and compensate
      const res = await releaseHospitalReservation(doc._id, {
        status: 'EXPIRED',
        reason: 'INTERRUPTED_PENDING_RECOVERED',
      });
      if (res.released) {
        interruptedCount++;
        reconciledReservations.push(doc._id);
      }
    } else {
      // Capacity was never claimed on hospital -> mark FAILED without counter compensation
      await HospitalReservation.updateOne(
        { _id: doc._id, status: 'PENDING' },
        { $set: { status: 'CANCELLED', releaseReason: 'ABORTED_BEFORE_CAPACITY_APPLIED' } },
      ).exec();
      interruptedCount++;
      reconciledReservations.push(doc._id);
    }
  }

  // 4. Orphaned reservations: active reservations whose emergency is terminal, rerouted, or deleted
  const activeFilter: Record<string, unknown> = {
    status: 'CONFIRMED',
    expiresAt: { $gt: now },
    createdAt: { $lte: activeCutoff }, // Skip fresh in-flight reservations within grace period
  };
  if (hospitalScope) activeFilter.hospitalId = hospitalScope;
  if (effectiveExclusions.length > 0) activeFilter.emergencyId = { $nin: effectiveExclusions };

  const activeDocs = await HospitalReservation.find(activeFilter)
    .limit(batchSize)
    .lean();

  for (const doc of activeDocs) {
    const emergency = await Emergency.findById(doc.emergencyId).lean();

    if (!emergency) {
      // Emergency doc deleted or absent -> orphaned
      const res = await releaseHospitalReservation(doc._id, {
        status: 'RELEASED',
        reason: 'ORPHANED_EMERGENCY_DELETED',
      });
      if (res.released) {
        orphanedCount++;
        reconciledReservations.push(doc._id);
      }
      continue;
    }

    if (!emergency.hospitalReservationId || emergency.hospitalReservationId !== doc._id) {
      // Reservation was confirmed, but emergency was never linked (process interrupted before linkage)
      // or emergency was subsequently linked to another reservation
      const res = await releaseHospitalReservation(doc._id, {
        status: 'RELEASED',
        reason: 'ORPHANED_EMERGENCY_NOT_LINKED',
      });
      if (res.released) {
        orphanedCount++;
        reconciledReservations.push(doc._id);
      }
      continue;
    }

    if (['COMPLETED', 'CANCELLED'].includes(emergency.status)) {
      // Emergency terminal -> reservation orphaned
      const res = await releaseHospitalReservation(doc._id, {
        status: emergency.status === 'COMPLETED' ? 'COMPLETED' : 'CANCELLED',
        reason: `ORPHANED_EMERGENCY_${emergency.status}`,
      });
      if (res.released) {
        orphanedCount++;
        reconciledReservations.push(doc._id);
      }
      continue;
    }

    if (emergency.destinationHospital && emergency.destinationHospital !== doc.hospitalId) {
      // Emergency rerouted elsewhere -> old reservation orphaned
      const res = await releaseHospitalReservation(doc._id, {
        status: 'RELEASED',
        reason: `ORPHANED_REROUTED_TO_${emergency.destinationHospital}`,
      });
      if (res.released) {
        orphanedCount++;
        reconciledReservations.push(doc._id);
      }
      continue;
    }

    skippedActive.push(doc._id);
  }

  // 5. Applied capacity with NO persisted reservation document:
  // Inspect hospitals with activeReservationIds and recover dangling IDs
  const hospFilter: Record<string, unknown> = {
    activeReservationIds: { $exists: true, $ne: [] },
  };
  if (hospitalScope) {
    hospFilter._id = hospitalScope;
  }
  const hospitalsWithClaims = await Hospital.find(hospFilter).lean();

  for (const hosp of hospitalsWithClaims) {
    const claimIds = hosp.activeReservationIds ?? [];
    for (const claimId of claimIds) {
      if (effectiveExclusions.length > 0) {
        const isExcluded = await HospitalReservation.exists({
          _id: claimId,
          emergencyId: { $in: effectiveExclusions },
        });
        if (isExcluded) {
          continue; // Protected
        }
      }

      const reservationExists = await HospitalReservation.exists({ _id: claimId });
      if (!reservationExists) {
        // Orphaned claim with no reservation document -> remove and compensate inferred resource
        const inferredType = parseResourceTypeFromReservationId(claimId);
        const reverseInc: Record<string, number> = { incomingAmbulances: -1 };
        if (inferredType === 'ICU_BED') {
          reverseInc.icuBeds = 1;
        } else if (inferredType === 'GENERAL_BED') {
          reverseInc.generalBeds = 1;
        }

        const comp = await Hospital.updateOne(
          {
            _id: hosp._id,
            activeReservationIds: claimId,
          },
          {
            $pull: { activeReservationIds: claimId },
            $inc: reverseInc,
            $set: { updatedAt: now },
          },
        ).exec();

        if ((comp.modifiedCount ?? 0) > 0) {
          danglingClaimsRecoveredCount++;
          reconciledReservations.push(claimId);
          await recordAudit({
            actor: 'reconciliation_worker',
            actorRole: 'SUPERVISOR',
            action: 'hospital.dangling_claim_recovered',
            resource: 'Hospital',
            resourceId: hosp._id,
            requestId: `recon-${Date.now()}`,
            result: 'SUCCESS',
            details: `Recovered dangling capacity claim ${claimId} (${inferredType ?? 'UNKNOWN'}) with no persisted reservation document`,
          });
        }
      }
    }
  }

  // 6. Guarantee non-negative incoming ambulances bound
  const nonNegativeQuery: Record<string, unknown> = { incomingAmbulances: { $lt: 0 } };
  if (hospitalScope) {
    nonNegativeQuery._id = hospitalScope;
  }
  await Hospital.updateMany(
    nonNegativeQuery,
    { $set: { incomingAmbulances: 0 } },
  ).exec();

  return {
    expiredCount,
    orphanedCount,
    interruptedCount,
    danglingClaimsRecoveredCount,
    reconciledReservations,
    skippedActive,
  };
}

let hospitalReconciliationIntervalTimer: NodeJS.Timeout | null = null;
let hospitalReconciliationInitialTimer: NodeJS.Timeout | null = null;
let activeHospitalSweepPromise: Promise<ReconciliationResult> | null = null;
let isHospitalReconciliationShuttingDown = false;
let hospitalReconciliationShutdownPromise: Promise<void> | null = null;

export function isHospitalReservationSchedulerRunning(): boolean {
  return hospitalReconciliationIntervalTimer !== null || hospitalReconciliationInitialTimer !== null;
}

export function isHospitalReservationSchedulerShuttingDown(): boolean {
  return isHospitalReconciliationShuttingDown;
}

export function setHospitalReservationSchedulerShutdown(shuttingDown: boolean): void {
  if (!shuttingDown && !isTest && isHospitalReconciliationShuttingDown) {
    logger.warn('Ignoring attempt to reverse hospital reservation scheduler shutdown state in production');
    return;
  }
  isHospitalReconciliationShuttingDown = shuttingDown;
  if (!shuttingDown) {
    hospitalReconciliationShutdownPromise = null;
  }
}

export function runHospitalReservationReconciliationSweep(
  options?: HospitalReconciliationOptions,
): Promise<ReconciliationResult> {
  if (isHospitalReconciliationShuttingDown) {
    const err = ApiError.serviceUnavailable('Hospital reservation reconciliation is unavailable: server is shutting down');
    return Promise.reject(err);
  }

  if (activeHospitalSweepPromise) {
    logger.warn('Hospital reservation reconciliation sweep already in progress; reusing active sweep');
    return activeHospitalSweepPromise;
  }

  const startTime = Date.now();
  const sweep = (async (): Promise<ReconciliationResult> => {
    try {
      logger.info('Hospital reservation reconciliation sweep started');
      const outcome = await reconcileHospitalReservations(options);
      const durationMs = Date.now() - startTime;
      logger.info(
        {
          durationMs,
          expiredCount: outcome.expiredCount,
          orphanedCount: outcome.orphanedCount,
          interruptedCount: outcome.interruptedCount,
          danglingClaimsRecoveredCount: outcome.danglingClaimsRecoveredCount,
          reconciledIds: outcome.reconciledReservations,
          skippedActiveCount: outcome.skippedActive.length,
        },
        'Hospital reservation reconciliation sweep completed successfully',
      );
      return outcome;
    } catch (err) {
      const durationMs = Date.now() - startTime;
      logger.error(
        { err, durationMs },
        'Hospital reservation reconciliation sweep encountered an error; will retry on next schedule',
      );
      throw err;
    } finally {
      activeHospitalSweepPromise = null;
    }
  })();

  activeHospitalSweepPromise = sweep;
  return sweep;
}

export interface HospitalSchedulerStartOptions {
  intervalMs?: number;
  initialJitterMs?: number;
  options?: HospitalReconciliationOptions;
}

export function startHospitalReservationReconciliationScheduler(
  intervalOrConfig?: number | HospitalSchedulerStartOptions,
  initialJitterMsParam?: number,
  reconciliationOptionsParam?: HospitalReconciliationOptions,
): void {
  let intervalMs = env.HOSPITAL_RECONCILIATION_INTERVAL_MS;
  let initialJitterMs: number | undefined = initialJitterMsParam;
  let options: HospitalReconciliationOptions | undefined = reconciliationOptionsParam;

  if (typeof intervalOrConfig === 'number') {
    intervalMs = intervalOrConfig;
  } else if (intervalOrConfig && typeof intervalOrConfig === 'object') {
    if (typeof intervalOrConfig.intervalMs === 'number') {
      intervalMs = intervalOrConfig.intervalMs;
    }
    if (typeof intervalOrConfig.initialJitterMs === 'number') {
      initialJitterMs = intervalOrConfig.initialJitterMs;
    }
    if (intervalOrConfig.options) {
      options = intervalOrConfig.options;
    }
  }
  if (isHospitalReconciliationShuttingDown && !isTest) {
    logger.warn('Cannot start hospital reservation reconciliation scheduler: server is in shutdown state');
    return;
  }

  // Database readiness check
  if (mongoose.connection?.readyState !== 1) {
    logger.warn('Cannot start hospital reservation reconciliation scheduler: database is not connected');
    return;
  }

  // Validate staging safety configuration (fail closed)
  const currentDb = mongoose.connection.name;
  const validation = validateStagingExclusionConfiguration(currentDb);
  if (!validation.valid) {
    logger.error(
      { error: validation.error, database: currentDb },
      'FATAL: Hospital reservation reconciliation scheduler refused to start due to invalid staging exclusion configuration',
    );
    return;
  }

  isHospitalReconciliationShuttingDown = false;
  hospitalReconciliationShutdownPromise = null;

  // Clear any existing active schedule (idempotent startup)
  if (hospitalReconciliationInitialTimer) {
    clearTimeout(hospitalReconciliationInitialTimer);
    hospitalReconciliationInitialTimer = null;
  }
  if (hospitalReconciliationIntervalTimer) {
    clearInterval(hospitalReconciliationIntervalTimer);
    hospitalReconciliationIntervalTimer = null;
  }

  const jitter = initialJitterMs !== undefined ? initialJitterMs : (isTest ? 0 : Math.floor(Math.random() * 15_000));

  hospitalReconciliationInitialTimer = setTimeout(() => {
    hospitalReconciliationInitialTimer = null;
    if (isHospitalReconciliationShuttingDown) return;

    runHospitalReservationReconciliationSweep(options).catch((err) => {
      logger.error({ err }, 'Initial scheduled hospital reservation reconciliation sweep failed');
    });

    hospitalReconciliationIntervalTimer = setInterval(() => {
      if (isHospitalReconciliationShuttingDown) return;
      runHospitalReservationReconciliationSweep(options).catch((err) => {
        logger.error({ err }, 'Periodic scheduled hospital reservation reconciliation sweep failed');
      });
    }, intervalMs);

    if (typeof hospitalReconciliationIntervalTimer.unref === 'function') {
      hospitalReconciliationIntervalTimer.unref();
    }
  }, jitter);

  if (typeof hospitalReconciliationInitialTimer.unref === 'function') {
    hospitalReconciliationInitialTimer.unref();
  }

  logger.info(
    { intervalMs, initialJitterMs: jitter, effectiveExclusions: validation.exclusions },
    'Periodic hospital reservation reconciliation scheduler initialized',
  );
}

export function stopHospitalReservationReconciliationScheduler(gracePeriodMs = 5_000): Promise<void> {
  if (hospitalReconciliationShutdownPromise) {
    return hospitalReconciliationShutdownPromise;
  }

  hospitalReconciliationShutdownPromise = (async () => {
    isHospitalReconciliationShuttingDown = true;

    if (hospitalReconciliationInitialTimer) {
      clearTimeout(hospitalReconciliationInitialTimer);
      hospitalReconciliationInitialTimer = null;
    }
    if (hospitalReconciliationIntervalTimer) {
      clearInterval(hospitalReconciliationIntervalTimer);
      hospitalReconciliationIntervalTimer = null;
    }

    if (activeHospitalSweepPromise) {
      logger.info('Awaiting in-flight hospital reservation reconciliation sweep to drain before shutdown');

      let timedOut = false;
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve('timeout');
        }, gracePeriodMs).unref();
      });

      const outcome = await Promise.race([
        activeHospitalSweepPromise.then(() => 'drained' as const).catch(() => 'drained' as const),
        timeoutPromise,
      ]);

      if (outcome === 'timeout' || timedOut) {
        const drainErr = new Error(
          `Hospital reservation reconciliation sweep failed to drain within ${gracePeriodMs}ms`,
        );
        (drainErr as any).isDrainTimeout = true;
        throw drainErr;
      }
    }
  })();

  return hospitalReconciliationShutdownPromise;
}
