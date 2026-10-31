import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, ApiError, type PublicUser } from '../api/client';
import { session } from '../api/session';
import type { UserRole } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: PublicUser | null;
  registrationEmailDelivery: 'sent' | 'failed' | null;
  /**
   * Returns true on success. On failure the server's error message (wrong
   * password, role mismatch …) is available via getLoginError() so the
   * login page can show something specific before its generic fallback.
   */
  login: (email: string, password: string, role: UserRole) => Promise<boolean>;
  /**
   * Self-service citizen signup. Mirrors `login`: on success the session is
   * established, because the register endpoint returns a token pair. The role
   * is not a parameter — public registration is citizen-only by design.
   */
  register: (name: string, email: string, password: string) => Promise<boolean>;
  /**
   * Patches the cached identity, e.g. flipping `emailVerified` once the user
   * follows their confirmation link. Only display state is updated — this never
   * grants a permission, and the server re-derives the real claim on every call.
   */
  setUser: (patch: Partial<PublicUser>) => void;
  /**
   * Queries GET /api/auth/me to synchronize the authenticated user's profile and
   * authoritative email verification status without reloading the page.
   *
   * Coalesces concurrent calls and applies a 1-second throttle to avoid redundant
   * API requests when multiple focus/visibilitychange events fire together.
   */
  refreshUser: (force?: boolean) => Promise<PublicUser | null>;
  logout: () => Promise<void>;
}

let lastLoginError: string | null = null;
export const getLoginError = (): string | null => lastLoginError;

let inFlightRefresh: Promise<PublicUser | null> | null = null;
let lastRefreshTime = 0;

/** Exposed strictly for unit tests to reset the focus/visibility throttle. */
export const _resetRefreshThrottleForTest = (): void => {
  lastRefreshTime = 0;
  inFlightRefresh = null;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      isAuthenticated: false,
      user: null,
      registrationEmailDelivery: null,

      login: async (email: string, password: string, role: UserRole): Promise<boolean> => {
        lastLoginError = null;
        try {
          const { user, accessToken } = await api.auth.login(email, password, role);
          session.setAccessToken(accessToken);
          set({ isAuthenticated: true, user });
          return true;
        } catch (err) {
          lastLoginError = err instanceof Error ? err.message : null;
          session.setAccessToken(null);
          set({ isAuthenticated: false, user: null });
          return false;
        }
      },

      register: async (name: string, email: string, password: string): Promise<boolean> => {
        lastLoginError = null;
        try {
          // Role is fixed to CITIZEN: privileged accounts are provisioned
          // through the audited admin API, never chosen by the public.
          const res = await api.auth.register({ name, email, password, role: 'CITIZEN' });
          session.setAccessToken(res.accessToken);
          set({
            isAuthenticated: true,
            user: res.user,
            registrationEmailDelivery: res.emailDelivery ?? 'sent',
          });
          return true;
        } catch (err) {
          lastLoginError = err instanceof Error ? err.message : null;
          session.setAccessToken(null);
          set({ isAuthenticated: false, user: null, registrationEmailDelivery: null });
          return false;
        }
      },

      setUser: (patch: Partial<PublicUser>) => {
        set((state) => (state.user ? { user: { ...state.user, ...patch } } : state));
      },

      refreshUser: async (force = false): Promise<PublicUser | null> => {
        const state = get();
        if (!state.isAuthenticated || !state.user) return null;

        // Coalesce concurrent calls into a single network flight
        if (inFlightRefresh) return inFlightRefresh;

        // Throttle back-to-back calls within 1 second to avoid redundant server roundtrips
        const now = Date.now();
        if (!force && now - lastRefreshTime < 1000) {
          return state.user;
        }

        inFlightRefresh = (async () => {
          try {
            let freshUser: PublicUser;
            try {
              freshUser = await api.auth.me();
            } catch (err) {
              // If the access token expired while away, silently refresh once before failing
              if (err instanceof ApiError && err.status === 401) {
                const refreshed = await session.refresh();
                if (refreshed) {
                  freshUser = await api.auth.me();
                } else {
                  return get().user;
                }
              } else {
                return get().user;
              }
            }

            lastRefreshTime = Date.now();
            if (freshUser && typeof freshUser === 'object') {
              set((curr) => {
                if (!curr.user) return curr;
                return {
                  user: { ...curr.user, ...freshUser },
                  registrationEmailDelivery: freshUser.emailVerified ? null : curr.registrationEmailDelivery,
                };
              });
              return freshUser;
            }
            return get().user;
          } catch {
            // Requirement 4: Preserve last known authenticated user state when refresh fails.
            // Do not falsely mark verified. Do not log user out or interrupt session.
            return get().user;
          } finally {
            inFlightRefresh = null;
          }
        })();

        return inFlightRefresh;
      },

      logout: async (): Promise<void> => {
        try {
          await api.auth.logout(); // revokes the refresh token server-side
        } catch {
          // Even if the network call fails we still clear local state.
        }
        session.setAccessToken(null);
        set({ isAuthenticated: false, user: null });
      },
    }),
    {
      name: 'rapidaid-auth',
      // Only persist identity — the access token stays in memory
      // (session.ts) and is re-established via the httpOnly refresh cookie.
      partialize: (state) => ({ isAuthenticated: state.isAuthenticated, user: state.user }),
    },
  ),
);

// Route guard + API client signal: refresh ultimately failed → sign out.
session.onSessionExpired = () => {
  session.setAccessToken(null);
  useAuthStore.setState({ isAuthenticated: false, user: null });
};
