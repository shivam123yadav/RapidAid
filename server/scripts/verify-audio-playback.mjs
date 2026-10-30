#!/usr/bin/env node
/**
 * REAL-BROWSER verification of stored voice-recording playback (headless
 * Chrome via playwright-core + the system Chrome installation).
 *
 *   node scripts/verify-audio-playback.mjs      (API running on :5000)
 *
 * Verifies, in an actual browser engine:
 *   1. the authenticated endpoint returns real binary audio (200, audio/webm,
 *      Accept-Ranges, EBML signature)
 *   2. HTTP Range → 206 + correct Content-Range + exact byte count
 *   3. unauthenticated access → 401 (recordings stay private)
 *   4. blob → <audio> fires `loadedmetadata` (duration initially Infinity —
 *      MediaRecorder WebM carries no Duration element)
 *   5. the seek-scan resolves the REAL duration (> 0) — no 0:00 / 0:00
 *   6. audio.play() actually advances currentTime — Play works
 *   7. ROOT-CAUSE DEMO: the old StrictMode pattern (create URL → revoke) can
 *      never load — proving why the old player was dead
 *   8. no `aud.subarray` / console errors during the flow
 */
import { chromium } from 'playwright-core';
import mongoose from 'mongoose';

const BASE = process.env.API_BASE ?? 'http://localhost:5000';
const MONGO = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/rapidaid';
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function login(email, password, role) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

/** The user's actual recording: the stored report with the largest audio. */
async function findRecordingReport() {
  await mongoose.connect(MONGO);
  try {
    const docs = await mongoose.connection.db
      .collection('voicereports')
      .find({ 'audio.storageKey': { $exists: true } })
      .project({ _id: 1, audio: 1, ownerId: 1 })
      .toArray();
    docs.sort((a, b) => (b.audio?.size ?? 0) - (a.audio?.size ?? 0));
    return docs[0] ?? null;
  } finally {
    await mongoose.disconnect();
  }
}

