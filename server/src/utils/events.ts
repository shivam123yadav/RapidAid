import { logger } from '../config/logger.js';

/**
 * Structured application events for the voice-emergency pipeline.
 *
 * These are log-only observability hooks (one line per meaningful step), kept
 * separate from the immutable `AuditLog` trail, which records who-did-what for
 * compliance. Nothing here ever carries raw audio bytes, credentials or
 * patient identity — only ids, counts, types and outcomes.
 */
export const VOICE_EVENTS = {
  RECORDING_UPLOADED: 'voice_recording_uploaded',
  TRANSCRIPTION_STARTED: 'voice_transcription_started',
  TRANSCRIPTION_COMPLETED: 'voice_transcription_completed',
  TRANSCRIPTION_FAILED: 'voice_transcription_failed',
  LOCATION_EXTRACTED: 'location_extracted',
  LOCATION_GEOCODED: 'location_geocoded',
  LOCATION_UNRESOLVED: 'location_unresolved',
  HOSPITAL_SEARCH_STARTED: 'hospital_search_started',
  HOSPITAL_SELECTED: 'hospital_selected',
  HOSPITAL_NOT_FOUND: 'hospital_not_found',
  EMERGENCY_CREATED: 'voice_emergency_created',
  HOSPITAL_NOTIFICATION_CREATED: 'hospital_notification_created',
  PROCESSING_FAILED: 'voice_processing_failed',
} as const;

export type VoiceEventName = (typeof VOICE_EVENTS)[keyof typeof VOICE_EVENTS];

/**
 * Emits one structured event. Failures are swallowed: observability must never
 * take down an emergency report.
 */
export function emitVoiceEvent(
  event: VoiceEventName,
  fields: Record<string, unknown> = {},
): void {
  try {
    logger.info({ event, ...fields }, `voice pipeline: ${event}`);
  } catch {
    // A logger failure must never break the request path.
  }
}

/** Emits an error-level voice event. */
export function emitVoiceError(
  event: VoiceEventName,
  error: unknown,
  fields: Record<string, unknown> = {},
): void {
  try {
    logger.error(
      {
        event,
        err: error instanceof Error ? { message: error.message, name: error.name } : error,
        ...fields,
      },
      `voice pipeline: ${event}`,
    );
  } catch {
    // ignored on purpose
  }
}
