import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import { seedGwaliorDemoResources } from '../src/seed/seedGwaliorDemo.js';

async function main() {
  const uri = env.MONGODB_URI;
  if (!uri.includes('rapidaid_phase1_test')) {
    throw new Error(`Safety restriction: MONGODB_URI must target 'rapidaid_phase1_test'. Current URI: ${uri}`);
  }

  await mongoose.connect(uri);
  console.log(`Connected to ${mongoose.connection.name}`);

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
