import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

export const REPORT_TYPES = [
  'INCIDENT_SUMMARY', 'RESPONSE_PERFORMANCE', 'FLEET_UTILIZATION',
  'HOSPITAL_CAPACITY', 'MAINTENANCE', 'CUSTOM',
] as const;
export const REPORT_STATUSES = ['GENERATING', 'READY', 'FAILED'] as const;

const reportSchema = new Schema({
  _id: { type: String, required: true },
  title: { type: String, required: true, trim: true, maxlength: 160 },
  reportType: { type: String, enum: REPORT_TYPES, required: true, index: true },
  periodFrom: { type: Date, required: true, index: true },
  periodTo: { type: Date, required: true, index: true },
  status: { type: String, enum: REPORT_STATUSES, required: true, default: 'GENERATING', index: true },
  createdBy: { type: String, required: true, index: true },
  generatedBy: { type: String, index: true },
  emergencyIds: { type: [String], default: [], index: true },
  summary: { type: Schema.Types.Mixed, required: true, default: {} },
  generatedAt: { type: Date },
  createdAt: { type: Date, required: true, index: true },
  updatedAt: { type: Date, required: true },
}, baseSchemaOptions);

export type ReportDoc = InferSchemaType<typeof reportSchema>;
export const Report: Model<ReportDoc> = model<ReportDoc>('Report', reportSchema);
