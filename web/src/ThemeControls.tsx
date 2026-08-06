import { useEffect, useRef, useState } from 'react';
import { useSettings } from './settings';
import { APPEARANCE_OPTIONS, buildThemeOptions, createCustomThemeFrom, getThemeOption, resolveMode } from './theme/themes';

/**
 * The theme settings (color palette + appearance), extracted from HeaderMenu so
 * they are usable WITHOUT a signed-in session: settings are app-level
 * (localStorage-backed), not account state. `ThemeSections` renders the two
 * menu sections (HeaderMenu embeds them); `ThemeCog` is a standalone floating
 * cog + popover for chromeless surfaces (the sign-in screen, local dev mode).
 *
 * `onOpenBuilder` (optional) adds the custom-themes section: passed only where
 * the /themes route is reachable (the hosted shell), so the login screen and
 * local dev keep the picker-only popover while still listing saved customs.
 */
export function ThemeSections(props: { onOpenBuilder?: () => void }) {
  const { themeId, appearance, customThemes, setThemeId, setAppearance, setCustomThemes } = useSettings();
  const options = buildThemeOptions(customThemes);

  // Mirrors the reference shell's on-ramp: snapshot the active theme as a new
  // custom theme, activate it, and jump into the builder to edit it.
  const createFromActive = () => {
    const draft = createCustomThemeFrom(getThemeOption(themeId, customThemes), resolveMode(appearance));
    setCustomThemes([...customThemes, draft]);
    setThemeId(draft.id);
    props.onOpenBuilder?.();
  };

  return (
    <>
      <div className="hmenu-section">
        <div className="hmenu-label">Color palette</div>
        <div className="theme-list">
          {options.map((t) => (
            <button
              key={t.id}
              className={`theme-opt ${t.id === themeId ? 'is-active' : ''}`}
              onClick={() => setThemeId(t.id)}
            >
              <span className="swatches">
                {t.swatches.map((c, i) => (
                  <span key={`${i}-${c}`} style={{ background: c }} />
                ))}
              </span>
              <span className="cell-stack">
                <span className="theme-name">{t.label}</span>
                <span className="hint">{t.description || 'Custom theme'}</span>
              </span>
              {t.id === themeId && <span className="check">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="hmenu-section">
        <div className="hmenu-label">Appearance</div>
        <div className="seg">
          {APPEARANCE_OPTIONS.map((m) => (
            <button
              key={m.id}
              className={`seg-btn ${m.id === appearance ? 'is-active' : ''}`}
              onClick={() => setAppearance(m.id)}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {props.onOpenBuilder && (
        <div className="hmenu-section">
          <div className="hmenu-label">Custom themes</div>
          <div className="cell-inline">
            <button className="btn btn-ghost btn-sm" onClick={createFromActive}>
              ＋ Create custom theme
            </button>
            <button className="btn btn-ghost btn-sm" onClick={props.onOpenBuilder}>
              Theme builder
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export function ThemeCog() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="hmenu theme-cog" ref={ref}>
      <button
        className={`hmenu-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Theme settings"
        title="Theme settings"
      >
        <span className="cog">⚙</span>
      </button>
      {open && (
        <div className="hmenu-pop" role="menu">
          <ThemeSections />
        </div>
      )}
    </div>
  );
}
