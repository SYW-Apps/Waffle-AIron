import { useEffect, useRef } from 'react';
import { useRealtimeStatus } from './realtime';
import { useToast } from './ui';

/**
 * A small connection-status pill for the app chrome. Shows whether realtime
 * updates are live, and toasts once when the socket goes offline (sustained
 * reconnect failure — most often a reverse proxy not forwarding the WebSocket
 * upgrade) and once when it recovers. Purely informational: the app stays fully
 * usable read-only either way (views load over REST, independent of the socket).
 */
export function RealtimeStatus() {
  const status = useRealtimeStatus();
  const toast = useToast();
  const wasOffline = useRef(false);

  useEffect(() => {
    if (status === 'offline' && !wasOffline.current) {
      wasOffline.current = true;
      toast.bad(
        "Realtime updates are offline — views won't auto-refresh. If this instance is behind a reverse proxy, it must forward WebSocket upgrades to /web/ws.",
      );
    } else if (status === 'connected' && wasOffline.current) {
      wasOffline.current = false;
      toast.ok('Realtime updates reconnected.');
    }
  }, [status, toast]);

  const label = status === 'connected' ? 'Live' : status === 'connecting' ? 'Connecting…' : 'Offline';
  const title =
    status === 'offline'
      ? 'Realtime updates are offline — the view will not auto-refresh. If this instance is behind a reverse proxy (e.g. NGINX), ensure it forwards the WebSocket Upgrade/Connection headers to /web/ws.'
      : status === 'connecting'
        ? 'Connecting to realtime updates…'
        : 'Realtime updates are live.';

  return (
    <span className={`rt-status rt-${status}`} title={title} role="status" aria-live="polite">
      <span className="rt-dot" aria-hidden="true" />
      <span className="rt-label">{label}</span>
    </span>
  );
}
