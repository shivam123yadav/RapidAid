import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  seedGwaliorDemoResources,
  isGwaliorDemoSeedingAllowed,
  GWALIOR_DEMO_STAGING_ALLOWLIST,
} from '../src/seed/seedGwaliorDemo.js';

export const TARGET_STAGING_DB = 'rapidaid_staging';

/**
 * Validates that the active database connection is strictly 'rapidaid_staging'.
 * Aborts and disconnects for any other database name, protecting production ('rapidaid')
 * as well as other staging/test databases ('rapidaid_phase1_test', 'rapidaid_test').
 */
export function assertGwaliorSeedTargetDatabase(dbName: string | undefined | null): void {
  if (dbName !== TARGET_STAGING_DB) {
    throw new Error(
      `Safety restriction violated: The targeted Gwalior seed CLI script is restricted exclusively to '${TARGET_STAGING_DB}'. Attempted execution against '${dbName}' is strictly prohibited. Other databases ('rapidaid', 'rapidaid_phase1_test', 'rapidaid_test', etc.) are rejected.`,
    );
  }

  if (!isGwaliorDemoSeedingAllowed(dbName)) {
    throw new Error(
      `Safety restriction violated: Database '${dbName}' is not in the approved staging allowlist (${GWALIOR_DEMO_STAGING_ALLOWLIST.join(
        ', ',
      )}). Production databases ('rapidaid') are strictly protected.`,
    );
  }
}

export async function main(): Promise<void> {
  // Explicitly supplied process.env.MONGODB_URI takes precedence over server/.env
  const uri = process.env.MONGODB_URI || env.MONGODB_URI;
  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName}`);

  // Primary strict CLI entry-point guard: only 'rapidaid_staging' allowed
  if (dbName !== TARGET_STAGING_DB) {
    await mongoose.disconnect();
    throw new Error(
      `Safety restriction violated: The targeted Gwalior seed CLI script is restricted exclusively to '${TARGET_STAGING_DB}'. Attempted execution against '${dbName}' aborted and disconnected. Other databases ('rapidaid', 'rapidaid_phase1_test', 'rapidaid_test', etc.) are strictly disallowed.`,
    );
  }

  // Secondary allowlist check
  if (!isGwaliorDemoSeedingAllowed(dbName)) {
    await mongoose.disconnect();
    throw new Error(
      `Safety restriction violated: Database '${dbName}' is not in the approved staging allowlist (${GWALIOR_DEMO_STAGING_ALLOWLIST.join(
        ', ',
      )}). Production databases ('rapidaid') are strictly protected.`,
    );
  }

  const results = await seedGwaliorDemoResources();
  console.log('Seeded Ambulances:', results.ambulances);
  console.log('Seeded Hospitals:', results.hospitals);

  await mongoose.disconnect();
  console.log('Disconnected');
}

const isDirectRun =
  process.argv[1]?.replace(/\\/g, '/').endsWith('run-seed-gwalior.ts') ||
  process.argv[1]?.replace(/\\/g, '/').endsWith('run-seed-gwalior.js');

if (isDirectRun) {
  main().catch((err) => {
    console.error('Failed to seed Gwalior demo resources:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
