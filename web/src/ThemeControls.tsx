import { useEffect, useRef, useState } from 'react';
import { useSettings } from './settings';
import { APPEARANCE_OPTIONS, THEME_OPTIONS } from './theme/themes';

/**
 * The theme settings (color palette + appearance), extracted from HeaderMenu so
 * they are usable WITHOUT a signed-in session: settings are app-level
 * (localStorage-backed), not account state. `ThemeSections` renders the two
 * menu sections (HeaderMenu embeds them); `ThemeCog` is a standalone floating
 * cog + popover for chromeless surfaces (the sign-in screen, local dev mode).
 */
export function ThemeSections() {
  const { themeId, appearance, setThemeId, setAppearance } = useSettings();
  return (
    <>
      <div className="hmenu-section">
        <div className="hmenu-label">Color palette</div>
        <div className="theme-list">
          {THEME_OPTIONS.map((t) => (
            <button
              key={t.id}
              className={`theme-opt ${t.id === themeId ? 'is-active' : ''}`}
              onClick={() => setThemeId(t.id)}
            >
              <span className="swatches">
                {t.swatches.map((c) => (
                  <span key={c} style={{ background: c }} />
                ))}
              </span>
              <span className="cell-stack">
                <span className="theme-name">{t.label}</span>
                <span className="hint">{t.description}</span>
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
