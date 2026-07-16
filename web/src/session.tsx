import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, raw, ApiError } from './api';

/** The slim principal context the server returns from GET /web/context. */
export interface WebContext {
  subject: {
    userId: string;
    kind: string;
    issuer: string;
    displayName?: string;
    email?: string;
  };
  /** True only for the env-anchored instance super-admin. */
  isAdmin: boolean;
  /** True under `wairon dev` (single local project, no tenancy chrome). */
  local?: boolean;
}

type Status = 'loading' | 'authenticated' | 'anonymous' | 'error';

interface SessionState {
  status: Status;
  ctx: WebContext | null;
  /** Whether the Admin surfaces are reachable — the env super-admin OR a
   *  delegated/SSO admin holding instance-level project:admin (probed, since the
   *  slim context only carries the env-super flag). */
  adminVisible: boolean;
  error?: string;
  reload: () => void;
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [ctx, setCtx] = useState<WebContext | null>(null);
  const [adminVisible, setAdminVisible] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    setStatus('loading');
    get<WebContext>('/web/context')
      .then(async (c) => {
        setCtx(c);
        setStatus('authenticated');
        // The Admin tab shows for any instance-level admin; the slim context
        // only flags the env super-admin, so probe a resolver-gated
        // instance-admin read to detect a delegated/SSO admin.
        if (c.isAdmin) {
          setAdminVisible(true);
        } else {
          try {
            setAdminVisible((await raw('/web/admin/roles')).ok);
          } catch {
            setAdminVisible(false);
          }
        }
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) {
          setStatus('anonymous');
        } else {
          setError(e instanceof Error ? e.message : String(e));
          setStatus('error');
        }
      });
  }, []);

  useEffect(load, [load]);

  return (
    <SessionContext.Provider value={{ status, ctx, adminVisible, error, reload: load }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionState {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession must be used within a SessionProvider');
  return s;
}
