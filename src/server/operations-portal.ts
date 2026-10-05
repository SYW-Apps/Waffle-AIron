// ---------------------------------------------------------------------------
// operations_portal — the hosted operations plane's HTTP boundary: parses each
// /operations/* route and forwards it to the operations orchestrator's reads in
// ./operations.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrator's own functions, every
// collaborator those functions reached (diagnostics, quota rules) counted as an
// undeclared hop of the portal.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from 'http';
import * as operationsOrchestrator from './operations.js';
import { sendJson } from './httpio.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import type { HostConfig } from './types.js';

// Pure forwarding to the orchestrator functions in ./operations.ts. Rides the ADMIN-plane
// listener (mirroring identity-portal.ts / landscape-portal.ts), owning its own error → status
// mapping (401/403/404/400) so faults never fall through to the admin-plane
// catch. Endpoints match ioperations_portal exactly. Called by http.ts when the
// admin listener sees an `/operations/*` path AND the exposure policy enables it.

/**
 * Route one operations control-plane request to the orchestrator and write the
 * HTTP response. Read-only: three GET endpoints (health, usage, quota), each
 * taking an optional `scope` query selector.
 */
export function handleOperationsRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['operations', ...]
  const scope = url.searchParams.get('scope') ?? undefined;
  try {
    // GET /operations/health
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'health') {
      return sendJson(res, 200, operationsOrchestrator.getHealthReport(cfg, credential, scope));
    }
    // GET /operations/usage
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'usage') {
      return sendJson(res, 200, operationsOrchestrator.getUsage(cfg, credential, scope));
    }
    // GET /operations/quota
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'quota') {
      return sendJson(res, 200, operationsOrchestrator.evaluateQuota(cfg, credential, scope));
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}
