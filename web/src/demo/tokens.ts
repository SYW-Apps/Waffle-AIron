import { APPEARANCE_TOKEN_KEYS, type EmbedMode } from './embed';
import type { CustomTheme } from '../theme/themes';

/**
 * Maps the framing page's design-system tokens onto the UI's own theme variables, so the UI
 * (whose theme engine already bridges --syw-*) follows the parent's appearance exactly. The
 * tokens become one custom theme whose overrides win over derivation; the --syw-* tokens
 * themselves are also set as sent, last, so nothing the bridge recomputes can drift from them.
 */

export const EMBED_THEME_ID = 'custom:embed';

/** The UI's `--wairon-*` variables the tokens fix. */
export function waironVariablesFromTokens(t: Record<string, string>): Record<string, string> {
  const v: Record<string, string> = {};
  const set = (name: string, value: string | undefined): void => {
    if (value) v[name] = value;
  };
  set('--wairon-page-bg', t['--syw-color-canvas']);
  set('--wairon-app-bg', t['--syw-color-canvas']);
  set('--wairon-panel-bg', t['--syw-color-surface']);
  set('--wairon-panel-bg-strong', t['--syw-color-surface-raised']);
  set('--wairon-header-bg', t['--syw-header-bg']);
  set('--wairon-sidebar-bg', t['--syw-header-bg']);
  set('--wairon-menu-bg', t['--syw-color-surface-raised']);
  set('--wairon-primary', t['--syw-color-primary']);
  set('--wairon-primary-strong', t['--syw-color-primary']);
  set('--wairon-primary-contrast', t['--syw-color-on-primary']);
  set('--wairon-secondary', t['--syw-color-secondary']);
  set('--wairon-accent', t['--syw-color-accent']);
  set('--wairon-brand-text-bg', t['--syw-gradient-primary']);
  set('--wairon-text', t['--syw-color-text']);
  set('--wairon-text-muted', t['--syw-color-text-muted']);
  set('--wairon-text-subtle', t['--syw-color-text-muted']);
  set('--wairon-border', t['--syw-color-line']);
  set('--wairon-border-strong', t['--syw-color-line-strong']);
  set('--wairon-border-muted', t['--syw-color-line']);
  set('--wairon-shadow', t['--syw-shadow-surface']);
  set('--wairon-ok', t['--syw-color-success']);
  set('--wairon-warn', t['--syw-color-warning']);
  set('--wairon-bad', t['--syw-color-danger']);
  return v;
}

/** The custom theme that carries the parent's tokens for one mode. */
export function themeFromTokens(tokens: Record<string, string>, mode: EmbedMode): CustomTheme {
  const primary = tokens['--syw-color-primary'] ?? '#22ddff';
  return {
    id: EMBED_THEME_ID,
    custom: true,
    label: 'Page',
    description: "The framing page's appearance",
    swatches: [primary, tokens['--syw-color-secondary'] ?? '#8b5cf6', tokens['--syw-color-accent'] ?? '#ec4899'],
    defaultMode: mode,
    variables: waironVariablesFromTokens(tokens) as CustomTheme['variables'],
  };
}

/** The --syw-* tokens to set exactly as sent (only the known ones). */
export function sywOverridesFromTokens(tokens: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of APPEARANCE_TOKEN_KEYS) if (tokens[key]) out[key] = tokens[key];
  return out;
}
