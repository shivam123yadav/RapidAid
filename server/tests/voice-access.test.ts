/**
 * Voice-report access control: ROLE → PERMISSION → ACTION → SCOPE → RESOURCE.
 *
 * Scenario coverage for the access brief:
 *   1  eight demo roles against the same evidence set
 *   2  raw audio vs transcript vs download are three different rights
 *   3  direct API access cannot bypass the guards (403/404 per case)
 *   4  hospital / crew / citizen scope violations
 *   5  audit logging of views, plays, downloads, edits, rejections and denials
 *   6  the DRAFT review workflow (confirm / reject / edit) still works
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
import { permissionsFor } from '../src/authz/permissions.js';
import type { Role } from '../src/validation/constants.js';

const app = createApp();
useTestDatabase(runSeed);

/** Recordings live in a temp directory for the duration of this suite. */
const STORAGE = join(tmpdir(), `rapidaid-voice-access-${process.pid}`);
beforeAll(() => {
  process.env.VOICE_AUDIO_STORAGE_DIR = STORAGE;
});
afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

/** A structurally valid WebM (EBML header + padding). */
function webmAudio(bytes = 1024): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

/** Logs in any account, including fixtures created by the tests themselves. */
async function loginAsAccount(email: string, password: string, role: Role): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ email, password, role });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.body.accessToken as string;
}

