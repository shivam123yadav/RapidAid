import { canIn, type Permission } from './permissions.js';
import { Ambulance, Emergency, Hospital } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import type { Role } from '../validation/constants.js';

/** Hospital master-data fields: identity, registration, location, contact. Administrator only. */
export const HOSPITAL_MASTER_FIELDS = [
  'name', 'registrationNumber', 'location', 'phone', 'emergencyContact',
  'hospitalType', 'city', 'state', 'postalCode', 'verificationStatus',
] as const;

/**
 * Hospital operational fields: live capacity and availability. These are the
 * only fields Hospital Staff may write — and only for their own facility
 * (hospital:capacity:update:own, verified against the server-side identity).
 */
export const HOSPITAL_OPERATIONAL_FIELDS = [
  'emergencyCapacity', 'icuCapacity', 'traumaAvailable', 'capabilities', 'incomingAmbulances',
  'currentLoad', 'generalBeds', 'icuBeds', 'traumaCapacity', 'ventilatorAvailability',
  'operatingTheatreAvailability', 'specialistAvailability', 'bloodAvailability',
  'estimatedWaitingTimeMinutes', 'operationalStatus',
] as const;

/** Fields that let an operator be removed from dispatch routing (deactivation). */
export const HOSPITAL_LIFECYCLE_FIELDS = ['status', 'active', 'deactivationReason', 'deactivatedAt'] as const;

export interface AuthContext { userId: string; role: Role; name: string; email: string; hospitalId?: string; organizationId?: string; ambulanceId?: string; permissions: readonly string[]; }
export interface EmergencyScope { citizenId?: string | null; assignedCrewIds?: string[] | null; assignedAmbulance?: string | null; destinationHospital?: string | null; }
export function hasPermission(auth: AuthContext | undefined, permission: Permission | string): boolean { return Boolean(auth && canIn(auth.permissions, permission)); }
export function hasAnyPermission(auth: AuthContext | undefined, ...permissions: string[]): boolean { return permissions.some((permission) => hasPermission(auth, permission)); }
export async function isAssignedCrew(userId: string, ambulanceId: string): Promise<boolean> { return (await Ambulance.exists({ _id: ambulanceId, 'crew.userId': userId, active: { $ne: false } })) !== null; }
export async function isAssignedEmergency(auth: AuthContext, emergency: EmergencyScope): Promise<boolean> { return Boolean(emergency.assignedCrewIds?.includes(auth.userId) || (emergency.assignedAmbulance && await isAssignedCrew(auth.userId, emergency.assignedAmbulance))); }
export function canReadEmergencySync(auth: AuthContext, emergency: EmergencyScope): boolean {
  if (hasPermission(auth, 'emergency:read:all') || hasPermission(auth, 'emergency:read:historical')) return true;
  if (hasPermission(auth, 'emergency:read:own') && emergency.citizenId === auth.userId) return true;
  if (hasPermission(auth, 'emergency:read:assigned') && (emergency.assignedCrewIds?.includes(auth.userId) || emergency.assignedAmbulance === auth.ambulanceId)) return true;
  return hasPermission(auth, 'emergency:read:relevant') && emergency.destinationHospital === auth.hospitalId;
}
export async function canReadEmergency(auth: AuthContext, emergency: EmergencyScope): Promise<boolean> { return canReadEmergencySync(auth, emergency) || (hasPermission(auth, 'emergency:read:assigned') && await isAssignedEmergency(auth, emergency)); }
/**
 * Throws **404**, not 403, when the caller is outside the emergency's scope.
 *
 * Emergency ids are sequential (EMG-00001…), so a 403 on a real id but a 404 on
 * an unused one is a free existence oracle. This matches the policy already used
 * by `assertCanReadAmbulance` and the voice-report authorizer, both of which
 * return 404 precisely so a caller cannot probe for records that exist.
 */
