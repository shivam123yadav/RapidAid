import bcrypt from 'bcryptjs';
import {
  AIDetection,
  Ambulance,
  AuditLog,
  Camera,
  Counter,
  DailyStat,
  Emergency,
  Hospital,
  Maintenance,
  Notification,
  Report,
  Shift,
  User,
  VoiceReport,
  ensureEmergencyIdempotencyIndex,
} from '../models/index.js';
import { logger } from '../config/logger.js';
import { DEMO_USERS, DEMO_COUNTERS } from './data/users.js';
import { EMERGENCIES_PART_1 } from './data/emergencies1.js';
import { EMERGENCIES_PART_2 } from './data/emergencies2.js';
import { AMBULANCES_PART_1 } from './data/ambulances1.js';
import { AMBULANCES_PART_2 } from './data/ambulances2.js';
import { DEMO_HOSPITALS } from './data/hospitals.js';
import { DEMO_DETECTIONS } from './data/detections.js';
import { DEMO_NOTIFICATIONS, DEMO_AUDIT } from './data/notifications-audit.js';
import { DEMO_DAILY_STATS, DEMO_VOICE_REPORTS, DEMO_VOICE_AUDIO_SECONDS } from './data/stats-voice.js';
import { DEMO_CAMERAS, DEMO_MAINTENANCE, DEMO_REPORTS, DEMO_SHIFTS } from './data/operations.js';
import { ensureHospitalGeoFields } from '../services/hospitalRoutingService.js';
import {
  storeVoiceAudio,
  inspectVoiceAudio,
  reconcileVoiceAudioIntegrity,
} from '../services/voiceAudioStorage.js';
import { reconcileStrandedAmbulances } from '../services/emergencyService.js';

/**
 * Idempotent demo-data seeder.
 *
 * Every document is written with `$setOnInsert` keyed on its human-readable
 * `_id`, so a first run on an empty DB inserts everything, subsequent runs
 * are no-ops (runtime changes made through the API are never clobbered),
 * and counters are only initialized when missing.
 */

type AnyDoc = Record<string, unknown> & { _id: string };

interface UpdatableModel {
  updateOne(filter: unknown, update: unknown, opts: unknown): { exec(): Promise<unknown> };
}


/** Full idempotent seed — safe to run repeatedly (CLI + boot path). */
export async function runSeed(): Promise<void> {
  const started = Date.now();
  const passwordHash = await bcrypt.hash('demo123', 10);

  await upsertAll(
    User,
    DEMO_USERS.map((u) => ({ ...u, passwordHash, active: true })) as unknown as AnyDoc[],
  );
  await upsertAll(Emergency, [...EMERGENCIES_PART_1, ...EMERGENCIES_PART_2] as AnyDoc[]);
  await upsertAll(Ambulance, [...AMBULANCES_PART_1, ...AMBULANCES_PART_2] as AnyDoc[]);
  await upsertAll(Hospital, DEMO_HOSPITALS as AnyDoc[]);
  await upsertAll(AIDetection, DEMO_DETECTIONS as AnyDoc[]);
  await upsertAll(Notification, DEMO_NOTIFICATIONS as AnyDoc[]);
  await upsertAll(AuditLog, DEMO_AUDIT as AnyDoc[]);
  await upsertAll(DailyStat, DEMO_DAILY_STATS as AnyDoc[]);
  await upsertAll(VoiceReport, await withDemoRecordings(DEMO_VOICE_REPORTS));

  // Integrity sweep: any remaining report that still advertises a recording the
  // storage layer cannot produce is marked LOST, so every response tells the
  // truth instead of rendering a player that can only fail.
  const integrity = await reconcileVoiceAudioIntegrity();
  if (integrity.markedLost.length > 0) {
    logger.warn(
      { reports: integrity.markedLost },
      'voice reports reference recordings that are no longer stored; marked LOST',
    );
  }

  // Idempotent recovery sweeps for database-level safety:
  await ensureEmergencyIdempotencyIndex();
  await reconcileStrandedAmbulances();

  await upsertAll(Camera, DEMO_CAMERAS as AnyDoc[]);
  await upsertAll(Shift, DEMO_SHIFTS as AnyDoc[]);
  await upsertAll(Maintenance, DEMO_MAINTENANCE as AnyDoc[]);
  await upsertAll(Report, DEMO_REPORTS as AnyDoc[]);

  for (const [key, seq] of Object.entries(DEMO_COUNTERS)) {
    await Counter.updateOne({ _id: key }, { $setOnInsert: { seq } }, { upsert: true }).exec();
  }

  await backfillDemoCrewLinks();
  await backfillDemoOwnershipLinks();
  await backfillDemoVoiceCounter();
  await backfillDemoHospitalPlaces();
  // GeoJSON points power the nearest-hospital $geoNear query. Backfilling here
  // means a freshly seeded database is immediately routable.
  await ensureHospitalGeoFields();

  logger.info({ ms: Date.now() - started }, 'Seed complete (idempotent upserts)');
}

