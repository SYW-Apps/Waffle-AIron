import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ThemeSections } from './ThemeControls';
import { subjectLabel } from './types';
import type { WebContext } from './session';

/**
 * The header account + settings menu, adapted from the SYW Apps shell's
 * HeaderMenu: a cog button opening a dropdown with the signed-in identity, the
 * appearance controls (color palette picker + light/dark/high-contrast mode),
 * and sign out. The surface is the DS `.syw-popover` (it holds forms, so it is a
 * popover, not an ARIA menu); it closes on outside click / Escape and Escape
 * returns focus to the trigger.
 */
export function HeaderMenu(props: { ctx: WebContext; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // The theme flyout is portaled to <body>: a click in it is still inside the menu.
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element).closest?.('.tmenu-panel')) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
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
      <button
        type="button"
        ref={triggerRef}
        className={`syw-button syw-button--ghost hmenu-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-label="Account & settings"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="avatar">{initial}</span>
        <span className="hmenu-who">{who}</span>
        {props.ctx.isAdmin && <span className="syw-chip badge badge-accent">admin</span>}
        <span className="chevron" aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="syw-popover hmenu-pop" role="group" aria-label="Account and settings">
          <div className="hmenu-head">
            <span className="avatar avatar-lg">{initial}</span>
            <div className="cell-stack">
              <strong>{who}</strong>
              {props.ctx.subject.email && <span className="hint">{props.ctx.subject.email}</span>}
              <code className="subtle">{props.ctx.subject.issuer}:{props.ctx.subject.kind}</code>
            </div>
          </div>

          <ThemeSections
            onOpenBuilder={() => {
              setOpen(false);
              navigate('/themes');
            }}
          />

          <div className="hmenu-foot">
            <button type="button" className="syw-button syw-button--ghost btn-sm" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
