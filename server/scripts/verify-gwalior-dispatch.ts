import mongoose from 'mongoose';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { env } from '../src/config/env.js';
import {
  isAmbulanceDispatchEligible,
  isAmbulanceTelemetryFresh,
} from '../src/services/dispatchService.js';
import { verifyAmbulanceCrewDuty } from '../src/services/crewDutyService.js';
import { Ambulance, Emergency, Hospital } from '../src/models/index.js';

async function main() {
  if (!env.MONGODB_URI.includes('rapidaid_phase1_test')) {
    throw new Error(`Safety restriction violated: Must target rapidaid_phase1_test`);
  }

  await mongoose.connect(env.MONGODB_URI);
  console.log(`Connected to database: ${mongoose.connection.name}`);

  const app = createApp();

  // 1. Login as dispatcher to obtain authorization token
  const loginRes = await request(app)
    .post('/api/auth/login')
    .send({ email: 'dispatcher@rapidaid.com', password: 'demo123', role: 'DISPATCHER' });

  if (loginRes.status !== 200) {
    throw new Error(`Login failed: ${loginRes.status} ${JSON.stringify(loginRes.body)}`);
  }
  const token = loginRes.body.accessToken;

  console.log('\n--- 1. Testing GET /api/dispatch/recommendations/EMG-20485 ---');
  const ambRes = await request(app)
    .get('/api/dispatch/recommendations/EMG-20485')
    .set('Authorization', `Bearer ${token}`);

  console.log(`Status: ${ambRes.status}`);
  console.log(`Recommendations Count: ${ambRes.body.length}`);
  console.log('Recommendations:');
  for (const rec of ambRes.body) {
    console.log(` - Unit: ${rec.ambulanceId}, Score: ${rec.score}, Distance: ${rec.distance}m, ETA: ${rec.eta}s, Capabilities: [${rec.capabilities.join(', ')}]`);
    console.log(`   Reasons: ${rec.reasons.join('; ')}`);
  }

  console.log('\n--- 2. Testing GET /api/dispatch/hospital-recommendations/EMG-20485 ---');
  const hospRes = await request(app)
    .get('/api/dispatch/hospital-recommendations/EMG-20485')
    .set('Authorization', `Bearer ${token}`);

  console.log(`Status: ${hospRes.status}`);
  console.log(`Hospital Recommendations Count: ${hospRes.body.length}`);
  console.log('Hospital Recommendations:');
  for (const rec of hospRes.body) {
    console.log(` - Hospital: ${rec.hospitalId}, Score: ${rec.score}, Distance: ${rec.distance}m, ETA: ${rec.eta}s, TraumaBay: ${rec.traumaAvailable}, ED: ${rec.emergencyCapacity}, ICU: ${rec.icuCapacity}`);
    console.log(`   Reasons: ${rec.reasons.join('; ')}`);
  }

  console.log('\n--- 3. Ambulance Eligibility & Crew Duty Verification ---');
  for (const ambId of ['AMB-051', 'AMB-052']) {
    const ambDoc = await Ambulance.findById(ambId).lean();
    const telemetry = isAmbulanceTelemetryFresh(ambDoc);
    const crewDuty = await verifyAmbulanceCrewDuty(ambId);
    const overall = await isAmbulanceDispatchEligible(ambId);

    console.log(`[${ambId}]`);
    console.log(` - Telemetry Fresh: ${telemetry.fresh} (age: ${telemetry.ageSeconds}s, limit: ${telemetry.thresholdSeconds}s)`);
    console.log(` - Crew Duty Eligible: ${crewDuty.eligible}`);
    console.log(` - Verified Crew IDs: [${crewDuty.verifiedCrewIds?.join(', ')}]`);
    console.log(` - Overall Dispatch Eligible: ${overall.eligible}`);
  }

  console.log('\n--- 4. Hospital Capacity Verification ---');
  for (const hospId of ['HOSP-81', 'HOSP-82']) {
    const hospDoc = await Hospital.findById(hospId).lean();
    console.log(`[${hospId}] ${hospDoc?.name}`);
    console.log(` - Status: ${hospDoc?.status}, Verification: ${hospDoc?.verificationStatus}`);
    console.log(` - ED Capacity: ${hospDoc?.emergencyCapacity}, ICU Capacity: ${hospDoc?.icuCapacity}, Trauma Bay: ${hospDoc?.traumaAvailable}`);
    console.log(` - General Beds: ${hospDoc?.generalBeds}, ICU Beds: ${hospDoc?.icuBeds}, Current Load: ${hospDoc?.currentLoad}%`);
    console.log(` - Active Reservations: ${hospDoc?.activeReservationIds.length}, Incoming Ambulances: ${hospDoc?.incomingAmbulances}`);
  }

  console.log('\n--- 5. Automated Dispatch & Assignment Safety Check ---');
  const emg = await Emergency.findById('EMG-20485').lean();
  console.log(`Emergency Status: ${emg?.status} (Expected: REPORTED)`);
  console.log(`Assigned Ambulance: ${emg?.assignedAmbulance ?? 'None (Unassigned)'}`);
  console.log(`Automated Dispatch Config: AUTOMATED_DISPATCH_ENABLED=${process.env.AUTOMATED_DISPATCH_ENABLED ?? 'false'}`);

  if (emg?.assignedAmbulance) {
    throw new Error('Safety failure: Emergency has an ambulance automatically assigned!');
  }

  await mongoose.disconnect();
  console.log('\nVerification completed successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
