/**
 * Tiny WCAG contrast helper.
 *
 * Theme acceptance requires that text and controls stay readable in *every*
 * themes (§29). Token pairs are validated against this in the test suite, so a
 * future theme cannot silently ship an unreadable muted label or a badge whose
 * text disappears into its background.
 *
 * Pure functions, no dependencies — safe to import from anywhere.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const RGB =
  /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i;

/** Parses `#abc`, `#aabbcc`, `#aabbccdd`, `rgb()` and `rgba()`. Throws on unknown formats. */
export function parseColor(input: string): Rgb {
  const value = input.trim();

  const hex8 = HEX8.exec(value);
  if (hex8) {
    return {
      r: parseInt(hex8[1], 16),
      g: parseInt(hex8[2], 16),
      b: parseInt(hex8[3], 16),
      a: parseInt(hex8[4], 16) / 255,
    };
  }

  const hex6 = HEX6.exec(value);
  if (hex6) {
    return {
      r: parseInt(hex6[1], 16),
      g: parseInt(hex6[2], 16),
      b: parseInt(hex6[3], 16),
      a: 1,
    };
  }

  const hex3 = HEX3.exec(value);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
      a: 1,
    };
  }

  const rgb = RGB.exec(value);
  if (rgb) {
    return {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: rgb[4] === undefined ? 1 : Number(rgb[4]),
    };
  }

  throw new Error(`parseColor: unsupported colour "${input}"`);
}

/** Source-over composite of a possibly-translucent colour onto an opaque backdrop. */
export function flatten(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/**
 * WCAG contrast ratio between two colours (1–21). A translucent foreground is
 * composited onto the background first, exactly as the browser renders it.
 */
export function contrastRatio(foreground: string, background: string): number {
  const bg = parseColor(background);
  const fg = flatten(parseColor(foreground), bg.a < 1 ? { r: 255, g: 255, b: 255, a: 1 } : bg);
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

/** True when the pair clears WCAG AA (4.5:1 body, 3:1 for large/graphics). */
export function meetsAA(foreground: string, background: string, large = false): boolean {
  return contrastRatio(foreground, background) >= (large ? 3 : 4.5);
}
