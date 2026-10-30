/**
 * Voice-recording playback: the lifecycle glue between the stored server
 * copy, the local recording blob, and an HTML `<audio>` element.
 *
 * Three problems this module exists to solve:
 *
 * 1. OBJECT-URL LIFECYCLE. `URL.createObjectURL` + an effect cleanup that
 *    calls `URL.revokeObjectURL` is broken under React StrictMode (dev):
 *    effects run setup → cleanup → setup, so the URL is revoked once and,
 *    because `useMemo` does not re-run, never recreated — the player then
 *    shows 0:00 / 0:00 and Play does nothing. `useObjectUrl` creates the URL
 *    *inside* the effect, so every setup mints a fresh live URL and only its
 *    own URL is ever revoked.
 *
 * 2. AUTHENTICATED DELIVERY. The recording endpoint requires a Bearer token;
 *    an `<audio src="...">` can never carry one. `fetchServerRecording` does
 *    an authenticated fetch → Blob so the element can play an object URL
 *    instead. The local recording blob stays available as a fallback — a
 *    server failure never forces the user to re-record.
 *
 * 3. DURATION. MediaRecorder WebM files omit the Duration element (verified
 *    on stored RapidAid recordings), so `audio.duration` is `Infinity`/NaN
 *    and the control renders 0:00 / 0:00 even for a healthy file.
 *    `resolveFiniteDuration` forces the browser to scan to the end and
 *    returns the real duration.
 *
 * The module is DOM-free at import time (aside from React) and every
 * browser-facing dependency is injectable, so the server test suite can run
 * it under Node.
 */
import { useEffect, useState } from 'react';
import { session } from '../api/session';

// ── 1. Object-URL lifecycle ─────────────────────────────────────────────────

export interface UrlOps {
  create(blob: Blob): string;
  revoke(url: string): void;
}

export const browserUrlOps: UrlOps = {
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
};

export interface UrlSession {
  url: string;
  /** Revokes this session's URL exactly once; safe to call repeatedly. */
  dispose(): void;
}

/**
 * Mints an object URL whose disposal only ever touches its own URL.
 * Two sequential sessions (the StrictMode mount → unmount → mount sequence)
 * leave the second session's URL live even after the first disposes.
 */
export function createUrlSession(blob: Blob, ops: UrlOps = browserUrlOps): UrlSession {
  const url = ops.create(blob);
  let disposed = false;
  return {
    url,
    dispose() {
      if (disposed) return;
      disposed = true;
      ops.revoke(url);
    },
  };
}

/**
 * StrictMode-safe `blob → object URL` binding.
 *
 * The URL is created inside the effect (not in `useMemo`), so the dev-mode
 * double-invoke always ends with a freshly minted, still-live URL. Revocation
 * happens only when the blob changes or the component unmounts — never while
 * the audio element is using it.
 */
export function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) {
      setUrl(null);
      return;
    }
    const session_ = createUrlSession(blob);
    setUrl(session_.url);
    return () => session_.dispose();
  }, [blob]);
  return url;
}

// ── 2. Authenticated server delivery ────────────────────────────────────────

export type ServerAudioResult =
  | { ok: true; blob: Blob; status: number; contentType: string; size: number }
  | {
      ok: false;
      status: number;
      message: string;
      /**
       * Stable server code when the failure came from the API envelope
       * (`AUDIO_NOT_RECORDED`, `AUDIO_OBJECT_MISSING`, `AUDIO_CORRUPT`).
       * Callers use it to tell "never recorded" apart from "the server lost the
       * artefact" — the two need very different copy, and neither of them is
       * ever a microphone problem.
       */
      code?: string;
    };

export interface ServerAudioDeps {
  fetchImpl?: typeof fetch;
  getAccessToken?: () => string | null;
  refresh?: () => Promise<string | null>;
  apiBase?: string;
}

/**
 * Turns a failed audio response into a message that names what actually
 * happened.
 *
 * The distinction that matters: the API reports `AUDIO_NOT_RECORDED` when a
 * report simply has no recording, and `AUDIO_OBJECT_MISSING` when the report
 * references audio that the server no longer holds. The old single string
 * ("The stored recording could not be found on the server") described the second
 * case in words that read like the user's recording had failed — which is how a
 * lost server artefact turned into a false microphone accusation.
 */
export function audioFailureMessage(status: number, code?: string | null): string {
  switch (code) {
    case 'AUDIO_NOT_RECORDED':
      return 'No voice recording was captured for this report.';
    case 'AUDIO_OBJECT_MISSING':
      return 'This recording is no longer stored on the server. The report and its transcript are intact.';
    case 'AUDIO_CORRUPT':
      return 'The stored recording failed its integrity check and cannot be played.';
    case 'AUDIO_TOO_LARGE':
      return 'The recording is larger than the upload limit.';
    case 'UNSUPPORTED_AUDIO_TYPE':
    case 'INVALID_AUDIO_CONTENT':
      return 'The stored recording is in an unsupported format.';
    default:
      return failureFor(status);
  }
}

