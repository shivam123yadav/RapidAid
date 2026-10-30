import { ZodError, type ZodType } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { RequestHandler } from 'express';

/**
 * Validates `req.body` against a Zod schema, replacing the body with the
 * parsed (coerced/trimmed) result. On failure throws a 400 whose message
 * lists each failing field, e.g.
 *   "email: Invalid email; password: String must contain at least 6 character(s)".
 */
export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (req, _res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const details = err.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
        next(ApiError.badRequest(details));
        return;
      }
      next(err);
    }
  };
}
