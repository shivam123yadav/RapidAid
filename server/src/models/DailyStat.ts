import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * One document per calendar day holding operational metrics. Analytics
 * reads these plus live aggregations over Emergency/Hospital/Ambulance.
 * `_id` is the date string (YYYY-MM-DD) for natural idempotent upserts.
 */
const dailyStatSchema = new Schema({
  _id: { type: String, required: true }, // 2026-01-15
  emergencyCount: { type: Number, required: true, default: 0 },
  medianResponseSeconds: { type: Number, required: true, default: 0 },
  p90ResponseSeconds: { type: Number, required: true, default: 0 },
  ambulanceUtilizationPct: { type: Number, required: true, default: 0 },
});

export type DailyStatDoc = InferSchemaType<typeof dailyStatSchema>;
export const DailyStat: Model<DailyStatDoc> = model<DailyStatDoc>('DailyStat', dailyStatSchema);
