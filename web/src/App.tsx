import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { SettingsProvider, useSettings } from './settings';
import { ToastProvider } from './ui';
import { HeaderMenu } from './HeaderMenu';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { Users } from './views/Users';
import { Roles } from './views/Roles';
import { Units } from './views/Units';
import { Projects } from './views/Projects';
import { ProjectOps } from './views/ProjectOps';
import { post } from './api';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  end?: boolean;
}

const MAIN_NAV: NavItem[] = [
  { to: '/', label: 'Canvas', icon: '◈', end: true },
  { to: '/projects', label: 'Projects', icon: '▦' },
];

const ADMIN_NAV: NavItem[] = [
  { to: '/admin/users', label: 'Users', icon: '⦿' },
  { to: '/admin/roles', label: 'Roles', icon: '⛨' },
  { to: '/admin/units', label: 'Organization', icon: '⌂' },
];

function NavList(props: { items: NavItem[]; collapsed: boolean }) {
  return (
    <nav className="nav-group">
      {props.items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.end} className="nav-item" title={props.collapsed ? n.label : undefined}>
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
        {!props.collapsed && <span className="brand syw-gradient-text">wairon</span>}
        <button
          className="icon-btn sidebar-toggle"
          onClick={props.onToggle}
          aria-label={props.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={props.collapsed ? 'Expand' : 'Collapse'}
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

function Shell() {
  const { ctx, adminVisible } = useSession();
  const { sidebarCollapsed, toggleSidebar } = useSettings();
  const local = !!ctx?.local;

  async function signOut() {
    try {
      await post('/web/logout');
    } finally {
      window.location.reload();
    }
  }

  // Local dev mode (`wairon dev`): no chrome — the canvas fills the viewport.
  if (local) {
    return (
      <main className="view-full">
        <Home />
      </main>
    );
  }

  return (
    <div className={`shell ${sidebarCollapsed ? 'is-collapsed' : ''}`}>
      <Sidebar adminVisible={adminVisible} collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
      <div className="main-col">
        <header className="topbar">
          <span className="spacer" />
          {ctx && <HeaderMenu ctx={ctx} onSignOut={signOut} />}
        </header>
        <main className="view">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:projectId" element={<ProjectOps />} />
            <Route path="/admin/users" element={<Users />} />
            <Route path="/admin/roles" element={<Roles />} />
            <Route path="/admin/units" element={<Units />} />
            <Route path="/admin" element={<Navigate to="/admin/users" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Gate() {
  const { status, error, reload } = useSession();
  if (status === 'loading') return <div className="boot">Loading…</div>;
  if (status === 'anonymous') return <Login onSignedIn={reload} />;
  if (status === 'error') {
    return (
      <div className="boot">
        <p className="err">Could not reach the server.</p>
        <button className="btn" onClick={reload}>
          Retry
        </button>
        {error && <p className="hint">{error}</p>}
      </div>
    );
  }
  return <Shell />;
}

export function App() {
  return (
    <SettingsProvider>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </SettingsProvider>
  );
}
