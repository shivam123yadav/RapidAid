import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { User } from '../models/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { recordAudit } from '../services/auditService.js';
import { effectivePermissionsFor, canIn, type Permission } from '../authz/permissions.js';
import type { Role } from '../validation/constants.js';

/**
 * `alg` is pinned to HS256 on both sign and verify, so a token presenting any
 * other algorithm (including `none`) is rejected outright. `iss`/`aud` bind the
 * token to this API, so a token minted by another service that happens to share
 * the signing secret is not accepted here.
 */
export const JWT_ISSUER = 'rapidaid-api';
export const JWT_AUDIENCE = 'rapidaid-client';

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  name: string;
  email: string;
  /**
   * Bumped on password reset. `authenticate` compares it against the live user
   * document, which retires every outstanding access token for that account
   * immediately instead of leaving them usable for the rest of their TTL.
   */
  ver: number;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

/**
 * Verifies the `Authorization: Bearer <jwt>` header and attaches the
 * identity to req.auth. Throws 401 on missing/invalid/expired tokens.
 */
export const authenticate: RequestHandler = asyncHandler(async (req, _res, next) => {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    throw ApiError.unauthorized('Missing bearer token');
  }
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload & AccessTokenPayload;
    const user = await User.findById(decoded.sub).lean();
    if (!user || user.active === false) {
      throw ApiError.unauthorized('User no longer exists or is deactivated');
    }
    // A password reset bumps `tokenVersion`, which retires every access token
    // minted before it. Checking the live document (rather than trusting a
    // claim) is what makes revocation effective on the very next request.
    const currentVersion = user.tokenVersion ?? 0;
    if ((decoded.ver ?? 0) !== currentVersion) {
      throw ApiError.unauthorized('Session is no longer valid; please sign in again');
    }
    // hospitalId rides along in the auth context (not the JWT) so ownership
    // checks always read current DB state, never a stale token claim.
    req.auth = {
      userId: user._id,
      role: user.role,
      name: user.name,
      email: user.email,
      // `hospitalId` is optional on the schema, so mongoose types it as
      // `string | null | undefined`; normalise null away for the auth context.
      hospitalId: user.hospitalId ?? undefined,
      organizationId: user.organizationId ?? undefined,
      ambulanceId: user.ambulanceId ?? undefined,
      permissions: await effectivePermissionsFor(user.role),
    };
    next();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw ApiError.unauthorized('Invalid or expired token');
  }
});

/**
 * Role-based access control. Must run after `authenticate`.
 * Throws 403 when the caller's role is not in the allowlist.
 *
 * Retained for coarse checks (e.g. admin-only routes) and as the enforcement
 * primitive behind {@link requirePermission}. New code should prefer
 * permissions so the matrix lives in one place.
 */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(ApiError.unauthorized('Missing bearer token'));
      return;
    }
    if (!roles.includes(req.auth.role as Role)) {
      next(
        ApiError.forbidden(
          `Role '${req.auth.role}' is not permitted; requires one of: ${roles.join(', ')}`,
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Permission-based access control. Must run after `authenticate`.
 *
 * A caller is authorized when they hold *any* of the listed permissions, so a
 * route can accept several alternatives (`requirePermission(AMBULANCE_VIEW,
 * AMBULANCE_VIEW_OWN)`) without duplicating the handler. Denials are audited
 * as `permission.denied` with the attempted permission, route, actor and
 * request id — this is the trail behind "who tried to do what and failed".
 */
export function requirePermission(...permissions: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      next(ApiError.unauthorized('Missing bearer token'));
      return;
    }
    // `permissions.some` widens the element type to `string`; `can()` needs the
    // union, so assert at the single boundary where the tuple is declared.
    if (permissions.some((permission) => canIn(req.auth!.permissions ?? [], permission))) {
      next();
      return;
    }

    // Audit asynchronously — a logging failure must not mask the 403.
    void recordAudit({
      actor: req.auth.name,
      actorId: req.auth.userId,
      actorRole: req.auth.role,
      action: 'permission.denied',
      resource: 'Route',
      resourceId: `${req.method} ${req.originalUrl}`,
      requestId: req.requestId,
      details: `role=${req.auth.role} requires=${permissions.join('|')}`,
      result: 'FAILURE',
      ip: req.ip,
    });

    next(
      ApiError.forbidden(
        `Your role '${req.auth.role}' does not permit this action`,
      ),
    );
  };
}
