import { useState } from 'react';
import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { ToastProvider } from './ui';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { Users } from './views/Users';
import { Roles } from './views/Roles';
import { Units } from './views/Units';
import { Projects } from './views/Projects';
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
  { to: '/admin/users', label: 'Users', icon: '👤' },
  { to: '/admin/roles', label: 'Roles', icon: '🛡' },
  { to: '/admin/units', label: 'Organization', icon: '🏢' },
];

function Sidebar(props: { adminVisible: boolean; open: boolean; onNavigate: () => void }) {
  return (
    <aside className={`sidebar ${props.open ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand">wairon</div>
      <nav className="nav-group">
        {MAIN_NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end} className="nav-item" onClick={props.onNavigate}>
            <span className="nav-icon">{n.icon}</span>
            {n.label}
          </NavLink>
        ))}
      </nav>
      {props.adminVisible && (
        <>
          <div className="nav-label">Administration</div>
          <nav className="nav-group">
            {ADMIN_NAV.map((n) => (
              <NavLink key={n.to} to={n.to} className="nav-item" onClick={props.onNavigate}>
                <span className="nav-icon">{n.icon}</span>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </>
      )}
    </aside>
  );
}

function Shell() {
  const { ctx, adminVisible } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const who = ctx?.subject.displayName || ctx?.subject.email || ctx?.subject.userId || 'signed in';
  const local = !!ctx?.local;

  async function signOut() {
    try {
      await post('/web/logout');
    } finally {
      window.location.reload();
    }
  }

  // Local dev mode: no chrome at all — the canvas fills the viewport.
  if (local) {
    return (
      <main className="view-full">
        <Home />
      </main>
    );
  }

  return (
    <div className={`shell ${drawerOpen ? 'drawer-open' : ''}`}>
      <Sidebar adminVisible={adminVisible} open={drawerOpen} onNavigate={() => setDrawerOpen(false)} />
      {drawerOpen && <div className="scrim scrim-drawer" onClick={() => setDrawerOpen(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button className="icon-btn hamburger" aria-label="Menu" onClick={() => setDrawerOpen((o) => !o)}>
            ☰
          </button>
          <span className="spacer" />
          <div className="account">
            <span className="who">{who}</span>
            {ctx?.isAdmin && <span className="badge badge-accent">admin</span>}
            <button className="btn btn-ghost btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>
        <main className="view">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/projects" element={<Projects />} />
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
    <BrowserRouter>
      <SessionProvider>
        <ToastProvider>
          <Gate />
        </ToastProvider>
      </SessionProvider>
    </BrowserRouter>
  );
}
