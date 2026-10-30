/**
 * RapidAid theme system — type definitions.
 *
 * This module (and `registry.ts`) is deliberately **pure data**: no React, no
 * stores, no business logic. That keeps the theme system testable in
 * isolation and makes "add theme #6" a two-line change instead of a sweep
 * through the component tree.
 *
 * THEMES ARE PRESENTATION ONLY. Nothing in this folder may import auth, API,
 * map, dispatch, emergency or voice-report code — and nothing outside may let
 * a theme value influence behaviour.
 */

/**
 * What the user *chooses* in the Appearance control.
 *
 * This is a preference, not a colour: `system` defers to the operating system
 * and is resolved at render time (see `resolveAppearance` in `mode.ts`).
 */
export type AppearanceMode = 'day' | 'night' | 'system';

/**
 * What actually *renders* — the outcome of resolving an {@link AppearanceMode}.
 *
 * Every one of the five palettes ships an intentional variant for BOTH values,
 * so "Day" is never an inverted "Night": it is a deliberately designed light
 * token set with its own surfaces, borders, shadows and status shades.
 */
export type ResolvedAppearance = 'day' | 'night';

/**
 * Stable theme identifiers.
 *
 * NEVER branch on display names ("Command Pulse") — they are translatable and
 * may be reworded. Logic only ever sees these stable ids.
 */
export type ThemeId =
  | 'command-pulse'
  | 'northstar-os'
  | 'aether-command'
  | 'rescue-glass'
  | 'warm-ivory';

/**
 * Every semantic design token a theme must supply.
 *
 * Components consume these as CSS custom properties (`var(--primary)` …), so a
 * theme swap is a re-declaration of these values on `<html data-theme>` — no
 * component re-renders with different props, no route is touched, no state is
 * reset.
 *
 * Field name → CSS custom property (the CSS in src/index.css is the rendering
 * authority; these objects are the same values in JS, used for previews,
 * contrast validation and tests). Most map by camelCase → kebab-case, with two
 * deliberate legacy aliases kept because 90+ live components consume them:
 *
 *   danger            → --destructive        (dangerForeground → --destructive-foreground)
 *   surfaceElevated   → --surface-elevated
 *   sidebar           → --sidebar            (navigation rail; equals --card when
 *                                             the palette does not distinguish it)
 *   shadowCard        → --shadow-card        (also aliased as --shadow)
 *   glassElevated     → --glass-elevated
 *
 * The spec's semantic names (`--bg-primary`, `--text-primary`, `--success`,
 * `--focus-ring`…) are declared once as aliases in index.css, so they exist for
 * every theme + appearance combination without being repeated.
 */
export interface ThemeTokens {
  /** App background behind all content. */
  background: string;
  /** Primary body text on `background`. */
  foreground: string;

  /** Card / sidebar / dialog surface. */
  card: string;
  cardForeground: string;

  /** Inset panel sitting *on top of* a card (chips, inline stat blocks). */
  surface: string;
  /** Raised surface: portalled popovers, dropdowns, selected rows. */
  surfaceElevated: string;
  /**
   * Navigation rail background. Existing palettes reuse `card`; a palette may
   * choose a quieter secondary tone without changing card readability.
   */
  sidebar: string;

  /** Brand accent — buttons, active nav, links. */
  primary: string;
  /** Hover/pressed shade of `primary`. */
  primaryHover: string;
  /** Softer sibling of `primary` for halos and soft fills. */
  primarySoft: string;
  /** Text/icon colour that sits *on* `primary`. */
  primaryForeground: string;

  /** Secondary brand hue (per-theme: teal, violet, cobalt…). */
  secondary: string;
  secondaryForeground: string;

  /** Focus / hover tint. */
  accent: string;
  accentForeground: string;

  /** Neutral hover fill (rows, ghost buttons, skeletons). */
  muted: string;
  /** Secondary text — descriptions, timestamps, labels. */
  mutedForeground: string;

  /* ---- Semantic status tokens. MEANINGS ARE FIXED ACROSS ALL THEMES. ---- */
  /** success → Available / Completed / Healthy */
  success: string;
  successForeground: string;
  /** warning → Pending / Attention / Degraded */
  warning: string;
  warningForeground: string;
  /** danger → Emergency / Critical / Failed */
  danger: string;
  dangerForeground: string;
  dangerHover: string;
  /** info → informational, "active" state */
  info: string;
  infoForeground: string;

