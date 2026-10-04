// ---------------------------------------------------------------------------
// project_policy_portal — the hosted project-policy plane's HTTP boundary:
// parses each /projects/* and /instance/pack-policy route and forwards it to
// the project policy orchestrator's workflows in ./policy.ts.
//
// A module of its own so the portal -> orchestrator hop is a real import edge.
// When the portal's methods were the orchestrator's own functions, every
// collaborator those functions reached (the policy store, the orchestrator's
// own audit and governing-profile helpers) counted as an undeclared hop of the
// portal.
// ---------------------------------------------------------------------------
import type { IncomingMessage, ServerResponse } from 'http';
import * as projectPolicyOrchestrator from './policy.js';
import { sendJson } from './httpio.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import type { HostConfig, InstancePackPolicy, ProjectInitRequest } from './types.js';

// Pure forwarding to the orchestrator functions in ./policy.ts. Rides the ADMIN-plane
// listener (mirroring identity-portal.ts), owning its own error → status mapping
// (401/403/404/400) so faults never fall through to the admin-plane catch. The
// pre-authorized entries (executeApprovedInit, evaluateInitRequest) are
// intentionally not exposed here. Called by http.ts when the admin listener sees
// a `/projects/*` or `/instance/*` path.

export function handlePolicyRequest(
  cfg: HostConfig,
  credential: string | null,
  req: IncomingMessage,
  res: ServerResponse,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any,
  url: URL,
): void {
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'projects') {
      // POST /projects/init
      if (req.method === 'POST' && parts.length === 2 && parts[1] === 'init') {
        return sendJson(res, 201, projectPolicyOrchestrator.initializeProjectWithProfile(cfg, credential, body as ProjectInitRequest));
      }
      // GET /projects/{id}/policy/evaluation
      if (req.method === 'GET' && parts.length === 4 && parts[2] === 'policy' && parts[3] === 'evaluation') {
        return sendJson(res, 200, projectPolicyOrchestrator.evaluateProjectPolicy(cfg, credential, parts[1]));
      }
      // POST /projects/{id}/policy/reconcile
      if (req.method === 'POST' && parts.length === 4 && parts[2] === 'policy' && parts[3] === 'reconcile') {
        return sendJson(res, 200, projectPolicyOrchestrator.reconcileProjectPolicy(cfg, credential, parts[1]));
      }
    }

    if (parts[0] === 'instance') {
      // GET /instance/pack-policy
      if (req.method === 'GET' && parts.length === 2 && parts[1] === 'pack-policy') {
        return sendJson(res, 200, projectPolicyOrchestrator.getPackPolicy(cfg, credential));
      }
      // PUT /instance/pack-policy
      if (req.method === 'PUT' && parts.length === 2 && parts[1] === 'pack-policy') {
        return sendJson(res, 200, projectPolicyOrchestrator.setPackPolicy(cfg, credential, body as InstancePackPolicy));
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    if (err instanceof ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|unknown project/i.test(msg)) return sendJson(res, 404, { error: msg });
    return sendJson(res, 400, { error: msg });
  }
}
