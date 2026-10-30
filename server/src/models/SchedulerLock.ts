import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';

const schedulerLockSchema = new Schema(
  {
    _id: { type: String, required: true }, // e.g. 'ambulance_reconciliation'
    owner: { type: String, required: true }, // unique token: `${processId}:${uuid}`
    fenceToken: { type: Number, required: true, default: 0 },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true },
    renewedAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);

export type SchedulerLockDoc = InferSchemaType<typeof schedulerLockSchema>;
export const SchedulerLock: Model<SchedulerLockDoc> = model<SchedulerLockDoc>(
  'SchedulerLock',
  schedulerLockSchema,
);
