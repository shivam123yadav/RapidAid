/**
 * Device GPS for the voice-emergency location fallback.
 *
 * RapidAid distinguishes three location sources and never pretends one is
 * another:
 *   SPOKEN — a place named in the voice message (preferred)
 *   DEVICE — this browser's geolocation fix (fallback)
 *   MANUAL — coordinates the reporter confirmed by hand
 *
 * If none of them resolve, the request stays UNRESOLVED and the UI asks the
 * user to confirm a location rather than routing to an arbitrary hospital.
 */

export type LocationSource = 'SPOKEN' | 'DEVICE' | 'MANUAL';

export interface DeviceLocation {
  latitude: number;
  longitude: number;
  /** Reported horizontal accuracy in metres. */
  accuracy: number;
  source: 'DEVICE';
}

export type DeviceLocationResult =
  | { ok: true; location: DeviceLocation }
  | { ok: false; reason: 'unsupported' | 'denied' | 'unavailable' | 'timeout'; message: string };

/**
 * Requests a one-shot position fix. Never throws: every failure mode is
 * returned as a typed result so the caller can pick the right fallback and
 * show an accurate message.
 */
export function getDeviceLocation(timeoutMs = 10_000): Promise<DeviceLocationResult> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.resolve({
      ok: false,
      reason: 'unsupported',
      message: 'This browser cannot share your location.',
    });
  }

  return new Promise<DeviceLocationResult>((resolve) => {
    let settled = false;
    const finish = (result: DeviceLocationResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // A hard timeout: some browsers never fire the error callback at all.
    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout', message: 'Timed out while getting your location.' });
    }, timeoutMs);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        const { latitude, longitude, accuracy } = position.coords;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
          finish({
            ok: false,
            reason: 'unavailable',
            message: 'Your device returned an invalid position.',
          });
          return;
        }
        finish({ ok: true, location: { latitude, longitude, accuracy, source: 'DEVICE' } });
      },
      (error) => {
        clearTimeout(timer);
        if (error.code === error.PERMISSION_DENIED) {
          finish({
            ok: false,
            reason: 'denied',
            message: 'Location permission was denied. Please type or confirm the location.',
          });
          return;
        }
        if (error.code === error.TIMEOUT) {
          finish({ ok: false, reason: 'timeout', message: 'Timed out while getting your location.' });
          return;
        }
        finish({
          ok: false,
          reason: 'unavailable',
          message: 'Your location is unavailable. Please type or confirm the location.',
        });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}