import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  seedGwaliorDemoResources,
  isGwaliorDemoSeedingAllowed,
  GWALIOR_DEMO_STAGING_ALLOWLIST,
} from '../src/seed/seedGwaliorDemo.js';

async function main() {
  const uri = env.MONGODB_URI;
  await mongoose.connect(uri);
  const dbName = mongoose.connection.name;
  console.log(`Connected to database: ${dbName}`);

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

main().catch((err) => {
  console.error('Failed to seed Gwalior demo resources:', err);
  process.exit(1);
});
