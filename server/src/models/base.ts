import type { SchemaOptions } from 'mongoose';

/**
 * Every collection uses a human-readable string `_id` as the primary key
 * (EMG-20481, AMB-017, HOSP-01, USR-001 …) which is exactly what the
 * frontend `id` field expects. This transform maps `_id` → `id` on
 * serialization and strips the mongoose-internal `__v`.
 */
export function toApi<T>(this: { toJSON: () => unknown }): T {
  return this.toJSON() as T;
}

export const baseSchemaOptions = {
  toJSON: {
    transform(_doc: unknown, ret: Record<string, unknown>) {
      ret.id = ret._id;
      delete ret._id;
      delete ret.__v;
      return ret;
    },
  },
  timestamps: false,
} satisfies Partial<SchemaOptions>;
