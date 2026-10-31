import { Router, type Request } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { authLimiter, resendVerificationLimiter } from '../middleware/rateLimit.js';
import { User, Counter } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { recordAudit } from '../services/auditService.js';
import {
  clearRefreshCookie,
  getRefreshCookie,
  hashPassword,
  issueTokens,
  toPublicUser,
  verifyPassword,
  setRefreshCookie,
  rotateRefreshToken,
  revokeRefreshToken,
  invalidateAccessToken,
  DUMMY_PASSWORD_HASH,
} from '../services/tokenService.js';
import { loginSchema, registerSchema, verifyEmailSchema, forgotPasswordSchema, resetPasswordSchema } from '../validation/schemas.js';
import { RefreshToken } from '../models/index.js';
import { sendVerificationEmail, resendVerificationEmail, sendPasswordResetEmail, consumeToken, markEmailVerified } from '../services/email/emailService.js';
import type { Role } from '../validation/constants.js';

export const authRouter = Router();

/**
 * Records a rejected sign-in attempt.
 *
 * Without this the audit trail only ever contains successful logins, so
 * credential stuffing against a known account leaves no evidence at all. The
 * outcome is best-effort — a logging failure must not mask the 401 — and
 * the email is recorded because the actor is otherwise unknown.
 *
 * `actorRole` falls back to the *attempted* role: for an unknown account there
 * is no real role to attribute, and the row is still a valid enum member.
 */
function recordLoginFailure(
  req: Request,
  email: string,
  reason: 'unknown-account' | 'inactive-account' | 'role-mismatch' | 'bad-password',
  user?: { _id: string; name: string; role: Role },
): Promise<void> {
  return recordAudit({
    actor: user?.name ?? email,
    actorId: user?._id,
    actorRole: (user?.role ?? 'CITIZEN') as never,
    action: 'auth.login_failed',
    resource: 'User',
    resourceId: user?._id ?? email,
    requestId: req.requestId,
    details: reason,
    result: 'FAILURE',
    ip: req.ip,
    userAgent: req.header('user-agent'),
  });
}

/**
 * POST /api/auth/login
 * Body: { email, password, role } — the selected role must match the
 * account's role (defends against credential stuffing across personas).
 * Sets an httpOnly refresh cookie; returns { user, accessToken }.
 *
 * Anti-enumeration posture:
 * All failures (missing account, inactive account, bad password, role mismatch)
 * return the identical HTTP 401 { error: { message: 'Invalid credentials', code: 'UNAUTHORIZED' } }.
 * Nonexistent accounts perform dummy bcrypt verification to resist timing attacks.
 * Internal failure categories are preserved in server-side audit logs.
 */
authRouter.post(
  '/login',
  authLimiter,
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password, role } = req.body;

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user) {
      await verifyPassword(password, DUMMY_PASSWORD_HASH);
      await recordLoginFailure(req, email, 'unknown-account');
      throw ApiError.unauthorized('Invalid credentials');
    }

    const passwordMatches = await verifyPassword(password, user.passwordHash);
    if (!passwordMatches) {
      await recordLoginFailure(req, email, 'bad-password', user);
      throw ApiError.unauthorized('Invalid credentials');
    }

    if (user.active === false) {
      await recordLoginFailure(req, email, 'inactive-account', user);
      throw ApiError.unauthorized('Invalid credentials');
    }

    if (user.role !== role) {
      await recordLoginFailure(req, email, 'role-mismatch', user);
      throw ApiError.unauthorized('Invalid credentials');
    }

    const tokens = await issueTokens({ sub: user._id, role: user.role, name: user.name, email: user.email, ver: user.tokenVersion ?? 0 });
    setRefreshCookie(res, tokens.refreshToken);

    await recordAudit({
      actor: user.name,
      actorRole: user.role,
      action: 'auth.login',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
    });

    res.json({ user: await toPublicUser(user), accessToken: tokens.accessToken });
  }),
);

/**
 * POST /api/auth/register â€” creates an account and starts a session.
 * The seeded demo users cover the operational roles; registration is
 * primarily for CITIZEN accounts (self-service reporting).
 */
