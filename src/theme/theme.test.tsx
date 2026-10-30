import { useEffect, useState } from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { useThemeStore } from '../stores/theme';
import { useUIStore } from '../stores/ui';
import { ThemeSelector } from '../components/theme/ThemeSelector';
import { ThemeButton } from '../components/theme/ThemeButton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { contrastRatio } from './contrast';
import {
  APPEARANCES,
  DEFAULT_THEME_ID,
  THEME_IDS,
  THEME_LIST,
  THEME_STORAGE_KEY,
  THEME_VARIANTS,
  getTheme,
  getVariant,
  resolveTheme,
} from './registry';
import {
  APPEARANCE_IDS,
  APPEARANCE_OPTIONS,
  DEFAULT_APPEARANCE,
  MODE_STORAGE_KEY,
  appearanceLabel,
  resolveAppearance,
  systemPrefersNight,
  validateAppearanceMode,
  watchSystemAppearance,
} from './mode';
import type { AppearanceMode, ResolvedAppearance, ThemeId } from './types';

const AUTH_KEY = 'rapidaid-auth';

/** Puts the store, the DOM and storage back to a known state. */
function resetToDefault() {
  useThemeStore.setState({
    themeId: DEFAULT_THEME_ID,
    appearance: 'night',
    resolvedAppearance: 'night',
  });
  useUIStore.setState({ mapMode: 'standard', selectedEmergencyId: null });
  localStorage.removeItem(THEME_STORAGE_KEY);
  localStorage.removeItem(MODE_STORAGE_KEY);
  localStorage.removeItem(AUTH_KEY);
  document.documentElement.setAttribute('data-theme', DEFAULT_THEME_ID);
  document.documentElement.setAttribute('data-appearance', 'night');
  document.documentElement.setAttribute('data-glow', 'off');
  document.documentElement.classList.add('dark');
}

const appliedTheme = () => document.documentElement.getAttribute('data-theme');
const appliedAppearance = () => document.documentElement.getAttribute('data-appearance');

/**
 * Controllable `prefers-color-scheme` stand-in.
 *
 * System mode must be resolved from the REAL media query rather than a stored
 * boolean, so these tests drive a genuine `matchMedia` implementation (with
 * working add/removeEventListener) and then flip it, exactly like the OS would.
 */
function installMediaQuery(initialNight: boolean) {
  const listeners = new Set<() => void>();
  const original = window.matchMedia;
  let night = initialNight;

  const mql = (query: string) => ({
    matches: query.includes('prefers-color-scheme: dark') ? night : false,
    media: query,
    onchange: null,
    addEventListener: (_type: string, cb: () => void) => {
      listeners.add(cb);
    },
    removeEventListener: (_type: string, cb: () => void) => {
      listeners.delete(cb);
    },
    addListener: (cb: () => void) => {
      listeners.add(cb);
    },
    removeListener: (cb: () => void) => {
      listeners.delete(cb);
    },
    dispatchEvent: () => false,
  });

  Object.defineProperty(window, 'matchMedia', { writable: true, configurable: true, value: mql });

  return {
    /** Flips the OS preference and notifies subscribers, as a real change would. */
    setNight(next: boolean) {
      night = next;
      listeners.forEach((cb) => cb());
    },
    listenerCount: () => listeners.size,
    restore() {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: original,
      });
    },
  };
}

/**
 * Stand-in for every piece of state a *visual* change must never disturb: an
 * unsaved form field, an in-progress voice recording, and a mount counter that
 * would expose an unwanted remount.
 */
let sentinelMounts = 0;

function StateSentinel() {
  const [draft, setDraft] = useState('');
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    sentinelMounts += 1;
  }, []);

  return (
    <div>
      <input aria-label="unsaved draft" value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button type="button" onClick={() => setRecording((r) => !r)}>
        toggle recording
      </button>
      <output data-testid="recording">{String(recording)}</output>
    </div>
  );
}

function LocationSpy({ report }: { report: (path: string) => void }) {
  const location = useLocation();
  useEffect(() => {
    report(location.pathname);
  }, [location.pathname, report]);
  return null;
}

beforeEach(() => {
  resetToDefault();
  sentinelMounts = 0;
});

afterEach(() => {
  resetToDefault();
});

