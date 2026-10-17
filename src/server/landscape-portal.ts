// ---------------------------------------------------------------------------
// landscape_portal — the hosted landscape's HTTP boundary: parses each
// /landscape/* route and forwards it to the landscape and surface-exchange
// workflows in ./landscape.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrators' own functions, every
// collaborator those functions reached (the landscape graph builder) counted as
// an undeclared hop of the portal.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from 'http';
import * as landscapeOrchestrator from './landscape.js';
import { sendJson } from './httpio.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import type { HostConfig, OrganizationUnitRecord, ProjectPlacement, ProjectRelationRecord } from './types.js';

// Pure forwarding to the orchestrator functions in ./landscape.ts. Rides the ADMIN-plane
// listener (mirroring identity-portal.ts / policy-portal.ts), owning its own error → status
// mapping (401/403/404/400) so faults never fall through to the admin-plane catch.
// Endpoints match ilandscape_portal exactly. Called by http.ts when the admin
// listener sees a `/landscape/*` path.

export function handleLandscapeRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['landscape', ...]
  try {
    if (parts[1] === 'units') {
      // PUT /landscape/units/{id} — the path segment IS the qualified dot-path
      // id. When the body carries no slug/parent, derive them from the id (its
      // last dot-segment / its prefix) so the PUT-by-id shape works unchanged
      // under qualified ids.
      if (req.method === 'PUT' && parts.length === 3) {
        const qualifiedId = parts[2];
        const unit = { ...(body as OrganizationUnitRecord), id: qualifiedId };
        if (!unit.slug) unit.slug = qualifiedId.split('.').pop() ?? qualifiedId;
        const lastDot = qualifiedId.lastIndexOf('.');
        if (unit.parentId === undefined && lastDot > 0) unit.parentId = qualifiedId.slice(0, lastDot);
        return sendJson(res, 200, landscapeOrchestrator.upsertUnit(cfg, credential, unit));
      }
    }

    if (parts[1] === 'projects') {
      // PUT /landscape/projects/{id}/placements/{unitId}
      if (req.method === 'PUT' && parts.length === 5 && parts[3] === 'placements') {
        const placement = { ...(body as ProjectPlacement), projectId: parts[2], unitId: parts[4] };
        return sendJson(res, 200, landscapeOrchestrator.placeProject(cfg, credential, placement));
      }
      // POST /landscape/projects/{id}/public-surface/refresh
      if (req.method === 'POST' && parts.length === 5 && parts[3] === 'public-surface' && parts[4] === 'refresh') {
        return sendJson(res, 200, landscapeOrchestrator.refreshPublicSurface(cfg, credential, parts[2]));
      }
      // GET /landscape/projects/{id}/visible-surfaces
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'visible-surfaces') {
        return sendJson(res, 200, landscapeOrchestrator.listVisibleSurfaces(cfg, credential, parts[2]));
      }
      // GET /landscape/projects/{id}/surface?format=native|openapi&audience=<level>&spec=<portalId>
      // Generate-and-download (the diagram pattern) — never a served UI. `spec`
      // picks ONE of a multi-portal project's per-portal OpenAPI documents.
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'surface') {
        const artifact = landscapeOrchestrator.exportProjectSurface(
          cfg,
          credential,
          parts[2],
          url.searchParams.get('format') ?? 'native',
          url.searchParams.get('audience') ?? 'instance',
          url.searchParams.get('spec') ?? undefined,
        );
        res.writeHead(200, {
          'content-type': artifact.contentType,
          'content-disposition': `attachment; filename="${artifact.filename}"`,
        });
        res.end(artifact.body);
        return;
      }
    }

    if (parts[1] === 'relations') {
      // GET /landscape/relations?project=
      if (req.method === 'GET' && parts.length === 2) {
        return sendJson(res, 200, landscapeOrchestrator.listRelations(cfg, credential, url.searchParams.get('project') ?? undefined));
      }
      // PUT /landscape/relations/{id}
      if (req.method === 'PUT' && parts.length === 3) {
        const relation = { ...(body as ProjectRelationRecord), id: parts[2] };
        return sendJson(res, 200, landscapeOrchestrator.upsertRelation(cfg, credential, relation));
      }
      // DELETE /landscape/relations/{id}
      if (req.method === 'DELETE' && parts.length === 3) {
        landscapeOrchestrator.removeRelation(cfg, credential, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
    }

    // GET /landscape/graph?scope=
    if (req.method === 'GET' && parts[1] === 'graph' && parts.length === 2) {
      return sendJson(res, 200, landscapeOrchestrator.generateLandscape(cfg, credential, url.searchParams.get('scope') ?? undefined));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|unknown project|does not exist/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
