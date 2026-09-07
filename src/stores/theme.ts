import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ThemeMode } from '../types';

interface ThemeState {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode: (mode: ThemeMode) => void;
  initTheme: () => void;
}

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') return getSystemTheme();
  return mode;
}

function applyTheme(theme: 'light' | 'dark') {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

// Apply theme immediately from localStorage before React loads
function applyStoredTheme() {
  try {
    const stored = localStorage.getItem('rapidaid-theme');
    if (stored) {
      const parsed = JSON.parse(stored);
      const mode = parsed?.state?.mode || 'system';
      const resolved = resolveTheme(mode);
      applyTheme(resolved);
    }
  } catch {
    // ignore
  }
}

// Run immediately on module load
if (typeof window !== 'undefined') {
  applyStoredTheme();
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: 'system',
      resolved: getSystemTheme(),
      setMode: (mode) => {
        const resolved = resolveTheme(mode);
        set({ mode, resolved });
        applyTheme(resolved);
      },
      initTheme: () => {
        const { mode } = get();
        const resolved = resolveTheme(mode);
        // Only update if actually different to avoid unnecessary re-renders
        const current = get();
        if (current.resolved !== resolved) {
          set({ resolved });
        }
        applyTheme(resolved);
      },
    }),
    {
      name: 'rapidaid-theme',
      partialize: (state) => ({ mode: state.mode }),
    }
  )
);

export function useTheme() {
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolved);
  const setMode = useThemeStore((s) => s.setMode);
  return { mode, resolved, setMode };
}