export async function assertCanReadEmergency(auth: AuthContext, emergency: EmergencyScope & { _id: string }): Promise<void> { if (!(await canReadEmergency(auth, emergency))) throw ApiError.notFound(`Emergency ${emergency._id} not found`); }
export async function canReadAmbulance(auth: AuthContext, ambulance: { _id: string; destinationHospital?: string | null; currentEmergency?: string | null; crew?: Array<{ userId?: string | null }> }): Promise<boolean> {
  if (hasPermission(auth, 'ambulance:read:all') || hasPermission(auth, 'ambulance:read:historical')) return true;
  if (hasPermission(auth, 'ambulance:read:own') && Boolean(ambulance.crew?.some((member) => member.userId === auth.userId))) return true;
  if (hasPermission(auth, 'ambulance:read:incoming')) {
    if (ambulance.destinationHospital && ambulance.destinationHospital === auth.hospitalId) return true;
    if (ambulance.currentEmergency) return Boolean(await Emergency.exists({ _id: ambulance.currentEmergency, destinationHospital: auth.hospitalId }));
  }
  if (hasPermission(auth, 'tracking:read:own') || auth.role === 'CITIZEN') {
    if (ambulance.currentEmergency) {
      const owned = await Emergency.exists({ _id: ambulance.currentEmergency, citizenId: auth.userId });
      if (owned) return true;
    }
    const isAssigned = await Emergency.exists({ assignedAmbulance: ambulance._id, citizenId: auth.userId });
    if (isAssigned) return true;
  }
  return false;
}
export async function assertCanReadAmbulance(auth: AuthContext, ambulance: { _id: string; destinationHospital?: string | null; crew?: Array<{ userId?: string | null }> }): Promise<void> { if (!(await canReadAmbulance(auth, ambulance))) throw ApiError.notFound(`Ambulance ${ambulance._id} not found`); }
export async function canReadHospital(auth: AuthContext, hospitalId: string): Promise<boolean> {
  if (hasPermission(auth, 'hospital:read:all') || hasPermission(auth, 'hospital:read:historical')) return true;
  if (hasPermission(auth, 'hospital:read:own') && auth.hospitalId === hospitalId) return true;
  if (!hasPermission(auth, 'hospital:read:relevant')) return false;
  if (auth.hospitalId === hospitalId) return true;
  if (auth.role === 'CITIZEN') return Boolean(await Hospital.exists({ _id: hospitalId, active: { $ne: false }, status: { $ne: 'OFFLINE' } }));
  if (auth.role !== 'AMBULANCE_CREW') return false;
  const ambulances = await Ambulance.find({ 'crew.userId': auth.userId, active: { $ne: false } }).select('_id').lean();
  return Boolean(await Emergency.exists({ destinationHospital: hospitalId, $or: [{ assignedCrewIds: auth.userId }, { assignedAmbulance: { $in: ambulances.map((ambulance) => ambulance._id) } }] }));
}
export function assertOwnHospital(auth: AuthContext, hospitalId: string): void { if (!auth.hospitalId || auth.hospitalId !== hospitalId) throw ApiError.forbidden('You may only update your assigned hospital'); }
export async function assertOwnAmbulance(auth: AuthContext, ambulanceId: string): Promise<void> { if (!(await isAssignedCrew(auth.userId, ambulanceId))) throw ApiError.forbidden('You may only update your assigned ambulance'); }

// ── Hospital write authorization ────────────────────────────────────────────────
/**
 * Master-data / lifecycle writes (identity, registration, location, contact,
 * activation, deactivation, staff association) are Administrator-only.
 * `hospital:update:all` is the single gate, so a Supervisor cannot escalate to
 * master-data edits by calling a different endpoint.
 */
export function assertCanManageHospitalMasterData(auth: AuthContext): void {
  if (!hasPermission(auth, 'hospital:update:all')) throw ApiError.forbidden('Only an Administrator can edit hospital master data');
}

