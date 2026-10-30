/**
 * In-memory access-token holder + single-flight refresh.
 *
 * The short-lived access JWT lives only in module memory (never persisted
 * to localStorage — XSS can't read it). The long-lived refresh token is an
 * httpOnly cookie the browser attaches automatically. On a 401 the API
 * client calls session.refresh() once (concurrent 401s share one in-flight
 * refresh), then retries the original request.
 *
 * The auth store registers `onSessionExpired` so a failed refresh clears
 * persisted auth state and the route guard redirects to /login.
 */

/**
 * Normalizes the API base URL to ensure proper prefixing and eliminate trailing slashes.
 * Supports:
 *  - Default local proxy: '/api'
 *  - Custom relative path: '/api'
 *  - Absolute URL without /api: 'https://backend.onrender.com' -> 'https://backend.onrender.com/api'
 *  - Absolute URL with /api: 'https://backend.onrender.com/api' -> 'https://backend.onrender.com/api'
 *  - Trailing slashes: 'https://backend.onrender.com/' -> 'https://backend.onrender.com/api'
 */
export function resolveApiBase(rawUrl?: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') return '/api';
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) return '/api';
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

const API_BASE = resolveApiBase(import.meta.env.VITE_API_URL as string | undefined);

let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    accessToken = data.accessToken ?? null;
    return accessToken;
  } catch {
    return null; // network failure — treat like an expired session
  } finally {
    refreshInFlight = null;
  }
}

export const session = {
  apiBase: API_BASE,
  getAccessToken: (): string | null => accessToken,
  setAccessToken: (token: string | null): void => {
    accessToken = token;
  },
  /** Single-flight refresh: parallel callers await the same promise. */
  refresh: (): Promise<string | null> => {
    if (!refreshInFlight) refreshInFlight = doRefresh();
    return refreshInFlight;
  },
  /** Registered by the auth store; called when refresh ultimately fails. */
  onSessionExpired: (): void => {},
};
