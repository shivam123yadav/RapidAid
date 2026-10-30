/**
 * RapidAid theme registry — the single catalogue of available themes.
 *
 * HOW TO ADD THEME #6
 *   1. Add `'my-new-theme'` to `ThemeId` (src/theme/types.ts).
 *   2. Add a `makeTheme({ id, name, description, day, night })` entry below.
 *   3. Add it to `THEME_LIST`.
 *   4. Add BOTH appearance blocks to src/index.css:
 *        [data-theme='my-new-theme'][data-appearance='day']   { … }
 *        [data-theme='my-new-theme'][data-appearance='night'] { … }
 *   5. Add its two base background colours to the flash-guard map in index.html.
 * No component, page, header, settings, chart or map change is required.
 *
 * The official palettes are the identity of RapidAid. Appearance mode
 * (day / night / system) only chooses which variant of a palette renders — it
 * never introduces another palette and never turns a theme into "generic
 * dark/light". Every palette ships an *intentional* Day and Night token set;
 * Day is never a programmatic inversion of Night.
 */

import type {
  AppearanceMode,
  ResolvedAppearance,
  ResolvedTheme,
  ThemeDefinition,
  ThemeEffects,
  ThemeId,
  ThemeTokens,
  ThemeVariant,
} from './types';
import {
  DEFAULT_APPEARANCE,
  appearanceLabel,
  resolveAppearance,
  validateAppearanceMode,
} from './mode';

/** Persistence key. Also read by the pre-mount flash guard in index.html. */
export const THEME_STORAGE_KEY = 'rapidaid-theme';

/** Safe fallback — used whenever storage is missing, blocked or corrupted. */
export const DEFAULT_THEME_ID: ThemeId = 'command-pulse';

/** Both appearances, in display order (Day first — it is the lighter default). */
export const APPEARANCES: ResolvedAppearance[] = ['day', 'night'];

interface VariantInput {
  tokens: ThemeTokens;
  /** Pure brand hue for the preview swatch (may differ from the panel-strength `tokens.secondary`). */
  brandSecondary: string;
  effects?: Partial<ThemeEffects>;
}

interface MakeThemeInput {
  id: ThemeId;
  name: string;
  description: string;
  /** Intentional light appearance for this palette. */
  day: VariantInput;
  /** Intentional dark appearance for this palette. */
  night: VariantInput;
}

const DEFAULT_EFFECTS: ThemeEffects = {
  surfaceStyle: 'solid',
  glow: false,
  glass: false,
  transitionMs: 200,
};

/**
 * Builds one theme × appearance variant and derives its preview swatches
 * straight from the tokens, so a preview can never drift from the real theme.
 */
function makeVariant(
  themeId: ThemeId,
  appearance: ResolvedAppearance,
  input: VariantInput,
): ThemeVariant {
  const { tokens } = input;
  return {
    themeId,
    appearance,
    tokens,
    effects: { ...DEFAULT_EFFECTS, ...input.effects },
    preview: {
      appearance,
      background: tokens.background,
      card: tokens.card,
      surface: tokens.surface,
      sidebar: tokens.sidebar,
      primary: tokens.primary,
      primarySoft: tokens.primarySoft,
      text: tokens.foreground,
      muted: tokens.mutedForeground,
      border: tokens.border,
      success: tokens.success,
      warning: tokens.warning,
      danger: tokens.danger,
      secondary: input.brandSecondary,
    },
  };
}

/** Builds a complete palette from its two appearances. */
function makeTheme(input: MakeThemeInput): ThemeDefinition {
  return {
    id: input.id,
    name: input.name,
    description: input.description,
    variants: {
      day: makeVariant(input.id, 'day', input.day),
      night: makeVariant(input.id, 'night', input.night),
    },
  };
}

/* ------------------------------------------------------------------ *
 * THEME 1 — COMMAND PULSE
 * Emergency command center + enterprise operations.
 *
 * Night: deep graphite/navy base, charcoal surfaces, electric blue accent,
 *        controlled crimson, emerald status.
 * Day:   very light cool-neutral base, white surfaces, the same electric
 *        blue identity, dark navy text. Recognisably the same product.
 * ------------------------------------------------------------------ */
