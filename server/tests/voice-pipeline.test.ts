import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { AudioConversionError, normalizeAudioToBuffer, isAllowedAudioMimeType } from '../src/services/audioNormalizeService.js';
import { matchesAudioSignature } from '../src/services/voiceAudioStorage.js';
import { extractBoundary, parseMultipart, sanitizeFilename } from '../src/middleware/audioUpload.js';
import { extractSpokenLocation, extractEmergencyInformation } from '../src/services/emergencyExtractionService.js';
import { parseByteRange } from '../src/utils/mediaResponse.js';
import { geocodeSpokenLocation, invalidateGazetteerCache } from '../src/services/geocodingService.js';
import { findNearestEligibleHospital } from '../src/services/hospitalRoutingService.js';
import { transcribeAudio } from '../src/services/transcriptionService.js';
import { Emergency, Hospital, Notification, AuditLog, VoiceReport } from '../src/models/index.js';

/**
 * End-to-end coverage of the voice emergency pipeline, including the regression
 * test for `TypeError: aud.subarray is not a function`.
 */

const app = createApp();
useTestDatabase(runSeed);

/** Stored recordings live in a temp directory for the duration of the suite. */
const STORAGE = join(tmpdir(), `rapidaid-voice-tests-${process.pid}`);
beforeAll(() => {
  process.env.VOICE_AUDIO_STORAGE_DIR = STORAGE;
  invalidateGazetteerCache();
});
afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

/** A minimal but *structurally valid* WebM (EBML) header + padding. */
function webmAudio(bytes = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

function wavAudio(bytes = 2048): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(bytes, 40);
  return Buffer.concat([header, Buffer.alloc(bytes, 0)]);
}

/** Builds a real multipart body, exactly as a browser would. */
function multipart(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }>,
): { body: Buffer; contentType: string } {
  const boundary = '----RapidAidTestBoundary7f3a91';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));
    if ('value' in part) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      );
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
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function upload(
  token: string,
  parts: Parameters<typeof multipart>[0],
  headers: Record<string, string> = {},
) {
  const { body, contentType } = multipart(parts);
  return request(app)
    .post('/api/voice/reports/recording')
    .set(bearer(token))
    .set({ 'Content-Type': contentType, ...headers })
    .send(body);
}

const ACCEPTANCE_TRANSCRIPT =
  'Accident near Rajwada Square in Indore. Two people are injured. Please send an ambulance.';

/** Mirrors `VOICE_AUDIO_FILENAME_PREFIX` in validation/constants.ts. */
const STORED_FILENAME_PATTERN = /^voice-emergency-\d+\.[a-z0-9]+$/;

