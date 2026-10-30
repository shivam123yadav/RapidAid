import { Schema, model, type InferSchemaType, type Model } from 'mongoose';

/**
 * Monotonic counters for generating readable business IDs
 * (EMG-20481, N001, A001, VR-001, USR-001) without duplicates.
 * Uses findOneAndUpdate + $inc which is atomic even under concurrency.
 */
const counterSchema = new Schema({
  _id: { type: String, required: true }, // 'emergency', 'notification', ...
  seq: { type: Number, required: true, default: 0 },
});

export type CounterDoc = InferSchemaType<typeof counterSchema>;
export const Counter: Model<CounterDoc> = model<CounterDoc>('Counter', counterSchema);

/** Atomically get the next sequence for a key and format it as PREFIX-####. */
export async function nextId(key: string, prefix: string, width = 5): Promise<string> {
  const doc = await Counter.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  ).exec();
  return `${prefix}-${String(doc!.seq).padStart(width, '0')}`;
}
