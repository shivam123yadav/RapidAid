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
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message = 'Bad request'): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message);
  }
  static unauthorized(message = 'Authentication required'): ApiError {
    return new ApiError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to perform this action'): ApiError {
    return new ApiError(403, 'FORBIDDEN', message);
  }
  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
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
  static conflict(message = 'Conflict'): ApiError {
    return new ApiError(409, 'CONFLICT', message);
  }
  static serviceUnavailable(message = 'Service unavailable'): ApiError {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message);
  }
}
