import { useEffect, useRef, useState } from 'react';
import { useSettings } from './settings';
import { APPEARANCE_OPTIONS, THEME_OPTIONS } from './theme/themes';
import { subjectLabel } from './types';
import type { WebContext } from './session';

/**
 * The header account + settings menu, adapted from the SYW Apps shell's
 * HeaderMenu: a cog button opening a dropdown with the signed-in identity, the
 * appearance controls (color palette picker + light/dark/high-contrast mode),
 * and sign out. Native (no FontAwesome / ui-sdk) — closes on outside click / Esc.
 */
export function HeaderMenu(props: { ctx: WebContext; onSignOut: () => void }) {
  const { themeId, appearance, setThemeId, setAppearance } = useSettings();
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

  const who = subjectLabel(props.ctx.subject);
  const initial = who.charAt(0).toUpperCase();

  return (
    <div className="hmenu" ref={ref}>
      <button className={`hmenu-trigger ${open ? 'is-open' : ''}`} onClick={() => setOpen((o) => !o)} aria-label="Account & settings">
        <span className="avatar">{initial}</span>
        <span className="hmenu-who">{who}</span>
        {props.ctx.isAdmin && <span className="badge badge-accent">admin</span>}
        <span className="chevron">▾</span>
      </button>

      {open && (
        <div className="hmenu-pop" role="menu">
          <div className="hmenu-head">
            <span className="avatar avatar-lg">{initial}</span>
            <div className="cell-stack">
              <strong>{who}</strong>
              {props.ctx.subject.email && <span className="hint">{props.ctx.subject.email}</span>}
              <code className="subtle">{props.ctx.subject.issuer}:{props.ctx.subject.kind}</code>
            </div>
          </div>

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

          <div className="hmenu-foot">
            <button className="btn btn-ghost btn-sm" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