authRouter.post(
  '/register',
  authLimiter,
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const { name, email, password, role, avatar } = req.body;

    const existing = await User.findOne({ email }).lean();
    if (existing) throw ApiError.conflict('An account with this email already exists');

    const counter = await Counter.findOneAndUpdate(
      { _id: 'user' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    ).exec();
    const _id = `USR-${String(counter!.seq).padStart(3, '0')}`;

    const user = await User.create({
      _id,
      name,
      email,
      role,
      ...(avatar ? { avatar } : {}),
      passwordHash: await hashPassword(password),
      active: true,
      // Self-registered accounts must prove control of the mailbox. Admin-created
      // accounts are marked verified in admin.routes.ts instead.
      emailVerified: false,
    });

    // Best-effort: a delivery failure must not fail the signup, and the user can
    // request a new link from the app.
    const delivery = await sendVerificationEmail({ _id: user._id, name: user.name, email: user.email });

    const tokens = await issueTokens({ sub: user._id, role: user.role, name: user.name, email: user.email, ver: user.tokenVersion ?? 0 });
    setRefreshCookie(res, tokens.refreshToken);

    await recordAudit({
      actor: user.name,
      actorRole: user.role,
      action: 'auth.register',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
      details: `Registered as ${role}`,
    });

    res.status(201).json({
      user: await toPublicUser(user),
      accessToken: tokens.accessToken,
      emailDelivery: delivery.delivered ? 'sent' : 'failed',
    });
  }),
);

/**
 * POST /api/auth/refresh â€” rotates the refresh token (one-time use)
 * and returns a fresh access token. Requires the httpOnly cookie.
 */
authRouter.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const raw = getRefreshCookie(req);
    if (!raw) throw ApiError.unauthorized('No refresh token present');
    const tokens = await rotateRefreshToken(raw);
    setRefreshCookie(res, tokens.refreshToken);
    res.json({ accessToken: tokens.accessToken });
  }),
);

/**
 * POST /api/auth/logout — revokes the refresh token server-side, invalidates
 * the presented access token session (via tokenVersion bump), and clears the cookie.
 * Safe to call repeatedly and supports both authenticated and unauthenticated callers.
 */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const invalidatedUser = await invalidateAccessToken(req.header('authorization'));
    await revokeRefreshToken(getRefreshCookie(req));
    clearRefreshCookie(res);

    if (invalidatedUser) {
      await recordAudit({
        actor: invalidatedUser.name,
        actorId: invalidatedUser.userId,
        actorRole: invalidatedUser.role,
        action: 'auth.logout',
        resource: 'User',
        resourceId: invalidatedUser.userId,
        requestId: req.requestId,
        details: 'Access token session invalidated via tokenVersion bump',
      });
    }

    res.json({ success: true });
  }),
);

/** GET /api/auth/me â€” current identity (requires valid access token). */
authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.auth!.userId).lean();
    if (!user) throw ApiError.unauthorized('User no longer exists');
    res.json(await toPublicUser(user));
  }),
);

/**
 * PATCH /api/auth/me â€” update the caller's own profile (name/avatar only;
 * role and email are immutable to prevent privilege escalation).
 */
const updateMeSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  avatar: z.string().url().nullable().optional(),
});

authRouter.patch(
  '/me',
  authenticate,
  validateBody(updateMeSchema),
  asyncHandler(async (req, res) => {
    const updates: Record<string, unknown> = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.avatar !== undefined) updates.avatar = req.body.avatar;
    if (Object.keys(updates).length === 0) throw ApiError.badRequest('No updatable fields supplied');

    const user = await User.findByIdAndUpdate(req.auth!.userId, updates, { new: true }).lean();
    if (!user) throw ApiError.unauthorized('User no longer exists');

    await recordAudit({
      actor: user.name,
      actorRole: user.role,
      action: 'auth.profile_updated',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
      details: Object.keys(updates).join(', '),
    });

    res.json(await toPublicUser(user));
  }),
);

/**
 * POST /api/auth/verify-email — Body: { token }
 * Consumes a one-time confirmation link. Unknown, expired and already-used
 * tokens all return the same neutral response, so the endpoint cannot be used
 * to discover which token values are real.
 */