async function storedAudioRecord(ownerId: string, seconds = 7) {
  const stored = await storeVoiceAudio({
    audio: webmAudio(2048),
    ownerId,
    declaredMimeType: 'audio/webm',
    durationSeconds: seconds,
  });
  return {
    storageKey: stored.storageKey,
    filename: stored.filename,
    mimeType: stored.mimeType,
    size: stored.size,
    checksum: stored.checksum,
    durationSeconds: stored.durationSeconds ?? seconds,
    status: 'STORED',
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────
/** Report routed to the demo hospital staff member's own facility (HOSP-01). */
const OWN_HOSPITAL_REPORT = 'VR-901';
/** Report routed to a different facility (HOSP-22) — must stay invisible. */
const OTHER_HOSPITAL_REPORT = 'VR-902';
/** Confirmed record of an emergency that already finished (history only). */
const TERMINAL_REPORT = 'VR-903';
/** Owned by a second citizen account — nobody else may touch it. */
const FOREIGN_CITIZEN_REPORT = 'VR-904';
/** Rejected draft: historical but not evidence. */
const REJECTED_REPORT = 'VR-905';

let secondCitizenId = '';

const emergencyFixture = {
  priority: 'HIGH',
  incidentType: 'VEHICLE_COLLISION',
  location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' },
  source: 'VOICE_REPORT',
  description: 'Two people injured in a collision',
  victimCount: 2,
};

beforeAll(async () => {
  const created = await request(app)
    .post('/api/admin/users')
    .set(bearer(await loginAs(app, 'admin')))
    .send({ name: 'Second Citizen', email: 'citizen2@rapidaid.com', password: 'demo12345', role: 'CITIZEN' });
  if (created.status !== 201) throw new Error(`fixture citizen failed: ${created.status}`);
  secondCitizenId = created.body.id as string;

  const now = new Date();
  const emergency = { ...emergencyFixture, reportedAt: now, updatedAt: now };
  await Emergency.create([
    { _id: 'EMG-90001', citizenId: 'USR-008', assignedCrewIds: ['USR-002'], status: 'DISPATCHING', destinationHospital: 'HOSP-01', assignedDispatcher: 'USR-001', ...emergency },
    { _id: 'EMG-90002', citizenId: 'USR-008', assignedCrewIds: ['USR-777'], assignedAmbulance: 'AMB-900', status: 'EN_ROUTE', destinationHospital: 'HOSP-22', assignedDispatcher: 'USR-777', ...emergency },
    { _id: 'EMG-90003', citizenId: 'USR-008', assignedCrewIds: [], status: 'COMPLETED', destinationHospital: 'HOSP-01', assignedDispatcher: 'USR-999', ...emergency },
  ]);

  const base = {
    transcript: 'Accident near Rajwada Square in Indore. Two people are injured.',
    extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square, Indore', victimCount: 2, description: 'Collision' },
    confidence: 88,
    createdAt: now,
  };

  await VoiceReport.create([
    { _id: OWN_HOSPITAL_REPORT, ownerId: 'USR-008', hospitalId: 'HOSP-01', emergencyId: 'EMG-90001', status: 'CONFIRMED', audio: await storedAudioRecord('USR-008'), hospitalRouting: { hospitalId: 'HOSP-01', hospitalName: 'AIIMS Trauma Center', distance: 1200, routingReason: 'NEAREST_ELIGIBLE', selectedAt: now }, ...base },
    { _id: OTHER_HOSPITAL_REPORT, ownerId: 'USR-008', hospitalId: 'HOSP-22', emergencyId: 'EMG-90002', status: 'CONFIRMED', audio: await storedAudioRecord('USR-008'), hospitalRouting: { hospitalId: 'HOSP-22', hospitalName: 'Choithram Maniram Hospital', distance: 900, routingReason: 'NEAREST_ELIGIBLE', selectedAt: now }, ...base },
    { _id: TERMINAL_REPORT, ownerId: 'USR-008', hospitalId: 'HOSP-01', emergencyId: 'EMG-90003', status: 'CONFIRMED', audio: await storedAudioRecord('USR-008'), hospitalRouting: { hospitalId: 'HOSP-01', hospitalName: 'AIIMS Trauma Center', selectedAt: now }, ...base },
    { _id: FOREIGN_CITIZEN_REPORT, ownerId: secondCitizenId, transcript: 'My own private report nobody else may hear.', extractedData: { incidentType: 'OTHER', location: 'Somewhere private' }, confidence: 61, status: 'DRAFT', createdAt: now },
    { _id: REJECTED_REPORT, ownerId: 'USR-008', hospitalId: 'HOSP-01', status: 'REJECTED', audio: await storedAudioRecord('USR-008'), ...base },
  ]);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function listReports(token: string, query = ''): Promise<Record<string, unknown>[]> {
  const res = await request(app).get(`/api/voice/reports${query}`).set(bearer(token));
  expect(res.status, `GET /api/voice/reports${query}`).toBe(200);
  return res.body.reports as Record<string, unknown>[];
}

const idsOf = (rows: Record<string, unknown>[]): string[] => rows.map((row) => row.id as string);
const capsOf = (row: Record<string, unknown>): Record<string, boolean> =>
  row.capabilities as Record<string, boolean>;

/** Polls for an audit row: auditing is fire-and-forget and may land just after the response. */
async function auditRow(action: string, resourceId: string, actorId?: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const filter: Record<string, unknown> = { action, resourceId };
    if (actorId) filter.actorId = actorId;
    // Newest first: earlier tests may have logged the same action on the same
    // report (e.g. an admin download before the auditor's), so the row under
    // test is the latest one.
    const row = await AuditLog.findOne(filter).sort({ timestamp: -1 }).lean();
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

// ── Administrator ───────────────────────────────────────────────────────────

describe('Administrator — global voice-report access', () => {
  it('lists every report: draft queue, confirmed history, rejected drafts and other citizens', async () => {
    const token = await loginAs(app, 'admin');
    const ids = idsOf(await listReports(token));
    expect(ids).toEqual(
      expect.arrayContaining([
        OWN_HOSPITAL_REPORT,
        OTHER_HOSPITAL_REPORT,
        TERMINAL_REPORT,
        FOREIGN_CITIZEN_REPORT,
        REJECTED_REPORT,
      ]),
    );
  });

  it('reads the transcript, plays and downloads any authorized recording', async () => {
    const token = await loginAs(app, 'admin');

    const detail = await request(app).get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}`).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.transcript).toContain('Rajwada Square');
    expect(detail.body.accessLabel).toBe('Administrator Access');
    expect(detail.body.ownerId).toBe('USR-008');
    expect(capsOf(detail.body).listen).toBe(true);
    expect(capsOf(detail.body).download).toBe(true);

    const transcript = await request(app)
      .get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}/transcript`)
      .set(bearer(token));
    expect(transcript.status).toBe(200);
    expect(transcript.body.transcript).toContain('Rajwada Square');

    const audio = await request(app).get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}/audio`).set(bearer(token));
    expect(audio.status).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/webm');
    expect(audio.body.length).toBeGreaterThan(0);

    const download = await request(app)
      .get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}/audio/download`)
      .set(bearer(token));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');

    // Every sensitive action is traceable.
    expect((await auditRow('voice.report_viewed', OWN_HOSPITAL_REPORT))?.actorId).toBe('USR-004');
    expect((await auditRow('voice.report_played', OWN_HOSPITAL_REPORT))?.actorId).toBe('USR-004');
    expect((await auditRow('voice.report_downloaded', OWN_HOSPITAL_REPORT))?.actorId).toBe('USR-004');
    expect((await auditRow('voice.transcript_viewed', OWN_HOSPITAL_REPORT))?.actorId).toBe('USR-004');
  });

  it('shows the access history of a sensitive report', async () => {
    const token = await loginAs(app, 'admin');
    const res = await request(app)
      .get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}/access-history`)
      .set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(OWN_HOSPITAL_REPORT);
    expect(res.body.entries.length).toBeGreaterThan(0);
    expect(res.body.entries[0]).toMatchObject({ actorRole: expect.any(String), action: expect.any(String) });
  });

  it('corrects AI-extracted information and audits the diff', async () => {
    const token = await loginAs(app, 'admin');
    const patched = await request(app)
      .patch(`/api/voice/reports/${OWN_HOSPITAL_REPORT}`)
      .set(bearer(token))
      .send({ extractedData: { victimCount: 3 } });
    expect(patched.status).toBe(200);
    expect((patched.body.extractedData as Record<string, unknown>).victimCount).toBe(3);

    const audit = await auditRow('voice.report_edited', OWN_HOSPITAL_REPORT);
    expect(audit).toMatchObject({ actorId: 'USR-004' });
    expect((audit?.previousState as Record<string, unknown>).extractedData).toMatchObject({ victimCount: 2 });
    expect((audit?.newState as Record<string, unknown>).extractedData).toMatchObject({ victimCount: 3 });
  });
});

// ── Supervisor ──────────────────────────────────────────────────────────────

describe('Supervisor — operational oversight', () => {
  it('sees and hears operational reports and may download authorized recordings', async () => {
    const token = await loginAs(app, 'supervisor');
    const ids = idsOf(await listReports(token, '?scope=active'));
    expect(ids).toEqual(expect.arrayContaining([OWN_HOSPITAL_REPORT, FOREIGN_CITIZEN_REPORT]));

    const detail = await request(app).get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}`).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Full Operational Access');
    expect(detail.body.transcript).toContain('Rajwada Square');

    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;
    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(200);
  });

  it('can confirm or reject a live draft, and read the whole history', async () => {
    const token = await loginAs(app, 'supervisor');
    const [draft] = await listReports(token, '?scope=active&search=VR-904');
    expect(draft.id).toBe(FOREIGN_CITIZEN_REPORT);
    expect(capsOf(draft).confirm).toBe(true);
    expect(capsOf(draft).reject).toBe(true);
    expect(capsOf(draft).listen).toBe(true);

    expect(idsOf(await listReports(token, '?scope=historical'))).toEqual(
      expect.arrayContaining([OWN_HOSPITAL_REPORT, TERMINAL_REPORT, REJECTED_REPORT]),
    );
  });
});