describe('theme registry and provider', () => {
  it('1. the theme provider loads and exposes the expected API', () => {
    const state = useThemeStore.getState();
    expect(state).toBeDefined();
    expect(typeof state.setTheme).toBe('function');
    expect(typeof state.setAppearance).toBe('function');
    expect(typeof state.setMode).toBe('function'); // legacy alias
    expect(typeof state.syncSystemAppearance).toBe('function');
    expect(typeof state.initTheme).toBe('function');
    expect(typeof state.restoreTheme).toBe('function');
    expect(typeof state.persistTheme).toBe('function');
    expect(typeof state.applyTheme).toBe('function');
    expect(typeof state.validateTheme).toBe('function');
    expect(typeof state.validateAppearance).toBe('function');
    expect(Array.isArray(state.themes)).toBe(true);
    // Defaults: Command Pulse identity, System appearance (never forced Night).
    expect(DEFAULT_THEME_ID).toBe('command-pulse');
    expect(DEFAULT_APPEARANCE).toBe('system');
    expect(state.validateAppearance('day')).toBe('day');
    expect(state.validateAppearance('nope')).toBeNull();
    expect(APPEARANCE_IDS).toEqual(['day', 'night', 'system']);
  });

  it('2. defaults to Command Pulse', () => {
    expect(DEFAULT_THEME_ID).toBe('command-pulse');
    expect(useThemeStore.getState().themeId).toBe('command-pulse');
    expect(appliedTheme()).toBe('command-pulse');
    // resetToDefault() pins an explicit appearance so the rest of the suite is
    // deterministic; the shipping default is System.
    expect(appliedAppearance()).toBe('night');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(useThemeStore.getState().resolvedAppearance).toBe('night');
  });

  it('3. registers exactly the five official themes, each with Day AND Night', () => {
    expect(THEME_IDS).toEqual([
      'command-pulse',
      'northstar-os',
      'aether-command',
      'rescue-glass',
      'warm-ivory',
    ]);
    expect(THEME_LIST).toHaveLength(5);
    expect(THEME_LIST.map((t) => t.name)).toEqual([
      'Command Pulse',
      'Northstar OS',
      'Aether Command',
      'Rescue Glass',
      'Warm Ivory',
    ]);

    for (const theme of THEME_LIST) {
      expect(theme.description).toBeTruthy();
      // Both appearances always exist and are fully tokenised.
      expect(Object.keys(theme.variants).sort()).toEqual(['day', 'night']);
      for (const appearance of APPEARANCES) {
        const variant = theme.variants[appearance];
        expect(variant.themeId).toBe(theme.id);
        expect(variant.appearance).toBe(appearance);
        expect(variant.tokens.background).toBeTruthy();
        expect(variant.tokens.primary).toBeTruthy();
        expect(variant.tokens.success).toBeTruthy();
        expect(variant.tokens.danger).toBeTruthy();
        expect(variant.preview.primary).toBe(variant.tokens.primary);
        expect(variant.preview.appearance).toBe(appearance);
        expect(variant.effects.transitionMs).toBeGreaterThanOrEqual(150);
        expect(variant.effects.transitionMs).toBeLessThanOrEqual(250);
      }
      // Day is an intentional light palette, not an inverted Night one.
      expect(theme.variants.day.tokens.background).not.toBe(theme.variants.night.tokens.background);
      expect(theme.variants.day.tokens.foreground).not.toBe(theme.variants.night.tokens.foreground);
    }

    // 5 palettes x 2 appearances = 10 verified variants.
    expect(THEME_VARIANTS).toHaveLength(10);
    expect(THEME_VARIANTS.filter((v) => v.appearance === 'day')).toHaveLength(5);
    expect(THEME_VARIANTS.filter((v) => v.appearance === 'night')).toHaveLength(5);
  });

  it('3c. Warm Ivory carries the approved ivory, sand and text tokens', () => {
    const theme = getTheme('warm-ivory');
    expect(theme.name).toBe('Warm Ivory');
    expect(theme.description).toBeTruthy();

    const day = theme.variants.day.tokens;
    // The supplied design values, exactly.
    expect(day.background).toBe('#FFF9E9');
    expect(day.sidebar).toBe('#E1DAC5');
    expect(day.card).toBe('#F5EEDC');
    expect(day.foreground).toBe('#342F25');
    expect(day.border).toBe('#D8CFB9');
    // The supplied secondary text was darkened only to clear WCAG AA on the
    // sand rail; the interactive accent and focus ring were chosen by contrast.
    expect(day.mutedForeground).toBe('#685E4B');
    expect(day.primary).toBe('#5B4A2F');
    expect(day.ring).toBe('#4F3E24');

    // Both appearances are intentional and fully tokenised.
    const night = theme.variants.night.tokens;
    expect(night.background).toBe('#1B1812');
    expect(night.sidebar).not.toBe(day.sidebar);
    expect(night.foreground).not.toBe(day.foreground);
    expect(night.sidebar).toBeTruthy();
    expect(night.ring).toBeTruthy();

    // Every existing palette still reuses its card as the navigation rail, so
    // adding the token changed nothing for them.
    for (const existing of ['command-pulse', 'northstar-os', 'aether-command', 'rescue-glass'] as const) {
      expect(getTheme(existing).variants.day.tokens.sidebar).toBe(
        getTheme(existing).variants.day.tokens.card,
      );
      expect(getTheme(existing).variants.night.tokens.sidebar).toBe(
        getTheme(existing).variants.night.tokens.card,
      );
    }
  });

  it('3a. resolveTheme pairs any palette with any mode (and degrades safely)', () => {
    expect(resolveTheme('aether-command', 'night').appearance).toBe('night');
    expect(resolveTheme('aether-command', 'night').label).toBe('Aether Command · Night');
    expect(resolveTheme('aether-command', 'day').appearance).toBe('day');
    expect(resolveTheme('aether-command', 'day').label).toBe('Aether Command · Day');
    expect(resolveTheme('aether-command', 'day').variant).toBe(
      getTheme('aether-command').variants.day,
    );

    // System follows the injected OS preference, never a stored flag.
    expect(resolveTheme('rescue-glass', 'system', true).appearance).toBe('night');
    expect(resolveTheme('rescue-glass', 'system', false).appearance).toBe('day');

    // Unknown theme id -> Command Pulse; unknown mode -> System.
    expect(resolveTheme('not-a-theme', 'not-a-mode').theme.id).toBe(DEFAULT_THEME_ID);
    expect(resolveTheme('not-a-theme', 'not-a-mode').mode).toBe('system');
    expect(getVariant('nope', 'night')).toBe(getTheme(DEFAULT_THEME_ID).variants.night);

    // Day and Night of the same palette share the palette identity (primary
    // hue family) while differing in surfaces — the point of two variants.
    for (const theme of THEME_LIST) {
      expect(theme.variants.day.tokens.card).not.toBe(theme.variants.night.tokens.card);
    }
  });

  it('4. setTheme applies a registered palette and keeps the appearance', () => {
    for (const id of THEME_IDS) {
      act(() => useThemeStore.getState().setTheme(id));
      expect(useThemeStore.getState().themeId).toBe(id);
      expect(appliedTheme()).toBe(id);
      // Changing the palette must never change the selected appearance.
      expect(useThemeStore.getState().appearance).toBe('night');
      expect(appliedAppearance()).toBe('night');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
      const variant = getVariant(id, 'night');
      expect(document.documentElement.getAttribute('data-glow')).toBe(
        variant.effects.glow ? 'on' : 'off',
      );
    }
  });

  it('4c. Day and Night switch tokens, .dark, color-scheme and the glow', () => {
    act(() => useThemeStore.getState().setTheme('aether-command'));
    expect(appliedAppearance()).toBe('night');
    expect(document.documentElement.getAttribute('data-glow')).toBe('on');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    act(() => useThemeStore.getState().setAppearance('day'));
    expect(useThemeStore.getState().appearance).toBe('day');
    expect(useThemeStore.getState().resolvedAppearance).toBe('day');
    expect(appliedAppearance()).toBe('day');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    // Aether Command Day is deliberately not neon, so the glow is switched off
    // for this variant only.
    expect(document.documentElement.getAttribute('data-glow')).toBe('off');
    expect(document.documentElement.style.colorScheme).toBe('light');
    expect(getTheme('aether-command').variants.day.tokens.glow).toBe('none');

    // Back to Night: the palette identity survives both directions.
    act(() => useThemeStore.getState().setAppearance('night'));
    expect(appliedTheme()).toBe('aether-command');
    expect(appliedAppearance()).toBe('night');
    expect(document.documentElement.getAttribute('data-glow')).toBe('on');
  });

  it('4b. setTheme ignores unknown ids instead of corrupting state', () => {
    act(() => useThemeStore.getState().setTheme('command-pulse'));
    act(() => useThemeStore.getState().setTheme('not-a-real-theme'));
    expect(useThemeStore.getState().themeId).toBe('command-pulse');
    expect(appliedTheme()).toBe('command-pulse');
    expect(useThemeStore.getState().validateTheme('nope')).toBeNull();
    expect(useThemeStore.getState().validateTheme('rescue-glass')).toBe('rescue-glass');
  });
});

