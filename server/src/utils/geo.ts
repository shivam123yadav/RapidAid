/** Great-circle distance in meters between two WGS-84 points. */
export function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Urban ambulance ETA in seconds: distance / speed plus a fixed dispatch
 * overhead (siren-priority driving through Delhi traffic ≈ 8 m/s ≈ 29 km/h).
 */
export const AVG_AMBULANCE_SPEED_MPS = 8;
export const DISPATCH_OVERHEAD_SECONDS = 45;

export function estimateEtaSeconds(distanceMeters: number): number {
  return Math.round(distanceMeters / AVG_AMBULANCE_SPEED_MPS) + DISPATCH_OVERHEAD_SECONDS;
}

export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
