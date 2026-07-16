import { BrowserRouter, Routes, Route, NavLink, Navigate } from 'react-router-dom';
import { SessionProvider, useSession } from './session';
import { Login } from './views/Login';
import { Home } from './views/Home';
import { post } from './api';

/** The signed-in application shell: a topbar with the primary navigation and the
 *  account menu, plus the routed view area. Admin routes appear only when the
 *  session has admin reach. Views are migrated incrementally; unmigrated ones
 *  fall back to the placeholder in Home. */
function Shell() {
  const { ctx, adminVisible } = useSession();
  const who = ctx?.subject.displayName || ctx?.subject.email || ctx?.subject.userId || 'signed in';

  async function signOut() {
    try {
      await post('/web/logout');
    } finally {
      window.location.reload();
    }
  }

  const local = !!ctx?.local;

  return (
    <div className="app">
      {!local && (
        <header className="topbar">
          <span className="brand">wairon</span>
          <nav className="tabs">
            <NavLink to="/" end>Canvas</NavLink>
            <NavLink to="/projects">Projects</NavLink>
            {adminVisible && <NavLink to="/admin">Admin</NavLink>}
          </nav>
          <span className="spacer" />
          <div className="account">
            <span className="who">{who}</span>
            {ctx?.isAdmin && <span className="badge">admin</span>}
            <button onClick={signOut}>Sign out</button>
          </div>
        </header>
      )}
      <main className="view">
        <Routes>
          <Route path="/" element={<Home />} />
          {/* Placeholder routes — migrated incrementally. */}
          <Route path="/projects" element={<Home />} />
          <Route path="/admin/*" element={<Home />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
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
        <button onClick={reload}>Retry</button>
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
        <Gate />
      </SessionProvider>
    </BrowserRouter>
  );
}