const commandPulse = makeTheme({
  id: 'command-pulse',
  name: 'Command Pulse',
  description: 'Emergency command center',
  day: {
    brandSecondary: '#2563EB',
    tokens: {
      background: '#F4F6FA',
      foreground: '#0E1A2B',
      card: '#FFFFFF',
      cardForeground: '#0E1A2B',
      surface: '#E9EEF6',
      surfaceElevated: '#FFFFFF',
      sidebar: '#FFFFFF',
      primary: '#2563EB',
      primaryHover: '#1D4ED8',
      primarySoft: '#60A5FA',
      primaryForeground: '#FFFFFF',
      secondary: '#E2E8F0',
      secondaryForeground: '#334155',
      accent: 'rgba(37, 99, 235, 0.10)',
      accentForeground: '#1D4ED8',
      muted: '#E9EEF6',
      mutedForeground: '#55677F',
      success: '#047857',
      successForeground: '#FFFFFF',
      warning: '#B45309',
      warningForeground: '#FFFFFF',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#1D4ED8',
      infoForeground: '#FFFFFF',
      border: '#D7DFEA',
      input: '#D7DFEA',
      ring: '#2563EB',
      shadowCard: '0 1px 2px 0 rgba(15, 23, 42, 0.06)',
      shadowPop: '0 16px 40px -16px rgba(15, 23, 42, 0.22)',
      overlay: 'rgba(15, 23, 42, 0.42)',
      glass: '#FFFFFF',
      glassElevated: '#FFFFFF',
      glassBorder: 'rgba(15, 23, 42, 0.08)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'brightness(1.02) saturate(0.92)',
      chart1: '#2563EB',
      chart2: '#047857',
      chart3: '#B45309',
      chart4: '#DC2626',
      chart5: '#7C3AED',
      chart6: '#64748B',
    },
  },
  night: {
    brandSecondary: '#3B82F6',
    tokens: {
      background: '#0B1220',
      foreground: '#F8FAFC',
      card: '#111827',
      cardForeground: '#F8FAFC',
      surface: '#172033',
      surfaceElevated: '#1E2A42',
      sidebar: '#111827',
      primary: '#2563EB',
      primaryHover: '#1D4ED8',
      primarySoft: '#3B82F6',
      primaryForeground: '#FFFFFF',
      secondary: '#1B2537',
      secondaryForeground: '#E2E8F0',
      accent: 'rgba(37, 99, 235, 0.18)',
      accentForeground: '#93C5FD',
      muted: '#151E30',
      mutedForeground: '#94A3B8',
      success: '#10B981',
      successForeground: '#04211A',
      warning: '#F59E0B',
      warningForeground: '#1F1203',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#60A5FA',
      infoForeground: '#08131F',
      border: '#243047',
      input: '#243047',
      ring: '#3B82F6',
      shadowCard: '0 1px 2px 0 rgba(0, 0, 0, 0.5)',
      shadowPop: '0 16px 40px -12px rgba(0, 0, 0, 0.6)',
      overlay: 'rgba(2, 6, 23, 0.62)',
      glass: '#1E2A42',
      glassElevated: '#1E2A42',
      glassBorder: 'rgba(255, 255, 255, 0.06)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'brightness(0.72) contrast(1.15) saturate(0.85)',
      chart1: '#3B82F6',
      chart2: '#10B981',
      chart3: '#F59E0B',
      chart4: '#EF4444',
      chart5: '#A78BFA',
      chart6: '#94A3B8',
    },
  },
});

/* ------------------------------------------------------------------ *
 * THEME 2 — NORTHSTAR OS
 * Professional mission control + navigation. Calm, highly readable.
 *
 * Night: deep navy base, dark blue surfaces, arctic-blue primary,
 *        teal secondary, white text.
 * Day:   cool light-gray/white base, white surfaces, deep navy text,
 *        the same arctic blue and teal.
 * ------------------------------------------------------------------ */