authRouter.post(
  '/verify-email',
  authLimiter,
  validateBody(verifyEmailSchema),
  asyncHandler(async (req, res) => {
    const user = await consumeToken(req.body.token, 'verify');
    if (!user) {
      await recordAudit({
        actor: 'anonymous',
        actorRole: 'CITIZEN',
        action: 'auth.email_verification',
        resource: 'User',
        resourceId: 'unknown',
        requestId: req.requestId,
        result: 'FAILURE',
        details: 'Invalid or expired verification token',
      });
      throw ApiError.badRequest('This verification link is invalid or has expired');
    }

    await markEmailVerified(user._id);

    await recordAudit({
      actor: user.name,
      actorId: user._id,
      actorRole: user.role as never,
      action: 'auth.email_verified',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
    });

    res.json({ success: true, emailVerified: true });
  }),
);

/**
 * POST /api/auth/resend-verification
 * Authenticated endpoint to re-issue and send a fresh email verification link.
 * Enforces:
 *  - Authentication required.
 *  - Only permits resending when emailVerified is false (400 if already verified).
 *  - Issues a fresh token and invalidates any prior verification token.
 *  - Applies rate limiting and 60-second cooldown to guard against abuse.
 *  - Generic response envelope that avoids account enumeration/leakage.
 */
authRouter.post(
  '/resend-verification',
  authenticate,
  resendVerificationLimiter,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.auth!.userId);
    if (!user) throw ApiError.unauthorized('User no longer exists');

    if (user.emailVerified) {
      throw ApiError.badRequest('Email is already verified');
    }

    const result = await resendVerificationEmail(user);

    await recordAudit({
      actor: user.name,
      actorId: user._id,
      actorRole: user.role as never,
      action: 'auth.verification_email_resent',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
    });

    res.json({ success: true, message: result.message, delivered: result.delivered });
  }),
);

/**
 * POST /api/auth/forgot-password — Body: { email }
 * Always answers 200 with the same body. A response that differed for existing
 * versus unknown addresses would turn this endpoint into an account-enumeration
 * oracle, so the mail is sent quietly only when the account actually exists.
 */
authRouter.post(
  '/forgot-password',
  authLimiter,
  validateBody(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    const user = await User.findOne({ email, active: { $ne: false } }).lean();

    if (user) {
      await sendPasswordResetEmail({ _id: user._id, name: user.name, email: user.email });
    }

    // Audit records the attempt, not the outcome, so the log cannot be used to
    // infer which addresses have accounts.
    await recordAudit({
      actor: 'anonymous',
      actorRole: 'CITIZEN',
      action: 'auth.password_reset_requested',
      resource: 'User',
      resourceId: user?._id ?? 'unknown',
      requestId: req.requestId,
      details: user ? 'Reset link dispatched' : 'No account for address',
    });

    res.json({
      success: true,
      message: 'If an account exists for that address, a reset link is on its way.',
    });
  }),
);

/**
 * POST /api/auth/reset-password — Body: { token, password }
 * Consumes a reset link, stores the new hash, and revokes every existing
 * refresh session so that a token captured before the reset cannot be reused.
 */
authRouter.post(
  '/reset-password',
  authLimiter,
  validateBody(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const { token, password } = req.body;

    const user = await consumeToken(token, 'reset');
    if (!user) throw ApiError.badRequest('This reset link is invalid or has expired');

    // Bumping `tokenVersion` retires every access token already issued to this
    // account, so a stolen token dies here rather than lingering for its TTL.
    await User.findByIdAndUpdate(user._id, {
      passwordHash: await hashPassword(password),
      $inc: { tokenVersion: 1 },
    });

    // Session-hijack containment: a reset usually means the old credential may
    // have been exposed, so every issued session is dropped.
    const revoked = await RefreshToken.deleteMany({ userId: user._id });

    await recordAudit({
      actor: user.name,
      actorId: user._id,
      actorRole: user.role as never,
      action: 'auth.password_reset',
      resource: 'User',
      resourceId: user._id,
      requestId: req.requestId,
      details: `Revoked ${revoked.deletedCount ?? 0} active session(s)`,
    });

    res.json({ success: true });
  }),
);

// Admin-only user administration lives under /api/admin (see admin.routes.ts).
export { requireRole };

