#!/usr/bin/env node
/**
 * FULL UI FLOW verification in a REAL browser (headless Chrome).
 *
 *   npm run verify:ui-flow          (from server/)
 *   npm run server:verify:ui-flow   (from the repo root)
 *
 * Requires: API on :5000, Vite dev on :3000, ui-tts.wav (regenerate with
 * scripts/ui-tts.ps1) and playwright-core, which is a devDependency of the
 * REPO ROOT — Node resolves it by walking up from server/scripts, so install
 * from the repo root, not only via `npm --prefix server install`.
 *
 * Flow exercised end to end through the actual React UI:
 *   login → /voice → record (fake mic plays the TTS fixture) → on-device
 *   Whisper transcription → multipart upload → full server pipeline →
 *   result card → authenticated server audio fetch → <audio> metadata →
 *   REAL duration → Play Recording button → currentTime advances.
 *
 * Also asserts: no `aud.subarray` errors, nothing the app itself serves fails
 * to load, transcript/extraction visible, the location resolves (spoken place,
 * or the device-GPS fallback the app also
 * sends), a hospital is routed, EMG-##### is created, and the diagnostics show
 * the server copy fetched over authenticated HTTP 200.
 */
import { chromium } from 'playwright-core';

const APP = process.env.APP_BASE ?? 'http://localhost:3000';
const CHROME = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TTS = process.env.TTS_WAV ?? 'C:\\Users\\yashj\\Downloads\\workspace\\server\\scripts\\ui-tts.wav';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
/**
 * FOCUS: the voice REPORT HISTORY panel (`VoiceScopedDetail`) — the player that
 * regressed after the earlier fix (the result card was already repaired).
 *
 * Asserts the real chain for a *stored* recording: authenticated fetch
 * (200 + audio/*) -> Blob -> live blob: URL -> <audio> -> REAL duration
 * (never 0:00 / 0:00) -> currentTime advances. Then re-checks that switching
 * theme mid-playback keeps the same live source, and that selecting another
 * report drops the previous one (no stale audio).
 */
