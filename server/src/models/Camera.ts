import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

export const CAMERA_STATUSES = ['ONLINE', 'DEGRADED', 'OFFLINE'] as const;
const cameraSchema = new Schema(
  {
    _id: { type: String, required: true }, // CAM-001
    name: { type: String, required: true, trim: true, maxlength: 120 },
    zone: { type: String, required: true, trim: true, maxlength: 120, index: true },
    location: { lat: { type: Number, required: true }, lng: { type: Number, required: true }, address: { type: String, maxlength: 300 } },
    status: { type: String, enum: CAMERA_STATUSES, required: true, default: 'ONLINE', index: true },
    liveEnabled: { type: Boolean, required: true, default: true },
    recordingEnabled: { type: Boolean, required: true, default: true },
    retentionDays: { type: Number, required: true, default: 30, min: 1, max: 365 },
    lastHeartbeatAt: { type: Date, index: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);
export type CameraDoc = InferSchemaType<typeof cameraSchema>;
export const Camera: Model<CameraDoc> = model<CameraDoc>('Camera', cameraSchema);