const northstarOS = makeTheme({
  id: 'northstar-os',
  name: 'Northstar OS',
  description: 'Professional mission control',
  day: {
    brandSecondary: '#0F766E',
    tokens: {
      background: '#F2F6FA',
      foreground: '#0A1A2A',
      card: '#FFFFFF',
      cardForeground: '#0A1A2A',
      surface: '#E8EFF7',
      surfaceElevated: '#FFFFFF',
      sidebar: '#FFFFFF',
      primary: '#0369A1',
      primaryHover: '#075985',
      primarySoft: '#38BDF8',
      primaryForeground: '#FFFFFF',
      secondary: 'rgba(13, 148, 136, 0.12)',
      secondaryForeground: '#0F766E',
      accent: 'rgba(3, 105, 161, 0.10)',
      accentForeground: '#0369A1',
      muted: '#E8EFF7',
      mutedForeground: '#4F6377',
      success: '#15803D',
      successForeground: '#FFFFFF',
      warning: '#B45309',
      warningForeground: '#FFFFFF',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#0369A1',
      infoForeground: '#FFFFFF',
      border: '#D3DDE9',
      input: '#D3DDE9',
      ring: '#0284C7',
      shadowCard: '0 1px 2px 0 rgba(9, 23, 38, 0.06)',
      shadowPop: '0 16px 40px -16px rgba(9, 23, 38, 0.22)',
      overlay: 'rgba(9, 23, 38, 0.42)',
      glass: '#FFFFFF',
      glassElevated: '#FFFFFF',
      glassBorder: 'rgba(9, 23, 38, 0.08)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'brightness(1.02) saturate(0.92)',
      chart1: '#0369A1',
      chart2: '#0F766E',
      chart3: '#15803D',
      chart4: '#B45309',
      chart5: '#DC2626',
      chart6: '#64748B',
    },
  },
  night: {
    brandSecondary: '#14B8A6',
    tokens: {
      background: '#07111F',
      foreground: '#F8FAFC',
      card: '#0D1B2A',
      cardForeground: '#F8FAFC',
      surface: '#13263A',
      surfaceElevated: '#1A3149',
      sidebar: '#0D1B2A',
      primary: '#38BDF8',
      primaryHover: '#0EA5E9',
      primarySoft: '#7DD3FC',
      primaryForeground: '#06111D',
      secondary: 'rgba(20, 184, 166, 0.18)',
      secondaryForeground: '#5EEAD4',
      accent: 'rgba(56, 189, 248, 0.18)',
      accentForeground: '#7DD3FC',
      muted: '#0C1A29',
      mutedForeground: '#94A3B8',
      success: '#22C55E',
      successForeground: '#06180C',
      warning: '#F59E0B',
      warningForeground: '#1F1203',
      danger: '#EF4444',
      dangerForeground: '#1A0405',
      dangerHover: '#DC2626',
      info: '#38BDF8',
      infoForeground: '#06111D',
      border: '#1E3A52',
      input: '#1E3A52',
      ring: '#7DD3FC',
      shadowCard: '0 1px 2px 0 rgba(0, 0, 0, 0.5)',
      shadowPop: '0 16px 40px -12px rgba(0, 0, 0, 0.6)',
      overlay: 'rgba(3, 10, 24, 0.62)',
      glass: '#1A3149',
      glassElevated: '#1A3149',
      glassBorder: 'rgba(255, 255, 255, 0.06)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'brightness(0.72) contrast(1.15) saturate(0.85)',
      chart1: '#38BDF8',
      chart2: '#14B8A6',
      chart3: '#22C55E',
      chart4: '#F59E0B',
      chart5: '#EF4444',
      chart6: '#94A3B8',
    },
  },
});

/* ------------------------------------------------------------------ *
 * THEME 3 — AETHER COMMAND
 * AI + intelligent operations. Ice cyan with a restrained violet.
 *
 * Night: midnight navy, dark surfaces, ice cyan, subtle violet, soft glow —
 *        scoped to focus rings and active indicators only.
 * Day:   cool white/light-gray base, dark navy text, ice-cyan accents,
 *        restrained violet and NO glow, so the light appearance is never
 *        neon and the dark one is never cyberpunk.
 * ------------------------------------------------------------------ */
