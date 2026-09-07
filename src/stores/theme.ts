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
    root.classList.remove('light');
  } else {
    root.classList.add('light');
    root.classList.remove('dark');
  }
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
        set({ resolved });
        applyTheme(resolved);
      },
    }),
    { 
      name: 'rapidaid-theme', 
      partialize: (state) => ({ mode: state.mode }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          const resolved = resolveTheme(state.mode);
          applyTheme(resolved);
        }
      }
    }
  )
);

export function useTheme() {
  return useThemeStore((s) => ({
    mode: s.mode,
    resolved: s.resolved,
    setMode: s.setMode,
  }));
}
