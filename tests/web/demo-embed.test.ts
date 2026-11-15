import { describe, it, expect, vi } from 'vitest';
import {
  APPEARANCE_TOKEN_KEYS,
  PRODUCTION_PARENT_ORIGIN,
  createEmbedHost,
  isAllowedParentOrigin,
  isFramed,
  parentOriginsOf,
  type EmbedMessageEvent,
  type EmbedWindow,
} from '../../web/src/demo/embed';
import { EMBED_THEME_ID, sywOverridesFromTokens, themeFromTokens, waironVariablesFromTokens } from '../../web/src/demo/tokens';

// The frame side of embed contract v1, against stubbed windows (no browser).

const DEMO = { id: 'wairon', title: "wairon's own design", waironVersion: '6.7.4' };

function tokens(): Record<string, string> {
  const t: Record<string, string> = {};
  APPEARANCE_TOKEN_KEYS.forEach((k, i) => (t[k] = '#' + String(i).padStart(2, '0').repeat(3)));
  return t;
}

/** A frame window whose parent records every postMessage with its target origin. */
function setup(opts: { ancestor?: string[]; referrer?: string } = {}) {
  const sent: { message: any; origin: string }[] = [];
  const parent: EmbedWindow = { parent: null, addEventListener() {}, removeEventListener() {}, postMessage: (message, origin) => sent.push({ message, origin }) };
  let listener: ((e: EmbedMessageEvent) => void) | null = null;
  const win: EmbedWindow = {
    parent,
    addEventListener: (_t, l) => (listener = l),
    removeEventListener: () => (listener = null),
    postMessage: () => {},
  };
  const appearances: { mode: string; tokens: Record<string, string> }[] = [];
  const navigations: string[] = [];
  const intervals: { fn: () => void; ms: number }[] = [];
  const host = createEmbedHost({
    win,
    referrer: opts.referrer ?? '',
    ancestorOrigins: opts.ancestor ?? ['https://wairon.sywapps.com'],
    demo: DEMO,
    onAppearance: (mode, t) => appearances.push({ mode, tokens: t }),
    onNavigate: (v) => navigations.push(v),
    setInterval: (fn, ms) => (intervals.push({ fn, ms }), intervals.length),
    clearInterval: () => {},
  });
  const deliver = (e: Partial<EmbedMessageEvent> & { data: unknown }) =>
    listener?.({ origin: 'https://wairon.sywapps.com', source: parent, ...e });
  return { host, sent, parent, win, deliver, appearances, navigations, intervals };
}

describe('allowed parent origins', () => {
  it('allows production and localhost on any port, nothing else', () => {
    expect(isAllowedParentOrigin('https://wairon.sywapps.com')).toBe(true);
    expect(isAllowedParentOrigin('http://localhost:8080')).toBe(true);
    expect(isAllowedParentOrigin('http://localhost:5173')).toBe(true);
    expect(isAllowedParentOrigin('http://localhost')).toBe(false);
    expect(isAllowedParentOrigin('https://localhost:8080')).toBe(false);
    expect(isAllowedParentOrigin('http://localhost:8080.evil.example')).toBe(false);
    expect(isAllowedParentOrigin('http://evil.example')).toBe(false);
    expect(isAllowedParentOrigin('https://wairon.sywapps.com.evil.example')).toBe(false);
    expect(isAllowedParentOrigin('http://wairon.sywapps.com')).toBe(false);
    expect(isAllowedParentOrigin('*')).toBe(false);
  });

  it('takes the target from the ancestor origin, else the referrer, else production', () => {
    expect(parentOriginsOf(['http://localhost:9000'], '')).toEqual(['http://localhost:9000']);
    expect(parentOriginsOf([], 'http://localhost:9001/page?x=1')).toEqual(['http://localhost:9001']);
    expect(parentOriginsOf(['http://evil.example'], 'http://localhost:9002/')).toEqual(['http://localhost:9002']);
    expect(parentOriginsOf([], '')).toEqual([PRODUCTION_PARENT_ORIGIN]);
    expect(parentOriginsOf(['http://evil.example'], 'http://evil.example/')).toEqual([PRODUCTION_PARENT_ORIGIN]);
  });
});

describe('the frame speaks first: ready', () => {
  it('posts a ready of the contract shape to the concrete parent origin', () => {
    const t = setup({ ancestor: ['http://localhost:9000'] });
    t.host.start();
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0].origin).toBe('http://localhost:9000');
    expect(t.sent[0].message).toEqual({
      wairon: 'embed',
      v: 1,
      kind: 'ready',
      demo: DEMO,
      views: ['canvas', 'specs'],
    });
  });

  it('repeats ready until the parent answers, then stops', () => {
    const t = setup();
    t.host.start();
    expect(t.intervals[0].ms).toBe(1000);
    t.intervals[0].fn();
    expect(t.sent.filter((s) => s.message.kind === 'ready')).toHaveLength(2);
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'navigate', view: 'specs' } });
    t.intervals[0].fn();
    expect(t.sent.filter((s) => s.message.kind === 'ready')).toHaveLength(2);
  });

  it('never posts to "*" and never to a non-allowed origin', () => {
    for (const ancestor of [[], ['http://evil.example'], ['http://localhost:1234'], ['https://wairon.sywapps.com']]) {
      const t = setup({ ancestor, referrer: 'http://evil.example/' });
      t.host.start();
      t.deliver({ origin: ancestor[0] ?? 'https://wairon.sywapps.com', data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'dark', tokens: tokens() } });
      t.host.reportView('specs', '/specs/x');
      expect(t.sent.length).toBeGreaterThan(0);
      for (const s of t.sent) {
        expect(s.origin).not.toBe('*');
        expect(isAllowedParentOrigin(s.origin)).toBe(true);
      }
    }
  });

  it('does nothing when the page is not framed', () => {
    const win: any = { addEventListener: vi.fn(), postMessage: vi.fn() };
    win.parent = win;
    expect(isFramed(win)).toBe(false);
    const host = createEmbedHost({ win, referrer: '', ancestorOrigins: [], demo: DEMO, onAppearance: vi.fn(), onNavigate: vi.fn() });
    host.start();
    host.reportView('canvas', '/canvas/x');
    expect(win.addEventListener).not.toHaveBeenCalled();
    expect(win.postMessage).not.toHaveBeenCalled();
  });
});

