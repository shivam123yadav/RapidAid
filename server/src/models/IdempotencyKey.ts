import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

export const IDEMPOTENCY_STATUSES = ['IN_PROGRESS', 'COMPLETED', 'FAILED'] as const;
export type IdempotencyStatus = (typeof IDEMPOTENCY_STATUSES)[number];

const idempotencyKeySchema = new Schema(
  {
    key: { type: String, required: true },
    scope: { type: String, required: true },
    endpoint: { type: String, required: true },
    requestHash: { type: String, required: true },
    status: {
      type: String,
      enum: IDEMPOTENCY_STATUSES,
      default: 'IN_PROGRESS',
      required: true,
      index: true,
    },
    statusCode: { type: Number },
    responseBody: { type: Schema.Types.Mixed },
    createdAt: { type: Date, default: Date.now, expires: 86400 }, // 24-hour TTL index
    updatedAt: { type: Date, default: Date.now },
  },
  baseSchemaOptions,
);

// Enforce single active claim per caller + endpoint + key
idempotencyKeySchema.index({ key: 1, scope: 1, endpoint: 1 }, { unique: true });

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencyKeySchema>;
export const IdempotencyKey: Model<IdempotencyKeyDoc> = model<IdempotencyKeyDoc>(
  'IdempotencyKey',
  idempotencyKeySchema,
);
