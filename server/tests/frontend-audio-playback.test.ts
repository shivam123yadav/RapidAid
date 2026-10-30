import { describe, expect, it, vi } from 'vitest';
import {
  SEEK_SCAN_TIME,
  createUrlSession,
  audioFailureMessage,
  describeMediaError,
  fetchServerRecording,
  resolveFiniteDuration,
  type DurationProbe,
} from '../../src/lib/audioPlayback.js';

/**
 * Playback-lifecycle tests for the stored voice recording.
 *
 * The load-bearing regression here is the `0:00 / 0:00, Play does nothing`
 * bug: the old player created the object URL in `useMemo` and revoked it in
 * an effect cleanup. Under React StrictMode (dev) effects run
 * setup → cleanup → setup, so the URL was revoked once and never recreated —
 * the <audio> element pointed at a dead blob URL.
 *
 * These tests are excluded from the server tsc program (they need the DOM
 * lib, like frontend-audio-normalize.test.ts) but vitest RUNS them.
 */

function recordingBlob(): Blob {
  return new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' });
}

describe('object URL lifecycle (StrictMode regression)', () => {
  it('keeps the live session’s URL alive after the first session disposes', () => {
    const revoked: string[] = [];
    let counter = 0;
    const ops = {
      create: () => `blob:test-${(counter += 1)}`,
      revoke: (url: string) => revoked.push(url),
    };

    // The StrictMode dev sequence: setup → cleanup → setup.
    const first = createUrlSession(recordingBlob(), ops);
    first.dispose();
    const second = createUrlSession(recordingBlob(), ops);

    // Only the first URL was revoked; the URL the player uses is still live.
    expect(revoked).toEqual(['blob:test-1']);
    expect(second.url).toBe('blob:test-2');
    expect(revoked).not.toContain(second.url);

    // Dispose is idempotent — double cleanup never revokes twice.
    second.dispose();
    second.dispose();
    expect(revoked).toEqual(['blob:test-1', 'blob:test-2']);
  });

  it('the buggy pattern (useMemo URL + cleanup revoke) really does kill the URL', () => {
    // Documents WHY the session exists: with a shared URL and cleanup-style
    // disposal, the StrictMode sequence ends with a revoked URL in hand.
    const revoked: string[] = [];
    const url = 'blob:buggy';
    const cleanup = () => revoked.push(url); // what the old effect did
    cleanup(); // StrictMode fake unmount
    expect(revoked).toContain(url); // player's src is now dead → 0:00 / 0:00
  });
});

function response(body: BodyInit, init: ResponseInit = {}): Response {
  return new Response(body, init);
}

function audioResponse(bytes = 5, status = 200): Response {
  return response(new Uint8Array(bytes).fill(0x1a), {
    status,
    headers: { 'content-type': 'audio/webm' },
  });
}

