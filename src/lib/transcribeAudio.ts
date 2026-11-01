/**
 * Local, on-device speech-to-text fallback for the Voice page.
 *
 * The browser's Web Speech API streams microphone audio to Google's servers,
 * which can be unreachable (restricted networks, offline use, browser policy)
 * and fails with `Speech recognition lost its network connection`. This module
 * transcribes a recorded audio blob entirely on-device with Whisper running
 * through transformers.js (ONNX Runtime WASM) — no API key, no server round
 * trip, no Google involved.
 *
 * The quantized model and ONNX runtime ship with the app under /models and
 * /ort (populated at install/build time by scripts/sync-voice-model.mjs), so
 * transcription is fully offline — zero runtime downloads.
 *
 * ── BUG FIXED HERE: `TypeError: aud.subarray is not a function` ──────────────
 * The decoder used to return `{ array: Float32Array, sampling_rate: 16000 }`,
 * a *plain object*. transformers.js `prepareAudios()` only special-cases
 * `string` / `URL` / `Float64Array` and returns anything else unchanged, so
 * `aud` reached `WhisperForConditionalGeneration._call_whisper` as that plain
 * object. With `chunk_length_s: 30` the chunking loop then called
 * `aud.subarray(offset, offset_end)` on it and threw. The decoder now returns
 * a bare `Float32Array` (the JS pipeline's actual contract) and
 * `normalizeAudioToFloat32` is the single gate that guarantees it.
 */

import { describeAudio, isTypedArrayLike, type AudioLike } from './audioNormalize';

/**
 * Whisper's native input rate. The JS pipeline wants a BARE `Float32Array` at
 * this rate — NOT the `{ array, sampling_rate }` object that the *Python*
 * `transformers` library uses. See `normalizeAudioToFloat32` for why that
 * distinction is the whole bug.
 */
export const WHISPER_SAMPLE_RATE = 16000;

/**
 * The Python-style container that used to be handed to the pipeline.
 * Still accepted (and unwrapped) so any caller written against the old shape
 * keeps working instead of crashing with `aud.subarray is not a function`.
 */
export interface RawAudio {
  array: Float32Array;
  sampling_rate: number;
}

/** Reports model-download progress (0-100), or `null` once inference starts. */
export type TranscribeProgress = (percent: number | null) => void;

/** Metadata about a completed transcription (no audio content, no secrets). */
export interface TranscriptionDiagnostics {
  /** What `aud` actually was at the pipeline boundary. */
  inputShape: ReturnType<typeof describeAudio>;
  /** Sample rate the audio was resampled to. */
  samplingRate: number;
  /** Length fed to the model. */
  sampleCount: number;
  /** Wall-clock inference time in ms. */
  durationMs: number;
  /** Recording container MIME type. */
  mimeType: string | null;
  byteLength: number | null;
}

/** Result of a successful transcription, with the text plus useful metadata. */
export interface TranscriptionResult {
  text: string;
  provider: 'on-device-whisper';
  diagnostics: TranscriptionDiagnostics;
}

/**
 * Raised when the audio value handed to the speech engine is not something it
 * can index. Kept distinct from a generic Error so the UI can say something
 * specific instead of "Something went wrong".
 */
export class AudioShapeError extends Error {
  readonly receivedType: string;

  constructor(receivedType: string) {
    super(
      `The audio buffer has an unexpected type (${receivedType}). It must be a Float32Array or another typed array.`,
    );
    this.name = 'AudioShapeError';
    this.receivedType = receivedType;
  }
}

export interface TranscribePipelineOptions {
  chunk_length_s?: number;
  stride_length_s?: number;
  language?: string | null;
  task?: 'transcribe' | 'translate';
  initial_prompt?: string;
  return_timestamps?: boolean;
}

interface Transcriber {
  (audio: Float32Array, options?: TranscribePipelineOptions): Promise<{
    text?: unknown;
  }>;
}

/**
 * Normalizes speech recognition text whitespace without mutating or inventing words.
 * Conforms to: "Do not invent transcript corrections or automatically replace misrecognized words."
 */
export function normalizeSpeechTranscript(text: string): string {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Amplitude normalization: boosts low-level audio signals safely up to target peak
 * so quiet speech is readily audible to Whisper's feature extractor.
 */
export function normalizeAudioAmplitude(samples: Float32Array, targetPeak = 0.95): Float32Array {
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  if (peak === 0 || peak >= targetPeak) return samples;
  const factor = targetPeak / peak;
  const normalized = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    normalized[i] = samples[i] * factor;
  }
  return normalized;
}

/** Emergency domain vocabulary priming for Whisper decoder */
export const EMERGENCY_INITIAL_PROMPT =
  'Emergency report: road accident, vehicle collision, ambulance needed, hospital, patient, unconscious, bleeding, Gwalior, Indore, Delhi, Maharaj Bada, Phool Bagh, Hazira, Morar, Deendayal Nagar, सड़क दुर्घटना, घायल, एम्बुलेंस, अस्पताल, बेहोश, दिल का दौरा';

