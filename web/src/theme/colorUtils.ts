/**
 * Color math ported from the SYW Apps web shell (waffler_ui). Drives the
 * configurable theme engine: WCAG-aware contrast fixing, HSL rotation, and
 * mixing so a whole surface/text/border palette can be derived from one primary.
 */

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  return '#' + [clamp(r), clamp(g), clamp(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function getLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = [rgb.r, rgb.g, rgb.b].map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function getContrastRatio(a: string, b: string): number {
  const l1 = getLuminance(a);
  const l2 = getLuminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function rgbToHsl(r: number, g: number, b: number) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number) {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function rotateHex(hex: string, degrees: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const hue = ((((h * 360 + degrees) % 360) + 360) % 360) / 360;
  const out = hslToRgb(hue, s, l);
  return rgbToHex(out.r, out.g, out.b);
}

export function adjustLightness(hex: string, delta: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const out = hslToRgb(h, s, clamp01(l + delta));
  return rgbToHex(out.r, out.g, out.b);
}

export function mixHex(a: string, b: string, amount: number): string {
  const ra = hexToRgb(a);
  const rb = hexToRgb(b);
  if (!ra || !rb) return a;
  const w = clamp01(amount);
  return rgbToHex(ra.r * w + rb.r * (1 - w), ra.g * w + rb.g * (1 - w), ra.b * w + rb.b * (1 - w));
}

export function rgbaFromHex(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(255,255,255,${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

export function rgbTriplet(hex: string): string {
  const rgb = hexToRgb(hex);
  return rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : '34, 221, 255';
}

/** Parse a CSS color literal — #hex (3 or 6 digit), rgb()/rgba(), hsl()/hsla(). */
export function parseCssColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const raw = value.trim();
  const hex = raw.replace(/^#/, '');
  if (raw.startsWith('#') || /^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(hex)) {
    if (/^[0-9a-fA-F]{3}$/.test(hex)) {
      return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16), a: 1 };
    }
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    }
    return null;
  }
  const rgbMatch = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => Number(p.trim()));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    const a = parts[3] !== undefined && !Number.isNaN(parts[3]) ? Math.min(1, Math.max(0, parts[3])) : 1;
    const c = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
    return { r: c(parts[0]), g: c(parts[1]), b: c(parts[2]), a };
  }
  const hslMatch = raw.match(/^hsla?\(([^)]+)\)$/i);
  if (hslMatch) {
    const parts = hslMatch[1].split(',').map((p) => Number(p.trim().replace(/%$/, '')));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    const h = (((parts[0] % 360) + 360) % 360) / 360;
    const s = clamp01(parts[1] / 100);
    const l = clamp01(parts[2] / 100);
    const a = parts[3] !== undefined && !Number.isNaN(parts[3]) ? clamp01(parts[3]) : 1;
    const rgb = hslToRgb(h, s, l);
    return { ...rgb, a };
  }
  return null;
}

/** Collapse any parseable CSS color to opaque #rrggbb; `fallback` when it isn't one. */
export function colorToHex(value: string | undefined, fallback: string): string {
  const parsed = value ? parseCssColor(value) : null;
  return parsed ? rgbToHex(parsed.r, parsed.g, parsed.b) : fallback;
}

/** Iteratively lighten/darken `foreground` until it meets `targetRatio` against
 *  `background` (WCAG 2.1 AA), staying as close to the brand color as possible. */
export function findClosestAccessibleColor(foreground: string, background: string, targetRatio = 4.5): string {
  const rgb = hexToRgb(foreground);
  if (!rgb) return foreground;
  let { l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const { h, s } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  let hex = foreground;
  let ratio = getContrastRatio(hex, background);
  if (ratio >= targetRatio) return hex;
  const lighten = getLuminance(background) < 0.5;
  while (ratio < targetRatio && l > 0 && l < 1) {
    l += lighten ? 0.01 : -0.01;
    const out = hslToRgb(h, s, clamp01(l));
    hex = rgbToHex(out.r, out.g, out.b);
    ratio = getContrastRatio(hex, background);
  }
  return hex;
}