describe('persistence and restoration', () => {
  it('6. persists the selected theme under rapidaid-theme', () => {
    act(() => useThemeStore.getState().setTheme('aether-command'));
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).state.themeId).toBe('aether-command');

    expect(useThemeStore.getState().persistTheme('rescue-glass')).toBe(true);
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) as string).state.themeId).toBe(
      'rescue-glass',
    );
  });

  it('6b. persists the appearance mode under rapidaid-mode as well', () => {
    act(() => useThemeStore.getState().setAppearance('day'));
    // Plain-text mirror, so index.html's guard needs no JSON parse.
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('day');
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) as string).state.appearance).toBe(
      'day',
    );

    act(() => useThemeStore.getState().setAppearance('system'));
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('system');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).not.toContain('{');

    act(() => useThemeStore.getState().setAppearance('night'));
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('night');
  });

  it('6c. persists and restores Warm Ivory through the existing mechanism', async () => {
    act(() => {
      useThemeStore.getState().setTheme('warm-ivory');
      useThemeStore.getState().setAppearance('day');
    });
    expect(JSON.parse(localStorage.getItem(THEME_STORAGE_KEY) as string).state).toMatchObject({
      themeId: 'warm-ivory',
      appearance: 'day',
    });
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('day');

    // Simulate a fresh boot: memory resets, storage survives, then rehydrate
    // and run the same restore path the app uses on startup. The envelope is
    // rewritten afterwards because setState itself persists the reset pair.
    const stored = localStorage.getItem(THEME_STORAGE_KEY) as string;
    act(() =>
      useThemeStore.setState({
        themeId: DEFAULT_THEME_ID,
        appearance: 'system',
        resolvedAppearance: 'night',
      }),
    );
    localStorage.setItem(THEME_STORAGE_KEY, stored);
    localStorage.setItem(MODE_STORAGE_KEY, 'day');
    await act(async () => {
      await useThemeStore.persist.rehydrate();
    });
    expect(useThemeStore.getState().themeId).toBe('warm-ivory');
    expect(useThemeStore.getState().appearance).toBe('day');

    act(() => {
      useThemeStore.getState().restoreTheme();
    });
    expect(appliedTheme()).toBe('warm-ivory');
    expect(appliedAppearance()).toBe('day');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('7. restores BOTH values after a reload', async () => {
    act(() => {
      useThemeStore.getState().setTheme('northstar-os');
      useThemeStore.getState().setAppearance('day');
    });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toContain('northstar-os');
    expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('day');

    // Simulate a fresh boot: in-memory state is fresh, storage survives.
    act(() =>
      useThemeStore.setState({
        themeId: DEFAULT_THEME_ID,
        appearance: 'system',
        resolvedAppearance: 'night',
      }),
    );
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ state: { themeId: 'northstar-os', appearance: 'day' }, version: 0 }),
    );
    localStorage.setItem(MODE_STORAGE_KEY, 'day');
    await act(async () => {
      await useThemeStore.persist.rehydrate();
    });
    expect(useThemeStore.getState().themeId).toBe('northstar-os');
    expect(useThemeStore.getState().appearance).toBe('day');

    // The real startup path (index.html guard + module load + ThemeInitializer).
    let restored: ThemeId | undefined;
    act(() => {
      restored = useThemeStore.getState().restoreTheme();
    });
    expect(restored).toBe('northstar-os');
    expect(appliedTheme()).toBe('northstar-os');
    expect(appliedAppearance()).toBe('day');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    // Mode-only restore: the plain-text mirror is enough on its own.
    localStorage.removeItem(THEME_STORAGE_KEY);
    localStorage.setItem(MODE_STORAGE_KEY, 'night');
    act(() => {
      useThemeStore.getState().restoreTheme();
    });
    expect(useThemeStore.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(useThemeStore.getState().appearance).toBe('night');
    expect(appliedAppearance()).toBe('night');
  });

  it('8. falls back safely when the stored values are invalid or corrupt', async () => {
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ state: { themeId: 'bogus-theme', appearance: 'bogus-mode' }, version: 0 }),
    );
    localStorage.setItem(MODE_STORAGE_KEY, 'not-a-mode');
    await act(async () => {
      await useThemeStore.persist.rehydrate();
    });
    expect(useThemeStore.getState().themeId).toBe(DEFAULT_THEME_ID);
    expect(appliedTheme()).toBe(DEFAULT_THEME_ID);
    // An invalid mode falls back to System, which resolves against the media
    // query rather than a stored value.
    expect(useThemeStore.getState().appearance).toBe('system');
    act(() => {
      useThemeStore.getState().restoreTheme();
    });
    expect(useThemeStore.getState().appearance).toBe('system');
    expect(appliedAppearance()).toBe(resolveAppearance('system', systemPrefersNight()));

    // Unparseable payload must not throw
    localStorage.setItem(THEME_STORAGE_KEY, '{{{ not json');
    localStorage.setItem(MODE_STORAGE_KEY, '{{{ not a mode');
    await act(async () => {
      await useThemeStore.persist.rehydrate();
    });
    expect(() => useThemeStore.getState().restoreTheme()).not.toThrow();
    expect(appliedTheme()).toBe(DEFAULT_THEME_ID);
    expect(validateAppearanceMode('{{{ not a mode')).toBeNull();

    // Wrong shape entirely
    localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({ hello: 'world' }));
    expect(useThemeStore.getState().restoreTheme()).toBe(DEFAULT_THEME_ID);
    expect(useThemeStore.getState().appearance).toBe('system');
    expect(appliedAppearance()).toBe('day'); // the jsdom stub reports a light OS
  });

  it('8b. still works when localStorage is unavailable', () => {
    const original = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: storage blocked');
      },
    });
    expect(() => useThemeStore.getState().setTheme('northstar-os')).not.toThrow();
    expect(useThemeStore.getState().themeId).toBe('northstar-os');
    expect(appliedTheme()).toBe('northstar-os');
    Object.defineProperty(window, 'localStorage', { configurable: true, value: original });
  });

  it('8c. maps a legacy light/dark/system payload onto a theme AND an appearance', () => {
    localStorage.removeItem(MODE_STORAGE_KEY);
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ state: { mode: 'light' }, version: 0 }),
    );
    expect(useThemeStore.getState().restoreTheme()).toBe('rescue-glass');
    expect(useThemeStore.getState().appearance).toBe('day');
    expect(appliedAppearance()).toBe('day');

    localStorage.removeItem(MODE_STORAGE_KEY);
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ state: { mode: 'dark' }, version: 0 }),
    );
    expect(useThemeStore.getState().restoreTheme()).toBe('command-pulse');
    expect(useThemeStore.getState().appearance).toBe('night');
    expect(appliedAppearance()).toBe('night');

    // A legacy "follow the OS" choice stays System and lands on the default
    // palette instead of silently pinning a light or dark look. The mirror is
    // cleared first so the (possibly stale) plain-text value cannot win over
    // the envelope being restored.
    localStorage.removeItem(MODE_STORAGE_KEY);
    localStorage.setItem(
      THEME_STORAGE_KEY,
      JSON.stringify({ state: { mode: 'system' }, version: 0 }),
    );
    expect(useThemeStore.getState().restoreTheme()).toBe(DEFAULT_THEME_ID);
    expect(useThemeStore.getState().appearance).toBe('system');
  });

  it('8d. accepts the legacy light/dark words on the setter too', () => {
    act(() => useThemeStore.getState().setAppearance('dark'));
    expect(useThemeStore.getState().appearance).toBe('night');
    act(() => useThemeStore.getState().setAppearance('light'));
    expect(useThemeStore.getState().appearance).toBe('day');
    // setMode is the legacy spelling of the same operation.
    act(() => useThemeStore.getState().setMode('system'));
    expect(useThemeStore.getState().appearance).toBe('system');
    // Unknown input degrades to System rather than throwing.
    expect(() => useThemeStore.getState().setAppearance('turbo')).not.toThrow();
    expect(useThemeStore.getState().appearance).toBe('system');
    // The palette is untouched by any of this.
    expect(useThemeStore.getState().themeId).toBe(DEFAULT_THEME_ID);
  });
});

