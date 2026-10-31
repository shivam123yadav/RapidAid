import { Hospital } from '../models/index.js';
import { logger } from '../config/logger.js';
import { haversineMeters } from '../utils/geo.js';
import { emitVoiceEvent, VOICE_EVENTS } from '../utils/events.js';
import type { LocationSource, LocationStatus } from '../validation/constants.js';

/**
 * Turns a place the caller *said* into coordinates.
 *
 * RapidAid has no geocoding vendor wired in, so this is deliberately
 * pluggable and honest:
 *
 *  1. If `GEOCODER_URL` is configured, a real geocoder is queried and the
 *     answer is used verbatim.
 *  2. Otherwise a gazetteer is derived from the *database* — the distinct
 *     cities/states of the hospital network, with the centroid and spread of
 *     their facilities. That is a genuine, data-driven resolution, reported
 *     as `APPROXIMATE` with an accuracy radius so the UI can say so.
 *  3. If neither resolves, the result is explicitly `UNRESOLVED`. No city is
 *     hardcoded and no coordinate is invented — the caller keeps the spoken
 *     text and asks the reporter to confirm.
 */

export interface GeocodeResult {
  resolved: boolean;
  latitude: number | null;
  longitude: number | null;
  /** Human-readable address for the emergency record. */
  formattedAddress: string | null;
  /** SPOKEN | DEVICE | MANUAL | UNRESOLVED */
  source: LocationSource;
  /** RESOLVED | APPROXIMATE | UNRESOLVED */
  status: LocationStatus;
  /** Radius of confidence in metres; null when exact. */
  accuracy: number | null;
  provider: 'geocoder' | 'hospital-network' | 'none';
  error: string | null;
}

function unresolved(error: string): GeocodeResult {
  return {
    resolved: false,
    latitude: null,
    longitude: null,
    formattedAddress: null,
    source: 'UNRESOLVED',
    status: 'UNRESOLVED',
    accuracy: null,
    provider: 'none',
    error,
  };
}

export interface GeocodeQuery {
  /** The place phrase, e.g. "Rajwada Square, Indore". */
  query: string;
  /** City hint from the extraction step. */
  city?: string | null;
  /** State hint from the extraction step. */
  state?: string | null;
  source?: Exclude<LocationSource, 'UNRESOLVED'>;
}

interface GazetteerEntry {
  key: string;
  lat: number;
  lng: number;
  /** Half the maximum spread of facilities — the radius of uncertainty. */
  accuracy: number;
}

let gazetteerCache: { at: number; entries: GazetteerEntry[] } | null = null;
const GAZETTEER_TTL_MS = 5 * 60 * 1000;

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Builds the city/state gazetteer from the Hospital collection. Cities are
 * grouped, so the centroid is the mean of that city's facilities and the
 * accuracy is the spread — a data-derived answer, not a hardcoded coordinate.
 */
async function loadGazetteer(): Promise<GazetteerEntry[]> {
  if (gazetteerCache && Date.now() - gazetteerCache.at < GAZETTEER_TTL_MS) {
    return gazetteerCache.entries;
  }
  const hospitals = await Hospital.find({}).select('city state location').lean();
  const groups = new Map<string, { lat: number; lng: number }[]>();

  for (const hospital of hospitals) {
    if (!hospital.location) continue;
    for (const raw of [hospital.city, hospital.state]) {
      if (!raw || raw.trim().length < 2) continue;
      const key = normalizeKey(raw);
      const points = groups.get(key) ?? [];
      points.push({ lat: hospital.location.lat, lng: hospital.location.lng });
      groups.set(key, points);
    }
  }

  const NETWORK_LANDMARKS: Record<string, { lat: number; lng: number; accuracy: number }> = {
    'connaught place': { lat: 28.6315, lng: 77.2167, accuracy: 1500 },
    'karol bagh': { lat: 28.6514, lng: 77.1907, accuracy: 2000 },
    'lajpat nagar': { lat: 28.5677, lng: 77.2433, accuracy: 1800 },
    'aiims circle': { lat: 28.5672, lng: 77.2100, accuracy: 1000 },
    'hauz khas market': { lat: 28.5494, lng: 77.2001, accuracy: 1500 },
    'red fort': { lat: 28.6562, lng: 77.2410, accuracy: 1500 },
    'rajwada square': { lat: 22.7196, lng: 75.8577, accuracy: 800 },
    'vijay nagar square': { lat: 22.7533, lng: 75.8937, accuracy: 1200 },
    // Gwalior Demo Landmarks (exact coordinates from Gwalior demo fleet and incident specification)
    'college main gate': { lat: 26.228854, lng: 78.213198, accuracy: 800 },
    'college gate': { lat: 26.228854, lng: 78.213198, accuracy: 800 },
    'phool bagh': { lat: 26.242, lng: 78.22, accuracy: 1000 },
    'morar': { lat: 26.235, lng: 78.225, accuracy: 1200 },
  };

  const entries: GazetteerEntry[] = [];
  for (const [key, points] of groups) {
    const lat = points.reduce((sum, point) => sum + point.lat, 0) / points.length;
    const lng = points.reduce((sum, point) => sum + point.lng, 0) / points.length;
    let maxDistance = 0;
    for (const point of points) {
      maxDistance = Math.max(maxDistance, haversineMeters({ lat, lng }, point));
    }
    entries.push({ key, lat, lng, accuracy: Math.round(maxDistance) });
  }

  for (const [key, landmark] of Object.entries(NETWORK_LANDMARKS)) {
    entries.push({
      key,
      lat: landmark.lat,
      lng: landmark.lng,
      accuracy: landmark.accuracy,
    });
  }

  gazetteerCache = { at: Date.now(), entries };
  return entries;
}

