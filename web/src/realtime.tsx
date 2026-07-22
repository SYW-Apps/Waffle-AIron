import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Realtime client: one session-authenticated WebSocket to /web/ws, shared by the
 * whole app. Views register interest in named channels (via useAsync's `channels`
 * option); when the server broadcasts a `change` on a channel, every registered
 * handler fires — typically a data reload. The socket auto-reconnects with
 * backoff and re-subscribes to whatever channels currently have listeners. The
 * event carries no data, so a reconnect gap only delays a refetch, never loses
 * authorization state.
 */

type ChangeHandler = () => void;

/** Connection state of the realtime socket, for surfacing liveness in the UI. */
export type RealtimeStatus = 'connecting' | 'connected' | 'offline';

interface RealtimeApi {
  subscribe(channels: string[], handler: ChangeHandler): () => void;
}

// Two contexts on purpose: `subscribe` is a STABLE identity (data-invalidation
// consumers via useAsync depend on it and must NOT re-subscribe on every
// connect/disconnect), while `status` changes on each transition and feeds only
// the connection-status pill. 'offline' means sustained reconnect failure (e.g. a
// reverse proxy blocking the WebSocket upgrade); nothing blocks on it — views
// still load over REST.
const RealtimeContext = createContext<RealtimeApi>({ subscribe: () => () => {} });
const RealtimeStatusContext = createContext<RealtimeStatus>('connecting');
export const useRealtime = () => useContext(RealtimeContext);
export const useRealtimeStatus = () => useContext(RealtimeStatusContext);

/** App-level heartbeat interval; a ping unanswered by the next tick = half-open → reconnect. */
const HEARTBEAT_MS = 20_000;
/** Reconnect attempts before the socket is considered offline (and surfaced to the user). */
const OFFLINE_AFTER_ATTEMPTS = 3;

export function RealtimeProvider(props: { children: ReactNode }) {
  const handlers = useRef<Map<string, Set<ChangeHandler>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const attempts = useRef(0);
  const stopped = useRef(false);
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  const activeChannels = useCallback(
    () => [...handlers.current.entries()].filter(([, s]) => s.size > 0).map(([c]) => c),
    [],
  );

  const pushSubscription = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', channels: activeChannels() }));
    }
  }, [activeChannels]);

  useEffect(() => {
    stopped.current = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let awaitingPong = false;

    const stopHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      awaitingPong = false;
    };

    const scheduleReconnect = () => {
      if (stopped.current) return;
      const n = attempts.current++;
      // Surface 'offline' only once reconnect keeps failing (e.g. a proxy blocking
      // the upgrade); a quick blip that recovers within a few tries never shows it.
      setStatus(n >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'connecting');
      const delay = Math.min(30_000, 1000 * 2 ** n);
      reconnectTimer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${window.location.host}/web/ws`);
      } catch {
        scheduleReconnect(); // construct threw — keep retrying instead of giving up silently
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attempts.current = 0;
        awaitingPong = false;
        setStatus('connected');
        pushSubscription();
        // App-level heartbeat: catches a HALF-OPEN socket (a proxy silently dropping
        // traffic) that never fires onclose. The server answers {type:'ping'} with
        // {type:'pong'}; any inbound frame counts as proof of life.
        stopHeartbeat();
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (awaitingPong) {
            try {
              ws.close(); // last ping went unanswered → force a reconnect
            } catch {
              /* ignore */
            }
            return;
          }
          try {
            ws.send(JSON.stringify({ type: 'ping' }));
            awaitingPong = true;
          } catch {
            /* ignore */
          }
        }, HEARTBEAT_MS);
      };
      ws.onmessage = (ev) => {
        awaitingPong = false; // any inbound frame proves the connection is alive
        let msg: { type?: string; channel?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'change' && typeof msg.channel === 'string') {
          handlers.current.get(msg.channel)?.forEach((h) => h());
        }
      };
      ws.onclose = () => {
        stopHeartbeat();
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped.current) return;
        scheduleReconnect();
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    };

    connect();
    return () => {
      stopped.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      stopHeartbeat();
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    };
  }, [pushSubscription]);

  const subscribe = useCallback(
    (channels: string[], handler: ChangeHandler) => {
      for (const c of channels) {
        let set = handlers.current.get(c);
        if (!set) {
          set = new Set();
          handlers.current.set(c, set);
        }
        set.add(handler);
      }
      pushSubscription();
      return () => {
        for (const c of channels) {
          const set = handlers.current.get(c);
          if (set) {
            set.delete(handler);
            if (set.size === 0) handlers.current.delete(c);
          }
        }
        pushSubscription();
      };
    },
    [pushSubscription],
  );

  const api = useMemo<RealtimeApi>(() => ({ subscribe }), [subscribe]);

  return (
    <RealtimeContext.Provider value={api}>
      <RealtimeStatusContext.Provider value={status}>{props.children}</RealtimeStatusContext.Provider>
    </RealtimeContext.Provider>
  );
}
