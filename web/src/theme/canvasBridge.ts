import {
  deriveThemeVariables,
  getThemeOption,
  resolveMode,
  type AppearanceMode,
} from './themes';

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
  const v = deriveThemeVariables(getThemeOption(themeId).swatches[0], mode);
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
    // SYW globals the canvas CSS leans on: solid app background instead of the
    // deep-space gradient, and the app's shadow/glow/brand gradient.
    '--syw-bg': v['--wairon-page-bg'],
    '--syw-deep-space': 'none',
    '--syw-deep-shadow': v['--wairon-shadow'],
    '--syw-glow': v['--wairon-focus-ring'],
    '--syw-primary-gradient': v['--wairon-brand-text-bg'],
  };
}
