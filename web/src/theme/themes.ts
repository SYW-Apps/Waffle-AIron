import { adjustLightness, colorToHex, findClosestAccessibleColor, mixHex, rgbaFromHex, rgbTriplet, rotateHex } from './colorUtils';

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

/** Every `--wairon-*` variable the engine emits (the theme builder's editable surface). */
export const THEME_VARIABLE_NAMES = [
  '--wairon-page-bg',
  '--wairon-app-bg',
  '--wairon-panel-bg',
  '--wairon-panel-bg-strong',
  '--wairon-panel-bg-soft',
  '--wairon-panel-bg-hover',
  '--wairon-header-bg',
  '--wairon-sidebar-bg',
  '--wairon-menu-bg',
  '--wairon-section-bg',
  '--wairon-primary',
  '--wairon-primary-strong',
  '--wairon-primary-contrast',
  '--wairon-primary-rgb',
  '--wairon-secondary',
  '--wairon-secondary-rgb',
  '--wairon-accent',
  '--wairon-brand-text-bg',
  '--wairon-text',
  '--wairon-text-muted',
  '--wairon-text-subtle',
  '--wairon-text-inverse',
  '--wairon-border',
  '--wairon-border-strong',
  '--wairon-border-muted',
  '--wairon-shadow',
  '--wairon-shell-shadow',
  '--wairon-focus-ring',
  '--wairon-ok',
  '--wairon-warn',
  '--wairon-bad',
] as const;

export type ThemeVariableName = (typeof THEME_VARIABLE_NAMES)[number];
export type ThemeVariableMap = Partial<Record<ThemeVariableName, string>>;
export type ThemeModeVariableMap = Partial<Record<ResolvedMode, ThemeVariableMap>>;

export interface ThemeOption {
  id: string;
  label: string;
  description: string;
  /** swatches[0] is the primary the palette derives from. */
  swatches: [string, string, string];
  defaultMode: ResolvedMode;
}

/**
 * A user-authored theme (theme builder, persisted in localStorage). Where the
 * reference SYW builder stores a full computed-style snapshot and re-derives on
 * top of it, wairon's palette is 100% derived from the primary — so a custom
 * theme stores SPARSE overrides instead: resolution is derive(primary, mode) →
 * `variables` (all modes) → `modeVariables[mode]`. Every edit therefore wins
 * over derivation, and untouched tokens keep adapting per mode.
 */
export interface CustomTheme extends ThemeOption {
  custom: true;
  variables: ThemeVariableMap;
  modeVariables?: ThemeModeVariableMap;
}