const aetherCommand = makeTheme({
  id: 'aether-command',
  name: 'Aether Command',
  description: 'AI command interface',
  day: {
    brandSecondary: '#6D28D9',
    tokens: {
      background: '#F3F6F9',
      foreground: '#0A1421',
      card: '#FFFFFF',
      cardForeground: '#0A1421',
      surface: '#E9EFF5',
      surfaceElevated: '#FFFFFF',
      sidebar: '#FFFFFF',
      primary: '#0E7490',
      primaryHover: '#155E75',
      primarySoft: '#22D3EE',
      primaryForeground: '#FFFFFF',
      secondary: 'rgba(109, 40, 217, 0.10)',
      secondaryForeground: '#6D28D9',
      accent: 'rgba(14, 116, 144, 0.10)',
      accentForeground: '#0E7490',
      muted: '#E9EFF5',
      mutedForeground: '#4C5F73',
      success: '#047857',
      successForeground: '#FFFFFF',
      warning: '#B45309',
      warningForeground: '#FFFFFF',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#0E7490',
      infoForeground: '#FFFFFF',
      border: '#D5DEE7',
      input: '#D5DEE7',
      ring: '#0E7490',
      shadowCard: '0 1px 2px 0 rgba(10, 20, 33, 0.06)',
      shadowPop: '0 16px 40px -16px rgba(10, 20, 33, 0.22)',
      overlay: 'rgba(10, 20, 33, 0.42)',
      glass: '#FFFFFF',
      glassElevated: '#FFFFFF',
      glassBorder: 'rgba(10, 20, 33, 0.08)',
      backdropBlur: 'none',
      /* No glow in daylight: `--glow` stays `none` and data-glow is 'off'. */
      glow: 'none',
      mapFilter: 'brightness(1.02) saturate(0.92)',
      chart1: '#0E7490',
      chart2: '#6D28D9',
      chart3: '#047857',
      chart4: '#B45309',
      chart5: '#DC2626',
      chart6: '#64748B',
    },
  },
  night: {
    brandSecondary: '#8B5CF6',
    effects: { glow: true, transitionMs: 220 },
    tokens: {
      background: '#070B14',
      foreground: '#F8FAFC',
      card: '#0D1320',
      cardForeground: '#F8FAFC',
      surface: '#151D2D',
      surfaceElevated: '#1C2537',
      sidebar: '#0D1320',
      primary: '#67E8F9',
      primaryHover: '#22D3EE',
      primarySoft: '#A5F3FC',
      primaryForeground: '#060A11',
      secondary: 'rgba(139, 92, 246, 0.20)',
      secondaryForeground: '#C4B5FD',
      accent: 'rgba(103, 232, 249, 0.16)',
      accentForeground: '#A5F3FC',
      muted: '#101828',
      mutedForeground: '#9CA3AF',
      success: '#34D399',
      successForeground: '#06110C',
      warning: '#FBBF24',
      warningForeground: '#1F1603',
      danger: '#F87171',
      dangerForeground: '#1A0606',
      dangerHover: '#EF4444',
      info: '#67E8F9',
      infoForeground: '#060A11',
      border: '#25304A',
      input: '#25304A',
      ring: '#A5F3FC',
      shadowCard: '0 1px 2px 0 rgba(0, 0, 0, 0.55)',
      shadowPop: '0 18px 44px -12px rgba(0, 0, 0, 0.65)',
      overlay: 'rgba(2, 4, 12, 0.66)',
      glass: '#1C2537',
      glassElevated: '#1C2537',
      glassBorder: 'rgba(103, 232, 249, 0.10)',
      backdropBlur: 'none',
      glow: '0 0 0 1px rgba(103, 232, 249, 0.28), 0 0 18px -6px rgba(103, 232, 249, 0.38)',
      mapFilter: 'brightness(0.68) contrast(1.18) saturate(0.8)',
      chart1: '#67E8F9',
      chart2: '#8B5CF6',
      chart3: '#34D399',
      chart4: '#FBBF24',
      chart5: '#F87171',
      chart6: '#9CA3AF',
    },
  },
});

/* ------------------------------------------------------------------ *
 * THEME 4 — RESCUE GLASS
 * Premium modern SaaS + polished emergency platform.
 *
 * Day:   cool off-white base, white surfaces, cobalt blue, cyan, subtle
 *        glass panels, dark text.
 * Night: deep navy base, dark surfaces, cobalt/blue primary, cyan
 *        secondary, light text, restrained glass.
 *
 * Glass is the only theme with real blur, and it is applied through the
 * opt-in `.glass-surface` / `.glass-elevated` helpers — elevated cards,
 * overlays, floating panels, navigation — never to every element. Structural
 * colours (background/surface/card) stay opaque in both appearances so body
 * copy is never see-through.
 * ------------------------------------------------------------------ */
