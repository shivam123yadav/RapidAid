import { Hospital, nextId } from '../models/index.js';
import type { HospitalDoc } from '../models/Hospital.js';
import { recordAudit } from './auditService.js';
import { ApiError } from '../utils/errors.js';
import type { AuthContext } from '../authz/access.js';
import type { CreateHospitalInput } from '../validation/schemas.js';
import type { Role } from '../validation/constants.js';

/**
 * Master identity/contact fields. Only `hospital:update:all` (Administrator)
 * callers may write these — re-exported from the central access layer so the
 * route file and the service can never disagree about what "master" means.
 */
export { HOSPITAL_MASTER_FIELDS, HOSPITAL_OPERATIONAL_FIELDS } from '../authz/access.js';

export interface HospitalAuditContext {
  auth: AuthContext;
  requestId: string;
  ip?: string;
  userAgent?: string;
}

function auditBase(ctx: HospitalAuditContext) {
  return {
    actor: ctx.auth.name,
    actorId: ctx.auth.userId,
    actorRole: ctx.auth.role as Role,
    requestId: ctx.requestId,
    ip: ctx.ip,
    userAgent: ctx.userAgent,
  };
}

/** Operational defaults applied on create, so a new record is dispatch-safe. */
const CREATE_DEFAULTS = {
  status: 'OPERATIONAL',
  verificationStatus: 'PENDING',
  emergencyCapacity: 'AVAILABLE',
  icuCapacity: 'AVAILABLE',
  traumaAvailable: false,
  capabilities: [] as string[],
  incomingAmbulances: 0,
  currentLoad: 0,
  generalBeds: 0,
  icuBeds: 0,
  traumaCapacity: 'LIMITED',
  ventilatorAvailability: 'AVAILABLE',
  operatingTheatreAvailability: 'AVAILABLE',
  specialistAvailability: 'AVAILABLE',
  bloodAvailability: 'AVAILABLE',
  estimatedWaitingTimeMinutes: 0,
  operationalStatus: 'OPERATIONAL',
} as const;

/**
 * Obvious-duplicate check: same registration number, or same name + city.
 * Case/whitespace-insensitive on the Mongo side, so "aiims trauma centre"
 * cannot be onboarded alongside "AIIMS Trauma Centre".
 */