describe('messages from the parent', () => {
  it('applies an appearance: the mode and only the known tokens', () => {
    const t = setup();
    t.host.start();
    const sent = { ...tokens(), '--evil': 'url(javascript:1)', '--syw-color-text': 42 as unknown as string };
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'high-contrast', tokens: sent } });
    expect(t.appearances).toHaveLength(1);
    expect(t.appearances[0].mode).toBe('high-contrast');
    expect(t.appearances[0].tokens['--evil']).toBeUndefined();
    expect(t.appearances[0].tokens['--syw-color-text']).toBeUndefined();
    expect(t.appearances[0].tokens['--syw-color-canvas']).toBe(tokens()['--syw-color-canvas']);
    // every later appearance is applied too (live, no reload)
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'light', tokens: tokens() } });
    expect(t.appearances.map((a) => a.mode)).toEqual(['high-contrast', 'light']);
  });

  it('ignores an unknown mode', () => {
    const t = setup();
    t.host.start();
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'sepia', tokens: tokens() } });
    expect(t.appearances).toHaveLength(0);
  });

  it('navigates to a known view only', () => {
    const t = setup();
    t.host.start();
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'navigate', view: 'specs' } });
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'navigate', view: 'canvas' } });
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'navigate', view: 'family' } });
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'navigate', view: '__proto__' } });
    expect(t.navigations).toEqual(['specs', 'canvas']);
  });

  it('rejects other origins, a wrong source, and other protocols', () => {
    const t = setup();
    t.host.start();
    const good = { wairon: 'embed', v: 1, kind: 'navigate', view: 'specs' };
    t.deliver({ origin: 'http://evil.example', data: good });
    t.deliver({ origin: 'https://wairon.sywapps.com.evil.example', data: good });
    t.deliver({ source: {}, data: good });
    t.deliver({ source: null, data: good });
    t.deliver({ data: { ...good, v: 2 } });
    t.deliver({ data: { ...good, wairon: 'other' } });
    t.deliver({ data: null });
    t.deliver({ data: 'navigate' });
    expect(t.navigations).toHaveLength(0);
    expect(t.host.heardParent()).toBe(false);
    // and an allowed localhost origin of any port is heard
    t.deliver({ origin: 'http://localhost:6123', data: good });
    expect(t.navigations).toEqual(['specs']);
  });

  it('answers only the origin it heard the parent on', () => {
    const t = setup({ ancestor: [] });
    t.host.start();
    t.deliver({ origin: 'http://localhost:6123', data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'dark', tokens: tokens() } });
    t.host.reportView('specs', '/specs/a');
    expect(t.sent.at(-1)?.origin).toBe('http://localhost:6123');
  });
});

describe('view messages', () => {
  it('sends the view once after the first appearance, then on every change', () => {
    const t = setup();
    t.host.start();
    t.host.reportView('canvas', '/canvas/sdd_network');
    expect(t.sent.filter((s) => s.message.kind === 'view')).toHaveLength(0);
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'dark', tokens: tokens() } });
    expect(t.sent.filter((s) => s.message.kind === 'view').map((s) => s.message)).toEqual([
      { wairon: 'embed', v: 1, kind: 'view', view: 'canvas', path: '/canvas/sdd_network' },
    ]);
    // a later appearance does not repeat it
    t.deliver({ data: { wairon: 'embed', v: 1, kind: 'appearance', mode: 'light', tokens: tokens() } });
    expect(t.sent.filter((s) => s.message.kind === 'view')).toHaveLength(1);
    // a route change does
    t.host.reportView('specs', '/specs/implementation/conformance_rules_impl');
    const views = t.sent.filter((s) => s.message.kind === 'view').map((s) => s.message);
    expect(views).toHaveLength(2);
    expect(views[1]).toMatchObject({ view: 'specs', path: '/specs/implementation/conformance_rules_impl' });
  });
});

describe('tokens onto the UI theme', () => {
  it('maps the design-system tokens onto the UI variables and a custom theme', () => {
    const t = tokens();
    const vars = waironVariablesFromTokens(t);
    expect(vars['--wairon-page-bg']).toBe(t['--syw-color-canvas']);
    expect(vars['--wairon-panel-bg']).toBe(t['--syw-color-surface']);
    expect(vars['--wairon-text']).toBe(t['--syw-color-text']);
    expect(vars['--wairon-primary']).toBe(t['--syw-color-primary']);
    expect(vars['--wairon-bad']).toBe(t['--syw-color-danger']);
    const theme = themeFromTokens(t, 'light');
    expect(theme.id).toBe(EMBED_THEME_ID);
    expect(theme.custom).toBe(true);
    expect(theme.swatches[0]).toBe(t['--syw-color-primary']);
    expect(Object.keys(sywOverridesFromTokens(t)).sort()).toEqual([...APPEARANCE_TOKEN_KEYS].sort());
  });
});