/* ================================================================== *
 * System mode — resolved from the REAL media query, never a stored boolean.
 * ================================================================== */
describe('system appearance mode', () => {
  it('14. Light OS resolves to Day', () => {
    const mq = installMediaQuery(false);
    try {
      expect(systemPrefersNight()).toBe(false);
      act(() => useThemeStore.getState().setAppearance('system'));
      expect(useThemeStore.getState().appearance).toBe('system');
      expect(useThemeStore.getState().resolvedAppearance).toBe('day');
      expect(appliedAppearance()).toBe('day');
      expect(document.documentElement.classList.contains('dark')).toBe(false);
    } finally {
      mq.restore();
    }
  });

  it('15. Dark OS resolves to Night', () => {
    const mq = installMediaQuery(true);
    try {
      expect(systemPrefersNight()).toBe(true);
      act(() => useThemeStore.getState().setAppearance('system'));
      expect(useThemeStore.getState().resolvedAppearance).toBe('night');
      expect(appliedAppearance()).toBe('night');
      expect(document.documentElement.classList.contains('dark')).toBe(true);
    } finally {
      mq.restore();
    }
  });

  it('16. an OS change updates System mode live, without touching the selection', () => {
    const mq = installMediaQuery(true);
    try {
      act(() => {
        useThemeStore.getState().setTheme('aether-command');
        useThemeStore.getState().setAppearance('system');
      });
      expect(appliedAppearance()).toBe('night');
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('system');

      // The OS flips light -> dark while the app is open.
      act(() => mq.setNight(false));
      act(() => useThemeStore.getState().syncSystemAppearance());
      expect(useThemeStore.getState().appearance).toBe('system'); // selection untouched
      expect(useThemeStore.getState().themeId).toBe('aether-command');
      expect(appliedAppearance()).toBe('day');

      act(() => mq.setNight(true));
      act(() => useThemeStore.getState().syncSystemAppearance());
      expect(appliedAppearance()).toBe('night');
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('system');
    } finally {
      mq.restore();
    }
  });

  it('16b. watchSystemAppearance reports OS flips and unsubscribes cleanly', () => {
    const mq = installMediaQuery(false);
    try {
      const seen: boolean[] = [];
      const stop = watchSystemAppearance(() => seen.push(systemPrefersNight()));
      expect(mq.listenerCount()).toBe(1);

      mq.setNight(true);
      mq.setNight(false);
      expect(seen).toEqual([true, false]);

      stop();
      expect(mq.listenerCount()).toBe(0);
      mq.setNight(true);
      expect(seen).toEqual([true, false]); // no callbacks after unsubscribe
    } finally {
      mq.restore();
    }
  });

  it('16c. an explicit Day or Night choice ignores OS changes', () => {
    const mq = installMediaQuery(true);
    try {
      act(() => useThemeStore.getState().setAppearance('day'));
      mq.setNight(false);
      act(() => useThemeStore.getState().syncSystemAppearance());
      expect(useThemeStore.getState().appearance).toBe('day');
      expect(appliedAppearance()).toBe('day');

      act(() => useThemeStore.getState().setAppearance('night'));
      mq.setNight(false);
      act(() => useThemeStore.getState().syncSystemAppearance());
      expect(appliedAppearance()).toBe('night');
      expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe('night');
    } finally {
      mq.restore();
    }
  });
});

