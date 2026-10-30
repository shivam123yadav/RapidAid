import { connectDB, disconnectDB } from '../db/connection.js';
import { runSeed } from './seed.js';

/** CLI entry: `npm run seed` — connects, seeds idempotently, disconnects. */
async function main(): Promise<void> {
  await connectDB();
  await runSeed();
  await disconnectDB();
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