const rescueGlass = makeTheme({
  id: 'rescue-glass',
  name: 'Rescue Glass',
  description: 'Premium response interface',
  day: {
    brandSecondary: '#06B6D4',
    effects: { surfaceStyle: 'glass', glass: true, transitionMs: 220 },
    tokens: {
      background: '#F4F7FB',
      foreground: '#0F172A',
      card: '#FFFFFF',
      cardForeground: '#0F172A',
      /* Cool-gray inset: distinct from the white card, so inset panels read. */
      surface: '#EEF4FB',
      surfaceElevated: 'rgba(255, 255, 255, 0.75)',
      sidebar: '#FFFFFF',
      primary: '#2563EB',
      primaryHover: '#1D4ED8',
      primarySoft: '#60A5FA',
      primaryForeground: '#FFFFFF',
      secondary: '#06B6D4',
      secondaryForeground: '#0F172A',
      accent: 'rgba(37, 99, 235, 0.10)',
      accentForeground: '#1D4ED8',
      muted: '#EEF2F8',
      mutedForeground: '#5B6B7F', /* #64748b measured 4.43:1 on the #F4F7FB base; darkened to clear WCAG AA */
      success: '#16A34A',
      successForeground: '#051F0D', /* #0a2e19 measured 4.49:1 on #16A34A; darkened to clear WCAG AA */
      warning: '#D97706',
      warningForeground: '#1E1002',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#2563EB',
      infoForeground: '#FFFFFF',
      border: '#DCE3EC',
      input: '#DCE3EC',
      ring: '#2563EB',
      shadowCard: '0 1px 2px 0 rgba(15, 23, 42, 0.08)',
      shadowPop: '0 16px 40px -16px rgba(15, 23, 42, 0.25)',
      overlay: 'rgba(15, 23, 42, 0.42)',
      glass: 'rgba(255, 255, 255, 0.65)',
      /* Elevated menus need more fill than decorative panels, otherwise a red
         action button behind the menu bleeds through and hurts contrast. */
      glassElevated: 'rgba(255, 255, 255, 0.88)',
      glassBorder: 'rgba(255, 255, 255, 0.75)',
      backdropBlur: 'blur(14px)',
      glow: 'none',
      mapFilter: 'none',
      chart1: '#2563EB',
      chart2: '#06B6D4',
      chart3: '#16A34A',
      chart4: '#D97706',
      chart5: '#DC2626',
      chart6: '#64748B',
    },
  },
  night: {
    brandSecondary: '#22D3EE',
    effects: { surfaceStyle: 'glass', glass: true, transitionMs: 220 },
    tokens: {
      background: '#0A1424',
      foreground: '#EFF5FC',
      card: '#101D31',
      cardForeground: '#EFF5FC',
      surface: '#16243B',
      surfaceElevated: '#1D2C47',
      sidebar: '#101D31',
      primary: '#2563EB',
      primaryHover: '#3B82F6',
      primarySoft: '#60A5FA',
      primaryForeground: '#FFFFFF',
      secondary: 'rgba(34, 211, 238, 0.16)',
      secondaryForeground: '#67E8F9',
      accent: 'rgba(59, 130, 246, 0.18)',
      accentForeground: '#93C5FD',
      muted: '#132136',
      mutedForeground: '#9DAEC5',
      success: '#22C55E',
      successForeground: '#05200F',
      warning: '#F59E0B',
      warningForeground: '#1F1203',
      danger: '#DC2626',
      dangerForeground: '#FFFFFF',
      dangerHover: '#B91C1C',
      info: '#38BDF8',
      infoForeground: '#06131F',
      border: '#26364C',
      input: '#26364C',
      ring: '#60A5FA',
      shadowCard: '0 1px 2px 0 rgba(0, 0, 0, 0.5)',
      shadowPop: '0 18px 44px -14px rgba(0, 0, 0, 0.7)',
      overlay: 'rgba(3, 9, 18, 0.62)',
      /* Restrained night glass: a dark translucent panel over blur(14px). */
      glass: 'rgba(20, 34, 56, 0.72)',
      glassElevated: 'rgba(18, 30, 50, 0.92)',
      glassBorder: 'rgba(148, 180, 220, 0.16)',
      backdropBlur: 'blur(14px)',
      glow: 'none',
      mapFilter: 'brightness(0.72) contrast(1.14) saturate(0.85)',
      chart1: '#3B82F6',
      chart2: '#22D3EE',
      chart3: '#22C55E',
      chart4: '#F59E0B',
      chart5: '#EF4444',
      chart6: '#94A3B8',
    },
  },
});

