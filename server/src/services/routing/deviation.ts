import type { Coordinate } from './types.js';

const EARTH_RADIUS_METERS = 6371000;

export function isValidCoordinate(coord?: Partial<Coordinate> | null): coord is Coordinate {
  if (!coord || typeof coord !== 'object') return false;
  const lat = typeof coord.lat === 'number' ? coord.lat : Number(coord.lat);
  const lng = typeof coord.lng === 'number' ? coord.lng : Number(coord.lng);
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Calculates great-circle distance between two points in meters using Haversine formula.
 */
export function haversineDistanceMeters(p1: Coordinate, p2: Coordinate): number {
  const lat1 = (p1.lat * Math.PI) / 180;
  const lat2 = (p2.lat * Math.PI) / 180;
  const dLat = ((p2.lat - p1.lat) * Math.PI) / 180;
  const dLng = ((p2.lng - p1.lng) * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

/**
 * Distance in meters from a point P to a line segment AB.
 */
function distanceToSegmentMeters(p: Coordinate, a: Coordinate, b: Coordinate): number {
  const meanLat = ((a.lat + b.lat + p.lat) / 3) * (Math.PI / 180);
  const cosLat = Math.cos(meanLat);

  // Convert to local Cartesian coordinates in meters relative to point A
  const bx = (b.lng - a.lng) * (Math.PI / 180) * EARTH_RADIUS_METERS * cosLat;
  const by = (b.lat - a.lat) * (Math.PI / 180) * EARTH_RADIUS_METERS;

  const px = (p.lng - a.lng) * (Math.PI / 180) * EARTH_RADIUS_METERS * cosLat;
  const py = (p.lat - a.lat) * (Math.PI / 180) * EARTH_RADIUS_METERS;

  const segLengthSq = bx * bx + by * by;
  if (segLengthSq === 0) {
    return Math.sqrt(px * px + py * py);
  }

  // Projection scalar t on segment [0, 1]
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLengthSq));

  const projX = t * bx;
  const projY = t * by;

  const dx = px - projX;
  const dy = py - projY;
  return Math.sqrt(dx * dx + dy * dy);
}

export interface DeviationResult {
  minDistanceMeters: number;
  isDeviated: boolean;
  nearestSegmentIndex: number;
}

/**
 * Computes minimum perpendicular distance from a position to an existing route polyline [ [lat, lng], ... ].
 */
export function calculateRouteDeviation(
  currentPosition: Coordinate,
  routeCoordinates: [number, number][],
  thresholdMeters = 100,
): DeviationResult {
  if (!routeCoordinates || routeCoordinates.length < 2) {
    const singleDist = routeCoordinates.length === 1
      ? haversineDistanceMeters(currentPosition, { lat: routeCoordinates[0][0], lng: routeCoordinates[0][1] })
      : 0;
    return {
      minDistanceMeters: singleDist,
      isDeviated: singleDist > thresholdMeters,
      nearestSegmentIndex: 0,
    };
  }

  let minDistance = Infinity;
  let nearestSegmentIndex = 0;

  for (let i = 0; i < routeCoordinates.length - 1; i++) {
    const p1: Coordinate = { lat: routeCoordinates[i][0], lng: routeCoordinates[i][1] };
    const p2: Coordinate = { lat: routeCoordinates[i + 1][0], lng: routeCoordinates[i + 1][1] };
    const dist = distanceToSegmentMeters(currentPosition, p1, p2);
    if (dist < minDistance) {
      minDistance = dist;
      nearestSegmentIndex = i;
    }
  }

  return {
    minDistanceMeters: Math.round(minDistance * 10) / 10,
    isDeviated: minDistance > thresholdMeters,
    nearestSegmentIndex,
  };
}