describe('header theme control', () => {
  it('9. opens a popover, lists all five themes and switches instantly', async () => {
    const user = userEvent.setup();
    render(<ThemeButton />);

    const trigger = screen.getByTestId('theme-button');
    expect(trigger).toHaveAccessibleName(/Appearance/);

    await user.click(trigger);
    const group = await screen.findByRole('radiogroup', { name: 'Quick theme switcher' });
    expect(within(group).getAllByRole('radio')).toHaveLength(5);
    // Warm Ivory is exposed alongside the four pre-existing palettes.
    expect(within(group).getByRole('radio', { name: /Warm Ivory/ })).toBeInTheDocument();
    // Current theme is shown before picking a new one.
    expect(screen.getByText(/Current:/)).toBeInTheDocument();

    await user.click(within(group).getByRole('radio', { name: /Northstar OS/ }));
    expect(useThemeStore.getState().themeId).toBe('northstar-os');
    expect(appliedTheme()).toBe('northstar-os');
    // Closes after selection so it never lingers over the page.
    expect(screen.queryByRole('radiogroup', { name: 'Quick theme switcher' })).not.toBeInTheDocument();
  });

  it('11. shows the selected theme as checked, not by colour alone', async () => {
    const user = userEvent.setup();
    render(<ThemeButton />);
    await user.click(screen.getByTestId('theme-button'));
    const group = await screen.findByRole('radiogroup', { name: 'Quick theme switcher' });

    const checked = within(group).getByRole('radio', { checked: true });
    expect(checked).toHaveAccessibleName(/Command Pulse/);
    expect(checked).toHaveAttribute('aria-checked', 'true');
    // Selection is conveyed by an icon + aria-checked, never by colour alone.
    expect(checked.querySelector('svg')).not.toBeNull();
  });

  it('13b. closes the popover on Escape', async () => {
    const user = userEvent.setup();
    render(<ThemeButton />);
    await user.click(screen.getByTestId('theme-button'));
    expect(await screen.findByRole('radiogroup', { name: 'Quick theme switcher' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('radiogroup', { name: 'Quick theme switcher' })).not.toBeInTheDocument();
    // Closing must not have changed the theme.
    expect(useThemeStore.getState().themeId).toBe('command-pulse');
  });
});

describe('settings appearance selector', () => {
  it('10. applies a theme on click with no Save step', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ThemeSelector />);
    const group = screen.getByRole('radiogroup', { name: 'RapidAid theme' });

    await user.click(within(group).getByRole('radio', { name: /Aether Command/ }));
    expect(useThemeStore.getState().themeId).toBe('aether-command');
    expect(appliedTheme()).toBe('aether-command');
    // Still on the same page — no navigation, no reload.
    expect(window.location.pathname).toBe('/');

    await user.click(within(group).getByRole('radio', { name: /Rescue Glass/ }));
    expect(useThemeStore.getState().themeId).toBe('rescue-glass');
    expect(appliedTheme()).toBe('rescue-glass');
    // Still on the same page — no navigation, no reload.
    expect(window.location.pathname).toBe('/');

    // A second click on the already-selected card is a no-op for the palette
    // while still leaving the application exactly where it was.
    await user.click(within(group).getByRole('radio', { name: /Rescue Glass/ }));
    expect(useThemeStore.getState().themeId).toBe('rescue-glass');
    expect(appliedTheme()).toBe('rescue-glass');
    // Palette and resolved appearance are orthogonal: switching themes must
    // not flip the (night) appearance the suite pinned in beforeEach.
    expect(appliedAppearance()).toBe('night');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    unmount();
  });

  it('10b. Warm Ivory is selectable in Settings and applies its identifier', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ThemeSelector />);
    const group = screen.getByRole('radiogroup', { name: 'RapidAid theme' });

    const ivory = within(group).getByRole('radio', { name: /Warm Ivory/ });
    expect(ivory).toBeInTheDocument();
    await user.click(ivory);

    expect(useThemeStore.getState().themeId).toBe('warm-ivory');
    expect(appliedTheme()).toBe('warm-ivory');
    // The existing appearance (night) is preserved by a palette change.
    expect(appliedAppearance()).toBe('night');
    expect(within(group).getByRole('radio', { checked: true })).toHaveAccessibleName(
      /Warm Ivory/,
    );

    act(() => useThemeStore.getState().setAppearance('day'));
    expect(appliedAppearance()).toBe('day');
    expect(document.documentElement.getAttribute('data-glow')).toBe('off');
    expect(document.documentElement.style.colorScheme).toBe('light');

    // The applied palette is exactly the one the registry exposes.
    const day = getVariant('warm-ivory', 'day').tokens;
    expect(day.background).toBe('#FFF9E9');
    expect(day.sidebar).toBe('#E1DAC5');
    expect(day.card).toBe('#F5EEDC');
    unmount();
  });

  it('11b. marks the selected card with aria-checked and a visible "Active" chip', () => {
    render(<ThemeSelector />);
    const group = screen.getByRole('radiogroup', { name: 'RapidAid theme' });
    const checked = within(group).getByRole('radio', { checked: true });
    expect(checked).toHaveAccessibleName(/Command Pulse/);
    expect(within(checked).getByText('Active')).toBeInTheDocument();
    expect(within(checked).getByText('Active').querySelector('svg')).not.toBeNull();

    const other = within(group).getByRole('radio', { checked: false, name: /Northstar OS/ });
    expect(within(other).queryByText('Active')).not.toBeInTheDocument();
    // The unselected card still names its palette and the live appearance, so
    // a screen-reader user hears the same Day/Night context as a sighted one.
    expect(other).toHaveAccessibleName(/Northstar OS/);
    expect(other).toHaveAccessibleName(/Night/);
  });

  it('12. supports roving-tabindex keyboard navigation', async () => {
    const user = userEvent.setup();
    render(<ThemeSelector />);

    const group = screen.getByRole('radiogroup', { name: 'RapidAid theme' });
    const first = within(group).getByRole('radio', { name: /Command Pulse/ });
    expect(first).toHaveAttribute('tabindex', '0');
    // Roving tabindex: exactly one theme card is reachable with Tab. (The
    // mode selector below is a *separate* radiogroup with its own stop.)
    expect(
      within(group).getAllByRole('radio').filter((el) => el.getAttribute('tabindex') === '0'),
    ).toHaveLength(1);
    first.focus();

    await user.keyboard('{ArrowDown}');
    expect(within(group).getByRole('radio', { checked: true })).toHaveAccessibleName(/Northstar OS/);
    expect(document.activeElement as HTMLElement).toHaveAccessibleName(/Northstar OS/);

    await user.keyboard('{End}');
    expect(within(group).getByRole('radio', { checked: true })).toHaveAccessibleName(/Warm Ivory/);
    expect(document.activeElement as HTMLElement).toHaveAccessibleName(/Warm Ivory/);

    await user.keyboard('{Home}');
    expect(within(group).getByRole('radio', { checked: true })).toHaveAccessibleName(/Command Pulse/);

    // Enter/Space are native button activation: they select the focused card.
    within(group).getByRole('radio', { name: /Aether Command/ }).focus();
    await user.keyboard('{Enter}');
    expect(useThemeStore.getState().themeId).toBe('aether-command');
  });

  it('20. the selector reflows to a single column on small screens', () => {
    render(<ThemeSelector />);
    const group = screen.getByRole('radiogroup', { name: 'RapidAid theme' });
    // One-column base grid, two columns from `sm` up.
    expect(group.className).toContain('grid-cols-1');
    expect(group.className).toContain('sm:grid-cols-2');
  });
});

