import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiError } from '../utils/errors.js';
import {
  MAX_VOICE_AUDIO_BYTES,
  VOICE_AUDIO_FILENAME_PREFIX,
  VOICE_AUDIO_MIME_TYPES,
} from '../validation/constants.js';
import {
  isAllowedAudioMimeType,
  normalizeUploadedAudio,
  type ServerAudioLike,
} from './audioNormalizeService.js';
import { buildStoredAudioFilename } from '../middleware/audioUpload.js';
import { emitVoiceEvent, VOICE_EVENTS } from '../utils/events.js';
import { VoiceReport } from '../models/VoiceReport.js';

/**
 * Durable storage for the original voice recording.
 *
 * RapidAid has no S3/AWS configuration — emergency photos are stored inline on
 * the Mongo document. Audio is different: recordings are large and are patient
 * data, so the binary goes to the filesystem and only *metadata* reaches
 * MongoDB (`voiceInput` on the VoiceReport). This keeps every report document
 * far below the 16 MB BSON limit and leaves one obvious seam to swap in S3
 * later — `storeVoiceAudio` / `readVoiceAudio` are the only two functions
 * that touch a disk.
 *
 * Bytes are validated by *signature*, not by the declared MIME type, so a
 * renamed `evil.exe` cannot pass as `audio/webm`.
 */

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('../../storage/voice', import.meta.url)));

/** Root directory for stored recordings. Overridable for tests/deployments. */
export function storageRoot(): string {
  const configured = process.env.VOICE_AUDIO_STORAGE_DIR;
  if (!configured) return DEFAULT_ROOT;
  return isAbsolute(configured) ? normalize(configured) : resolve(process.cwd(), configured);
}

/** Container extension for a MIME type. */
export function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case 'audio/webm':
    case 'audio/x-webm':
      return 'webm';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/flac':
      return 'flac';
    default:
      return 'bin';
  }
}

function startsWith(bytes: Buffer, signature: number[], offset = 0): boolean {
  return signature.every((byte, i) => bytes[offset + i] === byte);
}

const MP4_BOXES: number[][] = [
  [0x66, 0x74, 0x79, 0x70], // ftyp
  [0x6d, 0x6f, 0x6f, 0x76], // moov
  [0x6d, 0x64, 0x61, 0x74], // mdat
  [0x73, 0x74, 0x73, 0x64], // stsd
  [0x66, 0x72, 0x65, 0x65], // free
  [0x73, 0x6b, 0x69, 0x70], // skip
];

/**
 * True when the bytes look like the container the client declared. Mirrors the
 * image-signature approach already used for emergency photo attachments.
 */
export function matchesAudioSignature(bytes: Buffer, mimeType: string): boolean {
  if (bytes.byteLength < 4) return false;
  switch (mimeType) {
    case 'audio/webm':
    case 'audio/x-webm':
      // EBML header
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case 'audio/ogg':
      // "OggS"
      return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]);
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      // RIFF....WAVE
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x41, 0x56, 0x45], 8)
      );
    case 'audio/mpeg':
    case 'audio/mp3':
      // ID3 tag, or a raw MPEG frame sync
      return (
        startsWith(bytes, [0x49, 0x44, 0x33]) ||
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
      );
    case 'audio/flac':
      return startsWith(bytes, [0x66, 0x4c, 0x61, 0x43]); // fLaC
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
    case 'audio/aac':
      // ISO-BMFF: an ftyp/moov/mdat box appears near the start.
      for (let offset = 0; offset <= Math.min(bytes.byteLength - 4, 64); offset += 1) {
        if (MP4_BOXES.some((box) => startsWith(bytes, box, offset))) return true;
      }
      // Raw ADTS AAC frame
      return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
    default:
      return false;
  }
}

export interface StoredVoiceAudio {
  storageKey: string;
  filename: string;
  mimeType: string;
  size: number;
  /** SHA-256 of the stored bytes, for integrity checks. */
  checksum: string;
  durationSeconds: number | null;
}