/**
 * Operational capacity writes. Admin/Supervisor may do it for any facility via
 * `hospital:capacity:update`; Hospital Staff may only do it for the facility
 * bound to their own authenticated token via `hospital:capacity:update:own`.
 * The `hospitalId` in the request path is never trusted for scope — it is
 * compared against `auth.hospitalId`, which comes from the signed-in user.
 */
export function assertCanUpdateHospitalCapacity(auth: AuthContext, hospitalId: string): void {
  if (hasPermission(auth, 'hospital:capacity:update')) return;
  if (hasPermission(auth, 'hospital:capacity:update:own')) {
    assertOwnHospital(auth, hospitalId);
    return;
  }
  throw ApiError.forbidden('You may only update operational capacity for your assigned hospital');
}

/** Activation/deactivation is an Administrator lifecycle decision. */
export function assertCanChangeHospitalLifecycle(auth: AuthContext, action: 'activate' | 'deactivate'): void {
  if (hasPermission(auth, action === 'activate' ? 'hospital:activate' : 'hospital:deactivate')) return;
  throw ApiError.forbidden(`Only an Administrator can ${action} a hospital`);
}

/** Registration review (approve/reject) — Administrator or Supervisor. */
export function assertCanReviewHospital(auth: AuthContext): void {
  if (!hasPermission(auth, 'hospital:approve')) throw ApiError.forbidden('You may not review hospital registrations');
}

/** Staff association/management is Administrator-only. */
export function assertCanManageHospitalStaff(auth: AuthContext): void {
  if (!hasPermission(auth, 'hospital:staff:manage')) throw ApiError.forbidden('Only an Administrator can manage hospital staff accounts');
}

/**
 * Splits a request body into the operational fields Hospital Staff may write and
 * the master/lifecycle fields only an Administrator may write. A staff caller
 * that smuggles a master field gets 403 rather than a silent drop.
 */
export function assertNoMasterDataInOperationalBody(_auth: AuthContext, body: Record<string, unknown>): void {
  const offending = (Object.keys(body) as string[]).filter((key) => (HOSPITAL_MASTER_FIELDS as readonly string[]).includes(key));
  if (offending.length > 0) throw ApiError.forbidden(`Hospital master data cannot be changed here: ${offending.join(', ')}`);
}

