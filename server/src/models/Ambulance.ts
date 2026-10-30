import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { AMBULANCE_STATUSES } from '../validation/constants.js';

// Crew member primary key is the readable code (C001), not an ObjectId.
// Subdocuments don't inherit the parent's toJSON transform, so this child
// schema needs its own `_id` → `id` mapping for the frontend CrewMember shape.
const crewMemberSchema = new Schema(
  {
    _id: { type: String, required: true }, // C001
    name: { type: String, required: true },
    role: { type: String, required: true },
    certification: { type: [String], default: [] },
    /**
     * Linked login account (USR-002) for seats filled by an authenticated
     * crew member. This is the authoritative ownership link: it is what
     * "your assigned ambulance" resolves to for AMBULANCE_CREW callers.
     * Optional — roster seats can be staffed by people with no login.
     */
    userId: { type: String, index: true },
  },
  {
    _id: true,
    toJSON: {
      transform(_doc: unknown, ret: Record<string, unknown>) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        // userId is an internal authz link, not part of the API contract.
        delete ret.userId;
        return ret;
      },
    },
  },
);

const activeRouteSchema = new Schema(
  {
    coordinates: { type: [[Number]], default: [] },
    distanceMeters: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: 0 },
    calculatedAt: { type: Date },
    destinationType: { type: String, enum: ['INCIDENT', 'HOSPITAL'] },
    destinationId: { type: String },
    destinationLocation: {
      lat: { type: Number },
      lng: { type: Number },
      address: { type: String },
    },
    routeOrigin: {
      lat: { type: Number },
      lng: { type: Number },
    },
    provider: { type: String },
    status: { type: String, enum: ['SUCCESS', 'NO_ROUTE', 'FAILED', 'UNAVAILABLE'], default: 'UNAVAILABLE' },
    isStale: { type: Boolean, default: false },
    deviated: { type: Boolean, default: false },
    deviationDistanceMeters: { type: Number, default: 0 },
  },
  { _id: false },
);

const ambulanceSchema = new Schema(
  {
    _id: { type: String, required: true }, // AMB-017
    status: { type: String, enum: AMBULANCE_STATUSES, required: true, default: 'AVAILABLE', index: true },
    location: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String },
    },
    speed: { type: Number, required: true, default: 0, min: 0 },
    heading: { type: Number, required: true, default: 0, min: 0, max: 360 },
    crew: { type: [crewMemberSchema], default: [] },
    capabilities: { type: [String], default: [] },
    equipment: { type: [String], default: [] },
    currentEmergency: { type: String, index: true },
    claimToken: { type: String, index: true },
    destinationHospital: { type: String },
    eta: { type: Number },
    lastUpdated: { type: Date, required: true },
    isSimulated: { type: Boolean, default: false },
    telemetrySource: { type: String, enum: ['HARDWARE_GPS', 'SIMULATED'], default: 'HARDWARE_GPS' },
    activeRoute: { type: activeRouteSchema },
    /**
     * Soft-delete flag. Retired units stay in the collection because emergency
     * timelines and audit records reference this _id; they are hidden from
     * fleet reads and cannot be dispatched.
     */
    active: { type: Boolean, default: true, index: true },
  },
  baseSchemaOptions,
);

export type AmbulanceDoc = InferSchemaType<typeof ambulanceSchema>;
export const Ambulance: Model<AmbulanceDoc> = model<AmbulanceDoc>('Ambulance', ambulanceSchema);
