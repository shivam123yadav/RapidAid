#!/usr/bin/env node
/**
 * Live end-to-end verification of the RapidAid voice-emergency pipeline.
 *
 * Run against a LIVE server (default http://localhost:5000) + the live
 * MongoDB, using a REAL browser-generated WebM recording from
 * `storage/voice` (produced by MediaRecorder in a previous session).
 *
 *   node scripts/e2e-voice-live.mjs
 *
 * Verifies, end to end:
 *   1. multipart upload of a real recording (browser FormData shape)
 *   2. audio stored on disk + metadata persisted (audio.*)
 *   3. transcript stored (transcription.*)
 *   4. emergency information extracted (type, injured people, spoken location)
 *   5. spoken location geocoded (coordinates + source SPOKEN)
 *   6. nearest ELIGIBLE hospital selected from MongoDB (not hardcoded)
 *   7. emergency created and associated with that hospital
 *   8. dispatcher + hospital notifications created (RBAC-scoped)
 *   9. audit entries written
 *  10. original recording downloadable again (byte-identical)
 *  11. error states: 401 / 415 / 400 empty / 202 awaiting location /
 *      422 transcription failed / cross-user recording access denied
 *
 * Exits non-zero when any check fails.
 */
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const BASE = process.env.API_BASE ?? 'http://localhost:5000';
const MONGO = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/rapidaid';
const SERVER_DIR = fileURLToPath(new URL('..', import.meta.url));
const STORAGE_DIR = process.env.VOICE_AUDIO_STORAGE_DIR ?? join(SERVER_DIR, 'storage', 'voice');

