import type { DemoMeta } from './snapshot';

/**
 * The frame side of the embed contract (version 1): the demo page speaking postMessage with the
 * page that frames it. Pure of the DOM: the window, the referrer and the ancestor origins are
 * handed in, so the whole contract is testable without a browser.
 *
 *   frame -> parent   ready      { demo: { id, title, waironVersion }, views }
 *   frame -> parent   view       { view, path }           once after ready, then on each route change
 *   parent -> frame   appearance { mode, tokens }         applied live
 *   parent -> frame   navigate   { view }                 go to that view's start
 *
 * Every message is `{ wairon: 'embed', v: 1, kind, ... }`. A message is acted on only when it
 * comes from the framing window itself and from an allowed origin; every message sent names a
 * concrete allowed origin as its target, never '*'.
 */

export const PRODUCTION_PARENT_ORIGIN = 'https://wairon.sywapps.com';
const LOCAL_ORIGIN = /^http:\/\/localhost:\d{1,5}$/;

export const EMBED_VIEWS = ['canvas', 'specs'] as const;
export type EmbedView = (typeof EMBED_VIEWS)[number];
export type EmbedMode = 'light' | 'dark' | 'high-contrast';

/** The design-system tokens the parent sends, and the only ones the frame accepts. */
export const APPEARANCE_TOKEN_KEYS = [
  '--syw-color-canvas',
  '--syw-color-surface',
  '--syw-color-surface-raised',
  '--syw-color-text',
  '--syw-color-text-muted',
  '--syw-color-line',
  '--syw-color-line-strong',
  '--syw-color-primary',
  '--syw-color-secondary',
  '--syw-color-accent',
  '--syw-color-on-primary',
  '--syw-color-danger',
  '--syw-color-on-danger',
  '--syw-color-success',
  '--syw-color-warning',
  '--syw-gradient-primary',
  '--syw-shadow-surface',
  '--syw-shadow-elevated',
  '--syw-header-bg',
] as const;

/** Whether a page at this origin may frame the demo and be listened to. */
export function isAllowedParentOrigin(origin: string): boolean {
  return origin === PRODUCTION_PARENT_ORIGIN || LOCAL_ORIGIN.test(origin);
}

/** The origin of a URL, or '' when it has none. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * The origins a `ready` is posted to. The browser tells the frame who framed it (the ancestor
 * origins, else the referrer); when that is an allowed origin it is the one target, which is how
 * a localhost page on any port is reached. Otherwise the only concrete origin left is production.
 */
export function parentOriginsOf(ancestorOrigins: readonly string[], referrer: string): string[] {
  for (const candidate of [ancestorOrigins[0] ?? '', originOf(referrer)]) {
    if (candidate !== '' && isAllowedParentOrigin(candidate)) return [candidate];
  }
  return [PRODUCTION_PARENT_ORIGIN];
}

export interface EmbedMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

export interface EmbedWindow {
  parent: EmbedWindow | null;
  addEventListener(type: 'message', listener: (event: EmbedMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: EmbedMessageEvent) => void): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface EmbedHostOptions {
  win: EmbedWindow;
  referrer: string;
  ancestorOrigins: readonly string[];
  demo: DemoMeta;
  /** The parent's appearance, to apply live. Called for every valid message. */
  onAppearance: (mode: EmbedMode, tokens: Record<string, string>) => void;
  /** The parent asked for a view's start. */
  onNavigate: (view: EmbedView) => void;
  /** How often `ready` is repeated until the parent answers (default 1000 ms), and how many times. */
  retryMs?: number;
  retries?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface EmbedHost {
  /** Announce `ready` and start listening. */
  start(): void;
  /** Tell the parent the visitor is on this view and route. */
  reportView(view: EmbedView, path: string): void;
  /** Whether the parent has spoken to the frame yet. */
  heardParent(): boolean;
  dispose(): void;
}

/** Whether the page is inside another page (the demo opened directly runs as a plain snapshot). */
export function isFramed(win: EmbedWindow): boolean {
  return win.parent !== null && win.parent !== win;
}

export function createEmbedHost(opts: EmbedHostOptions): EmbedHost {
  const { win } = opts;
  const parent = win.parent;
  let targets = parentOriginsOf(opts.ancestorOrigins, opts.referrer);
  let heard = false;
  let timer: unknown = null;
  let viewSent = false;
  let current: { view: EmbedView; path: string } | null = null;

  const post = (body: Record<string, unknown>): void => {
    if (parent === null || parent === win) return;
    for (const origin of targets) parent.postMessage({ wairon: 'embed', v: 1, ...body }, origin);
  };
  const sendReady = (): void => post({ kind: 'ready', demo: opts.demo, views: [...EMBED_VIEWS] });
  const sendView = (): void => {
    if (current) post({ kind: 'view', view: current.view, path: current.path });
  };

  const stopRetrying = (): void => {
    if (timer !== null) (opts.clearInterval ?? ((h: unknown) => clearInterval(h as never)))(timer);
    timer = null;
  };

  const onMessage = (event: EmbedMessageEvent): void => {
    if (event.source !== parent || !isAllowedParentOrigin(event.origin)) return;
    const data = event.data as Record<string, unknown> | null;
    if (typeof data !== 'object' || data === null || data.wairon !== 'embed' || data.v !== 1) return;
    if (!heard) {
      // From here on the parent is known by its origin: nothing is posted anywhere else.
      heard = true;
      targets = [event.origin];
      stopRetrying();
    }
    if (data.kind === 'appearance') {
      const mode = data.mode;
      if (mode !== 'light' && mode !== 'dark' && mode !== 'high-contrast') return;
      const tokens: Record<string, string> = {};
      const sent = (typeof data.tokens === 'object' && data.tokens !== null ? data.tokens : {}) as Record<string, unknown>;
      for (const key of APPEARANCE_TOKEN_KEYS) {
        if (typeof sent[key] === 'string') tokens[key] = sent[key] as string;
      }
      opts.onAppearance(mode, tokens);
      // The first appearance is what reveals the frame: say where the visitor is, once.
      if (!viewSent) {
        viewSent = true;
        sendView();
      }
    } else if (data.kind === 'navigate') {
      if ((EMBED_VIEWS as readonly unknown[]).includes(data.view)) opts.onNavigate(data.view as EmbedView);
    }
  };

  return {
    start() {
      if (parent === null || parent === win) return;
      win.addEventListener('message', onMessage);
      sendReady();
      let left = opts.retries ?? 8;
      timer = (opts.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms)))(() => {
        if (heard || left-- <= 0) return stopRetrying();
        sendReady();
      }, opts.retryMs ?? 1000);
    },
    reportView(next, path) {
      current = { view: next, path };
      // Before the first appearance the view is held, and sent with it; after, every change is sent.
      if (viewSent) sendView();
    },
    heardParent: () => heard,
    dispose() {
      stopRetrying();
      win.removeEventListener('message', onMessage);
    },
  };
}