export interface StoreVoiceAudioInput {
  audio: ServerAudioLike;
  ownerId: string;
  /** MIME type declared by the client, when the container carries none. */
  declaredMimeType?: string;
  /** Client-reported recording length in seconds. */
  durationSeconds?: number;
}

/**
 * Validates and persists a recording, returning only the metadata that belongs
 * on the VoiceReport. Throws an `ApiError` when the upload must be rejected.
 */
export async function storeVoiceAudio(input: StoreVoiceAudioInput): Promise<StoredVoiceAudio> {
  const { buffer, mimeType, byteLength } = normalizeUploadedAudio(input.audio, {
    defaultMimeType: input.declaredMimeType,
    maxBytes: MAX_VOICE_AUDIO_BYTES,
  });

  if (!isAllowedAudioMimeType(mimeType)) {
    throw new ApiError(
      415,
      'UNSUPPORTED_AUDIO_TYPE',
      `Recording must be one of: ${VOICE_AUDIO_MIME_TYPES.join(', ')}`,
    );
  }
  if (!matchesAudioSignature(buffer, mimeType)) {
    throw new ApiError(
      415,
      'INVALID_AUDIO_CONTENT',
      'The uploaded file is not a valid audio recording',
    );
  }

  // The storage key is generated server-side from a random id, so a client can
  // never influence the path and cannot traverse out of the storage root.
  const id = randomUUID();
  const filename = buildStoredAudioFilename(extensionForMimeType(mimeType), Date.now());
  const storageKey = `${input.ownerId.replace(/[^A-Za-z0-9_-]/g, '')}/${id}/${filename}`;

  const target = resolveWithinRoot(storageRoot(), storageKey);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, buffer);

  const checksum = createHash('sha256').update(buffer).digest('hex');

  // WRITE-VERIFY. The caller is about to persist this key on a VoiceReport, so
  // the object is read back and verified HERE. A row must never be able to point
  // at bytes that were not actually persisted — that dangling reference is
  // exactly what produced "the stored recording could not be found" for reports
  // whose audio was supposedly uploaded.
  const verified = await inspectVoiceAudio(storageKey, { size: byteLength, checksum });
  if (!verified.exists || verified.size !== byteLength || verified.checksumMatches !== true) {
    throw new ApiError(
      500,
      'AUDIO_STORE_FAILED',
      'The recording could not be persisted, so it was not attached to the report',
    );
  }

  emitVoiceEvent(VOICE_EVENTS.RECORDING_UPLOADED, {
    storageKey,
    mimeType,
    size: byteLength,
    checksum: checksum.slice(0, 16),
  });

  return {
    storageKey,
    filename,
    mimeType,
    size: byteLength,
    checksum,
    durationSeconds:
      typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds)
        ? Math.max(0, Math.round(input.durationSeconds))
        : null,
  };
}

/**
 * Reconciles every VoiceReport's audio reference against what storage actually
 * holds.
 *
 * For a report whose object is gone and which the seeder does not own (an
 * orphan from an older dataset, or a real recording lost with its volume) the
 * original bytes are unrecoverable. The correct action is to record that
 * truthfully — `status: 'LOST'` — never to delete the report, never to
 * substitute placeholder audio, and never to keep claiming the recording is
 * playable. Transcript, extraction and the emergency link are untouched.
 */
export async function reconcileVoiceAudioIntegrity(): Promise<{ checked: number; markedLost: string[] }> {
  const rows = await VoiceReport.find(
    { 'audio.storageKey': { $exists: true, $ne: null } },
    { _id: 1, audio: 1 },
  ).lean();

  const markedLost: string[] = [];
  for (const row of rows) {
    if (row.audio?.status === 'LOST') continue;
    const integrity = await inspectVoiceAudio(row.audio?.storageKey, {
      size: row.audio?.size ?? null,
      checksum: row.audio?.checksum ?? null,
    });
    if (integrity.exists) continue;
    await VoiceReport.updateOne(
      { _id: row._id },
      { $set: { 'audio.status': 'LOST' } },
    ).exec();
    markedLost.push(String(row._id));
  }
  return { checked: rows.length, markedLost };
}

