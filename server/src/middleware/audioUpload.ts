import type { RequestHandler } from 'express';
import { ApiError } from '../utils/errors.js';
import { VOICE_AUDIO_FILENAME_PREFIX } from '../validation/constants.js';

/**
 * Minimal, dependency-free `multipart/form-data` reader.
 *
 * RapidAid has no multer/busboy dependency, and adding one is not necessary:
 * a voice recording is a single small binary part plus a handful of scalar
 * fields, so a bounded, well-tested RFC 7578 reader is both simpler and
 * easier to audit than a general streaming parser.
 *
 * Security posture:
 *  - the request is aborted the moment it exceeds the byte cap, so a huge
 *    upload never becomes a huge in-memory buffer;
 *  - filenames are reduced to a safe basename (no traversal, no separators);
 *  - only a well-formed declared boundary is honoured.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Binary parts of a parsed multipart body, keyed by field name. */
      files?: Record<string, MultipartFile>;
    }
  }
}

export interface MultipartFile {
  fieldname: string;
  /** Raw bytes. This is what a transcription provider must receive. */
  buffer: Buffer;
  /** Declared MIME type from the part's Content-Type header. */
  mimetype: string;
  /** Sanitized basename of the client-supplied filename. */
  originalname: string;
  size: number;
}

export interface MultipartBody {
  fields: Record<string, string>;
  files: Record<string, MultipartFile>;
}

/** `multipart/form-data; boundary=----X` → `----X`. Throws when absent. */
export function extractBoundary(contentType: string | undefined): string {
  if (!contentType) {
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Expected a multipart/form-data upload');
  }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = (match?.[1] ?? match?.[2])?.trim();
  if (!match || !contentType.toLowerCase().includes('multipart/form-data') || !boundary) {
    throw new ApiError(
      415,
      'UNSUPPORTED_MEDIA_TYPE',
      'Malformed upload: the Content-Type must include the multipart boundary',
    );
  }
  if (boundary.length > 200) {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed multipart boundary');
  }
  return boundary;
}

/** Strips directories, control characters and separators from a client filename. */
export function sanitizeFilename(name: string | undefined): string {
  const base = (name ?? '').split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\/]/g, '').trim();
  return cleaned.slice(0, 120) || 'audio';
}

/** Parses `Content-Disposition: form-data; name="a"; filename="b.webm"`. */
function parseContentDisposition(value: string | undefined): {
  name?: string;
  filename?: string;
} {
  if (!value) return {};
  const name = /\bname="([^"]*)"/i.exec(value)?.[1];
  const filenameStar = /\bfilename\*=(?:UTF-8''|)([^;]+)/i.exec(value)?.[1];
  const filename = /\bfilename="([^"]*)"/i.exec(value)?.[1] ?? filenameStar;
  return { name, filename };
}

function parsePartHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split('\r\n')) {
    const index = line.indexOf(':');
    if (index === -1) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

/**
 * Splits a complete multipart body into fields and files.
 *
 * Operates on the full buffer, which the caller has already bounded, so this
 * scanner never walks unbounded input.
 */
export function parseMultipart(body: Buffer, boundary: string): MultipartBody {
  const fields: Record<string, string> = {};
  const files: Record<string, MultipartFile> = {};

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(delimiter);
  if (cursor === -1) {
    throw new ApiError(400, 'MALFORMED_MULTIPART', 'Multipart body has no boundary delimiter');
  }

  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;
    // `--boundary--` marks the end of the body.
    if (body.slice(partStart, partStart + 2).toString('latin1') === '--') break;
    let headerStart = partStart;
    if (body.slice(headerStart, headerStart + 2).toString('latin1') === '\r\n') headerStart += 2;

    const headerEnd = body.indexOf('\r\n\r\n', headerStart, 'latin1');
    if (headerEnd === -1) {
      throw new ApiError(400, 'MALFORMED_MULTIPART', 'Multipart part is missing its headers');
    }
    const headers = parsePartHeaders(body.slice(headerStart, headerEnd).toString('utf8'));
    const contentStart = headerEnd + 4;

    const nextDelimiter = body.indexOf(delimiter, contentStart);
    const contentEnd = nextDelimiter === -1 ? body.length : nextDelimiter;
    // Trim the CRLF that precedes the next delimiter.
    const content = body.slice(contentStart, Math.max(contentStart, contentEnd - 2));

    const { name, filename } = parseContentDisposition(headers['content-disposition']);
    if (name) {
      if (filename !== undefined) {
        files[name] = {
          fieldname: name,
          buffer: content,
          mimetype: (headers['content-type'] ?? 'application/octet-stream')
            .split(';')[0]
            .trim()
            .toLowerCase(),
          originalname: sanitizeFilename(filename),
          size: content.byteLength,
        };
      } else {
        fields[name] = content.toString('utf8');
      }
    }

    cursor = nextDelimiter;
  }

  return { fields, files };
}

export interface AudioUploadOptions {
  /** Form field carrying the recording. Defaults to `audio`. */
  field?: string;
  /** Byte cap for the whole request. */
  maxBytes: number;
  /** Also expose every non-file field on `req.body`. Defaults to true. */
  exposeFieldsAsBody?: boolean;
}

/**
 * Reads a `multipart/form-data` body into `req.files` / `req.body`.
 *
 * The client MUST NOT hand-set the `Content-Type` header on a `FormData`
 * request — the browser appends `multipart/form-data; boundary=…` itself.
 * If that header is wrong (a hand-written `multipart/form-data` with no
 * boundary), this middleware answers 415 with an explicit message.
 */
export function audioUpload(options: AudioUploadOptions): RequestHandler {
  const field = options.field ?? 'audio';
  return (req, _res, next) => {
    try {
      const boundary = extractBoundary(req.header('content-type'));
      const declaredLength = Number(req.header('content-length') ?? '0');
      if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
        throw new ApiError(
          413,
          'AUDIO_TOO_LARGE',
          `Upload is larger than the ${(options.maxBytes / 1024 / 1024).toFixed(0)} MB limit`,
        );
      }

      const chunks: Buffer[] = [];
      let total = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        total += chunk.byteLength;
        if (total > options.maxBytes) {
          aborted = true;
          next(
            new ApiError(
              413,
              'AUDIO_TOO_LARGE',
              `Upload is larger than the ${(options.maxBytes / 1024 / 1024).toFixed(0)} MB limit`,
            ),
          );
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          const parsed = parseMultipart(Buffer.concat(chunks), boundary);
          if (!parsed.files[field]) {
            throw new ApiError(
              400,
              'AUDIO_MISSING',
              `No audio file was uploaded (expected a '${field}' file part)`,
            );
          }
          req.files = parsed.files;
          if (options.exposeFieldsAsBody !== false) {
            req.body = { ...req.body, ...parsed.fields };
          }
          next();
        } catch (error) {
          next(error);
        }
      });

      req.on('error', () => {
        if (aborted) return;
        aborted = true;
        next(new ApiError(400, 'UPLOAD_READ_FAILED', 'The upload could not be read'));
      });
    } catch (error) {
      next(error);
    }
  };
}

/** Filename the server assigns to a stored recording. */
export function buildStoredAudioFilename(extension: string, timestamp: number): string {
  return `${VOICE_AUDIO_FILENAME_PREFIX}${timestamp}.${extension}`;
}
