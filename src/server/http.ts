import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { handleMcpRequest, handleViewDiagram, sendJson, bearerToken } from './request.js';
import { handleWebRequest, sessionCookieValue, startDevSession, setSessionCookie } from './web.js';
import * as admin from './admin.js';
import * as packs from './packs.js';
import * as identity from './identity.js';
import * as selfservice from './selfservice.js';
import * as policy from './policy.js';
import * as landscape from './landscape.js';
import * as operations from './operations.js';
import { AdminAuthError, LockValidationError } from './admin.js';
import type { ApprovalDecision, HostConfig, HostExposurePolicy, Role } from './types.js';

// ---------------------------------------------------------------------------
// Host HTTP Portal + Host Server (sdd_host)
//
// Two separately-bound HTTP listeners: the public data plane (/mcp, /healthz,
// /readyz) and the admin plane (/admin/*, bound to localhost by default). The
// data plane routes to the request orchestrator; the admin plane routes to the
// admin orchestrator. host_server owns the listener lifecycle.
// ---------------------------------------------------------------------------

// ── Request body size cap (Fix S3) ──────────────────────────────────────────
//
// readBody runs on the public data plane (/mcp binds 0.0.0.0) BEFORE any
// authentication, so an unauthenticated client could stream an unbounded body
// and exhaust process memory. Cap the accumulated body: short-circuit an
// oversize Content-Length header, and stop buffering the moment the streamed
// bytes exceed the limit. Both cases reject with PayloadTooLargeError, which the
// route handlers map to HTTP 413. Breaking out of the read loop pauses the
// request stream, so TCP backpressure bounds any further buffering; the socket
// is left intact so the 413 response can be delivered.
const MAX_BODY_BYTES = 8 * 1024 * 1024; // 8 MB

/** Thrown by readBody when a request body exceeds MAX_BODY_BYTES (by declared
 *  Content-Length or by streamed bytes). Route handlers map it to HTTP 413. */
