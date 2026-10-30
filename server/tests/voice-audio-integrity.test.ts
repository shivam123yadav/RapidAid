import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import {
  storeVoiceAudio,
  readVoiceAudio,
  inspectVoiceAudio,
  reconcileVoiceAudioIntegrity,
  storageRoot,
  resolveWithinRoot,
} from '../src/services/voiceAudioStorage.js';
import { isPlayableAudio } from '../src/authz/voiceReportAccess.js';
import { VoiceReport } from '../src/models/index.js';

/**
 * REGRESSION: "the transcript is available but the recording cannot be loaded".
 *
 * The failure pinned here is a DANGLING REFERENCE — a VoiceReport row that
 * advertises a recording the storage layer cannot produce. That is what made the
 * UI show a healthy transcript next to "the stored recording could not be found
 * on the server", and what let a lost artefact be reported as if the user had
 * failed to record anything.
 *
 * Four guarantees keep it from returning:
 *   1. a stored key is verified to exist before it is ever returned;
 *   2. reading distinguishes "never recorded" from "object lost" from "corrupt";
 *   3. a dangling reference is detected and marked, never silently advertised;
 *   4. the API answers with those precise codes instead of a generic 404.
 */
const app = createApp();
useTestDatabase(runSeed);

const STORAGE = join(tmpdir(), `rapidaid-audio-integrity-${process.pid}`);
beforeAll(() => {
  process.env.VOICE_AUDIO_STORAGE_DIR = STORAGE;
});
afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

/** Structurally valid WebM (EBML header) so the signature check passes. */
function webmAudio(bytes = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

function multipart(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }>,
): { body: Buffer; contentType: string } {
  const boundary = '----IntegrityBoundary91a7';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if ('value' in part) {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`, 'utf8'));
    } else {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.mime}\r\n\r\n`,
          'utf8',
        ),
      );
      chunks.push(part.data);
      chunks.push(Buffer.from('\r\n', 'utf8'));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function upload(token: string, data: Buffer, transcript = 'Accident near Rajwada Square in Indore.') {
  const { body, contentType } = multipart([
    { name: 'audio', filename: 'voice.webm', mime: 'audio/webm', data },
    { name: 'transcript', value: transcript },
  ]);
  return request(app).post('/api/voice/reports/recording').set(bearer(token))
    .set({ 'Content-Type': contentType }).send(body);
}

describe('1. a stored key is verified before it is ever returned', () => {
  it('storeVoiceAudio only returns a key whose object really exists and matches', async () => {
    const stored = await storeVoiceAudio({ audio: webmAudio(4096), ownerId: 'USR-001', declaredMimeType: 'audio/webm' });

    const integrity = await inspectVoiceAudio(stored.storageKey, {
      size: stored.size,
      checksum: stored.checksum,
    });
    expect(integrity.exists).toBe(true);
    expect(integrity.size).toBe(stored.size);
    expect(integrity.checksumMatches).toBe(true);

    // The bytes on disk are the bytes that were handed in — the ORIGINAL audio,
    // never a re-encode.
    const onDisk = await readFile(resolveWithinRoot(storageRoot(), stored.storageKey));
    expect(onDisk.equals(webmAudio(4096))).toBe(true);
  });
});

describe('2. read failures are distinct and honest', () => {
  it('a missing key is AUDIO_NOT_RECORDED, not a lost object', async () => {
    await expect(readVoiceAudio('')).rejects.toMatchObject({
      status: 404,
      code: 'AUDIO_NOT_RECORDED',
    });
  });

  it('a key whose object is gone is AUDIO_OBJECT_MISSING (410)', async () => {
    const stored = await storeVoiceAudio({ audio: webmAudio(1024), ownerId: 'USR-002', declaredMimeType: 'audio/webm' });
    // Simulate the object disappearing (lost volume / cleaned temp dir).
    await rm(resolveWithinRoot(storageRoot(), stored.storageKey));

    await expect(readVoiceAudio(stored.storageKey)).rejects.toMatchObject({
      status: 410,
      code: 'AUDIO_OBJECT_MISSING',
    });
  });

  it('a tampered object fails its checksum rather than being served', async () => {
    const stored = await storeVoiceAudio({ audio: webmAudio(1024), ownerId: 'USR-003', declaredMimeType: 'audio/webm' });
    const target = resolveWithinRoot(storageRoot(), stored.storageKey);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, webmAudio(2048)); // same container, different bytes

    await expect(readVoiceAudio(stored.storageKey, { checksum: stored.checksum })).rejects.toMatchObject({
      status: 409,
      code: 'AUDIO_CORRUPT',
    });
  });
});

