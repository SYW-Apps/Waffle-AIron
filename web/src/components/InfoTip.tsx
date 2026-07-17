import { useState, type ReactNode } from 'react';

/**
 * A small "ⓘ" help affordance: hover (or focus) reveals a bubble; click pins it
 * open (touch-friendly). Used next to fields that need a "what / how" note — e.g.
 * how to create a git PAT — without spending vertical space until asked for.
 */
export function InfoTip(props: { children: ReactNode; label?: string }) {
  const [pinned, setPinned] = useState(false);
  return (
    <span className={`infotip ${pinned ? 'open' : ''}`}>
      <button
        type="button"
        className="infotip-icon"
        aria-label={props.label ?? 'More information'}
        aria-expanded={pinned}
        onClick={(e) => {
          e.preventDefault();
          setPinned((p) => !p);
        }}
      >
        i
      </button>
      <span className="infotip-bubble" role="tooltip" onMouseDown={(e) => e.stopPropagation()}>
        {props.children}
      </span>
    </span>
  );
}
