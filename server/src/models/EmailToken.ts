import { Schema, model, type InferSchemaType, type Model } from 'mongoose';
import { env } from '../config/env.js';

/**
 * Single-use tokens for email verification and password reset.
 *
 * Only a SHA-256 hash is stored, so a database leak does not expose usable
 * links — the same protection RefreshToken applies to session cookies. A TTL
 * index removes rows after EMAIL_TOKEN_TTL_HOURS, and the raw value is returned
 * to the caller exactly once, at creation time, to be emailed.
 *
 * Both purposes share one collection, discriminated by `purpose`, so a reset
 * link can never be replayed as a verification link.
 */
const emailTokenSchema = new Schema({
  tokenHash: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  purpose: { type: String, enum: ['verify', 'reset'], required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, required: true, default: () => new Date() },
});

emailTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type EmailTokenDoc = InferSchemaType<typeof emailTokenSchema>;
export const EmailToken: Model<EmailTokenDoc> = model<EmailTokenDoc>(
  'EmailToken',
  emailTokenSchema,
);

export const EMAIL_TOKEN_TTL_MS = env.EMAIL_TOKEN_TTL_HOURS * 60 * 60 * 1000;
