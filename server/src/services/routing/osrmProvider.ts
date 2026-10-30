import { logger } from '../../config/logger.js';
import { isValidCoordinate } from './deviation.js';
import type { Coordinate, RouteResult, RoutingProvider } from './types.js';

interface OsrmRouteLeg {
  distance: number;
  duration: number;
}

interface OsrmRoute {
  geometry: {
    coordinates: [number, number][]; // [lng, lat] GeoJSON
    type: string;
  };
  legs: OsrmRouteLeg[];
  distance: number; // in meters
  duration: number; // in seconds
}

interface OsrmResponse {
  code: string;
  message?: string;
  routes?: OsrmRoute[];
}

export class OsrmRoutingProvider implements RoutingProvider {
  readonly name = 'osrm';
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 4000) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  async calculateRoute(origin: Coordinate, destination: Coordinate): Promise<RouteResult> {
    const calculatedAt = new Date();

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

    const url = `${this.baseUrl}/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson`;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Accept: 'application/json',
          'User-Agent': 'RapidAid-Emergency-Dispatch/1.0',
        },
      });

      if (!response.ok) {
        logger.warn(
          { status: response.status, statusText: response.statusText, url },
          'OSRM routing provider returned HTTP error',
        );
        return {
          coordinates: [],
          distanceMeters: 0,
          durationSeconds: 0,
          provider: this.name,
          calculatedAt,
          status: 'FAILED',
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as OsrmResponse;

      if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
        if (data.code === 'NoRoute') {
          return {
            coordinates: [],
            distanceMeters: 0,
            durationSeconds: 0,
            provider: this.name,
            calculatedAt,
            status: 'NO_ROUTE',
            error: data.message || 'No drivable route found between coordinates',
          };
        }
        return {
          coordinates: [],
          distanceMeters: 0,
          durationSeconds: 0,
          provider: this.name,
          calculatedAt,
          status: 'FAILED',
          error: data.message || `OSRM error code: ${data.code}`,
        };
      }

      const primary = data.routes[0];
      const rawCoordinates = primary.geometry?.coordinates ?? [];

      // Convert GeoJSON [lng, lat] to Leaflet / Map coordinate pairs [lat, lng]
      const coordinates: [number, number][] = rawCoordinates.map(([lng, lat]) => [lat, lng]);

      return {
        coordinates,
        distanceMeters: Math.round(primary.distance * 10) / 10,
        durationSeconds: Math.round(primary.duration),
        provider: this.name,
        calculatedAt,
        status: 'SUCCESS',
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, url }, 'OSRM routing request failed');
      return {
        coordinates: [],
        distanceMeters: 0,
        durationSeconds: 0,
        provider: this.name,
        calculatedAt,
        status: 'FAILED',
        error: errorMsg,
      };
    }
  }
}