async function main() {
  const report = await findRecordingReport();
  check('stored recording report found in MongoDB', Boolean(report));
  if (!report) throw new Error('No stored recording to verify');
  const apiPath = `/api/voice/reports/${report._id}/audio`;
  console.log(`  report ${report._id} · ${report.audio.size} bytes · ${report.audio.mimeType} · ${report.audio.filename}`);

  // Dispatcher holds voice:read:all — authorized for any report.
  const token = await login('dispatcher@rapidaid.com', 'demo123', 'DISPATCHER');
  check('dispatcher authenticated', Boolean(token));

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const page = await browser.newPage();
  const consoleIssues = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleIssues.push(message.text());
  });
  page.on('pageerror', (error) => consoleIssues.push(String(error)));

  // Any URL on the API origin sets the document origin for same-origin fetch.
  await page.goto(`${BASE}/api/auth/login`, { waitUntil: 'domcontentloaded' });

  const out = await page.evaluate(async ({ path, bearer }) => {
    const result = {};
    const auth = { Authorization: `Bearer ${bearer}` };

    // 1. Full authenticated GET
    const full = await fetch(path, { headers: auth });
    result.fullStatus = full.status;
    result.contentType = full.headers.get('content-type');
    result.contentLength = full.headers.get('content-length');
    result.acceptRanges = full.headers.get('accept-ranges');
    result.cacheControl = full.headers.get('cache-control');
    const bytes = new Uint8Array(await full.arrayBuffer());
    result.byteLength = bytes.byteLength;
    result.ebml =
      bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;

    // 2. Range request
    const ranged = await fetch(path, { headers: { ...auth, Range: 'bytes=0-99' } });
    result.rangeStatus = ranged.status;
    result.contentRange = ranged.headers.get('content-range');
    result.rangeByteLength = (await ranged.arrayBuffer()).byteLength;

    // 3. Unauthenticated
    result.anonStatus = (await fetch(path)).status;

    // 4. Playback — authenticated fetch → Blob → object URL → <audio>
    const blob = new Blob([bytes], { type: result.contentType || 'audio/webm' });
    result.blobSize = blob.size;
    result.blobType = result.contentType;
    const url = URL.createObjectURL(blob);
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = url;
    document.body.appendChild(audio);

    result.metadata = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ event: 'timeout', duration: audio.duration, readyState: audio.readyState }),
        8000,
      );
      audio.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve({ event: 'loadedmetadata', duration: audio.duration, readyState: audio.readyState });
      });
      audio.addEventListener('error', () => {
        clearTimeout(timer);
        resolve({ event: 'error', code: audio.error ? audio.error.code : null });
      });
    });

    // 5. Duration: scan to the end when the container has no Duration element
    let duration = result.metadata.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      duration = await new Promise((resolve) => {
        const onChange = () => {
          if (Number.isFinite(audio.duration) && audio.duration > 0) {
            cleanup();
            audio.currentTime = 0;
            resolve(audio.duration);
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          audio.currentTime = 0;
          resolve(NaN);
        }, 5000);
        const cleanup = () => {
          audio.removeEventListener('durationchange', onChange);
          audio.removeEventListener('timeupdate', onChange);
          clearTimeout(timer);
        };
        audio.addEventListener('durationchange', onChange);
        audio.addEventListener('timeupdate', onChange);
        audio.currentTime = 1e101;
      });
    }
    result.resolvedDuration = duration;

    // 6. Play
    try {
      await audio.play();
      result.playCalled = true;
    } catch (error) {
      result.playCalled = false;
      result.playError = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result.currentTimeAfter1_5s = audio.currentTime;
    result.pausedAfterPlay = audio.paused;
    result.readyStateAfterPlay = audio.readyState;
    result.audioErrorAfterPlay = audio.error ? audio.error.code : null;
    URL.revokeObjectURL(url);

    // 7. ROOT CAUSE DEMO — the old StrictMode pattern
    const deadUrl = URL.createObjectURL(blob);
    URL.revokeObjectURL(deadUrl); // what the old effect cleanup did
    const dead = document.createElement('audio');
    dead.preload = 'metadata';
    dead.src = deadUrl;
    document.body.appendChild(dead);
    result.deadUrlOutcome = await new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ event: 'timeout', duration: dead.duration, code: dead.error ? dead.error.code : null }),
        4000,
      );
      dead.addEventListener('loadedmetadata', () => {
        clearTimeout(timer);
        resolve({ event: 'loadedmetadata', duration: dead.duration });
      });
      dead.addEventListener('error', () => {
        clearTimeout(timer);
        resolve({ event: 'error', code: dead.error ? dead.error.code : null, duration: dead.duration });
      });
    });

    return result;
  }, { path: apiPath, bearer: token });

  await browser.close();

  // ── Assertions ────────────────────────────────────────────────────────────
  check('HTTP 200 with real binary audio', out.fullStatus === 200 && out.byteLength > 0, `${out.byteLength} bytes`);
  check('Content-Type is audio/webm', out.contentType === 'audio/webm', out.contentType);
  check('Accept-Ranges: bytes advertised', out.acceptRanges === 'bytes', out.acceptRanges);
  check('served bytes start with the EBML signature', out.ebml === true);
  check('Content-Length matches the body', Number(out.contentLength) === out.byteLength, out.contentLength);
  check('Cache-Control keeps recordings private', (out.cacheControl ?? '').includes('private'), out.cacheControl);
  check('Range request → 206 with correct Content-Range',
    out.rangeStatus === 206 && out.contentRange === `bytes 0-99/${out.byteLength}`,
    `${out.rangeStatus} ${out.contentRange}`);
  check('Range request body is exactly the requested slice', out.rangeByteLength === 100, `${out.rangeByteLength} bytes`);
  check('unauthenticated request → 401 (audio stays protected)', out.anonStatus === 401, String(out.anonStatus));

  check('blob carries the right type and size',
    out.blobType === 'audio/webm' && out.blobSize === out.byteLength, `${out.blobType}, ${out.blobSize} B`);
  check('browser fires loadedmetadata (duration read)', out.metadata.event === 'loadedmetadata',
    `event=${out.metadata.event}, raw duration=${out.metadata.duration}`);
  check('REAL duration resolved (no 0:00 / 0:00)',
    Number.isFinite(out.resolvedDuration) && out.resolvedDuration > 0,
    `${out.resolvedDuration} s`);
  check('audio.play() called without error', out.playCalled === true, out.playError ?? 'ok');
  check('PLAYBACK ADVANCES (currentTime moves, not paused)',
    out.currentTimeAfter1_5s > 0.3 && out.pausedAfterPlay === false,
    `currentTime=${out.currentTimeAfter1_5s?.toFixed?.(2)} s after 1.5 s, paused=${out.pausedAfterPlay}`);
  check('no media error after playing', out.audioErrorAfterPlay === null, String(out.audioErrorAfterPlay));

  check('ROOT CAUSE: revoked blob URL (old StrictMode pattern) can never load',
    out.deadUrlOutcome.event !== 'loadedmetadata',
    `event=${out.deadUrlOutcome.event}, code=${out.deadUrlOutcome.code}, duration=${out.deadUrlOutcome.duration}`);

  const subarrayIssue = consoleIssues.find((line) => /subarray/i.test(line));
  check('no aud.subarray errors in the browser console', !subarrayIssue, subarrayIssue ?? `${consoleIssues.length} unrelated console issues`);
  if (consoleIssues.length > 0 && !subarrayIssue) {
    console.log('  (console issues observed):');
    for (const line of consoleIssues.slice(0, 5)) console.log(`   · ${line.slice(0, 200)}`);
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const entry of failed) console.log(`  - ${entry.name}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('playback verification crashed:', error);
  process.exitCode = 1;
});
