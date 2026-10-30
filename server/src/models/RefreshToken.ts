import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { env } from '../config/env.js';

/**
 * Refresh-token records. Only a SHA-256 hash of the token is stored, so a
 * database leak does not expose usable refresh tokens. A TTL index expires
 * rows automatically after REFRESH_TOKEN_TTL_DAYS.
 */
const refreshTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

// Expire refresh tokens automatically once expiresAt passes.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenDoc = InferSchemaType<typeof refreshTokenSchema>;
export const RefreshToken: Model<RefreshTokenDoc> = model<RefreshTokenDoc>(
  'RefreshToken',
  refreshTokenSchema,
);

export const REFRESH_TOKEN_TTL_MS = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000;
