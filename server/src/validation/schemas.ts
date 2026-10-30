import { z } from 'zod';
import {
  AMBULANCE_STATUSES,
  ATTACHMENT_MIME_TYPES,
  CAPACITY_STATUSES,
  DETECTION_STATUSES,
  EMERGENCY_SOURCES,
  EMERGENCY_STATUSES,
  HOSPITAL_STATUSES,
  HOSPITAL_TYPES,
  HOSPITAL_VERIFICATION_STATUSES,
  INCIDENT_TYPES,
  MAX_ATTACHMENTS_PER_EMERGENCY,
  MAX_ATTACHMENT_BYTES,
  PRIORITIES,
  ROLES,
  type AttachmentMimeType,
} from './constants.js';

// ── Auth ────────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
  role: z.enum(ROLES, { message: 'Please select a valid role' }),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  // Public registration is intentionally citizen-only. Operational accounts
  // are provisioned by the Administrator API; accepting a role from an
  // unauthenticated registration body would be a privilege-escalation path.
  role: z.literal('CITIZEN').default('CITIZEN'),
  avatar: z.string().url().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** POST /api/auth/verify-email — consumes a one-time confirmation link. */
export const verifyEmailSchema = z.object({
  token: z.string().trim().min(10, 'Verification token is required').max(200),
});

/** POST /api/auth/forgot-password — always succeeds, whether or not the account exists. */
export const forgotPasswordSchema = z.object({
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
});

/** POST /api/auth/reset-password — consumes a reset link and sets a new password. */
export const resetPasswordSchema = z.object({
  token: z.string().trim().min(10, 'Reset token is required').max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// ── Emergencies ─────────────────────────────────────────────────────────
export const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().max(300).optional(),
});

/**
 * A single photo attached to an emergency report. The client sends a base64
 * data URL (reports are JSON, not multipart); we re-check the prefix, that the
 * base64 actually decodes, that it is a real image of the declared type, and
 * the decoded byte size — so a client can never smuggle a non-image or an
 * oversized blob past the zod contract.
 */
const DATA_URL_PREFIXES = ATTACHMENT_MIME_TYPES.map((type) => `data:${type};base64,`);

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

/**
 * `mimeType` comes from the client, so the declared type alone proves nothing:
 * match the decoded bytes against each format's magic-byte signature. Photos
 * are stored inline and rendered in the console, so this is also what keeps
 * non-image content out of a `data:image/...` URL.
 */
const IMAGE_SIGNATURE_CHECKS: Record<AttachmentMimeType, (bytes: Buffer) => boolean> = {
  'image/png': (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  'image/gif': (b) =>
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || // GIF87a
    startsWith(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]), // GIF89a
  'image/webp': (b) =>
    startsWith(b, [0x52, 0x49, 0x46, 0x46]) && // "RIFF"
    startsWith(b, [0x57, 0x45, 0x42, 0x50], 8), // "WEBP" at offset 8
};

export const attachmentSchema = z
  .object({
    name: z.string().trim().min(1, 'Photo name is required').max(200),
    mimeType: z.enum(ATTACHMENT_MIME_TYPES, { message: `Photo must be one of: ${ATTACHMENT_MIME_TYPES.join(', ')}` }),
    // 2 MB decoded → ~2.79 M base64 characters.
    dataUrl: z
      .string()
      .max(Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + DATA_URL_PREFIXES[0].length + 16)
      .refine(
        (value) => DATA_URL_PREFIXES.some((prefix) => value.startsWith(prefix)),
        { message: `Photo must be a base64 data URL of type: ${ATTACHMENT_MIME_TYPES.join(', ')}` },
      ),
  })
  .transform((value, ctx) => {
    const base64 = value.dataUrl.slice(value.dataUrl.indexOf(',') + 1);
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Photo data is empty or not valid base64' });
      return z.NEVER;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      ctx.addIssue({ code: 'custom', message: `Photo must be ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller (got ${(bytes.length / 1024 / 1024).toFixed(1)} MB)` });
      return z.NEVER;
    }
    if (!IMAGE_SIGNATURE_CHECKS[value.mimeType](bytes)) {
      ctx.addIssue({ code: 'custom', message: `"${value.name}" is not a valid ${value.mimeType} image` });
      return z.NEVER;
    }
    return {
      name: value.name,
      mimeType: value.mimeType,
      size: bytes.length,
      dataUrl: value.dataUrl,
    };
  });