  border: string;
  input: string;
  ring: string;

  shadowCard: string;
  shadowPop: string;
  /** Scrim behind modals, drawers and the command palette. */
  overlay: string;

  /** Translucent panel colour (Rescue Glass). Solid themes reuse `card`. */
  glass: string;
  glassBorder: string;
  /**
   * Overlay-strength glass for portalled surfaces (popover, dropdown, dialog).
   * Tougher than `glass` so floating text stays readable over any content.
   */
  glassElevated: string;
  backdropBlur: string;

  /**
   * Subtle glow for *focused controls / active AI indicators / important status
   * only*. `none` for themes without a glow — never a neon wash over the app.
   */
  glow: string;

  /**
   * Cosmetic filter for map tiles so the canvas agrees with the theme.
   * This touches tile *pixels* only: coordinates, routing, markers, geocoding
   * and tracking are untouched.
   */
  mapFilter: string;

  /** Categorical palette for charts (index 1–6). */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
}

/** Per-theme behavioural effects that are still purely visual. */
export interface ThemeEffects {
  /**
   * Surface painting style. Decorative panels only — `glass` is opt-in and
   * used selectively (elevated cards, overlays, floating panels, navigation),
   * never for every element.
   */
  surfaceStyle: 'solid' | 'glass';
  /**
   * Subtle glow, per *variant*. Enabled only for Aether Command Night (AI
   * indicators, active controls, focused elements). Aether Command Day turns
   * it off so the light appearance never reads as neon, and the other three
   * palettes never glow at all.
   */
  glow: boolean;
  /** True for Rescue Glass Day and Night — restrained in Night. */
  glass: boolean;
  /** Root token transition duration. Honoured only when motion is allowed. */
  transitionMs: number;
}

/** Colour swatches used to draw a preview mini-mockup in the selector. */
export interface ThemePreview {
  /** Which appearance these swatches describe. */
  appearance: ResolvedAppearance;
  background: string;
  card: string;
  surface: string;
  sidebar: string;
  primary: string;
  primarySoft: string;
  text: string;
  muted: string;
  border: string;
  success: string;
  warning: string;
  danger: string;
  /** Pure brand secondary hue (may differ in intensity from `tokens.secondary`). */
  secondary: string;
}

/**
 * ONE appearance (Day or Night) of ONE palette: the tokens, the visual effects
 * and the preview swatches for that exact combination.
 *
 * This is the unit the CSS mirrors as `[data-theme='x'][data-appearance='y']`
 * and the unit every test validates, which is why a theme can never ship a
 * Day variant that nobody checked.
 */
export interface ThemeVariant {
  themeId: ThemeId;
  appearance: ResolvedAppearance;
  tokens: ThemeTokens;
  effects: ThemeEffects;
  preview: ThemePreview;
}

/**
 * A palette plus its identity metadata. The registered RapidAid palettes are
 * the only entries here; Day/Night/System never adds another palette, it
 * changes which variant of the chosen palette renders.
 */
export interface ThemeDefinition {
  /** Stable id — the only value ever used in logic or storage. */
  id: ThemeId;
  /** Human-readable name shown in the selector. */
  name: string;
  /** One-line description shown under the name. */
  description: string;
  /** Both appearances, always present, always intentional. */
  variants: Record<ResolvedAppearance, ThemeVariant>;
}

/**
 * The fully resolved combination that drives the DOM:
 *
 *     COLOR THEME + APPEARANCE MODE → ResolvedTheme → CSS VARIABLES → UI
 *
 * Exposed by `useTheme()` so no component ever has to combine the two values
 * itself (and therefore no component can get the combination wrong).
 */
export interface ResolvedTheme {
  theme: ThemeDefinition;
  variant: ThemeVariant;
  /** What the user selected — may be `system`. */
  mode: AppearanceMode;
  /** What is actually rendering. */
  appearance: ResolvedAppearance;
  /** e.g. `"Command Pulse · Night"` — for aria-labels and the current-value line. */
  label: string;
}
