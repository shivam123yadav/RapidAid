import mongoose from 'mongoose';
import { Ambulance } from '../models/Ambulance.js';
import { env } from '../config/env.js';
import { updateAmbulanceRoute } from './routing/routeService.js';

export interface SimulatedWaypoint {
  step: number;
  label: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  etaSeconds: number;
  status: 'ASSIGNED' | 'EN_ROUTE' | 'AT_SCENE';
}

/**
 * Realistic waypoint route for AMB-051 responding to EMG-20485 in Gwalior.
 * Distance: ~1.65 km from Phool Bagh station to College Main Gate.
 */
export const GWALIOR_AMB_051_WAYPOINTS: SimulatedWaypoint[] = [
  {
    step: 0,
    label: 'Station Departure (Phool Bagh)',
    lat: 26.242,
    lng: 78.22,
    speed: 0,
    heading: 195,
    etaSeconds: 240,
    status: 'ASSIGNED',
  },
  {
    step: 1,
    label: 'Accelerating on Station Road',
    lat: 26.2392,
    lng: 78.2185,
    speed: 38,
    heading: 205,
    etaSeconds: 190,
    status: 'EN_ROUTE',
  },
  {
    step: 2,
    label: 'Passing Padav Crossing Junction',
    lat: 26.2365,
    lng: 78.2171,
    speed: 44,
    heading: 200,
    etaSeconds: 140,
    status: 'EN_ROUTE',
  },
  {
    step: 3,
    label: 'Navigating Mela Road Corridor',
    lat: 26.2338,
    lng: 78.2158,
    speed: 40,
    heading: 205,
    etaSeconds: 95,
    status: 'EN_ROUTE',
  },
  {
    step: 4,
    label: 'Approaching College Road Turn',
    lat: 26.231,
    lng: 78.2144,
    speed: 28,
    heading: 210,
    etaSeconds: 45,
    status: 'EN_ROUTE',
  },
  {
    step: 5,
    label: 'Arrived at College Main Gate (EMG-20485)',
    lat: 26.228854,
    lng: 78.213198,
    speed: 0,
    heading: 210,
    etaSeconds: 0,
    status: 'AT_SCENE',
  },
];

/**
 * Strict database isolation guard.
 * Refuses execution if targeting any live or production database.
 */
export function assertIsolatedTestDatabase(): void {
  const uri = env.MONGODB_URI;
  const dbName = mongoose.connection.name || '';
  const isIsolatedTestDb =
    (uri.includes('rapidaid_phase1_test') || dbName === 'rapidaid_phase1_test') &&
    !uri.includes('rapidaid_prod') &&
    !uri.includes('production');

  if (!isIsolatedTestDb) {
    throw new Error(
      `[GPS SIMULATOR SAFETY BREACH] GPS Simulation is strictly isolated to 'rapidaid_phase1_test'. Current DB: '${dbName}', URI: '${uri}'. Execution aborted.`,
    );
  }
}

/**
 * Ingests a simulated GPS coordinate update for an ambulance into rapidaid_phase1_test.
 */
export async function stepAmbulanceSimulation(options: {
  ambulanceId?: string;
  stepIndex: number;
  timestamp?: Date;
}) {
  assertIsolatedTestDatabase();
  const ambulanceId = options.ambulanceId ?? 'AMB-051';
  const step = Math.max(0, Math.min(options.stepIndex, GWALIOR_AMB_051_WAYPOINTS.length - 1));
  const waypoint = GWALIOR_AMB_051_WAYPOINTS[step];

  const now = options.timestamp ?? new Date();

  let updated = await Ambulance.findByIdAndUpdate(
    ambulanceId,
    {
      $set: {
        'location.lat': waypoint.lat,
        'location.lng': waypoint.lng,
        'location.address': waypoint.label,
        speed: waypoint.speed,
        heading: waypoint.heading,
        eta: waypoint.etaSeconds,
        status: waypoint.status,
        currentEmergency: ambulanceId === 'AMB-051' ? 'EMG-20485' : undefined,
        lastUpdated: now,
        isSimulated: true,
        telemetrySource: 'SIMULATED',
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new Error(`Ambulance ${ambulanceId} not found in database.`);
  }

  if (updated.currentEmergency) {
    try {
      await updateAmbulanceRoute(ambulanceId, { lat: waypoint.lat, lng: waypoint.lng });
      const refetched = await Ambulance.findById(ambulanceId);
      if (refetched) updated = refetched;
    } catch {
      // Do not block simulator step if routing encounters transient network issues
    }
  }

  return {
    ambulance: updated,
    waypoint,
    timestamp: now,
  };
}

/**
 * Ages an ambulance's telemetry timestamp to 6 minutes ago (360 seconds).
 * Demonstrates stale / offline telemetry detection when GPS hardware stops sending packets.
 */
export async function setAmbulanceTelemetryStale(ambulanceId: string = 'AMB-051') {
  assertIsolatedTestDatabase();
  const staleTimestamp = new Date(Date.now() - 360_000); // 6 mins ago (> 300s threshold)

  const updated = await Ambulance.findByIdAndUpdate(
    ambulanceId,
    {
      $set: {
        lastUpdated: staleTimestamp,
        speed: 0,
      },
    },
    { new: true },
  );

  if (!updated) {
    throw new Error(`Ambulance ${ambulanceId} not found in database.`);
  }

  return {
    ambulance: updated,
    staleTimestamp,
    ageSeconds: 360,
  };
}

/**
 * Resets the ambulance to initial waypoint 0.
 */
export async function resetAmbulanceSimulation(ambulanceId: string = 'AMB-051') {
  return stepAmbulanceSimulation({ ambulanceId, stepIndex: 0 });
}
