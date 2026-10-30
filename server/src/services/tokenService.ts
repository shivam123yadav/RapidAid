import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { RefreshToken, User, REFRESH_TOKEN_TTL_MS } from '../models/index.js';
import { signAccessToken, JWT_ISSUER, JWT_AUDIENCE, type AccessTokenPayload } from '../middleware/auth.js';
import { ApiError } from '../utils/errors.js';
import { effectivePermissionsFor } from '../authz/permissions.js';
import type { Role } from '../validation/constants.js';

const BCRYPT_ROUNDS = 10;
const REFRESH_COOKIE = 'rapidaid_rt';

/**
 * Precomputed, valid bcrypt hash (10 rounds) used to perform dummy password
 * verification for nonexistent accounts, mitigating response timing attacks.
 */
export const DUMMY_PASSWORD_HASH = '$2a$10$IEtJJC7bqRD3CdSwZLVnAeag5LAIzzBgJGliFxrVdWeIdw0MVBwNO';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  avatar?: string;
  hospitalId?: string | null;
  ambulanceId?: string | null;
  organizationId?: string | null;
  /**
   * Whether the user has confirmed their mailbox. Unverified users may still
   * sign in; the client surfaces a reminder banner rather than blocking access.
   */
  emailVerified: boolean;
  /**
   * The effective permission set for `role`, emitted straight from the central
   * RBAC registry (`authz/permissions.ts`). The client renders navigation and
   * buttons from this list instead of keeping a second, drift-prone copy of
   * the matrix — the server remains the enforcement authority either way.
   */
  permissions: string[];
}

export async function toPublicUser(user: { _id: string; name: string; email: string; role: Role; avatar?: string | null; hospitalId?: string | null; ambulanceId?: string | null; organizationId?: string | null; emailVerified?: boolean }): Promise<PublicUser> {
  const pub: PublicUser = {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: [...(await effectivePermissionsFor(user.role))],
    // Absent means a legacy row written before verification existed; treat those
    // as verified so no existing account is locked out of its own session.
    emailVerified: user.emailVerified ?? true,
  };
  if (user.avatar) pub.avatar = user.avatar;
  if (user.hospitalId) pub.hospitalId = user.hospitalId;
  if (user.ambulanceId) pub.ambulanceId = user.ambulanceId;
  if (user.organizationId) pub.organizationId = user.organizationId;
  return pub;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string; // raw value — only ever sent to the client as an httpOnly cookie
}

/** Issues a short-lived access JWT + a rotating refresh token persisted as a hash. */
export async function issueTokens(payload: AccessTokenPayload): Promise<IssuedTokens> {
  const accessToken = signAccessToken(payload);
  const refreshToken = randomBytes(48).toString('hex');
  await RefreshToken.create({
    tokenHash: sha256(refreshToken),
    userId: payload.sub,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
  });
  return { accessToken, refreshToken };
}

/**
 * Consumes a refresh token: validates hash+expiry+user, deletes it
 * (one-time use — replay of a stolen token fails after first use),
 * and issues a fresh token pair.
 */
export async function rotateRefreshToken(rawToken: string): Promise<IssuedTokens> {
  const record = await RefreshToken.findOneAndDelete({ tokenHash: sha256(rawToken) }).lean();
  if (!record || record.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized('Refresh token is invalid or expired');
  }
  const user = await User.findById(record.userId).lean();
  if (!user || user.active === false) {
    throw ApiError.unauthorized('User no longer exists or is deactivated');
  }
  return issueTokens({ sub: user._id, role: user.role, name: user.name, email: user.email, ver: user.tokenVersion ?? 0 });
}

/** Best-effort server-side revocation of the presented refresh token. */
export async function revokeRefreshToken(rawToken: string | undefined): Promise<void> {
  if (!rawToken) return;
  await RefreshToken.deleteOne({ tokenHash: sha256(rawToken) }).exec();
}

/**
 * Invalidates an access-token session on authenticated logout by incrementing
 * the user's `tokenVersion`.
 *
 * Security requirements:
 * 1. Never trusts unverified claims: rigorously verifies signature (HS256),
 *    expiry, issuer (`rapidaid-api`), audience (`rapidaid-client`), and subject.
 * 2. Validates that the subject user exists in the database, is active, and matches
 *    the current `tokenVersion`.
 * 3. Safely handles missing, malformed, invalid, or expired tokens as no-ops without
 *    allowing unauthorized user-state changes or throwing exceptions.
 */
export async function invalidateAccessToken(
  bearerHeader: string | undefined,
): Promise<{ userId: string; name: string; role: Role } | null> {
  if (!bearerHeader || !bearerHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = bearerHeader.slice(7).trim();
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload & AccessTokenPayload;

    if (!decoded || !decoded.sub) return null;

    const user = await User.findById(decoded.sub);
    if (!user || user.active === false) return null;

    const currentVersion = user.tokenVersion ?? 0;
    if ((decoded.ver ?? 0) !== currentVersion) {
      return null;
    }

    await User.findByIdAndUpdate(user._id, { $inc: { tokenVersion: 1 } });
    return { userId: user._id, name: user.name, role: user.role as Role };
  } catch {
    return null;
  }
}

export function setRefreshCookie(res: import('express').Response, token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: env.COOKIE_SAME_SITE,
    secure: env.NODE_ENV === 'production' || env.COOKIE_SAME_SITE === 'none',
    path: '/api/auth',
    maxAge: REFRESH_TOKEN_TTL_MS,
  });
}

export function clearRefreshCookie(res: import('express').Response): void {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth', httpOnly: true, sameSite: env.COOKIE_SAME_SITE, secure: env.NODE_ENV === 'production' || env.COOKIE_SAME_SITE === 'none' });
}

export function getRefreshCookie(req: import('express').Request): string | undefined {
  const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies;
  return cookies?.[REFRESH_COOKIE];
}

/** Correlation id embedded in audit logs for every mutating auth action. */
export function newRequestId(): string {
  return randomUUID();
}

export { jwt };
