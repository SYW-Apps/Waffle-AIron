import { useEffect, useRef, useState } from 'react';

/**
 * ThemeMenu — the compact palette + appearance picker used across SYW apps
 * (ported from the waffler_ui header menu): a dropdown trigger showing the
 * ACTIVE theme (swatch pill + name + description + chevron), a flyout panel
 * listing every theme with an optional "create custom theme" call-to-action,
 * and the appearance-mode segmented control directly beneath.
 *
 * Deliberately app-agnostic so it can be lifted into any app unchanged:
 * - Fully props-driven — no store, router, or theme-engine imports. The host
 *   app binds its own state (wairon: ThemeControls.tsx) and passes plain
 *   option/mode lists; `ThemeOption`/`APPEARANCE_OPTIONS` shapes fit
 *   structurally.
 * - Visuals come only from the `.tmenu-*` semantic classes (styled from the
 *   app's own tokens; wairon's block lives in theme.css under "Theme menu").
 *   Porting = copy this file + restyle that block from the target app's vars.
 * - `onCreateTheme` / `onManageThemes` are optional: omit them on surfaces
 *   where a theme-builder route is not reachable and those affordances vanish.
 */

export interface ThemeMenuOption {
  id: string;
  label: string;
  description?: string;
  /** Rendered as the option's swatch pill (typically primary/secondary/accent). */
  swatches: readonly string[];
}

export interface ThemeMenuMode {
  id: string;
  label: string;
  description?: string;
}

function SwatchPill({ swatches }: { swatches: readonly string[] }) {
  return (
    <span className="tmenu-pill">
      {swatches.map((c, i) => (
        <span key={`${i}-${c}`} style={{ background: c }} />
      ))}
    </span>
  );
}

export function ThemeMenu(props: {
  themeId: string;
  appearance: string;
  options: readonly ThemeMenuOption[];
  modes: readonly ThemeMenuMode[];
  onSelectTheme: (id: string) => void;
  onSelectMode: (id: string) => void;
  /** Renders the dashed CTA at the bottom of the flyout. */
  onCreateTheme?: () => void;
  /** Renders a small "Theme builder" link beside the section label. */
  onManageThemes?: () => void;
  label?: string;
  hint?: string;
}) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!pickerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = props.options.find((o) => o.id === props.themeId) ?? props.options[0];

  return (
    <div className="tmenu">
      <div className="tmenu-head">
        <span className="tmenu-label">{props.label ?? 'Appearance'}</span>
        {props.onManageThemes && (
          <button className="tmenu-manage" onClick={props.onManageThemes}>
            Theme builder ↗
          </button>
        )}
      </div>
      {props.hint && <span className="tmenu-hint">{props.hint}</span>}

      <div className="tmenu-picker" ref={pickerRef}>
        <button
          className={`tmenu-trigger ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {active && <SwatchPill swatches={active.swatches} />}
          <span className="tmenu-opt-text">
            <span className="tmenu-opt-name">{active?.label ?? '—'}</span>
            {active?.description && <span className="tmenu-opt-desc">{active.description}</span>}
          </span>
          <span className="tmenu-caret">▾</span>
        </button>

        {open && (
          <div className="tmenu-panel" role="listbox">
            {props.options.map((o) => (
              <button
                key={o.id}
                className={`tmenu-row ${o.id === props.themeId ? 'is-active' : ''}`}
                role="option"
                aria-selected={o.id === props.themeId}
                onClick={() => {
                  props.onSelectTheme(o.id);
                  setOpen(false);
                }}
              >
                <SwatchPill swatches={o.swatches} />
                <span className="tmenu-opt-text">
                  <span className="tmenu-opt-name">{o.label}</span>
                  {o.description && <span className="tmenu-opt-desc">{o.description}</span>}
                </span>
                {o.id === props.themeId && <span className="tmenu-check">✓</span>}
              </button>
            ))}
            {props.onCreateTheme && (
              <button
                className="tmenu-create"
                onClick={() => {
                  setOpen(false);
                  props.onCreateTheme?.();
                }}
              >
                Create custom theme
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tmenu-modes">
        {props.modes.map((m) => (
          <button
            key={m.id}
            className={`tmenu-mode ${m.id === props.appearance ? 'is-active' : ''}`}
            title={m.description}
            onClick={() => props.onSelectMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
    </div>
  );
}
