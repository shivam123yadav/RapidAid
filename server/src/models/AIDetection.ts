import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { DETECTION_STATUSES } from '../validation/constants.js';

const boundingBoxSchema = new Schema(
  {
    label: { type: String, required: true },
    x: { type: Number, required: true },
    y: { type: Number, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    confidence: { type: Number, required: true },
  },
  { _id: false },
);

const detectionSchema = new Schema(
  {
    _id: { type: String, required: true }, // DET-001
    cameraId: { type: String, required: true },
    cameraLocation: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
      address: { type: String },
    },
    detectedEvent: { type: String, required: true },
    confidence: { type: Number, required: true, min: 0, max: 100 },
    status: { type: String, enum: DETECTION_STATUSES, required: true, default: 'PENDING_REVIEW', index: true },
    timestamp: { type: Date, required: true, index: true },
    modelName: { type: String, required: true },
    modelVersion: { type: String, required: true },
    boundingBoxes: { type: [boundingBoxSchema], default: [] },
    reviewedBy: { type: String },
    linkedEmergency: { type: String },
  },
  baseSchemaOptions,
);

export type AIDetectionDoc = InferSchemaType<typeof detectionSchema>;
export const AIDetection: Model<AIDetectionDoc> = model<AIDetectionDoc>('AIDetection', detectionSchema);
