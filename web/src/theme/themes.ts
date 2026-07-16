import { adjustLightness, findClosestAccessibleColor, mixHex, rgbaFromHex, rgbTriplet, rotateHex } from './colorUtils';

/**
 * Configurable theme engine adapted from the SYW Apps web shell. A theme is a
 * primary color + a set of appearance modes; the whole surface/text/border
 * palette is DERIVED from the primary per mode, so themes stay consistent and a
 * custom primary "just works". Emits `--wairon-*` shell variables (the app's own
 * namespace, distinct from the global `--syw-*` brand tokens). Trimmed to the
 * shell/app variables this app needs (no node-designer canvas vars).
 */

export type AppearanceMode = 'system' | 'light' | 'dark' | 'high-contrast';
export type ResolvedMode = Exclude<AppearanceMode, 'system'>;

export interface ThemeOption {
  id: string;
  label: string;
  description: string;
  /** swatches[0] is the primary the palette derives from. */
  swatches: [string, string, string];
  defaultMode: ResolvedMode;
}

export const THEME_OPTIONS: ThemeOption[] = [
  {
    id: 'waffler',
    label: 'Waffler',
    description: 'Cyan, violet, and pink brand palette.',
    swatches: ['#22ddff', '#8b5cf6', '#ec4899'],
    defaultMode: 'dark',
  },
  {
    id: 'syw-apps',
    label: 'SYW Apps',
    description: 'SYW blue with complementary accents.',
    swatches: ['#0256b8', '#02b864', '#b85f02'],
    defaultMode: 'dark',
  },
  {
    id: 'neutral',
    label: 'Neutral',
    description: 'Work-focused blue and gray.',
    swatches: ['#2563eb', '#111827', '#f9fafb'],
    defaultMode: 'light',
  },
];

export const APPEARANCE_OPTIONS: { id: AppearanceMode; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'high-contrast', label: 'Contrast' },
];

export const DEFAULT_THEME_ID = 'waffler';
export const DEFAULT_APPEARANCE: AppearanceMode = 'dark';

export function getThemeOption(id: string): ThemeOption {
  return THEME_OPTIONS.find((t) => t.id === id) ?? THEME_OPTIONS[0];
}

/** Resolve 'system' to the OS preference; other modes pass through. */
export function resolveMode(mode: AppearanceMode): ResolvedMode {
  if (mode !== 'system') return mode;
  const dark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  return dark ? 'dark' : 'light';
}

