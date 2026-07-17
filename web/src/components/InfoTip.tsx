import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small "ⓘ" help affordance: hover (or focus) reveals a bubble; click pins it
 * open (touch-friendly). The bubble is portaled to <body> with fixed positioning
 * so it is NEVER clipped by an ancestor's overflow (e.g. a modal body's scroll)
 * and always stacks above the modal + backdrop. Used next to fields that need a
 * "what / how" note — e.g. how to create a git PAT.
 */
export function InfoTip(props: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const iconRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = open || pinned;

  function openNow() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    setOpen(true);
  }
  // A short grace period so moving the pointer from the icon into the bubble
  // (they don't touch — the bubble is portaled) doesn't dismiss it.
  function closeSoon() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  }

  // Anchor the fixed bubble under the icon, right-aligned, clamped to the viewport.
  useLayoutEffect(() => {
    if (!show || !iconRef.current) return;
    const place = () => {
      const el = iconRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 340;
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      setPos({ top: r.bottom + 8, left });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [show]);

  // A pinned bubble closes on Escape or a click outside the icon + bubble.
  useEffect(() => {
    if (!pinned) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setPinned(false);
        e.stopPropagation();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [pinned]);

  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);

  return (
    <span className="infotip">
      <button
        ref={iconRef}
        type="button"
        className="infotip-icon"
        aria-label={props.label ?? 'More information'}
        aria-expanded={show}
        onMouseEnter={openNow}
        onMouseLeave={closeSoon}
        onFocus={openNow}
        onBlur={closeSoon}
        onClick={(e) => {
          e.preventDefault();
          setPinned((p) => !p);
        }}
      >
        i
      </button>
      {show &&
        pos &&
        createPortal(
          <span
            className="infotip-bubble"
            role="tooltip"
            style={{ top: pos.top, left: pos.left }}
            onMouseEnter={openNow}
            onMouseLeave={closeSoon}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {props.children}
          </span>,
          document.body,
        )}
    </span>
  );
}