// ── Dispatcher ──────────────────────────────────────────────────────────────

describe('Dispatcher — active / relevant / handled emergencies only', () => {
  it('sees the live review queue and active emergencies, but not closed history', async () => {
    const token = await loginAs(app, 'dispatcher');
    const all = idsOf(await listReports(token));
    expect(all).toEqual(expect.arrayContaining([OWN_HOSPITAL_REPORT, FOREIGN_CITIZEN_REPORT]));
    // EMG-90003 finished and was handled by another dispatcher: not this one's.
    expect(all).not.toContain(TERMINAL_REPORT);

    const terminal = await request(app).get(`/api/voice/reports/${TERMINAL_REPORT}`).set(bearer(token));
    expect(terminal.status).toBe(404);
    expect(
      (await request(app).get(`/api/voice/reports/${TERMINAL_REPORT}/audio`).set(bearer(token))).status,
    ).toBe(404);
    expect(
      (await request(app).get(`/api/voice/reports/${TERMINAL_REPORT}/transcript`).set(bearer(token))).status,
    ).toBe(404);
  });

  it('plays a relevant recording and reads its transcript, but may not download it', async () => {
    const token = await loginAs(app, 'dispatcher');
    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;

    const detail = await request(app).get(base).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Active Report');
    expect(capsOf(detail.body).listen).toBe(true);
    expect(capsOf(detail.body).download).toBe(false);

    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);

    // In scope, but download is a separate right the dispatcher does not hold.
    const download = await request(app).get(`${base}/audio/download`).set(bearer(token));
    expect(download.status).toBe(403);
    // …and audit history is administrator/auditor territory.
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(403);
  });
});