describe('audio normalization (server side)', () => {
  it('3. returns a Buffer unchanged', () => {
    const input = Buffer.from([1, 2, 3, 4]);
    expect(normalizeAudioToBuffer(input)).toBe(input);
  });

  it('4. converts a Uint8Array to a Buffer', () => {
    const result = normalizeAudioToBuffer(new Uint8Array([9, 8, 7]));
    expect(Buffer.isBuffer(result)).toBe(true);
    expect([...result]).toEqual([9, 8, 7]);
  });

  it('5. converts an ArrayBuffer to a Buffer', () => {
    const result = normalizeAudioToBuffer(new Uint8Array([1, 2, 3]).buffer);
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBe(3);
  });

  it('6. decodes base64 and data-URL audio', () => {
    const raw = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    expect([...normalizeAudioToBuffer(raw.toString('base64'))]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect([
      ...normalizeAudioToBuffer(`data:audio/webm;base64,${raw.toString('base64')}`),
    ]).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('7. rejects invalid audio input with a typed error', () => {
    expect(() => normalizeAudioToBuffer(null)).toThrow(AudioConversionError);
    expect(() => normalizeAudioToBuffer({ nope: 1 } as never)).toThrow(/Unsupported audio container/);
    expect(() => normalizeAudioToBuffer(42 as never)).toThrow(AudioConversionError);
  });

  it('unwraps a multipart file part (the { buffer, mimetype } shape)', () => {
    const file = { buffer: Buffer.from([1, 2, 3]), mimetype: 'audio/webm', size: 3 };
    expect([...normalizeAudioToBuffer(file)]).toEqual([1, 2, 3]);
  });
});

describe('multipart upload parsing', () => {
  it('1/2. parses a browser-shaped multipart body into one file + fields', () => {
    const { body, contentType } = multipart([
      { name: 'audio', filename: 'voice.webm', mime: 'audio/webm', data: webmAudio(64) },
      { name: 'transcript', value: 'Accident near Rajwada Square in Indore.' },
    ]);
    const parsed = parseMultipart(body, extractBoundary(contentType));
    expect(parsed.files.audio.mimetype).toBe('audio/webm');
    expect(parsed.files.audio.originalname).toBe('voice.webm');
    expect(parsed.files.audio.size).toBeGreaterThan(0);
    expect(Buffer.isBuffer(parsed.files.audio.buffer)).toBe(true);
    expect(parsed.fields.transcript).toContain('Rajwada');
  });

  it('rejects a Content-Type without a boundary (the classic hand-set header)', () => {
    expect(() => extractBoundary('multipart/form-data')).toThrow(/boundary/i);
    expect(() => extractBoundary('application/json')).toThrow(/multipart/);
  });

  it('sanitizes client filenames', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\temp\\evil.exe')).toBe('evil.exe');
    expect(sanitizeFilename('')).toBe('audio');
  });

  it('validates audio bytes against container signatures', () => {
    expect(matchesAudioSignature(webmAudio(), 'audio/webm')).toBe(true);
    expect(matchesAudioSignature(wavAudio(), 'audio/wav')).toBe(true);
    // A renamed executable must not pass as audio.
    expect(matchesAudioSignature(Buffer.from('MZevil.exe'), 'audio/webm')).toBe(false);
    expect(isAllowedAudioMimeType('audio/webm')).toBe(true);
    expect(isAllowedAudioMimeType('application/x-msdownload')).toBe(false);
  });

  it('builds a canonical stored filename from the real container type', () => {
    expect(STORED_FILENAME_PATTERN.test('voice-emergency-1700000000000.webm')).toBe(true);
  });
});

describe('transcription adapter', () => {
  it('8. returns the transcript and safe metadata', async () => {
    const result = await transcribeAudio(webmAudio(), 'audio/webm', 'voice.webm', {
      clientTranscript: 'Accident near Rajwada Square in Indore.',
    });
    expect(result.status).toBe('COMPLETED');
    expect(result.provider).toBe('on-device-whisper');
    expect(result.text).toContain('Rajwada');
    expect(result.audioShape.isBuffer).toBe(true);
    // Metadata only — never the samples.
    expect(result.audioShape).not.toHaveProperty('buffer');
  });

  it('9. reports a clean failure instead of throwing when no provider exists', async () => {
    const result = await transcribeAudio(webmAudio(), 'audio/webm', 'voice.webm', {});
    expect(result.status).toBe('FAILED');
    expect(result.provider).toBe('none');
    expect(result.error).toMatch(/transcript/i);
  });

  it('rejects an empty recording outright', async () => {
    await expect(transcribeAudio(Buffer.alloc(0), 'audio/webm', 'a.webm', {})).rejects.toThrow(
      /empty/i,
    );
  });
});

describe('spoken location extraction (10, 11)', () => {
  const context = {
    knownCities: ['Indore', 'New Delhi'],
    knownStates: ['Madhya Pradesh', 'Delhi'],
  };

  it.each([
    ['Accident near Rajwada Square in Indore. Two people are injured.', 'Rajwada Square', 'Indore'],
    ['Fire near Vijay Nagar Square in Indore, please send ambulance', 'Vijay Nagar Square', 'Indore'],
    ['Accident happened near Palasia', 'Palasia', null],
    ['Someone collapsed near Phoenix Citadel', 'Phoenix Citadel', null],
    ['There is a fire at Rau', 'Rau', null],
    ['Need ambulance near Rajwada', 'Rajwada', null],
    ['Road accident near Vijay Nagar', 'Vijay Nagar', null],
    [
      'Accident near Rajwada Square, Indore. Two people are injured and need an ambulance.',
      'Rajwada Square',
      'Indore',
    ],
  ])('extracts the spoken location from %j', (transcript, landmark, city) => {
    const result = extractSpokenLocation(transcript, context);
    expect(result.spokenLocation).toBeTruthy();
    if (city) expect(result.city).toBe(city);
    expect(result.spokenLocation).toContain(landmark);
  });

  it('never invents a location when none was spoken', () => {
    const result = extractSpokenLocation(
      'Please send an ambulance quickly, someone needs help.',
      context,
    );
    expect(result.spokenLocation).toBeNull();
    expect(result.city).toBeNull();
    expect(result.landmarks).toEqual([]);
  });

  it('extracts type, severity and injured people', () => {
    const info = extractEmergencyInformation(ACCEPTANCE_TRANSCRIPT, context);
    expect(info.emergencyType).toBe('VEHICLE_COLLISION');
    expect(info.injuredPeople).toBe(2);
    expect(['HIGH', 'CRITICAL']).toContain(info.severity);
    expect(info.spokenLocation).toContain('Rajwada Square');
  });

  it('raises severity to CRITICAL for life-threatening phrases', () => {
    const info = extractEmergencyInformation(
      'Someone collapsed near Rajwada Square in Indore and is not breathing.',
      context,
    );
    expect(info.severity).toBe('CRITICAL');
    expect(info.dispatchHints.length).toBeGreaterThan(0);
  });
});

describe('geocoding (12, 13)', () => {
  it('12. resolves a spoken city using the hospital-network gazetteer', async () => {
    invalidateGazetteerCache();
    const result = await geocodeSpokenLocation({ query: 'Rajwada Square, Indore', city: 'Indore' });
    expect(result.resolved).toBe(true);
    expect(result.source).toBe('SPOKEN');
    // Centroid of the Indore facilities, not a hardcoded constant.
    expect(result.latitude).toBeGreaterThan(22);
    expect(result.latitude).toBeLessThan(23);
    expect(result.longitude).toBeGreaterThan(75);
    expect(result.longitude).toBeLessThan(76);
  });

  it('13. reports UNRESOLVED rather than inventing coordinates', async () => {
    invalidateGazetteerCache();
    const result = await geocodeSpokenLocation({ query: 'Zzzq Nowhere Territory' });
    expect(result.resolved).toBe(false);
    expect(result.latitude).toBeNull();
    expect(result.longitude).toBeNull();
    expect(result.status).toBe('UNRESOLVED');
    expect(result.error).toBeTruthy();
  });
});

describe('nearest hospital selection (15, 16)', () => {
  const INDORE = { latitude: 22.72, longitude: 75.86 };

  it('15. picks the nearest ACTIVE eligible hospital from the database', async () => {
    const outcome = await findNearestEligibleHospital({
      ...INDORE,
      incidentType: 'VEHICLE_COLLISION',
      severity: 'HIGH',
    });
    expect(outcome.hospital).not.toBeNull();
    expect(['HOSP-21', 'HOSP-22']).toContain(outcome.hospital!.hospitalId);
    expect(outcome.distanceMeters).toBeGreaterThan(0);
    // Trauma capability is required for a road accident at HIGH severity.
    expect(outcome.hospital!.traumaAvailable).toBe(true);
  });

  it('routes to a different city for a different spoken location', async () => {
    const indore = await findNearestEligibleHospital({
      ...INDORE, incidentType: 'FIRE', severity: 'MEDIUM',
    });
    const delhi = await findNearestEligibleHospital({
      latitude: 28.61, longitude: 77.2, incidentType: 'FIRE', severity: 'MEDIUM',
    });
    expect(indore.hospital!.hospitalId).not.toBe(delhi.hospital!.hospitalId);
  });

  it('16. excludes OFFLINE and FULL-capacity hospitals', async () => {
    await Hospital.updateOne({ _id: 'HOSP-21' }, { $set: { status: 'OFFLINE' } });
    await Hospital.updateOne({ _id: 'HOSP-22' }, { $set: { emergencyCapacity: 'FULL' } });
    const after = await findNearestEligibleHospital({
      ...INDORE, incidentType: 'FIRE', severity: 'MEDIUM',
    });
    expect(after.hospital).toBeNull();
    expect(after.routingReason).toBe('NO_ELIGIBLE_HOSPITAL');

    await Hospital.updateOne({ _id: 'HOSP-21' }, { $set: { status: 'OPERATIONAL' } });
    await Hospital.updateOne({ _id: 'HOSP-22' }, { $set: { emergencyCapacity: 'AVAILABLE' } });
  });

  it('excludes a deactivated hospital', async () => {
    await Hospital.updateOne({ _id: 'HOSP-22' }, { $set: { active: false } });
    const outcome = await findNearestEligibleHospital({
      ...INDORE, incidentType: 'FIRE', severity: 'MEDIUM',
    });
    expect(outcome.hospital?.hospitalId).not.toBe('HOSP-22');
    await Hospital.updateOne({ _id: 'HOSP-22' }, { $set: { active: true } });
  });

  it('reports NO_ELIGIBLE_HOSPITAL with an actionable reason', async () => {
    const original = await Hospital.find({}).select('_id status').lean();
    await Hospital.updateMany({}, { $set: { status: 'OFFLINE' } });
    const outcome = await findNearestEligibleHospital({
      ...INDORE, incidentType: 'FIRE', severity: 'MEDIUM',
    });
    expect(outcome.hospital).toBeNull();
    expect('reason' in outcome ? outcome.reason : '').toMatch(/no active hospital/i);
    for (const hospital of original) {
      await Hospital.updateOne(
        { _id: hospital._id },
        { $set: { status: hospital.status as 'OPERATIONAL' } },
      );
    }
  });
});

describe('end-to-end voice emergency (14, 17–20, 27)', () => {
  it('runs the full pipeline from an uploaded recording', async () => {
    const token = await loginAs(app, 'citizen');
    const audio = webmAudio(4096);

    const res = await upload(token, [
      { name: 'audio', filename: 'voice.webm', mime: 'audio/webm', data: audio },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
      { name: 'durationSeconds', value: '6' },
    ]);

    expect(res.status).toBe(201);
    // 1/2. Audio stored, with real metadata — never guessed.
    expect(res.body.report.audio.status).toBe('STORED');
    expect(res.body.report.audio.mimeType).toBe('audio/webm');
    expect(res.body.report.audio.size).toBe(audio.length);
    expect(res.body.report.audio.filename).toMatch(/^voice-emergency-\d+\.webm$/);
    expect(res.body.report.audio.storageKey).toMatch(/^USR-\d+\//);
    // 3. Transcript generated and stored.
    expect(res.body.transcript).toBe(ACCEPTANCE_TRANSCRIPT);
    expect(res.body.report.transcription.status).toBe('COMPLETED');
    expect(res.body.report.transcription.provider).toBe('on-device-whisper');
    // 4/5. Extracted information.
    expect(res.body.extractedInformation.emergencyType).toBe('VEHICLE_COLLISION');
    expect(res.body.extractedInformation.injuredPeople).toBe(2);
    expect(res.body.extractedInformation.spokenLocation).toContain('Rajwada Square');
    // 6/7. Location extracted, geocoded, source tracked.
    expect(res.body.location.source).toBe('SPOKEN');
    expect(res.body.location.resolved).toBe(true);
    expect(res.body.location.latitude).toBeCloseTo(22.7, 1);
    // 8/9. Nearest ACTIVE hospital selected from MongoDB.
    expect(res.body.hospital).not.toBeNull();
    expect(['HOSP-21', 'HOSP-22']).toContain(res.body.hospital.hospitalId);
    expect(res.body.hospital.traumaAvailable).toBe(true);
    expect(res.body.distance).toBeGreaterThan(0);
    // 10/11. Emergency created + hospital association stored.
    expect(res.body.emergency.id).toMatch(/^EMG-\d{5}$/);
    expect(res.body.emergency.source).toBe('VOICE_REPORT');
    expect(res.body.emergency.status).toBe('REPORTED');
    expect(res.body.emergency.destinationHospital).toBe(res.body.hospital.hospitalId);
    expect(res.body.report.hospitalRouting.hospitalId).toBe(res.body.hospital.hospitalId);
    // Traceability link persisted by the pipeline (report → emergency).
    expect(res.body.report.emergencyId).toBe(res.body.emergency.id);
    // 13. Dispatch hand-off, not a real-world dispatch action.
    expect(res.body.dispatchStatus).toBe('DISPATCHER_NOTIFIED');
    expect(res.body.hospitalNotificationSent).toBe(true);

    // 12. Everything persisted.
    const stored = await VoiceReport.findById(res.body.report.id).lean();
    expect(stored?.transcript).toBe(ACCEPTANCE_TRANSCRIPT);
    expect(stored?.location?.latitude).toBeCloseTo(res.body.location.latitude!, 5);
    expect(stored?.extractedInformation?.emergencyType).toBe('VEHICLE_COLLISION');

    const emergency = await Emergency.findById(res.body.emergency.id).lean();
    expect(emergency?.destinationHospital).toBe(res.body.hospital.hospitalId);
    expect(emergency?.location?.lat).toBeCloseTo(res.body.location.latitude!, 5);
  });

  it('notifies the hospital and the dispatcher without leaking patient data', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(2048) },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
    ]);
    expect(res.status).toBe(201);
    const emergencyId = res.body.emergency.id as string;

    // 19. Hospital + dispatcher notifications.
    const notifications = await Notification.find({ linkedEmergency: emergencyId }).lean();
    const hospitalNotice = notifications.find(
      (n) => n.hospitalId === res.body.hospital.hospitalId,
    );
    expect(hospitalNotice).toBeTruthy();
    expect(notifications.some((n) => n.audienceRoles?.includes('DISPATCHER'))).toBe(true);
    // Hospital notifications must not leak the citizen's own words or identity.
    // (The incident *location* is deliberately included — a receiving facility
    // needs to know where the patient is.)
    expect(hospitalNotice?.message).not.toContain('Two people are injured');
    expect(hospitalNotice?.message).not.toContain('USR-');

    // 16. Audit entries written.
    const audits = await AuditLog.find({
      resourceId: { $in: [res.body.report.id, emergencyId] },
    }).lean();
    expect(audits.some((a) => a.action === 'voice.report_created')).toBe(true);
    expect(audits.some((a) => a.action === 'voice.emergency_created')).toBe(true);
  });

  it('14. an ambulance is then assigned through the existing RBAC workflow', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(2048) },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
    ]);
    expect(res.status).toBe(201);

    // The citizen cannot assign — RBAC is enforced.
    const forbidden = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(token))
      .send({ emergencyId: res.body.emergency.id, ambulanceId: 'AMB-005' });
    expect(forbidden.status).toBe(403);

    // A dispatcher can.
    const dispatcher = await loginAs(app, 'dispatcher');
    const assigned = await request(app)
      .post('/api/dispatch/assign')
      .set(bearer(dispatcher))
      .send({ emergencyId: res.body.emergency.id, ambulanceId: 'AMB-005' });
    expect(assigned.status).toBe(201);
    expect(assigned.body.emergency.assignedAmbulance).toBe('AMB-005');
  });
});

