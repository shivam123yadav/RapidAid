import { ApiError } from '../utils/errors.js';
import {
  MAX_VOICE_AUDIO_BYTES,
  VOICE_AUDIO_MIME_TYPES,
  type VoiceAudioMimeType,
} from '../validation/constants.js';

/**
 * Server-side audio normalization — the mirror image of the browser's
 * `src/lib/audioNormalize.ts`.
 *
 * Audio reaches the server in several shapes depending on the transport:
 *   - multipart upload   → `{ buffer, mimetype, originalname, size }`
 *   - JSON body          → a base64 string (optionally a data URL)
 *   - proxy/queue payload→ a `Buffer` or a plain `ArrayBuffer`
 *
 * Any of those used to be handed straight to a transcription provider, and a
 * provider that calls `.subarray(...)` on a non-typed-array throws
 * `TypeError: <name>.subarray is not a function`. Everything is coerced to a
 * Node `Buffer` exactly once, here, so no provider-specific audio handling
 * leaks into the rest of the application.
 */

/** Anything the server knows how to turn into audio bytes. */
export type ServerAudioLike =
  | Buffer
  | Uint8Array
  | ArrayBuffer
  | DataView
  | number[]
  | string
  | {
      buffer: Buffer | Uint8Array | ArrayBuffer | DataView | number[] | string;
      mimetype?: string;
      type?: string;
      mimeType?: string;
    }
  | null
  | undefined;

export class AudioConversionError extends ApiError {
  readonly receivedType: string;

  constructor(message: string, receivedType: string, code = 'AUDIO_CONVERSION_FAILED') {
    super(400, code, message);
    this.name = 'AudioConversionError';
    this.receivedType = receivedType;
  }
}

/** Safe, loggable description of an audio value. Metadata only, never samples. */
export interface ServerAudioShape {
  kind: string;
  constructorName: string;
  isBuffer: boolean;
  isUint8Array: boolean;
  isArrayBuffer: boolean;
  isTypedArray: boolean;
  isString: boolean;
  byteLength: number | null;
  mimeType: string | null;
}

/** Reads a declared MIME type off whichever container carries one. */
export function readMimeType(audio: ServerAudioLike): string | null {
  if (typeof audio === 'string') {
    const match = /^data:([^;,]+)[;,]/.exec(audio.trim());
    return match ? match[1].toLowerCase() : null;
  }
  if (!audio || typeof audio !== 'object') return null;
  const bag = audio as { mimetype?: string; type?: string; mimeType?: string };
  const declared = bag.mimetype || bag.type || bag.mimeType;
  return declared ? declared.split(';')[0].trim().toLowerCase() : null;
}

/** Public, loggable metadata for the audio pipeline (never the samples). */
export function describeServerAudio(audio: ServerAudioLike): ServerAudioShape {
  if (audio === null || audio === undefined) {
    return {
      kind: String(audio), constructorName: String(audio), isBuffer: false, isUint8Array: false,
      isArrayBuffer: false, isTypedArray: false, isString: false, byteLength: null, mimeType: null,
    };
  }
  const kind = typeof audio;
  const isBuffer = Buffer.isBuffer(audio);
  const isTypedArray = ArrayBuffer.isView(audio);
  const isArrayBuffer = audio instanceof ArrayBuffer;
  return {
    kind,
    constructorName: kind === 'object' ? (audio as object).constructor?.name ?? 'Object' : kind,
    isBuffer,
    isUint8Array: audio instanceof Uint8Array,
    isArrayBuffer,
    isTypedArray,
    isString: kind === 'string',
    byteLength: isArrayBuffer
      ? (audio as ArrayBuffer).byteLength
      : isTypedArray
        ? (value => (value as ArrayBufferView).byteLength)(audio)
        : isBuffer
          ? (audio as Buffer).length
          : null,
    mimeType: readMimeType(audio),
  };
}

/** Browser + Node base64 decoder. */
function decodeBase64(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64');
}

/**
 * Coerces any supported audio container into a Node `Buffer`.
 *
 * Buffer        → returned unchanged
 * Uint8Array    → Buffer.from(audio)
 * ArrayBuffer   → Buffer.from(new Uint8Array(audio))
 * base64/dataURL→ Buffer.from(base64, 'base64')
 * multipart obj → recurses into `.buffer`
 * number[]      → Buffer.from(audio)
 */
export function normalizeAudioToBuffer(audio: ServerAudioLike): Buffer {
  if (audio === null || audio === undefined) {
    throw new AudioConversionError('No audio was provided', 'null');
  }
  // Buffer — already correct. Return it directly.
  if (Buffer.isBuffer(audio)) return audio;
  // Uint8Array (Buffer handled above)
  if (audio instanceof Uint8Array) return Buffer.from(audio);
  // ArrayBuffer
  if (audio instanceof ArrayBuffer) return Buffer.from(new Uint8Array(audio));
  // DataView / any other typed-array view
  if (ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  // byte array
  if (Array.isArray(audio)) return Buffer.from(audio);
  // base64 string or data URL
  if (typeof audio === 'string') {
    const trimmed = audio.trim();
    if (!trimmed) throw new AudioConversionError('The recording was empty', 'string');
    const base64 = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed;
    if (!/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(base64)) {
      throw new AudioConversionError('The audio payload was not valid base64', 'string');
    }
    const decoded = decodeBase64(base64);
    if (decoded.byteLength === 0) {
      throw new AudioConversionError('The recording was empty', 'string');
    }
    return decoded;
  }
  // multipart-middleware shape: { buffer, mimetype }
  if (typeof audio === 'object' && 'buffer' in (audio as Record<string, unknown>)) {
    return normalizeAudioToBuffer((audio as { buffer: ServerAudioLike }).buffer);
  }
  const shape = describeServerAudio(audio);
  throw new AudioConversionError(
    `Unsupported audio container of type ${shape.constructorName}`,
    shape.constructorName,
  );
}

export interface NormalizeOptions {
  /** MIME type to use when the container declares none. */
  defaultMimeType?: string;
  /** Enforce the upload ceiling. Defaults to `MAX_VOICE_AUDIO_BYTES`. */
  maxBytes?: number;
}

/**
 * The single entry point the upload path uses: normalize, reject empties and
 * oversized payloads, and return the bytes together with the resolved MIME
 * type. Callers get a `Buffer` they can hand to any provider.
 */
export function normalizeUploadedAudio(
  audio: ServerAudioLike,
  options: NormalizeOptions = {},
): { buffer: Buffer; mimeType: string; byteLength: number } {
  const buffer = normalizeAudioToBuffer(audio);
  if (buffer.byteLength === 0) {
    throw new AudioConversionError('The recording was empty', 'empty', 'AUDIO_EMPTY');
  }
  const maxBytes = options.maxBytes ?? MAX_VOICE_AUDIO_BYTES;
  if (buffer.byteLength > maxBytes) {
    throw new ApiError(
      413,
      'AUDIO_TOO_LARGE',
      `Recording is ${(buffer.byteLength / 1024 / 1024).toFixed(1)} MB; the limit is ${(maxBytes / 1024 / 1024).toFixed(0)} MB`,
    );
  }
  const mimeType = readMimeType(audio) ?? options.defaultMimeType ?? '';
  return { buffer, mimeType, byteLength: buffer.byteLength };
}

/** True when a MIME type is one of the accepted audio containers. */
export function isAllowedAudioMimeType(
  mimeType: string | null | undefined,
): mimeType is VoiceAudioMimeType {
  if (!mimeType) return false;
  return (VOICE_AUDIO_MIME_TYPES as readonly string[]).includes(mimeType);
}