// ── Ambulance crew ──────────────────────────────────────────────────────────

describe('Ambulance crew — assigned emergencies only', () => {
  it('sees only the reports tied to their own assignment', async () => {
    const token = await loginAs(app, 'crew');
    const ids = idsOf(await listReports(token));
    expect(ids).toContain(OWN_HOSPITAL_REPORT); // EMG-90001 names USR-002
    expect(ids).not.toEqual(
      expect.arrayContaining([OTHER_HOSPITAL_REPORT, TERMINAL_REPORT, REJECTED_REPORT, FOREIGN_CITIZEN_REPORT]),
    );
  });

  it('plays and reads the transcript of its assigned report, without download rights', async () => {
    const token = await loginAs(app, 'crew');
    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;

    const detail = await request(app).get(base).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Assigned Emergency');
    expect(detail.body.transcript).toContain('Rajwada Square');
    expect(capsOf(detail.body).download).toBe(false);
    expect(capsOf(detail.body).accessHistory).toBe(false);

    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(403);
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(403);
  });

  it('cannot reach an unrelated crew report, in any form', async () => {
    const token = await loginAs(app, 'crew');
    const base = `/api/voice/reports/${OTHER_HOSPITAL_REPORT}`; // assigned to USR-777 / AMB-900

    expect((await request(app).get(base).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(404);
  });
});

// ── Hospital staff ──────────────────────────────────────────────────────────

describe('Hospital staff — own hospital only', () => {
  it('receives the reports of emergencies routed to its own facility', async () => {
    const token = await loginAs(app, 'hospital');
    const ids = idsOf(await listReports(token));
    expect(ids).toContain(OWN_HOSPITAL_REPORT);
    expect(ids).not.toContain(OTHER_HOSPITAL_REPORT);

    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;
    const detail = await request(app).get(base).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Hospital Emergency');
    expect(detail.body.transcript).toContain('Rajwada Square');

    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(403);
  });

  it('cannot reach another hospital’s report', async () => {
    const token = await loginAs(app, 'hospital');
    const base = `/api/voice/reports/${OTHER_HOSPITAL_REPORT}`; // routed to HOSP-22

    expect((await request(app).get(base).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(404);
  });
});

// ── Analyst ─────────────────────────────────────────────────────────────────

describe('Analyst — structured data and transcripts, never raw audio by default', () => {
  it('holds transcript access without any listen permission', () => {
    const held = permissionsFor('ANALYST');
    expect(held).toContain('voice:transcript:view:analytical');
    expect(held).not.toContain('voice:listen:analytical');
    expect(held).not.toContain('voice:listen:all');
    expect(held).not.toContain('voice:download:authorized');
  });

  it('sees confirmed records with transcripts, and no citizen identity', async () => {
    const token = await loginAs(app, 'analyst');
    const ids = idsOf(await listReports(token));
    expect(ids).toEqual(expect.arrayContaining([OWN_HOSPITAL_REPORT, TERMINAL_REPORT]));
    expect(ids).not.toContain(FOREIGN_CITIZEN_REPORT);
    expect(ids).not.toContain(REJECTED_REPORT);

    const detail = await request(app).get(`/api/voice/reports/${OWN_HOSPITAL_REPORT}`).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Analytical Record');
    expect(detail.body.transcript).toContain('Rajwada Square');
    expect(detail.body.ownerId).toBeUndefined();
    expect(capsOf(detail.body).listen).toBe(false);
    expect(capsOf(detail.body).download).toBe(false);
  });

  it('is refused raw audio (403) even though it may read the same report', async () => {
    const token = await loginAs(app, 'analyst');
    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;

    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);

    const audio = await request(app).get(`${base}/audio`).set(bearer(token));
    expect(audio.status).toBe(403);
    expect(JSON.stringify(audio.body)).toContain('not authorized to listen');
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(403);
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(403);
    // No write rights either.
    expect(
      (await request(app).patch(base).set(bearer(token)).send({ extractedData: { victimCount: 5 } })).status,
    ).toBe(403);
    expect(
      (await request(app).post(`${base}/reject`).set(bearer(token)).send({ reason: 'analysts cannot reject' }))
        .status,
    ).toBe(403);
  });
});

// ── Auditor ─────────────────────────────────────────────────────────────────

describe('Auditor — authorized historical evidence, read-only', () => {
  it('lists historical records (confirmed and rejected) but no live drafts', async () => {
    const token = await loginAs(app, 'auditor');
    const ids = idsOf(await listReports(token));
    expect(ids).toEqual(
      expect.arrayContaining([OWN_HOSPITAL_REPORT, OTHER_HOSPITAL_REPORT, TERMINAL_REPORT, REJECTED_REPORT]),
    );
    expect(ids).not.toContain(FOREIGN_CITIZEN_REPORT);
  });

  it('listens to and exports authorized evidence and reads its access history', async () => {
    const token = await loginAs(app, 'auditor');
    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;

    const detail = await request(app).get(base).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Audit Evidence');
    expect(detail.body.transcript).toContain('Rajwada Square');
    expect(capsOf(detail.body).evidence).toBe(true);
    expect(capsOf(detail.body).download).toBe(true);

    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);

    const download = await request(app).get(`${base}/audio/download`).set(bearer(token));
    expect(download.status).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(200);
    expect((await auditRow('voice.report_downloaded', OWN_HOSPITAL_REPORT, 'USR-006'))?.actorRole).toBe('AUDITOR');
  });

  it('can never modify, reject, delete or confirm evidence', async () => {
    const token = await loginAs(app, 'auditor');
    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;

    expect(
      (await request(app).patch(base).set(bearer(token)).send({ extractedData: { victimCount: 9 } })).status,
    ).toBe(403);
    expect(
      (await request(app).post(`${base}/reject`).set(bearer(token)).send({ reason: 'auditors cannot reject' }))
        .status,
    ).toBe(403);
    expect((await request(app).delete(base).set(bearer(token))).status).toBe(403);
    expect((await request(app).post(`${base}/confirm`).set(bearer(token)).send({})).status).toBe(403);

    // …and the evidence is still there, unmodified.
    expect(await VoiceReport.findById(OWN_HOSPITAL_REPORT).lean()).not.toBeNull();
  });
});

// ── Citizen ─────────────────────────────────────────────────────────────────

describe('Citizen — own reports only', () => {
  it('sees, plays and reads only its own recording', async () => {
    const token = await loginAs(app, 'citizen');
    const ids = idsOf(await listReports(token));
    expect(ids).toEqual(expect.arrayContaining([OWN_HOSPITAL_REPORT, REJECTED_REPORT]));
    expect(ids).not.toContain(FOREIGN_CITIZEN_REPORT);

    const base = `/api/voice/reports/${OWN_HOSPITAL_REPORT}`;
    const detail = await request(app).get(base).set(bearer(token));
    expect(detail.status).toBe(200);
    expect(detail.body.accessLabel).toBe('Own Report');
    expect(detail.body.transcript).toContain('Rajwada Square');
    expect(detail.body.ownerId).toBe('USR-008');

    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(200);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(200);

    // Product policy: a citizen may play their own recording, not export it.
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(403);
    expect((await request(app).get(`${base}/access-history`).set(bearer(token))).status).toBe(403);

    // …and holds no review powers over a report.
    expect((await request(app).post(`${base}/confirm`).set(bearer(token)).send({})).status).toBe(403);
    expect(
      (await request(app).post(`${base}/reject`).set(bearer(token)).send({ reason: 'citizens cannot reject' }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).patch(base).set(bearer(token)).send({ transcript: 'rewritten transcript text' })).status,
    ).toBe(403);
  });

  it('cannot reach another citizen’s report by id, transcript or audio', async () => {
    const token = await loginAs(app, 'citizen');
    const owner = await loginAsAccount('citizen2@rapidaid.com', 'demo12345', 'CITIZEN');
    const base = `/api/voice/reports/${FOREIGN_CITIZEN_REPORT}`;

    expect((await request(app).get(base).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/transcript`).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/audio`).set(bearer(token))).status).toBe(404);
    expect((await request(app).get(`${base}/audio/download`).set(bearer(token))).status).toBe(404);

    // The legitimate owner still reaches their own draft.
    expect((await request(app).get(base).set(bearer(owner))).status).toBe(200);
  });
});