/**
 * A short, genuinely decodable demo recording.
 *
 * Synthesised as 8-bit mono PCM WAV rather than a stub container so that
 * "Play Audio" in the UI actually produces sound during manual verification — a
 * file that passes the signature check but no decoder would verify the guard
 * without verifying anything a user can hear. The 220 Hz tone is quiet and faded
 * in and out so it is not obnoxious in an open demo.
 */
function demoRecordingTone(seconds = 2, sampleRate = 8000): Buffer {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples);
  const fade = Math.max(1, Math.floor(samples / 10));
  for (let i = 0; i < samples; i += 1) {
    const envelope = Math.min(i, samples - i, fade) / fade;
    const value = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 0.25 * envelope;
    // 8-bit PCM is unsigned, centred on 128.
    data[i] = Math.round(value * 127) + 128;
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM format-chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(1, 22); // channels = mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); // byte rate = rate * channels * bytes/sample
  header.writeUInt16LE(1, 32); // block align
  header.writeUInt16LE(8, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * Attaches stored recording metadata to the demo voice reports, and REPAIRS
 * reports whose audio reference no longer resolves to an object.
 *
 * The previous version of this function asked a single question — "do the
 * documents already exist?" — and returned early when they did. That assumption
 * is what produced the reported bug: a VoiceReport row can outlive the volume it
 * points at (a restored database, a redeploy onto a fresh container, a cleaned
 * temp directory), so the database kept a plausible `audio.storageKey` for
 * recordings that no longer existed anywhere. The UI then showed a healthy
 * transcript next to "the stored recording could not be found on the server".
 *
 * The question that actually matters is per-report and about the OBJECT, not the
 * row: if the referenced audio is missing or the wrong size, a recording is
 * stored and the metadata is repaired in place. Reports that already have a
 * valid object are left completely untouched, so a healthy seed never writes a
 * second copy or churns keys.
 */
async function withDemoRecordings(reports: readonly AnyDoc[]): Promise<AnyDoc[]> {
  const enriched: AnyDoc[] = [];
  for (const report of reports) {
    const existing = await VoiceReport.findById(report._id).select('audio').lean();
    const existingKey = existing?.audio?.storageKey ?? null;

    if (existingKey) {
      const integrity = await inspectVoiceAudio(existingKey, {
        size: existing?.audio?.size ?? null,
        checksum: existing?.audio?.checksum ?? null,
      });
      if (integrity.exists && integrity.size === existing?.audio?.size) {
        // Healthy: keep the document exactly as it is.
        enriched.push(report);
        continue;
      }
      // Dangling or truncated reference — repair it below.
      logger.warn(
        { reportId: report._id, storageKey: existingKey, size: integrity.size },
        'demo voice report references a missing recording; repairing',
      );
    }

    const stored = await storeVoiceAudio({
      audio: demoRecordingTone(),
      ownerId: String(report.ownerId ?? 'USR-008'),
      declaredMimeType: 'audio/wav',
      durationSeconds: DEMO_VOICE_AUDIO_SECONDS[report._id] ?? 7,
    });
    const audio = { ...stored, status: 'STORED' };
    enriched.push({ ...report, audio });
    if (existing) {
      // Update only the audio reference; every other field is left as-is so a
      // repair never rewrites transcript, extraction or emergency links.
      await VoiceReport.updateOne({ _id: report._id }, { $set: { audio } }).exec();
    }
  }
  return enriched;
}

/**
 * Links each demo AMBULANCE_CREW login to the roster seat it staffs.
 *
 * `upsertAll` is `$setOnInsert`, so databases seeded before crew ownership
 * existed have no `userId` on the roster — crew would 403 on their own unit.
 * This backfills only the *missing* link and never overwrites one an operator
 * has since set through the API, so it is safe to run on every boot.
 */
async function backfillDemoCrewLinks(): Promise<void> {
  const seatOwners: Record<string, { ambulanceId: string; seatId: string }> = {
    'USR-002': { ambulanceId: 'AMB-031', seatId: 'C009' },
  };

  for (const [userId, { ambulanceId, seatId }] of Object.entries(seatOwners)) {
    await Ambulance.updateOne(
      { _id: ambulanceId, crew: { $elemMatch: { _id: seatId, $or: [{ userId: { $exists: false } }, { userId: '' }] } } },
      { $set: { 'crew.$.userId': userId } },
    ).exec();
  }
}

/**
 * Backfills ownership fields introduced after the original demo seed.
 *
 * Demo documents use `$setOnInsert`, so an existing database cannot receive
 * newly added fields from a normal seed rerun. These updates are deliberately
 * constrained to known demo records and missing/empty values; they never
 * overwrite ownership assigned later through the API.
 */
async function backfillDemoOwnershipLinks(): Promise<void> {
  await User.updateOne(
    { _id: 'USR-003', $or: [{ hospitalId: { $exists: false } }, { hospitalId: null }, { hospitalId: '' }] },
    { $set: { hospitalId: 'HOSP-01' } },
  ).exec();
  await Emergency.updateOne(
    { _id: 'EMG-20482', $or: [{ citizenId: { $exists: false } }, { citizenId: null }, { citizenId: '' }] },
    { $set: { citizenId: 'USR-008' } },
  ).exec();
  await Emergency.updateOne(
    { _id: 'EMG-20482', $or: [{ assignedCrewIds: { $exists: false } }, { assignedCrewIds: { $size: 0 } }] },
    { $set: { assignedCrewIds: ['USR-002'] } },
  ).exec();
  await Emergency.updateOne(
    { _id: 'EMG-20482', $or: [{ assignedDispatcher: { $exists: false } }, { assignedDispatcher: null }, { assignedDispatcher: '' }] },
    { $set: { assignedDispatcher: 'USR-001' } },
  ).exec();

  const unlinkedEmergencies = await Emergency.find({
    assignedAmbulance: { $exists: true, $ne: null },
    $or: [{ assignedCrew: { $exists: false } }, { assignedCrew: { $size: 0 } }],
  }).exec();
  for (const emg of unlinkedEmergencies) {
    if (!emg.assignedAmbulance) continue;
    const amb = await Ambulance.findById(emg.assignedAmbulance).lean();
    if (amb && amb.crew && amb.crew.length > 0) {
      await Emergency.updateOne(
        { _id: emg._id, $or: [{ assignedCrew: { $exists: false } }, { assignedCrew: { $size: 0 } }] },
        {
          $set: {
            assignedCrew: amb.crew.map((c) => c.name),
            assignedCrewIds: amb.crew.map((c) => c.userId).filter((uid): uid is string => Boolean(uid)),
          },
        },
      ).exec();
    }
  }
}

/**
 * Raises the `voiceReport` counter to the highest id actually in use.
 *
 * Counters are only `$setOnInsert`, so a database seeded before `VR-002`
 * existed would keep allocating `VR-002` and every new voice report would
 * collide with the seeded document. `$max` moves the sequence forward only,
 * so a database that has already allocated past this point is untouched.
 */
async function backfillDemoVoiceCounter(): Promise<void> {
  const highest = await VoiceReport.find({}, '_id').sort({ _id: -1 }).limit(1).lean();
  const seq = Number(String(highest[0]?._id ?? '').replace(/^VR-/, ''));
  if (!Number.isFinite(seq) || seq <= 0) return;
  await Counter.updateOne({ _id: 'voiceReport' }, { $max: { seq } }, { upsert: true }).exec();
}

/**
 * Ensures the demo facilities carry `city` / `state`.
 *
 * The voice pipeline's gazetteer is derived from these two fields, and
 * `upsertAll` is `$setOnInsert`, so a database seeded before they existed has
 * empty values that a normal seed rerun will never fill. This backfills only
 * the demo records and only where the value is missing — operator-entered
 * master data is never overwritten.
 */
async function backfillDemoHospitalPlaces(): Promise<void> {
  for (const hospital of DEMO_HOSPITALS) {
    const set: Record<string, string> = {};
    if (hospital.city) set.city = hospital.city;
    if (hospital.state) set.state = hospital.state;
    if (Object.keys(set).length === 0) continue;
    await Hospital.updateOne(
      { _id: hospital._id, $or: [{ city: { $exists: false } }, { city: null }, { city: '' }] },
      { $set: set },
    ).exec();
  }
}

/** Seeds only when the users collection is empty (boot path). */
export async function seedIfEmpty(): Promise<boolean> {
  const existing = await User.countDocuments().exec();
  if (existing > 0) {
    // Ownership links are not user data, so refresh them even when skipping
    // the demo-data seed — otherwise a pre-RBAC database leaves crew locked
    // out of their own ambulance.
    await backfillDemoCrewLinks();
    await backfillDemoOwnershipLinks();
    await backfillDemoHospitalPlaces();
    // GeoJSON backfill is infrastructure, not demo data, so it also runs when
    // the demo seed is skipped — otherwise an older database has no `geo` field
    // and nearest-hospital routing silently degrades to the haversine scan.
    await ensureHospitalGeoFields();
    logger.info('Seed skipped — database already contains users');
    return false;
  }
  await runSeed();
  return true;
}

async function upsertAll(model: UpdatableModel, docs: readonly AnyDoc[]): Promise<void> {
  for (const doc of docs) {
    await model.updateOne({ _id: doc._id }, { $setOnInsert: { ...doc } }, { upsert: true }).exec();
  }
}