/* ================================================================== *
 * 13–18. Theme switching must be presentation-only.
 * ================================================================== */
describe('theme switching is presentation only', () => {
  it('13–18. keeps route, forms, recordings, emergency/map state and auth intact', async () => {
    const user = userEvent.setup();

    // Establish real application state first.
    act(() => {
      useUIStore.getState().setMapMode('terrain');
      useUIStore.getState().setSelectedEmergencyId('EMG-42');
    });
    localStorage.setItem(
      AUTH_KEY,
      JSON.stringify({ state: { isAuthenticated: true, user: null }, version: 0 }),
    );
    const authBefore = localStorage.getItem(AUTH_KEY);
    let currentPath = '/emergencies';

    render(
      <MemoryRouter initialEntries={['/emergencies']}>
        <LocationSpy
          report={(p) => {
            currentPath = p;
          }}
        />
        <StateSentinel />
        <ThemeButton />
        <ThemeSelector />
      </MemoryRouter>,
    );

    // Unsaved form data + an in-progress "voice recording".
    await user.type(screen.getByLabelText('unsaved draft'), 'unsaved draft text');
    await user.click(screen.getByRole('button', { name: 'toggle recording' }));
    expect(screen.getByTestId('recording')).toHaveTextContent('true');
    expect(sentinelMounts).toBe(1);

    // Switch twice, through both entry points.
    await user.click(screen.getByRole('radio', { name: /Rescue Glass/ }));
    expect(useThemeStore.getState().themeId).toBe('rescue-glass');
    await user.click(screen.getByTestId('theme-button'));
    await user.click(
      within(await screen.findByRole('radiogroup', { name: 'Quick theme switcher' })).getByRole(
        'radio',
        { name: /Aether Command/ },
      ),
    );
    expect(useThemeStore.getState().themeId).toBe('aether-command');

    // 13. Route unchanged, window never navigated.
    expect(currentPath).toBe('/emergencies');
    expect(window.location.pathname).toBe('/');

    // 14 + 22. No remount, form data survives.
    expect(sentinelMounts).toBe(1);
    expect(screen.getByLabelText('unsaved draft')).toHaveValue('unsaved draft text');

    // 17. Voice recording state untouched.
    expect(screen.getByTestId('recording')).toHaveTextContent('true');

    // 16. Emergency state untouched.
    expect(useUIStore.getState().selectedEmergencyId).toBe('EMG-42');

    // 18. Map state untouched.
    expect(useUIStore.getState().mapMode).toBe('terrain');

    // 15. Not logged out; auth payload byte-identical.
    expect(localStorage.getItem(AUTH_KEY)).toBe(authBefore);
    expect(JSON.parse(localStorage.getItem(AUTH_KEY) as string).state.isAuthenticated).toBe(true);
  });
});

/* ================================================================== *
 * 19. Every theme renders the shared component surface.
 * ================================================================== */
function SharedComponentGallery() {
  return (
    <div>
      <Button>Default</Button>
      <Button variant="destructive">Destructive</Button>
      <Button variant="emergency">Emergency</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="secondary">Secondary</Button>
      <Button variant="ghost">Ghost</Button>
      <Badge variant="default">Active</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="success">Available</Badge>
      <Badge variant="warning">Pending</Badge>
      <Badge variant="info">Info</Badge>
      <Badge variant="critical">Critical</Badge>
      <Badge variant="outline">Outline</Badge>
      <Card>
        <CardHeader>
          <CardTitle>Hospital capacity</CardTitle>
        </CardHeader>
        <CardContent>
          <Input placeholder="Search" aria-label="search" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    </div>
  );
}