export const createEmergencySchema = z.object({
  priority: z.enum(PRIORITIES).default('MEDIUM'),
  incidentType: z.enum(INCIDENT_TYPES),
  location: geoSchema,
  source: z.enum(EMERGENCY_SOURCES).default('CITIZEN_REPORT'),
  description: z.string().trim().min(5, 'Description must be at least 5 characters').max(2000),
  victimCount: z.number().int().min(0).max(999).default(1),
  attachments: z
    .array(attachmentSchema)
    .max(MAX_ATTACHMENTS_PER_EMERGENCY, `An emergency can hold at most ${MAX_ATTACHMENTS_PER_EMERGENCY} photos`)
    .default([]),
});
export type CreateEmergencyInput = z.infer<typeof createEmergencySchema>;

export const updateStatusSchema = z.object({
  status: z.enum(EMERGENCY_STATUSES),
  currentStatus: z.enum(EMERGENCY_STATUSES).optional(),
  note: z.string().trim().max(500).optional(),
});
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>;

// ── Dispatch ────────────────────────────────────────────────────────────
export const assignSchema = z.object({
  emergencyId: z.string().trim().min(1),
  ambulanceId: z.string().trim().min(1),
});
export type AssignInput = z.infer<typeof assignSchema>;

// ── Vision ──────────────────────────────────────────────────────────────
export const detectionStatusSchema = z.object({
  status: z.enum(DETECTION_STATUSES),
  reviewedBy: z.string().trim().min(1).max(100).optional(),
});

const shiftFields = z.object({
  title: z.string().trim().min(2).max(120),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  crewIds: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  ambulanceId: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(1000).optional(),
});
export const shiftCreateSchema = shiftFields.refine((value) => value.endsAt > value.startsAt, { path: ['endsAt'], message: 'endsAt must be after startsAt' });
export const shiftUpdateSchema = shiftFields.partial().refine((value) => Object.keys(value).length > 0, { message: 'No shift fields supplied' }).refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, { path: ['endsAt'], message: 'endsAt must be after startsAt' });
export const shiftStatusSchema = z.object({ status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']), note: z.string().trim().max(500).optional() });

// ── Maintenance / Cameras ─────────────────────────────────────────────────
export const maintenanceCreateSchema = z.object({ ambulanceId: z.string().trim().min(1).max(40), title: z.string().trim().min(2).max(160), description: z.string().trim().min(5).max(2000), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM') });
export const maintenanceUpdateSchema = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'APPROVED', 'RESOLVED', 'REJECTED']).optional(), assignedTo: z.string().trim().max(40).nullable().optional(), resolution: z.string().trim().max(2000).optional() }).refine((value) => Object.keys(value).length > 0, { message: 'No maintenance fields supplied' });
export const cameraCreateSchema = z.object({ name: z.string().trim().min(2).max(120), zone: z.string().trim().min(1).max(120), location: geoSchema, liveEnabled: z.boolean().default(true), recordingEnabled: z.boolean().default(true), retentionDays: z.number().int().min(1).max(365).default(30) });
export const cameraUpdateSchema = cameraCreateSchema.partial().extend({ status: z.enum(['ONLINE', 'DEGRADED', 'OFFLINE']).optional() }).refine((value) => Object.keys(value).length > 0, { message: 'No camera fields supplied' });

