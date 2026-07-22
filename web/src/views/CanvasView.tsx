import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
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
export function CanvasView({
  projectId,
  route = '',
  unitPrefix = '',
}: {
  projectId: string;
  route?: string;
  /**
   * The owning org-unit path ('/'-joined, e.g. 'acme/finance', '' when unplaced),
   * prepended to every per-project URL this canvas pushes so the unit ancestry is
   * preserved across in-canvas drills. Passed verbatim (already `/`-joined).
   */
  unitPrefix?: string;
}) {
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

  const navigate = useNavigate();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<CanvasHandle | null>(null);
  const model = state.data;
  // The route we last synced with the engine (either seeded at mount, pushed to
  // the URL from an in-canvas drill, or applied from the URL). Used to skip
  // redundant openRoute calls and redundant history pushes — the engine already
  // suppresses the URL->engine->URL echo, this just avoids the extra churn.
  const lastRouteRef = useRef<string>(route);
  // Keep the freshest values reachable from the (mount-only) engine callback
  // without re-mounting on every route/nav change.
  const routeRef = useRef<string>(route);
  const projectIdRef = useRef<string>(projectId);
  const unitPrefixRef = useRef<string>(unitPrefix);
  routeRef.current = route;
  projectIdRef.current = projectId;
  unitPrefixRef.current = unitPrefix;

  // Mount (or remount) whenever a fresh model arrives; tear down on unmount.
  // NOTE: `route` is intentionally NOT a dependency — drill-down must not remount
  // the graph; it drives the engine via openRoute (the effect below) instead.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || model === undefined) return;
    lastRouteRef.current = routeRef.current;
    // embed: trims the classic chrome that's redundant inside the app (its own
    // brand mark + Theme toggle — the app owns both).
    const handle = mountCanvas(host, model, {
      shadow: true,
      theme: canvasTheme,
      vars: canvasVars,
      embed: true,
      // Stage J: seed the initial view from the URL route so a deep link renders
      // its scope immediately (no root-first flash).
      initialRoute: routeRef.current,
      // Stage J: push in-canvas navigation into the URL path. Only navigate when
      // the target differs from the current location (avoid redundant history).
      onViewChange: (r: string) => {
        const up = unitPrefixRef.current;
        const target =
          '/canvas/' + (up ? up + '/' : '') + encodeURIComponent(projectIdRef.current) + (r ? '/' + r : '');
        lastRouteRef.current = r;
        if (target !== window.location.pathname) navigate(target);
      },
      // "View OpenAPI" on an API-exposing component opens the project's full
      // (combined) surface as an interactive Swagger UI page. When the affordance
      // carries a tag (a specific portal's L0 gateway entry id) we deep-link to
      // that section; a subsystem/project passes '' and opens the whole document.
      onOpenApi: (tag?: string) =>
        window.open(
          `/web/openapi?projectId=${encodeURIComponent(projectIdRef.current)}` + (tag ? `#/${tag}` : ''),
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

  // Stage J: when the route changes from OUTSIDE the engine (browser back/forward,
  // a legacy redirect, or any external navigation), drive the mounted engine to
  // that view. Skipped when the route already matches what the engine reported —
  // and the engine suppresses the onViewChange echo, so there is no loop.
  useEffect(() => {
    if (route === lastRouteRef.current) return;
    lastRouteRef.current = route;
    handleRef.current?.openRoute(route);
  }, [route]);

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
