import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { Emergency, IdempotencyKey, User, VoiceReport } from '../src/models/index.js';
import { computeRequestHash, formatScopedIdempotencyKey } from '../src/middleware/idempotency.js';
import { invalidateGazetteerCache } from '../src/services/geocodingService.js';

const app = createApp();
const STORAGE = join(tmpdir(), `rapidaid-phase1-idempotency-${process.pid}`);
useTestDatabase(runSeed, STORAGE);

beforeAll(() => {
  invalidateGazetteerCache();
});

afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

/** A minimal valid EBML/WebM audio buffer */
function webmAudio(bytes = 1024): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

/** Formats RFC 7578 multipart body matching RapidAid custom audioUpload parser */
function multipartVoice(
  fields: Record<string, string>,
  audio: Buffer,
  filename = 'recording.webm',
  mime = 'audio/webm',
): { body: Buffer; contentType: string } {
  const boundary = `----IdempotencyBoundary${process.pid}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
  chunks.push(
    Buffer.from(
      `Content-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(audio);
  chunks.push(Buffer.from('\r\n', 'utf8'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function sendVoiceRecording(
  token: string,
  fields: Record<string, string>,
  audio: Buffer,
  headers: Record<string, string> = {},
  filename = 'recording.webm',
) {
  const { body, contentType } = multipartVoice(fields, audio, filename);
  return request(app)
    .post('/api/voice/reports/recording')
    .set(bearer(token))
    .set({ 'Content-Type': contentType, ...headers })
    .send(body);
}

describe('Phase 1 - Voice Upload Idempotency & Safe Duplicate Handling', () => {
  it('supports Idempotency-Key and replays the original completed response for identical duplicate', async () => {
    const token = await loginAs(app, 'citizen');
    const idempotencyKey = 'client-voice-uuid-001';
    const audio = webmAudio();
    const fields = {
      transcript: 'Crash near Connaught Place with severe injuries',
      durationSeconds: '5',
      deviceLatitude: '28.6139',
      deviceLongitude: '77.2090',
    };

    // First request
    const firstRes = await sendVoiceRecording(token, fields, audio, {
      'Idempotency-Key': idempotencyKey,
    });

    expect(firstRes.status).toBe(201);
    expect(firstRes.body).toHaveProperty('report');
    expect(firstRes.body.report.id).toMatch(/^VR-\d{3}$/);
    expect(firstRes.body.emergency).toBeTruthy();
    expect(firstRes.body.emergency.id).toMatch(/^EMG-\d{5}$/);
    const createdEmergencyId = firstRes.body.emergency.id;

    // Second request with SAME key and SAME payload
    const duplicateRes = await sendVoiceRecording(token, fields, audio, {
      'Idempotency-Key': idempotencyKey,
    });

    // Must replay original status and emergency without creating a second emergency
    expect(duplicateRes.status).toBe(201);
    expect(duplicateRes.header['idempotent-replayed']).toBe('true');
    expect(duplicateRes.body.emergency.id).toBe(createdEmergencyId);
    expect(duplicateRes.body.report.id).toBe(firstRes.body.report.id);

    // Verify only 1 emergency exists in database for this key
    const count = await Emergency.countDocuments({ idempotencyKey: { $regex: idempotencyKey } });
    expect(count).toBe(1);
  });

  it('supports x-idempotency-key header interchangeably with Idempotency-Key', async () => {
    const token = await loginAs(app, 'citizen');
    const idempotencyKey = 'client-voice-x-key-002';
    const audio = webmAudio();
    const fields = {
      transcript: 'Fire reported near Lajpat Nagar metro',
      durationSeconds: '4',
      deviceLatitude: '28.5677',
      deviceLongitude: '77.2433',
    };

    const firstRes = await sendVoiceRecording(token, fields, audio, {
      'x-idempotency-key': idempotencyKey,
    });

    expect(firstRes.status).toBe(201);

    const secondRes = await sendVoiceRecording(token, fields, audio, {
      'x-idempotency-key': idempotencyKey,
    });

    expect(secondRes.status).toBe(201);
    expect(secondRes.header['idempotent-replayed']).toBe('true');
    expect(secondRes.body.emergency.id).toBe(firstRes.body.emergency.id);
  });

  it('produces different payload hashes for identical form fields with different audio bytes', () => {
    const fields = { transcript: 'Chest pain at Hauz Khas market', durationSeconds: '6' };
    const audioA = webmAudio(1024);
    const audioB = webmAudio(2048);

    const hashA = computeRequestHash(fields, audioA);
    const hashB = computeRequestHash(fields, audioB);
    const hashNoAudio = computeRequestHash(fields, null);

    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(hashNoAudio);
    expect(hashB).not.toBe(hashNoAudio);
  });

  it('rejects reusing the same key with different audio bytes on identical form fields with 409 Conflict', async () => {
    const token = await loginAs(app, 'citizen');
    const idempotencyKey = 'client-voice-conflict-key-003';
    const audio1 = webmAudio(1024);
    const audio2 = webmAudio(2048); // different audio length/bytes
    const fields = {
      transcript: 'Chest pain at Hauz Khas market',
      durationSeconds: '6',
      deviceLatitude: '28.5494',
      deviceLongitude: '77.2001',
    };

    const firstRes = await sendVoiceRecording(token, fields, audio1, {
      'Idempotency-Key': idempotencyKey,
    });

    expect(firstRes.status).toBe(201);

    // Reusing same key with SAME text fields but DIFFERENT audio bytes
    const conflictRes = await sendVoiceRecording(token, fields, audio2, {
      'Idempotency-Key': idempotencyKey,
    });

    expect(conflictRes.status).toBe(409);
    expect(conflictRes.body.error.code).toBe('CONFLICT');
    expect(conflictRes.body.error.message).toMatch(/different payload/i);
  });

  it('rejects concurrent in-progress duplicate requests with 409 Conflict', async () => {
    const token = await loginAs(app, 'citizen');
    const citizenUser = await User.findOne({ email: 'citizen@rapidaid.com' }).lean();
    const userId = citizenUser ? String(citizenUser._id) : 'USR-008';
    const endpoint = 'POST /api/voice/reports/recording';
    const idempotencyKey = 'client-voice-in-progress-key-004';
    const audio = webmAudio();
    const payloadFields = {
      transcript: 'Crash at AIIMS circle',
      durationSeconds: '3',
      deviceLatitude: '28.5672',
      deviceLongitude: '77.2100',
    };
    const requestHash = computeRequestHash(payloadFields, audio);

    // Simulate an IN_PROGRESS idempotency record directly with all schema-required fields
    await IdempotencyKey.create({
      key: idempotencyKey,
      scope: userId,
      endpoint,
      status: 'IN_PROGRESS',
      requestHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const inProgressRes = await sendVoiceRecording(token, payloadFields, audio, {
      'Idempotency-Key': idempotencyKey,
    });

    expect(inProgressRes.status).toBe(409);
    expect(inProgressRes.body.error.code).toBe('CONFLICT');
    expect(inProgressRes.body.error.message).toMatch(/already in progress/i);
  });

  it('recovers safely if crash occurred after emergency creation but before idempotency record completion', async () => {
    const token = await loginAs(app, 'citizen');
    const citizenUser = await User.findOne({ email: 'citizen@rapidaid.com' }).lean();
    const userId = citizenUser ? String(citizenUser._id) : 'USR-008';
    const endpoint = 'POST /api/voice/reports/recording';
    const idempotencyKey = 'client-voice-crash-recovery-key-005';
    const scopedKey = formatScopedIdempotencyKey(userId, endpoint, idempotencyKey);
    const audio = webmAudio();
    const payloadFields = {
      transcript: 'Crash at recovery scene',
      durationSeconds: '5',
      deviceLatitude: '28.6139',
      deviceLongitude: '77.2090',
    };
    const requestHash = computeRequestHash(payloadFields, audio);

    // Simulate partial failure: emergency exists in DB with idempotencyKey,
    // but IdempotencyKey record is stuck IN_PROGRESS
    const existingEmergency = await Emergency.create({
      _id: 'EMG-99991',
      incidentType: 'VEHICLE_COLLISION',
      priority: 'HIGH',
      status: 'REPORTED',
      source: 'VOICE_REPORT',
      citizenId: userId,
      location: { lat: 28.6139, lng: 77.209, address: 'Recovered Scene' },
      description: 'Crash at recovery scene',
      reportedAt: new Date(),
      idempotencyKey: scopedKey,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const existingReport = await VoiceReport.create({
      _id: 'VR-991',
      transcript: 'Crash at recovery scene',
      confidence: 90,
      extractedData: {
        incidentType: 'VEHICLE_COLLISION',
        location: 'Recovered Scene',
      },
      status: 'CONFIRMED',
      emergencyId: existingEmergency._id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Leave idempotency record as IN_PROGRESS with required schema fields
    await IdempotencyKey.create({
      key: idempotencyKey,
      scope: userId,
      endpoint,
      status: 'IN_PROGRESS',
      requestHash,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // When the client retries with the same idempotency key and payload, recovery detects
    // the existing emergency and reconstructs the successful response instead of failing
    const retryRes = await sendVoiceRecording(token, payloadFields, audio, {
      'Idempotency-Key': idempotencyKey,
    });

    expect(retryRes.status).toBe(201);
    expect(retryRes.header['idempotent-replayed']).toBe('true');
    expect(retryRes.body.emergency.id || retryRes.body.emergency._id).toBe(existingEmergency._id);
    expect(retryRes.body.report.id || retryRes.body.report._id).toBe(existingReport._id);
  });

  it('preserves legacy clients without idempotency keys safely without blocking or collision', async () => {
    const token = await loginAs(app, 'citizen');
    const audio = webmAudio();

    // Request without any Idempotency-Key header
    const legacyRes = await sendVoiceRecording(
      token,
      {
        transcript: 'Legacy crash report without key near Red Fort',
        durationSeconds: '4',
        deviceLatitude: '28.6562',
        deviceLongitude: '77.2410',
      },
      audio,
    );

    expect(legacyRes.status).toBe(201);
    expect(legacyRes.body.emergency).toBeTruthy();
    expect(legacyRes.header['idempotent-replayed']).toBeUndefined();
  });

  it('does not create a phantom emergency when location cannot be resolved', async () => {
    const token = await loginAs(app, 'citizen');
    const idempotencyKey = 'client-voice-unresolved-loc-006';

    const res = await sendVoiceRecording(
      token,
      { transcript: 'Hello can anyone hear me no location mentioned anywhere', durationSeconds: '4' },
      webmAudio(),
      { 'Idempotency-Key': idempotencyKey },
    );

    // Report draft is created, but no emergency is created due to unresolved location (status 202 Accepted)
    expect(res.status).toBe(202);
    expect(res.body.report).toBeTruthy();
    expect(res.body.emergency).toBeNull();
    expect(res.body.report.status).toBe('DRAFT');

    // Verify in DB that no emergency was inserted
    const emergency = await Emergency.findOne({ idempotencyKey: { $regex: idempotencyKey } });
    expect(emergency).toBeNull();
  });

  it('does not deduplicate legitimate separate emergency reports with different keys even if audio is identical', async () => {
    const token = await loginAs(app, 'citizen');
    const sharedAudio = webmAudio(1500);
    const fields = {
      transcript: 'Accident at Connaught Place outer circle',
      durationSeconds: '5',
      deviceLatitude: '28.6328',
      deviceLongitude: '77.2197',
    };

    // Call 1 from citizen for incident A
    const res1 = await sendVoiceRecording(token, fields, sharedAudio, {
      'Idempotency-Key': 'legit-call-alpha-007',
    });

    // Call 2 with a different key (e.g. repeated report or second citizen)
    const res2 = await sendVoiceRecording(token, fields, sharedAudio, {
      'Idempotency-Key': 'legit-call-beta-008',
    });

    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res1.body.emergency.id).not.toBe(res2.body.emergency.id);
  });
});