export async function emergencyScopeFilter(auth: AuthContext): Promise<Record<string, unknown>> {
  if (hasPermission(auth, 'emergency:read:all') || hasPermission(auth, 'emergency:read:historical')) return {};
  const clauses: Record<string, unknown>[] = [];
  if (hasPermission(auth, 'emergency:read:own')) clauses.push({ citizenId: auth.userId });
  if (hasPermission(auth, 'emergency:read:assigned')) {
    const assigned = await Ambulance.find({ 'crew.userId': auth.userId, active: { $ne: false } }).select('_id').lean();
    clauses.push({ assignedCrewIds: auth.userId }, { assignedAmbulance: { $in: assigned.map((a) => a._id) } });
  }
  if (hasPermission(auth, 'emergency:read:relevant') && auth.hospitalId) clauses.push({ destinationHospital: auth.hospitalId });
  return clauses.length ? { $or: clauses } : { _id: '__no_access__' };
}
export async function ambulanceScopeFilter(auth: AuthContext): Promise<Record<string, unknown>> {
  if (hasPermission(auth, 'ambulance:read:all') || hasPermission(auth, 'ambulance:read:historical')) return {};
  if (hasPermission(auth, 'ambulance:read:own')) return { 'crew.userId': auth.userId };
  if (hasPermission(auth, 'ambulance:read:incoming') && auth.hospitalId) {
    const emergencies = await Emergency.find({ destinationHospital: auth.hospitalId }).select('assignedAmbulance').lean();
    return { _id: { $in: emergencies.map((e) => e.assignedAmbulance).filter((id): id is string => Boolean(id)) } };
  }
  if (hasPermission(auth, 'tracking:read:own') || auth.role === 'CITIZEN') {
    const emergencies = await Emergency.find({ citizenId: auth.userId, assignedAmbulance: { $exists: true, $ne: null } }).select('assignedAmbulance').lean();
    const ids = emergencies.map((e) => e.assignedAmbulance).filter((id): id is string => Boolean(id));
    return { _id: { $in: ids } };
  }
  return { _id: '__no_access__' };
}
export async function hospitalScopeFilter(auth: AuthContext): Promise<Record<string, unknown>> {
  if (hasPermission(auth, 'hospital:read:all') || hasPermission(auth, 'hospital:read:historical')) return {};
  if (hasPermission(auth, 'hospital:read:own') && auth.hospitalId) return { _id: auth.hospitalId };
  if (hasPermission(auth, 'hospital:read:relevant') && auth.role === 'CITIZEN') return { active: { $ne: false }, status: { $ne: 'OFFLINE' } };
  if (hasPermission(auth, 'hospital:read:relevant') && auth.role === 'AMBULANCE_CREW') {
    const ambulances = await Ambulance.find({ 'crew.userId': auth.userId, active: { $ne: false } }).select('_id').lean();
    const emergencies = await Emergency.find({ $or: [{ assignedCrewIds: auth.userId }, { assignedAmbulance: { $in: ambulances.map((ambulance) => ambulance._id) } }] }).select('destinationHospital').lean();
    return { _id: { $in: emergencies.map((emergency) => emergency.destinationHospital).filter((id): id is string => Boolean(id)) } };
  }
  return { _id: '__no_access__' };
}
export function assertHasPatientScope(auth: AuthContext, scope: 'basic' | 'medical' | 'location' | 'contact' | 'update' | 'export'): void {
  const allowed = scope === 'update' ? hasPermission(auth, 'patient:update') : scope === 'export' ? hasPermission(auth, 'patient:export') : hasPermission(auth, `patient:${scope}-read`);
  if (!allowed) throw ApiError.forbidden('Patient data is outside your authorized scope');
}

const INTERNAL_EMERGENCY_FIELDS = [
  'citizenId',
  'assignedDispatcher',
  'assignedCrewIds',
  'greenCorridorActivatedBy',
  'ambulanceClaimToken',
] as const;

/** Serializes an emergency for a normal API response, never its raw DB shape. */
export function toClientEmergency(
  auth: AuthContext,
  emergency: { citizenId?: string | null; assignedDispatcher?: string | null; toJSON(): Record<string, unknown> },
): Record<string, unknown> {
  const value = emergency.toJSON() as Record<string, unknown>;
  const owner = emergency.citizenId === auth.userId;
  const response = { ...value };
  for (const field of INTERNAL_EMERGENCY_FIELDS) delete response[field];
  if (!owner && !hasPermission(auth, 'patient:basic-read')) delete response.description;
  if (!owner && !hasPermission(auth, 'patient:location-read')) delete response.location;
  if (!owner && !hasPermission(auth, 'patient:medical-read')) delete response.attachments;
  if (!owner && !hasPermission(auth, 'patient:basic-read') && Array.isArray(response.timeline)) {
    response.timeline = response.timeline.map((entry) => {
      if (!entry || typeof entry !== 'object') return entry;
      const { note: _note, ...statusOnly } = entry as Record<string, unknown>;
      return statusOnly;
    });
  }
  return response;
}

/**
 * Serializes an emergency for a *list* response.
 *
 * Identical to {@link toClientEmergency} except that `attachments[].dataUrl` is
 * dropped and replaced by a count. An emergency can carry four 2 MB photos as
 * base64, so a list of 100 incidents was a >1 GB response; the caller can fetch
 * the full record (and its photos) from `GET /api/emergencies/:id` under the
 * same authorization. Everything else — including every patient-scope rule — is
 * unchanged, so a list item never reveals more than its own detail view would.
 */
