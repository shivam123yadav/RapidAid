import { Emergency, Ambulance, Hospital } from '../models/index.js';
import { ApiError } from '../utils/errors.js';
import { estimateEtaSeconds, haversineMeters } from '../utils/geo.js';

export interface GreenCorridorSimulation {
  emergencyId: string;
  route: { lat: number; lng: number }[];
  baselineETA: number;
  simulatedETA: number;
  timeSaved: number;
  signalsAffected: number;
  status: 'IDLE' | 'SIMULATING' | 'COMPLETE';
}

const interpolate = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  steps: number,
): { lat: number; lng: number }[] => {
  const points: { lat: number; lng: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    points.push({
      lat: from.lat + (to.lat - from.lat) * t,
      lng: from.lng + (to.lng - from.lng) * t,
    });
  }
  return points;
};

/**
 * Simulates a "green corridor": a coordinated route from the assigned
 * ambulance to the destination hospital. Baseline ETA assumes normal urban
 * driving; the simulated ETA models signal pre-emption (≈30% faster) and
 * counts the intersections the corridor would affect. Deterministic — no
 * randomness — so the same inputs always produce the same result.
 */
export async function simulateGreenCorridor(emergencyId: string): Promise<GreenCorridorSimulation> {
  const emergency = await Emergency.findById(emergencyId).lean();
  if (!emergency) throw ApiError.notFound(`Emergency ${emergencyId} not found`);

  const ambulance = emergency.assignedAmbulance
    ? await Ambulance.findById(emergency.assignedAmbulance).lean()
    : null;
  const hospital = emergency.destinationHospital
    ? await Hospital.findById(emergency.destinationHospital).lean()
    : await Hospital.findOne({ status: 'OPERATIONAL' }).lean();

  // `location` is always written by our writers; non-null assertion keeps
  // the geometry helpers free of defensive branches.
  const origin = ambulance?.location ?? emergency.location!;
  const destination = hospital?.location ?? emergency.location!;

  const direct = haversineMeters(origin, destination);
  // Urban road-network factor: real routes are ~1.35× the crow-fly distance.
  const routeDistance = direct * 1.35;
  const baselineETA = estimateEtaSeconds(routeDistance);
  const simulatedETA = Math.round(baselineETA * 0.7); // signal prioritisation saves ~30%
  const route = interpolate(origin, destination, 4);
  const signalsAffected = Math.max(3, Math.round(routeDistance / 450));

  return {
    emergencyId,
    route,
    baselineETA,
    simulatedETA,
    timeSaved: Math.max(0, baselineETA - simulatedETA),
    signalsAffected,
    status: 'COMPLETE',
  };
}
