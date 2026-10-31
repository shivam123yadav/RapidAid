/**
 * Typed operational error. Every error that reaches the error-handler
 * middleware as an ApiError is rendered as-is (status + stable code);
 * anything else is logged and rendered as an opaque 500 so internals
 * never leak to clients.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', details?: unknown): ApiError {
    return new ApiError(400, code, message, details);
  }
  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED', details?: unknown): ApiError {
    return new ApiError(401, code, message, details);
  }
  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN', details?: unknown): ApiError {
    return new ApiError(403, code, message, details);
  }
  static notFound(message = 'Resource not found', code = 'NOT_FOUND', details?: unknown): ApiError {
    return new ApiError(404, code, message, details);
  }
  /**
   * The report says a recording exists, but the stored object is gone.
   *
   * 410 (Gone) with a stable code rather than a generic 404, because this is
   * materially different from "no recording was ever made": the audio was
   * captured and referenced, and the artefact behind that reference is missing.
   * The UI needs to say exactly that instead of implying the user failed to
   * record anything.
   */
  static audioObjectMissing(message = 'The stored recording is no longer available'): ApiError {
    return new ApiError(410, 'AUDIO_OBJECT_MISSING', message);
  }
  /** The report carries no audio reference at all (never recorded). */
  static audioNotRecorded(message = 'This report has no stored recording'): ApiError {
    return new ApiError(404, 'AUDIO_NOT_RECORDED', message);
  }
  static conflict(message = 'Conflict', code = 'CONFLICT', details?: unknown): ApiError {
    return new ApiError(409, code, message, details);
  }
  static tooManyRequests(message = 'Too many requests, please try again later', code = 'RATE_LIMITED', details?: unknown): ApiError {
    return new ApiError(429, code, message, details);
  }
  static serviceUnavailable(message = 'Service unavailable', code = 'SERVICE_UNAVAILABLE', details?: unknown): ApiError {
    return new ApiError(503, code, message, details);
  }
}

