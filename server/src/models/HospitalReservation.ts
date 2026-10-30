import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import {
  HOSPITAL_RESOURCE_TYPES,
  RESERVATION_STATUSES,
} from '../validation/constants.js';

const hospitalReservationSchema = new Schema(
  {
    _id: { type: String, required: true },
    emergencyId: { type: String, required: true, index: true },
    hospitalId: { type: String, required: true, index: true },
    resourceType: {
      type: String,
      enum: HOSPITAL_RESOURCE_TYPES,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: RESERVATION_STATUSES,
      required: true,
      default: 'CONFIRMED',
      index: true,
    },
    allocatedUnits: { type: Number, required: true, default: 1, min: 1 },
    bedTypeDecremented: {
      type: String,
      enum: ['icuBeds', 'generalBeds', null],
      default: null,
    },
    incomingAmbulanceIncremented: { type: Boolean, required: true, default: true },
    capacityApplied: { type: Boolean, required: true, default: false, index: true },
    capacityCompensated: { type: Boolean, required: true, default: false, index: true },
    claimToken: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
    confirmedAt: { type: Date },
    releasedAt: { type: Date },
    releaseReason: { type: String, trim: true },
    idempotencyKey: { type: String },
    notes: { type: String },
  },
  { ...baseSchemaOptions, timestamps: true },
);

hospitalReservationSchema.index({ emergencyId: 1, hospitalId: 1, resourceType: 1, status: 1 });
hospitalReservationSchema.index({ hospitalId: 1, status: 1 });
hospitalReservationSchema.index({ status: 1, expiresAt: 1 });
hospitalReservationSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true });

export type HospitalReservationDoc = InferSchemaType<typeof hospitalReservationSchema>;
export const HospitalReservation: Model<HospitalReservationDoc> = model<HospitalReservationDoc>(
  'HospitalReservation',
  hospitalReservationSchema,
);
