/**
 * Emergency -> voice-report link: the same scopes, proven through the emergency.
 *
 * `GET /api/emergencies/:id` attaches a `voiceReport` block when *this* caller
 * is in scope for the report that emergency was raised from. These tests pin the
 * two properties that make that safe:
 *
 *   1  the link is never WIDER than the emergency read it hangs off - a caller
 *      who may read the incident does not thereby learn about a recording
 *   2  the link is never WIDER than `GET /api/voice/reports/:id` - both call
 *      the same authorizer, so the emergency path cannot become a bypass
 *
 * Plus the negative cases that matter operationally: a refused emergency leaks
 * nothing, an Analyst still cannot hear raw audio *through this route*, and
 * merely seeing the block writes no audit row.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { AuditLog, Emergency, VoiceReport } from '../src/models/index.js';
import { storeVoiceAudio } from '../src/services/voiceAudioStorage.js';

/**
 * Fixtures store their own recordings in a temp directory for this suite.
 *
 * The directory is handed to `useTestDatabase` so it is in place BEFORE the
 * seeder writes the demo recordings. Repointing it in a later `beforeAll`
 * would orphan what the seeder just stored.
 */
const app = createApp();
const STORAGE = join(tmpdir(), `rapidaid-emergency-voice-link-${process.pid}`);
useTestDatabase(runSeed, STORAGE);
afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

