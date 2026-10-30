import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import {
  APPEARANCE_OPTIONS,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME_ID,
  MODE_STORAGE_KEY,
  THEME_LIST,
  THEME_STORAGE_KEY,
  getTheme,
  getVariant,
  legacyAppearance,
  resolveAppearance,
  resolveTheme,
  validateAppearanceMode,
  validateThemeId,
} from '../theme';
import type {
  AppearanceMode,
  ResolvedAppearance,
  ResolvedTheme,
  ThemeDefinition,
  ThemeId,
} from '../theme';

/**
 * RapidAid theme provider — COLOR THEME + APPEARANCE MODE.
 *
 * This store is the single source of truth for "what does RapidAid look like".
 * There is deliberately no second ThemeProvider/ThemeContext — components read
 * tokens through CSS variables, so changing either half of the pair mutates ONE
 * element:
 *
 *     USER -> SETTINGS / HEADER -> useThemeStore
 *          -> <html data-theme data-appearance> -> CSS VARIABLES -> ALL UI
 *
 * Consequences that matter operationally:
 *   - changing theme or mode never navigates, reloads, remounts or resets
 *   - no component takes a `theme`/`mode` prop, so there is no re-render cascade
 *   - auth, RBAC, API, emergency, voice, AI and map logic are untouched
 *   - `appearance` (the user's choice) and `resolvedAppearance` (what renders)
 *     are separate, so `system` can follow the OS without ever rewriting the
 *     saved preference
 *
 * Persistence: TWO keys, both validated on read.
 *   rapidaid-theme — the zustand envelope: { themeId, appearance }
 *   rapidaid-mode  — the plain-text mirror: day | night | system
 * The mirror exists so the pre-paint guard in index.html can read the mode
 * without a JSON parse. The backend has no user-preference endpoint
 * (PATCH /api/auth/me accepts name/avatar only), so localStorage is the whole
 * persistence story — and every read/write is guarded, because a blocked or
 * corrupted store must never break the app.
 */

/** Minimal storage contract: localStorage with an in-memory fallback. */
interface SafeStorage {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/** Keeps the app alive when localStorage is unavailable (private mode, tests). */
const memoryFallback = new Map<string, string>();

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.localStorage;
  } catch {
    return false;
  }
}

/** Raw, unvalidated read — used for the plain-text mode mirror. */
function rawGet(name: string): string | null {
  if (canUseLocalStorage()) {
    try {
      // localStorage is authoritative: the tests (and users) can edit or clear
      // it directly between reads, so always prefer its answer — even `null`.
      return window.localStorage.getItem(name);
    } catch {
      /* storage blocked mid-read: fall through to the in-memory copy */
    }
  }
  return memoryFallback.get(name) ?? null;
}

