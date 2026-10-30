export interface Coordinate {
  lat: number;
  lng: number;
  address?: string | null;
}

export type RouteStatus = 'SUCCESS' | 'NO_ROUTE' | 'FAILED' | 'UNAVAILABLE';

export interface RouteResult {
  coordinates: [number, number][]; // [lat, lng]
  distanceMeters: number;
  durationSeconds: number;
  provider: string;
  calculatedAt: Date;
  status: RouteStatus;
  error?: string;
}

export interface RoutingProvider {
  readonly name: string;
  calculateRoute(origin: Coordinate, destination: Coordinate): Promise<RouteResult>;
}

export interface ActiveRouteData {
  coordinates: [number, number][]; // [lat, lng]
  distanceMeters: number;
  durationSeconds: number;
  calculatedAt: Date;
  destinationType: 'INCIDENT' | 'HOSPITAL';
  destinationId: string;
  destinationLocation: {
    lat: number;
    lng: number;
    address?: string | null;
  };
  routeOrigin: {
    lat: number;
    lng: number;
  };
  provider: string;
  status: RouteStatus;
  isStale: boolean;
  deviated: boolean;
  deviationDistanceMeters?: number;
}
