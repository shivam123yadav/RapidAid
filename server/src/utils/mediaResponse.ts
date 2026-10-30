import type { Response } from 'express';

/**
 * HTTP byte-range support for the voice-recording media endpoint.
 *
 * HTML5 `<audio>` may issue `Range: bytes=…` requests (always, in practice,
 * once the user seeks). Express's `res.send(Buffer)` does NOT honour Range —
 * it always answers 200 — so the media endpoint parses the header itself and
 * answers correctly:
 *
 *   no / ignorable Range → 200 with the full body + Accept-Ranges: bytes
 *   valid single range    → 206 + Content-Range + the exact byte slice
 *   invalid / unsatisfiable → 416 with the RFC 9110 unsatisfied Content-Range
 *     (the `bytes` unit, an asterisk, then the total size)
 *
 * The parser is a pure function so every branch is unit-testable without a
 * server. Multi-range requests are intentionally answered with the full body
 * (RFC 9110 permits a server to ignore Range) — multipart/byteranges is not
 * needed for this endpoint.
 */

export type ByteRangeOutcome =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;

/** Parses a `Range` header for a resource of `size` bytes. Never throws. */
export function parseByteRange(header: string | undefined, size: number): ByteRangeOutcome {
  const raw = header?.trim();
  if (!raw) return { kind: 'full' };
  // Multi-range → serve the full body (allowed; avoids multipart responses).
  if (raw.includes(',')) return { kind: 'full' };

  const match = SINGLE_RANGE.exec(raw);
  if (!match) return { kind: 'unsatisfiable' }; // malformed, e.g. `bytes=abc`

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'unsatisfiable' }; // `bytes=-`

  if (rawStart === '') {
    // Suffix range: last N bytes (`bytes=-500`).
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) {
      return { kind: 'unsatisfiable' };
    }
    const start = Math.max(0, size - suffix);
    return { kind: 'partial', start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };

  const end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}

export interface MediaPayload {
  bytes: Buffer;
  contentType: string;
  filename: string;
  /**
   * `inline` (default) streams for the `<audio>` element; `attachment` makes
   * the browser save the file — used by the separately-permissioned download
   * endpoint, which is a different right from listening.
   */
  disposition?: 'inline' | 'attachment';
}

/**
 * Writes `payload` to `res` with full Range semantics. Binary only — this
 * endpoint must never emit JSON/HTML bodies for media requests.
 */
export function sendMedia(req: { header(name: string): string | undefined }, res: Response, payload: MediaPayload): void {
  const size = payload.bytes.byteLength;
  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `${payload.disposition ?? 'inline'}; filename="${payload.filename}"`);
  // Recordings are patient data: never cached by a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store');

  const outcome = parseByteRange(req.header('range'), size);
  if (outcome.kind === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }
  if (outcome.kind === 'partial') {
    const chunk = payload.bytes.subarray(outcome.start, outcome.end + 1);
    res.setHeader('Content-Range', `bytes ${outcome.start}-${outcome.end}/${size}`);
    res.setHeader('Content-Length', String(chunk.byteLength));
    res.status(206).end(chunk);
    return;
  }
  res.setHeader('Content-Length', String(size));
  res.status(200).end(payload.bytes);
}
