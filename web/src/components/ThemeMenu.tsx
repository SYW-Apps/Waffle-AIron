import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { SywSegmented } from '@syw/design-react';

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
 * - Visuals come from the DS surfaces (`.syw-menu`, `.syw-segmented`,
 *   `.syw-button`) plus a few `.tmenu-*` layout classes (theme.css, "Theme menu").
 *   The menu follows the listbox pattern: opening focuses the active option,
 *   Arrow/Home/End move, Enter/Space select, Escape closes and returns focus.
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The flyout renders in a portal on <body> (position: fixed from the trigger's rect), so a scrolling or
  // clipping ancestor (the settings panel body) can never make it scroll or cut it off.
  const [pos, setPos] = useState<CSSProperties>({});

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pickerRef.current?.contains(t) && !panelRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Consume it: an enclosing modal <dialog> must not also treat it as its own.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom - 12;
      const above = r.top - 12;
      const flip = below < 220 && above > below;
      const room = Math.max(120, flip ? above : below);
      setPos({
        left: r.left,
        width: r.width,
        maxHeight: Math.min(320, room),
        ...(flip ? { bottom: window.innerHeight - r.top + 6 } : { top: r.bottom + 6 }),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Opening moves focus onto the active option (or the first), per listbox practice.
  useEffect(() => {
    if (!open) return;
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="option"]');
    const active = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    (active ?? rows?.[0])?.focus();
  }, [open]);

  function onListKey(e: ReactKeyboardEvent) {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const at = rows.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (at + 1) % rows.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + rows.length) % rows.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    if (next < 0) return;
    e.preventDefault();
    rows[next]?.focus();
  }

  const active = props.options.find((o) => o.id === props.themeId) ?? props.options[0];

  return (
    <div className="tmenu">
      <div className="tmenu-head">
        <span className="tmenu-label">{props.label ?? 'Appearance'}</span>
        {props.onManageThemes && (
          <button type="button" className="syw-button syw-button--ghost btn-sm tmenu-manage" onClick={props.onManageThemes}>
            Theme builder ↗
          </button>
        )}
      </div>
      {props.hint && <span className="tmenu-hint">{props.hint}</span>}

      <div className="tmenu-picker" ref={pickerRef}>
        <button
          type="button"
          ref={triggerRef}
          className={`syw-button tmenu-trigger ${open ? 'is-open' : ''}`}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={`Theme: ${active?.label ?? 'none'}`}
        >
          {active && <SwatchPill swatches={active.swatches} />}
          <span className="tmenu-opt-text">
            <span className="tmenu-opt-name">{active?.label ?? '—'}</span>
            {active?.description && <span className="tmenu-opt-desc">{active.description}</span>}
          </span>
          <span className="tmenu-caret" aria-hidden="true">▾</span>
        </button>

        {open &&
          createPortal(
          <div className="syw-menu tmenu-panel" ref={panelRef} style={pos}>
            <div role="listbox" aria-label="Themes" ref={listRef} onKeyDown={onListKey}>
              {props.options.map((o) => (
                <button
                  type="button"
                  key={o.id}
                  className={`syw-menu__item tmenu-row ${o.id === props.themeId ? 'is-active' : ''}`}
                  role="option"
                  aria-selected={o.id === props.themeId}
                  tabIndex={o.id === props.themeId ? 0 : -1}
                  onClick={() => {
                    props.onSelectTheme(o.id);
                    close(true);
                  }}
                >
                  <SwatchPill swatches={o.swatches} />
                  <span className="tmenu-opt-text">
                    <span className="tmenu-opt-name">{o.label}</span>
                    {o.description && <span className="tmenu-opt-desc">{o.description}</span>}
                  </span>
                  {o.id === props.themeId && <span className="tmenu-check" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
            {props.onCreateTheme && (
              <button
                type="button"
                className="syw-button tmenu-create"
                onClick={() => {
                  setOpen(false);
                  props.onCreateTheme?.();
                }}
              >
                Create custom theme
              </button>
            )}
          </div>,
          document.body,
        )}
      </div>

      <SywSegmented
        className="tmenu-modes"
        aria-label="Appearance mode"
        value={props.appearance}
        options={props.modes.map((m) => ({ value: m.id, label: m.label }))}
        onChange={(v) => props.onSelectMode(v)}
      />
    </div>
  );
}
