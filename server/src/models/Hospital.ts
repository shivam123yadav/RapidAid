import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { CAPACITY_STATUSES, HOSPITAL_STATUSES, HOSPITAL_TYPES, HOSPITAL_VERIFICATION_STATUSES } from '../validation/constants.js';

const hospitalSchema = new Schema(
  {
    _id: { type: String, required: true }, // HOSP-01
    // ── Master data (Administrator-controlled) ──────────────────────────
    /** Official registration identifier. Partial-unique so double-onboarding is refused by the DB itself. */
    registrationNumber: { type: String, trim: true },
    name: { type: String, required: true },
    hospitalType: { type: String, enum: HOSPITAL_TYPES, required: true, default: 'GOVERNMENT' },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    postalCode: { type: String, trim: true },
    emergencyContact: { type: String, trim: true },
    /**
     * Registration review state. Administrator onboards a facility
     * (PENDING by default); a Supervisor holding hospital:approve verifies or
     * rejects it. A rejected facility is retained, never hard-deleted.
     */
    verificationStatus: { type: String, enum: HOSPITAL_VERIFICATION_STATUSES, required: true, default: 'PENDING', index: true },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    reviewNote: { type: String },
    // ── Operational data (own-facility Hospital Staff may update) ───────
    status: { type: String, enum: HOSPITAL_STATUSES, required: true, default: 'OPERATIONAL', index: true },
    /**
     * Soft-offboarding. `active: false` removes a facility from new dispatch /
     * destination selection while historical emergency, ambulance and audit
     * references to this id keep resolving.
     */
    deactivatedAt: { type: Date },
    deactivatedBy: { type: String },
    deactivationReason: { type: String },
    reactivatedAt: { type: Date },
    reactivatedBy: { type: String },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String },
    },
    phone: { type: String, required: true },
    emergencyCapacity: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    icuCapacity: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    traumaAvailable: { type: Boolean, required: true, default: false },
    capabilities: { type: [String], default: [] },
    incomingAmbulances: { type: Number, required: true, default: 0, min: 0 },
    activeReservationIds: { type: [String], default: [], index: true },
    active: { type: Boolean, default: true, index: true },
    currentLoad: { type: Number, required: true, default: 0, min: 0, max: 100 },
    generalBeds: { type: Number, required: true, default: 0, min: 0 },
    icuBeds: { type: Number, required: true, default: 0, min: 0 },
    traumaCapacity: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'LIMITED' },
    ventilatorAvailability: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    operatingTheatreAvailability: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    specialistAvailability: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    bloodAvailability: { type: String, enum: CAPACITY_STATUSES, required: true, default: 'AVAILABLE' },
    estimatedWaitingTimeMinutes: { type: Number, required: true, default: 0, min: 0, max: 1440 },
    operationalStatus: { type: String, enum: HOSPITAL_STATUSES, required: true, default: 'OPERATIONAL' },
    /**
     * GeoJSON point for MongoDB geospatial queries, in the order
     * `[longitude, latitude]` (NOT lat/lng). Derived from `location` by
     * `ensureHospitalGeoFields` on boot; the routing service falls back to an
     * in-process haversine scan when it is absent, so the two can never drift
     * into a hard failure.
     */
    geo: {
      type: {
        type: String,
        enum: ['Point'],
        required: false,
      },
      coordinates: { type: [Number], required: false },
    },
  },
  { ...baseSchemaOptions, timestamps: true },
);

export type HospitalDoc = InferSchemaType<typeof hospitalSchema>;

// Registration identifier is unique when supplied (a partial index, so facilities
// without one can still onboard). A duplicate registration number would be an
// obvious double-onboarding, so the database — not just the API — refuses it.
hospitalSchema.index({ registrationNumber: 1 }, { unique: true, partialFilterExpression: { registrationNumber: { $type: 'string' } } });
// Dispatch reads the network by operational status; deactivation filtering relies on it.
hospitalSchema.index({ active: 1, status: 1 });
// Nearest-hospital routing uses $geoNear against this GeoJSON point. Sparse so
// documents that have not been backfilled yet are simply skipped by the query.
hospitalSchema.index({ geo: '2dsphere' }, { sparse: true });
// Master-data lookups (duplicate-name checks) and verification queues.
hospitalSchema.index({ name: 1 });
hospitalSchema.index({ verificationStatus: 1, createdAt: -1 });

export const Hospital: Model<HospitalDoc> = model<HospitalDoc>('Hospital', hospitalSchema);
