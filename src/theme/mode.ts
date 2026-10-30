/**
 * ModeResolver — turns a user *preference* into a rendered *appearance*.
 *
 *     day    → day      (always light, ignoring the OS)
 *     night  → night    (always dark, ignoring the OS)
 *     system → day | night, from the real `prefers-color-scheme` media query
 *
 * System mode is genuinely derived from the browser media query — it is NOT a
 * stored boolean and it is never faked from a previous resolution. When the OS
 * flips while the app is open, {@link watchSystemAppearance} notifies the theme
 * store, which re-resolves and re-applies tokens. The user's saved selection is
 * never rewritten by that update.
 *
 * Pure + side-effect-free apart from the two `window` reads, which are fully
 * guarded, so this module is safe to import from tests and from the store.
 */

import type { AppearanceMode, ResolvedAppearance } from './types';

/** Plain-text mirror key. `rapidaid-theme` holds the full envelope; this holds
 *  just the mode, so the pre-paint guard in index.html can read it without a
 *  JSON parse. */
export const MODE_STORAGE_KEY = 'rapidaid-mode';

/** Default for a brand-new user: Command Pulse that follows the device. */
export const DEFAULT_APPEARANCE: AppearanceMode = 'system';

/** Every selectable mode, in display order. */
export const APPEARANCE_IDS: AppearanceMode[] = ['day', 'night', 'system'];

/** Metadata for the selectors, so Settings and the header cannot disagree. */
export interface AppearanceOption {
  id: AppearanceMode;
  /** Short label used in the segmented header control. */
  label: string;
  /** Explains what the mode does; shown on the Settings cards. */
  description: string;
}

export const APPEARANCE_OPTIONS: AppearanceOption[] = [
  { id: 'day', label: 'Day', description: 'Always light' },
  { id: 'night', label: 'Night', description: 'Always dark' },
  { id: 'system', label: 'System', description: "Match your device's setting" },
];

/** Type guard for anything from storage, the DOM or a click. Never throws. */
export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return typeof value === 'string' && (APPEARANCE_IDS as string[]).includes(value);
}

/** Returns a valid mode, or `null`. */
export function validateAppearanceMode(value: unknown): AppearanceMode | null {
  return isAppearanceMode(value) ? value : null;
}

/**
 * Maps values written by the pre-appearance `light | dark | system` control
 * (and by the old theme `mode` field, which stored `'light'`/`'dark'`) onto the
 * new vocabulary, so nobody loses their preference on upgrade.
 */
export function legacyAppearance(value: unknown): AppearanceMode | null {
  if (value === 'light') return 'day';
  if (value === 'dark') return 'night';
  if (value === 'system') return 'system';
  return null;
}

/** Label for a resolved appearance — used in aria text and the summary line. */
export function appearanceLabel(appearance: ResolvedAppearance): string {
  return appearance === 'night' ? 'Night' : 'Day';
}

/** True when the OS/browser currently prefers a dark appearance. */
export function systemPrefersNight(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * Resolves a selected mode into what actually renders.
 * `prefersNight` is injectable so tests can drive both OS states.
 */
export function resolveAppearance(
  mode: AppearanceMode,
  prefersNight: boolean = systemPrefersNight(),
): ResolvedAppearance {
  if (mode === 'day') return 'day';
  if (mode === 'night') return 'night';
  return prefersNight ? 'night' : 'day';
}

/**
 * Subscribes to OS appearance changes. Only meaningful when `mode === 'system'`
 * — the caller decides what to do, this just reports the flip.
 * Returns an unsubscribe function; a no-op when `matchMedia` is unavailable.
 */
export function watchSystemAppearance(listener: () => void): () => void {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    // `addEventListener` is the modern API; Safari < 14 only had addListener.
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    }
    const legacy = query as unknown as {
      addListener?: (cb: () => void) => void;
      removeListener?: (cb: () => void) => void;
    };
    legacy.addListener?.(listener);
    return () => legacy.removeListener?.(listener);
  } catch {
    return () => {};
  }
}
