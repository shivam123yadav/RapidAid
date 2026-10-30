import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api, type PublicUser } from '../api/client';
import { session } from '../api/session';
import type { UserRole } from '../types';

interface AuthState {
  isAuthenticated: boolean;
  user: PublicUser | null;
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
  logout: () => Promise<void>;
}

let lastLoginError: string | null = null;
export const getLoginError = (): string | null => lastLoginError;

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      user: null,

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
          const { user, accessToken } = await api.auth.register({ name, email, password, role: 'CITIZEN' });
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

      setUser: (patch: Partial<PublicUser>) => {
        set((state) => (state.user ? { user: { ...state.user, ...patch } } : state));
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