/** A structurally valid WebM (EBML header + padding). */
function webmAudio(bytes = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

async function storedAudioRecord(ownerId: string, seconds = 7) {
  const stored = await storeVoiceAudio({
    audio: webmAudio(),
    ownerId,
    declaredMimeType: 'audio/webm',
    durationSeconds: seconds,
  });
  return { ...stored, status: 'STORED' };
}

// --- Fixtures ---------------------------------------------------------------
/** Citizen-owned, crew USR-002 assigned, routed to HOSP-01. Still live. */
const LIVE_EMERGENCY = 'EMG-91001';
const LIVE_REPORT = 'VR-911';
/** Assigned to a stranger, routed to another hospital. Nobody may read it here. */
const FOREIGN_EMERGENCY = 'EMG-91002';
const FOREIGN_REPORT = 'VR-912';
/** Finished incident, confirmed report - the historical/evidence set. */
const CLOSED_EMERGENCY = 'EMG-91003';
const CLOSED_REPORT = 'VR-913';
/** The citizen's own incident, but the report filed against it is not theirs. */
const OWN_EMERGENCY = 'EMG-91004';
const FOREIGN_OWNED_REPORT = 'VR-914';

const emergencyBase = {
  priority: 'HIGH',
  incidentType: 'VEHICLE_COLLISION',
  location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' },
  source: 'VOICE_REPORT',
  description: 'Two people injured in a collision',
  victimCount: 2,
  reportedAt: new Date('2026-01-15T09:00:00Z'),
  updatedAt: new Date('2026-01-15T09:00:00Z'),
};

const reportBase = {
  transcript: 'Accident near Rajwada Square in Indore. Two people are injured.',
  extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square, Indore', victimCount: 2, description: 'Collision' },
  confidence: 88,
  createdAt: new Date('2026-01-15T09:01:00Z'),
};

beforeAll(async () => {
  const created = await request(app)
    .post('/api/admin/users')
    .set(bearer(await loginAs(app, 'admin')))
    .send({ name: 'Other Citizen', email: 'othercitizen@rapidaid.com', password: 'demo12345', role: 'CITIZEN' });
  if (created.status !== 201) throw new Error(`fixture citizen failed: ${created.status}`);
  const secondCitizenId = created.body.id as string;

  await Emergency.create([
    { _id: LIVE_EMERGENCY, citizenId: 'USR-008', assignedCrewIds: ['USR-002'], status: 'EN_ROUTE', destinationHospital: 'HOSP-01', assignedDispatcher: 'USR-001', ...emergencyBase },
    { _id: FOREIGN_EMERGENCY, citizenId: 'USR-008', assignedCrewIds: ['USR-777'], assignedAmbulance: 'AMB-900', status: 'EN_ROUTE', destinationHospital: 'HOSP-22', assignedDispatcher: 'USR-777', ...emergencyBase },
    { _id: CLOSED_EMERGENCY, citizenId: 'USR-777', assignedCrewIds: ['USR-002'], status: 'COMPLETED', destinationHospital: 'HOSP-01', assignedDispatcher: 'USR-999', ...emergencyBase },
    { _id: OWN_EMERGENCY, citizenId: 'USR-008', assignedCrewIds: ['USR-002'], status: 'EN_ROUTE', destinationHospital: 'HOSP-01', assignedDispatcher: 'USR-001', ...emergencyBase },
  ]);

  await VoiceReport.create([
    { _id: LIVE_REPORT, ownerId: 'USR-008', emergencyId: LIVE_EMERGENCY, status: 'DRAFT', audio: await storedAudioRecord('USR-008'), hospitalRouting: { hospitalId: 'HOSP-01', hospitalName: 'AIIMS Trauma Center', distance: 1200, routingReason: 'NEAREST_ELIGIBLE', selectedAt: new Date() }, ...reportBase },
    { _id: FOREIGN_REPORT, ownerId: 'USR-008', emergencyId: FOREIGN_EMERGENCY, status: 'DRAFT', audio: await storedAudioRecord('USR-008'), hospitalRouting: { hospitalId: 'HOSP-22', hospitalName: 'Choithram Maniram Hospital', distance: 900, routingReason: 'NEAREST_ELIGIBLE', selectedAt: new Date() }, ...reportBase },
    { _id: CLOSED_REPORT, ownerId: 'USR-777', emergencyId: CLOSED_EMERGENCY, status: 'CONFIRMED', audio: await storedAudioRecord('USR-777'), hospitalRouting: { hospitalId: 'HOSP-01', hospitalName: 'AIIMS Trauma Center', selectedAt: new Date() }, ...reportBase },
    { _id: FOREIGN_OWNED_REPORT, ownerId: secondCitizenId, emergencyId: OWN_EMERGENCY, status: 'DRAFT', audio: await storedAudioRecord(secondCitizenId), ...reportBase },
  ]);
});

// --- Helpers ----------------------------------------------------------------

interface VoiceLink {
  id: string;
  status: string;
  accessLabel: string;
  capabilities: Record<string, boolean>;
}

const emergencyWithLink = (token: string, id: string) =>
  request(app).get(`/api/emergencies/${id}`).set(bearer(token));

const linkOf = (res: { body: Record<string, unknown> }): VoiceLink | null =>
  (res.body.voiceReport as VoiceLink | null) ?? null;

/** Asserts a serialized response carries no transcript and no audio key. */
function expectNoLeak(res: { body: unknown }, reportId: string) {
  const raw = JSON.stringify(res.body);
  expect(raw, 'response must not contain the transcript').not.toContain('Rajwada Square in Indore');
  expect(raw, 'response must not contain an audio storage key').not.toContain('storageKey');
  expect(raw, 'response must not name the linked report').not.toContain(reportId);
}

/** Polls for an audit row: auditing is fire-and-forget and may land just after. */
async function waitForAudit(action: string, resourceId: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await AuditLog.findOne({ action, resourceId }).lean();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

const voiceAuditCount = (resourceId: string) =>
  AuditLog.countDocuments({ resourceId, action: { $regex: '^voice\\.' } });

// --- Tests ------------------------------------------------------------------

describe('emergency -> voice report link', () => {
  it('gives assigned crew the report for their own emergency, and its recording', async () => {
    const token = await loginAs(app, 'crew');
    const res = await emergencyWithLink(token, LIVE_EMERGENCY);
    expect(res.status).toBe(200);

    const link = linkOf(res);
    expect(link).not.toBeNull();
    expect(link!.id).toBe(LIVE_REPORT);
    expect(link!.capabilities.read).toBe(true);
    expect(link!.capabilities.listen).toBe(true);
    expect(link!.capabilities.canPlayRecording).toBe(true);
    expect(link!.accessLabel).toBe('Assigned Emergency');
    // Crew hold no download grant - the link must not widen that.
    expect(link!.capabilities.download).toBe(false);

    // The block is a pointer, not a copy: the detail still comes from the voice
    // route, which enforces the scopes a second time.
    const audio = await request(app).get(`/api/voice/reports/${LIVE_REPORT}/audio`).set(bearer(token));
    expect(audio.status).toBe(200);
  });

  it('hides the report from crew on an emergency they are not assigned to, leaking nothing', async () => {
    const token = await loginAs(app, 'crew');
    const res = await emergencyWithLink(token, FOREIGN_EMERGENCY);
    // 404, not 403: ids are sequential, so a 403 on a real id but 404 on an
    // unused one would be an existence oracle. Same policy as the voice and
    // ambulance readers.
    expect(res.status).toBe(404);
    expectNoLeak(res, FOREIGN_REPORT);

    // And the report is unreachable directly too - the link did not become a
    // second, weaker way in.
    const direct = await request(app).get(`/api/voice/reports/${FOREIGN_REPORT}`).set(bearer(token));
    expect(direct.status).toBe(404);
  });

  it('gives hospital staff the report routed to their own facility', async () => {
    const token = await loginAs(app, 'hospital');
    const res = await emergencyWithLink(token, LIVE_EMERGENCY);
    expect(res.status).toBe(200);

    const link = linkOf(res);
    expect(link!.id).toBe(LIVE_REPORT);
    expect(link!.capabilities.listen).toBe(true);
    expect(link!.capabilities.canPlayRecording).toBe(true);
    expect(link!.accessLabel).toBe('Hospital Emergency');
    expect(link!.capabilities.download).toBe(false);
  });

  it('hides the report from hospital staff on another hospital emergency', async () => {
    const token = await loginAs(app, 'hospital');
    const res = await emergencyWithLink(token, FOREIGN_EMERGENCY);
    // 404 rather than 403, for the same reason as above: the status code must
    // not reveal that the incident exists.
    expect(res.status).toBe(404);
    expectNoLeak(res, FOREIGN_REPORT);
  });

  it('is narrower than the emergency read: a citizen sees their incident, not another recording', async () => {
    const token = await loginAs(app, 'citizen');
    // The citizen owns EMG-91004, so the emergency itself is readable...
    const res = await emergencyWithLink(token, OWN_EMERGENCY);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(OWN_EMERGENCY);

    // ...but the report filed against it belongs to somebody else, so the link is
    // withheld. Reading the incident must not imply hearing its recording.
    expect(linkOf(res)).toBeNull();

    const direct = await request(app).get(`/api/voice/reports/${FOREIGN_OWNED_REPORT}`).set(bearer(token));
    expect(direct.status).toBe(404);
  });

  it('shows the citizen the report on their own incident', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await emergencyWithLink(token, LIVE_EMERGENCY);
    expect(res.status).toBe(200);

    const link = linkOf(res);
    expect(link!.id).toBe(LIVE_REPORT);
    expect(link!.accessLabel).toBe('Own Report');
    expect(link!.capabilities.canPlayRecording).toBe(true);
  });

  it('still refuses raw audio to an Analyst reached through the emergency page', async () => {
    const token = await loginAs(app, 'analyst');

    // An Analyst may read any emergency, historical or not...
    const res = await emergencyWithLink(token, CLOSED_EMERGENCY);
    expect(res.status).toBe(200);

    // ...and the confirmed report is in their analytical set, so the link appears...
    const link = linkOf(res);
    expect(link).not.toBeNull();
    expect(link!.id).toBe(CLOSED_REPORT);
    expect(link!.capabilities.transcript).toBe(true);

    // ...but the recording is not theirs, through this route or any other.
    expect(link!.capabilities.listen).toBe(false);
    expect(link!.capabilities.canPlayRecording).toBe(false);
    expect(link!.capabilities.download).toBe(false);

    const audio = await request(app).get(`/api/voice/reports/${CLOSED_REPORT}/audio`).set(bearer(token));
    expect(audio.status).toBe(403);
  });

  it('gives the Auditor evidence on a closed incident without any write action', async () => {
    const token = await loginAs(app, 'auditor');
    const res = await emergencyWithLink(token, CLOSED_EMERGENCY);
    expect(res.status).toBe(200);

    const link = linkOf(res);
    expect(link!.id).toBe(CLOSED_REPORT);
    expect(link!.capabilities.evidence).toBe(true);
    expect(link!.capabilities.accessHistory).toBe(true);
    expect(link!.capabilities.canPlayRecording).toBe(true);
    expect(link!.capabilities.download).toBe(true);
    // Read-only by construction.
    expect(link!.capabilities.edit).toBe(false);
    expect(link!.capabilities.confirm).toBe(false);
    expect(link!.capabilities.reject).toBe(false);
    expect(link!.capabilities.discard).toBe(false);
  });

  it('withholds the report from an Auditor on a live draft, which is not evidence', async () => {
    const token = await loginAs(app, 'auditor');
    const res = await emergencyWithLink(token, LIVE_EMERGENCY);
    expect(res.status).toBe(200);
    expect(linkOf(res)).toBeNull();
  });

  it('writes no audit row for merely exposing the link; playing the recording does', async () => {
    const token = await loginAs(app, 'auditor');

    // Measured as a delta, not an absolute: an earlier case deliberately
    // provoked a 403, which legitimately wrote its own denial row.
    const before = await voiceAuditCount(CLOSED_REPORT);

    await emergencyWithLink(token, CLOSED_EMERGENCY);
    expect(
      await voiceAuditCount(CLOSED_REPORT),
      'reading the incident must not be recorded as accessing the recording',
    ).toBe(before);

    // Playing it *is* recorded, and recorded as a play rather than a view.
    const audio = await request(app).get(`/api/voice/reports/${CLOSED_REPORT}/audio`).set(bearer(token));
    expect(audio.status).toBe(200);
    expect(await waitForAudit('voice.report_played', CLOSED_REPORT)).not.toBeNull();
  });
});

describe('seeded demo recordings', () => {
  it('stores a real recording so playback is verifiable against demo data', async () => {
    const report = await VoiceReport.findById('VR-001').lean();
    expect(report?.audio?.storageKey).toBeTruthy();
    expect(report?.audio?.status).toBe('STORED');
    // The link itself is what the emergency page depends on.
    expect(report?.emergencyId).toBe('EMG-20482');
  });

  it('links the confirmed demo report to a hospital-routed emergency', async () => {
    const report = await VoiceReport.findById('VR-002').lean();
    expect(report?.status).toBe('CONFIRMED');
    expect(report?.emergencyId).toBe('EMG-20481');
    expect(report?.hospitalRouting?.hospitalId).toBe('HOSP-01');
    expect(report?.audio?.storageKey).toBeTruthy();
  });
  it('never regenerates a recording for an already-seeded report', async () => {
    const before = await VoiceReport.findById('VR-001').lean();
    await runSeed();
    const after = await VoiceReport.findById('VR-001').lean();
    // Same document, same single copy on disk - re-seeding must not orphan a file.
    expect(after?.audio?.storageKey).toBe(before?.audio?.storageKey);
  });
});
