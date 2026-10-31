import { useEffect } from 'react';
import { useAuthStore } from '../stores/auth';

/**
 * Automatically synchronizes authenticated user verification status and profile data.
 *
 * Listens for:
 * 1. window 'focus': fired when the user returns to or clicks the dashboard window.
 * 2. document 'visibilitychange': fired when the browser tab transitions to 'visible'.
 *
 * When triggered, calls `refreshUser()` to pull authoritative account state from GET /api/auth/me,
 * allowing cross-device actions (e.g. email confirmation on mobile) to immediately reflect
 * in the active desktop dashboard without requiring a full page reload.
 */
export function useAuthSync(): void {
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  useEffect(() => {
    if (!isAuthenticated) return;

    const handleFocus = () => {
      refreshUser();
    };

    const handleVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        refreshUser();
      }
    };

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', handleFocus);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleVisibilityChange);
    }

    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', handleFocus);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
    };
  }, [isAuthenticated, refreshUser]);
}
