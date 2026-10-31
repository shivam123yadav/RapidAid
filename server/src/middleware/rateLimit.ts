import { rateLimit, type Options } from 'express-rate-limit';
import { env, isTest } from '../config/env.js';

/**
 * RapidAid V2 — Rate Limiting Architecture & Store Policy
 *
 * Current deployment model: Single-process per host using express-rate-limit's
 * built-in in-memory store (MemoryStore).
 *
 * ARCHITECTURAL PROPERTIES & LIMITATIONS:
 * 1. Process-local storage: Hits are tracked in an in-memory Map in the Node.js
 *    process. Hit counters reset to 0 whenever the process restarts or restarts
 *    inside a Docker container.
 * 2. Multi-replica behavior: When scaled horizontally behind a round-robin load
 *    balancer across N backend replicas, each instance maintains an independent
 *    in-memory bucket. Effective throughput per client scales to N * limit.
 * 3. Shared-store extensibility: The `createRateLimiter` factory accepts an
 *    optional `store` implementing express-rate-limit's Store interface (e.g.
 *    RedisStore from rate-limit-redis or a custom Redis/Valkey client).
 * 4. Outage behavior caveat: A local memory fallback during a shared-store
 *    (Redis) outage does NOT provide a globally shared limit; it provides
 *    independent per-replica protection. Silently failing open during store
 *    outages would weaken brute-force defense on auth and DoS protection on
 *    emergency uploads.
 */

const disabled = isTest || env.RATE_LIMIT_DISABLED;

/** Standard envelope-matching 429 handler shared by all limiters. */
export const rateLimitHandler: Options['handler'] = (req, res) => {
  res.status(429).json({
    error: {
      message: 'Too many requests, please try again later',
      code: 'RATE_LIMITED',
      requestId: req.requestId ?? 'unknown',
    },
  });
};

/** General API limiter: 300 req / 15 min / IP. */
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  handler: rateLimitHandler,
});

/** Stricter limiter for auth endpoints: 20 req / 15 min / IP (brute-force guard). */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  handler: rateLimitHandler,
});

/**
 * Emergency incident report creation: 30 req / 15 min / IP (or user).
 *
 * Emergency reports accept large bodies (up to 16 MB with base64 attachments).
 * Restricting creation rate guards memory buffers, disk storage, and worker queues
 * from denial-of-service abuse or flooding. Keyed on the authenticated user where
 * present, falling back to IP.
 */
export const emergencyReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  keyGenerator: (req) => (req as { auth?: { userId?: string } }).auth?.userId ?? req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

/**
 * Voice recording upload: 20 req / 15 min / IP.
 *
 * Each accepted request writes real audio to disk and runs the transcription
 * pipeline, and the body limit is 8 MB — so 300 requests in the general window
 * is 2.4 GB of writes plus 300 pipeline invocations from one address. Keyed on
 * the authenticated user where one is present so a shared NAT egress (a hospital
 * or campus) does not starve its own staff, falling back to the IP otherwise.
 */
export const voiceUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  keyGenerator: (req) => (req as { auth?: { userId?: string } }).auth?.userId ?? req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

/** CSP violation report ingestion limiter: 100 req / 15 min / IP. */
export const cspReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  handler: rateLimitHandler,
});

/** Resend verification email limiter: 5 req / 15 min / user (falling back to IP). */
export const resendVerificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => disabled,
  keyGenerator: (req) => (req as { auth?: { userId?: string } }).auth?.userId ?? req.ip ?? 'unknown',
  handler: rateLimitHandler,
});

/**
 * Factory helper for testing rate limiters or defining custom route limiters
 * without mutating global environment state.
 */
export function createRateLimiter(options?: Partial<Options>) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => disabled,
    handler: rateLimitHandler,
    ...options,
  });
}