const TRANSCRIPT =
  'Accident near Rajwada Square in Indore. Two people are injured. Please send an ambulance.';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function login(email, password, role) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, role }),
  });
  if (res.status !== 200) {
    throw new Error(`login(${email}) failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).accessToken;
}

/** Newest .webm actually recorded by the browser in a previous session. */
async function findRealRecording() {
  const entries = await readdir(STORAGE_DIR, { recursive: true, withFileTypes: true });
  const webms = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.webm')) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const info = await stat(full);
    webms.push({ full, size: info.size, mtime: info.mtimeMs });
  }
  webms.sort((a, b) => b.mtime - a.mtime);
  return webms[0] ?? null;
}

function uploadForm({ bytes, mimeType = 'audio/webm', transcript, durationSeconds }) {
  const form = new FormData();
  // Never set Content-Type manually — fetch adds the multipart boundary.
  form.append('audio', new Blob([bytes], { type: mimeType }), 'voice-emergency-live.webm');
  if (transcript !== undefined) form.append('transcript', transcript);
  if (durationSeconds !== undefined) form.append('durationSeconds', String(durationSeconds));
  return form;
}

async function uploadRecording(token, options) {
  const res = await fetch(`${BASE}/api/voice/reports/recording`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: uploadForm(options),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  // ── 0. Pick a real browser recording ──────────────────────────────────────
  const recording = await findRealRecording();
  check('real browser recording available in storage/voice', Boolean(recording), recording ? `${recording.size} bytes` : 'none found');
  if (!recording) throw new Error('No stored recording to replay');
  const bytes = await readFile(recording.full);
  check('recording starts with a WebM/EBML signature', bytes[0] === 0x1a && bytes[1] === 0x45, bytes.subarray(0, 4).toString('hex'));

  // ── 1. Authenticate ───────────────────────────────────────────────────────
  const citizen = await login('citizen@rapidaid.com', 'demo123', 'CITIZEN');
  check('citizen authenticated', Boolean(citizen));

  // ── 2. Upload the recording + on-device transcript ────────────────────────
  const created = await uploadRecording(citizen, {
    bytes,
    mimeType: 'audio/webm',
    transcript: TRANSCRIPT,
    durationSeconds: 6,
  });
  check('POST /api/voice/reports/recording → 201', created.status === 201, `status ${created.status}`);
  if (created.status !== 201) {
    console.log(JSON.stringify(created.body, null, 2));
    throw new Error('pipeline did not create the emergency');
  }
  const r = created.body;

  // ── 3. Audio stored ───────────────────────────────────────────────────────
  check('audio stored (status STORED)', r.report?.audio?.status === 'STORED');
  check('audio mime type preserved (audio/webm)', r.report?.audio?.mimeType === 'audio/webm', r.report?.audio?.mimeType);
  check('audio size matches upload', r.report?.audio?.size === bytes.length, `${r.report?.audio?.size} vs ${bytes.length}`);
  check('stored filename voice-emergency-<ts>.webm', /^voice-emergency-\d+\.webm$/.test(r.report?.audio?.filename ?? ''), r.report?.audio?.filename);
  check('storage key is server-generated (USR-…)', /^USR-\d+\//.test(r.report?.audio?.storageKey ?? ''), r.report?.audio?.storageKey);
  check('audio sha-256 persisted', /^[0-9a-f]{64}$/.test(r.report?.audio?.checksum ?? ''));

  // ── 4. Transcript stored ──────────────────────────────────────────────────
  check('transcript stored verbatim', r.transcript === TRANSCRIPT);
  check('transcription status COMPLETED', r.report?.transcription?.status === 'COMPLETED', r.report?.transcription?.status);
  check('transcription provider recorded', r.report?.transcription?.provider === 'on-device-whisper', r.report?.transcription?.provider);

  // ── 5. Extracted information ──────────────────────────────────────────────
  const ex = r.extractedInformation ?? {};
  check('emergency type extracted (accident → VEHICLE_COLLISION)', ex.emergencyType === 'VEHICLE_COLLISION', ex.emergencyType);
  check('injured people extracted = 2', ex.injuredPeople === 2, String(ex.injuredPeople));
  check('spoken location extracted', /Rajwada Square/i.test(ex.spokenLocation ?? ''), ex.spokenLocation);
  check('severity is HIGH or CRITICAL', ['HIGH', 'CRITICAL'].includes(ex.severity), ex.severity);

  // ── 6. Geocoding ──────────────────────────────────────────────────────────
  const loc = r.location ?? {};
  check('location resolved', loc.resolved === true && loc.latitude !== null && loc.longitude !== null, `${loc.latitude}, ${loc.longitude}`);
  check('location source = SPOKEN', loc.source === 'SPOKEN', loc.source);
  check('coordinates are finite and valid',
    Number.isFinite(loc.latitude) && Number.isFinite(loc.longitude) &&
    Math.abs(loc.latitude) <= 90 && Math.abs(loc.longitude) <= 180);

  // ── 7. Nearest eligible hospital from the DATABASE ────────────────────────
  const hosp = r.hospital;
  check('nearest hospital selected from MongoDB', Boolean(hosp?.hospitalId), hosp ? `${hosp.hospitalId} ${hosp.name}` : 'none');
  check('selected hospital is OPERATIONAL', hosp?.status === 'OPERATIONAL', hosp?.status);
  check('trauma capability present for a collision', hosp?.traumaAvailable === true, String(hosp?.traumaAvailable));
  check('distance calculated', typeof r.distance === 'number' && r.distance > 0, `${r.distance} m`);

  // ── 8. Emergency created + associated ─────────────────────────────────────
  const emg = r.emergency;
  check('emergency created (EMG-#####)', /^EMG-\d{5}$/.test(emg?.id ?? ''), emg?.id);
  check('emergency source = VOICE_REPORT', emg?.source === 'VOICE_REPORT', emg?.source);
  check('emergency status = REPORTED', emg?.status === 'REPORTED', emg?.status);
  check('emergency.destinationHospital = selected hospital', emg?.destinationHospital === hosp?.hospitalId, `${emg?.destinationHospital}`);
  check('report.hospitalRouting stored', r.report?.hospitalRouting?.hospitalId === hosp?.hospitalId);
  check('dispatch hand-off status', r.dispatchStatus === 'DISPATCHER_NOTIFIED', r.dispatchStatus);
  check('hospital notification sent flag', r.hospitalNotificationSent === true);
  check('report dispatchStatus = DISPATCH_PENDING', r.report?.dispatchStatus === 'DISPATCH_PENDING', r.report?.dispatchStatus);

  // ── 9. Original recording is retrievable, byte-identical ──────────────────
  const audioRes = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`, {
    headers: { Authorization: `Bearer ${citizen}` },
  });
  const audioBack = Buffer.from(await audioRes.arrayBuffer());
  check('stored recording downloadable (200)', audioRes.status === 200, `status ${audioRes.status}`);
  check('downloaded recording is byte-identical', sha256(audioBack) === sha256(bytes));
  check('playback served with recorded MIME type', (audioRes.headers.get('content-type') ?? '').startsWith('audio/webm'));
  check('recordings are never publicly cacheable', (audioRes.headers.get('cache-control') ?? '').includes('private'));

  // ── 10. Dispatcher receives the voice SOS ─────────────────────────────────
  const dispatcher = await login('dispatcher@rapidaid.com', 'demo123', 'DISPATCHER');
  const notifRes = await fetch(`${BASE}/api/notifications`, { headers: { Authorization: `Bearer ${dispatcher}` } });
  const dispatcherNotifs = await notifRes.json();
  const sos = dispatcherNotifs.find((n) => n.linkedEmergency === emg.id && /Voice SOS/i.test(n.title ?? ''));
  check('dispatcher notified of the voice SOS', Boolean(sos), sos?._id ?? 'not visible');
  check('dispatcher notification links the emergency', sos?.linkedEmergency === emg.id);

  // ── 11. Live database state ───────────────────────────────────────────────
  await mongoose.connect(MONGO);
  const db = mongoose.connection.db;

  const reportDoc = await db.collection('voicereports').findOne({ _id: r.report.id });
  check('VoiceReport persisted: audio metadata', reportDoc?.audio?.storageKey === r.report.audio.storageKey);
  check('VoiceReport persisted: transcript', reportDoc?.transcript === TRANSCRIPT);
  check('VoiceReport persisted: extractedInformation', reportDoc?.extractedInformation?.spokenLocation?.includes('Rajwada Square'));
  check('VoiceReport persisted: coordinates', typeof reportDoc?.location?.latitude === 'number');
  check('VoiceReport persisted: location source SPOKEN', reportDoc?.location?.source === 'SPOKEN');
  check('VoiceReport persisted: hospitalRouting', reportDoc?.hospitalRouting?.hospitalId === hosp?.hospitalId);
  check('VoiceReport persisted: emergency link', reportDoc?.emergencyId === emg.id);

  const emergencyDoc = await db.collection('emergencies').findOne({ _id: emg.id });
  check('Emergency document associated with hospital', emergencyDoc?.destinationHospital === hosp?.hospitalId);
  check('Emergency document carries the spoken coordinates',
    Math.abs((emergencyDoc?.location?.lat ?? 0) - loc.latitude) < 1e-5);

  const hospitalNotifs = await db.collection('notifications')
    .find({ hospitalId: hosp?.hospitalId, linkedEmergency: emg.id }).toArray();
  check('hospital notification created for the selected hospital', hospitalNotifs.length >= 1, `${hospitalNotifs.length}`);
  // Required content (id, location, distance, severity) must be present; the
  // raw transcript / casualty sentence must never be shared with the hospital.
  check('hospital notification carries dispatch-relevant facts',
    hospitalNotifs.every((n) =>
      (n.message ?? '').includes(emg.id) &&
      /km away/.test(n.message ?? '') &&
      /severity/.test(n.message ?? '')));
  check('hospital notification does not leak the raw transcript',
    hospitalNotifs.every((n) =>
      !(n.message ?? '').includes(TRANSCRIPT) &&
      !(n.message ?? '').includes('Two people are injured') &&
      !(n.message ?? '').includes('Please send an ambulance')));

  const audits = await db.collection('auditlogs')
    .find({ $or: [{ resourceId: r.report.id }, { resourceId: emg.id }] }).toArray();
  const actions = new Set(audits.map((a) => a.action));
  check('audit: voice.report_created', actions.has('voice.report_created'));
  check('audit: voice.emergency_created', actions.has('voice.emergency_created'));

  const onDisk = await stat(join(STORAGE_DIR, r.report.audio.storageKey));
  check('audio bytes actually written to disk', onDisk.size === bytes.length, `${onDisk.size} bytes at ${r.report.audio.storageKey}`);

  // ── 12. Error states ──────────────────────────────────────────────────────
  const anon = await fetch(`${BASE}/api/voice/reports/recording`, { method: 'POST', body: uploadForm({ bytes, transcript: TRANSCRIPT }) });
  check('unauthenticated upload rejected (401)', anon.status === 401, `status ${anon.status}`);

  const boundaryless = await fetch(`${BASE}/api/voice/reports/recording`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${citizen}`, 'Content-Type': 'multipart/form-data' },
    body: 'not-a-multipart-body',
  });
  check('boundary-less multipart rejected (415)', boundaryless.status === 415, `status ${boundaryless.status}`);

  const empty = await uploadRecording(citizen, { bytes: new Uint8Array(0), transcript: TRANSCRIPT });
  check('empty recording rejected with a specific error (400 AUDIO_EMPTY)',
    empty.status === 400 && empty.body?.error?.code === 'AUDIO_EMPTY',
    `${empty.status} ${empty.body?.error?.code}`);

  const noLocation = await uploadRecording(citizen, { bytes, transcript: 'Please help me, I need assistance right now.' });
  check('no location → 202 awaiting location, no silent routing',
    noLocation.status === 202 && noLocation.body?.emergency === null &&
    noLocation.body?.dispatchStatus === 'AWAITING_LOCATION' &&
    /location/i.test(noLocation.body?.warning ?? ''),
    `status ${noLocation.status}, dispatch ${noLocation.body?.dispatchStatus}`);
  check('unresolved-location warning is actionable', /confirm the location/i.test(noLocation.body?.warning ?? ''));

  const noTranscript = await uploadRecording(citizen, { bytes });
  check('missing transcript → 422 TRANSCRIPTION_FAILED, recording kept',
    noTranscript.status === 422 && noTranscript.body?.error?.code === 'TRANSCRIPTION_FAILED',
    `${noTranscript.status} ${noTranscript.body?.error?.code}`);
  const failedReport = await db.collection('voicereports')
    .find({ status: 'FAILED' }).sort({ createdAt: -1 }).limit(1).toArray();
  check('failed transcription still stores the recording',
    failedReport.length === 1 && failedReport[0].audio?.status === 'STORED',
    failedReport[0]?._id ?? 'none');

  const crew = await login('crew@rapidaid.com', 'demo123', 'AMBULANCE_CREW');
  const foreign = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`, {
    headers: { Authorization: `Bearer ${crew}` },
  });
  check('another user cannot read the citizen recording (403/404)',
    foreign.status === 403 || foreign.status === 404, `status ${foreign.status}`);

  const noTokenAudio = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`);
  check('recording playback requires authentication (401)', noTokenAudio.status === 401, `status ${noTokenAudio.status}`);

  // HTTP Range delivery (HTML5 audio seeking) — 200 full, 206 slice, 416 bad.
  const fullAudio = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`, {
    headers: { Authorization: `Bearer ${citizen}` },
  });
  const fullSize = Number(fullAudio.headers.get('content-length'));
  check('audio endpoint advertises Accept-Ranges: bytes', fullAudio.headers.get('accept-ranges') === 'bytes');
  const ranged = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`, {
    headers: { Authorization: `Bearer ${citizen}`, Range: 'bytes=0-99' },
  });
  check('Range request → 206 with Content-Range',
    ranged.status === 206 && ranged.headers.get('content-range') === `bytes 0-99/${fullSize}`,
    `${ranged.status} ${ranged.headers.get('content-range')}`);
  const rangedBytes = Buffer.from(await ranged.arrayBuffer());
  check('Range slice is exactly 100 bytes', rangedBytes.byteLength === 100, `${rangedBytes.byteLength}`);
  const badRange = await fetch(`${BASE}/api/voice/reports/${r.report.id}/audio`, {
    headers: { Authorization: `Bearer ${citizen}`, Range: 'bytes=99999999-' },
  });
  check('unsatisfiable Range → 416', badRange.status === 416, `status ${badRange.status}`);

  await mongoose.disconnect();

  // ── Summary ───────────────────────────────────────────────────────────────
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log('FAILED:');
    for (const entry of failed) console.log(`  - ${entry.name}`);
    process.exitCode = 1;
  }
  console.log(`\nEmergency: ${emg?.id}  Report: ${r.report?.id}  Hospital: ${hosp?.hospitalId} (${r.distance} m)`);
}

main().catch((error) => {
  console.error('E2E run crashed:', error);
  process.exitCode = 1;
});
