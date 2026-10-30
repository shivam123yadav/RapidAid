import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { baseSchemaOptions } from './base.js';
import { ROLES } from '../validation/constants.js';

const userSchema = new Schema(
  {
    _id: { type: String, required: true }, // USR-001
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    avatar: { type: String },
    active: { type: Boolean, default: true },
    /**
     * Whether the user has proved control of their mailbox.
     *
     * Self-registered citizens start unverified and confirm via a one-time link.
     * Accounts created by an Administrator are set verified at creation — the
     * admin vouching for the person is itself the verification — as are the
     * seeded demo users, so their existing login flow is unchanged.
     */
    emailVerified: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date },
    /**
     * Bumped whenever the password is reset or on authenticated logout. It is embedded in every
     * access token as `ver` and compared against this live value on each request, so
     * a reset or logout immediately invalidates tokens issued before it — without it, a
     * revoked access token stays usable for the remainder of its TTL.
     */
    tokenVersion: { type: Number, default: 0, min: 0 },
    /**
     * Owning facility for HOSPITAL_STAFF. This is the authoritative ownership
     * link for "own hospital" scoping — a hospital account may read and manage
     * only this facility's operational data. Optional: roles with no
     * organisational home (ADMIN, CITIZEN, …) leave it unset.
     */
    organizationId: { type: String, index: true },
    ambulanceId: { type: String, index: true },
    hospitalId: { type: String, index: true },
  },
  baseSchemaOptions,
);

export type UserDoc = InferSchemaType<typeof userSchema>;
export const User: Model<UserDoc> = model<UserDoc>('User', userSchema);