describe('3. dangling references are detected and never advertised', () => {
  it('a reference with no object is reported missing by inspectVoiceAudio', async () => {
    const stored = await storeVoiceAudio({ audio: webmAudio(512), ownerId: 'USR-004', declaredMimeType: 'audio/webm' });
    await rm(resolveWithinRoot(storageRoot(), stored.storageKey));
    const integrity = await inspectVoiceAudio(stored.storageKey, { size: stored.size });
    expect(integrity.exists).toBe(false);
  });

  it('reconcileVoiceAudioIntegrity marks a lost recording LOST and keeps everything else', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(2048));
    expect(created.status).toBe(201);
    const reportId = created.body.report.id as string;

    // Remove the object behind the report's back, as a lost volume would.
    const key = created.body.report.audio.storageKey as string;
    await rm(resolveWithinRoot(storageRoot(), key));

    const result = await reconcileVoiceAudioIntegrity();
    expect(result.markedLost).toContain(reportId);

    const after = await VoiceReport.findById(reportId).lean();
    // Marked honestly…
    expect(after?.audio?.status).toBe('LOST');
    // …the transcript and the emergency link are untouched…
    expect(after?.transcript).toContain('Rajwada');
    expect(after?.emergencyId).toBeTruthy();
    // …and it is no longer advertised as playable.
    expect(isPlayableAudio(after?.audio)).toBe(false);
  });

  it('a healthy recording is never marked LOST', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(3072));
    const reportId = created.body.report.id as string;
    await reconcileVoiceAudioIntegrity();
    const after = await VoiceReport.findById(reportId).lean();
    expect(after?.audio?.status).toBe('STORED');
    expect(isPlayableAudio(after?.audio)).toBe(true);
  });
});


describe('4. the API answers with the precise code', () => {
  it('a stored recording is served as real bytes with the recorded MIME type', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(4096));
    const res = await request(app)
      .get(`/api/voice/reports/${created.body.report.id as string}/audio`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('audio/webm');
    expect(Number(res.headers['content-length'])).toBe(4096 + 12);
    expect(res.body.length).toBe(4096 + 12);
  });

  it('Range still works on a healthy recording (206 / 416)', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(4096));
    const url = `/api/voice/reports/${created.body.report.id as string}/audio`;

    const slice = await request(app).get(url).set(bearer(token)).set('Range', 'bytes=0-9');
    expect(slice.status).toBe(206);
    expect(slice.headers['content-range']).toMatch(/^bytes 0-9\/\d+$/);
    expect(slice.body.length).toBe(10);

    const beyond = await request(app)
      .get(url).set(bearer(token)).set('Range', 'bytes=99999999-');
    expect(beyond.status).toBe(416);
  });

  it('a report with no audio is AUDIO_NOT_RECORDED (404)', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await request(app).post('/api/voice/reports').set(bearer(token))
      .send({ transcript: 'A transcript-only draft with no recording at all.' });
    expect(created.status).toBe(201);
    const res = await request(app)
      .get(`/api/voice/reports/${created.body.id as string}/audio`)
      .set(bearer(token));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('AUDIO_NOT_RECORDED');
  });

  it('a LOST recording answers 410 AUDIO_OBJECT_MISSING, not a generic 404', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(1024));
    const reportId = created.body.report.id as string;
    await rm(resolveWithinRoot(storageRoot(), created.body.report.audio.storageKey as string));
    await reconcileVoiceAudioIntegrity();

    const res = await request(app).get(`/api/voice/reports/${reportId}/audio`).set(bearer(token));
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('AUDIO_OBJECT_MISSING');
  });

  it('a lost recording still refuses unauthorized callers (401, never the detail)', async () => {
    const token = await loginAs(app, 'citizen');
    const created = await upload(token, webmAudio(1024));
    const reportId = created.body.report.id as string;
    await rm(resolveWithinRoot(storageRoot(), created.body.report.audio.storageKey as string));

    // Unauthenticated: still 401, never the 410 detail.
    expect((await request(app).get(`/api/voice/reports/${reportId}/audio`)).status).toBe(401);
  });
});