export interface TranscriptionOptions {
  /** Explicit language code: 'en', 'hi', or 'auto' for automatic language detection. */
  language?: 'auto' | 'en' | 'hi' | string | null;
  task?: 'transcribe' | 'translate';
  initialPrompt?: string;
}

/**
 * ---------------------------------------------------------------------------
 * ROOT CAUSE OF `TypeError: aud.subarray is not a function`
 * ---------------------------------------------------------------------------
 * `decodeTo16kMono` used to return `{ array, sampling_rate }` — a *plain
 * object*. transformers.js then does:
 *
 *   const preparedAudios = await prepareAudios(audio, sampling_rate);
 *   for (const aud of preparedAudios) { ... aud.subarray(offset, offset_end) }
 *
 * and `prepareAudios` only special-cases `string`, `URL` and `Float64Array`:
 *
 *   return x;   // <-- a plain object falls straight through unchanged
 *
 * So `aud` was the plain object, and with `chunk_length_s: 30 > 0` the chunking
 * loop called `.subarray` on it → TypeError.
 *
 * This function is the boundary that makes that impossible: whatever the
 * caller supplies, the pipeline only ever receives a real `Float32Array`.
 */
export function normalizeAudioToFloat32(
  audio: AudioLike,
  fallbackSampleRate = WHISPER_SAMPLE_RATE,
): { samples: Float32Array; samplingRate: number } {
  if (audio === null || audio === undefined) {
    throw new AudioShapeError('null');
  }

  // The Python-style `{ array, sampling_rate }` container → unwrap it.
  if (
    typeof audio === 'object' &&
    !ArrayBuffer.isView(audio) &&
    !(typeof Blob !== 'undefined' && audio instanceof Blob) &&
    'array' in (audio as Record<string, unknown>)
  ) {
    const bag = audio as unknown as RawAudio;
    return normalizeAudioToFloat32(bag.array, bag.sampling_rate ?? fallbackSampleRate);
  }

  // Float32Array (the expected input)
  if (audio instanceof Float32Array) {
    return { samples: audio, samplingRate: fallbackSampleRate };
  }

  // Float64Array → narrow (mirrors what transformers.js does internally)
  if (audio instanceof Float64Array) {
    return { samples: new Float32Array(audio), samplingRate: fallbackSampleRate };
  }

  // Any other typed array of numbers (Float16/Int16/Uint8…): scale ints.
  if (isTypedArrayLike(audio)) {
    const view = audio as unknown as { length: number; [index: number]: number };
    const samples = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) samples[i] = view[i];
    return { samples, samplingRate: fallbackSampleRate };
  }

  // ArrayBuffer of raw samples
  if (typeof ArrayBuffer !== 'undefined' && audio instanceof ArrayBuffer) {
    return { samples: new Float32Array(audio), samplingRate: fallbackSampleRate };
  }

  throw new AudioShapeError(describeAudio(audio).constructorName);
}

/** Bundled Multilingual Whisper — files live in public/models (see sync script). */
export const MODEL_ID = 'Xenova/whisper-base';

type ProgressEventLike = {
  status?: string;
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
};

let transcriberPromise: Promise<Transcriber> | null = null;
const progressSubscribers = new Set<TranscribeProgress>();

function emitProgress(percent: number | null): void {
  for (const subscriber of [...progressSubscribers]) {
    try {
      subscriber(percent);
    } catch {
      // A misbehaving subscriber must not break transcription.
    }
  }
}

async function loadTranscriber(): Promise<Transcriber> {
  const { pipeline, env } = await import('@huggingface/transformers');

  // Fully offline: model files ship with the app under /models and the ONNX
  // runtime wasm under /ort. Disabling remote models guarantees nothing is
  // fetched from the network at runtime.
  env.allowLocalModels = true;
  env.localModelPath = '/models/';
  env.allowRemoteModels = false;
  if (env.backends.onnx.wasm) {
    env.backends.onnx.wasm.wasmPaths = '/ort/';
  }

  // Aggregate per-file load progress into one overall percentage.
  const files = new Map<string, { loaded: number; total: number }>();
  const onProgress = (event: ProgressEventLike) => {
    if (event.status !== 'progress' || !event.total) return;
    files.set(event.file ?? event.name ?? String(files.size), {
      loaded: event.loaded ?? 0,
      total: event.total,
    });
    let loaded = 0;
    let total = 0;
    for (const value of files.values()) {
      loaded += value.loaded;
      total += value.total;
    }
    if (total > 0) emitProgress(Math.min(99, Math.round((loaded / total) * 100)));
  };

  try {
    return (await pipeline('automatic-speech-recognition', MODEL_ID, {
      dtype: 'q8',
      progress_callback: onProgress,
    })) as unknown as Transcriber;
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? ` (${error.message.slice(0, 160)})` : '';
    throw new Error(
      `Could not start the local speech engine. If this keeps happening, run "npm run prepare:voice-model" and reload.${detail}`,
    );
  }
}