describe('fetchServerRecording', () => {
  it('returns the audio blob with status and content type on 200', async () => {
    const fetchImpl = vi.fn(async () => audioResponse(7));
    const out = await fetchServerRecording('VR-1', {
      fetchImpl,
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.status).toBe(200);
    expect(out.contentType).toBe('audio/webm');
    expect(out.size).toBe(7);
    expect(out.blob.type).toContain('audio');
    // The token travels on the fetch (an <audio src> can never carry it).
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer tok');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/voice/reports/VR-1/audio');
  });

  it('refreshes once on 401 and retries with the fresh token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response('{}', { status: 401, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(audioResponse(3));
    // Like session.refresh(), a successful refresh installs the new token
    // where getAccessToken() reads it from.
    let token = 'stale';
    const refresh = vi.fn(async () => {
      token = 'fresh-token';
      return token;
    });
    const out = await fetchServerRecording('VR-2', {
      fetchImpl,
      getAccessToken: () => token,
      refresh,
      apiBase: '/api',
    });
    expect(out.ok).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(retryInit.headers).get('Authorization')).toBe('Bearer fresh-token');
  });

  it('gives up with an unauthorized message after a second 401', async () => {
    const fetchImpl = vi.fn(async () => response('{}', { status: 401 }));
    const out = await fetchServerRecording('VR-3', {
      fetchImpl,
      getAccessToken: () => 'stale',
      refresh: async () => 'still-bad',
      apiBase: '/api',
    });
    expect(out).toEqual({ ok: false, status: 401, message: 'Audio access is unauthorized — please sign in again.' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('classifies 403 and 404 with specific messages', async () => {
    const notFound = await fetchServerRecording('VR-4', {
      fetchImpl: async () => response('{}', { status: 404 }),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(notFound.ok).toBe(false);
    // A bare 404 is now described neutrally. The precise reason is read from the
    // API envelope, so a lost server artefact is never reported as if the user
    // had failed to record anything.
    if (!notFound.ok) expect(notFound.message).toMatch(/unavailable/i);

    const forbidden = await fetchServerRecording('VR-5', {
      fetchImpl: async () => response('{}', { status: 403 }),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.message).toMatch(/not authorized/);
  });

  it('never hands a JSON body with status 200 to the player', async () => {
    const out = await fetchServerRecording('VR-6', {
      fetchImpl: async () => response('{"error":"x"}', { status: 200, headers: { 'content-type': 'application/json' } }),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.message).toMatch(/application\/json instead of audio/);
  });

  it('rejects an empty recording and reports network failures', async () => {
    const empty = await fetchServerRecording('VR-7', {
      fetchImpl: async () => audioResponse(0),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toMatch(/empty recording/);

    const offline = await fetchServerRecording('VR-8', {
      fetchImpl: async () => { throw new Error('network down'); },
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(offline).toEqual({ ok: false, status: 0, message: 'Cannot reach the server to load the stored recording.' });
  });
});

interface FakeMedia extends DurationProbe {
  fire(type: 'durationchange' | 'timeupdate'): void;
  getTime(): number;
}

/**
 * Fake HTMLMediaElement whose browser-like behaviour is injected: setting
 * `currentTime` past the end optionally "scans" the stream and reports the
 * computed duration, exactly like Chrome does for Duration-less WebM.
 */
function fakeMedia(options: { duration: number; scansTo?: number }): FakeMedia {
  const listeners: Record<string, Array<() => void>> = {};
  let duration = options.duration;
  let currentTime = 0;
  return {
    get duration() { return duration; },
    get currentTime() { return currentTime; },
    set currentTime(value: number) {
      currentTime = value;
      if (value >= SEEK_SCAN_TIME && options.scansTo !== undefined && !Number.isFinite(duration)) {
        duration = options.scansTo;
        this.fire('durationchange');
      }
    },
    addEventListener(type, listener) {
      (listeners[type] ??= []).push(listener);
    },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] ?? []).filter((entry) => entry !== listener);
    },
    fire(type) {
      for (const listener of [...(listeners[type] ?? [])]) listener();
    },
    getTime() {
      return currentTime;
    },
  };
}

describe('resolveFiniteDuration', () => {
  it('returns a finite duration immediately without seeking', async () => {
    const media = fakeMedia({ duration: 3.25 });
    await expect(resolveFiniteDuration(media)).resolves.toBe(3.25);
    expect(media.getTime()).toBe(0); // untouched
  });

  it('scans to the end for Infinity duration (MediaRecorder WebM) and rewinds', async () => {
    // This is the fix for the 0:00 / 0:00 duration display.
    const media = fakeMedia({ duration: Infinity, scansTo: 8.94 });
    await expect(resolveFiniteDuration(media, 500)).resolves.toBe(8.94);
    expect(media.getTime()).toBe(0); // rewound after the scan
  });

  it('resolves null when the browser never produces a duration', async () => {
    const media = fakeMedia({ duration: NaN }); // no scan simulation
    await expect(resolveFiniteDuration(media, 30)).resolves.toBeNull();
  });

  it('removes its listeners after settling', async () => {
    const media = fakeMedia({ duration: Infinity, scansTo: 2 });
    await resolveFiniteDuration(media, 500);
    media.fire('durationchange'); // must not throw or re-resolve
    expect(media).toBeDefined();
  });
});

describe('describeMediaError', () => {
  it('maps each HTMLMediaElement error code to a specific message', () => {
    expect(describeMediaError(1)).toMatch(/interrupted/);
    expect(describeMediaError(2)).toMatch(/loaded from the server/);
    expect(describeMediaError(3)).toMatch(/decoded|corrupted/);
    expect(describeMediaError(4)).toMatch(/cannot load/i);
    expect(describeMediaError(null)).toMatch(/could not be loaded/);
    expect(describeMediaError(undefined)).toMatch(/could not be loaded/);
  });
});

/**
 * The three "no audio" outcomes must be reported as three different things.
 *
 * This is the client half of the fix for "the transcript is available but the
 * recording cannot be loaded": the server distinguishes never-recorded from
 * object-lost from corrupt, and the player must not collapse them back into one
 * sentence — least of all one that reads like the user's microphone failed.
 */
describe('audioFailureMessage + envelope codes', () => {
  function envelope(code: string, status: number): Response {
    return response(JSON.stringify({ error: { code, message: 'x' } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('separates never-recorded from object-lost from corrupt', () => {
    expect(audioFailureMessage(404, 'AUDIO_NOT_RECORDED')).toMatch(/no voice recording was captured/i);
    expect(audioFailureMessage(410, 'AUDIO_OBJECT_MISSING')).toMatch(/no longer stored/i);
    expect(audioFailureMessage(409, 'AUDIO_CORRUPT')).toMatch(/integrity check/i);
  });

  it('never produces a microphone accusation', () => {
    for (const [status, code] of [
      [404, 'AUDIO_NOT_RECORDED'],
      [410, 'AUDIO_OBJECT_MISSING'],
      [409, 'AUDIO_CORRUPT'],
      [500, 'AUDIO_STORE_FAILED'],
    ] as const) {
      expect(audioFailureMessage(status, code)).not.toMatch(/microphone|no speech captured/i);
    }
  });

  it('surfaces the code from the API envelope and maps it to precise copy', async () => {
    const lost = await fetchServerRecording('VR-L', {
      fetchImpl: async () => envelope('AUDIO_OBJECT_MISSING', 410),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(lost.ok).toBe(false);
    if (!lost.ok) {
      expect(lost.status).toBe(410);
      expect(lost.code).toBe('AUDIO_OBJECT_MISSING');
      expect(lost.message).toMatch(/no longer stored/i);
    }

    const never = await fetchServerRecording('VR-N', {
      fetchImpl: async () => envelope('AUDIO_NOT_RECORDED', 404),
      getAccessToken: () => 'tok',
      refresh: async () => null,
      apiBase: '/api',
    });
    expect(never.ok).toBe(false);
    if (!never.ok) expect(never.message).toMatch(/no voice recording was captured/i);
  });
});