const safeStorage: SafeStorage = {
  getItem(name) {
    const raw = rawGet(name);
    if (raw === null) return null;
    // A corrupt payload must behave exactly like a missing one.
    try {
      JSON.parse(raw);
    } catch {
      return null;
    }
    return raw;
  },
  setItem(name, value) {
    memoryFallback.set(name, value);
    if (!canUseLocalStorage()) return;
    try {
      window.localStorage.setItem(name, value);
    } catch {
      /* quota exceeded or storage blocked — the in-memory copy already holds it */
    }
  },
  removeItem(name) {
    memoryFallback.delete(name);
    if (!canUseLocalStorage()) return;
    try {
      window.localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Maps a pre-theme-system `light | dark | system` value (or the old theme
 * `mode` field) onto one of the five registered themes, so nobody who used the
 * old control loses their choice.
 */
function themeIdFromLegacyMode(mode: unknown): ThemeId | null {
  if (mode === 'light') return 'rescue-glass';
  if (mode === 'dark') return 'command-pulse';
  // A legacy "follow the OS" choice keeps meaning System (the appearance is
  // migrated separately) and lands on the default palette.
  if (mode === 'system') return 'command-pulse';
  return null;
}

export interface ThemeState {
  /** Active theme id — the only theme value that ever leaves this store. */
  themeId: ThemeId;
  /** The user's choice: `day`, `night` or `system`. Stored verbatim. */
  appearance: AppearanceMode;
  /** What the document is actually painted with right now. */
  resolvedAppearance: ResolvedAppearance;
  /** Registered themes (stable array reference — safe as a React dependency). */
  themes: ThemeDefinition[];
  /** Change the palette. Keeps the current appearance. Invalid input is ignored. */
  setTheme: (id: unknown) => void;
  /** Change the appearance mode. Invalid input falls back to `system`. */
  setAppearance: (mode: unknown) => void;
  /** Legacy alias for `setAppearance` (also accepts the old light/dark words). */
  setMode: (mode: unknown) => void;
  /** Re-apply the current pair (called on mount and after an OS change). */
  initTheme: () => void;
  /**
   * Re-resolve `system` against the live media query. A no-op for explicit
   * day/night, and it never rewrites the user's saved selection.
   */
  syncSystemAppearance: () => void;
  /** Read + validate + apply the persisted pair. Returns the applied theme id. */
  restoreTheme: () => ThemeId;
  /** Write the current selection to storage. False when storage is blocked. */
  persistTheme: (id?: ThemeId) => boolean;
  /** Mutate the DOM: data-theme, data-appearance, .dark, data-glow, color-scheme. */
  applyTheme: (id?: ThemeId) => void;
  /** Returns the id if it is registered, otherwise null. */
  validateTheme: (value: unknown) => ThemeId | null;
  /** Returns the mode if it is valid, otherwise null. */
  validateAppearance: (value: unknown) => AppearanceMode | null;
}

/** Mirrors the selected mode into the plain-text key the flash guard reads. */
function writeModeMirror(mode: AppearanceMode): void {
  safeStorage.setItem(MODE_STORAGE_KEY, mode);
}

/**
 * The ONLY place that touches the document for theming.
 *
 * It writes attributes on `<html>` instead of re-rendering React, which is
 * exactly why a switch cannot remount a component, reset a form, interrupt a
 * recording, re-create a Leaflet map or clear emergency state.
 *
 * `prefersNight` is forwarded to the resolver, so a test (or the OS-change
 * listener) can resolve `system` deterministically.
 */
function applyResolvedTheme(
  themeId: ThemeId,
  mode: AppearanceMode,
  prefersNight?: boolean,
): ResolvedAppearance {
  const resolved: ResolvedTheme = resolveTheme(themeId, mode, prefersNight);
  writeModeMirror(mode);
  if (typeof document === 'undefined') return resolved.appearance;

  const root = document.documentElement;
  root.setAttribute('data-theme', resolved.theme.id);
  root.setAttribute('data-appearance', resolved.appearance);
  // Legacy marker: any `dark:` utility or `.dark` rule keeps working.
  root.classList.toggle('dark', resolved.appearance === 'night');
  // Scoped glow switch — CSS reads this instead of naming a theme id, so an
  // Aether Day (glow off) loses its halo without any component knowing why.
  root.setAttribute('data-glow', resolved.variant.effects.glow ? 'on' : 'off');
  root.style.colorScheme = resolved.appearance === 'night' ? 'dark' : 'light';
  // Paint immediately: on a cold load the stylesheet may still be parsing, and
  // index.html's guard has already set this same colour for the first frame.
  root.style.backgroundColor = resolved.variant.tokens.background;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved.variant.tokens.background);
  return resolved.appearance;
}

/** Reads the plain-text mirror, then the envelope, then the default. */
function readPersistedAppearance(): AppearanceMode {
  const mirror = rawGet(MODE_STORAGE_KEY);
  const fromMirror = validateAppearanceMode(mirror) ?? legacyAppearance(mirror);
  if (fromMirror) return fromMirror;
  try {
    const raw = safeStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as { state?: { appearance?: unknown; mode?: unknown } };
    const state = parsed?.state;
    return (
      validateAppearanceMode(state?.appearance) ??
      legacyAppearance(state?.mode) ??
      DEFAULT_APPEARANCE
    );
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Reads the persisted id, falling back through legacy values to the default. */
function readPersistedThemeId(): ThemeId {
  try {
    const raw = safeStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return DEFAULT_THEME_ID;
    const parsed = JSON.parse(raw) as { state?: { themeId?: unknown; mode?: unknown } };
    const state = parsed?.state;
    return (
      validateThemeId(state?.themeId) ?? themeIdFromLegacyMode(state?.mode) ?? DEFAULT_THEME_ID
    );
  } catch {
    return DEFAULT_THEME_ID;
  }
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      themeId: DEFAULT_THEME_ID,
      appearance: DEFAULT_APPEARANCE,
      resolvedAppearance: resolveAppearance(DEFAULT_APPEARANCE),
      themes: THEME_LIST,

      setTheme: (id) => {
        const valid = validateThemeId(id);
        if (!valid || valid === get().themeId) return;
        // The appearance mode is untouched: only the palette changes.
        const resolvedAppearance = applyResolvedTheme(valid, get().appearance);
        set({ themeId: valid, resolvedAppearance });
      },

      setAppearance: (mode) => {
        // Unknown input degrades to the default instead of throwing, and the
        // pre-appearance words (light/dark) still map onto day/night.
        const valid =
          validateAppearanceMode(mode) ?? legacyAppearance(mode) ?? DEFAULT_APPEARANCE;
        // Re-applied even when unchanged, so re-selecting `system` picks up the
        // current OS preference immediately.
        const resolvedAppearance = applyResolvedTheme(get().themeId, valid);
        set({ appearance: valid, resolvedAppearance });
      },

      setMode: (mode) => get().setAppearance(mode),

      initTheme: () => {
        const { themeId, appearance } = get();
        set({ resolvedAppearance: applyResolvedTheme(themeId, appearance) });
      },

      syncSystemAppearance: () => {
        const { themeId, appearance } = get();
        // An explicit day/night choice is never overridden by the OS.
        if (appearance !== 'system') return;
        set({ resolvedAppearance: applyResolvedTheme(themeId, appearance) });
      },

      restoreTheme: () => {
        const id = readPersistedThemeId();
        const appearance = readPersistedAppearance();
        const resolvedAppearance = applyResolvedTheme(id, appearance);
        set({ themeId: id, appearance, resolvedAppearance });
        return id;
      },

      persistTheme: (id) => {
        const themeId = id ?? get().themeId;
        try {
          // Same envelope zustand/persist writes, so the two never diverge.
          const payload = JSON.stringify({
            state: { themeId, appearance: get().appearance },
            version: 0,
          });
          safeStorage.setItem(THEME_STORAGE_KEY, payload);
          writeModeMirror(get().appearance);
          return true;
        } catch {
          return false;
        }
      },

      applyTheme: (id) => {
        const themeId = validateThemeId(id) ?? get().themeId;
        set({ resolvedAppearance: applyResolvedTheme(themeId, get().appearance) });
      },

      validateTheme: (value) => validateThemeId(value),
      validateAppearance: (value) => validateAppearanceMode(value),
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ themeId: state.themeId, appearance: state.appearance }),
      /**
       * Runs on rehydrate. Everything arriving from storage is untrusted: a
       * wrong-shaped or unknown value must resolve to Command Pulse + System
       * instead of crashing the app.
       */
      merge: (persisted, current) => {
        const stored = (persisted ?? {}) as {
          themeId?: unknown;
          appearance?: unknown;
          mode?: unknown;
        };
        const themeId =
          validateThemeId(stored.themeId) ??
          themeIdFromLegacyMode(stored.mode) ??
          DEFAULT_THEME_ID;
        const appearance =
          validateAppearanceMode(stored.appearance) ??
          legacyAppearance(stored.mode) ??
          // The envelope may predate the appearance field; the plain-text
          // mirror (and then the default) fills the gap.
          readPersistedAppearance();
        return {
          ...current,
          ...(persisted as object | undefined),
          themeId,
          appearance,
          themes: THEME_LIST,
          resolvedAppearance: resolveAppearance(appearance),
        };
      },
    },
  ),
);

