/**
 * RapidAid theme system — public surface.
 *
 * UI code should import from here (`useTheme`, `getTheme`, `THEME_LIST`…),
 * never from a specific theme file, so future themes stay invisible to
 * consumers.
 */

export * from './types';
export * from './contrast';
export * from './mode';
export {
  APPEARANCES,
  DEFAULT_THEME_ID,
  THEMES,
  THEME_IDS,
  THEME_LIST,
  THEME_STORAGE_KEY,
  THEME_VARIANTS,
  getTheme,
  getThemes,
  getVariant,
  isThemeId,
  resolveTheme,
  themeLabel,
  validateThemeId,
} from './registry';
