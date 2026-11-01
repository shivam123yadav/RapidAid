import { describe, expect, it, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { runSeed } from '../src/seed/seed.js';
import { useTestDatabase } from './setup.js';
import {
  Emergency,
  ensureEmergencyCollection,
  ensureEmergencyIdempotencyIndex,
  isEmergencyIdempotencyIndexReady,
  setEmergencyIdempotencyIndexReady,
} from '../src/models/index.js';

createApp();
useTestDatabase(runSeed);

describe('Emergency Idempotency Index Lifecycle & Initialization', () => {
  beforeEach(async () => {
    // Ensure clean state before each test
    await ensureEmergencyCollection();
    setEmergencyIdempotencyIndexReady(false);
  });

  // 1. Missing collection
  it('1. missing collection: safely creates collection and verifies unique sparse index on fresh database', async () => {
    const collName = Emergency.collection.collectionName;
    const nativeDb = Emergency.db!.db!;

    // Drop collection entirely to simulate a brand-new staging/production database
    try {
      await Emergency.collection.drop();
    } catch {
      // Ignored if collection didn't exist
    }

    const collectionsBefore = await nativeDb.listCollections({ name: collName }).toArray();
    expect(collectionsBefore.length).toBe(0);

    // ensureEmergencyIdempotencyIndex must not throw 'ns does not exist'
    const result = await ensureEmergencyIdempotencyIndex();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('CREATED');
    expect(isEmergencyIdempotencyIndexReady()).toBe(true);

    // Verify collection was created
    const collectionsAfter = await nativeDb.listCollections({ name: collName }).toArray();
    expect(collectionsAfter.length).toBe(1);

    // Verify unique sparse index is verified active
    const indexes = await Emergency.collection.indexes();
    const verified = indexes.find(
      (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
    );
    expect(verified).toBeDefined();
    expect(verified?.unique).toBe(true);
    expect(verified?.sparse).toBe(true);
  });

  // 2. Existing collection with the required index
  it('2. existing collection with required index: verifies index and returns status EXISTS without recreating', async () => {
    // Ensure index exists first
    const initResult = await ensureEmergencyIdempotencyIndex();
    expect(initResult.ready).toBe(true);

    // Second call on existing collection with required index
    const result = await ensureEmergencyIdempotencyIndex();
    expect(result.ready).toBe(true);
    expect(result.status).toBe('EXISTS');
    expect(isEmergencyIdempotencyIndexReady()).toBe(true);
  });

  // 3. Existing collection without the required index
  describe('3. existing collection without required index', () => {
    it('creates and verifies the missing index when collection exists but has no idempotency index', async () => {
      // Drop the specific index
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      // Verify index is absent
      const indexesBefore = await Emergency.collection.indexes();
      const absent = indexesBefore.find(
        (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
      );
      expect(absent).toBeUndefined();

      // Initialization should create the index
      const result = await ensureEmergencyIdempotencyIndex();
      expect(result.ready).toBe(true);
      expect(result.status).toBe('CREATED');
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);

      // Verify the index was actually created and is active
      const indexesAfter = await Emergency.collection.indexes();
      const verified = indexesAfter.find(
        (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
      );
      expect(verified).toBeDefined();
      expect(verified?.unique).toBe(true);
      expect(verified?.sparse).toBe(true);
    });

    it('rejects an invalid index that lacks required unique=true and sparse=true flags', async () => {
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
      expect(result.details).toContain('unique=false');
      expect(isEmergencyIdempotencyIndexReady()).toBe(false);

      // Clean up invalid index
      await Emergency.collection.dropIndex('idempotencyKey_1');
    });
  });

  // 4. Duplicate idempotency keys
  it('4. duplicate idempotency keys: detects duplicates, reports DUPLICATES_DETECTED, and preserves records without mutation', async () => {
    const existingIndexes = await Emergency.collection.indexes();
    for (const idx of existingIndexes) {
      if (idx.key && (idx.key as Record<string, unknown>).idempotencyKey !== undefined) {
        try {
          await Emergency.collection.dropIndex(idx.name!);
        } catch {
          // Ignored
        }
      }
    }

    const now = new Date();
    const sharedKey = `dup-init-test-${Date.now()}`;

    await Emergency.collection.insertOne({
      _id: 'EMG-TEST-DUP-1',
      status: 'REPORTED',
      priority: 'HIGH',
      incidentType: 'CARDIAC_ARREST',
      location: { lat: 28.6139, lng: 77.209 },
      source: 'CITIZEN_REPORT',
      description: 'First duplicate incident',
      victimCount: 1,
      reportedAt: now,
      updatedAt: now,
      idempotencyKey: sharedKey,
    } as any);

    await Emergency.collection.insertOne({
      _id: 'EMG-TEST-DUP-2',
      status: 'REPORTED',
      priority: 'MEDIUM',
      incidentType: 'VEHICLE_COLLISION',
      location: { lat: 28.6139, lng: 77.209 },
      source: 'CITIZEN_REPORT',
      description: 'Second duplicate incident',
      victimCount: 1,
      reportedAt: new Date(now.getTime() + 1000),
      updatedAt: now,
      idempotencyKey: sharedKey,
    } as any);

    const result = await ensureEmergencyIdempotencyIndex();
    expect(result.ready).toBe(false);
    expect(result.status).toBe('DUPLICATES_DETECTED');
    expect(result.duplicateCount).toBeGreaterThanOrEqual(1);
    expect(isEmergencyIdempotencyIndexReady()).toBe(false);

    // Records must NOT be dropped, deleted, or unset
    const reloaded1 = await Emergency.findById('EMG-TEST-DUP-1');
    const reloaded2 = await Emergency.findById('EMG-TEST-DUP-2');
    expect(reloaded1?.idempotencyKey).toBe(sharedKey);
    expect(reloaded2?.idempotencyKey).toBe(sharedKey);

    // Cleanup test records
    await Emergency.deleteMany({ _id: { $in: ['EMG-TEST-DUP-1', 'EMG-TEST-DUP-2'] } });
  });

  // 5. Repeated initialization
  describe('5. repeated initialization', () => {
    it('sequential repeated invocations are completely idempotent and preserve readiness', async () => {
      // Call 1
      const res1 = await ensureEmergencyIdempotencyIndex();
      expect(res1.ready).toBe(true);
      expect(['CREATED', 'EXISTS']).toContain(res1.status);

      // Call 2
      const res2 = await ensureEmergencyIdempotencyIndex();
      expect(res2.ready).toBe(true);
      expect(res2.status).toBe('EXISTS');

      // Call 3
      const res3 = await ensureEmergencyIdempotencyIndex();
      expect(res3.ready).toBe(true);
      expect(res3.status).toBe('EXISTS');
      expect(isEmergencyIdempotencyIndexReady()).toBe(true);
    });

    it('concurrent startup invocations resolve safely without namespace collision errors', async () => {
      // Drop index to simulate concurrent bootstrap racing to initialize
      try {
        await Emergency.collection.dropIndex('idempotencyKey_1');
      } catch {
        // Ignored
      }

      const results = await Promise.all([
        ensureEmergencyIdempotencyIndex(),
        ensureEmergencyIdempotencyIndex(),
        ensureEmergencyIdempotencyIndex(),
      ]);

      for (const res of results) {
        expect(res.ready).toBe(true);
        expect(['CREATED', 'EXISTS']).toContain(res.status);
      }

      expect(isEmergencyIdempotencyIndexReady()).toBe(true);

      // Verify the index is verified active
      const indexes = await Emergency.collection.indexes();
      const verified = indexes.find(
        (idx) => idx.key && (idx.key as Record<string, unknown>).idempotencyKey === 1,
      );
      expect(verified).toBeDefined();
      expect(verified?.unique).toBe(true);
      expect(verified?.sparse).toBe(true);
    });
  });
});