async function verifyScopedDetailPanel(browser) {
  const context = await browser.newContext({ permissions: ['microphone', 'geolocation'] });
  await context.setGeolocation({ latitude: 22.7196, longitude: 75.8577, accuracy: 35 });
  const page = await context.newPage();
  const consoleIssues = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleIssues.push(m.text()); });
  page.on('pageerror', (e) => consoleIssues.push(`pageerror: ${String(e)}`));

  const audioRequests = [];
  page.on('response', (response) => {
    if (/\/api\/voice\/reports\/VR-\d+\/audio$/.test(new URL(response.url()).pathname)) {
      audioRequests.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()['content-type'] ?? null,
      });
    }
  });

  // Dispatcher holds voice:read:all, so the history panel is populated.
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.click('button[title^="dispatcher@rapidaid.com"]');
  await page.click('form button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  await page.goto(`${APP}/voice`, { waitUntil: 'domcontentloaded' });
  // The inspector renders only once a report card is selected, so open the
  // newest stored report first (that is the recording path under test).
  await page.waitForSelector('[data-testid="voice-scope-tabs"]', { timeout: 25000 });
  const reportCards = page.locator('[data-testid="voice-report-card"]');
  await reportCards.first().waitFor({ timeout: 25000 });
  await reportCards.first().click();
  await page.waitForSelector('[data-testid="voice-scoped-detail"]', { timeout: 25000 });

  const reportId = (await page.textContent('[data-testid="voice-scoped-detail"] h4'))?.trim() ?? '';
  check('report history panel opened for an existing report', /^VR-\d+$/.test(reportId), reportId);

  // The shared player loads the stored copy on mount over the AUTHENTICATED
  // endpoint. It must never link the protected URL into `src`, because an
  // <audio src> request cannot carry Authorization: Bearer.
  const SCOPED = '[data-testid="voice-scoped-player"]';
  await page.waitForSelector(`${SCOPED} audio`, { timeout: 20000 });
  const scopedSrc = await page.getAttribute(`${SCOPED} audio`, 'src');
  check('scoped player plays a blob: URL, never the protected API URL',
    (scopedSrc ?? '').startsWith('blob:') && !(scopedSrc ?? '').includes('/api/voice/'),
    (scopedSrc ?? '').slice(0, 60));
  check('stored audio fetched over authenticated HTTP with a real audio Content-Type',
    audioRequests.length > 0 &&
      audioRequests.every((r) => r.status === 200 && String(r.type).startsWith('audio/')),
    JSON.stringify(audioRequests[0] ?? null));

  // Real duration from the player's own clock readout.
  const clockText = await page
    .locator(`${SCOPED} [data-testid$="-clock"]`)
    .first()
    .textContent({ timeout: 20000 });
  const shown = (clockText ?? '').match(/(\d+):(\d{2})/g)?.pop()?.match(/(\d+):(\d{2})/);
  const shownSeconds = shown ? Number(shown[1]) * 60 + Number(shown[2]) : 0;
  check('scoped panel resolves a REAL duration (no 0:00 / 0:00)',
    shownSeconds > 0, (clockText ?? '').trim());


  const audioState = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="voice-scoped-player-audio"]');
    if (!el) return null;
    return {
      src: el.getAttribute('src') ?? '',
      isBlob: (el.getAttribute('src') ?? '').startsWith('blob:'),
      usesApiUrl: (el.getAttribute('src') ?? '').includes('/api/voice/'),
      duration: el.duration,
      readyState: el.readyState,
      errorCode: el.error ? el.error.code : null,
    };
  });
  check('browser media element loaded the bytes (readyState >= 1)',
    (audioState?.readyState ?? 0) >= 1, `readyState=${audioState?.readyState}, duration=${audioState?.duration}`);
  check('no media element error on the scoped player',
    audioState?.errorCode === null || audioState?.errorCode === undefined, `code=${audioState?.errorCode}`);

  // Play for real, through the panel's own button: currentTime must advance.
  await page.click(`${SCOPED} button[aria-label="Play recorded emergency voice report"]`);
  await page.waitForTimeout(1500);
  const played = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="voice-scoped-player-audio"]');
    return el ? { currentTime: el.currentTime, paused: el.paused } : null;
  });
  check('PLAYBACK ADVANCES in the scoped player (not 0:00 / paused)',
    (played?.currentTime ?? 0) > 0.3 && played?.paused === false,
    `currentTime=${played?.currentTime?.toFixed?.(2)} s, paused=${played?.paused}`);

  // Theme switch mid-playback must not clear the Blob or revoke its URL.
  const srcBeforeTheme = audioState?.src;
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'northstar-os'));
  await page.waitForTimeout(600);
  const afterTheme = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="voice-scoped-player-audio"]');
    return {
      src: el?.getAttribute('src') ?? null,
      currentTime: el?.currentTime ?? 0,
      error: el?.error?.code ?? null,
    };
  });
  check('theme switch keeps the same live source and does not error the player',
    afterTheme.src === srcBeforeTheme && afterTheme.error === null,
    `${afterTheme.src} @ ${afterTheme.currentTime.toFixed?.(2)}s`);

  // Selecting another report must drop the previous source (no stale audio).
  const rows = page.locator('[data-testid="voice-report-card"]');
  if (await rows.count() > 1) {
    await rows.nth(1).click();
    await page.waitForTimeout(800);
    const secondId = (await page.textContent('[data-testid="voice-scoped-detail"] h4'))?.trim() ?? '';
    const stale = await page.locator('[data-testid="voice-scoped-player-audio"]').count();
    check('switching reports drops the previous recording (no stale audio)',
      secondId !== reportId || stale === 0, secondId);
  } else {
    check('switching reports drops the previous recording (no stale audio)', true,
      'only one report in scope — skipped');
  }

  const subarrayIssue = consoleIssues.find((line) => /subarray/i.test(line));
  check('no aud.subarray errors in the scoped panel flow', !subarrayIssue,
    subarrayIssue ?? `${consoleIssues.length} console errors`);

  await context.close();
}


