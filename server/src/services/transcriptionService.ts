import { logger } from '../config/logger.js';
import { ApiError } from '../utils/errors.js';
import { emitVoiceError, emitVoiceEvent, VOICE_EVENTS } from '../utils/events.js';
import {
  describeServerAudio,
  normalizeAudioToBuffer,
  type ServerAudioLike,
} from './audioNormalizeService.js';
import type { TranscriptionStatus } from '../validation/constants.js';

/**
 * The single adapter between the voice pipeline and whatever actually turns
 * audio into text.
 *
 * RapidAid's existing architecture transcribes **on the device** with the
 * bundled, offline Whisper model (`src/lib/transcribeAudio.ts`) so nothing
 * spoken leaves the browser and no API key is required. That transcript
 * travels up with the multipart upload. This service is the provider-agnostic
 * seam: it validates and normalizes the audio to a `Buffer` exactly once,
 * preserves the real MIME type, records which provider produced the text, and
 * can hand off to a server-side provider when one is configured — without any
 * of that leaking into the routes.
 *
 * A transcription failure never loses the recording or the report: the caller
 * keeps the stored audio and a `FAILED` status.
 */

export type TranscriptionProvider = 'on-device-whisper' | 'server-whisper' | 'none';

export interface TranscriptionResult {
  text: string;
  provider: TranscriptionProvider;
  status: TranscriptionStatus;
  /** 0–100, or null when the provider does not report one. */
  confidence: number | null;
  byteLength: number;
  mimeType: string | null;
  filename: string | null;
  durationMs: number;
  /** Safe, loggable description of the buffer the provider actually received. */
  audioShape: ReturnType<typeof describeServerAudio>;
  error: string | null;
}

/**
 * Rough duration estimate from container size, used only when the client did
 * not report one. Bitrates are typical `MediaRecorder`/encoder defaults; the
 * value is stored for display, never for billing or scheduling.
 */
const APPROX_BYTES_PER_SECOND: Record<string, number> = {
  'audio/webm': 12_000,
  'audio/x-webm': 12_000,
  'audio/ogg': 12_000,
  'audio/mp4': 12_000,
  'audio/m4a': 12_000,
  'audio/x-m4a': 12_000,
  'audio/aac': 12_000,
  'audio/mpeg': 16_000,
  'audio/mp3': 16_000,
  'audio/wav': 32_000,
  'audio/x-wav': 32_000,
  'audio/wave': 32_000,
  'audio/flac': 300_000,
};

export function estimateDurationSeconds(
  byteLength: number,
  mimeType: string | null | undefined,
): number | null {
  const rate = mimeType ? APPROX_BYTES_PER_SECOND[mimeType] : undefined;
  if (!rate || byteLength <= 0) return null;
  return Math.round(byteLength / rate);
}

function baseResult(
  buffer: Buffer,
  mimeType: string | null,
  filename: string | null,
  status: TranscriptionStatus,
  provider: TranscriptionProvider,
  durationMs: number,
  error: string | null,
  text = '',
  confidence: number | null = null,
): TranscriptionResult {
  return {
    text,
    provider,
    status,
    confidence,
    byteLength: buffer.byteLength,
    mimeType,
    filename,
    durationMs,
    // Never the samples themselves — metadata only.
    audioShape: describeServerAudio(buffer),
    error,
  };
}

/**
 * Normalizes speech recognition text to correct known acoustic/phonetic
 * misrecognitions of emergency phrases (e.g. "recollector" for "vehicle accident").
 */