export function toClientEmergencySummary(
  auth: AuthContext,
  emergency: { citizenId?: string | null; assignedDispatcher?: string | null; toJSON(): Record<string, unknown> },
): Record<string, unknown> {
  const response = toClientEmergency(auth, emergency);
  const attachments = response.attachments;
  if (Array.isArray(attachments)) {
    const { dataUrl: _dropped, ...metadata } = attachments[0] ?? {};
    void _dropped;
    response.attachmentCount = attachments.length;
    // Keep the shape of a single entry so the client can still show filenames
    // and sizes, with the (multi-megabyte) payload removed.
    response.attachments = attachments.length === 0 ? [] : [metadata];
  } else {
    response.attachmentCount = 0;
  }
  return response;
}

function sanitizeAuditState(auth: AuthContext, value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditState(auth, item));
  if (!value || typeof value !== 'object') return value;
  const response: Record<string, unknown> = {};
  const canBasic = hasPermission(auth, 'patient:basic-read');
  const canLocation = hasPermission(auth, 'patient:location-read');
  const canMedical = hasPermission(auth, 'patient:medical-read');
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if ((INTERNAL_EMERGENCY_FIELDS as readonly string[]).includes(key)) continue;
    if (key === 'description' && !canBasic) continue;
    if (key === 'location' && !canLocation) continue;
    if (key === 'attachments' && !canMedical) continue;
    if (key === 'note' && !canMedical) continue;
    response[key] = sanitizeAuditState(auth, item);
  }
  return response;
}

/** Keeps audit evidence useful while enforcing patient fields on state snapshots. */
export function toClientAudit(auth: AuthContext, entry: { toJSON(): Record<string, unknown> }): Record<string, unknown> {
  const value = entry.toJSON();
  return {
    ...value,
    previousState: sanitizeAuditState(auth, value.previousState),
    newState: sanitizeAuditState(auth, value.newState),
  };
}
export async function notificationScopeFilter(auth: AuthContext): Promise<Record<string, unknown>> {
  if (hasPermission(auth, 'alert:read:all')) return {};
  const scope: Record<string, unknown>[] = [{ ownerId: auth.userId }];
  if (auth.hospitalId) scope.push({ hospitalId: auth.hospitalId });
  if (hasPermission(auth, 'alert:read:relevant') && auth.hospitalId) {
    const emergencyIds = await Emergency.find({ destinationHospital: auth.hospitalId }).select('_id').lean();
    scope.push({ linkedEmergency: { $in: emergencyIds.map((emergency) => emergency._id) } });
  }
  if (hasPermission(auth, 'alert:read:own')) {
    const ownedConditions: Record<string, unknown>[] = [{ citizenId: auth.userId }, { assignedCrewIds: auth.userId }];
    if (auth.ambulanceId) {
      ownedConditions.push({ assignedAmbulance: auth.ambulanceId });
    }
    const owned = await Emergency.find({ $or: ownedConditions }).select('_id').lean();
    scope.push({ linkedEmergency: { $in: owned.map((emergency) => emergency._id) } });
  }
  scope.push({ audienceRoles: auth.role });
  return { $or: scope };
}
export async function canReadNotification(auth: AuthContext, notification: { ownerId?: string | null; hospitalId?: string | null; audienceRoles?: string[]; linkedEmergency?: string | null }): Promise<boolean> {
  if (hasPermission(auth, 'alert:read:all')) return true;
  if (notification.ownerId && notification.ownerId === auth.userId) return true;
  if (notification.hospitalId && notification.hospitalId === auth.hospitalId && hasPermission(auth, 'alert:read:relevant')) return true;
  if (notification.audienceRoles?.includes(auth.role)) return true;
  if (notification.linkedEmergency) {
    const emergency = await Emergency.findById(notification.linkedEmergency).lean();
    return Boolean(emergency && await canReadEmergency(auth, emergency));
  }
  return false;
}