const reportBaseFields = {
  title: z.string().trim().min(2).max(160),
  reportType: z.enum(['INCIDENT_SUMMARY', 'RESPONSE_PERFORMANCE', 'FLEET_UTILIZATION', 'HOSPITAL_CAPACITY', 'MAINTENANCE', 'CUSTOM']),
  periodFrom: z.coerce.date(),
  periodTo: z.coerce.date(),
};
const validReportPeriod = (value: { periodFrom: Date; periodTo: Date }) => value.periodTo >= value.periodFrom;
export const reportCreateSchema = z.object(reportBaseFields).refine(validReportPeriod, { path: ['periodTo'], message: 'periodTo must not precede periodFrom' });
export const reportGenerateSchema = z.object(reportBaseFields).refine(validReportPeriod, { path: ['periodTo'], message: 'periodTo must not precede periodFrom' });

const hospitalCapacityEnum = z.enum(CAPACITY_STATUSES);
const hospitalStatusEnum = z.enum(HOSPITAL_STATUSES);

/** Master identity/contact fields — Administrator-controlled (hospital:update:all only). */
export const hospitalMasterDataSchema = z.object({
  name: z.string().trim().min(2, 'Hospital name is required').max(160),
  registrationNumber: z.string().trim().min(3, 'Registration number must be at least 3 characters').max(40),
  location: geoSchema,
  phone: z.string().trim().min(3).max(40),
  hospitalType: z.enum(HOSPITAL_TYPES).default('GOVERNMENT'),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  postalCode: z.string().trim().max(12).optional(),
  emergencyContact: z.string().trim().max(40).optional(),
});

/** Operational fields Hospital Staff may change for their OWN facility. */
export const hospitalOperationalSchema = z.object({
  emergencyCapacity: hospitalCapacityEnum.optional(),
  icuCapacity: hospitalCapacityEnum.optional(),
  traumaAvailable: z.boolean().optional(),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(50).optional(),
  incomingAmbulances: z.number().int().min(0).optional(),
  currentLoad: z.number().int().min(0).max(100).optional(),
  generalBeds: z.number().int().min(0).optional(),
  icuBeds: z.number().int().min(0).optional(),
  traumaCapacity: hospitalCapacityEnum.optional(),
  ventilatorAvailability: hospitalCapacityEnum.optional(),
  operatingTheatreAvailability: hospitalCapacityEnum.optional(),
  specialistAvailability: hospitalCapacityEnum.optional(),
  bloodAvailability: hospitalCapacityEnum.optional(),
  estimatedWaitingTimeMinutes: z.number().int().min(0).max(1440).optional(),
  operationalStatus: hospitalStatusEnum.optional(),
});

export const createHospitalSchema = z.object({
  ...hospitalMasterDataSchema.shape,
  ...hospitalOperationalSchema.shape,
  status: hospitalStatusEnum.default('OPERATIONAL'),
  verificationStatus: z.enum(HOSPITAL_VERIFICATION_STATUSES).default('PENDING'),
  emergencyCapacity: hospitalCapacityEnum.default('AVAILABLE'),
  icuCapacity: hospitalCapacityEnum.default('AVAILABLE'),
  traumaAvailable: z.boolean().default(false),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(50).default([]),
  incomingAmbulances: z.number().int().min(0).default(0),
  currentLoad: z.number().int().min(0).max(100).default(0),
  generalBeds: z.number().int().min(0).default(0),
  icuBeds: z.number().int().min(0).default(0),
  traumaCapacity: hospitalCapacityEnum.default('LIMITED'),
  ventilatorAvailability: hospitalCapacityEnum.default('AVAILABLE'),
  operatingTheatreAvailability: hospitalCapacityEnum.default('AVAILABLE'),
  specialistAvailability: hospitalCapacityEnum.default('AVAILABLE'),
  bloodAvailability: hospitalCapacityEnum.default('AVAILABLE'),
  estimatedWaitingTimeMinutes: z.number().int().min(0).max(1440).default(0),
  operationalStatus: hospitalStatusEnum.default('OPERATIONAL'),
});

