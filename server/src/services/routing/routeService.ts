import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Ambulance, Emergency, Hospital } from '../../models/index.js';
import { getRoutingProvider } from './index.js';
import {
  calculateRouteDeviation,
  haversineDistanceMeters,
  isValidCoordinate,
} from './deviation.js';
import type { ActiveRouteData, Coordinate, RouteResult } from './types.js';

interface CacheEntry {
  result: RouteResult;
  expiresAt: number;
}

const routeCache = new Map<string, CacheEntry>();

export function clearRouteCache(): void {
  routeCache.clear();
}

export function getRouteCacheStats(): { size: number } {
  return { size: routeCache.size };
}

function getCacheKey(origin: Coordinate, destination: Coordinate, destId: string): string {
  return `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}->${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}:${destId}`;
}

export interface RecalculationOptions {
  force?: boolean;
}

/**
 * Calculates or refreshes the road route for an ambulance based on its current position
 * and its assigned incident / reserved hospital destination.
 */
export async function updateAmbulanceRoute(
  ambulanceId: string,
  currentLocation?: Coordinate,
  options?: RecalculationOptions,
): Promise<ActiveRouteData | null> {
  const ambulance = await Ambulance.findById(ambulanceId);
  if (!ambulance || !ambulance.currentEmergency) {
    if (ambulance && ambulance.activeRoute) {
      await Ambulance.updateOne({ _id: ambulanceId }, { $unset: { activeRoute: 1 } });
    }
    return null;
  }

  const emergency = await Emergency.findById(ambulance.currentEmergency);
  if (!emergency) {
    return null;
  }

  const origin: Coordinate = currentLocation && isValidCoordinate(currentLocation)
    ? currentLocation
    : ambulance.location && isValidCoordinate(ambulance.location)
      ? { lat: ambulance.location.lat, lng: ambulance.location.lng, address: ambulance.location.address }
      : { lat: NaN, lng: NaN };

  if (!isValidCoordinate(origin)) {
    logger.warn({ ambulanceId, origin }, 'Cannot route: invalid ambulance origin coordinates');
    return null;
  }

  // Determine destination based on emergency status and reservation
  let destinationType: 'INCIDENT' | 'HOSPITAL' = 'INCIDENT';
  let destinationId = emergency._id;
  let destinationLocation: Coordinate = emergency.location && isValidCoordinate(emergency.location)
    ? {
        lat: emergency.location.lat,
        lng: emergency.location.lng,
        address: emergency.location.address,
      }
    : { lat: NaN, lng: NaN };

  const isTransportingToHospital =
    ['PATIENT_ONBOARD', 'TRANSPORTING', 'AT_HOSPITAL'].includes(emergency.status) ||
    ambulance.status === 'TRANSPORTING';

  const hospitalId = emergency.destinationHospital || ambulance.destinationHospital;

  if (isTransportingToHospital && hospitalId) {
    const hospital = await Hospital.findById(hospitalId).lean();
    if (hospital && isValidCoordinate(hospital.location)) {
      destinationType = 'HOSPITAL';
      destinationId = hospital._id;
      destinationLocation = {
        lat: hospital.location.lat,
        lng: hospital.location.lng,
        address: hospital.name,
      };
    }
  }

  if (!isValidCoordinate(destinationLocation)) {
    logger.warn({ ambulanceId, destinationLocation }, 'Cannot route: invalid destination coordinates');
    return null;
  }

  const existingRoute = ambulance.activeRoute as ActiveRouteData | undefined;
  const now = Date.now();

  // Evaluate whether recalculation is necessary
  let needsRecalculation = Boolean(options?.force);
  let isDeviated = false;
  let deviationDist = 0;

  if (!needsRecalculation) {
    if (!existingRoute || !existingRoute.coordinates || existingRoute.coordinates.length < 2) {
      needsRecalculation = true;
    } else if (existingRoute.destinationId !== destinationId || existingRoute.destinationType !== destinationType) {
      // Destination changed (e.g. rerouted to hospital or new hospital)
      needsRecalculation = true;
    } else if (existingRoute.status !== 'SUCCESS') {
      needsRecalculation = true;
    } else {
      // Check deviation from active route geometry
      const dev = calculateRouteDeviation(
        origin,
        existingRoute.coordinates,
        env.ROUTING_DEVIATION_THRESHOLD_METERS,
      );
      isDeviated = dev.isDeviated;
      deviationDist = dev.minDistanceMeters;

      if (isDeviated) {
        logger.info(
          { ambulanceId, deviationMeters: dev.minDistanceMeters, threshold: env.ROUTING_DEVIATION_THRESHOLD_METERS },
          'Ambulance deviated from active road route; triggering recalculation',
        );
        needsRecalculation = true;
      } else {
        // Check distance moved from the position where the route was originally calculated
        const routeOrigin: Coordinate = existingRoute.routeOrigin ?? {
          lat: existingRoute.coordinates[0][0],
          lng: existingRoute.coordinates[0][1],
        };
        const distFromOrigin = haversineDistanceMeters(origin, routeOrigin);
        const routeAgeMs = now - (existingRoute.calculatedAt ? new Date(existingRoute.calculatedAt).getTime() : 0);

        // Recalculate if vehicle moved past the threshold distance and throttle window elapsed
        if (distFromOrigin >= env.ROUTING_RECALCULATION_DISTANCE_THRESHOLD_METERS && routeAgeMs >= 10000) {
          needsRecalculation = true;
        }
      }
    }
  }

  if (!needsRecalculation && existingRoute && existingRoute.status === 'SUCCESS') {
    // Sensible throttling: update remaining ETA without re-calling the provider
    // Calculate approximate remaining duration based on straight distance progress
    const remainingDistMeters = haversineDistanceMeters(origin, destinationLocation);
    // Road ratio ~ 1.25, estimated speed based on current speed or 40km/h
    const currentSpeedMps = ambulance.speed > 5 ? (ambulance.speed * 1000) / 3600 : 11.1;
    const estimatedRemainingSeconds = Math.max(10, Math.round((remainingDistMeters * 1.25) / currentSpeedMps));

    // If ETA changed noticeably (> 15s), update DB
    if (!ambulance.eta || Math.abs(ambulance.eta - estimatedRemainingSeconds) >= 15) {
      await Ambulance.updateOne({ _id: ambulanceId }, { $set: { eta: estimatedRemainingSeconds } });
      await Emergency.updateOne({ _id: emergency._id }, { $set: { eta: estimatedRemainingSeconds } });
    }
    return existingRoute;
  }

  // Check in-memory route cache
  const cacheKey = getCacheKey(origin, destinationLocation, destinationId);
  const cached = routeCache.get(cacheKey);
  let routeResult: RouteResult;

  if (cached && cached.expiresAt > now && !options?.force) {
    routeResult = cached.result;
  } else {
    const provider = getRoutingProvider();
    routeResult = await provider.calculateRoute(origin, destinationLocation);

    if (routeResult.status === 'SUCCESS') {
      routeCache.set(cacheKey, {
        result: routeResult,
        expiresAt: now + env.ROUTING_CACHE_TTL_MS,
      });
    }
  }

  if (routeResult.status === 'SUCCESS') {
    const newActiveRoute: ActiveRouteData = {
      coordinates: routeResult.coordinates,
      distanceMeters: routeResult.distanceMeters,
      durationSeconds: routeResult.durationSeconds,
      calculatedAt: routeResult.calculatedAt,
      destinationType,
      destinationId,
      destinationLocation: {
        lat: destinationLocation.lat,
        lng: destinationLocation.lng,
        address: destinationLocation.address,
      },
      routeOrigin: {
        lat: origin.lat,
        lng: origin.lng,
      },
      provider: routeResult.provider,
      status: 'SUCCESS',
      isStale: false,
      deviated: false,
      deviationDistanceMeters: 0,
    };

    const etaSeconds = Math.round(routeResult.durationSeconds);

    await Ambulance.updateOne(
      { _id: ambulanceId },
      {
        $set: {
          activeRoute: newActiveRoute,
          eta: etaSeconds,
          lastUpdated: new Date(),
        },
      },
    );

    await Emergency.updateOne(
      { _id: emergency._id },
      {
        $set: {
          eta: etaSeconds,
          updatedAt: new Date(),
        },
      },
    );

    return newActiveRoute;
  } else {
    // Provider failure: DO NOT fabricate synthetic routes or invent ETAs
    logger.warn(
      { ambulanceId, destinationId, status: routeResult.status, error: routeResult.error },
      'Routing provider failed; route marked unavailable',
    );

    const failedActiveRoute: ActiveRouteData = existingRoute
      ? {
          ...existingRoute,
          status: 'FAILED',
          isStale: true,
          deviated: isDeviated,
          deviationDistanceMeters: deviationDist,
        }
      : {
          coordinates: [],
          distanceMeters: 0,
          durationSeconds: 0,
          calculatedAt: new Date(),
          destinationType,
          destinationId,
          destinationLocation: {
            lat: destinationLocation.lat,
            lng: destinationLocation.lng,
            address: destinationLocation.address,
          },
          routeOrigin: {
            lat: origin.lat,
            lng: origin.lng,
          },
          provider: routeResult.provider,
          status: 'FAILED',
          isStale: true,
          deviated: false,
          deviationDistanceMeters: 0,
        };

    await Ambulance.updateOne(
      { _id: ambulanceId },
      {
        $set: { activeRoute: failedActiveRoute },
        $unset: { eta: 1 },
      },
    );

    await Emergency.updateOne(
      { _id: emergency._id },
      { $unset: { eta: 1 } },
    );

    return failedActiveRoute;
  }
}
