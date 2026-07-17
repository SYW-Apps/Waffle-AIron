import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react';

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

interface RealtimeApi {
  subscribe(channels: string[], handler: ChangeHandler): () => void;
}

const RealtimeContext = createContext<RealtimeApi>({ subscribe: () => () => {} });
export const useRealtime = () => useContext(RealtimeContext);

export function RealtimeProvider(props: { children: ReactNode }) {
  const handlers = useRef<Map<string, Set<ChangeHandler>>>(new Map());
  const wsRef = useRef<WebSocket | null>(null);
  const attempts = useRef(0);
  const stopped = useRef(false);

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

    const connect = () => {
      if (stopped.current) return;
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      let ws: WebSocket;
      try {
        ws = new WebSocket(`${proto}://${window.location.host}/web/ws`);
      } catch {
        return; // e.g. blocked — a later reconnect may succeed
      }
      wsRef.current = ws;
      ws.onopen = () => {
        attempts.current = 0;
        pushSubscription();
      };
      ws.onmessage = (ev) => {
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
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped.current) return;
        const delay = Math.min(30_000, 1000 * 2 ** attempts.current++);
        reconnectTimer = setTimeout(connect, delay);
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

  const apiRef = useRef<RealtimeApi>({ subscribe });
  apiRef.current.subscribe = subscribe;

  return <RealtimeContext.Provider value={apiRef.current}>{props.children}</RealtimeContext.Provider>;
}
