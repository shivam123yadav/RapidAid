import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { shutdownReconciliationAndDB } from '../src/index.js';
import { formatScopedIdempotencyKey } from '../src/middleware/idempotency.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import { bearer, loginAs } from './helpers.js';
import {
  Ambulance,
  AuditLog,
  Emergency,
  IdempotencyKey,
  ensureEmergencyIdempotencyIndex,
  isEmergencyIdempotencyIndexReady,
  setEmergencyIdempotencyIndexReady,
} from '../src/models/index.js';
import {
  runReconciliationSweep,
  startAmbulanceReconciliationScheduler,
  stopAmbulanceReconciliationScheduler,
  isReconciliationSchedulerRunning,
  isReconciliationShutdown,
  setReconciliationShutdown,
  reconcileStrandedAmbulances,
} from '../src/services/emergencyService.js';
import {
  inspectDuplicates,
  applyMigration,
  verifyIndex,
  BACKUP_COLLECTION_NAME,
} from '../scripts/migrate-idempotency-index.js';

const app = createApp();
useTestDatabase(runSeed);

describe('Milestone 2.1: Operational Hardening', () => {
  describe('Idempotency Index Safety & Readiness', () => {
    it('duplicate legacy keys cause no automatic document mutations', async () => {
      const now = new Date();
      const duplicateKey = `legacy-dup-key-${Date.now()}`;

      // Drop existing index to test startup index verification
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored if index doesn't exist
      }

      // Seed 2 emergencies with the same idempotency key
      const emg1 = await Emergency.create({
        _id: 'EMG-DUP-1',
        status: 'REPORTED',
        priority: 'HIGH',
        incidentType: 'CARDIAC_ARREST',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'CITIZEN_REPORT',
        description: 'First incident with duplicate key',
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
        idempotencyKey: duplicateKey,
      });

      const emg2 = await Emergency.create({
        _id: 'EMG-DUP-2',
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'RESPIRATORY_DISTRESS',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'CITIZEN_REPORT',
        description: 'Second incident with duplicate key',
        victimCount: 1,
        reportedAt: new Date(now.getTime() + 1000),
        updatedAt: now,
        idempotencyKey: duplicateKey,
      });

      // Run ensureEmergencyIdempotencyIndex
      const result = await ensureEmergencyIdempotencyIndex();

      expect(result.ready).toBe(false);
      expect(result.status).toBe('DUPLICATES_DETECTED');
      expect(result.duplicateCount).toBeGreaterThanOrEqual(1);
      expect(isEmergencyIdempotencyIndexReady()).toBe(false);

      // CRITICAL ASSERTION: Documents MUST NOT be modified or $unset!
      const reloaded1 = await Emergency.findById(emg1._id);
      const reloaded2 = await Emergency.findById(emg2._id);
      expect(reloaded1?.idempotencyKey).toBe(duplicateKey);
      expect(reloaded2?.idempotencyKey).toBe(duplicateKey);

      // Cleanup test documents
      await Emergency.deleteMany({ _id: { $in: ['EMG-DUP-1', 'EMG-DUP-2'] } });
    });

    it('index readiness rejects an ordinary non-unique index', async () => {
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      // Create an invalid non-unique index with the same name
      await Emergency.collection.createIndex(
        { idempotencyKey: 1 },
        { unique: false, sparse: true, name: 'idempotencyKey_1' },
      );

      const result = await ensureEmergencyIdempotencyIndex();
      expect(result.ready).toBe(false);
      expect(result.status).toBe('INVALID_EXISTING_INDEX');
      expect(isEmergencyIdempotencyIndexReady()).toBe(false);

      // Clean up invalid index
      await Emergency.collection.dropIndex('idempotencyKey_1');
    });

    it('successful index initialization reports the correct state and sets readiness', async () => {
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      const result = await ensureEmergencyIdempotencyIndex();
      expect(result.ready).toBe(true);
      expect(['CREATED', 'EXISTS']).toContain(result.status);
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);

      // Calling again should return EXISTS
      const secondResult = await ensureEmergencyIdempotencyIndex();
      expect(secondResult.ready).toBe(true);
      expect(secondResult.status).toBe('EXISTS');
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);
    });

    it('handles missing collection on a fresh database by safely creating collection and index', async () => {
      // Simulate fresh database where emergencies collection does not exist yet
      try {
        await Emergency.collection.drop();
      } catch {
        // Ignored if collection didn't exist
      }

      // Verify collection does not exist
      const collName = Emergency.collection.collectionName;
      const collectionsBefore = await Emergency.db!.db!.listCollections({ name: collName }).toArray();
      expect(collectionsBefore.length).toBe(0);

      // Startup initialization must succeed without 'ns does not exist' error
      const result = await ensureEmergencyIdempotencyIndex();
      expect(result.ready).toBe(true);
      expect(result.status).toBe('CREATED');
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);

      // Verify collection now exists and index is verified active
      const collectionsAfter = await Emergency.db!.db!.listCollections({ name: collName }).toArray();
      expect(collectionsAfter.length).toBe(1);

      const indexes = await Emergency.collection.indexes();
      const verified = indexes.find(
        (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
      );
      expect(verified).toBeDefined();
      expect(verified?.unique).toBe(true);
      expect(verified?.sparse).toBe(true);
    });

    it('repeated and concurrent initialization safely maintains readiness and returns EXISTS', async () => {
      // 1. Existing collection with required index returns EXISTS
      const res1 = await ensureEmergencyIdempotencyIndex();
      expect(res1.ready).toBe(true);
      expect(res1.status).toBe('EXISTS');

      const res2 = await ensureEmergencyIdempotencyIndex();
      expect(res2.ready).toBe(true);
      expect(res2.status).toBe('EXISTS');
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);

      // 2. Concurrent startup simulation (multiple instances/workers booting at once)
      const concurrentResults = await Promise.all([
        ensureEmergencyIdempotencyIndex(),
        ensureEmergencyIdempotencyIndex(),
        ensureEmergencyIdempotencyIndex(),
      ]);

      for (const res of concurrentResults) {
        expect(res.ready).toBe(true);
        expect(['EXISTS', 'CREATED']).toContain(res.status);
      }
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);
    });

    it('index creation failures are logged and reflected in readiness behavior', async () => {
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      // Mock createIndex to throw
      const originalCreateIndex = Emergency.collection.createIndex;
      Emergency.collection.createIndex = (async () => {
        throw new Error('Simulated MongoDB disk full error during index build');
      }) as never;

      try {
        const result = await ensureEmergencyIdempotencyIndex();
        expect(result.ready).toBe(false);
        expect(result.status).toBe('FAILED');
        expect(result.details).toContain('Simulated MongoDB disk full');
        expect(isEmergencyIdempotencyIndexReady()).toBe(false);
      } finally {
        Emergency.collection.createIndex = originalCreateIndex;
        // Restore healthy index
        await ensureEmergencyIdempotencyIndex();
      }
    });
  });

  describe('Explicit Index-Migration CLI Utilities', () => {
    it('migration inspection performs no writes and identifies duplicates deterministically', async () => {
      const now = new Date();
      const testKey = `cli-test-key-${Date.now()}`;

      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      await Emergency.create([
        {
          _id: 'EMG-CLI-1',
          status: 'REPORTED',
          priority: 'HIGH',
          incidentType: 'CARDIAC_ARREST',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Oldest duplicate incident',
          victimCount: 1,
          reportedAt: new Date(now.getTime() - 5000),
          updatedAt: now,
          idempotencyKey: testKey,
        },
        {
          _id: 'EMG-CLI-2',
          status: 'REPORTED',
          priority: 'MEDIUM',
          incidentType: 'FALL_INJURY',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Newer duplicate incident',
          victimCount: 1,
          reportedAt: now,
          updatedAt: now,
          idempotencyKey: testKey,
        },
      ]);

      const report = await inspectDuplicates();
      expect(report.duplicateGroupsCount).toBeGreaterThanOrEqual(1);

      const targetGroup = report.groups.find((g) => g.idempotencyKey === testKey);
      expect(targetGroup).toBeDefined();
      expect(targetGroup?.survivingRecordId).toBe('EMG-CLI-1'); // Oldest survives
      expect(targetGroup?.displacedRecordIds).toEqual(['EMG-CLI-2']);

      // Assert zero modifications to DB
      const count = await Emergency.countDocuments({ idempotencyKey: testKey });
      expect(count).toBe(2);

      await Emergency.deleteMany({ _id: { $in: ['EMG-CLI-1', 'EMG-CLI-2'] } });
    });

    it('migration aborts with error if not confirmed', async () => {
      await expect(applyMigration({ confirmed: false })).rejects.toThrow('--confirm flag is required');
    });

    it('migration aborts without modifying records if backup phase fails', async () => {
      const now = new Date();
      const testKey = `backup-fail-key-${Date.now()}`;

      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      await Emergency.create([
        {
          _id: 'EMG-BK-1',
          status: 'REPORTED',
          priority: 'HIGH',
          incidentType: 'CARDIAC_ARREST',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Incident 1',
          victimCount: 1,
          reportedAt: now,
          updatedAt: now,
          idempotencyKey: testKey,
        },
        {
          _id: 'EMG-BK-2',
          status: 'REPORTED',
          priority: 'MEDIUM',
          incidentType: 'FALL_INJURY',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Incident 2',
          victimCount: 1,
          reportedAt: new Date(now.getTime() + 1000),
          updatedAt: now,
          idempotencyKey: testKey,
        },
      ]);

      const db = mongoose.connection.db!;
      const originalCollection = db.collection.bind(db);

      // Force failure during backup insertMany
      db.collection = ((name: string) => {
        if (name === BACKUP_COLLECTION_NAME) {
          return {
            insertMany: async () => {
              throw new Error('Simulated disk failure during backup phase');
            },
          };
        }
        return originalCollection(name);
      }) as never;

      try {
        await expect(applyMigration({ confirmed: true })).rejects.toThrow('Backup failed');

        // Verify that NO documents were modified in Emergency collection!
        const reloaded = await Emergency.countDocuments({ idempotencyKey: testKey });
        expect(reloaded).toBe(2);
      } finally {
        db.collection = originalCollection;
        await Emergency.deleteMany({ _id: { $in: ['EMG-BK-1', 'EMG-BK-2'] } });
      }
    });

    it('migration applies cleanly with backup, deduplication, and index verification', async () => {
      const now = new Date();
      const testKey = `clean-migrate-key-${Date.now()}`;

      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      await Emergency.create([
        {
          _id: 'EMG-APPLY-1',
          status: 'REPORTED',
          priority: 'HIGH',
          incidentType: 'CARDIAC_ARREST',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Incident 1 (Survivor)',
          victimCount: 1,
          reportedAt: now,
          updatedAt: now,
          idempotencyKey: testKey,
        },
        {
          _id: 'EMG-APPLY-2',
          status: 'REPORTED',
          priority: 'MEDIUM',
          incidentType: 'FALL_INJURY',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'CITIZEN_REPORT',
          description: 'Incident 2 (Displaced)',
          victimCount: 1,
          reportedAt: new Date(now.getTime() + 2000),
          updatedAt: now,
          idempotencyKey: testKey,
        },
      ]);

      const result = await applyMigration({ confirmed: true });
      expect(result.success).toBe(true);
      expect(result.backedUpCount).toBeGreaterThanOrEqual(1);
      expect(result.unsetCount).toBeGreaterThanOrEqual(1);

      // Verify survivor retains key, displaced had key unset
      const survivor = await Emergency.findById('EMG-APPLY-1');
      const displaced = await Emergency.findById('EMG-APPLY-2');
      expect(survivor?.idempotencyKey).toBe(testKey);
      expect(displaced?.idempotencyKey).toBeUndefined();

      // Verify backup document was stored in backup collection
      const db = mongoose.connection.db!;
      const backupDoc = await db.collection(BACKUP_COLLECTION_NAME).findOne({ originalId: 'EMG-APPLY-2' });
      expect(backupDoc).toBeDefined();
      expect(backupDoc?.originalDoc.idempotencyKey).toBe(testKey);

      // Verify index directly via CLI verifyIndex function
      const verification = await verifyIndex();
      expect(verification.verified).toBe(true);
      expect(verification.remainingDuplicates).toBe(0);

      // Cleanup
      await Emergency.deleteMany({ _id: { $in: ['EMG-APPLY-1', 'EMG-APPLY-2'] } });
      await db.collection(BACKUP_COLLECTION_NAME).deleteMany({});
    });
  });

  describe('Periodic Ambulance Reconciliation Scheduler', () => {
    it('scheduler starts, stops, and prevents overlapping concurrent execution', async () => {
      expect(isReconciliationSchedulerRunning()).toBe(false);

      // Start with small interval and zero initial jitter
      startAmbulanceReconciliationScheduler(5000, 0);
      expect(isReconciliationSchedulerRunning()).toBe(true);

      // Trigger two concurrent reconciliation sweeps
      const sweep1Promise = runReconciliationSweep();
      const sweep2Promise = runReconciliationSweep();

      // They should return the exact same promise instance (overlap prevention)
      expect(sweep1Promise).toBe(sweep2Promise);

      const [res1, res2] = await Promise.all([sweep1Promise, sweep2Promise]);
      expect(res1).toEqual(res2);

      // Stop scheduler
      await stopAmbulanceReconciliationScheduler();
      expect(isReconciliationSchedulerRunning()).toBe(false);
      setReconciliationShutdown(false);
    });

    it('reconciliation sweep preserves active and retasked ambulances', async () => {
      const now = new Date();

      const emgActive = await Emergency.create({
        _id: 'EMG-SCHED-ACT',
        status: 'AMBULANCE_ASSIGNED',
        priority: 'CRITICAL',
        incidentType: 'CARDIAC_ARREST',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Active emergency',
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
      });

      const emgTerminal = await Emergency.create({
        _id: 'EMG-SCHED-TERM',
        status: 'COMPLETED',
        priority: 'MEDIUM',
        incidentType: 'FALL_INJURY',
        location: { lat: 28.6139, lng: 77.209 },
        source: 'DISPATCHER',
        description: 'Completed emergency',
        victimCount: 1,
        reportedAt: now,
        updatedAt: now,
      });

      await Ambulance.create([
        {
          _id: 'AMB-S1',
          status: 'ASSIGNED',
          currentEmergency: emgActive._id,
          location: { lat: 28.6139, lng: 77.209 },
          speed: 0,
          heading: 0,
          crew: [],
          capabilities: [],
          equipment: [],
          lastUpdated: now,
        },
        {
          _id: 'AMB-S2',
          status: 'ASSIGNED',
          currentEmergency: emgTerminal._id,
          location: { lat: 28.6139, lng: 77.209 },
          speed: 0,
          heading: 0,
          crew: [],
          capabilities: [],
          equipment: [],
          lastUpdated: now,
        },
      ]);

      const outcome = await runReconciliationSweep();
      expect(outcome.released).toContain('AMB-S2');
      expect(outcome.skippedActive).toContain('AMB-S1');

      const amb1 = await Ambulance.findById('AMB-S1');
      const amb2 = await Ambulance.findById('AMB-S2');
      expect(amb1?.status).toBe('ASSIGNED');
      expect(amb1?.currentEmergency).toBe(emgActive._id);
      expect(amb2?.status).toBe('AVAILABLE');
      expect(amb2?.currentEmergency).toBeNull();

      await Emergency.deleteMany({ _id: { $in: ['EMG-SCHED-ACT', 'EMG-SCHED-TERM'] } });
      await Ambulance.deleteMany({ _id: { $in: ['AMB-S1', 'AMB-S2'] } });
    });
  });

  describe('Operator Endpoint: POST /api/ambulances/reconcile', () => {
    it('rejects unauthenticated requests with 401', async () => {
      const res = await request(app).post('/api/ambulances/reconcile');
      expect(res.status).toBe(401);
    });

    it('rejects roles lacking AMBULANCE_UPDATE with 403', async () => {
      const tokenCitizen = await loginAs(app, 'citizen');
      const resCitizen = await request(app)
        .post('/api/ambulances/reconcile')
        .set(bearer(tokenCitizen));
      expect(resCitizen.status).toBe(403);

      const tokenDispatcher = await loginAs(app, 'dispatcher');
      const resDispatcher = await request(app)
        .post('/api/ambulances/reconcile')
        .set(bearer(tokenDispatcher));
      expect(resDispatcher.status).toBe(403);
    });

    it('allows supervisors and admins with AMBULANCE_UPDATE and records audit log', async () => {
      const tokenAdmin = await loginAs(app, 'admin');
      const res = await request(app)
        .post('/api/ambulances/reconcile')
        .set(bearer(tokenAdmin));

      expect(res.status).toBe(200);
      expect(res.body.checked).toBeDefined();
      expect(Array.isArray(res.body.released)).toBe(true);
      expect(Array.isArray(res.body.skippedActive)).toBe(true);

      // Verify audit log was recorded
      const audit = await AuditLog.findOne({
        action: 'ambulance.reconciled_manually',
      }).sort({ timestamp: -1 });

      expect(audit).toBeDefined();
      expect(audit?.resource).toBe('Ambulance');
      expect(audit?.details).toContain('Manual reconciliation executed');
    });
  });

  describe('Milestone 2.1 Safety Refinements: Fail-Closed & Shutdown Draining', () => {
    describe('FIX 1: Fail closed for idempotent emergency creation when deduplication is unavailable', () => {
      it('returns 503 with Retry-After: 30 when Idempotency-Key is provided and index is not ready', async () => {
        setEmergencyIdempotencyIndexReady(false);
        const citizenToken = await loginAs(app, 'citizen');
        const testKey = `unverified-key-${Date.now()}`;

        const beforeCount = await Emergency.countDocuments();
        const beforeAudits = await AuditLog.countDocuments({ action: 'emergency.created' });
        const beforeKeys = await IdempotencyKey.countDocuments();

        const res = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .set('Idempotency-Key', testKey)
          .send({
            incidentType: 'CARDIAC_ARREST',
            priority: 'CRITICAL',
            location: { lat: 28.6139, lng: 77.209 },
            description: 'Patient unresponsive',
            victimCount: 1,
            attachments: [],
          });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('30');
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');

        // Zero side effects
        const afterCount = await Emergency.countDocuments();
        const afterAudits = await AuditLog.countDocuments({ action: 'emergency.created' });
        const afterKeys = await IdempotencyKey.countDocuments();
        expect(afterCount).toBe(beforeCount);
        expect(afterAudits).toBe(beforeAudits);
        expect(afterKeys).toBe(beforeKeys);
      });

      it('returns 503 with Retry-After: 30 when X-Idempotency-Key is provided and index is not ready', async () => {
        setEmergencyIdempotencyIndexReady(false);
        const citizenToken = await loginAs(app, 'citizen');
        const testKey = `unverified-x-key-${Date.now()}`;

        const res = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .set('X-Idempotency-Key', testKey)
          .send({
            incidentType: 'RESPIRATORY_DISTRESS',
            priority: 'HIGH',
            location: { lat: 28.6139, lng: 77.209 },
            description: 'Severe asthma attack',
            victimCount: 1,
            attachments: [],
          });

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('30');
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
      });

      it('unkeyed emergency creation remains available when idempotency index is not ready', async () => {
        setEmergencyIdempotencyIndexReady(false);
        const citizenToken = await loginAs(app, 'citizen');

        const beforeCount = await Emergency.countDocuments();

        const res = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .send({
            incidentType: 'CARDIAC_ARREST',
            priority: 'HIGH',
            location: { lat: 28.6139, lng: 77.209 },
            description: 'Unkeyed emergency creation should succeed',
            victimCount: 1,
            attachments: [],
          });

        expect(res.status).toBe(201);
        expect(res.body.id).toBeDefined();

        const afterCount = await Emergency.countDocuments();
        expect(afterCount).toBe(beforeCount + 1);

        // Cleanup
        await Emergency.deleteOne({ _id: res.body.id });
      });

      it('health and readiness reflect degraded deduplication without evicting instance or breaking 7-service contract', async () => {
        setEmergencyIdempotencyIndexReady(false);
        const adminToken = await loginAs(app, 'admin');

        // GET /api/system/health
        const healthRes = await request(app)
          .get('/api/system/health')
          .set(bearer(adminToken));

        expect(healthRes.status).toBe(200);
        expect(healthRes.body.status).toBe('DEGRADED');
        expect(healthRes.body.idempotencyReady).toBe(false);
        expect(healthRes.body.capabilities?.idempotentEmergencyCreation).toBe('DEGRADED');

        // EXACTLY 7 services preserved in array
        expect(healthRes.body.services).toHaveLength(7);
        const serviceNames = healthRes.body.services.map((s: { service: string }) => s.service);
        expect(serviceNames).toEqual([
          'API Gateway',
          'Database',
          'Real-time (WebSocket)',
          'AI Vision Service',
          'Voice AI',
          'Maps Service',
          'Notification Service',
        ]);

        const dbService = healthRes.body.services.find((s: { service: string }) => s.service === 'Database');
        expect(dbService?.status).toBe('OPERATIONAL');
        expect(dbService?.details).toContain('idempotency index degraded');

        // /readyz returns 200 (not 503) so instance is not removed by load balancer
        const readyzRes = await request(app).get('/readyz');
        expect(readyzRes.status).toBe(200);
        expect(readyzRes.body.status).toBe('ready');
        expect(readyzRes.body.capabilities?.emergencyDeduplication).toBe('degraded');
      });

      it('recovers to full operational status and allows keyed creation once index is ready', async () => {
        setEmergencyIdempotencyIndexReady(true);
        const adminToken = await loginAs(app, 'admin');
        const citizenToken = await loginAs(app, 'citizen');

        const healthRes = await request(app)
          .get('/api/system/health')
          .set(bearer(adminToken));

        expect(healthRes.status).toBe(200);
        expect(healthRes.body.status).toBe('OPERATIONAL');
        expect(healthRes.body.idempotencyReady).toBe(true);
        expect(healthRes.body.capabilities?.idempotentEmergencyCreation).toBe('OPERATIONAL');

        const dbService = healthRes.body.services.find((s: { service: string }) => s.service === 'Database');
        expect(dbService?.details).toContain('idempotency index verified');

        // Now keyed creation succeeds
        const testKey = `recovered-key-${Date.now()}`;
        const createRes = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .set('Idempotency-Key', testKey)
          .send({
            incidentType: 'RESPIRATORY_DISTRESS',
            priority: 'HIGH',
            location: { lat: 28.6139, lng: 77.209 },
            description: 'Keyed emergency creation after recovery',
            victimCount: 1,
            attachments: [],
          });

        expect(createRes.status).toBe(201);
        expect(createRes.body.id).toBeDefined();

        await Emergency.deleteOne({ _id: createRes.body.id });
      });

      it('two separate authenticated users submitting the same raw key create two separate emergencies without collision or 500 error', async () => {
        setEmergencyIdempotencyIndexReady(true);
        const citizenToken = await loginAs(app, 'citizen'); // USR-006
        const dispatcherToken = await loginAs(app, 'dispatcher'); // USR-001
        const sharedRawKey = `multi-user-raw-key-${Date.now()}`;

        const payloadCitizen = {
          incidentType: 'CARDIAC_ARREST',
          priority: 'CRITICAL',
          location: { lat: 28.6139, lng: 77.209 },
          description: 'Citizen emergency with shared key',
          victimCount: 1,
          attachments: [],
        };

        const payloadDispatcher = {
          incidentType: 'RESPIRATORY_DISTRESS',
          priority: 'HIGH',
          location: { lat: 28.7041, lng: 77.1025 },
          description: 'Dispatcher emergency with shared key',
          victimCount: 1,
          attachments: [],
        };

        // User 1 creates emergency
        const res1 = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .set('Idempotency-Key', sharedRawKey)
          .send(payloadCitizen);

        expect(res1.status).toBe(201);
        expect(res1.body.id).toBeDefined();

        // User 2 creates emergency with identical raw key
        const res2 = await request(app)
          .post('/api/emergencies')
          .set(bearer(dispatcherToken))
          .set('Idempotency-Key', sharedRawKey)
          .send(payloadDispatcher);

        expect(res2.status).toBe(201);
        expect(res2.body.id).toBeDefined();
        expect(res2.body.id).not.toBe(res1.body.id);

        // Verify database isolation: scoped keys are stored
        const emg1 = await Emergency.findById(res1.body.id);
        const emg2 = await Emergency.findById(res2.body.id);
        expect(emg1?.idempotencyKey).toBe(formatScopedIdempotencyKey('USR-008', 'POST /api/emergencies', sharedRawKey));
        expect(emg2?.idempotencyKey).toBe(formatScopedIdempotencyKey('USR-001', 'POST /api/emergencies', sharedRawKey));

        // Replay verification: User 1 gets User 1's emergency, User 2 gets User 2's emergency
        const replay1 = await request(app)
          .post('/api/emergencies')
          .set(bearer(citizenToken))
          .set('Idempotency-Key', sharedRawKey)
          .send(payloadCitizen);
        expect(replay1.status).toBe(201);
        expect(replay1.headers['idempotent-replayed']).toBe('true');
        expect(replay1.body.id).toBe(res1.body.id);

        const replay2 = await request(app)
          .post('/api/emergencies')
          .set(bearer(dispatcherToken))
          .set('Idempotency-Key', sharedRawKey)
          .send(payloadDispatcher);
        expect(replay2.status).toBe(201);
        expect(replay2.headers['idempotent-replayed']).toBe('true');
        expect(replay2.body.id).toBe(res2.body.id);

        await Emergency.deleteMany({ _id: { $in: [res1.body.id, res2.body.id] } });
      });
    });

    describe('FIX 2: Safe reconciliation shutdown and draining', () => {
      beforeEach(() => {
        setReconciliationShutdown(false);
      });

      afterEach(() => {
        setReconciliationShutdown(false);
      });

      it('manual reconciliation route returns 503 + Retry-After: 10 during shutdown without DB work', async () => {
        const adminToken = await loginAs(app, 'admin');
        setReconciliationShutdown(true);

        const beforeAudits = await AuditLog.countDocuments({ action: 'ambulance.reconciled_manually' });

        const res = await request(app)
          .post('/api/ambulances/reconcile')
          .set(bearer(adminToken));

        expect(res.status).toBe(503);
        expect(res.headers['retry-after']).toBe('10');
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');

        // Zero audit logs recorded
        const afterAudits = await AuditLog.countDocuments({ action: 'ambulance.reconciled_manually' });
        expect(afterAudits).toBe(beforeAudits);
      });

      it('runReconciliationSweep rejects immediately with 503 if shutdown has begun', async () => {
        setReconciliationShutdown(true);
        await expect(runReconciliationSweep()).rejects.toThrow('shutting down');
      });

      it('cooperative cancellation halts reconcileStrandedAmbulances without processing remaining items', async () => {
        const now = new Date();
        const emg = await Emergency.create({
          _id: 'EMG-COOP-TERM',
          status: 'COMPLETED',
          priority: 'LOW',
          incidentType: 'FALL_INJURY',
          location: { lat: 28.6139, lng: 77.209 },
          source: 'DISPATCHER',
          description: 'Terminal emergency for cancellation test',
          victimCount: 1,
          reportedAt: now,
          updatedAt: now,
        });

        await Ambulance.create([
          {
            _id: 'AMB-COOP-1',
            status: 'ASSIGNED',
            currentEmergency: emg._id,
            location: { lat: 28.6139, lng: 77.209 },
            speed: 0,
            heading: 0,
            crew: [],
            capabilities: [],
            equipment: [],
            lastUpdated: now,
          },
          {
            _id: 'AMB-COOP-2',
            status: 'ASSIGNED',
            currentEmergency: emg._id,
            location: { lat: 28.6139, lng: 77.209 },
            speed: 0,
            heading: 0,
            crew: [],
            capabilities: [],
            equipment: [],
            lastUpdated: now,
          },
        ]);

        // Cancellation before start returns checked: 0
        const preCancelled = await reconcileStrandedAmbulances({ isCancelled: () => true });
        expect(preCancelled.checked).toBe(0);
        expect(preCancelled.released).toHaveLength(0);

        // Ambulances should remain ASSIGNED
        const amb1Before = await Ambulance.findById('AMB-COOP-1');
        expect(amb1Before?.status).toBe('ASSIGNED');

        // Cancellation after 1 item
        let count = 0;
        const midCancelled = await reconcileStrandedAmbulances({
          isCancelled: () => {
            count++;
            return count > 1; // cancel after inspecting first
          },
        });

        // Checked so far, loop stopped cooperatively
        expect(midCancelled.checked).toBe(2);
        // At most 1 released
        expect(midCancelled.released.length).toBeLessThanOrEqual(1);

        await Ambulance.deleteMany({ _id: { $in: ['AMB-COOP-1', 'AMB-COOP-2'] } });
        await Emergency.deleteOne({ _id: 'EMG-COOP-TERM' });
      });

      it('multiple shutdown invocations do not race through cleanup', async () => {
        startAmbulanceReconciliationScheduler(5000, 0);

        const shutdown1 = stopAmbulanceReconciliationScheduler(2000);
        const shutdown2 = stopAmbulanceReconciliationScheduler(2000);

        expect(shutdown1).toBe(shutdown2); // Idempotent same promise
        await Promise.all([shutdown1, shutdown2]);
        expect(isReconciliationShutdown()).toBe(true);
      });

      it('shutdown timeout path raises DrainTimeoutError with isDrainTimeout=true when sweep does not drain', async () => {
        const originalFind = Ambulance.find;
        let unblockFind: () => void = () => {};
        (Ambulance as unknown as { find: unknown }).find = () => {
          return {
            lean: () =>
              new Promise((resolve) => {
                unblockFind = () => resolve([]);
              }),
          };
        };

        try {
          const activePromise = runReconciliationSweep();

          let drainError: unknown = null;
          try {
            await stopAmbulanceReconciliationScheduler(50);
          } catch (err) {
            drainError = err;
          }

          expect(drainError).toBeDefined();
          expect((drainError as { isDrainTimeout?: boolean }).isDrainTimeout).toBe(true);
          expect((drainError as Error).message).toContain('Reconciliation sweep drain timed out');

          // Unblock the hanging query so no dangling promises remain
          unblockFind();
          await activePromise.catch(() => {});
        } finally {
          (Ambulance as unknown as { find: unknown }).find = originalFind;
          setReconciliationShutdown(false);
        }
      });

      it('fail-stop path executes on timeout: disconnectDB() is NOT called while sweep is unsettled and runner is not terminated', async () => {
        const originalFind = Ambulance.find;
        let unblockQuery: () => void = () => {};
        let sweepSettled = false;

        // Create a deliberately hanging MongoDB query to simulate an unsettled sweep
        (Ambulance as unknown as { find: unknown }).find = () => {
          return {
            lean: () =>
              new Promise((resolve) => {
                unblockQuery = () => {
                  sweepSettled = true;
                  resolve([]);
                };
              }),
          };
        };

        const mockDisconnectDB = vi.fn().mockResolvedValue(undefined);
        const mockExit = vi.fn();

        try {
          // Launch the active sweep
          const activePromise = runReconciliationSweep();
          expect(sweepSettled).toBe(false);

          // Trigger shutdown with short timeout
          await shutdownReconciliationAndDB({
            drainGracePeriodMs: 50,
            disconnectDatabase: mockDisconnectDB,
            exitProcess: mockExit,
          });

          // Critical assertions:
          // 1. Fail-stop path was exercised: exitProcess called with code 1
          expect(mockExit).toHaveBeenCalledWith(1);

          // 2. Database disconnect was NOT called because sweep was unsettled
          expect(mockDisconnectDB).not.toHaveBeenCalled();

          // 3. Verify sweep was indeed unsettled at the time of fail-stop
          expect(sweepSettled).toBe(false);

          // Clean up: unblock the query
          unblockQuery();
          await activePromise.catch(() => {});
          expect(sweepSettled).toBe(true);
        } finally {
          (Ambulance as unknown as { find: unknown }).find = originalFind;
          setReconciliationShutdown(false);
        }
      });

      it('shutdown state cannot be accidentally reversed if cleanup has started', async () => {
        setReconciliationShutdown(true);
        expect(isReconciliationShutdown()).toBe(true);

        // When shutting down, sweeping is blocked
        await expect(runReconciliationSweep()).rejects.toThrow('shutting down');

        setReconciliationShutdown(false);
        expect(isReconciliationShutdown()).toBe(false);
      });
    });
  });
});

