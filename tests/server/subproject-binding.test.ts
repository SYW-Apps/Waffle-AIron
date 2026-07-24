import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createProjectRecord,
  parseQualifiedSelector,
  resolveProjectBinding,
  resolveProjectRoot,
  resolveSubprojectMounts,
  assertMintableNarrowingEntry,
} from '../../src/server/projects.js';
import { handleMcpRequest } from '../../src/server/request.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { mintUserToken, allow, seedSubsystem, seedChainedMount } from './helpers.js';
import type { HostConfig, Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Subproject-qualified token narrowing (sdd_host).
//
// A token's `projects` narrowing entry (and the request selector) may be
// subproject-qualified: 'projectId::subsystemId', nested mounts composing
// ('proj::a::b'). Resolution binds the CHAINED CHILD's root INSIDE the
// project's isolated tree — the mount is looked up on the current root's
// subsystem specs (a subsystem carrying projectPath), containment-checked, and
// an unknown / non-chained / escaping mount REJECTS (never a silent fallback
// to the project root). The qualifier is a NARROWING only: a principal
// narrowed to 'proj::a' can never bind plain 'proj' or a sibling, while a
// plain-'proj' (or '*') principal MAY narrow via a qualified selector.
// Permission capabilities keep resolving over the TOP project, and the audit
// event keeps the TOP project id, additionally recording the bound qualifier.
// ---------------------------------------------------------------------------

/** Seed one component spec into the tree at `root` (flat legacy layout — the
 *  loader scans recursively, so placement is irrelevant to the lookup). */
function seedComponent(root: string, id: string): void {
  const dir = path.join(root, '.wai', 'specs', 'components');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${id}.yaml`),
    [
      `id: ${id}`,
      `name: ${id}`,
      `description: component ${id}`,
      'subsystem: core',
      'componentType: Store',
      'status: draft',
      "createdAt: '2026-01-01T00:00:00.000Z'",
      "updatedAt: '2026-01-01T00:00:00.000Z'",
      '',
    ].join('\n'),
  );
}

const principalWith = (projects: string[]): Principal => ({
  tokenId: 'tok-x',
  role: 'editor',
  projects,
  authenticated: true,
});

describe('resolveProjectBinding — subproject-qualified selectors and narrowing', () => {
  let dataDir: string;
  let demoRoot: string;
  let billingDir: string;
  let paymentsDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-subproj-bind-'));
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;
    // demo ── billing (chained) ── payments (chained, nested inside billing)
    //     ├── other   (chained sibling)
    //     ├── plain   (ordinary in-tree subsystem, NOT chained)
    //     └── esc     (chained but ../-escaping — must be rejected)
    billingDir = seedChainedMount(demoRoot, 'billing', 'packages/billing');
    paymentsDir = seedChainedMount(billingDir, 'payments', 'sub/payments');
    seedChainedMount(demoRoot, 'other', 'packages/other');
    seedSubsystem(demoRoot, 'plain');
    seedSubsystem(demoRoot, 'esc', '../../escape');
  });

  afterEach(() => {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  // ── parsing ────────────────────────────────────────────────────────────────

  it('parses a qualified selector: first ::-segment = project id, remainder = the mount chain', () => {
    expect(parseQualifiedSelector('demo')).toEqual({ projectId: 'demo', mounts: [] });
    expect(parseQualifiedSelector('demo::billing')).toEqual({ projectId: 'demo', mounts: ['billing'] });
    expect(parseQualifiedSelector('demo::a::b')).toEqual({ projectId: 'demo', mounts: ['a', 'b'] });
    // Malformed: empty mount segment, invalid project id, non-strings.
    expect(parseQualifiedSelector('demo::')).toBeNull();
    expect(parseQualifiedSelector('::billing')).toBeNull();
    expect(parseQualifiedSelector('Bad Id::x')).toBeNull();
    expect(parseQualifiedSelector('')).toBeNull();
    expect(parseQualifiedSelector(undefined)).toBeNull();
  });

  // ── resolution ─────────────────────────────────────────────────────────────

  it('binds the chained CHILD root for a qualified selector, keeping the TOP project id + qualifier', () => {
    const b = resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::billing');
    expect(b).toEqual({
      rootPath: path.resolve(demoRoot, 'packages', 'billing'),
      projectId: 'demo',
      subproject: 'billing',
    });
    // The root-path projection agrees.
    expect(resolveProjectRoot(dataDir, principalWith(['demo']), 'demo::billing')).toBe(b!.rootPath);
  });

  it('composes nested mounts: each hop resolves within the CURRENT root', () => {
    const b = resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::billing::payments');
    expect(b).toEqual({
      rootPath: path.resolve(billingDir, 'sub', 'payments'),
      projectId: 'demo',
      subproject: 'billing::payments',
    });
    expect(b!.rootPath).toBe(path.resolve(paymentsDir));
  });

  it('a single qualified narrowing entry binds the child root with NO selector', () => {
    const b = resolveProjectBinding(dataDir, principalWith(['demo::billing']));
    expect(b).toEqual({
      rootPath: path.resolve(demoRoot, 'packages', 'billing'),
      projectId: 'demo',
      subproject: 'billing',
    });
  });

  it('REJECTS an unknown mount — never a silent fallback to the project root', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::ghost')).toBeNull();
    expect(resolveProjectRoot(dataDir, principalWith(['demo']), 'demo::ghost')).toBeNull();
  });

  it('REJECTS a subsystem without projectPath (not a chained subproject)', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::plain')).toBeNull();
  });

  it('REJECTS an escaping mount (containment guard): ../-escape never binds', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::esc')).toBeNull();
  });

  // ── authorization matrix (the qualifier can never widen) ───────────────────

  it('a principal narrowed to proj::a can NEVER bind plain proj or a sibling — only at or below its qualifier', () => {
    const narrowed = principalWith(['demo::billing']);
    // Wider than the qualifier: rejected.
    expect(resolveProjectBinding(dataDir, narrowed, 'demo')).toBeNull();
    // Sibling mount: rejected.
    expect(resolveProjectBinding(dataDir, narrowed, 'demo::other')).toBeNull();
    // Another project entirely: rejected.
    createProjectRecord(dataDir, 'unrelated');
    expect(resolveProjectBinding(dataDir, narrowed, 'unrelated')).toBeNull();
    // Its own qualifier: allowed.
    expect(resolveProjectBinding(dataDir, narrowed, 'demo::billing')?.subproject).toBe('billing');
    // Deeper under the qualifier: allowed.
    const deeper = resolveProjectBinding(dataDir, narrowed, 'demo::billing::payments');
    expect(deeper?.subproject).toBe('billing::payments');
    expect(deeper?.rootPath).toBe(path.resolve(paymentsDir));
  });

  it('a plain-project principal MAY narrow via a qualified selector; so may a "*" principal', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'demo::billing')?.subproject).toBe('billing');
    expect(resolveProjectBinding(dataDir, principalWith(['*']), 'demo::billing')?.subproject).toBe('billing');
  });

  it('an unqualified binding stays exactly as before (no subproject field)', () => {
    expect(resolveProjectBinding(dataDir, principalWith(['demo']), 'demo')).toEqual({
      rootPath: demoRoot,
      projectId: 'demo',
    });
    expect(resolveProjectRoot(dataDir, principalWith(['demo']))).toBe(demoRoot);
  });

  // ── mount resolution + mint-time validation helpers ────────────────────────

  it('resolveSubprojectMounts throws ACTIONABLE errors: unknown mount, non-chained subsystem, escape', () => {
    expect(() => resolveSubprojectMounts('demo', demoRoot, ['ghost'])).toThrow(
      /unknown subproject mount "ghost" on "demo"/,
    );
    expect(() => resolveSubprojectMounts('demo', demoRoot, ['plain'])).toThrow(
      /not a chained subproject .*projectPath/,
    );
    expect(() => resolveSubprojectMounts('demo', demoRoot, ['esc'])).toThrow(
      /must resolve within the project root/,
    );
    // Nested unknown names the qualified position it failed at.
    expect(() => resolveSubprojectMounts('demo', demoRoot, ['billing', 'ghost'])).toThrow(
      /unknown subproject mount "ghost" on "demo::billing"/,
    );
  });

  it('assertMintableNarrowingEntry: "*" and valid plain/qualified entries pass; broken ones throw with guidance', () => {
    expect(() => assertMintableNarrowingEntry(dataDir, '*')).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo')).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::billing')).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::billing::payments')).not.toThrow();
    expect(() => assertMintableNarrowingEntry(dataDir, 'ghost')).toThrow(/unknown project "ghost"/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::ghost')).toThrow(/unknown subproject mount/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::plain')).toThrow(/not a chained subproject/);
    expect(() => assertMintableNarrowingEntry(dataDir, 'demo::')).toThrow(/invalid project narrowing entry/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end (in-process): a qualified token/selector drives handleMcpRequest
// over a real HTTP listener (auth enabled, real minted credentials — mirroring
// dataplane-perms.test.ts). Covers the 403 authorization matrix (the qualifier
// can never widen), the audit event's TOP-project provenance + recorded
// qualifier, and the TOP-project permission-gate anchor. The child-tree READ
// fidelity runs in the subprocess suite below — the scoped sdd_* dispatch uses
// lazy CJS requires the vitest in-process transform cannot resolve (see
// dataplane-content.test.ts).
// ---------------------------------------------------------------------------

describe('handleMcpRequest subproject binding (end-to-end)', () => {
  let dataDir: string;
  let demoRoot: string;
  let server: http.Server;
  let port: number;
  const savedEnv = { ...process.env };

  const call = (name: string, args: Record<string, unknown> = {}) => ({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  interface RpcResponse {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-subproj-e2e-'));
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;

    const billingDir = seedChainedMount(demoRoot, 'billing', 'packages/billing');
    seedChainedMount(demoRoot, 'other', 'packages/other');
    seedSubsystem(demoRoot, 'plain');
    // The component exists ONLY in the chained child tree.
    seedComponent(billingDir, 'child_comp');

    const cfg: HostConfig = {
      host: '127.0.0.1',
      port: 0,
      adminHost: '127.0.0.1',
      adminPort: 0,
      dataDir,
      authEnabled: true,
    };

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
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** A token narrowed to the PLAIN project, owner holding read on demo. */
  const plainToken = () => {
    allow(dataDir, 'u-plain', 'project:read', 'project', 'demo');
    return mintUserToken(dataDir, { id: 'tok-plain', userId: 'u-plain', projects: ['demo'] });
  };
  /** A token narrowed INTO the chained subproject; permission still anchors on
   *  the TOP project (the qualifier narrows reach, never grants). */
  const qualifiedToken = () => {
    allow(dataDir, 'u-qual', 'project:read', 'project', 'demo');
    return mintUserToken(dataDir, { id: 'tok-qual', userId: 'u-qual', projects: ['demo::billing'] });
  };

  const post = (bodyObj: unknown, token: string, selector?: string) =>
    fetch(`http://127.0.0.1:${port}/mcp${selector ? `?project=${encodeURIComponent(selector)}` : ''}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bodyObj),
    });

  const toolText = (r: RpcResponse): string => r.result?.content?.[0]?.text ?? '';

  it('403 matrix: a qualified token cannot bind the top root or a sibling; unknown / non-chained mounts reject', async () => {
    const qual = qualifiedToken();
    // Wider than the qualifier — plain project: rejected.
    expect((await post(call('sdd_get_status'), qual, 'demo')).status).toBe(403);
    // Sibling chained mount: rejected.
    expect((await post(call('sdd_get_status'), qual, 'demo::other')).status).toBe(403);

    const plain = plainToken();
    // Unknown mount: rejected — NEVER silently widened to the project root.
    expect((await post(call('sdd_get_status'), plain, 'demo::ghost')).status).toBe(403);
    // Existing but non-chained subsystem: rejected.
    expect((await post(call('sdd_get_status'), plain, 'demo::plain')).status).toBe(403);
  }, 20_000);

  it('audits a qualified data-plane call with the TOP project id + the bound subproject qualifier', async () => {
    const qual = qualifiedToken();

    // A FAILED read is captured by the default policy (successful reads are
    // excluded), so use a deterministic miss on the child tree.
    const res = await post(call('sdd_get_spec', { kind: 'component', id: 'missing_comp' }), qual);
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.isError).toBe(true);

    const events = queryAuditEvents(dataDir, { action: 'mcp.tool.call' });
    expect(events).toHaveLength(1);
    expect(events[0].projectId).toBe('demo'); // TOP project id — provenance
    expect(events[0].target).toBe('sdd_get_spec');
    expect(events[0].tokenId).toBe('tok-qual');
    expect(JSON.parse(events[0].metadata ?? '{}')).toEqual({ subproject: 'billing' });

    // An UNQUALIFIED call records no subproject metadata (old shape unchanged).
    const plain = plainToken();
    const res2 = await post(call('sdd_get_spec', { kind: 'component', id: 'missing_comp' }), plain, 'demo');
    expect(res2.status).toBe(200);
    const plainEvent = queryAuditEvents(dataDir, { action: 'mcp.tool.call', tokenId: 'tok-plain' });
    expect(plainEvent).toHaveLength(1);
    expect(plainEvent[0].projectId).toBe('demo');
    expect(plainEvent[0].metadata).toBeUndefined();
  }, 20_000);

  it('the data-plane permission gate anchors on the TOP project: an owner without demo read is refused', async () => {
    // Owner holds NO grant at all; the qualified narrowing alone confers nothing.
    const tok = mintUserToken(dataDir, { id: 'tok-nogrant', userId: 'u-nogrant', projects: ['demo::billing'] });
    const res = await post(call('sdd_get_spec', { kind: 'component', id: 'child_comp' }), tok);
    expect(res.status).toBe(200); // an authorization denial is a tool result
    const body = (await res.json()) as RpcResponse;
    expect(body.result?.isError).toBe(true);
    expect(toolText(body)).toContain('project:read required for sdd_get_spec');
  }, 20_000);
});