/* ------------------------------------------------------------------ *
 * THEME 5 — WARM IVORY
 * Calm, spacious operations on soft ivory and muted sand.
 *
 * Day:   warm ivory base, sand navigation rail, parchment cards, deep
 *        coffee text, muted olive-brown accent. Low-chroma status colours
 *        retain their fixed emergency meanings.
 * Night: deep espresso base with warm sand accents and light parchment
 *        text. An intentional dark companion — not an inversion.
 *
 * No glow, no gradients, no glass: structure comes from restrained borders
 * and shadows, matching the quiet reference aesthetic.
 * ------------------------------------------------------------------ */
const warmIvory = makeTheme({
  id: 'warm-ivory',
  name: 'Warm Ivory',
  description: 'Calm ivory operations',
  day: {
    brandSecondary: '#5B4A2F',
    tokens: {
      background: '#FFF9E9',
      foreground: '#342F25',
      card: '#F5EEDC',
      cardForeground: '#342F25',
      surface: '#F5EEDC',
      surfaceElevated: '#FFFDF4',
      sidebar: '#E1DAC5',
      primary: '#5B4A2F',
      primaryHover: '#473A24',
      primarySoft: '#9A8560',
      primaryForeground: '#FFFFFF',
      secondary: '#E1DAC5',
      secondaryForeground: '#4B4232',
      accent: 'rgba(91, 74, 47, 0.10)',
      accentForeground: '#5B4A2F',
      muted: '#EEE5D1',
      /* #756B57 measured 3.76:1 on the sand rail; darkened to clear WCAG AA. */
      mutedForeground: '#685E4B',
      success: '#2F6B4F',
      successForeground: '#FFFFFF',
      warning: '#A85B12',
      warningForeground: '#FFFFFF',
      danger: '#B3261E',
      dangerForeground: '#FFFFFF',
      dangerHover: '#941F18',
      info: '#3F5D7A',
      infoForeground: '#FFFFFF',
      border: '#D8CFB9',
      input: '#D8CFB9',
      ring: '#4F3E24',
      shadowCard: '0 1px 2px 0 rgba(52, 47, 37, 0.05)',
      shadowPop: '0 16px 40px -16px rgba(52, 47, 37, 0.20)',
      overlay: 'rgba(38, 32, 22, 0.45)',
      glass: '#F5EEDC',
      glassElevated: '#FFFDF4',
      glassBorder: 'rgba(52, 47, 37, 0.08)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'sepia(0.16) saturate(0.82) brightness(1.02)',
      chart1: '#5B4A2F',
      chart2: '#2F6B4F',
      chart3: '#A85B12',
      chart4: '#B3261E',
      chart5: '#4F5D78',
      chart6: '#7A6E57',
    },
  },
  night: {
    brandSecondary: '#D8C49A',
    tokens: {
      background: '#1B1812',
      foreground: '#F4EDDD',
      card: '#252016',
      cardForeground: '#F4EDDD',
      surface: '#2D271C',
      surfaceElevated: '#332C20',
      sidebar: '#221D15',
      primary: '#D8C49A',
      primaryHover: '#E6D4AB',
      primarySoft: '#B9A67F',
      primaryForeground: '#2A2215',
      secondary: '#3A3223',
      secondaryForeground: '#E3D5B8',
      accent: 'rgba(216, 196, 154, 0.14)',
      accentForeground: '#E8D9B7',
      muted: '#2F291E',
      mutedForeground: '#BDB29D',
      success: '#6FBF8F',
      successForeground: '#0A1F14',
      warning: '#E0A458',
      warningForeground: '#241506',
      danger: '#E57368',
      dangerForeground: '#260B08',
      dangerHover: '#CF5F55',
      info: '#9DB7D5',
      infoForeground: '#111A24',
      border: '#4A4234',
      input: '#4A4234',
      ring: '#E4D2A6',
      shadowCard: '0 1px 2px 0 rgba(0, 0, 0, 0.5)',
      shadowPop: '0 18px 44px -14px rgba(0, 0, 0, 0.66)',
      overlay: 'rgba(10, 8, 4, 0.66)',
      glass: '#252016',
      glassElevated: '#2C261B',
      glassBorder: 'rgba(244, 237, 221, 0.08)',
      backdropBlur: 'none',
      glow: 'none',
      mapFilter: 'sepia(0.2) brightness(0.7) contrast(1.08) saturate(0.78)',
      chart1: '#D8C49A',
      chart2: '#6FBF8F',
      chart3: '#E0A458',
      chart4: '#E57368',
      chart5: '#9DB7D5',
      chart6: '#C9BCA3',
    },
  },
});

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

