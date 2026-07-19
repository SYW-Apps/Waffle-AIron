import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { handleMcpRequest } from '../../src/server/request.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { createProject } from '../../src/server/admin.js';
import { mintUserToken, allow, seedUnit } from './helpers.js';
import { refreshPublicSurface, upsertRelation } from '../../src/server/landscape.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type {
  ApiKeyRecord,
  HostConfig,
  PrincipalSubject,
  ProjectGrant,
  ProjectRelationRecord,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Host Request Orchestrator — data-plane surface-exchange dispatch (sdd_host).
//
// Steps 10–28 of handleRequest: after the project root is resolved and bound, a
// `tools/call` for one of the four hosted landscape tools
// (sdd_landscape_list_reachable_projects / _list_reachable_project_interfaces /
// _list_visible_surfaces / _get_project_surface) is dispatched to the surface
// exchange orchestrator with currentProjectId = the BOUND
// project — never a project id from the arguments — then shaped into the standard
// MCP tool-result envelope and audited through the SAME best-effort path the
// scoped dispatch uses. Reachability is DIRECTIONAL and RELATIONS-ONLY, and
// interface discovery reads only the target's redacted public-surface snapshot.
//
// Driven end-to-end over a real HTTP listener with auth enabled and real minted
// credentials against real, provisioned projects, so the whole authenticate →
// resolve+bind → landscape dispatch → response wiring is exercised as in prod.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

