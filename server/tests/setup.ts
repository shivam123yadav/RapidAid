import { afterAll, beforeAll } from 'vitest';
import mongoose from 'mongoose';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const AUTHORIZED_PHASE1_TEST_DB = 'rapidaid_phase1_test';
export const AUTHORIZED_PHASE1_TEST_HOST = '127.0.0.1';
export const AUTHORIZED_PHASE1_TEST_PORT = '27017';
export const AUTHORIZED_PHASE1_TEST_URI = `mongodb://${AUTHORIZED_PHASE1_TEST_HOST}:${AUTHORIZED_PHASE1_TEST_PORT}/${AUTHORIZED_PHASE1_TEST_DB}`;

process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-must-be-at-least-16-chars';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-must-be-at-least-16-chars';
process.env.SEED_IF_EMPTY = 'false';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.LOG_LEVEL = 'silent';

/**
 * Validates a MongoDB URI using URL parser.
 * Requires:
 * - protocol: 'mongodb:'
 * - hostname: '127.0.0.1'
 * - port: '27017'
 * - pathname (database name): exactly '/rapidaid_phase1_test'
 * Explicitly rejects 'rapidaid', 'rapidaid_test', remote hosts, or missing database names.
 */
export function validateAuthorizedTestUri(rawUri: string | undefined): { ok: boolean; dbName?: string; error?: string } {
  if (!rawUri || typeof rawUri !== 'string') {
    return { ok: false, error: 'MongoDB URI is undefined or not a string' };
  }

  if (rawUri.includes('%')) {
    return { ok: false, error: 'Percent-encoded characters are not permitted in test URI' };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUri);
  } catch (err) {
    return { ok: false, error: `Invalid MongoDB URI syntax: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (parsed.protocol !== 'mongodb:') {
    return { ok: false, error: `Unauthorized protocol '${parsed.protocol}'. Expected 'mongodb:'` };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URI credentials are not permitted in test URI' };
  }

  if (parsed.hostname !== AUTHORIZED_PHASE1_TEST_HOST) {
    return { ok: false, error: `Unauthorized host '${parsed.hostname}'. Expected '${AUTHORIZED_PHASE1_TEST_HOST}'` };
  }

  if (!parsed.port) {
    return { ok: false, error: `Explicit port '${AUTHORIZED_PHASE1_TEST_PORT}' is required in test URI. None was specified` };
  }

  if (parsed.port !== AUTHORIZED_PHASE1_TEST_PORT) {
    return { ok: false, error: `Unauthorized port '${parsed.port}'. Expected '${AUTHORIZED_PHASE1_TEST_PORT}'` };
  }

  if (parsed.search) {
    return { ok: false, error: 'Query parameters are not permitted in test URI' };
  }

  if (parsed.hash) {
    return { ok: false, error: 'URI fragments are not permitted in test URI' };
  }

  if (
    parsed.pathname === '/rapidaid' ||
    parsed.pathname === '/rapidaid/' ||
    parsed.pathname === '/rapidaid_test' ||
    parsed.pathname === '/rapidaid_test/'
  ) {
    const rawDb = parsed.pathname.replace(/^\//, '').split('/')[0];
    return { ok: false, dbName: rawDb, error: `Strict safety block: Refusing to use preserved database '${rawDb}'` };
  }

  if (parsed.pathname !== `/${AUTHORIZED_PHASE1_TEST_DB}`) {
    return {
      ok: false,
      error: `Unauthorized database path '${parsed.pathname}'. Expected exact '/${AUTHORIZED_PHASE1_TEST_DB}' without trailing slashes or extra segments`
    };
  }

  return { ok: true, dbName: AUTHORIZED_PHASE1_TEST_DB };
}

// Enforce non-silent validation of process.env.MONGODB_URI
if (process.env.MONGODB_URI) {
  const existingValidation = validateAuthorizedTestUri(process.env.MONGODB_URI);
  if (!existingValidation.ok) {
    throw new Error(
      `CRITICAL TEST CONFIGURATION ERROR: process.env.MONGODB_URI is invalid or unauthorized: ${existingValidation.error}. Silent fallback forbidden.`
    );
  }
} else {
  process.env.MONGODB_URI = AUTHORIZED_PHASE1_TEST_URI;
}

/**
 * Strict database safety guard. Refuses destructive operations unless
 * the active Mongoose connection name is exactly 'rapidaid_phase1_test'.
 */
export function assertSafeTestDatabase(connection: typeof mongoose.connection): void {
  const currentDbName = connection.name || connection.db?.databaseName;
  if (!currentDbName || currentDbName !== AUTHORIZED_PHASE1_TEST_DB) {
    throw new Error(
      `CRITICAL DATABASE SAFETY ABORT: Refusing destructive operation on '${currentDbName}'. ` +
      `Test suite is strictly authorized ONLY for isolated database '${AUTHORIZED_PHASE1_TEST_DB}'. ` +
      `Destructive drop/seed operations on 'rapidaid', 'rapidaid_test', or any other database are strictly forbidden.`
    );
  }
}

/**
 * Where recordings live for the duration of one test file.
 */
function testAudioRoot(): string {
  return join(tmpdir(), `rapidaid-phase1-voice-${process.pid}`);
}

/**
 * Shared lifecycle for Phase 1 test files: connect strictly to the dedicated
 * `rapidaid_phase1_test` database, wipe it, seed fresh demo data, and
 * disconnect afterwards.
 */
export function useTestDatabase(seed: () => Promise<void>, storageDir?: string): void {
  beforeAll(async () => {
    process.env.VOICE_AUDIO_STORAGE_DIR = storageDir ?? testAudioRoot();
    if (mongoose.connection.readyState === 0) {
      const uriValidation = validateAuthorizedTestUri(process.env.MONGODB_URI);
      if (!uriValidation.ok) {
        throw new Error(`CRITICAL TEST CONFIGURATION ERROR: ${uriValidation.error}. Connection aborted.`);
      }
      await mongoose.connect(process.env.MONGODB_URI!);
    }
    assertSafeTestDatabase(mongoose.connection);
    await mongoose.connection.dropDatabase();
    await seed();
  });

  afterAll(async () => {
    let safetyError: unknown = null;
    try {
      if (mongoose.connection.readyState !== 0) {
        try {
          assertSafeTestDatabase(mongoose.connection);
          await mongoose.connection.dropDatabase();
        } catch (err) {
          safetyError = err;
          console.error('[SAFETY GUARD ABORT in afterAll]: Refusing database drop or encountered safety failure:', err);
        }
      }
    } finally {
      if (mongoose.connection.readyState !== 0) {
        try {
          await mongoose.disconnect();
        } catch (disconnectErr) {
          console.error('[CLEANUP WARNING in afterAll]: Error during mongoose disconnect:', disconnectErr);
        }
      }
      if (process.env.VOICE_AUDIO_STORAGE_DIR) {
        try {
          await rm(process.env.VOICE_AUDIO_STORAGE_DIR, { recursive: true, force: true });
        } catch (rmErr) {
          console.error('[CLEANUP WARNING in afterAll]: Error cleaning voice storage:', rmErr);
        }
      }
    }
    if (safetyError) {
      throw safetyError;
    }
  });
}
