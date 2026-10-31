import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ApiError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { isTest } from '../config/env.js';

/** Uniform JSON 404 for unmatched routes (incl. all /api/* misses). */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.path}`));
};

interface ErrorBody {
  error: {
    message: string;
    code: string;
    requestId: string;
    details?: unknown;
  };
}

/**
 * Central error formatter. Every response error uses the envelope
 * { error: { message, code, requestId } } so the frontend can rely on it.
 * Unexpected errors are logged with stack trace but NEVER leak internals
 * to the client (opaque 500 INTERNAL).
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId ?? 'unknown';

  // ── Known/expected errors ────────────────────────────────────────────
  if (err instanceof ApiError) {
    res.status(err.status).json({
      error: {
        message: err.message,
        code: err.code,
        requestId,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    } satisfies ErrorBody);
    return;
  }

  // ── Mongoose validation errors → 400 ─────────────────────────────────
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => `${e.path}: ${e.message}`);
    res.status(400).json({
      error: { message: details.join('; '), code: 'VALIDATION_ERROR', requestId },
    } satisfies ErrorBody);
    return;
  }

  // ── Duplicate key (e.g. email already registered) → 409 ──────────────
  if (
    err instanceof mongoose.Error &&
    (err as unknown as { code?: number }).code === 11000
  ) {
    const keyPattern = (err as unknown as { keyPattern?: Record<string, unknown> }).keyPattern;
    const field = Object.keys(keyPattern ?? {})[0] ?? 'field';
    res.status(409).json({
      error: { message: `Duplicate value for ${field}`, code: 'DUPLICATE_KEY', requestId },
    } satisfies ErrorBody);
    return;
  }

  // ── Malformed JSON body → 400 ────────────────────────────────────────
  // ── Payload too large → 413 ──────────────────────────────────────────
  if (
    (err as { status?: number; statusCode?: number }).status === 413 ||
    (err as { status?: number; statusCode?: number }).statusCode === 413 ||
    (err as { type?: string }).type === 'entity.too.large'
  ) {
    res.status(413).json({
      error: { message: 'Payload too large', code: 'PAYLOAD_TOO_LARGE', requestId },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: { message: 'Malformed JSON in request body', code: 'INVALID_JSON', requestId },
    } satisfies ErrorBody);
    return;
  }

  // ── Anything else → opaque 500 + server-side log ─────────────────────
  const activeLogger = (req as unknown as { log?: typeof logger }).log ?? logger;
  if (!isTest || activeLogger.level !== 'silent') {
    activeLogger.error({ err, requestId, path: req.path, method: req.method }, 'unhandled error');
  }
  res.status(500).json({
    error: { message: 'Internal server error', code: 'INTERNAL', requestId },
  } satisfies ErrorBody);
};
