import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The app's one themed tooltip (the DS `.syw-tooltip` surface, with this layer
 * as its placement/interaction engine — the DS ships the skin only).
 *
 * Any element carrying `data-tip="…"` gets a hint on pointer hover (after a short
 * delay) and on keyboard focus (immediately). It replaces native `title`
 * tooltips, which are unthemed and unreachable by keyboard. While shown, the
 * trigger is `aria-describedby` the tooltip; Escape, scroll, blur or leaving the
 * trigger dismisses it. The tooltip is a manual popover, so it lives in the top
 * layer and shows above modal dialogs. Essential information must still be
 * visible on its own (or in an accessible name) — a tooltip only supplements.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = 'wairon-tooltip';

  useEffect(() => {
    function clear() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
      const t = targetRef.current;
      if (t?.getAttribute('aria-describedby') === id) t.removeAttribute('aria-describedby');
      targetRef.current = null;
      setTip(null);
      setPos(null);
    }
    function open(el: Element) {
      const text = el.getAttribute('data-tip');
      if (!text) return;
      targetRef.current = el;
      el.setAttribute('aria-describedby', id);
      setTip({ text, rect: el.getBoundingClientRect() });
    }
    function find(e: Event): Element | null {
      return e.target instanceof Element ? e.target.closest('[data-tip]') : null;
    }
    function onOver(e: PointerEvent) {
      if (e.pointerType === 'touch') return;
      const el = find(e);
      if (!el || el === targetRef.current) return;
      clear();
      timer.current = setTimeout(() => open(el), 350);
    }
    function onOut(e: PointerEvent) {
      const el = find(e);
      if (!el) return;
      const to = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (to && el.contains(to)) return;
      // Keep a keyboard-focused trigger's tip when the pointer merely passes.
      if (el === document.activeElement && el.matches(':focus-visible')) return;
      clear();
    }
    function onFocusIn(e: FocusEvent) {
      const el = find(e);
      if (!el || !(el as HTMLElement).matches(':focus-visible')) return;
      clear();
      open(el);
    }
    function onFocusOut() {
      clear();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && targetRef.current) clear();
    }
    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', clear, true);
    window.addEventListener('scroll', clear, true);
    return () => {
      clear();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('scroll', clear, true);
    };
  }, []);

  // Enter the top layer, then place under the trigger (flip above when it would
  // leave the viewport), clamped horizontally.
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) return;
    try {
      if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) el.showPopover();
    } catch {
      /* fixed positioning still applies without the popover API */
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const r = tip.rect;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const below = r.bottom + 8;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 8) : below;
    setPos({ top, left });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={tipRef}
      id={id}
      role="tooltip"
      popover="manual"
      className="syw-tooltip tip-layer"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      {tip.text}
    </div>
  );
}