describe('error states (23, 24) and security (21, 22)', () => {
  it('23. an empty recording does not create an emergency', async () => {
    const token = await loginAs(app, 'citizen');
    const before = await Emergency.countDocuments();
    const res = await upload(token, [
      { name: 'audio', filename: 'empty.webm', mime: 'audio/webm', data: Buffer.alloc(0) },
      { name: 'transcript', value: 'Accident near Rajwada Square in Indore.' },
    ]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUDIO_EMPTY');
    expect(await Emergency.countDocuments()).toBe(before);
  });

  it('rejects a non-audio file masquerading as audio', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      {
        name: 'audio',
        filename: 'evil.webm',
        mime: 'audio/webm',
        data: Buffer.from('MZ\u0090\u0003 this is a windows executable, not audio'),
      },
      { name: 'transcript', value: 'Accident near Rajwada Square in Indore.' },
    ]);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('INVALID_AUDIO_CONTENT');
  });

  it('rejects an unsupported audio container', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'evil.wav', mime: 'application/x-msdownload', data: Buffer.from('MZ') },
      { name: 'transcript', value: 'Accident near Rajwada Square in Indore.' },
    ]);
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_AUDIO_TYPE');
  });

  it('rejects a request with no audio part at all', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [{ name: 'transcript', value: 'Accident somewhere.' }]);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('AUDIO_MISSING');
  });

  it('9. a transcription failure keeps the audio and returns a useful error', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(512) },
      { name: 'transcript', value: '   ' },
    ]);
    // The recording was stored before transcription was attempted.
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.error.code).toBe('TRANSCRIPTION_FAILED');
    expect(res.body.error.message).toMatch(/recording was stored/i);

    const failed = await VoiceReport.findOne({ status: 'FAILED' }).lean();
    expect(failed?.audio?.storageKey).toBeTruthy();
    expect(failed?.transcription?.status).toBe('FAILED');
  });

  it('24. no location does not silently route to a hospital', async () => {
    const token = await loginAs(app, 'citizen');
    const before = await Emergency.countDocuments();
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(512) },
      { name: 'transcript', value: 'Please send an ambulance as quickly as possible right now.' },
    ]);
    // 202: saved, but explicitly not a success.
    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.hospital).toBeNull();
    expect(res.body.dispatchStatus).toBe('AWAITING_LOCATION');
    expect(res.body.location.source).toBe('UNRESOLVED');
    expect(res.body.location.resolved).toBe(false);
    expect(res.body.warning).toMatch(/confirm the location/i);
    expect(await Emergency.countDocuments()).toBe(before);
    // The recording and transcript are still kept.
    const pending = await VoiceReport.findById(res.body.report.id).lean();
    expect(pending?.audio?.storageKey).toBeTruthy();
    expect(pending?.transcript).toContain('ambulance');
  });

  it('24. an unresolvable spoken location does not silently route either', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(512) },
      { name: 'transcript', value: 'Fire near Zzzq Nowhere Territory, please send help now.' },
    ]);
    expect(res.status).toBe(202);
    expect(res.body.location.resolved).toBe(false);
    expect(res.body.hospital).toBeNull();
    expect(res.body.emergency).toBeNull();
  });

  it('falls back to the device GPS when no location is spoken', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(512) },
      { name: 'transcript', value: 'Please send an ambulance right now, someone needs help.' },
      { name: 'deviceLatitude', value: '28.612' },
      { name: 'deviceLongitude', value: '77.21' },
      { name: 'deviceAccuracy', value: '25' },
    ]);
    // 202: device GPS alone without spoken location and confidence < 75% requires human review
    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.report.status).toBe('DRAFT');
    expect(res.body.location.source).toBe('DEVICE');
    expect(res.body.location.latitude).toBeCloseTo(28.612, 3);
    expect(res.body.hospital).not.toBeNull();
    expect(['HOSP-01', 'HOSP-04', 'HOSP-08', 'HOSP-12']).toContain(res.body.hospital.hospitalId);
  });

  it('21. unauthorized users cannot access the voice emergency endpoint', async () => {
    const anonymous = await request(app)
      .post('/api/voice/reports/recording')
      .set('Content-Type', 'multipart/form-data; boundary=x')
      .send('nope');
    expect(anonymous.status).toBe(401);

    // A role with no voice:create permission.
    const analyst = await loginAs(app, 'analyst');
    const res = await upload(analyst, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(512) },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
    ]);
    expect(res.status).toBe(403);
  });

  it('22. a user cannot access another user’s voice recording', async () => {
    const citizen = await loginAs(app, 'citizen');
    const created = await upload(citizen, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(1024) },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
    ]);
    const reportId = created.body.report.id as string;

    // The owner can play their own recording.
    const own = await request(app)
      .get(`/api/voice/reports/${reportId}/audio`)
      .set(bearer(citizen));
    expect(own.status).toBe(200);
    expect(own.headers['content-type']).toBe('audio/webm');
    expect(own.headers['cache-control']).toBe('private, no-store');
    expect(own.body.length).toBeGreaterThan(0);

    // A dispatcher with voice:read:all can too.
    const dispatcher = await loginAs(app, 'dispatcher');
    expect(
      (await request(app).get(`/api/voice/reports/${reportId}/audio`).set(bearer(dispatcher)))
        .status,
    ).toBe(200);

    // Hospital staff hold voice:read:own only — 404, never someone else's audio.
    const hospital = await loginAs(app, 'hospital');
    const denied = await request(app)
      .get(`/api/voice/reports/${reportId}/audio`)
      .set(bearer(hospital));
    expect(denied.status).toBe(404);
  });

  it('rejects a malformed report id on the audio route', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app).get('/api/voice/reports/xx/audio').set(bearer(token));
    expect(res.status).toBe(400);
  });

  it('serves the recording with full HTTP Range support (200 / 206 / 416)', async () => {
    const citizen = await loginAs(app, 'citizen');
    const created = await upload(citizen, [
      { name: 'audio', filename: 'v.webm', mime: 'audio/webm', data: webmAudio(4096) },
      { name: 'transcript', value: ACCEPTANCE_TRANSCRIPT },
    ]);
    expect(created.status).toBe(201);
    const url = `/api/voice/reports/${created.body.report.id as string}/audio`;

    // No Range → 200 full body; the endpoint advertises byte ranges.
    const full = await request(app).get(url).set(bearer(citizen));
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['content-type']).toBe('audio/webm');
    expect(full.headers['cache-control']).toBe('private, no-store');
    expect(Number(full.headers['content-length'])).toBe(full.body.length);
    const size = full.body.length;

    // Valid range → 206 with the exact slice and a correct Content-Range.
    const slice = await request(app).get(url).set(bearer(citizen)).set('Range', 'bytes=10-19');
    expect(slice.status).toBe(206);
    expect(slice.headers['content-range']).toBe(`bytes 10-19/${size}`);
    expect(slice.body.length).toBe(10);
    expect(slice.body.equals(full.body.subarray(10, 20))).toBe(true);

    // Suffix range: last 16 bytes.
    const suffix = await request(app).get(url).set(bearer(citizen)).set('Range', 'bytes=-16');
    expect(suffix.status).toBe(206);
    expect(suffix.headers['content-range']).toBe(`bytes ${size - 16}-${size - 1}/${size}`);
    expect(suffix.body.length).toBe(16);

    // Open-ended range from an offset.
    const tail = await request(app).get(url).set(bearer(citizen)).set('Range', `bytes=${size - 4}-`);
    expect(tail.status).toBe(206);
    expect(tail.body.length).toBe(4);
    expect(tail.body.equals(full.body.subarray(size - 4))).toBe(true);

    // Unsatisfiable range → 416 + Content-Range: bytes */size.
    const beyond = await request(app)
      .get(url).set(bearer(citizen)).set('Range', `bytes=${size + 100}-`);
    expect(beyond.status).toBe(416);
    expect(beyond.headers['content-range']).toBe(`bytes */${size}`);

    // Malformed range → 416 (never a JSON/HTML body with 200).
    const malformed = await request(app).get(url).set(bearer(citizen)).set('Range', 'bytes=abc-def');
    expect(malformed.status).toBe(416);

    // Unauthenticated range requests never leak bytes.
    const anon = await request(app).get(url).set('Range', 'bytes=0-9');
    expect(anon.status).toBe(401);
  });

  it('parseByteRange handles every documented branch', () => {
    expect(parseByteRange(undefined, 100)).toEqual({ kind: 'full' });
    expect(parseByteRange('', 100)).toEqual({ kind: 'full' });
    expect(parseByteRange('bytes=0-99', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
    expect(parseByteRange('bytes=50-', 100)).toEqual({ kind: 'partial', start: 50, end: 99 });
    expect(parseByteRange('bytes=-20', 100)).toEqual({ kind: 'partial', start: 80, end: 99 });
    expect(parseByteRange('bytes=90-200', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseByteRange('bytes=0-0', 100)).toEqual({ kind: 'partial', start: 0, end: 0 });
    // Multi-range: answered with the full body (RFC-permitted).
    expect(parseByteRange('bytes=0-9,20-29', 100)).toEqual({ kind: 'full' });
    // Invalid / unsatisfiable → 416 branch.
    expect(parseByteRange('bytes=abc', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=100-', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=50-10', 100)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=0-9', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseByteRange('bytes=-5', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('existing non-voice workflows still work (25)', () => {
  it('POST /api/emergencies is unchanged', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/emergencies')
      .set(bearer(token))
      .send({
        incidentType: 'FIRE',
        priority: 'HIGH',
        location: { lat: 28.61, lng: 77.2, address: 'Ansari Nagar' },
        description: 'Kitchen fire in a residential block.',
        victimCount: 2,
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^EMG-\d{5}$/);
    expect(res.body.source).toBe('CITIZEN_REPORT');
  });

  it('POST /api/voice/reports (transcript-only draft) is unchanged', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await request(app)
      .post('/api/voice/reports')
      .set(bearer(token))
      .send({
        transcript:
          'There is a crash near Karol Bagh market. Two people injured and bleeding badly, please hurry.',
      });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.extractedData.incidentType).toBe('VEHICLE_COLLISION');
    expect(res.body.extractedData.victimCount).toBe(2);
  });

  it('confirming a transcript-only draft geocodes and routes from the database', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');
    const created = await request(app)
      .post('/api/voice/reports')
      .set(bearer(dispatcher))
      .send({ transcript: 'Fire near Karol Bagh market in New Delhi, please send help.' });
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/voice/reports/${created.body.id}/confirm`)
      .set(bearer(dispatcher))
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.locationSource).toBe('SPOKEN');
    expect(res.body.hospital).not.toBeNull();
    expect(res.body.emergency.destinationHospital).toBe(res.body.hospital.hospitalId);
    // Never the old hardcoded Delhi centroid.
    expect(res.body.emergency.location.lat).not.toBe(28.6139);
  });
});
