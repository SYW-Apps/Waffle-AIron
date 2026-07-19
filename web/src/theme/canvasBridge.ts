import {
  deriveThemeVariables,
  getThemeOption,
  resolveMode,
  type AppearanceMode,
} from './themes';
import { mixHex } from './colorUtils';

/**
 * Bridge the app's SYW theme engine onto the classic canvas engine: the app
 * derives its whole `--wairon-*` palette from one primary + appearance mode;
 * the canvas chrome reads its own small var surface (`--bg`, `--chrome`,
 * `--accent`, …). Mapping the former onto the latter (passed as
 * `mountCanvas(..., { vars })`) makes the canvas follow the SELECTED app theme
 * — palette included — the same way it already followed light/dark. The
 * cytoscape CONTENT keeps its semantic per-stereotype light/dark palettes
 * (those colors mean things); only the chrome re-palettes.
 *
 * Hand-written — not part of the generated engine output.
 */

/** The engine's base data-theme for an app appearance: its light theme for
 *  light, its dark ('syw') theme otherwise (high-contrast rides dark). */
export function engineTheme(appearance: AppearanceMode): 'light' | 'syw' {
  return resolveMode(appearance) === 'light' ? 'light' : 'syw';
}

/** The CSS custom-property overlay themeing the canvas chrome to the app's
 *  active palette + appearance. */
export function engineVars(themeId: string, appearance: AppearanceMode): Record<string, string> {
  const mode = resolveMode(appearance);
  const theme = getThemeOption(themeId);
  const primary = theme.swatches[0];
  const v = deriveThemeVariables(primary, mode);
  // The classic canvas keeps its "deep space" GRADIENT background in dark
  // mode, re-derived strictly from the theme's OWN swatches (a hue rotation
  // drifted off-palette — reddish on non-Waffler themes): a whiff of the
  // primary at the start ramping into the secondary swatch, both sunk into the
  // dark base. Waffler reproduces the classic slate→indigo feel; Neutral's
  // near-dark secondary yields a deliberately quiet, almost-flat space. Light
  // mode is solid (matching the classic light theme); high contrast stays
  // pure black (max contrast beats atmosphere).
  const secondary = theme.swatches[1];
  const deepSpace =
    mode === 'light' || mode === 'high-contrast'
      ? 'none'
      : `linear-gradient(135deg, ${mixHex('#0b1120', primary, 0.95)} 0%, ${mixHex('#0b1120', secondary, 0.85)} 50%, ${mixHex('#0b1120', secondary, 0.7)} 100%)`;
  return {
    '--bg': v['--wairon-page-bg'],
    '--chrome': v['--wairon-panel-bg'],
    '--chrome-border': v['--wairon-border'],
    '--ink': v['--wairon-text'],
    '--dim': v['--wairon-text-muted'],
    '--line': v['--wairon-border-muted'],
    '--input-bg': v['--wairon-panel-bg-soft'],
    '--hover-bg': v['--wairon-panel-bg-hover'],
    '--accent': v['--wairon-primary'],
    '--card': v['--wairon-panel-bg-soft'],
    '--danger': v['--wairon-bad'],
    '--warn': v['--wairon-warn'],
    // SYW globals the canvas CSS leans on: the theme-derived deep-space
    // gradient (dark modes) and the app's shadow/glow/brand gradient.
    '--syw-bg': v['--wairon-page-bg'],
    '--syw-deep-space': deepSpace,
    '--syw-deep-shadow': v['--wairon-shadow'],
    '--syw-glow': v['--wairon-focus-ring'],
    '--syw-primary-gradient': v['--wairon-brand-text-bg'],
  };
}