export const updateHospitalMasterDataSchema = hospitalMasterDataSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No master data fields supplied' },
);
export const updateHospitalOperationalSchema = hospitalOperationalSchema.refine(
  (value) => Object.keys(value).length > 0,
  { message: 'No operational fields supplied' },
);
export const updateHospitalSchema = createHospitalSchema.partial().refine((value) => Object.keys(value).length > 0, { message: 'No hospital fields supplied' });
export const deactivateHospitalSchema = z.object({ reason: z.string().trim().min(10, 'A reason of at least 10 characters is required').max(1000) });
export const reactivateHospitalSchema = z.object({ reason: z.string().trim().max(1000).optional() });
export const reviewHospitalSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().min(3, 'A review note is required').max(1000) });
export type CreateHospitalInput = z.infer<typeof createHospitalSchema>;

/**
 * Associates a Hospital Staff account with a facility. `hospitalId` is the
 * target facility chosen by an Administrator — it is deliberately NOT taken
 * from the client's own user object, so a caller cannot self-assign or
 * re-point someone else's scope. Password comes from the Administrator;
 * account activation follows the same deactivation-preserving lifecycle as
 * hospitals (no hard delete).
 */
export const assignHospitalStaffSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address'),
  password: z.string().min(8, 'Temporary password must be at least 8 characters').max(128),
  hospitalId: z.string().trim().regex(/^HOSP-\d{1,10}$/, 'Invalid hospital id'),
  phone: z.string().trim().max(40).optional(),
});
export const updateHospitalStaffSchema = z.object({
  hospitalId: z.string().trim().regex(/^HOSP-\d{1,10}$/, 'Invalid hospital id').optional(),
  active: z.boolean().optional(),
  name: z.string().trim().min(2).max(100).optional(),
  email: z.string().trim().toLowerCase().email('Please enter a valid email address').optional(),
  reason: z.string().trim().max(500).optional(),
}).refine((value) => value.hospitalId !== undefined || value.active !== undefined || value.name !== undefined || value.email !== undefined, {
  message: 'No staff fields supplied',
});
export type AssignHospitalStaffInput = z.infer<typeof assignHospitalStaffSchema>;


