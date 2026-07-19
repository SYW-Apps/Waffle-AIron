import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { acceptWebSocket, isWebSocketUpgrade } from './websocket.js';
import type { WsConnection } from './websocket.js';
import { authenticateSession } from './auth.js';
import { authorize, isInstanceAdmin } from './authorization.js';
import { sessionCookieValue } from './web.js';
import type { HostConfig, Principal } from './types.js';

// ---------------------------------------------------------------------------
// Realtime channel hub (sdd_host) — live invalidation over WebSocket.
//
// The web app opens ONE session-authenticated socket at /web/ws and subscribes
// to named channels. When state changes (a /web mutation), the hub broadcasts a
// bare `{type:'change', channel}` — NO data — so subscribers re-fetch through the
// normal scoped REST API (which stays the single authorization point). The event
// carries nothing sensitive, and channel subscription is still authorized so a
// change's mere existence doesn't leak across tenants:
//   - `project:<id>`        → requires project:read on that project.
//   - user-facing channels  → any authenticated session (its own filtered view).
//   - everything else (admin)→ instance-level admin.
// ---------------------------------------------------------------------------

export const REALTIME_PATH = '/web/ws';

/** Channels every authenticated session may listen on — the payload is only a
 *  "refetch" nudge and the data is re-fetched through the caller's own scope. */
const USER_CHANNELS = new Set(['projects', 'landscape', 'units', 'tokens']);

function canSubscribe(cfg: HostConfig, principal: Principal, channel: string): boolean {
  if (channel.startsWith('project:')) {
    const projectId = channel.slice('project:'.length);
    return projectId.length > 0 && authorize(cfg.dataDir, principal, 'project:read', 'project', projectId).value === 'yes';
  }
  if (USER_CHANNELS.has(channel)) return true;
  return isInstanceAdmin(principal) || authorize(cfg.dataDir, principal, 'project:admin', 'instance', '').value === 'yes';
}

interface Subscriber {
  conn: WsConnection;
  principal: Principal;
  channels: Set<string>;
}

class RealtimeHub {
  private subs = new Set<Subscriber>();
  private heartbeat: ReturnType<typeof setInterval> | undefined;

  /** Handle an HTTP upgrade: gate the path, authenticate the session cookie,
   *  complete the handshake, and register the connection. A bad path or session
   *  destroys the socket. */
  handleUpgrade(cfg: HostConfig, req: IncomingMessage, socket: Duplex): void {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== REALTIME_PATH || !isWebSocketUpgrade(req)) {
      socket.destroy();
      return;
    }
    const sessionId = sessionCookieValue(req);
    const principal = sessionId ? authenticateSession(cfg.dataDir, sessionId) : null;
    if (!principal || !principal.authenticated) {
      try {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    const conn = acceptWebSocket(req, socket);
    if (!conn) {
      socket.destroy();
      return;
    }
    const sub: Subscriber = { conn, principal, channels: new Set() };
    this.subs.add(sub);
    conn.on('message', (raw: string) => this.onMessage(cfg, sub, raw));
    conn.on('close', () => this.subs.delete(sub));
    conn.send(JSON.stringify({ type: 'ready' }));
    this.ensureHeartbeat();
  }

  private onMessage(cfg: HostConfig, sub: Subscriber, raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; channels?: unknown };
    if (m.type === 'subscribe' && Array.isArray(m.channels)) {
      const accepted: string[] = [];
      for (const ch of m.channels) {
        if (typeof ch === 'string' && canSubscribe(cfg, sub.principal, ch)) {
          sub.channels.add(ch);
          accepted.push(ch);
        }
      }
      sub.conn.send(JSON.stringify({ type: 'subscribed', channels: accepted }));
    } else if (m.type === 'unsubscribe' && Array.isArray(m.channels)) {
      for (const ch of m.channels) if (typeof ch === 'string') sub.channels.delete(ch);
    } else if (m.type === 'ping') {
      sub.conn.send(JSON.stringify({ type: 'pong' }));
    }
  }

  /** Broadcast a change to every subscriber listening on `channel`. */
  publish(channel: string): void {
    if (this.subs.size === 0) return;
    const payload = JSON.stringify({ type: 'change', channel });
    for (const sub of this.subs) {
      if (sub.channels.has(channel)) sub.conn.send(payload);
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const sub of this.subs) sub.conn.ping();
    }, 30_000);
    this.heartbeat.unref?.();
  }

  closeAll(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const sub of this.subs) sub.conn.close();
    this.subs.clear();
  }

  /** Live subscriber count — for tests/diagnostics. */
  get size(): number {
    return this.subs.size;
  }
}

let hub: RealtimeHub | null = null;

export function getRealtimeHub(): RealtimeHub {
  if (!hub) hub = new RealtimeHub();
  return hub;
}

/** Broadcast a channel change (no-op when nothing is listening). */
export function publishChange(channel: string): void {
  getRealtimeHub().publish(channel);
}

/**
 * Map a successful /web mutation path (+ body) to the channels it invalidates.
 * Publishing is best-effort and side-effect-free for listeners (a bare refetch),
 * so a spurious publish after a failed mutation is harmless.
 */
export function channelsForWebMutation(pathname: string, body: unknown): string[] {
  const b = (body ?? {}) as { projectId?: unknown; id?: unknown };
  const projectId = typeof b.projectId === 'string' ? b.projectId : typeof b.id === 'string' ? b.id : undefined;
  const channels = new Set<string>();
  const add = (...cs: string[]) => cs.forEach((c) => channels.add(c));

  if (pathname.startsWith('/web/projects')) {
    add('projects', 'landscape');
    if (projectId) add(`project:${projectId}`);
  } else if (pathname === '/web/admin/org/units' || pathname === '/web/admin/org/units/remove') {
    add('units', 'landscape', 'projects');
  } else if (pathname === '/web/admin/org/placements') {
    add('projects', 'landscape', 'units');
    if (projectId) add(`project:${projectId}`);
  } else if (pathname.startsWith('/web/admin/users')) {
    add('users');
  } else if (pathname.startsWith('/web/admin/roles') || pathname.startsWith('/web/admin/permissions')) {
    add('roles', 'users');
  } else if (pathname.startsWith('/web/admin/approvals')) {
    add('approvals', 'projects');
  } else if (pathname.startsWith('/web/admin/providers')) {
    add('providers');
  } else if (pathname.startsWith('/web/admin/git-backing')) {
    add('git-backing');
  } else if (pathname.startsWith('/web/admin/share')) {
    add('share');
  } else if (
    pathname.startsWith('/web/admin/packs') ||
    pathname === '/web/admin/policy' ||
    pathname === '/web/admin/exposure' ||
    pathname === '/web/admin/secrets'
  ) {
    add('instance');
  } else if (pathname.startsWith('/web/tokens')) {
    add('tokens');
  }
  return [...channels];
}
