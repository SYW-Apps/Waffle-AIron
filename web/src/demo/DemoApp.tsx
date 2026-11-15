import { useEffect, useMemo, useRef, useState } from 'react';
import { MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { SessionProvider, useSession } from '../session';
import { SettingsProvider, useSettings } from '../settings';
import { ToastProvider, Tabs, Select } from '../ui';
import { TooltipLayer } from '../components/TooltipLayer';
import { ThemeCog } from '../ThemeControls';
import { CanvasView } from '../views/CanvasView';
import { SpecsTab } from '../views/SpecsEditor';
import { setFixedSywTokens } from '../theme/sywBridge';
import { createEmbedHost, isFramed, type EmbedHost, type EmbedView, type EmbedWindow } from './embed';
import { EMBED_THEME_ID, sywOverridesFromTokens, themeFromTokens } from './tokens';
import { loadIndex, type SnapshotIndex } from './snapshot';
import './demo.css';

/**
 * The static demo's page: the canvas and the specs of one recorded design, read-only, with no
 * server behind it. It mounts the same canvas and spec views as `wairon dev`, over a snapshot
 * (see ./snapshot.ts), inside an in-memory router so the address never changes (the framing page
 * sees one URL whatever the view). Framed by an allowed page it speaks the embed contract
 * (./embed.ts) and takes that page's appearance; opened directly it is a plain snapshot with
 * its own theme controls.
 */

const PROJECT_ID = 'local';

const TABS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'specs', label: 'Specs' },
];

const canvasStart = (index: SnapshotIndex): string => '/canvas/' + index.start.canvas;
const specsStart = (index: SnapshotIndex): string =>
  '/specs/' + index.start.specs.kind + '/' + index.start.specs.id.split('::').map(encodeURIComponent).join('/');
const viewOfPath = (pathname: string): EmbedView => (pathname.startsWith('/specs') ? 'specs' : 'canvas');

function DemoCanvas() {
  const splat = useParams()['*'] ?? '';
  const segments = splat.split('/').filter(Boolean);
  const route = (segments[0] === PROJECT_ID ? segments.slice(1) : segments).join('/');
  return (
    <div className="canvas-view">
      <CanvasView projectId={PROJECT_ID} route={route} />
    </div>
  );
}

function DemoSpecs() {
  const splat = useParams()['*'] ?? '';
  const nav = useNavigate();
  const segs = splat.split('/').filter(Boolean);
  const selection = useMemo(
    () => (segs.length >= 2 ? { kind: segs[0], id: segs.slice(1).map(decodeURIComponent).join('::') } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [splat],
  );
  const selectSpec = (sel: { kind: string; id: string } | null) => {
    if (!sel) return nav('/specs');
    nav(`/specs/${sel.kind}/${sel.id.split('::').map(encodeURIComponent).join('/')}`);
  };
  return (
    <div className="view-pad view-pad-wide">
      <SpecsTab projectId={PROJECT_ID} selection={selection} onSelectSpec={selectSpec} />
    </div>
  );
}

/** Speaks the embed contract for as long as the page is framed; renders nothing. */
function EmbedBridge(props: { index: SnapshotIndex }) {
  const { setThemeId, setAppearance, setCustomThemes } = useSettings();
  const nav = useNavigate();
  const { pathname } = useLocation();
  const host = useRef<EmbedHost | null>(null);
  const index = props.index;

  useEffect(() => {
    if (!isFramed(window as unknown as EmbedWindow)) return;
    const created = createEmbedHost({
      win: window as unknown as EmbedWindow,
      referrer: document.referrer,
      ancestorOrigins: Array.from((location as { ancestorOrigins?: ArrayLike<string> }).ancestorOrigins ?? []),
      demo: index.demo,
      onAppearance: (mode, tokens) => {
        setFixedSywTokens(sywOverridesFromTokens(tokens));
        setCustomThemes([themeFromTokens(tokens, mode)]);
        setThemeId(EMBED_THEME_ID);
        setAppearance(mode);
        // The page stayed blank until the first appearance arrived.
        document.documentElement.style.visibility = '';
      },
      onNavigate: (view) => nav(view === 'specs' ? specsStart(index) : canvasStart(index)),
    });
    host.current = created;
    created.start();
    return () => {
      created.dispose();
      host.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    host.current?.reportView(viewOfPath(pathname), pathname);
  }, [pathname]);

  return null;
}

function DemoFrame(props: { index: SnapshotIndex; framed: boolean }) {
  const { index, framed } = props;
  const nav = useNavigate();
  const { pathname } = useLocation();
  const tab = viewOfPath(pathname);
  const go = (id: string) => nav(id === 'specs' ? specsStart(index) : canvasStart(index));
  useEffect(() => {
    document.title = index.demo.title;
  }, [index.demo.title]);
  return (
    <div className="shell">
      <div className="main-col">
        <header className="syw-header topbar dev-bar">
          <span className="brand brand-gradient-text">wairon</span>
          <span className="dev-tag" tabIndex={0}>
            demo
          </span>
          <span className="dev-project" title={index.demo.title}>
            {index.demo.title}
          </span>
          <Tabs label="Workspace" className="dev-tabs" tabs={TABS} active={tab} onSelect={go} />
          <span className="dev-nav-select">
            <Select value={tab} onChange={go} options={TABS.map((t) => ({ value: t.id, label: t.label }))} />
          </span>
          <span className="syw-header__spacer" />
          <span className="demo-note">read-only snapshot, wairon {index.demo.waironVersion}</span>
          {framed ? null : <ThemeCog />}
        </header>
        <main className="view">
          <Routes>
            <Route path="/canvas/*" element={<DemoCanvas />} />
            <Route path="/specs/*" element={<DemoSpecs />} />
            <Route path="*" element={<Navigate to={canvasStart(index)} replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Gate(props: { index: SnapshotIndex }) {
  const { status } = useSession();
  const framed = isFramed(window as unknown as EmbedWindow);
  if (status === 'loading') return <div className="boot">Loading…</div>;
  if (status !== 'authenticated') return <div className="boot">The demo data could not be loaded.</div>;
  return (
    <>
      <EmbedBridge index={props.index} />
      <DemoFrame index={props.index} framed={framed} />
    </>
  );
}

export function DemoApp() {
  const [index, setIndex] = useState<SnapshotIndex | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    loadIndex().then(setIndex, () => setFailed(true));
  }, []);
  if (failed) return <div className="boot">The demo data could not be loaded.</div>;
  if (!index) return <div className="boot">Loading…</div>;
  return (
    <SettingsProvider>
      <MemoryRouter initialEntries={[canvasStart(index)]}>
        <SessionProvider>
          <ToastProvider>
            <Gate index={index} />
            <TooltipLayer />
          </ToastProvider>
        </SessionProvider>
      </MemoryRouter>
    </SettingsProvider>
  );
}
