import { createHash, randomBytes } from 'node:crypto';
import { EmailToken, EMAIL_TOKEN_TTL_MS, User } from '../../models/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { ApiError } from '../../utils/errors.js';
import { sendEmail } from './sender.js';
import { passwordResetEmail, verificationEmail } from './templates.js';

export type EmailTokenPurpose = 'verify' | 'reset';

export const RESEND_COOLDOWN_MS = 60 * 1000;

/** Set of user IDs with an in-flight resend request to prevent concurrent race conditions. */
const inFlightResends = new Set<string>();

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Issues a single-use token and mails the action link.
 *
 * Any token previously issued for the same purpose is revoked first, so a
 * resend cannot silently invalidate a link the user already has open while
 * leaving two live ones behind.
 *
 * The raw token is never logged, never returned in an HTTP response body, and
 * never persisted — only its SHA-256 hash is stored in MongoDB. The only
 * channel through which the raw token leaves this process is the email body.
 */
async function issueToken(
  user: { _id: string; name: string; email: string },
  purpose: EmailTokenPurpose,
): Promise<{ token: string; expiresAt: Date }> {
  await EmailToken.deleteMany({ userId: user._id, purpose });

  const token = randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + EMAIL_TOKEN_TTL_MS);
  await EmailToken.create({ tokenHash: sha256(token), userId: user._id, purpose, expiresAt });

  const url =
    purpose === 'verify'
      ? `${env.PUBLIC_URL}/verify-email?token=${token}`
      : `${env.PUBLIC_URL}/reset-password?token=${token}`;

  const content = purpose === 'verify'
    ? verificationEmail(user.name, url)
    : passwordResetEmail(user.name, url);

  // Best-effort: the token is already stored, so a failed send only means the
  // user must request another. Delivery is retried with backoff inside sendEmail.
  const result = await sendEmail(
    { to: user.email, subject: content.subject, text: content.text, html: content.html },
    { purpose: `email.${purpose}`, userId: user._id },
  );

  if (!result.delivered) {
    logger.error({ userId: user._id, purpose }, 'token issued but email delivery failed');
  }

  return { token, expiresAt };
}

/** Sends the address-confirmation link for a newly registered user. */
export async function sendVerificationEmail(user: {
  _id: string; name: string; email: string;
}): Promise<void> {
  await issueToken(user, 'verify');
}

/**
 * Re-issues and sends an address-confirmation link with cooldown & verification checks.
 *
 * Rejects already verified accounts with a 400.
 * Rejects rapid-fire requests within RESEND_COOLDOWN_MS with a 429.
 * Invalidates any previous verification token by deleting it inside issueToken.
 */
export async function resendVerificationEmail(user: {
  _id: string;
  name: string;
  email: string;
  emailVerified?: boolean;
}): Promise<{ success: boolean; message: string }> {
  if (user.emailVerified) {
    throw ApiError.badRequest('Email is already verified');
  }

  if (inFlightResends.has(user._id)) {
    throw ApiError.tooManyRequests(
      'Please wait before requesting another verification email',
    );
  }
  inFlightResends.add(user._id);

  try {
    const recentToken = await EmailToken.findOne({ userId: user._id, purpose: 'verify' })
      .sort({ createdAt: -1 })
      .lean();

    if (recentToken) {
      const elapsedMs = Date.now() - new Date(recentToken.createdAt).getTime();
      if (elapsedMs < RESEND_COOLDOWN_MS) {
        const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - elapsedMs) / 1000);
        throw ApiError.tooManyRequests(
          `Please wait ${retryAfterSec}s before requesting another verification email`,
        );
      }
    }

    await issueToken(user, 'verify');
    return { success: true, message: 'Verification email sent' };
  } finally {
    inFlightResends.delete(user._id);
  }
}

/** Sends a password-reset link. The caller decides whether the account exists. */
export async function sendPasswordResetEmail(user: {
  _id: string; name: string; email: string;
}): Promise<void> {
  await issueToken(user, 'reset');
}

/**
 * Consumes a token, returning the linked user, or null when the token is
 * unknown, expired, or issued for a different purpose.
 *
 * The record is deleted on lookup so a link is strictly single-use, and so a
 * replayed link is rejected even before the TTL would have expired it.
 */
export async function consumeToken(
  token: string,
  purpose: EmailTokenPurpose,
): Promise<{ _id: string; name: string; email: string; role: string } | null> {
  if (!token) return null;

  const record = await EmailToken.findOneAndDelete({
    tokenHash: sha256(token),
    purpose,
  }).lean();

  if (!record || record.expiresAt.getTime() < Date.now()) return null;

  const user = await User.findById(record.userId).lean();
  return user ? { _id: user._id, name: user.name, email: user.email, role: user.role } : null;
}

/** Marks the address confirmed. Idempotent — a second confirmation is harmless. */
export async function markEmailVerified(userId: string): Promise<void> {
  await User.findByIdAndUpdate(userId, { emailVerified: true, emailVerifiedAt: new Date() });
}