/**
 * Applied before React mounts. The guard in index.html does the same thing even
 * earlier (before the bundle), so the first paint already carries the restored
 * pair — no white flash, no wrong-theme flash, no dark-to-light flash.
 */
if (typeof window !== 'undefined') {
  const themeId = readPersistedThemeId();
  const appearance = readPersistedAppearance();
  useThemeStore.setState({
    themeId,
    appearance,
    resolvedAppearance: applyResolvedTheme(themeId, appearance),
  });
}

/**
 * The hook components use. It exposes the resolved pair (`theme` + `variant` +
 * `resolvedMode`) and keeps the historical names working:
 *
 *   const { theme, themeId, setTheme, appearance, setAppearance } = useTheme();
 *
 * `mode` / `setMode` / `resolved` are the legacy spellings. Note that
 * `resolved` now means `day | night` rather than `light | dark`, because the
 * appearance is no longer derived from the palette.
 */
export function useTheme() {
  const themeId = useThemeStore((s) => s.themeId);
  const theme = useThemeStore((s) => getTheme(s.themeId));
  const variant = useThemeStore((s) => getVariant(s.themeId, s.resolvedAppearance));
  const themes = useThemeStore((s) => s.themes);
  const setTheme = useThemeStore((s) => s.setTheme);
  const appearance = useThemeStore((s) => s.appearance);
  const resolvedAppearance = useThemeStore((s) => s.resolvedAppearance);
  const setAppearance = useThemeStore((s) => s.setAppearance);
  const setMode = useThemeStore((s) => s.setMode);
  const syncSystemAppearance = useThemeStore((s) => s.syncSystemAppearance);

  return {
    themeId,
    theme,
    themes,
    setTheme,
    /** Selected mode: `day` | `night` | `system`. */
    appearance,
    setAppearance,
    /** Tokens, effects and preview swatches for the resolved pair. */
    variant,
    /** True when the appearance follows the operating system. */
    isSystem: appearance === 'system',
    /** What is rendering: `day` | `night`. */
    resolvedMode: resolvedAppearance,
    /** Legacy alias of `resolvedMode`. */
    resolved: resolvedAppearance,
    /** Legacy alias of `appearance`. */
    mode: appearance,
    setMode,
    syncSystemAppearance,
    /** Selectable modes, so every selector lists the same three options. */
    modes: APPEARANCE_OPTIONS,
  };
}
