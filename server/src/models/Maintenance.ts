import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

export const MAINTENANCE_STATUSES = ['OPEN', 'IN_PROGRESS', 'APPROVED', 'RESOLVED', 'REJECTED'] as const;
export const MAINTENANCE_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
const maintenanceSchema = new Schema(
  {
    _id: { type: String, required: true }, // MNT-001
    ambulanceId: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, required: true, trim: true, maxlength: 2000 },
    severity: { type: String, enum: MAINTENANCE_SEVERITIES, required: true, default: 'MEDIUM', index: true },
    status: { type: String, enum: MAINTENANCE_STATUSES, required: true, default: 'OPEN', index: true },
    reportedBy: { type: String, required: true, index: true },
    assignedTo: { type: String, index: true },
    resolution: { type: String, maxlength: 2000 },
    createdAt: { type: Date, required: true, index: true },
    updatedAt: { type: Date, required: true },
    resolvedAt: { type: Date },
  },
  baseSchemaOptions,
);
export type MaintenanceDoc = InferSchemaType<typeof maintenanceSchema>;
export const Maintenance: Model<MaintenanceDoc> = model<MaintenanceDoc>('Maintenance', maintenanceSchema);
