import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Portal mounts — which listener serves which portal.
//
// A portal's routes are its methods' endpoint bindings, but those never said
// which LISTENER hands the portal its requests. While that was unmodelled, the
// call that mounts a portal crossed a boundary no contract described, a portal
// no listener served was unreachable with nobody noticing, and a route that
// belonged to no contract had nowhere to be missed from. A listener Portal now
// declares `mounts`, and this rule holds the declaration to the tree.
//
// Three decisions shape it:
//
//  1. PREFIX MEANS PATH SEGMENTS, not characters. A path lies under a prefix
//     when it EQUALS it or continues it past a slash — so `/web` covers
//     `/web/admin` but not `/webhooks`, and `/` covers the root and nothing
//     else (`'/' + '/'` is `'//'`). An app shell at `GET /` is mounted by
//     naming `/` without that mount swallowing every other route.
//
//  2. ONLY HTTP IS JUDGED. Prefixes are HTTP paths; an MCP, gRPC or Custom
//     portal is served by whatever speaks that transport, which a path prefix
//     cannot describe, so such endpoints are neither covered nor uncovered.
//
//  3. THE FIELD MARKS THE LISTENER. A listener is the one kind of portal the
//     host starts directly rather than something else serving it, so a portal
//     declaring `mounts` — even empty — is exempt from UNMOUNTED_PORTAL. One
//     portal may be mounted by several listeners; each mount is judged against
//     its own prefixes, and any one of them makes the portal reachable.
//
// Whether the router entry a mount names (`via`) is really exported is the
// code's question, and export-conformance asks it.
// ---------------------------------------------------------------------------

/** Whether `path` lies under `prefix`: equal to it, or continuing it past a slash. */
function liesUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + '/');
}

export const portalMountsRule: SddRule = {
  name: 'portal-mounts',
  description:
    'Which listener serves which portal: a portal\'s routes are its methods\' endpoint bindings, but nothing said which listener hands it its requests, so a portal no listener serves was unreachable without anyone noticing, and the call that mounts one crossed a boundary no contract described. A listener Portal declares its mounts — each a portal, the path prefixes routed to it, and optionally the router entry it calls — and this rule checks them against the tree: a mount must name a Portal, every HTTP endpoint of a mounted portal must lie under one of its prefixes, and every portal with HTTP endpoints must be mounted by some listener unless it is one. A path lies under a prefix when it equals it or continues it past a slash, so `/` covers only the root. Whether the named entry is really exported is the code\'s question, and export-conformance asks it.',
  codes: [
    {
      code: 'MOUNT_TARGET_NOT_PORTAL',
      defaultSeverity: 'error',
      summary: 'A listener mounts something that is not a Portal — an unknown component, or one whose type cannot serve routes',
    },
    {
      code: 'ENDPOINT_OUTSIDE_MOUNT',
      defaultSeverity: 'warning',
      summary: 'A mounted portal declares an HTTP endpoint under none of the prefixes its listener routes to it — a route the contract promises that no request can reach',
    },
    {
      code: 'UNMOUNTED_PORTAL',
      defaultSeverity: 'warning',
      summary: 'A portal declares HTTP endpoints but no listener mounts it and it declares no mounts of its own — a whole surface nothing serves',
    },
  ],
  check(ctx) {
    // The HTTP routes each portal's contracts promise, method by method.
    const httpRoutesOf = (compId: string): { method: string; verb: string; path: string }[] => {
      const routes: { method: string; verb: string; path: string }[] = [];
      for (const method of ctx.interfaceMethodsOf(compId)) {
        const ep = method.endpoint;
        if (ep?.transport === 'HTTP') routes.push({ method: method.name, verb: ep.method, path: ep.path });
      }
      return routes;
    };

    // Every portal some listener's mount names, whatever its prefixes — any
    // one listener serving it makes it reachable.
    const mounted = new Set<string>();

    // ---- 1. each mount each listener declares ----
    for (const listener of ctx.components) {
      if (listener.componentType !== 'Portal' || !listener.mounts) continue;
      const listenerDraft = ctx.isComponentDraft(listener.id);

      for (const mount of listener.mounts) {
        const target = ctx.componentMap.get(mount.portal);

        // ---- 2/3. a mount must name something that can serve routes ----
        if (!target || target.componentType !== 'Portal') {
          ctx.addIssue(
            'error',
            'MOUNT_TARGET_NOT_PORTAL',
            target
              ? `Listener "${listener.id}" mounts "${mount.portal}" under ${mount.prefixes.map(p => `"${p}"`).join(', ') || 'no prefixes'}, but "${target.id}" is a ${target.componentType} — only a Portal serves routes, so this mount routes requests to nothing.`
              : `Listener "${listener.id}" mounts "${mount.portal}" under ${mount.prefixes.map(p => `"${p}"`).join(', ') || 'no prefixes'}, but no component "${mount.portal}" exists — this mount routes requests to nothing.`,
            listener.id,
            listenerDraft || (target ? ctx.isComponentDraft(target.id) : false),
          );
          continue;
        }
        mounted.add(target.id);

        // ---- 4. every HTTP route of the mounted portal under one of its prefixes ----
        for (const route of httpRoutesOf(target.id)) {
          if (mount.prefixes.some(prefix => liesUnder(route.path, prefix))) continue;
          ctx.addIssue(
            'warning',
            'ENDPOINT_OUTSIDE_MOUNT',
            `Portal "${target.id}" binds "${route.method}" to ${route.verb} ${route.path}, but listener "${listener.id}" routes it only ${mount.prefixes.map(p => `"${p}"`).join(', ') || 'no prefixes at all'} — a route the contract promises that no request through this listener can reach. A path lies under a prefix when it equals it or continues it past a slash. Add the prefix to the mount, or move the endpoint under one it already routes.`,
            listener.id,
            listenerDraft || ctx.isComponentDraft(target.id),
          );
        }
      }
    }

    // ---- 5. every HTTP portal is a listener or mounted by one ----
    for (const portal of ctx.components) {
      if (portal.componentType !== 'Portal') continue;
      if (portal.mounts !== undefined || mounted.has(portal.id)) continue;
      const routes = httpRoutesOf(portal.id);
      if (routes.length === 0) continue;
      ctx.addIssue(
        'warning',
        'UNMOUNTED_PORTAL',
        `Portal "${portal.id}" declares ${routes.length} HTTP endpoint(s), but no listener mounts it and it declares no mounts of its own — a whole surface nothing serves. Mount it on the listener that routes its requests, or, if it IS a listener the host starts directly, declare its mounts (an empty list says it serves only its own routes).`,
        portal.id,
        ctx.isComponentDraft(portal.id),
      );
    }
    // ---- 6. every mount checked and every HTTP portal accounted for ----
  },
};