export function normalizeSpeechTranscript(text: string): string {
  if (!text) return '';
  return text
    .replace(/\b(?:recollector|re-collector|wreck collector)\b/gi, 'vehicle accident')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Transcribes a recording.
 *
 * @param audio            bytes from any container (Buffer / Uint8Array / base64 / multipart part)
 * @param mimeType         real container type reported by the browser, e.g. `audio/webm;codecs=opus`
 * @param filename         stored filename, for provider metadata
 * @param clientTranscript transcript produced on-device by the bundled Whisper model
 */
export async function transcribeAudio(
  audio: ServerAudioLike,
  mimeType: string | null,
  filename: string | null,
  options: { clientTranscript?: string | null; requestId?: string } = {},
): Promise<TranscriptionResult> {
  const startedAt = Date.now();

  // ── 1. Normalize to a Node Buffer, exactly once, here ─────────────────────
  let buffer: Buffer;
  try {
    buffer = normalizeAudioToBuffer(audio);
  } catch (error) {
    emitVoiceError(VOICE_EVENTS.TRANSCRIPTION_FAILED, error, {
      stage: 'normalize',
      requestId: options.requestId,
    });
    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('The recording could not be read');
  }
  if (buffer.byteLength === 0) {
    throw new ApiError(400, 'AUDIO_EMPTY', 'The recording was empty');
  }

  const resolvedMime = mimeType ?? null;
  emitVoiceEvent(VOICE_EVENTS.TRANSCRIPTION_STARTED, {
    requestId: options.requestId,
    ...describeServerAudio(buffer),
  });

  // ── 2. Provider: the on-device transcript the browser already produced ───
  const rawClientTranscript = (options.clientTranscript ?? '').trim();
  if (rawClientTranscript) {
    const authoritative = normalizeSpeechTranscript(rawClientTranscript);
    return baseResult(
      buffer, resolvedMime, filename, 'COMPLETED', 'on-device-whisper',
      Date.now() - startedAt, null, authoritative,
    );
  }

  // ── 3. Provider: server-side Whisper, if the runtime can load one ─────────
  const serverProvider = await loadServerProvider();
  if (serverProvider) {
    try {
      const rawText = await serverProvider(buffer, resolvedMime);
      const text = normalizeSpeechTranscript(rawText);
      emitVoiceEvent(VOICE_EVENTS.TRANSCRIPTION_COMPLETED, {
        requestId: options.requestId,
        provider: 'server-whisper',
        durationMs: Date.now() - startedAt,
      });
      return baseResult(
        buffer, resolvedMime, filename, 'COMPLETED', 'server-whisper',
        Date.now() - startedAt, null, text,
      );
    } catch (error) {
      emitVoiceError(VOICE_EVENTS.TRANSCRIPTION_FAILED, error, {
        requestId: options.requestId,
        provider: 'server-whisper',
      });
      return baseResult(
        buffer, resolvedMime, filename, 'FAILED', 'server-whisper',
        Date.now() - startedAt,
        error instanceof Error ? error.message : 'Transcription failed',
      );
    }
  }

  // ── 4. No transcript available. The recording is still kept. ─────────────
  const message =
    'No transcript was produced. The recording was stored — add a transcript or confirm the details manually.';
  emitVoiceEvent(VOICE_EVENTS.TRANSCRIPTION_FAILED, {
    requestId: options.requestId,
    provider: 'none',
    reason: 'no_provider',
  });
  return baseResult(
    buffer, resolvedMime, filename, 'FAILED', 'none', Date.now() - startedAt, message,
  );
}

type ServerProvider = (buffer: Buffer, mimeType: string | null) => Promise<string>;

let registeredServerProvider: ServerProvider | null = null;

/**
 * Registers an optional server-side transcription provider (e.g. for testing or extensions).
 * RapidAid ships no server-side speech model because transcription is performed
 * on-device in the browser; this provides a clean extension seam without
 * introducing heavy ML dependencies into the backend.
 */
export function registerServerProvider(provider: ServerProvider | null): void {
  registeredServerProvider = provider;
}

/**
 * Loads an optional server-side transcription provider.
 *
 * RapidAid transcribes offline on the client device (via bundled Whisper in the browser),
 * so in all standard deployments this resolves to `null` unless a custom server
 * provider has been registered. Spoken emergency audio never leaves the deployment.
 */
async function loadServerProvider(): Promise<ServerProvider | null> {
  if (registeredServerProvider) {
    return registeredServerProvider;
  }
  if (process.env.VOICE_TRANSCRIPTION_PROVIDER === 'server-whisper') {
    logger.warn(
      'VOICE_TRANSCRIPTION_PROVIDER="server-whisper" was requested, but server-side speech recognition ' +
        'is handled on-device by the frontend to prevent server ML dependency bloat. Register a provider via registerServerProvider if needed.',
    );
  }
  return null;
}

/** Test seam: forget any memoized or registered server provider. */
export function resetServerProviderCache(): void {
  registeredServerProvider = null;
}
