import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { SettingsProvider, useSettings } from './settings';
import { RealtimeProvider } from './realtime';
import { RealtimeStatus } from './RealtimeStatus';
import { ToastProvider } from './ui';
import { TooltipLayer } from './components/TooltipLayer';
import { HeaderMenu } from './HeaderMenu';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { Users } from './views/Users';
import { Roles } from './views/Roles';
import { Permissions } from './views/Permissions';
import { Units } from './views/Units';
import { Projects } from './views/Projects';
import { ProjectOps } from './views/ProjectOps';
import { CanvasRouter } from './views/CanvasRouter';
import { Tokens } from './views/Tokens';
import { Providers } from './views/Providers';
import { Approvals } from './views/Approvals';
import { Audit } from './views/Audit';
import { Health } from './views/Health';
import { Instance } from './views/Instance';
import { ThemeBuilder } from './views/ThemeBuilder';
import { CanvasView } from './views/CanvasView';
import { SpecsTab } from './views/SpecsEditor';
import { FamilyPanel } from './views/FamilyPanel';
import { DevBanner } from './views/DevBanner';
import { ApprovalBanner, BranchChip, CockpitProvider, LockInPlaceButton, SettingsCog, useApproval, useScopeNodes } from './views/DevCockpit';
import { parseMoved, subsystemOfRoute } from './views/devCockpitLogic';
import { Select, Tabs } from './ui';
import { devPageTitle, hostedPageTitle, projectLabel } from './views/devCockpitLogic';
import { post, raw } from './api';

/** The one project a `wairon dev` server ever serves: the cwd, registered as 'local'. */
const DEV_PROJECT_ID = 'local';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { to: '/canvas', label: 'Canvas', icon: '◈' },
  { to: '/projects', label: 'Projects', icon: '▦' },
  { to: '/agents', label: 'Agents', icon: '⌁' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/users', label: 'Users', icon: '⦿' },
  { to: '/admin/roles', label: 'Roles', icon: '⛨' },
  { to: '/admin/permissions', label: 'Permissions', icon: '⚖' },
  { to: '/admin/units', label: 'Organization', icon: '⌂' },
  { to: '/admin/providers', label: 'Sign-in (SSO)', icon: '⚿' },
  { to: '/admin/approvals', label: 'Approvals', icon: '✓' },
  { to: '/admin/audit', label: 'Audit', icon: '☰' },
  { to: '/admin/health', label: 'Health', icon: '♥' },
  { to: '/admin/instance', label: 'Instance', icon: '⚙' },
];