/** Derive the full `--waffler-*` shell palette from one primary + resolved mode. */
export function deriveThemeVariables(primary: string, mode: ResolvedMode): Record<string, string> {
  const hc = mode === 'high-contrast';
  const light = mode === 'light';
  const complement = rotateHex(primary, 180);
  const accent = rotateHex(primary, 120);

  const pageBg = light ? mixHex('#ffffff', primary, 0.965) : hc ? '#000000' : mixHex('#0b1120', primary, 0.94);
  const panelBg = light ? mixHex('#ffffff', primary, 0.985) : hc ? '#000000' : mixHex('#111827', primary, 0.92);
  const panelBgStrong = light ? mixHex('#f1f5f9', primary, 0.975) : hc ? '#050505' : mixHex('#0f172a', primary, 0.9);
  const panelBgSoft = light ? rgbaFromHex(primary, 0.055) : hc ? 'rgba(255,255,255,0.08)' : rgbaFromHex(primary, 0.08);
  const panelBgHover = light ? rgbaFromHex(primary, 0.085) : hc ? 'rgba(255,255,255,0.16)' : rgbaFromHex(primary, 0.12);
  const text = light ? '#111827' : '#f9fafb';
  const textMuted = light ? mixHex('#475569', primary, 0.88) : mixHex('#cbd5e1', primary, 0.95);
  const textSubtle = light ? mixHex('#64748b', primary, 0.82) : mixHex('#94a3b8', primary, 0.92);
  const border = light ? rgbaFromHex(primary, 0.18) : hc ? '#ffffff' : rgbaFromHex(primary, 0.24);
  const borderStrong = light ? rgbaFromHex(primary, 0.45) : hc ? '#ffffff' : rgbaFromHex(primary, 0.58);
  const borderMuted = light ? 'rgba(15,23,42,0.09)' : hc ? 'rgba(255,255,255,0.46)' : 'rgba(148,163,184,0.16)';
  const shadow = hc ? 'none' : light ? `0 12px 28px ${rgbaFromHex(primary, 0.12)}` : `0 14px 32px rgba(0,0,0,0.34)`;
  const shellShadow = hc ? '1px 0 0 #ffffff' : light ? `1px 0 0 ${rgbaFromHex(primary, 0.12)}` : `1px 0 0 ${rgbaFromHex(primary, 0.16)}`;
  const focusRing = hc ? '0 0 0 3px #ffffff' : `0 0 0 3px ${rgbaFromHex(primary, light ? 0.24 : 0.34)}`;

  return {
    '--wairon-page-bg': pageBg,
    '--wairon-app-bg': pageBg,
    '--wairon-panel-bg': panelBg,
    '--wairon-panel-bg-strong': panelBgStrong,
    '--wairon-panel-bg-soft': panelBgSoft,
    '--wairon-panel-bg-hover': panelBgHover,
    '--wairon-header-bg': light
      ? 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(241,245,249,0.98))'
      : hc
        ? '#000000'
        : `linear-gradient(135deg, ${panelBgStrong} 0%, ${panelBg} 100%)`,
    '--wairon-sidebar-bg': light
      ? 'linear-gradient(180deg, rgba(255,255,255,0.96), rgba(241,245,249,0.98))'
      : hc
        ? '#000000'
        : `linear-gradient(180deg, ${rgbaFromHex(primary, 0.12)} 0%, ${rgbaFromHex('#0b1120', 0.98)} 100%)`,
    '--wairon-menu-bg': light
      ? 'linear-gradient(135deg, #ffffff, #f8fafc)'
      : hc
        ? '#000000'
        : `linear-gradient(135deg, ${panelBgStrong}, ${panelBg})`,
    '--wairon-section-bg': `linear-gradient(135deg, ${rgbaFromHex(primary, light ? 0.08 : 0.1)}, ${rgbaFromHex(complement, light ? 0.08 : 0.1)})`,
    '--wairon-primary': primary,
    '--wairon-primary-strong': light ? adjustLightness(primary, -0.08) : adjustLightness(primary, 0.14),
    '--wairon-primary-contrast': findClosestAccessibleColor('#ffffff', primary, 4.5),
    '--wairon-primary-rgb': rgbTriplet(primary),
    '--wairon-secondary': complement,
    '--wairon-secondary-rgb': rgbTriplet(complement),
    '--wairon-accent': accent,
    '--wairon-brand-text-bg': `linear-gradient(135deg, ${primary} 0%, ${accent} 60%, ${complement} 100%)`,
    '--wairon-text': text,
    '--wairon-text-muted': textMuted,
    '--wairon-text-subtle': textSubtle,
    '--wairon-text-inverse': light ? '#ffffff' : '#0b1120',
    '--wairon-border': border,
    '--wairon-border-strong': borderStrong,
    '--wairon-border-muted': borderMuted,
    '--wairon-shadow': shadow,
    '--wairon-shell-shadow': shellShadow,
    '--wairon-focus-ring': focusRing,
    // Fixed semantic status colors (mode-agnostic, always legible).
    '--wairon-ok': '#34d399',
    '--wairon-warn': '#fbbf24',
    '--wairon-bad': '#f43f5e',
  };
}

/** Compute + apply a theme's variables to the document root and stamp data-mode. */
export function applyTheme(themeId: string, appearance: AppearanceMode): void {
  const theme = getThemeOption(themeId);
  const mode = resolveMode(appearance);
  const vars = deriveThemeVariables(theme.swatches[0], mode);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = mode;
  root.dataset.theme = themeId;
}
