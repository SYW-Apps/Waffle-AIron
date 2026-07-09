import * as http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import { handleMcpRequest, handleViewDiagram, sendJson, bearerToken } from './request.js';
import * as admin from './admin.js';
import * as packs from './packs.js';
import * as identity from './identity.js';
import { AdminAuthError, LockValidationError } from './admin.js';
import type { HostConfig, Role } from './types.js';

// ---------------------------------------------------------------------------
// Host HTTP Portal + Host Server (sdd_host)
//
// Two separately-bound HTTP listeners: the public data plane (/mcp, /healthz,
// /readyz) and the admin plane (/admin/*, bound to localhost by default). The
// data plane routes to the request orchestrator; the admin plane routes to the
// admin orchestrator. host_server owns the listener lifecycle.
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

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

function routeData(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): void {
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
  if (req.method === 'POST' && url.pathname === '/mcp') {
    readBody(req)
      .then((body) => handleMcpRequest(cfg, req, res, body))
      .catch((err) => {
        if (!res.headersSent) sendJson(res, 500, { error: String(err) });
      });
    return;
  }
  sendJson(res, 404, { error: 'not found' });
}

// ── Admin plane ───────────────────────────────────────────────────────────

async function routeAdmin(cfg: HostConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const cred = bearerToken(req);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['admin', ...]
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = req.method === 'POST' || req.method === 'PUT' ? (await readBody(req)) ?? {} : {};

    // Identity control plane rides the admin listener in Phase 1 (see identity.ts).
    // It owns its own error → status mapping, so it returns before the admin catch.
    if (parts[0] === 'identity') {
      identity.handleIdentityRequest(cfg, cred, req, res, body, url);
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

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
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