async function assertNoDuplicateHospital(
  input: { name?: string | null; city?: string | null; registrationNumber?: string | null },
  excludeId?: string,
): Promise<void> {
  const clauses: Record<string, unknown>[] = [];
  if (input.registrationNumber) clauses.push({ registrationNumber: input.registrationNumber });
  if (input.name) {
    const name = { name: input.name };
    clauses.push(input.city ? { name: input.name, city: input.city } : name);
  }
  if (clauses.length === 0) return;
  const existing = await Hospital.findOne({
    $or: clauses,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();
  if (!existing) return;
  const clash = input.registrationNumber && existing.registrationNumber === input.registrationNumber
    ? 'registration number'
    : 'name and city';
  throw ApiError.conflict(`A hospital with this ${clash} already exists (${existing._id})`);
}

/**
 * Creates a hospital. Administrator-only at the route (`hospital:create`);
 * this layer owns what the zod schema cannot express: duplicate detection and
 * the creation audit record.
 */
export async function createHospital(input: CreateHospitalInput, ctx: HospitalAuditContext): Promise<HospitalDoc> {
  await assertNoDuplicateHospital(input);
  const _id = await nextId('hospital', 'HOSP', 2);
  const hospital = await Hospital.create({ _id, ...input, ...CREATE_DEFAULTS, active: true });
  await recordAudit({
    ...auditBase(ctx),
    action: 'hospital.created',
    resource: 'Hospital',
    resourceId: _id,
    newState: hospital.toObject(),
    details: `verificationStatus=${hospital.verificationStatus}, hospitalType=${hospital.hospitalType}`,
  });
  return hospital;
}

/**
 * Administrator master-data edit (identity, registration, location, contact).
 * Re-checks duplicates so renaming cannot collide with another facility.
 */
export async function updateHospitalMasterData(
  hospitalId: string,
  updates: Record<string, unknown>,
  ctx: HospitalAuditContext,
  reason?: string,
): Promise<HospitalDoc> {
  const existing = await Hospital.findById(hospitalId).lean();
  if (!existing) throw ApiError.notFound(`Hospital ${hospitalId} not found`);
  if (['name', 'city', 'registrationNumber'].some((key) => typeof updates[key] === 'string')) {
    await assertNoDuplicateHospital(
      {
        name: (updates.name as string | undefined) ?? existing.name,
        city: (updates.city as string | undefined) ?? existing.city,
        registrationNumber: (updates.registrationNumber as string | undefined) ?? existing.registrationNumber,
      },
      hospitalId,
    );
  }
  const hospital = await Hospital.findByIdAndUpdate(hospitalId, { $set: updates }, { new: true, runValidators: true });
  if (!hospital) throw ApiError.notFound(`Hospital ${hospitalId} not found`);
  await recordAudit({
    ...auditBase(ctx),
    action: 'hospital.updated',
    resource: 'Hospital',
    resourceId: hospitalId,
    previousState: existing,
    newState: hospital.toObject(),
    reason,
    details: `master data updated: ${Object.keys(updates).join(', ')}`,
  });
  return hospital;
}

/**
 * Operational/capacity update. The route has already proved the caller may
 * write here (Admin/Supervisor for any facility; Hospital Staff only for their
 * own, via the hospitalId on the signed-in token), so this function's remaining
 * job is the audit trail: every capacity change keeps before/after evidence.
 */
export async function updateHospitalOperational(
  hospitalId: string,
  updates: Record<string, unknown>,
  ctx: HospitalAuditContext,
  reason?: string,
): Promise<HospitalDoc> {
  const existing = await Hospital.findById(hospitalId).lean();
  if (!existing) throw ApiError.notFound(`Hospital ${hospitalId} not found`);
  const hospital = await Hospital.findByIdAndUpdate(hospitalId, { $set: updates }, { new: true, runValidators: true });
  if (!hospital) throw ApiError.notFound(`Hospital ${hospitalId} not found`);
  const before = existing as unknown as Record<string, unknown>;
  const after = hospital.toObject() as Record<string, unknown>;
  const keys = Object.keys(updates);
  await recordAudit({
    ...auditBase(ctx),
    action: 'hospital.capacity_updated',
    resource: 'Hospital',
    resourceId: hospitalId,
    previousState: Object.fromEntries(keys.map((key) => [key, before[key]])),
    newState: Object.fromEntries(keys.map((key) => [key, after[key]])),
    reason,
    details: `operational data updated: ${keys.join(', ')}`,
  });
  return hospital;
}
export function toClientHospital(
  auth: AuthContext,
  hospital: { toJSON(): Record<string, unknown> } | Record<string, unknown>,
): Record<string, unknown> {
  const source = hospital as { toJSON?: () => Record<string, unknown> };
  const response: Record<string, unknown> = {
    ...(typeof source.toJSON === 'function' ? source.toJSON() : (hospital as Record<string, unknown>)),
  };
  const canReadInternal =
    auth.permissions.includes('hospital:read:all') ||
    auth.permissions.includes('hospital:read:historical') ||
    auth.permissions.includes('hospital:read:own');
  if (!canReadInternal) {
    // Public / operational consumers: location + capability only.
    for (const key of ['registrationNumber', 'deactivationReason', 'reviewNote', 'reviewedBy', 'reviewedAt']) {
      delete response[key];
    }
  }
  if (auth.role === 'CITIZEN') {
    const allowed = new Set([
      'id', 'name', 'location', 'phone', 'status', 'operationalStatus',
      'emergencyCapacity', 'icuCapacity', 'traumaAvailable', 'capabilities',
      'generalBeds', 'icuBeds', 'traumaCapacity', 'specialistAvailability', 'currentLoad',
    ]);
    for (const key of Object.keys(response)) if (!allowed.has(key)) delete response[key];
  }
  if (auth.role === 'AMBULANCE_CREW') {
    const allowed = new Set([
      'id', 'name', 'location', 'phone', 'status', 'operationalStatus',
      'emergencyCapacity', 'icuCapacity', 'traumaAvailable', 'capabilities',
      'traumaCapacity', 'generalBeds', 'icuBeds', 'estimatedWaitingTimeMinutes',
    ]);
    for (const key of Object.keys(response)) if (!allowed.has(key)) delete response[key];
  }
  return response;
}
