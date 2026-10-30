import { haversineDistanceMeters, isValidCoordinate } from './deviation.js';
import type { Coordinate, RouteResult, RoutingProvider } from './types.js';

export class MockRoutingProvider implements RoutingProvider {
  readonly name = 'mock';
  private failureMode = false;
  private failureReason = 'Simulated provider network outage';

  setFailureMode(enable: boolean, reason = 'Simulated provider network outage'): void {
    this.failureMode = enable;
    this.failureReason = reason;
  }

  async calculateRoute(origin: Coordinate, destination: Coordinate): Promise<RouteResult> {
    const calculatedAt = new Date();

    if (this.failureMode) {
      return {
        coordinates: [],
        distanceMeters: 0,
        durationSeconds: 0,
        provider: this.name,
        calculatedAt,
        status: 'FAILED',
        error: this.failureReason,
      };
    }

    if (!isValidCoordinate(origin)) {
      return {
        coordinates: [],
        distanceMeters: 0,
        durationSeconds: 0,
        provider: this.name,
        calculatedAt,
        status: 'FAILED',
        error: 'Invalid origin coordinates',
      };
    }

    if (!isValidCoordinate(destination)) {
      return {
        coordinates: [],
        distanceMeters: 0,
        durationSeconds: 0,
        provider: this.name,
        calculatedAt,
        status: 'FAILED',
        error: 'Invalid destination coordinates',
      };
    }

    // Generate realistic multi-segment road geometry between origin and destination
    const straightDistMeters = haversineDistanceMeters(origin, destination);
    // Road network distance is typically 1.25x - 1.4x of Euclidean distance
    const roadDistanceMeters = Math.round(straightDistMeters * 1.3);
    // Average urban ambulance speed ~ 40 km/h (11.1 m/s)
    const durationSeconds = Math.max(30, Math.round(roadDistanceMeters / 11.1));

    const waypoints: [number, number][] = [];
    const stepCount = Math.max(5, Math.min(25, Math.round(straightDistMeters / 200)));

    for (let i = 0; i <= stepCount; i++) {
      const t = i / stepCount;
      const lat = origin.lat + (destination.lat - origin.lat) * t;
      const lng = origin.lng + (destination.lng - origin.lng) * t;
      // Slight road curve deflection except at endpoints
      const deflection = i > 0 && i < stepCount ? Math.sin(t * Math.PI) * 0.0012 : 0;
      waypoints.push([lat + deflection, lng - deflection]);
    }

    return {
      coordinates: waypoints,
      distanceMeters: roadDistanceMeters,
      durationSeconds,
      provider: this.name,
      calculatedAt,
      status: 'SUCCESS',
    };
  }
}
