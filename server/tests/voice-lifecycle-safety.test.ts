import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import { invalidateGazetteerCache } from '../src/services/geocodingService.js';
import { Emergency, VoiceReport } from '../src/models/index.js';
import { reconcileVoiceConfirmations } from '../src/services/voiceEmergencyService.js';

const app = createApp();
useTestDatabase(runSeed);

const STORAGE = join(tmpdir(), `rapidaid-voice-lifecycle-tests-${process.pid}`);
beforeAll(() => {
  process.env.VOICE_AUDIO_STORAGE_DIR = STORAGE;
  invalidateGazetteerCache();
});
afterAll(async () => {
  await rm(STORAGE, { recursive: true, force: true });
});

function webmAudio(bytes = 2048): Buffer {
  return Buffer.concat([
    Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1f]),
    Buffer.alloc(bytes, 0x42),
  ]);
}

function multipart(
  parts: Array<{ name: string; value: string } | { name: string; filename: string; mime: string; data: Buffer }>,
): { body: Buffer; contentType: string } {
  const boundary = '----RapidAidTestBoundary992384';
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

describe('Voice Lifecycle Safety Remediation', () => {
  // Test 1: 55% confidence transcript does not automatically create an Emergency
  it('1. 55% confidence transcript does not automatically create an Emergency', async () => {
    const token = await loginAs(app, 'citizen');
    const beforeCount = await Emergency.countDocuments();

    const res = await upload(token, [
      { name: 'audio', filename: 'vr4.webm', mime: 'audio/webm', data: webmAudio(1024) },
      // Like VR-004: low confidence, vague phrasing
      { name: 'transcript', value: 'Amen, Christ with a vehicle.' },
      { name: 'deviceLatitude', value: '28.6139' },
      { name: 'deviceLongitude', value: '77.2090' },
      { name: 'deviceAccuracy', value: '35' },
    ]);

    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.report.status).toBe('DRAFT');
    expect(res.body.extractedInformation.confidence).toBeLessThan(75);
    expect(res.body.warning).toMatch(/confirmation required|review/i);

    const afterCount = await Emergency.countDocuments();
    expect(afterCount).toBe(beforeCount);

    const storedReport = await VoiceReport.findById(res.body.report.id).lean();
    expect(storedReport?.status).toBe('DRAFT');
    expect(storedReport?.emergencyId).toBeUndefined();
  });

  // Test 2: Incident type OTHER requires review
  it('2. Incident type OTHER requires explicit human review and confirmation', async () => {
    const token = await loginAs(app, 'citizen');
    const beforeCount = await Emergency.countDocuments();

    // Transcript mentioning a location but unclassified incident type
    const res = await upload(token, [
      { name: 'audio', filename: 'other.webm', mime: 'audio/webm', data: webmAudio(1024) },
      { name: 'transcript', value: 'Something strange happened near Rajwada Square in Indore. Please send someone.' },
    ]);

    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.report.status).toBe('DRAFT');
    expect(res.body.extractedInformation.emergencyType).toBe('OTHER');
    expect(res.body.warning).toMatch(/OTHER|review/i);

    expect(await Emergency.countDocuments()).toBe(beforeCount);
  });

  // Test 3: Valid high-confidence report follows the approved creation policy
  it('3. Valid high-confidence report follows the approved creation policy and sets CONFIRMED', async () => {
    const token = await loginAs(app, 'citizen');
    const res = await upload(token, [
      { name: 'audio', filename: 'high.webm', mime: 'audio/webm', data: webmAudio(2048) },
      {
        name: 'transcript',
        value: 'Accident near Rajwada Square in Indore. Two people are injured. Please send an ambulance.',
      },
    ]);

    expect(res.status).toBe(201);
    expect(res.body.emergency).not.toBeNull();
    expect(res.body.emergency.id).toMatch(/^EMG-\d{5}$/);
    expect(res.body.report.status).toBe('CONFIRMED');
    expect(res.body.report.emergencyId).toBe(res.body.emergency.id);
    expect(res.body.dispatchStatus).toBe('DISPATCHER_NOTIFIED');

    const storedReport = await VoiceReport.findById(res.body.report.id).lean();
    expect(storedReport?.status).toBe('CONFIRMED');
    expect(storedReport?.emergencyId).toBe(res.body.emergency.id);

    const emergency = await Emergency.findById(res.body.emergency.id).lean();
    expect(emergency?.status).toBe('REPORTED');
  });

  // Test 4: Device GPS alone cannot bypass confirmation
  it('4. Device GPS alone cannot authorize automatic creation of an active Emergency', async () => {
    const token = await loginAs(app, 'citizen');
    const beforeCount = await Emergency.countDocuments();

    const res = await upload(token, [
      { name: 'audio', filename: 'gps-only.webm', mime: 'audio/webm', data: webmAudio(1024) },
      { name: 'transcript', value: 'Help us immediately, there was a terrible crash.' },
      { name: 'deviceLatitude', value: '22.7196' },
      { name: 'deviceLongitude', value: '75.8577' },
      { name: 'deviceAccuracy', value: '15' },
    ]);

    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.location.source).toBe('DEVICE');
    expect(res.body.report.status).toBe('DRAFT');
    expect(await Emergency.countDocuments()).toBe(beforeCount);
  });

  // Test 5: Out-of-coverage report remains recorded for manual review
  it('5. Out-of-coverage report remains recorded for manual review without active Emergency', async () => {
    const token = await loginAs(app, 'citizen');
    const beforeCount = await Emergency.countDocuments();

    // Coordinates in remote location far outside any hospital network (>50 km from Delhi/Indore)
    const res = await upload(token, [
      { name: 'audio', filename: 'remote.webm', mime: 'audio/webm', data: webmAudio(1024) },
      { name: 'transcript', value: 'Heart attack near Remote Desert Outpost in Ladakh.' },
      { name: 'deviceLatitude', value: '34.1526' },
      { name: 'deviceLongitude', value: '77.5771' },
      { name: 'deviceAccuracy', value: '50' },
    ]);

    expect(res.status).toBe(202);
    expect(res.body.emergency).toBeNull();
    expect(res.body.hospital).toBeNull();
    expect(res.body.dispatchStatus).toBe('BLOCKED_NO_HOSPITAL');
    expect(res.body.report.status).toBe('DRAFT');
    expect(await Emergency.countDocuments()).toBe(beforeCount);

    const stored = await VoiceReport.findById(res.body.report.id).lean();
    expect(stored?.status).toBe('DRAFT');
    expect(stored?.dispatchStatus).toBe('BLOCKED_NO_HOSPITAL');
  });

  // Test 6: Existing emergencyId prevents duplicate creation
  it('6. Existing emergencyId prevents duplicate emergency creation on confirm route', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');

    // Create an existing Emergency and VoiceReport with linked emergencyId
    const emg = await Emergency.create({
      _id: 'EMG-55001',
      incidentType: 'VEHICLE_COLLISION',
      priority: 'HIGH',
      status: 'REPORTED',
      source: 'VOICE_REPORT',
      location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada, Indore' },
      description: 'Existing emergency',
      reportedAt: new Date(),
      updatedAt: new Date(),
    });

    const vr = await VoiceReport.create({
      _id: 'VR-88001',
      ownerId: 'USR-008',
      status: 'DRAFT',
      confidence: 60,
      transcript: 'Accident here',
      createdAt: new Date(),
      emergencyId: emg._id,
      location: { latitude: 22.7196, longitude: 75.8577, source: 'DEVICE' },
      extractedData: { incidentType: 'VEHICLE_COLLISION' },
    });

    const beforeCount = await Emergency.countDocuments();

    // Confirm request on report that already has emergencyId
    const res = await request(app)
      .post(`/api/voice/reports/${vr._id}/confirm`)
      .set(bearer(dispatcher))
      .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada, Indore' } });

    expect([200, 201]).toContain(res.status);
    expect(res.body.emergency.id).toBe('EMG-55001');
    expect(await Emergency.countDocuments()).toBe(beforeCount);

    const updated = await VoiceReport.findById(vr._id).lean();
    expect(updated?.status).toBe('CONFIRMED');
    expect(updated?.emergencyId).toBe('EMG-55001');
  });

  // Test 7: Concurrent confirmation requests cannot create duplicates
  it('7. Concurrent confirmation requests cannot create duplicate emergencies', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');

    const vr = await VoiceReport.create({
      _id: 'VR-88002',
      ownerId: 'USR-008',
      status: 'DRAFT',
      confidence: 70,
      transcript: 'Accident near Rajwada Square in Indore.',
      createdAt: new Date(),
      location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
      extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
    });

    const beforeCount = await Emergency.countDocuments();
    const body = { location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } };

    const [resA, resB] = await Promise.all([
      request(app).post(`/api/voice/reports/${vr._id}/confirm`).set(bearer(dispatcher)).send(body),
      request(app).post(`/api/voice/reports/${vr._id}/confirm`).set(bearer(dispatcher)).send(body),
    ]);

    // Exactly one wins or safe idempotent replay; never 2 new emergencies
    const statuses = [resA.status, resB.status];
    expect(statuses).toContain(201);
    expect((await Emergency.countDocuments()) - beforeCount).toBe(1);

    const finalReport = await VoiceReport.findById(vr._id).lean();
    expect(finalReport?.status).toBe('CONFIRMED');
    expect(finalReport?.emergencyId).toBeTruthy();
  });

  // Test 8: Interrupted cross-collection lifecycle operations reconcile safely
  it('8. Interrupted lifecycle operations reconcile safely without data corruption', async () => {
    const dispatcher = await loginAs(app, 'dispatcher');

    // Simulate partial failure: emergency exists and is linked on VR, but VR status was interrupted as DRAFT
    const emg = await Emergency.create({
      _id: 'EMG-55003',
      incidentType: 'CARDIAC_ARREST',
      priority: 'CRITICAL',
      status: 'REPORTED',
      source: 'VOICE_REPORT',
      location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada' },
      description: 'Cardiac emergency',
      reportedAt: new Date(),
      updatedAt: new Date(),
    });

    const vr = await VoiceReport.create({
      _id: 'VR-88003',
      ownerId: 'USR-008',
      status: 'DRAFT',
      confidence: 85,
      transcript: 'Person having heart attack',
      createdAt: new Date(),
      emergencyId: emg._id,
      location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
      extractedData: { incidentType: 'CARDIAC_ARREST' },
    });

    // Reconcile via GET and confirm endpoints
    const getRes = await request(app).get(`/api/voice/reports/${vr._id}`).set(bearer(dispatcher));
    expect(getRes.status).toBe(200);
    expect(getRes.body.emergencyId).toBe('EMG-55003');
    expect(getRes.body.emergencyStatus).toBe('REPORTED');

    const confirmRes = await request(app)
      .post(`/api/voice/reports/${vr._id}/confirm`)
      .set(bearer(dispatcher))
      .send({ location: { lat: 22.7196, lng: 75.8577 } });

    expect([200, 201]).toContain(confirmRes.status);
    expect(confirmRes.body.emergency.id).toBe('EMG-55003');

    const reconciled = await VoiceReport.findById(vr._id).lean();
    expect(reconciled?.status).toBe('CONFIRMED');
    expect(reconciled?.emergencyId).toBe('EMG-55003');
  });

  // Test 9: VoiceReport and Emergency states remain consistent
  it('9. VoiceReport and Emergency states remain consistent across operations', async () => {
    const token = await loginAs(app, 'citizen');

    // Valid high-confidence run
    const res = await upload(token, [
      { name: 'audio', filename: 'consistent.webm', mime: 'audio/webm', data: webmAudio(2048) },
      {
        name: 'transcript',
        value: 'Accident near Rajwada Square in Indore. Two people are injured. Please send an ambulance.',
      },
    ]);

    expect(res.status).toBe(201);
    const emgId = res.body.emergency.id;
    const vrId = res.body.report.id;

    const vr = await VoiceReport.findById(vrId).lean();
    const emg = await Emergency.findById(emgId).lean();

    expect(vr?.status).toBe('CONFIRMED');
    expect(vr?.emergencyId).toBe(emgId);
    expect(emg?.status).toBe('REPORTED');
    expect(emg?.source).toBe('VOICE_REPORT');
  });

  describe('Crash-Safe Voice Confirmation & Reconciliation (Boundaries A–E)', () => {
    // Boundary A: Crash before confirmation claim
    it('Boundary A: crash before confirmation claim allows clean confirmation on restart', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91001',
        ownerId: 'USR-008',
        status: 'DRAFT',
        confidence: 85,
        transcript: 'Crash before claim test',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const beforeCount = await Emergency.countDocuments();
      const res = await request(app)
        .post(`/api/voice/reports/${vr._id}/confirm`)
        .set(bearer(dispatcher))
        .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } });

      expect(res.status).toBe(201);
      expect((await Emergency.countDocuments()) - beforeCount).toBe(1);
      const updated = await VoiceReport.findById(vr._id).lean();
      expect(updated?.status).toBe('CONFIRMED');
      expect(updated?.emergencyId).toBe(res.body.emergency.id);
    });

    // Boundary B: Crash after CONFIRMING claim, before Emergency creation
    it('Boundary B: crash after CONFIRMING claim (no emergency created) reverts safely to DRAFT on restart', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91002',
        ownerId: 'USR-008',
        status: 'CONFIRMING',
        confirmationOperationId: 'op_crash_b_001',
        confirmationStartedAt: new Date(Date.now() - 30_000), // stale lock (crashed 30s ago)
        confidence: 85,
        transcript: 'Crashed after claim before emergency creation',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const beforeCount = await Emergency.countDocuments();

      // Service restarts and invokes reconciliation
      const reconResult = await reconcileVoiceConfirmations({ staleTimeoutMs: 10_000 });
      expect(reconResult.revertedToDraft).toContain('VR-91002');

      const reverted = await VoiceReport.findById(vr._id).lean();
      expect(reverted?.status).toBe('DRAFT');
      expect(reverted?.emergencyId).toBeUndefined();
      expect(await Emergency.countDocuments()).toBe(beforeCount); // No orphan emergency

      // Dispatcher now confirms the draft cleanly
      const confirmRes = await request(app)
        .post(`/api/voice/reports/${vr._id}/confirm`)
        .set(bearer(dispatcher))
        .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } });

      expect(confirmRes.status).toBe(201);
      expect((await Emergency.countDocuments()) - beforeCount).toBe(1);

      const finalReport = await VoiceReport.findById(vr._id).lean();
      expect(finalReport?.status).toBe('CONFIRMED');
      expect(finalReport?.emergencyId).toBe(confirmRes.body.emergency.id);
    });

    // Boundary C: Crash after Emergency creation, before VoiceReport linkage (reconciled via sweep)
    it('Boundary C: crash after Emergency creation (before report linkage) reconciles via startup sweep without duplicates', async () => {
      const vr = await VoiceReport.create({
        _id: 'VR-91003',
        ownerId: 'USR-008',
        status: 'CONFIRMING',
        confirmationOperationId: 'op_crash_c_001',
        confirmationStartedAt: new Date(Date.now() - 20_000),
        confidence: 88,
        transcript: 'Crash after emergency created',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      // Emergency was created with durable voiceReportId before the process died
      const emg = await Emergency.create({
        _id: 'EMG-99001',
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'VEHICLE_COLLISION',
        location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' },
        source: 'VOICE_REPORT',
        description: 'Crash after emergency created',
        victimCount: 1,
        voiceReportId: 'VR-91003',
        confirmationOperationId: 'op_crash_c_001',
        reportedAt: new Date(),
        updatedAt: new Date(),
      });

      const beforeCount = await Emergency.countDocuments();

      // Service restarts and invokes reconciliation
      const reconResult = await reconcileVoiceConfirmations();
      expect(reconResult.linkedEmergencies).toContain('VR-91003');

      const linked = await VoiceReport.findById(vr._id).lean();
      expect(linked?.status).toBe('CONFIRMED');
      expect(linked?.emergencyId).toBe(emg._id);
      expect(await Emergency.countDocuments()).toBe(beforeCount); // Exactly 1 emergency, zero duplicates
    });

    // Boundary D: Crash after Emergency creation, recovered directly via client retry
    it('Boundary D: crash after Emergency creation recovers directly via client retry without creating duplicate', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91004',
        ownerId: 'USR-008',
        status: 'CONFIRMING',
        confirmationOperationId: 'op_crash_d_001',
        confirmationStartedAt: new Date(Date.now() - 25_000),
        confidence: 90,
        transcript: 'Crash before report linkage direct retry test',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const emg = await Emergency.create({
        _id: 'EMG-99002',
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'VEHICLE_COLLISION',
        location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' },
        source: 'VOICE_REPORT',
        description: 'Direct retry test',
        victimCount: 2,
        voiceReportId: 'VR-91004',
        confirmationOperationId: 'op_crash_d_001',
        reportedAt: new Date(),
        updatedAt: new Date(),
      });

      const beforeCount = await Emergency.countDocuments();

      // Client retries confirmation without waiting for background sweep
      const retryRes = await request(app)
        .post(`/api/voice/reports/${vr._id}/confirm`)
        .set(bearer(dispatcher))
        .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } });

      expect(retryRes.status).toBe(200);
      expect(retryRes.body.emergency.id).toBe(emg._id);
      expect(await Emergency.countDocuments()).toBe(beforeCount); // No duplicate emergency created

      const updated = await VoiceReport.findById(vr._id).lean();
      expect(updated?.status).toBe('CONFIRMED');
      expect(updated?.emergencyId).toBe(emg._id);
    });

    // Boundary E: Interrupted CONFIRMED without Emergency heals cleanly
    it('Boundary E: report left in CONFIRMED without an emergency heals back to DRAFT', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91005',
        ownerId: 'USR-008',
        status: 'CONFIRMED', // stranded in CONFIRMED without emergencyId
        confidence: 85,
        transcript: 'Stranded confirmed report without emergency',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const beforeCount = await Emergency.countDocuments();

      // Reconciliation heals it back to DRAFT
      const reconResult = await reconcileVoiceConfirmations();
      expect(reconResult.revertedToDraft).toContain('VR-91005');

      const healed = await VoiceReport.findById(vr._id).lean();
      expect(healed?.status).toBe('DRAFT');
      expect(healed?.emergencyId).toBeUndefined();

      // Confirmation can now complete and create the emergency
      const res = await request(app)
        .post(`/api/voice/reports/${vr._id}/confirm`)
        .set(bearer(dispatcher))
        .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } });

      expect(res.status).toBe(201);
      expect((await Emergency.countDocuments()) - beforeCount).toBe(1);

      const finalReport = await VoiceReport.findById(vr._id).lean();
      expect(finalReport?.status).toBe('CONFIRMED');
      expect(finalReport?.emergencyId).toBe(res.body.emergency.id);
    });

    // Boundary F: Repeated reconciliation is strictly idempotent
    it('Boundary F: repeated reconciliation runs idempotently without state corruption', async () => {
      // Run sweep 5 times consecutively
      for (let i = 0; i < 5; i++) {
        const result = await reconcileVoiceConfirmations();
        expect(Array.isArray(result.linkedEmergencies)).toBe(true);
        expect(Array.isArray(result.revertedToDraft)).toBe(true);
      }
    });

    // Boundary G: Legacy confirmed records compatibility
    it('Boundary G: existing legacy confirmed records (VR-002) remain compatible and untouched', async () => {
      const vr002 = await VoiceReport.findById('VR-002').lean();
      expect(vr002?.status).toBe('CONFIRMED');
      expect(vr002?.emergencyId).toBe('EMG-20481');

      // Reconciliation sweep does not alter legacy confirmed record
      await reconcileVoiceConfirmations();

      const vr002After = await VoiceReport.findById('VR-002').lean();
      expect(vr002After?.status).toBe('CONFIRMED');
      expect(vr002After?.emergencyId).toBe('EMG-20481');
    });

    // Boundary H: Concurrent confirmations cannot duplicate creation
    it('Boundary H: concurrent confirmation requests for the same VoiceReport create exactly one Emergency', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91006',
        ownerId: 'USR-008',
        status: 'DRAFT',
        confidence: 88,
        transcript: 'Concurrent confirmation requests test',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const beforeCount = await Emergency.countDocuments();

      // Launch 3 concurrent confirm requests
      const promises = [1, 2, 3].map(() =>
        request(app)
          .post(`/api/voice/reports/${vr._id}/confirm`)
          .set(bearer(dispatcher))
          .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } }),
      );

      const results = await Promise.all(promises);
      const successful = results.filter((r) => r.status === 200 || r.status === 201);
      // All successful responses (either 201 created or 200/409 resolved)
      expect(successful.length).toBeGreaterThanOrEqual(1);

      // Verify database-level uniqueness: Exactly 1 emergency created for VR-91006
      const emergencies = await Emergency.find({ voiceReportId: vr._id });
      expect(emergencies.length).toBe(1);
      expect((await Emergency.countDocuments()) - beforeCount).toBe(1);

      const finalReport = await VoiceReport.findById(vr._id).lean();
      expect(finalReport?.status).toBe('CONFIRMED');
      expect(finalReport?.emergencyId).toBe(emergencies[0]._id);
    });

    // Boundary I: Concurrent confirmation worker and reconciliation sweep
    it('Boundary I: concurrent confirmation worker and reconciliation sweep resolve cleanly without duplicates', async () => {
      const dispatcher = await loginAs(app, 'dispatcher');
      const vr = await VoiceReport.create({
        _id: 'VR-91007',
        ownerId: 'USR-008',
        status: 'DRAFT',
        confidence: 90,
        transcript: 'Concurrent worker and sweep test',
        createdAt: new Date(),
        location: { latitude: 22.7196, longitude: 75.8577, source: 'SPOKEN' },
        extractedData: { incidentType: 'VEHICLE_COLLISION', location: 'Rajwada Square' },
      });

      const beforeCount = await Emergency.countDocuments();

      // Fire confirm request and reconciliation sweep concurrently
      const [confirmRes, sweepRes] = await Promise.all([
        request(app)
          .post(`/api/voice/reports/${vr._id}/confirm`)
          .set(bearer(dispatcher))
          .send({ location: { lat: 22.7196, lng: 75.8577, address: 'Rajwada Square, Indore' } }),
        reconcileVoiceConfirmations(),
      ]);

      expect([200, 201]).toContain(confirmRes.status);
      expect(Array.isArray(sweepRes.linkedEmergencies)).toBe(true);

      const emergencies = await Emergency.find({ voiceReportId: vr._id });
      expect(emergencies.length).toBe(1);
      expect((await Emergency.countDocuments()) - beforeCount).toBe(1);

      const finalReport = await VoiceReport.findById(vr._id).lean();
      expect(finalReport?.status).toBe('CONFIRMED');
      expect(finalReport?.emergencyId).toBe(emergencies[0]._id);
    });
  });
});
