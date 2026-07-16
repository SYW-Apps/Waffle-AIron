import { useEffect, useState } from 'react';
import { get, post } from '../api';

interface LoginOptions {
  passwordLogin: boolean;
  providers: { id: string; displayName: string }[];
}

/** The dynamic sign-in screen: renders exactly the methods the server reports
 *  on the pre-auth GET /web/login-options (password login and/or one button per
 *  enabled SSO provider). Mirrors the previous client's behaviour. */
export function Login({ onSignedIn }: { onSignedIn: () => void }) {
  const [opts, setOpts] = useState<LoginOptions | null>(null);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get<LoginOptions>('/web/login-options')
      .then(setOpts)
      .catch(() => setOpts({ passwordLogin: false, providers: [] }));
  }, []);

  async function signInPassword() {
    setBusy(true);
    setErr('');
    try {
      await post('/web/login', { user, password });
      onSignedIn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  async function signInSso(providerId: string) {
    setBusy(true);
    setErr('');
    try {
      const { url } = await post<{ url: string }>('/web/sso/start', {
        providerId,
        redirectUri: window.location.origin + '/web/sso/callback',
      });
      window.location.href = url;
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Sign-in failed.');
      setBusy(false);
    }
  }

  const nothing = opts && !opts.passwordLogin && opts.providers.length === 0;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand">wairon</div>
        {!opts && <p className="hint">Loading sign-in options…</p>}
        {nothing && <p className="hint">No sign-in method is configured on this instance.</p>}
        {opts?.passwordLogin && (
          <div className="stack">
            <input placeholder="Admin username" value={user} onChange={(e) => setUser(e.target.value)} />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && signInPassword()}
            />
            <button className="primary" disabled={busy} onClick={signInPassword}>
              Sign in
            </button>
          </div>
        )}
        {opts && opts.providers.length > 0 && (
          <div className="stack">
            {opts.passwordLogin && <div className="or">or</div>}
            {opts.providers.map((p) => (
              <button key={p.id} disabled={busy} onClick={() => signInSso(p.id)}>
                Sign in with {p.displayName}
              </button>
            ))}
          </div>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}