describe('all five themes render the shared components', () => {
  it('19. renders buttons, badges, cards, inputs and skeletons in each theme', () => {
    for (const id of THEME_IDS) {
      act(() => useThemeStore.getState().setTheme(id));
      const { unmount } = render(<SharedComponentGallery />);

      expect(appliedTheme()).toBe(id);
      expect(screen.getByRole('button', { name: 'Emergency' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Default' })).toBeInTheDocument();
      expect(screen.getByText('Available')).toBeInTheDocument();
      expect(screen.getByText('Pending')).toBeInTheDocument();
      expect(screen.getByText('Critical')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Hospital capacity')).toBeInTheDocument();
      expect(screen.getByLabelText('search')).toBeInTheDocument();

      // Semantic statuses keep their meaning in every theme.
      const success = screen.getByText('Available');
      expect(success.className).toContain('var(--success)');
      const warning = screen.getByText('Pending');
      expect(warning.className).toContain('var(--warning)');
      const critical = screen.getByText('Critical');
      expect(critical.className).toContain('var(--danger)');

      unmount();
    }
  });

  it('19b. Warm Ivory keeps severity labels alongside their colours', () => {
    act(() => useThemeStore.getState().setTheme('warm-ivory'));
    const { unmount } = render(<SharedComponentGallery />);

    // Emergency state is never colour-only: every badge still carries text.
    const critical = screen.getByText('Critical');
    expect(critical).toHaveTextContent('Critical');
    expect(critical.className).toContain('var(--danger)');
    expect(screen.getByText('Failed').className).toContain('var(--destructive)');
    expect(screen.getByText('Available').className).toContain('var(--success)');
    expect(screen.getByText('Pending').className).toContain('var(--warning)');
    expect(appliedTheme()).toBe('warm-ivory');
    unmount();
  });
});

/* ================================================================== *
 * 16/17/24. Map + chart compatibility and flash prevention.
 * ================================================================== */
const readProjectFile = (relative: string) => readFileSync(join(process.cwd(), relative), 'utf8');

describe('map and chart compatibility', () => {
  it('16. map logic is untouched — only tile pixels respond to the theme', () => {
    const map = readProjectFile('src/components/maps/CommandCenterMap.tsx');
    // Coordinates, markers and routing are unchanged.
    expect(map).toContain('const DELHI_CENTER: [number, number] = [28.6139, 77.2090];');
    expect(map).toContain('position={[emg.location.lat, emg.location.lng]}');
    expect(map).toContain(
      'positions={[[amb.location.lat, amb.location.lng], [emg.location.lat, emg.location.lng]]}',
    );
    // Marker colours stay fixed so status markers read the same in every theme.
    expect(map).toContain("createIcon('#dc2626'");
    expect(map).toContain("createIcon('#0ea5e9'");
    expect(map).toContain("createIcon('#16a34a'");

    const css = readProjectFile('src/index.css');
    expect(css).toContain('filter: var(--map-filter)');
    for (const theme of THEME_LIST) {
      expect(theme.variants.day.tokens.mapFilter).toBeTruthy();
      expect(theme.variants.night.tokens.mapFilter).toBeTruthy();
    }
  });

  it('17. chart colours come from tokens, not a hardcoded array', () => {
    const analytics = readProjectFile('src/pages/Analytics.tsx');
    expect(analytics).toContain("const COLORS = ['var(--chart-1)'");
    expect(analytics).not.toMatch(/const COLORS = \['#/);
    // Queries/aggregation untouched: the data keys are still present.
    expect(analytics).toContain('dataKey="count"');
    expect(analytics).toContain('dataKey="load"');
    for (const theme of THEME_LIST) {
      for (const key of ['chart1', 'chart2', 'chart3', 'chart4', 'chart5', 'chart6'] as const) {
        expect(theme.variants.day.tokens[key]).toBeTruthy();
        expect(theme.variants.night.tokens[key]).toBeTruthy();
      }
    }
  });
});

describe('flash prevention', () => {
  it('24. the pre-mount guard mirrors the registry and runs before React', () => {
    const html = readProjectFile('index.html');

    const idsMatch = html.match(/var IDS = \[([^\]]+)\]/);
    expect(idsMatch).not.toBeNull();
    const ids = (idsMatch as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''));
    expect(ids).toEqual(THEME_IDS);

    // Night is an appearance, not a palette property: every theme ships both
    // appearances, so the guard resolves each pair from its BG map instead of
    // a legacy per-theme dark list.
    for (const id of THEME_IDS) {
      expect(html).toContain(`\"${id}\": { \"day\":`);
    }

    expect(html).toContain("localStorage.getItem('rapidaid-theme')");
    expect(html).toContain("setAttribute('data-theme'");
    expect(html).toContain('backgroundColor');
    expect(html.indexOf('flash guard')).toBeLessThan(html.indexOf('/src/main.tsx'));

    // Warm Ivory's first paint matches its registry background.
    expect(html).toContain('"warm-ivory": { "day": "#fff9e9", "night": "#1b1812" }');
  });

  it('24b. Warm Ivory CSS mirrors the registry tokens and the rail token', () => {
    const css = readProjectFile('src/index.css');
    const expected = {
      day: getTheme('warm-ivory').variants.day.tokens,
      night: getTheme('warm-ivory').variants.night.tokens,
    } as const;

    for (const appearance of APPEARANCES) {
      const block =
        css.match(
          new RegExp(
            `\\[data-theme='warm-ivory'\\]\\[data-appearance='${appearance}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`,
          ),
        )?.[1] ?? '';
      expect(block).not.toBe('');

      const tokens = expected[appearance];
      for (const key of ['background', 'card', 'sidebar', 'foreground', 'border', 'primary', 'ring'] as const) {
        expect(block).toContain(`--${key === 'foreground' ? 'foreground' : key}: ${tokens[key].toLowerCase()};`);
      }
    }

    // One rail declaration per palette × appearance, plus the semantic alias.
    expect(css.match(/--sidebar:/g) ?? []).toHaveLength(THEME_LIST.length * 2);
    expect(css).toContain('--bg-sidebar: var(--sidebar)');
    expect(readProjectFile('src/components/layout/AppShell.tsx')).toContain(
      'bg-[var(--sidebar)]',
    );
  });
});

describe('contrast and semantic integrity', () => {
  it('29. every opaque token pair clears WCAG AA (4.5:1)', () => {
    const failures: string[] = [];

    for (const theme of THEME_LIST) {
      const t = theme.variants.day.tokens;
      const pairs: Array<[string, string, string]> = [
        ['foreground/background', t.foreground, t.background],
        ['foreground/card', t.foreground, t.card],
        ['foreground/surface', t.foreground, t.surface],
        ['foreground/sidebar', t.foreground, t.sidebar],
        ['cardForeground/card', t.cardForeground, t.card],
        ['mutedForeground/background', t.mutedForeground, t.background],
        ['mutedForeground/card', t.mutedForeground, t.card],
        ['mutedForeground/surface', t.mutedForeground, t.surface],
        ['mutedForeground/sidebar', t.mutedForeground, t.sidebar],
        ['primaryForeground/primary', t.primaryForeground, t.primary],
        ['successForeground/success', t.successForeground, t.success],
        ['warningForeground/warning', t.warningForeground, t.warning],
        ['dangerForeground/danger', t.dangerForeground, t.danger],
        ['infoForeground/info', t.infoForeground, t.info],
      ];

      for (const [label, fg, bg] of pairs) {
        const ratio = contrastRatio(fg, bg);
        if (ratio < 4.5) failures.push(`${theme.id} · ${label}: ${ratio.toFixed(2)}:1`);
      }
    }

    expect(failures).toEqual([]);
  });

  it('29b. Warm Ivory clears WCAG AA in both appearances, including the rail and focus ring', () => {
    for (const appearance of APPEARANCES) {
      const t = getVariant('warm-ivory', appearance).tokens;
      const surfaces = [t.background, t.card, t.surface, t.sidebar];

      for (const surface of surfaces) {
        expect(contrastRatio(t.foreground, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(t.mutedForeground, surface)).toBeGreaterThanOrEqual(4.5);
        // Focus indicators are non-text UI: WCAG requires at least 3:1.
        expect(contrastRatio(t.ring, surface)).toBeGreaterThanOrEqual(3);
      }

      expect(contrastRatio(t.primaryForeground, t.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.primary, t.background)).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of [
        [t.successForeground, t.success],
        [t.warningForeground, t.warning],
        [t.dangerForeground, t.danger],
        [t.infoForeground, t.info],
      ] as const) {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }

      // Severity stays distinguishable: four separate hues, danger stays red,
      // success stays green and warning stays amber.
      expect(new Set([t.danger, t.success, t.warning, t.info]).size).toBe(4);
      const rgb = (hex: string) => {
        const value = hex.replace('#', '');
        return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
      };
      const [dr, dg, db] = rgb(t.danger);
      const [sr, sg, sb] = rgb(t.success);
      const [wr, wg, wb] = rgb(t.warning);
      expect(dr).toBeGreaterThan(dg);
      expect(dr).toBeGreaterThan(db);
      expect(sg).toBeGreaterThan(sr);
      expect(sg).toBeGreaterThan(sb);
      expect(wr).toBeGreaterThan(wb);
      expect(wg).toBeGreaterThan(wb);
    }
  });

  it('3b. status colours keep their meaning across all five themes', () => {
    const rgb = (hex: string) => {
      const value = hex.replace('#', '');
      return [
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
      ];
    };

    for (const theme of THEME_LIST) {
      const t = theme.variants.day.tokens;
      const [dr, dg, db] = rgb(t.danger);
      const [sr, sg, sb] = rgb(t.success);
      const [wr, wg, wb] = rgb(t.warning);
      const [ir, , ib] = rgb(t.info);

      // danger red, success green, warning amber, info blue/cyan: a theme may
      // shift the shade, never the meaning.
      expect(dr).toBeGreaterThan(dg);
      expect(dr).toBeGreaterThan(db);
      expect(sg).toBeGreaterThan(sr);
      expect(sg).toBeGreaterThan(sb);
      expect(wr).toBeGreaterThan(wb);
      expect(wg).toBeGreaterThan(wb);
      expect(ib).toBeGreaterThanOrEqual(ir);

      expect(new Set([t.danger, t.success, t.warning, t.info]).size).toBe(4);
    }
  });
});

describe('no duplicate theme system', () => {
  it('33. there is exactly one theme store and one apply path', () => {
    const store = readProjectFile('src/stores/theme.ts');
    expect(store).toContain('export const useThemeStore');
    expect(store).toContain('export function useTheme');
    expect(store).toContain("root.setAttribute('data-theme', resolved.theme.id)");
    for (const file of ['src/App.tsx', 'src/main.tsx']) {
      const source = readProjectFile(file);
      expect(source).not.toContain('ThemeProvider2');
      expect(source).not.toContain('ThemeContext');
    }
  });
});

/* ================================================================== *
 * 34. Floating panels stay readable in every theme.
 * ================================================================== */
describe('overlay glass readability', () => {
  it('34. portalled overlays use the elevated glass token, never the decorative one', () => {
    const css = readProjectFile('src/index.css');

    // Exactly one elevated-glass declaration per registered theme × appearance.
    expect(css.match(/--glass-elevated:/g) ?? []).toHaveLength(THEME_LIST.length * 2);
    expect(css).toContain('.glass-elevated {');
    expect(css).toContain('background-color: var(--glass-elevated)');

    // The registry must expose the same token, so a preview can never show a
    // panel colour the real theme does not use.
    for (const theme of THEME_LIST) {
      expect(theme.variants.day.tokens.glassElevated).toBeTruthy();
      expect(theme.variants.night.tokens.glassElevated).toBeTruthy();
    }

    // A translucent panel lets the red Emergency button bleed through an open
    // theme menu and destroys label contrast, so overlays opt into the tougher
    // token while `.glass-surface` stays available for decoration.
    for (const file of [
      'src/components/theme/ThemeButton.tsx',
      'src/components/ui/dialog.tsx',
      'src/components/ui/select.tsx',
    ]) {
      const source = readProjectFile(file);
      expect(source).toContain('glass-elevated');
      expect(source).not.toContain('glass-surface');
    }
  });
});