// ── Ambulances ────────────────────────────────────────────────────────────
export const emergencyOverrideSchema = z.object({
  reason: z.string().trim().min(10, 'Override reason is required').max(1000),
  action: z.enum(['REASSIGN_AMBULANCE', 'ESCALATE', 'ROUTE_HOSPITAL', 'ACTIVATE_GREEN_CORRIDOR']),
  ambulanceId: z.string().trim().max(40).optional(),
  hospitalId: z.string().trim().max(40).optional(),
  priority: z.enum(PRIORITIES).optional(),
}).superRefine((value, ctx) => {
  if (value.action === 'REASSIGN_AMBULANCE' && !value.ambulanceId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ambulanceId'], message: 'ambulanceId is required for ambulance reassignment' });
  if (value.action === 'ROUTE_HOSPITAL' && !value.hospitalId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hospitalId'], message: 'hospitalId is required for hospital routing' });
});

/**
 * Crew telemetry — the narrow operational update a crew member may make on
 * their OWN unit (enforced by the ownership check in ambulances.routes.ts).
 * Fleet-wide attributes (capabilities, equipment, roster) are NOT here; those
 * belong to updateAmbulanceSchema, which is manager-only.
 */
export const ambulanceTelemetrySchema = z.object({
  status: z.enum(AMBULANCE_STATUSES).optional(),
  location: geoSchema.optional(),
  speed: z.number().min(0).max(300).optional(),
  heading: z.number().min(0).max(360).optional(),
  eta: z.number().int().min(0).max(86400).optional(),
  timestamp: z.union([z.string().datetime(), z.string(), z.number(), z.date()]).optional(),
  isSimulated: z.boolean().optional(),
  telemetrySource: z.enum(['HARDWARE_GPS', 'SIMULATED']).optional(),
});

/** A roster seat. `userId` binds the seat to a login for ownership checks. */
export const ambulanceCrewMemberSchema = z.object({
  id: z.string().trim().min(1, 'Crew member id is required').max(20),
  name: z.string().trim().min(1, 'Crew member name is required').max(100),
  role: z.string().trim().min(1).max(60),
  certification: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  userId: z.string().trim().min(1).max(40).optional(),
});

const tagList = (field: string) =>
  z.array(z.string().trim().min(1, `${field} entries cannot be blank`).max(40)).max(20);

/** POST /api/ambulances — register a new unit (ADMIN / SUPERVISOR). */
export const createAmbulanceSchema = z.object({
  status: z.enum(AMBULANCE_STATUSES).default('AVAILABLE'),
  location: geoSchema,
  capabilities: tagList('Capability').default([]),
  equipment: tagList('Equipment').default([]),
  crew: z.array(ambulanceCrewMemberSchema).max(8, 'An ambulance can carry at most 8 crew').default([]),
});

/**
 * PATCH /api/ambulances/:id — manager edit. Every field optional, but the
 * roster is replaced wholesale (PUT semantics on `crew`) so a manager cannot
 * accidentally leave a half-removed crew behind.
 */
export const updateAmbulanceSchema = z
  .object({
    status: z.enum(AMBULANCE_STATUSES).optional(),
    location: geoSchema.optional(),
    speed: z.number().min(0).max(300).optional(),
    heading: z.number().min(0).max(360).optional(),
    eta: z.number().int().min(0).max(86400).optional(),
    capabilities: tagList('Capability').optional(),
    equipment: tagList('Equipment').optional(),
    currentEmergency: z.string().trim().min(1).max(20).nullable().optional(),
    destinationHospital: z.string().trim().min(1).max(20).nullable().optional(),
    crew: z.array(ambulanceCrewMemberSchema).max(8, 'An ambulance can carry at most 8 crew').optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'No updatable fields supplied' });

/**
 * PATCH /api/ambulances/:id/crew — assign / clear the crew roster
 * (ADMIN / SUPERVISOR). Binds seats to login accounts, which is what grants a
 * crew member access to the unit.
 */
export const assignAmbulanceCrewSchema = z.object({
  crew: z.array(ambulanceCrewMemberSchema).max(8, 'An ambulance can carry at most 8 crew'),
});

export type CreateAmbulanceInput = z.infer<typeof createAmbulanceSchema>;
export type UpdateAmbulanceInput = z.infer<typeof updateAmbulanceSchema>;
export type AmbulanceCrewInput = z.infer<typeof assignAmbulanceCrewSchema>;

// ── Voice ───────────────────────────────────────────────────────────────
export const voiceTranscriptSchema = z.object({
  transcript: z.string().trim().min(10, 'Transcript must be at least 10 characters').max(10000),
});

export const confirmVoiceSchema = z.object({
  location: geoSchema.optional(),
  priority: z.enum(PRIORITIES).optional(),
  victimCount: z.number().int().min(0).max(999).optional(),
});

/** A reviewer's rejection of a draft: the reason is mandatory and audited. */
export const voiceRejectSchema = z.object({
  reason: z.string().trim().min(3, 'A rejection reason is required').max(500),
});

/**
 * Authorized correction of a voice report's transcript / AI extraction.
 * Every key is optional, but at least one must be supplied (checked in the
 * route so the error message can name the editable fields).
 */
export const voiceEditSchema = z.object({
  transcript: z.string().trim().min(10, 'Transcript must be at least 10 characters').max(10000).optional(),
  extractedData: z
    .object({
      incidentType: z.enum(INCIDENT_TYPES).optional(),
      location: z.string().trim().min(2).max(200).optional(),
      victimCount: z.number().int().min(0).max(999).optional(),
      description: z.string().trim().max(1000).optional(),
    })
    .optional(),
});