export function isCustomTheme(theme: ThemeOption): theme is CustomTheme {
  return (theme as CustomTheme).custom === true;
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

/** Built-ins + the user's custom themes: the full picker list. */
export function buildThemeOptions(customThemes: CustomTheme[] = []): ThemeOption[] {
  return [...THEME_OPTIONS, ...customThemes];
}

export function getThemeOption(id: string, customThemes: CustomTheme[] = []): ThemeOption {
  return buildThemeOptions(customThemes).find((t) => t.id === id) ?? THEME_OPTIONS[0];
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
  // Light-mode borders use a neutral slate (a faint translucent primary is
  // invisible on a near-white surface, merging sidebar/header/content together).
  const border = light ? 'rgba(15, 23, 42, 0.16)' : hc ? '#ffffff' : rgbaFromHex(primary, 0.24);
  const borderStrong = light ? 'rgba(15, 23, 42, 0.34)' : hc ? '#ffffff' : rgbaFromHex(primary, 0.58);
  const borderMuted = light ? 'rgba(15, 23, 42, 0.10)' : hc ? 'rgba(255,255,255,0.46)' : 'rgba(148,163,184,0.16)';
  const shadow = hc ? 'none' : light ? `0 12px 28px rgba(15, 23, 42, 0.12)` : `0 14px 32px rgba(0,0,0,0.34)`;
  const shellShadow = hc ? '1px 0 0 #ffffff' : light ? `1px 0 0 rgba(15, 23, 42, 0.10)` : `1px 0 0 ${rgbaFromHex(primary, 0.16)}`;
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

/** The full variable map for a theme in a mode: derivation for built-ins, plus
 *  the sparse override layers for custom themes. The `-rgb` companions and the
 *  accessible primary-contrast are recomputed from the FINAL colors so direct
 *  edits of primary/secondary stay coherent. */
export function resolveThemeVariables(theme: ThemeOption, mode: ResolvedMode): Record<string, string> {
  if (!isCustomTheme(theme)) return deriveThemeVariables(theme.swatches[0], mode);
  const overrides: ThemeVariableMap = { ...theme.variables, ...(theme.modeVariables?.[mode] ?? {}) };
  const primary = colorToHex(overrides['--wairon-primary'] ?? theme.swatches[0], THEME_OPTIONS[0].swatches[0]);
  const vars: Record<string, string> = { ...deriveThemeVariables(primary, mode), ...overrides };
  vars['--wairon-primary-rgb'] = rgbTriplet(colorToHex(vars['--wairon-primary'], primary));
  vars['--wairon-secondary-rgb'] = rgbTriplet(colorToHex(vars['--wairon-secondary'], rotateHex(primary, 180)));
  if (!overrides['--wairon-primary-contrast']) {
    vars['--wairon-primary-contrast'] = findClosestAccessibleColor('#ffffff', colorToHex(vars['--wairon-primary'], primary), 4.5);
  }
  return vars;
}

/** Compute + apply a theme's variables to the document root and stamp data-mode. */
export function applyTheme(themeId: string, appearance: AppearanceMode, customThemes: CustomTheme[] = []): void {
  const theme = getThemeOption(themeId, customThemes);
  const mode = resolveMode(appearance);
  const vars = resolveThemeVariables(theme, mode);
  const root = document.documentElement;
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.mode = mode;
  root.dataset.theme = theme.id;
}

/* ── Custom-theme lifecycle (theme builder) ─────────────────────────────── */

export function generateCustomThemeId(): string {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `custom:${id}`;
}

/** Start a custom theme from any theme. Because built-ins are pure derivations
 *  of their primary swatch, seeding swatches (+ any existing overrides when the
 *  source is itself custom) reproduces the source look exactly — no
 *  computed-style snapshot needed (the reference builder's approach, which
 *  would freeze one mode's values across all modes). */
export function createCustomThemeFrom(source: ThemeOption, mode: ResolvedMode): CustomTheme {
  return normalizeCustomTheme({
    id: generateCustomThemeId(),
    label: `${source.label} Custom`,
    description: 'Locally stored custom palette.',
    swatches: [...source.swatches] as [string, string, string],
    defaultMode: mode,
    custom: true,
    variables: isCustomTheme(source) ? { ...source.variables } : {},
    modeVariables: isCustomTheme(source)
      ? (Object.fromEntries(
          Object.entries(source.modeVariables ?? {}).map(([m, v]) => [m, { ...v }]),
        ) as ThemeModeVariableMap)
      : {},
  });
}

export function createCustomThemeCopy(theme: CustomTheme): CustomTheme {
  return normalizeCustomTheme({
    ...theme,
    id: generateCustomThemeId(),
    label: `${theme.label} Copy`,
    swatches: [...theme.swatches] as [string, string, string],
    variables: { ...theme.variables },
    modeVariables: Object.fromEntries(
      Object.entries(theme.modeVariables ?? {}).map(([m, v]) => [m, { ...v }]),
    ) as ThemeModeVariableMap,
  });
}

const stripDerivedCompanions = (variables: ThemeVariableMap): ThemeVariableMap => {
  const next = { ...variables };
  // Auto-derived from their color at resolve time — never stored.
  delete next['--wairon-primary-rgb'];
  delete next['--wairon-secondary-rgb'];
  for (const key of Object.keys(next) as ThemeVariableName[]) {
    if (!next[key]) delete next[key];
  }
  return next;
};

/** Drop derived companions + empty values and re-sync swatches from the
 *  effective primary/secondary/accent so pickers and the canvas bridge follow
 *  edits automatically. */
export function normalizeCustomTheme(theme: CustomTheme): CustomTheme {
  const variables = stripDerivedCompanions(theme.variables ?? {});
  const primary = colorToHex(variables['--wairon-primary'] ?? theme.swatches?.[0], THEME_OPTIONS[0].swatches[0]);
  const swatches: [string, string, string] = [
    primary,
    colorToHex(variables['--wairon-secondary'], rotateHex(primary, 180)),
    colorToHex(variables['--wairon-accent'], rotateHex(primary, 120)),
  ];
  const modeVariables = Object.fromEntries(
    Object.entries(theme.modeVariables ?? {})
      .map(([m, v]) => [m, stripDerivedCompanions(v ?? {})])
      .filter(([, v]) => Object.keys(v as ThemeVariableMap).length > 0),
  ) as ThemeModeVariableMap;
  return { ...theme, custom: true, swatches, variables, modeVariables };
}

/** Tolerantly coerce a persisted (possibly hand-edited or stale) payload into a
 *  clean custom-theme list; anything unusable is silently dropped. */
export function sanitizeCustomThemes(value: unknown): CustomTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTheme[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<CustomTheme> & { variables?: unknown; modeVariables?: unknown };
    if (typeof raw.id !== 'string' || !raw.id.startsWith('custom:')) continue;
    const pickVars = (v: unknown): ThemeVariableMap => {
      if (!v || typeof v !== 'object') return {};
      const out: ThemeVariableMap = {};
      for (const name of THEME_VARIABLE_NAMES) {
        const val = (v as Record<string, unknown>)[name];
        if (typeof val === 'string' && val) out[name] = val;
      }
      return out;
    };
    const modeVariables: ThemeModeVariableMap = {};
    if (raw.modeVariables && typeof raw.modeVariables === 'object') {
      for (const m of ['light', 'dark', 'high-contrast'] as ResolvedMode[]) {
        const v = (raw.modeVariables as Record<string, unknown>)[m];
        if (v) modeVariables[m] = pickVars(v);
      }
    }
    const swatches = Array.isArray(raw.swatches) ? raw.swatches.filter((s): s is string => typeof s === 'string') : [];
    themes.push(
      normalizeCustomTheme({
        id: raw.id,
        label: typeof raw.label === 'string' && raw.label ? raw.label : 'Custom theme',
        description: typeof raw.description === 'string' ? raw.description : '',
        swatches: [swatches[0] ?? THEME_OPTIONS[0].swatches[0], swatches[1] ?? '', swatches[2] ?? ''],
        defaultMode:
          raw.defaultMode === 'light' || raw.defaultMode === 'dark' || raw.defaultMode === 'high-contrast'
            ? raw.defaultMode
            : 'dark',
        custom: true,
        variables: pickVars(raw.variables),
        modeVariables,
      }),
    );
  }
  return themes;
}