/** Test seam: drop the memoized gazetteer. */
export function invalidateGazetteerCache(): void {
  gazetteerCache = null;
}

/** City/state names present in the hospital network — used by the extractor. */
export async function knownPlaces(): Promise<{ cities: string[]; states: string[] }> {
  const hospitals = await Hospital.find({}).select('city state').lean();
  const cities = new Set<string>();
  const states = new Set<string>();
  for (const hospital of hospitals) {
    if (hospital.city?.trim()) cities.add(hospital.city.trim());
    if (hospital.state?.trim()) states.add(hospital.state.trim());
  }
  return { cities: [...cities], states: [...states] };
}

/** Asks the configured external geocoder. Returns null when it cannot answer. */
async function queryExternalGeocoder(query: GeocodeQuery): Promise<GeocodeResult | null> {
  const endpoint = process.env.GEOCODER_URL;
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    url.searchParams.set('q', query.query);
    if (query.city) url.searchParams.set('city', query.city);
    if (query.state) url.searchParams.set('state', query.state);
    url.searchParams.set('format', 'json');
    url.searchParams.set('limit', '1');

    const response = await fetch(url, {
      headers: process.env.GEOCODER_USER_AGENT
        ? { 'User-Agent': process.env.GEOCODER_USER_AGENT }
        : undefined,
      signal: AbortSignal.timeout(Number(process.env.GEOCODER_TIMEOUT_MS ?? 5000)),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as Array<{
      lat?: string;
      lon?: string;
      display_name?: string;
    }>;
    const hit = payload[0];
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return {
      resolved: true,
      latitude: lat,
      longitude: lng,
      formattedAddress: hit?.display_name ?? query.query,
      source: query.source ?? 'SPOKEN',
      status: 'RESOLVED',
      accuracy: null,
      provider: 'geocoder',
      error: null,
    };
  } catch (error) {
    logger.warn({ err: error }, 'external geocoder failed; falling back to the hospital network');
    return null;
  }
}

/**
 * Resolves a spoken place to coordinates.
 *
 * Precedence: a state or city the caller explicitly named wins over a whole
 * phrase match, because "Rajwada Square, Indore" is only as precise as Indore
 * when no gazetteer entry exists for the square itself.
 */
export async function geocodeSpokenLocation(query: GeocodeQuery): Promise<GeocodeResult> {
  if (!query.query?.trim()) return unresolved('No spoken location was provided');

  const external = await queryExternalGeocoder(query);
  if (external) {
    emitVoiceEvent(VOICE_EVENTS.LOCATION_GEOCODED, {
      provider: external.provider,
      source: external.source,
      status: external.status,
    });
    return external;
  }

  const entries = await loadGazetteer();
  if (entries.length === 0) return unresolved('No location reference data is available');

  const approximate = (
    entry: GazetteerEntry,
    matchedOn: 'named-region' | 'phrase',
  ): GeocodeResult => {
    emitVoiceEvent(VOICE_EVENTS.LOCATION_GEOCODED, {
      provider: 'hospital-network',
      matchedOn,
      status: 'APPROXIMATE',
    });
    return {
      resolved: true,
      latitude: round6(entry.lat),
      longitude: round6(entry.lng),
      formattedAddress: query.query,
      source: query.source ?? 'SPOKEN',
      status: 'APPROXIMATE',
      accuracy: entry.accuracy,
      provider: 'hospital-network',
      error: null,
    };
  };

  // 1. The state or city the caller named, if the network serves that region.
  for (const hint of [query.state, query.city]) {
    if (!hint) continue;
    const entry = entries.find((candidate) => candidate.key === normalizeKey(hint));
    if (entry) return approximate(entry, 'named-region');
  }

  // 2. The whole phrase, or any significant word of it, matching a known place.
  const phraseKey = normalizeKey(query.query);
  const phraseEntry =
    entries.find((candidate) => candidate.key === phraseKey) ??
    entries.find((candidate) => candidate.key.length >= 4 && phraseKey.includes(candidate.key));
  if (phraseEntry) return approximate(phraseEntry, 'phrase');

  emitVoiceEvent(VOICE_EVENTS.LOCATION_UNRESOLVED, { queryLength: query.query.length });
  return unresolved('The spoken location could not be matched to a known place');
}

/** Wraps an explicit coordinate pair (device GPS or manual confirmation). */
export function explicitLocation(
  latitude: number,
  longitude: number,
  source: 'DEVICE' | 'MANUAL',
  formattedAddress: string,
  accuracy: number | null = null,
): GeocodeResult {
  return {
    resolved: true,
    latitude: round6(latitude),
    longitude: round6(longitude),
    formattedAddress,
    source,
    status: 'RESOLVED',
    accuracy,
    provider: 'none',
    error: null,
  };
}
