import { useEffect, useRef } from 'react';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { useSettings } from '../settings';
import { resolveMode } from '../theme/themes';
import { mountCanvas, type CanvasHandle } from '../canvas/engine';

/**
 * The architecture canvas, mounted directly in React (no iframe) from the shared
 * engine (web/src/canvas/engine.ts — the VERBATIM classic renderer). The engine
 * runs inside a shadow root so its classic CSS is isolated from the app shell,
 * and follows the app's light/dark appearance. Data comes from /web/canvas-model.
 */
export function CanvasView({ projectId }: { projectId: string }) {
  const state = useAsync<unknown>(
    () => get('/web/canvas-model?projectId=' + encodeURIComponent(projectId)),
    [projectId],
    [`project:${projectId}`, 'projects'],
  );
  const { appearance } = useSettings();
  // The classic engine ships a dark ('syw') and a 'light' theme; map the app's
  // resolved appearance onto them.
  const canvasTheme = resolveMode(appearance) === 'light' ? 'light' : 'syw';

  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const model = state.data;

  // Mount (or remount) whenever a fresh model arrives; tear down on unmount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || model === undefined) return;
    // embed: trims the classic chrome that's redundant inside the app (its own
    // brand mark + Theme toggle — the app owns both).
    const handle = mountCanvas(host, model, {
      shadow: true,
      theme: canvasTheme,
      embed: true,
      // "View OpenAPI" on an API-exposing component opens the project's full
      // surface as an interactive Swagger UI page.
      onOpenApi: () => window.open(`/web/openapi?projectId=${encodeURIComponent(projectId)}`, '_blank', 'noopener'),
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Follow the app theme without remounting the whole graph.
  useEffect(() => {
    handleRef.current?.setTheme(canvasTheme);
  }, [canvasTheme]);

  return (
    <AsyncView state={state}>
      {() => <div ref={hostRef} className="canvas-host" />}
    </AsyncView>
  );
}