/**
 * Resolves a storage key to an absolute path, refusing anything that escapes
 * the storage root (traversal, absolute paths, `..` segments).
 */
export function resolveWithinRoot(root: string, storageKey: string): string {
  if (!storageKey || storageKey.includes('\0')) {
    throw ApiError.badRequest('Malformed audio storage key');
  }
  const target = resolve(root, storageKey);
  if (target !== root && !target.startsWith(root + sep)) {
    throw ApiError.forbidden('Invalid audio storage key');
  }
  return target;
}

/** Outcome of checking whether a referenced object is really there. */
export interface VoiceAudioIntegrity {
  exists: boolean;
  /** Real size on disk, or null when the object is absent. */
  size: number | null;
  /** True when the stored bytes still match the recorded checksum. */
  checksumMatches: boolean | null;
}

/**
 * Verifies that a `storageKey` really resolves to a stored object.
 *
 * This is the check that the pipeline was missing: a VoiceReport row can
 * outlive the volume it points at (a restored database, a redeploy onto a fresh
 * container, a cleaned temp directory), and nothing used to notice. Callers use
 * this to refuse to advertise a recording that cannot be served, and to repair
 * demo data on boot.
 */
export async function inspectVoiceAudio(
  storageKey: string | null | undefined,
  expected?: { size?: number | null; checksum?: string | null },
): Promise<VoiceAudioIntegrity> {
  if (!storageKey) return { exists: false, size: null, checksumMatches: null };
  let target: string;
  try {
    target = resolveWithinRoot(storageRoot(), storageKey);
  } catch {
    // An unusable key is as good as a missing object for serving purposes.
    return { exists: false, size: null, checksumMatches: null };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    return { exists: false, size: null, checksumMatches: null };
  }
  if (bytes.byteLength === 0) {
    // A zero-byte object is not a recording; treat it as absent.
    return { exists: false, size: 0, checksumMatches: null };
  }
  const checksumMatches = expected?.checksum
    ? createHash('sha256').update(bytes).digest('hex') === expected.checksum
    : null;
  const sizeOk = expected?.size == null || bytes.byteLength === expected.size;
  return { exists: true, size: bytes.byteLength, checksumMatches: checksumMatches ?? (sizeOk ? true : false) };
}

/**
 * Reads a stored recording.
 *
 * The three ways this can fail are kept distinct on purpose, because the UI
 * must never tell a caller that their microphone failed when the truth is that
 * the server lost the artefact:
 *
 *  - no reference at all          → 404 AUDIO_NOT_RECORDED
 *  - reference present, no object → 410 AUDIO_OBJECT_MISSING
 *  - object present but corrupt   → 409 AUDIO_CORRUPT
 */
export async function readVoiceAudio(
  storageKey: string,
  expected?: { checksum?: string | null },
): Promise<Buffer> {
  if (!storageKey) throw ApiError.audioNotRecorded();
  const target = resolveWithinRoot(storageRoot(), storageKey);
  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch {
    // The reference exists but the object does not: captured-and-lost, which is
    // NOT the same as never-recorded.
    throw ApiError.audioObjectMissing();
  }
  if (bytes.byteLength === 0) {
    throw ApiError.audioObjectMissing('The stored recording is empty');
  }
  if (expected?.checksum) {
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected.checksum) {
      throw new ApiError(
        409,
        'AUDIO_CORRUPT',
        'The stored recording failed its integrity check',
      );
    }
  }
  return bytes;
}

/** Best-effort removal (used when a draft is discarded). */
export async function deleteVoiceAudio(storageKey: string): Promise<boolean> {
  try {
    const target = resolveWithinRoot(storageRoot(), storageKey);
    // `recursive` removes the per-report folder created next to the file.
    await rm(join(target, '..'), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export { VOICE_AUDIO_FILENAME_PREFIX };
