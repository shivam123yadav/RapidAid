import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

export const SHIFT_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
const shiftSchema = new Schema(
  {
    _id: { type: String, required: true }, // SH-001
    title: { type: String, required: true, trim: true, maxlength: 120 },
    startsAt: { type: Date, required: true, index: true },
    endsAt: { type: Date, required: true, index: true },
    status: { type: String, enum: SHIFT_STATUSES, required: true, default: 'PLANNED', index: true },
    crewIds: { type: [String], default: [], index: true },
    ambulanceId: { type: String, index: true },
    createdBy: { type: String, required: true, index: true },
    notes: { type: String, maxlength: 1000 },
    startedAt: { type: Date },
    endedAt: { type: Date },
    createdAt: { type: Date, required: true, index: true },
    updatedAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);
export type ShiftDoc = InferSchemaType<typeof shiftSchema>;
export const Shift: Model<ShiftDoc> = model<ShiftDoc>('Shift', shiftSchema);
