import { useEffect, useMemo, useRef } from 'react';
import { get } from '../api';
import { AsyncView, useAsync } from '../ui';
import { useSettings } from '../settings';
import { engineTheme, engineVars } from '../theme/canvasBridge';
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
  const { themeId, appearance } = useSettings();
  // The classic engine ships a dark ('syw') and a 'light' theme for its
  // semantic content colors; the SELECTED app palette is overlaid on the
  // chrome via CSS-variable overrides.
  const canvasTheme = engineTheme(appearance);
  const canvasVars = useMemo(() => engineVars(themeId, appearance), [themeId, appearance]);

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
      vars: canvasVars,
      embed: true,
      // "View OpenAPI" on an API-exposing component opens the project's full
      // (combined) surface as an interactive Swagger UI page. When the affordance
      // carries a tag (a specific portal's L0 gateway entry id) we deep-link to
      // that section; a subsystem/project passes '' and opens the whole document.
      onOpenApi: (tag?: string) =>
        window.open(
          `/web/openapi?projectId=${encodeURIComponent(projectId)}` + (tag ? `#/${tag}` : ''),
          '_blank',
          'noopener',
        ),
    });
    handleRef.current = handle;
    return () => {
      handle.destroy();
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  // Follow the app theme (palette + appearance) without remounting the graph.
  useEffect(() => {
    handleRef.current?.setTheme(canvasTheme, canvasVars);
  }, [canvasTheme, canvasVars]);

  return (
    <AsyncView state={state}>
      {() => <div ref={hostRef} className="canvas-host" />}
    </AsyncView>
  );
}
