import { Ambulance, Emergency, Shift, User, type ShiftDoc } from '../models/index.js';
import { TERMINAL_STATUSES } from '../validation/constants.js';

export type CrewDutyDisqualificationReason =
  | 'AMBULANCE_NOT_FOUND'
  | 'AMBULANCE_INACTIVE'
  | 'NO_ACTIVE_SHIFT'
  | 'MULTIPLE_ACTIVE_SHIFTS'
  | 'SHIFT_OUTSIDE_WINDOW'
  | 'SHIFT_AMBULANCE_MISMATCH'
  | 'NO_CREW_ON_SHIFT'
  | 'CREW_ROSTER_MISMATCH'
  | 'CREW_USER_NOT_FOUND_OR_INACTIVE'
  | 'CREW_ROLE_INVALID'
  | 'CREW_ASSIGNED_TO_ACTIVE_EMERGENCY'
  | 'CREW_OVERLAPPING_SHIFT_ON_OTHER_AMBULANCE';

export interface CrewDutyVerificationResult {
  eligible: boolean;
  disqualificationReason?: CrewDutyDisqualificationReason;
  message?: string;
  ambulanceId: string;
  shiftId?: string;
  verifiedCrewIds?: string[];
  activeEmergencyId?: string;
  conflictingShiftId?: string;
}

export interface VerifyCrewDutyOptions {
  /** Optional evaluation timestamp (defaults to Date.now()). */
  atTime?: Date;
  /** Explicit shift ID to verify against, bypassing the single-active-shift search. */
  specificShiftId?: string;
}

/**
 * Reusable crew-duty and active shift verification service.
 * Enforces safety requirements for ambulance candidate readiness:
 * - Exactly one valid active shift for the ambulance (unless evaluating a specific shift).
 * - Shift startsAt <= now <= endsAt.
 * - Shift belongs to the requested ambulance.
 * - Shift crew IDs match the ambulance roster.
 * - Every crew member represents an active User account with AMBULANCE_CREW role.
 * - Embedded crew names alone are never treated as proof of active staffing.
 * - Crew member must not have conflicting active emergency assignments.
 * - Crew member must not have prohibited overlapping shifts on other ambulances.
 */
