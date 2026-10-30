import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { ApiError } from '../utils/errors.js';

const WEAK_TOKEN_SUBSTRINGS = [
  'changeme',
  'secret',
  'password',
  '1234567890123456',
  'change-me',
  'placeholder',
  'admin',
  'root',
  'testtoken',
];

/**
 * Validates whether a metrics scrape token meets minimum security requirements.
 * Requires a string of at least 16 characters, rejects placeholders, empty values,
 * and low-entropy strings.
 */
export function isStrongScraperToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const trimmed = token.trim();
  if (trimmed.length < 16) return false;
  const lower = trimmed.toLowerCase();
  if (WEAK_TOKEN_SUBSTRINGS.some((weak) => lower.includes(weak))) {
    return false;
  }
  const uniqueChars = new Set(trimmed);
  if (uniqueChars.size < 4) {
    return false;
  }
  return true;
}

/**
 * Constant-time comparison of two string tokens using SHA-256 digests
 * and timingSafeEqual to prevent timing side-channels.
 */
export function constantTimeTokenCompare(provided: string, expected: string): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  if (!provided || !expected) {
    return false;
  }
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  const hashExpected = crypto.createHash('sha256').update(expected).digest();
  const hashesMatch = crypto.timingSafeEqual(hashProvided, hashExpected);
  return hashesMatch && provided.length === expected.length;
}

/**
 * Express middleware protecting the scraper endpoint.
 * Validates bearer token in constant time, fails closed if misconfigured,
 * and sets WWW-Authenticate header on failure without logging credentials.
 */
export function createScraperAuthMiddleware(
  tokenOrGetter: string | undefined | (() => string | undefined),
): RequestHandler {
  return (req, res, next) => {
    const expectedToken = typeof tokenOrGetter === 'function' ? tokenOrGetter() : tokenOrGetter;

    // 1. Fail closed if the scraper token is missing or weakly configured
    if (!isStrongScraperToken(expectedToken)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      next(ApiError.unauthorized('Authentication required'));
      return;
    }

    // 2. Extract Authorization header
    const authHeader = req.header('authorization');
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      next(ApiError.unauthorized('Authentication required'));
      return;
    }

    // 3. Extract Bearer token
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (!match || !match[1]) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      next(ApiError.unauthorized('Authentication required'));
      return;
    }

    const providedToken = match[1];

    // 4. Constant-time token comparison
    if (!constantTimeTokenCompare(providedToken, expectedToken!)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="metrics"');
      next(ApiError.unauthorized('Authentication required'));
      return;
    }

    // Success: continue without logging the token
    next();
  };
}
