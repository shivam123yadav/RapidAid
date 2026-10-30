import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import request from 'supertest';
import { Emergency, Ambulance, Hospital } from '../src/models/index.js';
import { loginAs, bearer } from '../tests/helpers.js';

async function main() {
  await mongoose.connect('mongodb://127.0.0.1:27017/rapidaid_phase1_test');
  const app = createApp();
  const token = await loginAs(app, 'dispatcher');

  // Case 1: Coordinates present (Gwalior device coordinates ~26.23, 78.21)
  await Emergency.findOneAndUpdate(
    { _id: 'EMG-20485' },
    {
      $set: {
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { lat: 26.228854, lng: 78.213198, address: 'College main gate' },
        source: 'VOICE_REPORT',
        description: 'Voice report emergency at College main gate',
        victimCount: 1,
        reportedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  console.log('--- Testing EMG-20485 with Gwalior Coordinates (26.23, 78.21) ---');
  const recsRes1 = await request(app)
    .get('/api/dispatch/recommendations/EMG-20485')
    .set(bearer(token));
  console.log('Ambulance recs status:', recsRes1.status, 'body:', recsRes1.body);

  const hospRes1 = await request(app)
    .get('/api/dispatch/hospital-recommendations/EMG-20485')
    .set(bearer(token));
  console.log('Hospital recs status:', hospRes1.status, 'body:', hospRes1.body);

  // Case 2: What if coordinates are missing (bypass schema validation directly in Mongo collection)
  await Emergency.collection.updateOne(
    { _id: 'EMG-20485-NOLOC' },
    {
      $set: {
        _id: 'EMG-20485-NOLOC',
        status: 'REPORTED',
        priority: 'MEDIUM',
        incidentType: 'MEDICAL_EMERGENCY',
        location: { address: 'College main gate' },
        source: 'VOICE_REPORT',
        description: 'Missing coordinates',
        victimCount: 1,
        reportedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );

  console.log('\n--- Testing EMG-20485-NOLOC with missing lat/lng ---');
  const recsRes2 = await request(app)
    .get('/api/dispatch/recommendations/EMG-20485-NOLOC')
    .set(bearer(token));
  console.log('Ambulance recs status:', recsRes2.status, 'body:', recsRes2.body);

  const hospRes2 = await request(app)
    .get('/api/dispatch/hospital-recommendations/EMG-20485-NOLOC')
    .set(bearer(token));
  console.log('Hospital recs status:', hospRes2.status, 'body:', hospRes2.body);

  // Clean up test doc
  await Emergency.deleteOne({ _id: 'EMG-20485-NOLOC' });
  await mongoose.disconnect();
}

main().catch(console.error);
