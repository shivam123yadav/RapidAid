#!/usr/bin/env node
import mongoose from 'mongoose';
import { env } from '../src/config/env.js';
import {
  GWALIOR_AMB_051_WAYPOINTS,
  assertIsolatedTestDatabase,
  stepAmbulanceSimulation,
  setAmbulanceTelemetryStale,
  resetAmbulanceSimulation,
} from '../src/services/gpsSimulator.js';
import { Ambulance } from '../src/models/Ambulance.js';

const MONGODB_TEST_URI = env.MONGODB_URI.includes('rapidaid_phase1_test')
  ? env.MONGODB_URI
  : 'mongodb://127.0.0.1:27017/rapidaid_phase1_test';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || '--status';

  await mongoose.connect(MONGODB_TEST_URI);
  assertIsolatedTestDatabase();

  const ambulanceId = 'AMB-051';

  try {
    if (command === '--step') {
      const stepIdx = parseInt(args[1] || '0', 10);
      const res = await stepAmbulanceSimulation({ ambulanceId, stepIndex: stepIdx });
      console.log(`\n[GPS SIMULATOR] Injected Step ${res.waypoint.step} for ${ambulanceId}:`);
      console.log(`  Location:    ${res.waypoint.lat.toFixed(6)}, ${res.waypoint.lng.toFixed(6)} (${res.waypoint.label})`);
      console.log(`  Speed/ETA:   ${res.waypoint.speed} km/h | Heading: ${res.waypoint.heading}° | ETA: ${res.waypoint.etaSeconds}s`);
      console.log(`  Status:      ${res.waypoint.status}`);
      console.log(`  Simulated:   ${res.ambulance.isSimulated ? 'YES (SIMULATED GPS)' : 'NO'}`);
      console.log(`  LastUpdated: ${res.ambulance.lastUpdated.toISOString()} (FRESH)\n`);
    } else if (command === '--stale') {
      const res = await setAmbulanceTelemetryStale(ambulanceId);
      console.log(`\n[GPS SIMULATOR] Set ${ambulanceId} Telemetry to STALE:`);
      console.log(`  LastUpdated: ${res.staleTimestamp.toISOString()} (~${res.ageSeconds}s ago)`);
      console.log(`  Threshold:   300s limit`);
      console.log(`  Result:      UI will display 'Stale GPS / Offline' badge.\n`);
    } else if (command === '--reset') {
      const res = await resetAmbulanceSimulation(ambulanceId);
      console.log(`\n[GPS SIMULATOR] Reset ${ambulanceId} to Station:`);
      console.log(`  Location:    ${res.waypoint.lat}, ${res.waypoint.lng} (${res.waypoint.label})`);
      console.log(`  Status:      ${res.ambulance.status}`);
      console.log(`  LastUpdated: ${res.ambulance.lastUpdated.toISOString()}\n`);
    } else if (command === '--run') {
      const intervalSec = parseFloat(args[1] || '4');
      console.log(`\n[GPS SIMULATOR] Starting autonomous route simulation for ${ambulanceId} (${GWALIOR_AMB_051_WAYPOINTS.length} steps, ${intervalSec}s delay)...`);
      for (let i = 0; i < GWALIOR_AMB_051_WAYPOINTS.length; i++) {
        const res = await stepAmbulanceSimulation({ ambulanceId, stepIndex: i });
        console.log(`  [Step ${i + 1}/${GWALIOR_AMB_051_WAYPOINTS.length}] Lat: ${res.waypoint.lat}, Lng: ${res.waypoint.lng} -> ${res.waypoint.label} (${res.waypoint.speed} km/h, ETA: ${res.waypoint.etaSeconds}s)`);
        if (i < GWALIOR_AMB_051_WAYPOINTS.length - 1) {
          await new Promise((r) => setTimeout(r, intervalSec * 1000));
        }
      }
      console.log(`[GPS SIMULATOR] Route simulation complete. Ambulance arrived at College Main Gate.\n`);
    } else {
      // Status
      const amb = await Ambulance.findById(ambulanceId).lean();
      if (!amb) {
        console.log(`[GPS SIMULATOR] Ambulance ${ambulanceId} not found in rapidaid_phase1_test.`);
        return;
      }
      const ageSec = Math.floor((Date.now() - new Date(amb.lastUpdated).getTime()) / 1000);
      const isFresh = ageSec <= 300;
      console.log(`\n[GPS SIMULATOR] Status of ${ambulanceId} in rapidaid_phase1_test:`);
      console.log(`  Status:       ${amb.status}`);
      console.log(`  Location:     ${amb.location?.lat}, ${amb.location?.lng} (${amb.location?.address ?? 'N/A'})`);
      console.log(`  Speed/Heading:${amb.speed} km/h, ${amb.heading}°`);
      console.log(`  ETA:          ${amb.eta ?? 'N/A'}s`);
      console.log(`  Emergency:    ${amb.currentEmergency ?? 'None'}`);
      if (amb.activeRoute) {
        console.log(`  Road Route:   ${amb.activeRoute.status} via ${amb.activeRoute.provider?.toUpperCase()} (${amb.activeRoute.distanceMeters}m, ${amb.activeRoute.coordinates?.length} waypoints)`);
      }
      console.log(`  Simulated:    ${amb.isSimulated ? 'YES' : 'NO'}`);
      console.log(`  Freshness:    ${isFresh ? `FRESH (${ageSec}s old)` : `STALE (${ageSec}s old, threshold 300s)`}`);
      console.log(`  Last Updated: ${amb.lastUpdated.toISOString()}\n`);
      console.log(`Usage:`);
      console.log(`  npx tsx scripts/simulate-ambulance-gps.ts --step <0-5>`);
      console.log(`  npx tsx scripts/simulate-ambulance-gps.ts --run [intervalSeconds]`);
      console.log(`  npx tsx scripts/simulate-ambulance-gps.ts --stale`);
      console.log(`  npx tsx scripts/simulate-ambulance-gps.ts --reset\n`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error('[GPS SIMULATOR ERROR]', err.message);
  process.exit(1);
});
