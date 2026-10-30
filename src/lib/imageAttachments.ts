import type { AttachmentMimeType, EmergencyAttachmentInput } from '../types';

/**
 * Emergency report photos travel as base64 data URLs inside the JSON report
 * (the API contract is JSON in / JSON out, and the server stores them inline
 * on the Emergency document), so there is no multipart/S3 dependency.
 *
 * The limits below mirror server/src/validation/constants.ts — the client
 * checks them for fast feedback, the server enforces them authoritatively.
 */
export const ATTACHMENT_MIME_TYPES: readonly AttachmentMimeType[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
];

/**
 * Max photos per report and max size of a single photo (2 MB). 4 × 2 MB stays
 * under MongoDB's 16 MB per-document limit once base64-encoded, since photos
 * are stored inline on the Emergency document.
 */
export const MAX_ATTACHMENTS = 4;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;

/** The `accept` attribute for the file input. */
export const ATTACHMENT_ACCEPT = ATTACHMENT_MIME_TYPES.join(',');

/** A photo picked in the dialog, held as a data URL until the report is sent. */
export interface StagedAttachment extends EmergencyAttachmentInput {
  /** Local key for the preview grid — dropped before the report is posted. */
  id: string;
}

export interface StagedAttachmentResult {
  accepted: StagedAttachment[];
  /** Per-file human-readable reasons why a file was not attached. */
  rejected: string[];
}

let stagedIdCounter = 0;

function nextStagedId(): string {
  stagedIdCounter += 1;
  return `photo-${Date.now().toString(36)}-${stagedIdCounter}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Could not read ${file.name}`));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(file);
  });
}

/** e.g. `2.4 MB` / `820 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function isSupportedImageType(type: string): type is AttachmentMimeType {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(type);
}

/**
 * Reads picked files into data URLs, skipping anything the server would reject
 * (wrong type, too large, more than MAX_ATTACHMENTS in total). Rejections come
 * back as messages so the form can tell the reporter exactly what was dropped.
 */
export async function stageImageAttachments(
  files: FileList | File[],
  existing: StagedAttachment[] = [],
): Promise<StagedAttachmentResult> {
  const accepted: StagedAttachment[] = [];
  const rejected: string[] = [];
  let remainingSlots = MAX_ATTACHMENTS - existing.length;

  for (const file of Array.from(files)) {
    if (remainingSlots <= 0) {
      rejected.push(
        `Only ${MAX_ATTACHMENTS} photos can be attached to a report — "${file.name}" was skipped.`,
      );
      continue;
    }
    if (!isSupportedImageType(file.type)) {
      rejected.push(`"${file.name}" is not a supported image (PNG, JPEG, WebP or GIF).`);
      continue;
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push(
        `"${file.name}" is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      );
      continue;
    }

    try {
      const dataUrl = await readAsDataUrl(file);
      // Guard against a browser handing back something that isn't actually the
      // declared type, which the server would reject anyway.
      if (!dataUrl.startsWith(`data:${file.type};base64,`)) {
        rejected.push(`"${file.name}" could not be read as a ${file.type} image.`);
        continue;
      }
      accepted.push({
        id: nextStagedId(),
        name: file.name.slice(0, 200),
        mimeType: file.type,
        size: file.size,
        dataUrl,
      });
      remainingSlots -= 1;
    } catch (err) {
      rejected.push(err instanceof Error ? err.message : `"${file.name}" could not be read.`);
    }
  }

  return { accepted, rejected };
}

/** Staged photos → the `attachments` array of the POST /emergencies body. */
export function toAttachmentPayload(staged: StagedAttachment[]): EmergencyAttachmentInput[] {
  return staged.map(({ id: _id, ...attachment }) => attachment);
}