export async function verifyAmbulanceCrewDuty(
  ambulanceId: string,
  options?: VerifyCrewDutyOptions,
): Promise<CrewDutyVerificationResult> {
  const atTime = options?.atTime ?? new Date();

  // 1. Verify ambulance exists and is active
  const ambulance = await Ambulance.findById(ambulanceId).lean();
  if (!ambulance) {
    return {
      eligible: false,
      disqualificationReason: 'AMBULANCE_NOT_FOUND',
      message: `Ambulance ${ambulanceId} not found`,
      ambulanceId,
    };
  }

  if (ambulance.active === false) {
    return {
      eligible: false,
      disqualificationReason: 'AMBULANCE_INACTIVE',
      message: `Ambulance ${ambulanceId} is inactive`,
      ambulanceId,
    };
  }

  // 2. Identify active shift(s)
  let shift: ShiftDoc | null = null;

  if (options?.specificShiftId) {
    shift = await Shift.findById(options.specificShiftId).lean();
    if (!shift || shift.status !== 'ACTIVE') {
      return {
        eligible: false,
        disqualificationReason: 'NO_ACTIVE_SHIFT',
        message: `Shift ${options.specificShiftId} is not active`,
        ambulanceId,
        shiftId: options.specificShiftId,
      };
    }
  } else {
    const activeShifts = await Shift.find({ ambulanceId, status: 'ACTIVE' }).lean();

    if (activeShifts.length === 0) {
      return {
        eligible: false,
        disqualificationReason: 'NO_ACTIVE_SHIFT',
        message: `No active shift found for ambulance ${ambulanceId}`,
        ambulanceId,
      };
    }

    if (activeShifts.length > 1) {
      return {
        eligible: false,
        disqualificationReason: 'MULTIPLE_ACTIVE_SHIFTS',
        message: `Ambulance ${ambulanceId} has ${activeShifts.length} concurrent active shifts`,
        ambulanceId,
      };
    }

    shift = activeShifts[0];
  }

  const shiftId = String(shift._id);

  // 3. Verify shift belongs to this ambulance
  if (shift.ambulanceId !== ambulanceId) {
    return {
      eligible: false,
      disqualificationReason: 'SHIFT_AMBULANCE_MISMATCH',
      message: `Shift ${shiftId} is assigned to ambulance ${shift.ambulanceId}, not ${ambulanceId}`,
      ambulanceId,
      shiftId,
    };
  }

  // 4. Verify startsAt <= atTime <= endsAt
  const shiftStart = new Date(shift.startsAt).getTime();
  const shiftEnd = new Date(shift.endsAt).getTime();
  const targetTime = atTime.getTime();

  if (targetTime < shiftStart || targetTime > shiftEnd) {
    return {
      eligible: false,
      disqualificationReason: 'SHIFT_OUTSIDE_WINDOW',
      message: `Shift ${shiftId} time window (${shift.startsAt.toISOString()} - ${shift.endsAt.toISOString()}) does not cover evaluation time (${atTime.toISOString()})`,
      ambulanceId,
      shiftId,
    };
  }

  // 5. Verify crew assigned on shift
  const shiftCrewIds = shift.crewIds ?? [];
  if (shiftCrewIds.length === 0) {
    return {
      eligible: false,
      disqualificationReason: 'NO_CREW_ON_SHIFT',
      message: `Shift ${shiftId} has no assigned crew`,
      ambulanceId,
      shiftId,
    };
  }

  // 6. Verify crew roster membership and map to user IDs
  // Ambulance crew contains subdocuments: { _id: 'C001', name: '...', userId?: 'USR-002' }
  const rosterCrew = ambulance.crew ?? [];
  const rosterUserIds = new Set<string>();
  const codeToUserIdMap = new Map<string, string>();

  for (const member of rosterCrew) {
    if (member.userId) {
      rosterUserIds.add(member.userId);
      codeToUserIdMap.set(member._id, member.userId);
    }
  }

  const verifiedUserIds: string[] = [];

  for (const crewIdentifier of shiftCrewIds) {
    let resolvedUserId: string | undefined;

    if (rosterUserIds.has(crewIdentifier)) {
      resolvedUserId = crewIdentifier;
    } else if (codeToUserIdMap.has(crewIdentifier)) {
      resolvedUserId = codeToUserIdMap.get(crewIdentifier);
    }

    if (!resolvedUserId) {
      return {
        eligible: false,
        disqualificationReason: 'CREW_ROSTER_MISMATCH',
        message: `Shift crew member ${crewIdentifier} is not on the roster for ambulance ${ambulanceId} or lacks a linked account`,
        ambulanceId,
        shiftId,
      };
    }

    verifiedUserIds.push(resolvedUserId);
  }

  // 7. Verify active User account and role for each crew member
  // Embedded crew names alone are never treated as proof of active staffing.
  const users = await User.find({ _id: { $in: verifiedUserIds } }).lean();
  const userMap = new Map(users.map((u) => [String(u._id), u]));

  for (const userId of verifiedUserIds) {
    const userDoc = userMap.get(userId);
    if (!userDoc || userDoc.active === false) {
      return {
        eligible: false,
        disqualificationReason: 'CREW_USER_NOT_FOUND_OR_INACTIVE',
        message: `Crew user account ${userId} was not found or is inactive`,
        ambulanceId,
        shiftId,
      };
    }

    if (userDoc.role !== 'AMBULANCE_CREW') {
      return {
        eligible: false,
        disqualificationReason: 'CREW_ROLE_INVALID',
        message: `Crew user account ${userId} has role '${userDoc.role}', expected 'AMBULANCE_CREW'`,
        ambulanceId,
        shiftId,
      };
    }
  }

  // 8. Detect conflicting active emergency assignments
  // Crew members cannot be assigned to an active emergency
  const conflictingEmergency = await Emergency.findOne({
    $or: [
      { assignedCrewIds: { $in: verifiedUserIds } },
      { assignedCrew: { $in: verifiedUserIds } },
    ],
    status: { $nin: [...TERMINAL_STATUSES] },
  })
    .select('_id status')
    .lean();

  if (conflictingEmergency) {
    return {
      eligible: false,
      disqualificationReason: 'CREW_ASSIGNED_TO_ACTIVE_EMERGENCY',
      activeEmergencyId: String(conflictingEmergency._id),
      message: `Crew member is already assigned to active emergency ${conflictingEmergency._id} (${conflictingEmergency.status})`,
      ambulanceId,
      shiftId,
      verifiedCrewIds: verifiedUserIds,
    };
  }

  // 9. Detect prohibited overlapping active shifts on other ambulances
  const overlappingShift = await Shift.findOne({
    _id: { $ne: shiftId },
    ambulanceId: { $ne: ambulanceId },
    crewIds: { $in: verifiedUserIds },
    status: 'ACTIVE',
    startsAt: { $lte: shift.endsAt },
    endsAt: { $gte: shift.startsAt },
  })
    .select('_id ambulanceId')
    .lean();

  if (overlappingShift) {
    return {
      eligible: false,
      disqualificationReason: 'CREW_OVERLAPPING_SHIFT_ON_OTHER_AMBULANCE',
      conflictingShiftId: String(overlappingShift._id),
      message: `Crew member is assigned to overlapping active shift ${overlappingShift._id} on ambulance ${overlappingShift.ambulanceId}`,
      ambulanceId,
      shiftId,
      verifiedCrewIds: verifiedUserIds,
    };
  }

  // All checks passed
  return {
    eligible: true,
    ambulanceId,
    shiftId,
    verifiedCrewIds: verifiedUserIds,
  };
}