export const THEMES: Record<ThemeId, ThemeDefinition> = {
  'command-pulse': commandPulse,
  'northstar-os': northstarOS,
  'aether-command': aetherCommand,
  'rescue-glass': rescueGlass,
  'warm-ivory': warmIvory,
};

/** Display order in the settings grid and the header popover. */
export const THEME_LIST: ThemeDefinition[] = [
  THEMES['command-pulse'],
  THEMES['northstar-os'],
  THEMES['aether-command'],
  THEMES['rescue-glass'],
  THEMES['warm-ivory'],
];

/** Every registered id — the list the flash guard in index.html mirrors. */
export const THEME_IDS: ThemeId[] = THEME_LIST.map((t) => t.id);

/**
 * Every theme × appearance combination (5 palettes × 2 appearances = 10).
 *
 * This is the unit of visual verification: contrast checks, previews and the
 * screenshot harness all iterate this list, so a Day variant nobody designed
 * cannot slip through unnoticed.
 */
export const THEME_VARIANTS: ThemeVariant[] = THEME_LIST.flatMap((theme) =>
  APPEARANCES.map((appearance) => theme.variants[appearance]),
);

/**
 * Type guard for anything reaching us from storage, the DOM or a user click.
 * An unknown or corrupted value returns `false` — it never throws.
 */
export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as string[]).includes(value);
}

/** Returns a valid theme id, or `null`. */
export function validateThemeId(value: unknown): ThemeId | null {
  return isThemeId(value) ? value : null;
}

/** Look up a theme. Unknown ids resolve to {@link DEFAULT_THEME_ID}. */
export function getTheme(id: unknown): ThemeDefinition {
  return THEMES[isThemeId(id) ? id : DEFAULT_THEME_ID];
}

/** The registered list (stable reference — safe as a React dependency). */
export function getThemes(): ThemeDefinition[] {
  return THEME_LIST;
}

/** Look up ONE appearance of one theme. Unknown input degrades safely. */
export function getVariant(id: unknown, appearance: ResolvedAppearance): ThemeVariant {
  return getTheme(id).variants[appearance === 'night' ? 'night' : 'day'];
}

/** `"Command Pulse · Night"` — for aria text and the current-value line. */
export function themeLabel(theme: ThemeDefinition, appearance: ResolvedAppearance): string {
  return `${theme.name} · ${appearanceLabel(appearance)}`;
}

/**
 * The heart of the model:
 *
 *     COLOR THEME + APPEARANCE MODE → RESOLVED THEME → CSS VARIABLES → UI
 *
 * Pure: it reads the media query only when the mode is `system`, and never
 * writes anything. Unknown ids and unknown modes degrade to the defaults
 * (Command Pulse + System) instead of throwing.
 *
 *   resolveTheme('aether-command', 'night')   → Aether Command, Night
 *   resolveTheme('rescue-glass', 'system')    → Rescue Glass, OS preference
 */
export function resolveTheme(
  id: unknown,
  mode: unknown = DEFAULT_APPEARANCE,
  prefersNight?: boolean,
): ResolvedTheme {
  const theme = getTheme(id);
  const safeMode = validateAppearanceMode(mode) ?? DEFAULT_APPEARANCE;
  const appearance = resolveAppearance(safeMode, prefersNight);
  const variant = theme.variants[appearance];
  return {
    theme,
    variant,
    mode: safeMode,
    appearance,
    label: themeLabel(theme, appearance),
  };
}