describe('handleMcpRequest landscape discovery dispatch (end-to-end)', () => {
  let base: string;
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let port: number;
  let relationId: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-req-landscape-e2e-'));
    dataDir = path.join(base, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    // Two registered, provisioned isolated projects PLACED in one shared unit
    // (same tenant — the unit-graph visibility gate stays open between them).
    // alpha is the "current" project; beta publishes a redacted public surface.
    const unit = seedUnit(dataDir, 'shared');
    createProject(cfg, MASTER, 'alpha', unit.id);
    const beta = createProject(cfg, MASTER, 'beta', unit.id);

    // Seed beta's L0 public surface (raw, un-schema'd publicInterfaces) — with a
    // method object carrying a full signature + narrative that MUST be redacted.
    seedSurface(beta.rootPath, [
      {
        id: 'beta-api',
        name: 'Beta API',
        type: 'REST',
        audience: 'partners',
        version: 'v1',
        stability: 'stable',
        // Private references that MUST NOT leak into the redacted summary:
        subsystem: 'billing',
        interface: 'ibilling_portal',
        component: 'billing_portal',
        methods: [
          { name: 'createInvoice', signature: 'createInvoice(x): y', narrative: 'secret private steps' },
          'listInvoices',
        ],
        endpoints: ['/invoices'],
        publicTypes: ['Invoice', { name: 'LineItem' }],
        details: 'Beta public surface',
      },
    ]);

    // Refresh beta's stored redacted snapshot (direct, admin credential).
    refreshPublicSurface(cfg, MASTER, 'beta');

    // An ACTIVE relation alpha → beta (direct, admin credential). Validated
    // against beta's snapshot, so it must target the interface id present there.
    const rel = upsertRelation(cfg, MASTER, relation('alpha', 'beta', 'consumes', 'beta-api'));
    relationId = rel.id;

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          body = undefined;
        }
        void handleMcpRequest(cfg, req, res, body).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    process.env = { ...savedEnv };
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Seed L0 publicInterfaces into a provisioned project's raw system spec. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function seedSurface(root: string, ifaces: any[]): void {
    const p = path.join(root, '.wai', 'specs', '.index.yaml');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = readYamlFile(p) as any;
    raw.publicInterfaces = ifaces;
    writeYamlFile(p, raw);
  }

  /** A minimal ACTIVE cross-project relation targeting an interface in the target's snapshot. */
  function relation(source: string, target: string, kind: string, interfaceId: string): ProjectRelationRecord {
    return {
      id: '',
      sourceProjectId: source,
      targetProjectId: target,
      kind,
      sourceAdapter: `${source}_client_adapter`,
      targetPublicInterface: { projectId: target, systemInterfaceId: interfaceId, reason: 'declared dependency' },
      reason: 'declared dependency',
      status: 'active',
      createdAt: '',
      createdBy: subject(),
    };
  }

  /** An editor agent token narrowed to `project`, whose OWNER holds
   *  project:read + project:write over it (the observer gate resolves the
   *  owner's live permission; the ordinary sdd_* regression call needs
   *  project:read). */
  function agentToken(id: string, project: string, userId: string): string {
    allow(dataDir, userId, 'project:read', 'project', project);
    allow(dataDir, userId, 'project:write', 'project', project);
    return mintUserToken(dataDir, { id, userId, projects: [project] });
  }

  const post = (bodyObj: unknown, token: string, project: string) =>
    fetch(`http://127.0.0.1:${port}/mcp?project=${project}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bodyObj),
    });

  interface RpcResponse {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  }
  const toolText = (r: RpcResponse): string => r.result?.content?.[0]?.text ?? '';

  interface ReachableRef {
    projectId: string;
    relationIds: string[];
    relationKinds: string[];
    publicInterfaceIds: string[];
  }
  interface IfaceSummary {
    id: string;
    name: string;
    type: string;
    methods: string[];
  }

  it('discovers exactly the reachable project (alpha → [beta]) with relation ids/kinds over the wire', async () => {
    const token = agentToken('agent-alpha', 'alpha', 'u-alpha');

    const res = await post(call('sdd_landscape_list_reachable_projects'), token, 'alpha');
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();

    const reachable = JSON.parse(toolText(jsonBody)) as ReachableRef[];
    expect(reachable).toHaveLength(1);
    expect(reachable[0].projectId).toBe('beta');
    expect(reachable[0].relationIds).toContain(relationId);
    expect(reachable[0].relationKinds).toContain('consumes');
    expect(reachable[0].publicInterfaceIds).toContain('beta-api');
  }, 20_000);

  it('returns beta’s redacted interface summaries for a reachable target — no narrative/signature leakage', async () => {
    const token = agentToken('agent-alpha-ifaces', 'alpha', 'u-alpha');

    const res = await post(
      call('sdd_landscape_list_reachable_project_interfaces', { projectId: 'beta' }),
      token,
      'alpha',
    );
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();

    const ifaces = JSON.parse(toolText(jsonBody)) as IfaceSummary[];
    expect(ifaces.map((i) => i.id)).toEqual(['beta-api']);
    const iface = ifaces[0];
    expect(iface.name).toBe('Beta API');
    expect(iface.type).toBe('REST');
    // Only method NAMES survive redaction — never the signature or narrative.
    expect(iface.methods).toEqual(['createInvoice', 'listInvoices']);

    // No private references / narratives / signatures leak over the wire.
    const raw = toolText(jsonBody);
    expect(raw).not.toMatch(/signature/);
    expect(raw).not.toMatch(/narrative/);
    expect(raw).not.toMatch(/secret private steps/);
    expect(raw).not.toMatch(/billing_portal/);
    expect(raw).not.toMatch(/ibilling_portal/);
  }, 20_000);

  it('denies an unreachable target with an isError tool result (HTTP 200, no interface data)', async () => {
    const token = agentToken('agent-alpha-deny', 'alpha', 'u-alpha');

    // gamma has no ACTIVE relation from alpha → unreachable (no existence leak).
    const res = await post(
      call('sdd_landscape_list_reachable_project_interfaces', { projectId: 'gamma' }),
      token,
      'alpha',
    );
    const jsonBody = (await res.json()) as RpcResponse;

    // A forbidden discovery call is an isError tool result, not an HTTP error.
    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBe(true);
    expect(toolText(jsonBody).toLowerCase()).toContain('not reachable');
    // No interface data leaks for an unreachable target.
    expect(toolText(jsonBody)).not.toContain('beta-api');
    expect(toolText(jsonBody)).not.toContain('createInvoice');
  }, 20_000);

  it('enforces directionality over the wire: a token scoped to beta discovers nothing', async () => {
    const token = agentToken('agent-beta', 'beta', 'u-beta');

    const res = await post(call('sdd_landscape_list_reachable_projects'), token, 'beta');
    const jsonBody = (await res.json()) as RpcResponse;

    expect(res.status).toBe(200);
    expect(jsonBody.result?.isError).toBeFalsy();
    // The relation is alpha → beta, so beta (the target) reaches nothing.
    expect(JSON.parse(toolText(jsonBody))).toEqual([]);
  }, 20_000);

  it('audits both discovery calls as captured mcp.tool.call events (not read-excluded)', async () => {
    const token = agentToken('agent-alpha-audit', 'alpha', 'u-alpha');

    await post(call('sdd_landscape_list_reachable_projects'), token, 'alpha');
    await post(call('sdd_landscape_list_reachable_project_interfaces', { projectId: 'beta' }), token, 'alpha');

    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    const targets = events.map((e) => e.target);
    // sdd_landscape_* does NOT start with sdd_get/sdd_validate, so discovery is captured.
    expect(targets).toContain('sdd_landscape_list_reachable_projects');
    expect(targets).toContain('sdd_landscape_list_reachable_project_interfaces');
    for (const e of events) {
      expect(e.projectId).toBe('alpha'); // audited under the BOUND project
      expect(e.outcome).toBe('success');
      expect(e.tokenId).toBe('agent-alpha-audit');
    }
  }, 20_000);

  it('advertises the hosted data-plane tools in tools/list (execution stays intercepted upstream)', async () => {
    const token = agentToken('k-list', 'alpha', 'u-list');
    const res = await post({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }, token, 'alpha');
    const body = await res.text();
    for (const name of [
      'sdd_host_initialize_project',
      'sdd_host_lock_project',
      'sdd_host_promote_project',
      'sdd_host_get_approval_status',
      'sdd_host_await_approval',
      'sdd_landscape_list_reachable_projects',
      'sdd_landscape_list_reachable_project_interfaces',
      'sdd_landscape_list_visible_surfaces',
      'sdd_landscape_get_project_surface',
    ]) {
      expect(body).toContain(name);
    }
  }, 20_000);

  it('sdd_landscape_list_visible_surfaces + get_project_surface dispatch over the wire (legacy relations posture)', async () => {
    const token = agentToken('k-vis', 'alpha', 'u-vis');

    // No org units: the catalog is empty (no unit graph to see through) but the
    // relation-backed contract fetch works (legacy reachability).
    const catalogRes = await post(call('sdd_landscape_list_visible_surfaces'), token, 'alpha');
    const catalog = JSON.parse(toolText((await catalogRes.json()) as RpcResponse));
    expect(Array.isArray(catalog)).toBe(true);

    const surfaceRes = await post(call('sdd_landscape_get_project_surface', { projectId: 'beta' }), token, 'alpha');
    const rpc = (await surfaceRes.json()) as RpcResponse;
    expect(rpc.result?.isError).not.toBe(true);
    const snapshot = JSON.parse(toolText(rpc));
    expect(snapshot.origin).toBe('exchanged');
    expect(typeof snapshot.projectName).toBe('string');
  }, 20_000);

  it('leaves a normal sdd_* tool call unaffected (regression)', async () => {
    const token = agentToken('agent-normal', 'alpha', 'u-normal');

    const res = await post(call('sdd_get_status'), token, 'alpha');
    const jsonBody = (await res.json()) as RpcResponse;

    // Handled by the scoped server: a standard tool result comes back and the
    // landscape dispatch did NOT intercept it.
    expect(res.status).toBe(200);
    expect(jsonBody.result).toBeDefined();
    expect(jsonBody.result?.content?.[0]?.text).toBeTypeOf('string');
  }, 20_000);
});
