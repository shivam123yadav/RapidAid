import { createHash, randomBytes } from 'node:crypto';
import { EmailToken, EMAIL_TOKEN_TTL_MS, User } from '../../models/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { sendEmail } from './sender.js';
import { passwordResetEmail, verificationEmail } from './templates.js';

export type EmailTokenPurpose = 'verify' | 'reset';

const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

/**
 * Issues a single-use token and mails the action link.
 *
 * Any token previously issued for the same purpose is revoked first, so a
 * resend cannot silently invalidate a link the user already has open while
 * leaving two live ones behind.
 *
 * Returns the raw token so callers can log or return it in a response; it is
 * never persisted and never leaves this process except in the email body.
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

/** Sends (or re-sends) the address-confirmation link for a self-registered user. */
export async function sendVerificationEmail(user: {
  _id: string; name: string; email: string;
}): Promise<void> {
  await issueToken(user, 'verify');
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
