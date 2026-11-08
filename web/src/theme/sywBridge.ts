import { colorToHex, findClosestAccessibleColor } from './colorUtils';

/**
 * Bridge the app's theme engine ONTO the SYW Design System's semantic tokens.
 *
 * The engine (themes.ts) stays the source of truth: it derives the `--wairon-*`
 * palette from a primary + mode, with dynamic contrast and sparse custom-theme
 * overrides. The design system's components read `--syw-*` semantic tokens, so
 * after every (re)derivation the engine's FINAL values are mirrored onto those
 * tokens as inline style on <html> (inline beats the DS built-in theme
 * selectors, so the DS components follow the user's theme and mode exactly).
 * Nothing flows the other way: the DS never replaces the engine, and saved
 * custom themes are untouched.
 */

/** The `--syw-*` semantic tokens this bridge owns (so it can be inspected/tested). */
export const SYW_BRIDGED_TOKENS = [
  '--syw-color-canvas',
  '--syw-color-surface',
  '--syw-color-surface-raised',
  '--syw-color-text',
  '--syw-color-text-muted',
  '--syw-color-line',
  '--syw-color-line-strong',
  '--syw-color-primary',
  '--syw-color-secondary',
  '--syw-color-accent',
  '--syw-color-on-primary',
  '--syw-color-danger',
  '--syw-color-on-danger',
  '--syw-color-success',
  '--syw-color-warning',
  '--syw-gradient-primary',
  '--syw-shadow-surface',
  '--syw-shadow-elevated',
  '--syw-header-bg',
  '--syw-focus-ring',
] as const;

/** Map one resolved `--wairon-*` variable map onto the `--syw-*` tokens. */
export function sywTokensFromEngine(v: Record<string, string>): Record<(typeof SYW_BRIDGED_TOKENS)[number], string> {
  const bad = v['--wairon-bad'];
  return {
    '--syw-color-canvas': v['--wairon-page-bg'],
    '--syw-color-surface': v['--wairon-panel-bg'],
    // Opaque by construction (dialogs, menus, buttons sit on it).
    '--syw-color-surface-raised': v['--wairon-panel-bg-strong'],
    '--syw-color-text': v['--wairon-text'],
    '--syw-color-text-muted': v['--wairon-text-muted'],
    '--syw-color-line': v['--wairon-border'],
    '--syw-color-line-strong': v['--wairon-border-strong'],
    '--syw-color-primary': v['--wairon-primary'],
    '--syw-color-secondary': v['--wairon-secondary'],
    '--syw-color-accent': v['--wairon-accent'],
    '--syw-color-on-primary': v['--wairon-primary-contrast'],
    '--syw-color-danger': bad,
    // Re-measured against the real (possibly user-overridden) danger color.
    '--syw-color-on-danger': findClosestAccessibleColor('#ffffff', colorToHex(bad, '#f43f5e'), 4.5),
    '--syw-color-success': v['--wairon-ok'],
    '--syw-color-warning': v['--wairon-warn'],
    '--syw-gradient-primary': v['--wairon-brand-text-bg'],
    '--syw-shadow-surface': v['--wairon-shadow'],
    '--syw-shadow-elevated': v['--wairon-shadow'],
    '--syw-header-bg': v['--wairon-header-bg'],
    '--syw-focus-ring': v['--wairon-focus-ring'],
  };
}

/**
 * Apply the bridge plus the DS document attributes to <html>.
 *
 * - `data-mode`  is stamped by the engine (resolved: light | dark | high-contrast),
 *   exactly the DS's mode vocabulary; `data-theme` carries the app theme id (a
 *   DS built-in id for built-ins, `custom:…` otherwise — those match no DS theme
 *   block, which is why every semantic token is bridged inline).
 * - `data-density="compact"`: the product is a dense tool UI.
 * - `color-scheme` follows the resolved mode so native controls/scrollbars match.
 * Text size, font and motion keep the DS defaults (the app has no such choices).
 */
export function applySywBridge(vars: Record<string, string>, mode: 'light' | 'dark' | 'high-contrast'): void {
  const root = document.documentElement;
  for (const [k, value] of Object.entries(sywTokensFromEngine(vars))) {
    if (value) root.style.setProperty(k, value);
  }
  root.dataset.density = 'compact';
  root.style.colorScheme = mode === 'light' ? 'light' : 'dark';
}