/** Shared, lazily-created transcriber instance (downloaded at most once). */
function ensureTranscriber(): Promise<Transcriber> {
  if (!transcriberPromise) {
    transcriberPromise = loadTranscriber();
    // Allow a retry after a failed load (e.g. transient network error).
    transcriberPromise.catch(() => {
      transcriberPromise = null;
    });
  }
  return transcriberPromise;
}

/**
 * Begins downloading the model and runtime in the background. Safe to call
 * repeatedly (no-op once loaded); failures are silent because the real load
 * happens again inside `transcribeBlob`.
 */
export function preloadTranscriber(): void {
  void ensureTranscriber().catch(() => undefined);
}

/**
 * Decodes any browser-recordable audio (webm/opus, mp4/aac, ogg…) to 16 kHz
 * mono — Whisper's native input rate. `OfflineAudioContext.decodeAudioData`
 * resamples to the context's sample rate while decoding.
 *
 * Returns a BARE `Float32Array`. It deliberately does not return the
 * `{ array, sampling_rate }` object: that is the Python `transformers`
 * convention, and handing it to the JS pipeline is what produced
 * `TypeError: aud.subarray is not a function`.
 */
async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const arrayBuffer = await blob.arrayBuffer();
  const context = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  const decoded = await context.decodeAudioData(arrayBuffer);

  if (decoded.numberOfChannels === 1) {
    return decoded.getChannelData(0).slice();
  }
  // Mix down to mono so multi-channel recordings still work.
  const mono = new Float32Array(decoded.length);
  for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
    const data = decoded.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) {
      mono[i] += data[i] / decoded.numberOfChannels;
    }
  }
  return mono;
}

/**
 * Transcribes a recorded audio blob to text on-device, returning the text plus
 * the diagnostics the pipeline logs.
 *
 * @param blob audio captured by `MediaRecorder`
 * @param onProgress optional model-download / phase progress callback
 * @param options optional explicit language ('en' | 'hi' | 'auto') and task options
 * @returns the recognized text (trimmed) and safe metadata
 * @throws Error with a user-facing message when decoding or the model fails
 */
export async function transcribeRecording(
  blob: Blob,
  onProgress?: TranscribeProgress,
  options?: TranscriptionOptions,
): Promise<TranscriptionResult> {
  if (!blob || blob.size === 0) {
    throw new Error('The recording was empty — check your microphone and try again.');
  }

  if (onProgress) progressSubscribers.add(onProgress);
  const startedAt = Date.now();
  try {
    const transcriber = await ensureTranscriber();
    const decoded = await decodeTo16kMono(blob);
    // The single normalization boundary. Whatever `decoded` is, the pipeline
    // below only ever sees a real Float32Array.
    const { samples: rawSamples, samplingRate } = normalizeAudioToFloat32(decoded, WHISPER_SAMPLE_RATE);
    // Audio amplitude normalization: boosts quiet microphone capture up to target peak
    const samples = normalizeAudioAmplitude(rawSamples, 0.95);

    // Model is ready — inference phase has an indeterminate indicator.
    emitProgress(null);

    const selectedLanguage =
      options?.language && options.language !== 'auto' ? options.language : undefined;

    const pipelineOptions: TranscribePipelineOptions = {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: options?.task || 'transcribe',
      ...(selectedLanguage ? { language: selectedLanguage } : {}),
      initial_prompt: options?.initialPrompt ?? EMERGENCY_INITIAL_PROMPT,
    };

    const output = await transcriber(samples, pipelineOptions);
    const rawText = typeof output?.text === 'string' ? output.text.trim() : '';
    const text = normalizeSpeechTranscript(rawText);
    return {
      text,
      provider: 'on-device-whisper',
      diagnostics: {
        inputShape: describeAudio(samples),
        samplingRate,
        sampleCount: samples.length,
        durationMs: Date.now() - startedAt,
        mimeType: blob.type || null,
        byteLength: blob.size,
      },
    };
  } catch (error) {
    if (error instanceof AudioShapeError) throw error;
    if (error instanceof Error && error.message) {
      const decodeFailed = /decode|encoding|not support/i.test(error.message);
      throw new Error(
        decodeFailed ? 'Could not read the recording in this browser.' : error.message,
      );
    }
    throw new Error('Could not transcribe the recording. Check your connection and try again.');
  } finally {
    if (onProgress) progressSubscribers.delete(onProgress);
  }
}

/** Convenience wrapper returning just the transcript text. */
export async function transcribeBlob(
  blob: Blob,
  onProgress?: TranscribeProgress,
  options?: TranscriptionOptions,
): Promise<string> {
  return (await transcribeRecording(blob, onProgress, options)).text;
}