function failureFor(status: number): string {
  switch (status) {
    case 401:
      return 'Audio access is unauthorized — please sign in again.';
    case 403:
      return 'You are not authorized to play this recording.';
    case 404:
      return 'The recording for this report is unavailable.';
    case 410:
      return 'This recording is no longer stored on the server.';
    case 409:
      return 'The stored recording could not be verified.';
    default:
      return `The server could not deliver the recording (HTTP ${status}).`;
  }
}

/**
 * Downloads the stored recording with the session token (one transparent
 * 401 → refresh → retry, mirroring the API client) and returns it as a Blob
 * suitable for `URL.createObjectURL`. Never links the endpoint directly —
 * the token cannot travel on an `<audio src>` request.
 */
export async function fetchServerRecording(
  reportId: string,
  deps: ServerAudioDeps = {},
): Promise<ServerAudioResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const getAccessToken = deps.getAccessToken ?? session.getAccessToken;
  const refresh = deps.refresh ?? session.refresh;
  const apiBase = deps.apiBase ?? session.apiBase;
  const url = `${apiBase}/voice/reports/${encodeURIComponent(reportId)}/audio`;

  const attempt = async (allowRefresh: boolean): Promise<ServerAudioResult> => {
    const headers = new Headers({ Accept: 'audio/*' });
    const token = getAccessToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);

    let res: Response;
    try {
      res = await fetchImpl(url, { headers, credentials: 'include' });
    } catch {
      return { ok: false, status: 0, message: 'Cannot reach the server to load the stored recording.' };
    }

    if (res.status === 401 && allowRefresh) {
      const fresh = await refresh();
      if (fresh) return attempt(false);
      return { ok: false, status: 401, message: audioFailureMessage(401) };
    }
    if (!res.ok) {
      // The API envelope carries a stable code that separates "no recording was
      // ever made" from "the stored object is gone" from "it failed integrity".
      // Reading it is what lets the UI say something true about each.
      let code: string | undefined;
      try {
        const body = (await res.clone().json()) as { error?: { code?: string } };
        code = body?.error?.code;
      } catch {
        /* non-JSON body: the status alone is the best we have */
      }
      return { ok: false, status: res.status, message: audioFailureMessage(res.status, code), code };
    }

    const contentType = res.headers.get('content-type') ?? '';
    const blob = await res.blob();
    if (blob.size === 0) {
      return { ok: false, status: res.status, message: 'The server returned an empty recording.' };
    }
    if (contentType && !contentType.startsWith('audio/')) {
      // Defence in depth: a JSON/HTML body with status 200 must never reach
      // the player (it would render as 0:00 / 0:00 with a dead Play button).
      return {
        ok: false,
        status: res.status,
        message: `The server responded with ${contentType} instead of audio.`,
      };
    }
    return { ok: true, blob, status: res.status, contentType, size: blob.size };
  };

  return attempt(true);
}

// ── 3. Duration ─────────────────────────────────────────────────────────────

/** Far-future seek target that forces a browser to scan a file to its end. */
export const SEEK_SCAN_TIME = 1e101;

/** The subset of HTMLMediaElement `resolveFiniteDuration` needs (fakeable). */
export interface DurationProbe {
  duration: number;
  currentTime: number;
  addEventListener(type: 'durationchange' | 'timeupdate' | 'seeked', listener: () => void): void;
  removeEventListener(type: 'durationchange' | 'timeupdate' | 'seeked', listener: () => void): void;
}

/**
 * Returns a real duration for media whose container carries no Duration
 * element (every MediaRecorder WebM): if `duration` is not a finite positive
 * number, seek to the end of the stream, read the value the browser computes,
 * and rewind. Resolves `null` when the browser never produces one.
 */
export function resolveFiniteDuration(
  media: DurationProbe,
  timeoutMs = 2500,
): Promise<number | null> {
  if (Number.isFinite(media.duration) && media.duration > 0) {
    return Promise.resolve(media.duration);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      media.removeEventListener('durationchange', onChange);
      media.removeEventListener('timeupdate', onChange);
      try {
        media.currentTime = 0; // rewind after the scan
      } catch {
        /* element may already be detached */
      }
      resolve(value);
    };
    const onChange = (): void => {
      if (Number.isFinite(media.duration) && media.duration > 0) finish(media.duration);
    };
    media.addEventListener('durationchange', onChange);
    media.addEventListener('timeupdate', onChange);
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      media.currentTime = SEEK_SCAN_TIME;
    } catch {
      finish(null);
    }
  });
}

// ── 4. Media error reporting ────────────────────────────────────────────────

/** Maps `HTMLMediaElement.error.code` to a specific, showable message. */
export function describeMediaError(code: number | null | undefined): string {
  switch (code) {
    case 1: // MEDIA_ERR_ABORTED
      return 'Playback of the recording was interrupted before it finished loading.';
    case 2: // MEDIA_ERR_NETWORK
      return 'The audio could not be loaded from the server — check your connection and retry.';
    case 3: // MEDIA_ERR_DECODE
      return 'The stored recording could not be decoded — the file may be corrupted.';
    case 4: // MEDIA_ERR_SRC_NOT_SUPPORTED
      return 'This browser cannot load the recording. It may be unauthorized or in an unsupported format.';
    default:
      return 'The audio could not be loaded.';
  }
}