// ---------------------------------------------------------------------------
// End-to-end (REAL hosted subprocess): the scoped sdd_* tools genuinely operate
// on the CHAINED CHILD tree when the binding is qualified. Runs the shipped
// server (startHostServer via tests/server/dataplane-content.driver.ts under
// `node --import tsx`) because the scoped MCP dispatch resolves its tools
// through lazy CJS requires the vitest in-process transform cannot satisfy.
// Reads prove a child-only spec resolves through the qualified binding and NOT
// through the plain project binding; a write proves its file lands INSIDE the
// child root, never the parent tree.
// ---------------------------------------------------------------------------

describe('subproject binding fidelity (real hosted subprocess)', () => {
  const REPO_ROOT = path.resolve(__dirname, '..', '..');
  const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  const DRIVER = path.join(__dirname, 'dataplane-content.driver.ts');

  let dataDir: string;
  let demoRoot: string;
  let billingDir: string;
  let child: ChildProcess;
  let port: number;
  let token: string;
  let qualToken: string;
  let starToken: string;

  interface RpcResponse {
    result?: { content?: { text?: string }[]; isError?: boolean };
    error?: { code?: number; message?: string };
  }

  /** An OS-assigned free TCP port (bound, read, released). */
  function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const p = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(p));
      });
      srv.on('error', reject);
    });
  }

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-subproj-fid-'));
    demoRoot = createProjectRecord(dataDir, 'demo').rootPath;
    billingDir = seedChainedMount(demoRoot, 'billing', 'packages/billing');
    seedComponent(billingDir, 'child_comp'); // exists ONLY in the child tree

    // One author with read+write on the TOP project; three narrowings.
    allow(dataDir, 'u-author', 'project:read', 'project', 'demo');
    allow(dataDir, 'u-author', 'project:write', 'project', 'demo');
    token = mintUserToken(dataDir, { id: 'author', userId: 'u-author', projects: ['demo'] });
    qualToken = mintUserToken(dataDir, { id: 'author-qual', userId: 'u-author', projects: ['demo::billing'] });
    starToken = mintUserToken(dataDir, { id: 'author-star', userId: 'u-author', projects: ['*'] });

    port = await freePort();
    const adminPort = await freePort();
    child = spawn(process.execPath, ['--import', TSX_LOADER, DRIVER], {
      cwd: dataDir,
      env: {
        ...process.env,
        WAIRON_ADMIN_TOKEN: 'test-admin-token-0123456789abcdef',
        DRIVER_PORT: String(port),
        DRIVER_ADMIN_PORT: String(adminPort),
        DRIVER_DATA_DIR: dataDir,
      },
      stdio: 'ignore',
    });

    // Wait until the data plane answers HTTP at all.
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
        if (res.status > 0) break;
      } catch {
        if (Date.now() > deadline) throw new Error('hosted server subprocess never became ready');
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }, 60_000);

  afterEach(async () => {
    if (child && child.exitCode === null) {
      const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill();
      await gone;
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }, 30_000);

  /** One authenticated tools/call through the REAL hosted path; the selector is
   *  omitted when undefined (single-entry tokens bind without one). */
  const callTool = async (
    tok: string,
    selector: string | undefined,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> => {
    const url = `http://127.0.0.1:${port}/mcp${selector ? `?project=${encodeURIComponent(selector)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    return { text: body.result?.content?.[0]?.text ?? '', isError: body.result?.isError === true };
  };

  it('reads resolve the child-only spec through every qualified route (and NOT through the plain binding); a write lands inside the child root', async () => {
    // Plain token + qualified SELECTOR → child tree: the child-only spec resolves.
    const viaSelector = await callTool(token, 'demo::billing', 'sdd_get_spec', { kind: 'component', id: 'child_comp' });
    expect(viaSelector.isError, viaSelector.text).toBe(false);
    expect((JSON.parse(viaSelector.text) as { id: string }).id).toBe('child_comp');

    // Qualified-NARROWED token, NO selector → the single qualified entry binds the child.
    const viaNarrowing = await callTool(qualToken, undefined, 'sdd_get_spec', { kind: 'component', id: 'child_comp' });
    expect(viaNarrowing.isError, viaNarrowing.text).toBe(false);
    expect((JSON.parse(viaNarrowing.text) as { id: string }).id).toBe('child_comp');

    // '*' token narrows via the qualified selector.
    const viaStar = await callTool(starToken, 'demo::billing', 'sdd_get_spec', { kind: 'component', id: 'child_comp' });
    expect(viaStar.isError, viaStar.text).toBe(false);

    // The PLAIN project binding does not see the bare child id (distinct trees).
    const viaParent = await callTool(token, 'demo', 'sdd_get_spec', { kind: 'component', id: 'child_comp' });
    expect(viaParent.isError).toBe(true);

    // A WRITE through the qualified binding lands INSIDE the child root: the
    // child gains its own L0 system spec; the parent tree gains none.
    const init = await callTool(token, 'demo::billing', 'sdd_initialize_system', {
      name: 'childsys',
      vision: 'the chained child system',
    });
    expect(init.isError, init.text).toBe(false);
    // The L0 system spec lives at .wai/specs/.index.yaml (specsSystem()).
    expect(fs.existsSync(path.join(billingDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(demoRoot, '.wai', 'specs', '.index.yaml'))).toBe(false);
  }, 120_000);
});
