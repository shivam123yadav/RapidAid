/**
 * Browser-side audio normalization layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MediaRecorder` hands back a `Blob`. Depending on the stage you are at, the
 * same audio can be a `Blob`, a `File`, an `ArrayBuffer`, a `Uint8Array`, a
 * base64 string, or a plain `{ buffer, mimetype }` object (the shape a
 * multipart middleware hands to a server). Code that calls
 * `aud.subarray(...)` on the wrong one of those produces
 * `TypeError: aud.subarray is not a function`.
 *
 * This module is the single place where "whatever the audio currently is" is
 * turned into a verified typed array, so the rest of the app never has to
 * guess. It is deliberately DOM-free at module scope so it can also be
 * imported by the server test suite.
 */

/** Raised when audio cannot be coerced into bytes. Carries a safe, showable message. */
export class AudioNormalizeError extends Error {
  readonly receivedType: string;

  constructor(message: string, receivedType: string) {
    super(message);
    this.name = 'AudioNormalizeError';
    this.receivedType = receivedType;
  }
}

/** Anything we know how to turn into raw audio bytes. */
export type AudioLike =
  | Blob
  | ArrayBuffer
  | ArrayBufferView
  | number[]
  | string
  | { buffer: ArrayBuffer | ArrayBufferView | number[]; mimetype?: string; type?: string }
  | null
  | undefined;

/** Safe, loggable description of an audio value — metadata only, never samples. */
export interface AudioShape {
  kind: string;
  constructorName: string;
  isBlob: boolean;
  isArrayBuffer: boolean;
  isTypedArray: boolean;
  isBuffer: boolean;
  isString: boolean;
  byteLength: number | null;
  mimeType: string | null;
}

/** True for `Uint8Array` and every typed-array view that exposes `subarray`. */
export function isTypedArrayLike(value: unknown): value is ArrayBufferView & {
  subarray: (...args: number[]) => ArrayBufferView;
} {
  return (
    ArrayBuffer.isView(value) && typeof (value as { subarray?: unknown }).subarray === 'function'
  );
}

/** True for a Node `Buffer` (a `Uint8Array` subclass). */
export function isBufferLike(value: unknown): value is Uint8Array {
  return (
    typeof Buffer !== 'undefined' &&
    Buffer.isBuffer(value) &&
    typeof (value as Uint8Array).subarray === 'function'
  );
}

/** True when the value exposes `arrayBuffer()` — i.e. a `Blob` or a `File`. */
function isBlobLike(value: unknown): value is Blob {
  return (
    typeof Blob !== 'undefined' &&
    value instanceof Blob &&
    typeof (value as Blob).arrayBuffer === 'function'
  );
}

/** Reads the declared MIME type off whichever container carries one. */
export function readDeclaredMimeType(audio: AudioLike): string | null {
  if (typeof audio === 'string') {
    const match = /^data:([^;,]+)[;,]/.exec(audio.trim());
    return match ? match[1].toLowerCase() : null;
  }
  if (!audio || typeof audio !== 'object') return null;
  const bag = audio as { mimetype?: string; type?: string; mimeType?: string };
  return bag.mimetype || bag.type || bag.mimeType || null;
}

function isArrayBufferSafe(value: unknown): boolean {
  return typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer;
}

/**
 * Describes an audio value without touching its contents — safe to log.
 * Used by the debug instrumentation around the recording pipeline.
 */
export function describeAudio(audio: AudioLike): AudioShape {
  if (audio === null) {
    return {
      kind: 'null', constructorName: 'null', isBlob: false, isArrayBuffer: false,
      isTypedArray: false, isBuffer: false, isString: false, byteLength: null, mimeType: null,
    };
  }
  const kind = typeof audio;
  const constructorName = kind === 'object' ? (audio as object).constructor?.name ?? 'Object' : kind;
  const typed = isTypedArrayLike(audio);
  return {
    kind,
    constructorName,
    isBlob: isBlobLike(audio),
    isArrayBuffer: isArrayBufferSafe(audio),
    isTypedArray: typed,
    isBuffer: isBufferLike(audio),
    isString: kind === 'string',
    byteLength: isArrayBufferSafe(audio)
      ? (audio as ArrayBuffer).byteLength
      : typed
        ? (audio as ArrayBufferView).byteLength
        : isBlobLike(audio)
          ? audio.size
          : null,
    mimeType: readDeclaredMimeType(audio),
  };
}

/**
 * THE fix for `aud.subarray is not a function`.
 *
 * Coerces any supported audio container into a real `Uint8Array` (which always
 * has `subarray`). Only call `.subarray(...)` on the value this returns.
 */