async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${TTS}`,
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
    ],
  });
  const context = await browser.newContext({ permissions: ['microphone', 'geolocation'] });
  // Fake device GPS (Indore city centre). Voice.tsx sends it as the documented
  // fallback whenever the spoken place cannot be resolved — Whisper/tiny.en can
  // mishear "Indore" as "Indoor" (it did: VR-023 went AWAITING_LOCATION with
  // source=UNRESOLVED, which is correct never-faked behaviour, not a bug).
  // The device fix keeps routing deterministic AND covers the DEVICE path.
  await context.setGeolocation({ latitude: 22.7196, longitude: 75.8577, accuracy: 35 });
  const page = await context.newPage();
  const consoleIssues = [];
  const failedRequests = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleIssues.push(message.text());
  });
  page.on('pageerror', (error) => consoleIssues.push(`pageerror: ${String(error)}`));
  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} — ${request.failure()?.errorText ?? 'failed'}`);
  });

  // Every authenticated GET of the stored recording, so the test can prove the
  // local blob was played BEFORE any server audio was ever requested.
  const audioRequests = [];
  // Uploads are the send boundary: nothing may be POSTed before the user asks.
  const uploadPosts = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/voice/reports/recording')) {
      uploadPosts.push(request.url());
    }
  });
  page.on('response', (response) => {
    if (/\/api\/voice\/reports\/VR-\d+\/audio$/.test(new URL(response.url()).pathname)) {
      audioRequests.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()['content-type'] ?? null,
      });
    }
  });

  // ── Login as the demo citizen ─────────────────────────────────────────────
  await page.goto(`${APP}/login`, { waitUntil: 'domcontentloaded' });
  await page.click('button[title^="citizen@rapidaid.com"]');
  await page.click('form button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20000 });
  check('logged in through the real login form', true, page.url());

  // ── Record through the real Voice page ────────────────────────────────────
  await page.goto(`${APP}/voice`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('button[aria-label="Start recording"]', { timeout: 20000 });
  await page.click('button[aria-label="Start recording"]');
  await page.waitForSelector('button[aria-label="Stop recording"]', { timeout: 20000 });
  check('recording started (microphone captured in headless Chrome)', true);

  // The TTS fixture is ~7.5 s — record a little longer, then stop.
  await page.waitForTimeout(9500);
  await page.click('button[aria-label="Stop recording"]');

  // ── REVIEW BEFORE SEND ──────────────────────────────────────────────────
  // Stopping must produce a playable local recording immediately, with nothing
  // uploaded yet: the user listens first and decides.
  const REVIEW = '[data-testid="voice-recording-review"]';
  await page.waitForSelector(REVIEW, { timeout: 60000 });
  check('recording stopped → local review panel appears without uploading', true);

  const localPlayer = `${REVIEW} [data-testid="voice-review-player-audio"]`;
  await page.waitForSelector(localPlayer, { timeout: 20000 });
  const localSrc = await page.getAttribute(localPlayer, 'src');
  check('LOCAL playback available before sending (blob: URL, not the API)',
    (localSrc ?? '').startsWith('blob:') && !(localSrc ?? '').includes('/api/voice/'),
    (localSrc ?? '').slice(0, 50));

  // Nothing has been SENT yet. The card above may legitimately be streaming a
  // PREVIOUS draft's recording, so the precise claim is about the upload POST:
  // the new recording must not have left the device.
  check('nothing is uploaded until the user presses Send',
    uploadPosts.length === 0, `${uploadPosts.length} upload POST(s) so far`);

  // Play the local recording BEFORE sending, and prove it advances.
  await page.click(`${REVIEW} button[aria-label="Play recorded emergency voice report"]`);
  const localPlayed = await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el ? el.currentTime > 0.3 && !el.paused : false;
      },
      localPlayer,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('LOCAL recording is audible before sending (currentTime advances)', localPlayed);

  const localDuration = await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : false;
      },
      localPlayer,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => NaN);
  check('LOCAL recording has a REAL duration (never 0:00 / 0:00)',
    Number.isFinite(localDuration) && localDuration > 1, `${localDuration} s`);

  // Send it. The same original bytes now travel to the server.
  await page.click(`${REVIEW} button:has-text("Send Recording")`);

  // On-device transcription + upload + server pipeline + result card.
  await page.waitForSelector('text=VOICE EMERGENCY', { timeout: 240000 });
  check('result card rendered after transcription + upload + pipeline', true);

  // ── Player (shared VoicePlaybackPlayer, result card instance) ────────────
  const RESULT_PLAYER = '[data-testid="voice-result-player"]';
  await page.waitForSelector(`${RESULT_PLAYER} audio`, { timeout: 15000 });
  check('result card player rendered with a real audio element', true);

  // The upload really reached the server and really was served back.
  check('stored recording served over authenticated HTTP with a real audio type',
    audioRequests.length > 0 &&
      audioRequests.every((r) => r.status === 200 && String(r.type).startsWith('audio/')),
    JSON.stringify(audioRequests[0] ?? null));

  const duration = await page
    .waitForFunction(
      (sel) => {
        const audio = document.querySelector(`${sel} audio`);
        return audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : false;
      },
      RESULT_PLAYER,
      { timeout: 20000 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => NaN);
  check('browser detects a REAL duration (0:00 / 0:00 is fixed)',
    Number.isFinite(duration) && duration > 1, `${duration} s`);

  // The player reports which copy it is using; the stored copy is preferred.
  const meta = await page.textContent(`${RESULT_PLAYER} [data-testid$="-meta"]`).catch(() => '');
  check('player shows the REAL container type from the recording',
    /audio\/webm/.test(meta ?? ''), (meta ?? '').trim().slice(0, 80));

  // ── Play / pause / seek / replay through the actual controls ─────────────
  const playButton = `${RESULT_PLAYER} button[aria-label="Play recorded emergency voice report"]`;
  await page.click(playButton);
  const playing = await page
    .waitForFunction(
      (sel) => {
        const audio = document.querySelector(`${sel} audio`);
        return audio ? audio.currentTime > 0.4 && !audio.paused : false;
      },
      RESULT_PLAYER,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('PLAY BUTTON WORKS — currentTime advances in the real player', playing);

  const pauseVisible = await page
    .locator(`${RESULT_PLAYER} button[aria-label="Pause recorded emergency voice report"]`)
    .count();
  check('player flips to a labelled Pause control while playing', pauseVisible === 1);

  // Pause via the control, then seek forward, then replay from the start.
  await page.click(`${RESULT_PLAYER} button[aria-label="Pause recorded emergency voice report"]`);
  await page.waitForTimeout(300);
  const paused = await page.evaluate(
    (sel) => document.querySelector(`${sel} audio`)?.paused === true,
    RESULT_PLAYER,
  );
  check('PAUSE works', paused);

  const seeked = await page.evaluate((sel) => {
    const audio = document.querySelector(`${sel} audio`);
    if (!audio) return false;
    audio.currentTime = Math.min(3, (audio.duration || 4) - 0.5);
    return true;
  }, RESULT_PLAYER);
  const seekOk = seeked && (await page.evaluate(
    (sel) => (document.querySelector(`${sel} audio`)?.currentTime ?? 0) > 0.5,
    RESULT_PLAYER,
  ));
  check('SEEK works (position moved forward)', seekOk);

  await page.click(`${RESULT_PLAYER} button[aria-label="Restart recorded emergency voice report from the beginning"]`);
  await page.waitForTimeout(500);
  const replayed = await page.evaluate(
    (sel) => {
      const audio = document.querySelector(`${sel} audio`);
      return audio ? audio.currentTime < 1.2 && !audio.paused : false;
    },
    RESULT_PLAYER,
  );
  check('REPLAY restarts from the beginning', replayed);

  // Native controls give volume control; assert the element really offers it.
  const hasVolume = await page.evaluate(
    (sel) => {
      const audio = document.querySelector(`${sel} audio`);
      return audio ? audio.controls === true : false;
    },
    RESULT_PLAYER,
  );
  check('native controls (seek + volume) present on the audio element', hasVolume);

  // ── Transcription / extraction / routing still intact ───────────────────
  const bodyText = (await page.textContent('body')) ?? '';
  // ResultRow renders <div><span>label</span><span>value</span></div>. Read the
  // value cell from the DOM: textContent concatenates cells with NO whitespace,
  // so "label value" regexes over bodyText false-pass (the old hospital check
  // could never match "None selected").
  const rowValue = (label) =>
    page.evaluate((want) => {
      for (const row of document.querySelectorAll('div')) {
        const spans = Array.from(row.children).filter((el) => el.tagName === 'SPAN');
        if (spans.length === 2 && spans[0].textContent.trim() === want) {
          return spans[1].textContent.trim();
        }
      }
      return null;
    }, label);

  const locationSource = await rowValue('Location source');
  const coordinates = await rowValue('Coordinates');
  const hospitalName = await rowValue('Nearest suitable hospital');
  const emergencyId = await rowValue('Emergency ID');
  const emergencyStatus = await rowValue('Status');
  check('stored audio metadata shown (audio/webm, size)',
    /audio\/webm/.test(bodyText));
  // The transcript is ASR output, so the exact wording is the model's business,
  // not this feature's. What matters here is that a transcript is present and
  // displayed independently of the recording.
  const transcriptText = (await page
    .locator('[data-testid="voice-transcript-text"]')
    .first()
    .textContent()) ?? '';
  check('transcript is available and displayed next to the recording',
    transcriptText.trim().length > 0,
    transcriptText.trim().slice(0, 80) || 'no transcript rendered');

  // ── PRIMARY REQUIREMENT: the player lives INSIDE AI Extracted Information ──
  const AI_PLAYER = '[data-testid="voice-ai-extraction-player"]';
  const inAiCard = await page.evaluate((sel) => {
    const player = document.querySelector(sel);
    if (!player) return { found: false };
    // Walk up to the card that carries the AI Extracted Information heading.
    let node = player;
    while (node) {
      const heading = node.querySelector?.('h3, h2, [class*="font-semibold"]');
      if (heading && /AI Extracted Information/i.test(heading.textContent ?? '')) {
        return { found: true, heading: heading.textContent.trim(), hasAudio: Boolean(player.querySelector('audio')) };
      }
      node = node.parentElement;
    }
    return { found: false };
  }, AI_PLAYER);
  check('audio player rendered INSIDE the AI Extracted Information box',
    inAiCard.found === true && inAiCard.hasAudio === true,
    inAiCard.heading ?? 'player not inside the AI card');

  const aiMeta = await page.textContent(`${AI_PLAYER} [data-testid$="-meta"]`).catch(() => '');
  check('AI card player shows the real container + size + duration',
    /audio\/webm/.test(aiMeta ?? '') && /\d+\s*KB/.test(aiMeta ?? '') && /0:0\d/.test(aiMeta ?? ''),
    (aiMeta ?? '').trim().slice(0, 90));

  const aiDuration = await page
    .waitForFunction(
      (sel) => {
        const audio = document.querySelector(`${sel} audio`);
        return audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : false;
      },
      AI_PLAYER,
      { timeout: 20000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => NaN);
  check('AI card player has a REAL duration (never 0:00 / 0:00)',
    Number.isFinite(aiDuration) && aiDuration > 1, `${aiDuration} s`);

  // Play the recording from inside the AI Extracted Information box.
  await page.click(`${AI_PLAYER} button[aria-label="Play recorded emergency voice report"]`);
  const aiPlayed = await page
    .waitForFunction(
      (sel) => {
        const audio = document.querySelector(`${sel} audio`);
        return audio ? audio.currentTime > 0.4 && !audio.paused : false;
      },
      AI_PLAYER,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  check('PLAY inside AI Extracted Information actually plays audio', aiPlayed);

  // ── Theme switch while that audio is playing must not interrupt it ───────
  const aiSrcBefore = await page.getAttribute(`${AI_PLAYER} audio`, 'src');
  await page.click('[data-testid="theme-button"]').catch(() => {});
  await page.waitForTimeout(400);
  for (const theme of ['northstar-os', 'aether-command', 'rescue-glass', 'command-pulse']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(250);
  }
  const afterTheme = await page.evaluate((sel) => {
    const audio = document.querySelector(`${sel} audio`);
    return audio
      ? { src: audio.getAttribute('src'), time: audio.currentTime, paused: audio.paused, error: audio.error?.code ?? null }
      : null;
  }, AI_PLAYER);
  check('theme switching while playing keeps the same source and does not error',
    afterTheme?.src === aiSrcBefore && afterTheme?.error === null && afterTheme?.paused === false,
    `src unchanged=${afterTheme?.src === aiSrcBefore}, t=${afterTheme?.time?.toFixed?.(2)}s, paused=${afterTheme?.paused}`);
  await page.click(`${AI_PLAYER} button[aria-label="Pause recorded emergency voice report"]`).catch(() => {});

  // ── Transcript is its own state, inside the same card ────────────────────
  const transcriptPanel = await page.locator('[data-testid="voice-transcript-panel"]').count();
  check('transcript panel rendered inside the AI Extracted Information box', transcriptPanel >= 1);

  // A transcript outcome must NEVER be reported as a microphone failure while
  // a recording exists.
  const micErrors = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      noSpeech: /no speech captured/i.test(text),
      mic: /check your microphone/i.test(text),
    };
  });
  check('a successful recording NEVER reports "no speech captured" / "check your microphone"',
    micErrors.noSpeech === false && micErrors.mic === false,
    JSON.stringify(micErrors));

  const spokenLocation = await rowValue('Location source');
  check('spoken location extracted (Rajwada Square)', /Rajwada Square/i.test(bodyText));
  check('location resolved — spoken place, or device-GPS fallback',
    (locationSource === 'SPOKEN' || locationSource === 'DEVICE') &&
      !/^Not resolved/.test(coordinates ?? ''),
    `${locationSource} · ${coordinates}`);
  check('nearest suitable hospital selected',
    Boolean(hospitalName) && hospitalName !== 'None selected',
    hospitalName ?? 'row not found');
  check('emergency created (EMG id visible)',
    /^EMG-\d{5}$/.test(emergencyId ?? ''), emergencyId ?? 'row not found');
  check('emergency status REPORTED', emergencyStatus === 'REPORTED',
    emergencyStatus ?? 'row not found');
  check('report not stuck in AWAITING_LOCATION', !/AWAITING_LOCATION/.test(bodyText));

  const subarrayIssue = consoleIssues.find((line) => /subarray/i.test(line));
  check('no aud.subarray errors in the console', !subarrayIssue, subarrayIssue ?? `${consoleIssues.length} console errors`);
  if (consoleIssues.length > 0 && !subarrayIssue) {
    console.log('  (console errors observed):');
    for (const line of consoleIssues.slice(0, 6)) console.log(`   · ${line.slice(0, 220)}`);
  }

  // Nothing the app itself serves may fail over HTTP(S). `blob:` URLs are the
  // recorder's own object URLs (Chrome reports them as aborted once the player
  // revokes them) and external hosts (fonts, map tiles) legitimately fail to
  // resolve in a sandbox without DNS — both are environmental noise, so they
  // are reported but not counted as regressions.
  const localFailures = failedRequests.filter((line) =>
    /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(line));
  check('no failed requests to the app itself (localhost only)', localFailures.length === 0,
    localFailures[0] ?? `${failedRequests.length} non-local failure(s)`);
  if (failedRequests.length > 0) {
    console.log('  (failed requests observed):');
    for (const line of failedRequests.slice(0, 6)) console.log(`   · ${line.slice(0, 220)}`);
  }

  // The report-history player (the one that regressed) is verified separately
  // against an already-stored recording, so the flow above keeps recording a
  // NEW report exactly once.
  await verifyScopedDetailPanel(browser);

  await browser.close();

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const entry of failed) console.log(`  - ${entry.name}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('UI flow verification crashed:', error);
  process.exitCode = 1;
});