export class PayloadTooLargeError extends Error {
  constructor(message = `request body exceeds the maximum allowed size of ${MAX_BODY_BYTES} bytes`) {
    super(message);
    this.name = 'PayloadTooLargeError';
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  // Short-circuit an oversize declared Content-Length before reading a byte.
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    const chunk = c as Buffer;
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      // Stop accumulating immediately; throwing settles this promise once and
      // exits the loop (pausing the stream) so we never buffer the whole body.
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export { MAX_BODY_BYTES, readBody };

function diagramContentType(format: string): string {
  switch (format) {
    case 'canvas': return 'text/html; charset=utf-8';
    case 'mermaid': return 'text/markdown; charset=utf-8';
    case 'drawio': return 'application/xml; charset=utf-8';
    case 'excalidraw': return 'application/json; charset=utf-8';
    default: return 'text/plain; charset=utf-8';
  }
}

function diagramFileName(format: string): string {
  switch (format) {
    case 'canvas': return 'canvas.html';
    case 'mermaid': return 'diagram.md';
    case 'drawio': return 'architecture.drawio';
    case 'excalidraw': return 'architecture.excalidraw';
    default: return 'diagram.txt';
  }
}

// ── Data plane ────────────────────────────────────────────────────────────
//
// The data-plane auth bridge: a credential is `bearerToken(req) ?? the wairon_session
// cookie`, so a browser session drives /mcp exactly like a bearer. CSRF defense:
// SameSite=Lax already blocks the cookie on cross-site POSTs, and — for a
// COOKIE-authenticated state-changing request (POST /mcp, POST /web/logout,
// POST /web/logout-all) — we additionally REQUIRE the custom `X-Wairon-Web: 1`
// header (a cross-site HTML form cannot set it; a same-origin fetch can). BEARER
// requests carry no ambient cookie and are EXEMPT; GET requests are exempt; the SSO
// callback (a GET top-level nav) is protected by the signed SSO state.

/** True when the request carries the custom `X-Wairon-Web: 1` CSRF header. */
function webCsrfHeaderPresent(req: IncomingMessage): boolean {
  const h = req.headers['x-wairon-web'];
  return (Array.isArray(h) ? h[0] : h) === '1';
}

export function routeData(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/readyz') {
    let ready = false;
    try {
      fs.accessSync(cfg.dataDir, fs.constants.W_OK);
      ready = true;
    } catch {
      /* not writable */
    }
    sendJson(res, ready ? 200 : 503, { ready });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/view/diagram') {
    handleViewDiagram(cfg, req, res);
    return;
  }

  // Auth bridge: prefer a bearer; fall back to the session cookie. A request is
  // "cookie-authenticated" only when there is no bearer but there IS a session
  // cookie (an ambient credential a cross-site request could ride).
  const bearer = bearerToken(req);
  const cookie = sessionCookieValue(req);
  const credential = bearer ?? cookie;
  const cookieAuth = !bearer && !!cookie;

  if (req.method === 'POST' && url.pathname === '/mcp') {
    // CSRF: a cookie-authenticated mutation must carry the custom header.
    if (cookieAuth && !webCsrfHeaderPresent(req)) {
      sendJson(res, 403, { error: 'missing X-Wairon-Web header' });
      return;
    }
    readBody(req)
      .then((body) => handleMcpRequest(cfg, req, res, body, credential))
      .catch((err) => {
        if (res.headersSent) return;
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      });
    return;
  }

  // Unified web UI (opt-in): the app shell at '/' and the thin /web/* routes.
  const isWebPath =
    url.pathname === '/' || url.pathname === '/web' || url.pathname.startsWith('/web/');
  if (isWebPath) {
    const exposure = resolveExposurePolicy(cfg);
    // LOCAL DEV MODE (`wairon dev`, strictly cfg.devMode): the web UI is always on,
    // regardless of the exposure policy — the dev server is loopback-bound with auth
    // off. In every other (hosted) mode NOTHING here changes: devMode is never set by
    // `serve`, so this whole branch of dev behavior is entirely absent in production.
    const devMode = cfg.devMode === true;
    // OPT-IN (hosted): every /web path and the app shell answer 404 unless enabled —
    // so an existing instance (compatible default) is entirely unaffected.
    if (!exposure.webUiEnabled && !devMode) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // /web/dev-login is a DEV-ONLY route: in any non-devMode server it does not exist
    // (404), so the hosted UI never exposes the unauthenticated dev-session mint.
    if (url.pathname === '/web/dev-login' && !devMode) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // CSRF: cookie-authenticated state-changing web routes require the header.
    const isCookieMutation =
      req.method === 'POST' &&
      (url.pathname === '/web/logout' || url.pathname === '/web/logout-all');
    if (isCookieMutation && cookieAuth && !webCsrfHeaderPresent(req)) {
      sendJson(res, 403, { error: 'missing X-Wairon-Web header' });
      return;
    }
    const secureCookie = exposure.requireTls;

    // DEV auto-login (strictly devMode): on a cookieless GET, transparently establish
    // the local-developer session and install the cookie inline BEFORE dispatch, so
    // the REUSED client lands signed-in and never sees a 401 / login screen. Excludes
    // /web/dev-login itself (that route mints + redirects on its own). Never runs in
    // hosted mode — so a hosted server sets no session cookie here.
    let sessionCredential = credential;
    if (devMode && req.method === 'GET' && !cookie && url.pathname !== '/web/dev-login') {
      const devSessionId = startDevSession(cfg);
      res.setHeader('set-cookie', setSessionCookie(devSessionId, secureCookie));
      sessionCredential = devSessionId;
    }

    const proceed = (body: unknown): Promise<void> =>
      handleWebRequest(cfg, req, res, body, url, { sessionId: sessionCredential, secureCookie });
    (req.method === 'POST' ? readBody(req) : Promise.resolve(undefined))
      .then(proceed)
      .catch((err) => {
        if (res.headersSent) return;
        if (err instanceof PayloadTooLargeError) {
          sendJson(res, 413, { error: err.message });
        } else {
          sendJson(res, 500, { error: String(err) });
        }
      });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

// ── Control-plane exposure policy ───────────────────────────────────────────
//
// HostExposurePolicy governs which control-plane surfaces the admin listener
// mounts over HTTP. The COMPATIBLE default keeps current behavior for existing
// deployments — every surface on, admin API in loopback-only mode — so an
// instance with no policy configured behaves exactly as before. An explicit
// policy overrides it flag-by-flag: only what a policy DISABLES is gated off.
//
// Phase 5b policy source (smallest honest mechanism): an already-plumbed
// HostConfig.exposurePolicy wins; otherwise an optional JSON file
// <dataDir>/exposure-policy.json is read (a partial object is fine — its flags
// override the compatible default). Env/flag plumbing can come later.

/** The compatible default: everything mounted on the loopback admin listener,
 *  matching pre-exposure-policy behavior. */
const COMPATIBLE_DEFAULT_EXPOSURE: HostExposurePolicy = {
  adminApiMode: 'local_only',
  adminUiEnabled: true,
  identityApiEnabled: true,
  landscapeApiEnabled: true,
  projectPolicyApiEnabled: true,
  cliControlEnabled: true,
  requireTls: true,
  operationsApiEnabled: true,
  // The unified web UI is a NEW public surface on the data plane, so it is
  // OPT-IN: false here keeps existing instances unaffected (every /web path and
  // the app shell answer 404 until an operator turns it on).
  webUiEnabled: false,
};

/** Read an optional <dataDir>/exposure-policy.json override (a partial policy);
 *  absent/malformed yields undefined so the compatible default stands. */
function readExposurePolicyFile(dataDir: string): Partial<HostExposurePolicy> | undefined {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'exposure-policy.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Partial<HostExposurePolicy>) : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the effective exposure policy: an explicit HostConfig.exposurePolicy
 *  or the <dataDir>/exposure-policy.json override, merged OVER the compatible
 *  default so unset flags keep current (mounted) behavior. */
export function resolveExposurePolicy(cfg: HostConfig): HostExposurePolicy {
  const override = cfg.exposurePolicy ?? readExposurePolicyFile(cfg.dataDir);
  return { ...COMPATIBLE_DEFAULT_EXPOSURE, ...(override ?? {}) };
}

// ── Admin plane ───────────────────────────────────────────────────────────

export async function routeAdmin(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cred = bearerToken(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['admin', ...]
  const exposure = resolveExposurePolicy(cfg);
  try {
    // adminApiMode 'disabled' → nothing on the admin listener is mounted; every
    // surface (admin API, identity, policy, landscape, operations, approvals,
    // UI) answers 404. The data plane rides a separate listener, unaffected.
    if (exposure.adminApiMode === 'disabled') {
      return sendJson(res, 404, { error: 'not found' });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = req.method === 'POST' || req.method === 'PUT' ? (await readBody(req)) ?? {} : {};

    // Identity control plane rides the admin listener behind identityApiEnabled
    // (see identity.ts). It owns its own error → status mapping, so it returns
    // before the admin catch. A disabled flag answers 404 (surface not mounted).
    if (parts[0] === 'identity') {
      if (!exposure.identityApiEnabled) return sendJson(res, 404, { error: 'not found' });
      identity.handleIdentityRequest(cfg, cred, req, res, body, url);
      return;
    }

    // Project policy control plane (Phase 3) rides the admin listener behind
    // projectPolicyApiEnabled. It handles the bare /projects/init +
    // /projects/{id}/policy/* and /instance/pack-policy routes only — NOT
    // /admin/projects (parts[0] here is 'projects', never 'admin', so the admin
    // project block below is never shadowed). Owns its own error → status
    // mapping, returning before the admin catch.
    if (parts[0] === 'projects' || parts[0] === 'instance') {
      if (!exposure.projectPolicyApiEnabled) return sendJson(res, 404, { error: 'not found' });
      policy.handlePolicyRequest(cfg, cred, req, res, body, url);
      return;
    }

    // Landscape control plane (Phase 4) rides the admin listener behind
    // landscapeApiEnabled. It owns its own error → status mapping, returning
    // before the admin catch. parts[0] here is 'landscape', never 'admin', so the
    // admin blocks below are never shadowed.
    if (parts[0] === 'landscape') {
      if (!exposure.landscapeApiEnabled) return sendJson(res, 404, { error: 'not found' });
      landscape.handleLandscapeRequest(cfg, cred, req, res, body, url);
      return;
    }

    // Operations control plane (Phase 5b) rides the admin listener behind
    // operationsApiEnabled. Read-only health/usage/quota; owns its own error →
    // status mapping, returning before the admin catch. parts[0] here is
    // 'operations', never 'admin', so the admin blocks below are never shadowed.
    if (parts[0] === 'operations') {
      if (!exposure.operationsApiEnabled) return sendJson(res, 404, { error: 'not found' });
      operations.handleOperationsRequest(cfg, cred, req, res, url);
      return;
    }

    if (parts[1] === 'projects') {
      if (req.method === 'GET' && parts.length === 2) return sendJson(res, 200, admin.listProjects(cfg, cred));
      if (req.method === 'POST' && parts.length === 2) return sendJson(res, 201, admin.createProject(cfg, cred, body.id));
      if (req.method === 'DELETE' && parts.length === 3) {
        admin.destroyProject(cfg, cred, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'lock') return sendJson(res, 200, admin.lockProject(cfg, cred, parts[2]));
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'promote') return sendJson(res, 200, admin.promoteProject(cfg, cred, parts[2]));
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'git') return sendJson(res, 201, admin.enableGit(cfg, cred, parts[2], body.remote, body.branch ?? 'main'));
      if (req.method === 'DELETE' && parts.length === 4 && parts[3] === 'git') {
        admin.disableGit(cfg, cred, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts.length === 5 && parts[3] === 'git' && parts[4] === 'sync') {
        admin.syncGit(cfg, cred, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'producers') return sendJson(res, 200, admin.listProducers(cfg, cred, parts[2]));
      if (req.method === 'POST' && parts.length === 5 && parts[3] === 'producers') {
        admin.configureProducer(cfg, cred, parts[2], parts[4], body.parentPageId);
        return sendJson(res, 201, { ok: true });
      }
      if (req.method === 'DELETE' && parts.length === 5 && parts[3] === 'producers') {
        admin.removeProducer(cfg, cred, parts[2], parts[4]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts.length === 6 && parts[3] === 'producers' && parts[5] === 'produce') {
        await admin.produceProducer(cfg, cred, parts[2], parts[4]);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'canvas-link') {
        return sendJson(res, 200, { url: admin.diagramViewLink(cfg, cred, parts[2]) });
      }
      if (req.method === 'POST' && parts.length === 4 && parts[3] === 'diagram') {
        const format = (body.format as string) ?? 'canvas';
        const artifact = admin.generateDiagram(cfg, cred, parts[2], format);
        res.writeHead(200, { 'content-type': diagramContentType(format) });
        res.end(artifact);
        return;
      }
      if (req.method === 'GET' && parts.length === 5 && parts[3] === 'diagram') {
        const format = parts[4];
        const artifact = admin.downloadDiagram(cfg, cred, parts[2], format);
        res.writeHead(200, {
          'content-type': diagramContentType(format),
          'content-disposition': `attachment; filename="${diagramFileName(format)}"`,
        });
        res.end(artifact);
        return;
      }
      if (req.method === 'GET' && parts.length === 4 && parts[3] === 'packs') return sendJson(res, 200, packs.listProjectPacks(cfg, cred, parts[2]));
      if (req.method === 'PUT' && parts.length === 5 && parts[3] === 'packs') return sendJson(res, 200, packs.installProjectPack(cfg, cred, parts[2], parts[4], body.content));
      if (req.method === 'DELETE' && parts.length === 5 && parts[3] === 'packs') {
        packs.removeProjectPack(cfg, cred, parts[2], parts[4]);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'packs') {
      if (req.method === 'GET' && parts.length === 2) return sendJson(res, 200, packs.listGlobalPacks(cfg, cred));
      if (req.method === 'PUT' && parts.length === 3) return sendJson(res, 200, packs.installGlobalPack(cfg, cred, parts[2], body.content));
      if (req.method === 'DELETE' && parts.length === 3) {
        packs.removeGlobalPack(cfg, cred, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'keys') {
      if (req.method === 'GET' && parts.length === 2) return sendJson(res, 200, admin.listKeys(cfg, cred, url.searchParams.get('project') ?? '*'));
      if (req.method === 'POST' && parts.length === 2) return sendJson(res, 201, { key: admin.mintKey(cfg, cred, body.project, (body.role ?? 'editor') as Role) });
      if (req.method === 'DELETE' && parts.length === 3) {
        admin.revokeKey(cfg, cred, parts[2]);
        return sendJson(res, 200, { ok: true });
      }
    }

    if (parts[1] === 'secrets') {
      if (req.method === 'GET' && parts.length === 2) return sendJson(res, 200, { keys: admin.listSecrets(cfg, cred) });
      if (req.method === 'PUT' && parts.length === 3) {
        admin.setSecret(cfg, cred, parts[2], body.value);
        return sendJson(res, 200, { ok: true });
      }
    }

    // ── Approval decision surface (Phase 2) ────────────────────────────────
    // The human decision surface for approval-backed self-service until the admin
    // UI lands: iadmin_portal.listApprovals/decideApproval/executeApproval forward
    // 1:1 to the self-service orchestrator (admin_portal_impl → listPendingRequests
    // / decideRequest / executeApprovedRequest). Owns its own error → status mapping
    // (401/403/404/400), mirroring the identity mount, so approval faults never fall
    // through to the admin catch (which maps only AdminAuthError/LockValidationError).
    if (parts[1] === 'approvals') {
      try {
        // GET /admin/approvals?status=&project=
        if (req.method === 'GET' && parts.length === 2) {
          // L3 (iadmin_portal.listApprovals) advertises a `status` filter, but the
          // self_service_orchestrator contract only lists PENDING requests this
          // phase (admin_portal_impl → listPendingRequests). Accept status=pending
          // explicitly and pass `project` through; reject any other status until
          // broader listing lands rather than silently returning pending-only.
          const status = url.searchParams.get('status');
          if (status !== null && status !== 'pending') {
            return sendJson(res, 400, {
              error: `unsupported status "${status}": only pending approvals can be listed in this phase`,
            });
          }
          return sendJson(res, 200, selfservice.listPendingRequests(cfg, cred, url.searchParams.get('project') ?? undefined));
        }
        // POST /admin/approvals/{id}/decision  { approved: boolean, reason?: string }
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'decision') {
          if (typeof body.approved !== 'boolean') {
            return sendJson(res, 400, { error: '`approved` must be a boolean' });
          }
          // decidedBy/decidedAt are server-authoritative: decideRequest overwrites
          // both from the authenticated caller (the client value is never trusted),
          // so these are ignored placeholders the ApprovalDecision type requires.
          const decision: ApprovalDecision = {
            requestId: parts[2],
            approved: body.approved,
            decidedBy: { userId: '', kind: 'service', issuer: 'local' },
            decidedAt: '',
          };
          if (typeof body.reason === 'string') decision.reason = body.reason;
          return sendJson(res, 200, selfservice.decideRequest(cfg, cred, decision));
        }
        // POST /admin/approvals/{id}/execute
        if (req.method === 'POST' && parts.length === 4 && parts[3] === 'execute') {
          return sendJson(res, 200, { outcome: selfservice.executeApprovedRequest(cfg, cred, parts[2]) });
        }
        return sendJson(res, 404, { error: 'not found' });
      } catch (err) {
        if (err instanceof identity.UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
        if (err instanceof identity.ForbiddenError) return sendJson(res, 403, { error: 'forbidden' });
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found/i.test(msg)) return sendJson(res, 404, { error: msg });
        return sendJson(res, 400, { error: msg });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return sendJson(res, 413, { error: err.message });
    if (err instanceof identity.UnauthenticatedError) return sendJson(res, 401, { error: 'unauthorized' });
    // Scope denials from the Phase 6 admin lifecycle throw ForbiddenError; map it
    // to 403 like every other plane (AdminAuthError stays 403 for compatibility).
    if (err instanceof identity.ForbiddenError) return sendJson(res, 403, { error: err.message });
    if (err instanceof AdminAuthError) return sendJson(res, 403, { error: 'forbidden' });
    if (err instanceof LockValidationError) return sendJson(res, 409, { error: err.message, errors: err.errors });
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export interface HostServerHandle {
  close(): void;
}

/** Bind the data-plane and admin-plane listeners and begin accepting connections. */
/** The literal placeholder shipped in .env.example — never a real credential. */
export const PLACEHOLDER_ADMIN_TOKEN = 'replace-with-a-random-64-hex-character-token';
/** Shortest admin token we accept; anything below this is trivially guessable. */
export const MIN_ADMIN_TOKEN_LENGTH = 16;

export function startHostServer(cfg: HostConfig): HostServerHandle {
  if (cfg.authEnabled) {
    const adminToken = process.env['WAIRON_ADMIN_TOKEN'];
    if (!adminToken) {
      throw new Error(
        'Refusing to start: auth is enabled but WAIRON_ADMIN_TOKEN is not set, so the admin ' +
          'API would be unreachable and no keys could be minted. Set WAIRON_ADMIN_TOKEN, or pass ' +
          '--no-auth for a trusted network.',
      );
    }
    // Reject the shipped placeholder and trivially-short tokens: copying
    // .env.example without editing it would otherwise run the admin API with a
    // publicly known master credential.
    if (adminToken === PLACEHOLDER_ADMIN_TOKEN || adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
      throw new Error(
        'Refusing to start: WAIRON_ADMIN_TOKEN is the example placeholder or too weak ' +
          `(must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters and not the shipped default). ` +
          'Generate a strong one with `openssl rand -hex 32`.',
      );
    }
  }
  const dataServer = http.createServer((req, res) => routeData(cfg, req, res));
  const adminServer = http.createServer((req, res) => {
    void routeAdmin(cfg, req, res);
  });
  dataServer.listen(cfg.port, cfg.host);
  adminServer.listen(cfg.adminPort, cfg.adminHost);
  return {
    close() {
      dataServer.close();
      adminServer.close();
    },
  };
}