function NavList(props: { items: NavItem[]; collapsed: boolean }) {
  return (
    <nav className="nav-group">
      {props.items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className="nav-item" data-tip={props.collapsed ? n.label : undefined} aria-label={props.collapsed ? n.label : undefined}>
          <span className="nav-icon">{n.icon}</span>
          {!props.collapsed && <span className="nav-text">{n.label}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

function Sidebar(props: { adminVisible: boolean; collapsed: boolean; onToggle: () => void }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        {!props.collapsed && <span className="brand brand-gradient-text">wairon</span>}
        <button
          type="button"
          className="syw-button syw-button--ghost icon-btn sidebar-toggle"
          onClick={props.onToggle}
          aria-label={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!props.collapsed}
          data-tip={props.collapsed ? 'Expand' : 'Collapse'}
        >
          ☰
        </button>
      </div>
      <NavList items={MAIN_NAV} collapsed={props.collapsed} />
      {props.adminVisible && (
        <>
          {!props.collapsed && <div className="nav-label">Administration</div>}
          {props.collapsed && <div className="nav-divider" />}
          <NavList items={ADMIN_NAV} collapsed={props.collapsed} />
        </>
      )}
    </aside>
  );
}

// ── Local developer mode (`wairon dev`) ──────────────────────────────────────
//
// The dev server is a fundamentally different deployment from the hosted
// instance: ONE project (the cwd, registered as 'local'), on loopback, with no
// accounts and no tenancy. So local mode is not the hosted app with things
// hidden — it mounts a separate, smaller surface built from the SAME components:
// the live architecture canvas and the spec editor, both hard-bound to 'local'.
// Everything the hosted app carries for a shared instance (sign-in, org units,
// the projects list, users/roles/permissions, tokens, sharing, audit) has no
// meaning here and is absent from this shell entirely.

const DEV_TABS = [
  { id: 'canvas', label: 'Canvas' },
  { id: 'specs', label: 'Specs' },
  { id: 'family', label: 'Family' },
];

/** `/canvas/[local/]<engine route>` — the local project's live canvas, mounted
 *  WITHOUT the environment (org-unit → project) layer above it: locally there is
 *  exactly one project, so there is nothing to navigate between. The optional
 *  leading 'local' segment is what CanvasView itself pushes on an in-canvas
 *  drill (it builds `/canvas/<projectId>/<route>`), so both shapes resolve here. */
function DevCanvas() {
  const splat = useParams()['*'] ?? '';
  const segments = splat.split('/').filter(Boolean);
  const route = (segments[0] === DEV_PROJECT_ID ? segments.slice(1) : segments).join('/');
  const nodes = useScopeNodes();
  return (
    <div className="canvas-view">
      <div className="lock-inplace">
        <LockInPlaceButton viewSubsystem={subsystemOfRoute(route, nodes)} />
      </div>
      <CanvasView projectId={DEV_PROJECT_ID} route={route} />
    </div>
  );
}

/** `/specs/<kind>/<id…>` — the spec value editor over the local project. Mirrors
 *  the hosted ProjectOps Specs tab routing (a qualified id's `::` mapped to `/`
 *  path segments) minus the project selector, so canvas deep-links and refreshes
 *  land on the same spec. */
function DevSpecs() {
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
    const idPath = sel.id.split('::').map(encodeURIComponent).join('/');
    nav(`/specs/${sel.kind}/${idPath}`);
  };
  const approval = useApproval();
  const changedSpecs = useMemo(() => parseMoved(approval?.verdict.moved), [approval]);
  return (
    <div className="view-pad view-pad-wide">
      <SpecsTab
        projectId={DEV_PROJECT_ID}
        selection={selection}
        onSelectSpec={selectSpec}
        approvalBanner={<ApprovalBanner />}
        changedSpecs={changedSpecs}
      />
    </div>
  );
}

function DevFamily() {
  return (
    <div className="view-pad view-pad-wide">
      <FamilyPanel projectId={DEV_PROJECT_ID} actions />
    </div>
  );
}

/** The served project's display name: the L0 system name the approval read the page already polls carries. Falls back until it arrives. */
function useDevProjectName(): string {
  return projectLabel(useApproval()?.projectName);
}

function DevShell() {
  return (
    <CockpitProvider>
      <DevFrame />
    </CockpitProvider>
  );
}

function DevFrame() {
  const projectName = useDevProjectName();
  useEffect(() => {
    document.title = devPageTitle(projectName);
  }, [projectName]);
  const nav = useNavigate();
  const { pathname } = useLocation();
  const tab = pathname.startsWith('/specs') ? 'specs' : pathname.startsWith('/family') ? 'family' : 'canvas';

  const go = (id: string) => nav(id === 'specs' ? '/specs' : id === 'family' ? '/family' : '/canvas');
  return (
    <div className="shell">
      <div className="main-col">
        <header className="syw-header topbar dev-bar">
          <span className="brand brand-gradient-text">wairon</span>
          <span className="dev-tag" data-tip="Local developer server — this project only" tabIndex={0}>
            dev
          </span>
          <span className="dev-project" title={projectName}>
            {projectName}
          </span>
          <Tabs label="Workspace" className="dev-tabs" tabs={DEV_TABS} active={tab} onSelect={go} />
          <span className="dev-nav-select">
            <Select value={tab} onChange={go} options={DEV_TABS.map((t) => ({ value: t.id, label: t.label }))} />
          </span>
          <span className="syw-header__spacer" />
          <BranchChip />
          <RealtimeStatus />
          <SettingsCog />
        </header>
        <DevBanner />
        <main className="view">
          <Routes>
            <Route path="/canvas/*" element={<DevCanvas />} />
            <Route path="/specs/*" element={<DevSpecs />} />
            <Route path="/family" element={<DevFamily />} />
            <Route path="*" element={<Navigate to="/canvas" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Shell() {
  const { ctx, adminVisible } = useSession();
  const { sidebarCollapsed, toggleSidebar } = useSettings();
  const { pathname: hostedPath } = useLocation();
  const hostedProject = hostedPath.split('/')[1] === 'projects' || hostedPath.split('/')[1] === 'canvas' ? hostedPath.split('/')[2] : undefined;
  useEffect(() => {
    if (ctx?.local) return;
    document.title = hostedPageTitle(hostedProject ? decodeURIComponent(hostedProject) : null);
  }, [ctx?.local, hostedProject]);

  async function signOut() {
    try {
      await post('/web/logout');
    } finally {
      window.location.reload();
    }
  }

  // `wairon dev` runs its own shell (above) — a different mode, not this one
  // with pieces hidden.
  if (ctx?.local) return <DevShell />;

  return (
    <div className={`shell ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
      <Sidebar adminVisible={adminVisible} collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      <div className="main-col">
        <header className="syw-header topbar">
          <span className="syw-header__spacer" />
          <RealtimeStatus />
          {ctx && <HeaderMenu ctx={ctx} onSignOut={signOut} />}
        </header>
        <main className="view">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/canvas/*" element={<CanvasRouter />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId/*" element={<ProjectOps />} />
            <Route path="/agents" element={<Tokens />} />
            <Route path="/themes" element={<ThemeBuilder />} />
            <Route path="/admin/users" element={<Users />} />
            <Route path="/admin/roles" element={<Roles />} />
            <Route path="/admin/permissions" element={<Permissions />} />
            <Route path="/admin/units" element={<Units />} />
            <Route path="/admin/providers" element={<Providers />} />
            <Route path="/admin/approvals" element={<Approvals />} />
            <Route path="/admin/audit" element={<Audit />} />
            <Route path="/admin/health" element={<Health />} />
            <Route path="/admin/instance" element={<Instance />} />
            <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

/**
 * Page-lifetime memo of the one-shot local-dev recovery probe (see Anonymous):
 * null = not attempted, 'hosted' = this server has no dev route, 'dev' = it does
 * but we came back anonymous anyway (so never probe in a loop).
 */
let devProbe: 'hosted' | 'dev' | null = null;

/**
 * Unauthenticated. On a HOSTED instance that means the sign-in screen. On a
 * `wairon dev` server it means something is wrong: dev mode configures NO
 * sign-in method, so rendering the hosted login screen there is a dead end
 * ("No sign-in method is configured on this instance") with no way forward.
 *
 * Session cookies are not port-scoped, so a stale wairon_session — from another
 * project's dev server, a hosted instance on the same host, or an ephemeral dev
 * data dir that was cleaned — can land us here. The dev-only /web/dev-login
 * route re-establishes the local session (and 404s on a hosted instance), so we
 * probe it ONCE with redirect:'manual': a redirect means "dev server, session
 * re-established" → reload the context; a 404 means "hosted" → sign in.
 */
function Anonymous({ onSignedIn }: { onSignedIn: () => void }) {
  const [state, setState] = useState<'probing' | 'hosted' | 'dev-failed'>(
    devProbe === null ? 'probing' : devProbe === 'dev' ? 'dev-failed' : 'hosted',
  );

  useEffect(() => {
    if (devProbe !== null) return;
    let alive = true;
    raw('/web/dev-login', { redirect: 'manual' })
      .then((res) => {
        // 404 → no dev route → a hosted instance. Anything else (an opaque
        // redirect, or a 2xx) → the dev server minted the local session.
        devProbe = res.status === 404 ? 'hosted' : 'dev';
        if (!alive) return;
        if (devProbe === 'dev') onSignedIn();
        else setState('hosted');
      })
      .catch(() => {
        devProbe = 'hosted';
        if (alive) setState('hosted');
      });
    return () => {
      alive = false;
    };
  }, [onSignedIn]);

  if (state === 'probing') return <div className="boot">Connecting…</div>;
  if (state === 'dev-failed') {
    return (
      <div className="boot">
        <p className="err">Could not start the local developer session.</p>
        <p className="hint">
          This is a local <code>wairon dev</code> server — it has no sign-in. Stop it, clear this site's cookies, and
          run <code>wairon dev</code> again.
        </p>
        <button type="button" className="syw-button" onClick={onSignedIn}>
          Retry
        </button>
      </div>
    );
  }
  return <Login onSignedIn={onSignedIn} />;
}

function Gate() {
  const { status, error, reload } = useSession();
  if (status === 'loading') return <div className="boot">Loading…</div>;
  if (status === 'anonymous') return <Anonymous onSignedIn={reload} />;
  if (status === 'error') {
    return (
      <div className="boot">
        <p className="err">Could not reach the server.</p>
        <button type="button" className="syw-button" onClick={reload}>
          Retry
        </button>
        {error && <p className="hint">{error}</p>}
      </div>
    );
  }
  return (
    <RealtimeProvider>
      <Shell />
    </RealtimeProvider>
  );
}

export function App() {
  return (
    <SettingsProvider>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <Gate />
            <TooltipLayer />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </SettingsProvider>
  );
}