export function normalizeAudioToBytes(audio: AudioLike): Uint8Array {
  if (audio === null || audio === undefined) {
    throw new AudioNormalizeError('No audio was provided', 'null');
  }
  // Buffer → return as-is (already a Uint8Array exposing subarray)
  if (isBufferLike(audio)) return audio as Uint8Array;
  // Any typed array / DataView
  if (isTypedArrayLike(audio)) {
    return new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  // ArrayBuffer
  if (isArrayBufferSafe(audio)) return new Uint8Array(audio as ArrayBuffer);
  // Plain array of byte values
  if (Array.isArray(audio)) return Uint8Array.from(audio);
  // base64 string, or a full data URL
  if (typeof audio === 'string') {
    const trimmed = audio.trim();
    if (!trimmed) throw new AudioNormalizeError('The recording was empty', 'string');
    const base64 = trimmed.startsWith('data:')
      ? trimmed.slice(trimmed.indexOf(',') + 1)
      : trimmed;
    let decoded: Uint8Array;
    try {
      decoded = decodeBase64(base64);
    } catch {
      throw new AudioNormalizeError('The recording was not valid base64 audio', 'string');
    }
    if (decoded.byteLength === 0) {
      throw new AudioNormalizeError('The recording was empty', 'string');
    }
    return decoded;
  }
  // Multipart-middleware shape: { buffer, mimetype }
  if (typeof audio === 'object' && 'buffer' in (audio as Record<string, unknown>)) {
    return normalizeAudioToBytes((audio as { buffer: AudioLike }).buffer);
  }
  // Blob / File — cannot be read synchronously.
  if (isBlobLike(audio)) {
    throw new AudioNormalizeError(
      'Blob audio must be read asynchronously — use normalizeAudioToBytesAsync',
      'Blob',
    );
  }
  const shape = describeAudio(audio);
  throw new AudioNormalizeError(
    `Unsupported audio container of type ${shape.constructorName}`,
    shape.constructorName,
  );
}

/**
 * Async counterpart of {@link normalizeAudioToBytes} that also accepts
 * `Blob` / `File` (the browser recording container). This is the entry point
 * the recording pipeline uses.
 */
export async function normalizeAudioToBytesAsync(audio: AudioLike): Promise<Uint8Array> {
  if (isBlobLike(audio)) {
    if (audio.size === 0) {
      throw new AudioNormalizeError('The recording was empty', 'Blob');
    }
    return new Uint8Array(await audio.arrayBuffer());
  }
  return normalizeAudioToBytes(audio);
}

/** Browser + Node base64 decoder (atob / Buffer). */
export function decodeBase64(value: string): Uint8Array {
  const compact = value.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(compact, 'base64'));
  }
  if (typeof atob === 'function') {
    const binary = atob(compact);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  }
  throw new Error('No base64 decoder available in this runtime');
}

/** Container extension for a MIME type, e.g. `audio/webm;codecs=opus` → `webm`. */
export function extensionForMimeType(mimeType: string | null | undefined): string {
  const base = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  switch (base) {
    case 'audio/webm':
    case 'audio/x-webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/wave':
    case 'audio/x-wav':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    default:
      return 'bin';
  }
}

/** `voice-emergency-<timestamp>.<ext>` — the canonical stored filename. */
export function buildAudioFilename(mimeType: string | null | undefined, timestamp = Date.now()): string {
  return `voice-emergency-${timestamp}.${extensionForMimeType(mimeType)}`;
}

export interface VoiceRecordingUpload {
  blob: Blob;
  /** Transcript produced on-device by the bundled Whisper model. */
  transcript: string;
  deviceLatitude?: number;
  deviceLongitude?: number;
  deviceAccuracy?: number;
  /** Recording length in seconds (the browser is the only accurate source). */
  durationSeconds?: number;
}

/**
 * Builds the multipart body for `POST /api/voice/reports/recording`.
 *
 * The `Content-Type` header is deliberately NOT set — the browser must add
 * `multipart/form-data; boundary=…` itself, otherwise the boundary is missing
 * and the server cannot parse the body. Never hand-set it.
 */
export function buildVoiceRecordingFormData(upload: VoiceRecordingUpload): FormData {
  const { blob, transcript, deviceLatitude, deviceLongitude, deviceAccuracy, durationSeconds } = upload;
  if (!blob || blob.size === 0) {
    throw new AudioNormalizeError('The recording was empty', 'Blob');
  }
  const form = new FormData();
  form.append('audio', blob, buildAudioFilename(blob.type, Date.now()));
  form.append('transcript', transcript);
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    form.append('durationSeconds', String(Math.max(0, Math.round(durationSeconds))));
  }
  if (typeof deviceLatitude === 'number' && typeof deviceLongitude === 'number') {
    form.append('deviceLatitude', String(deviceLatitude));
    form.append('deviceLongitude', String(deviceLongitude));
    if (typeof deviceAccuracy === 'number') {
      form.append('deviceAccuracy', String(Math.round(deviceAccuracy)));
    }
  }
  return form;
}
