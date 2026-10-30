import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { ROLES } from '../validation/constants.js';

/**
 * Persisted administrator-controlled policy. The static defaults live in
 * authz/policy.ts; this document stores the effective override set for a role
 * and is versioned for optimistic concurrency. Only the administrator policy
 * route may write it.
 */
const rolePolicySchema = new Schema(
  {
    _id: { type: String, required: true }, // role name, e.g. DISPATCHER
    role: { type: String, enum: ROLES, required: true, unique: true, index: true },
    permissions: { type: [String], required: true, default: [] },
    revision: { type: Number, required: true, default: 1, min: 1 },
    updatedBy: { type: String, required: true },
    updatedAt: { type: Date, required: true },
  },
  baseSchemaOptions,
);

export type RolePolicyDoc = InferSchemaType<typeof rolePolicySchema>;
export const RolePolicy: Model<RolePolicyDoc> = model<RolePolicyDoc>('RolePolicy', rolePolicySchema);
