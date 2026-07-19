import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createProjectRecord } from '../../src/server/projects.js';
import { mintUserToken, allow } from './helpers.js';

// ---------------------------------------------------------------------------
// Hosted data-plane spec-CONTENT round-trip (sdd_host).
//
// The permission suites prove the gates; THIS suite proves fidelity: every NEW
// schema field (durability, emits/subscribesTo, ext, lint.allow, narrative step
// labels, parallel fan-out branches + endStep, detach) authored through the
// REAL hosted path — handleMcpRequest behind startHostServer, authenticated,
// project-bound — comes back through sdd_get_spec deep-equal to what was sent.
// A dropped field anywhere in this path is a real bug, never a test tolerance.
//
// The server runs as a REAL subprocess (tests/server/dataplane-content.driver.ts
// under `node --import tsx`): the scoped MCP server dispatches its sdd_* tools
// through lazy CJS requires that the vitest in-process transform cannot resolve,
// and stubbing them would fake away exactly the layer under test. The test
// process seeds the data dir (projects, grid assignments, minted token) and
// drives the child over real HTTP — production-shaped end to end.
//
// Crucially it runs with TWO projects warm in the same server process: the
// shared workspace registry invalidates IN PLACE (src/core/specs.ts) precisely
// because hosted scoping once mis-routed writes through evicted-then-stale
// workspace references. Project B is authored first (warm), A is authored
// second, and the suite asserts byte-level that B's tree is untouched and no
// content bled in either direction.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const DRIVER = path.join(__dirname, 'dataplane-content.driver.ts');

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

/** Recursively snapshot every file under dir as relpath → exact bytes. */
function snapshotFiles(dir: string, base = dir): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      for (const [k, v] of snapshotFiles(p, base)) out.set(k, v);
    } else {
      out.set(path.relative(base, p).replace(/\\/g, '/'), fs.readFileSync(p));
    }
  }
  return out;
}

// ── The authored content (single source for both the writes and the expected
//    read-backs, so an assertion can never drift from what was sent) ─────────

const A_EMITS = [
  { topic: 'session.events', event: 'created', description: 'fires after a session record is stored' },
  { topic: 'session.metrics' },
];
const A_SUBSCRIBES = [{ topic: 'auth.revoked', description: 'evicts sessions of revoked principals' }];
const A_EXT = {
  'com.example.canvas': { color: 'red', pinned: true, weights: [1, 2, 3], nested: { depth: 2 } },
};
const A_LINT = {
  allow: [{ code: 'UNOWNED_STORE', reason: 'sanctioned standalone store — workflow-layer consumers only' }],
};
const IMPL_EXT = { 'com.example.metrics': { collect: ['latency', 'errors'] } };
const IMPL_LINT = {
  allow: [{ code: 'CALL_STEP_UNREALIZED', reason: 'audit mirror lands in the next implementation wave' }],
};
const B_EXT_BLUE = { 'com.example.canvas': { color: 'blue' } };
const B_EXT_GREEN = { 'com.example.canvas': { color: 'green' } };
const B_LINT = { allow: [{ code: 'UNOWNED_STORE', reason: 'project-B keeps its inventory store standalone' }] };

/** The narrative as AUTHORED: symbolic labels everywhere a jump is needed —
 *  onFalseLabel, a parallel arm named by label — plus a detached call. */
const PUT_NARRATIVE_INPUT = [
  { label: 'entry', description: 'validate the session record shape', type: 'local' },
  { description: 'is the record valid?', type: 'branch', condition: 'record shape is valid', onFalseLabel: 'reject' },
  {
    description: 'fan out the write to both sinks',
    type: 'parallel',
    branches: [
      { label: 'mirror-arm', name: 'mirror' },
      { step: 5, name: 'persist' },
    ],
    endStep: 5,
  },
  {
    label: 'mirror-arm',
    description: 'mirror the write into the audit log (fire-and-forget)',
    type: 'call',
    targetComponent: 'audit_log',
    targetMethod: 'record',
    detach: true,
  },
  { description: 'persist the record durably', type: 'local' },
  { label: 'done', description: 'report the stored session', type: 'return', outcome: 'success' },
  { label: 'reject', description: 'reject the malformed record', type: 'throw', error: 'invalid session record' },
];

/** The narrative as it must be STORED: stepNumbers defaulted from position,
 *  every *Label twin resolved to its numeric field and gone, step `label`
 *  anchors preserved, parallel branches resolved to {step, name}, detach kept. */
const PUT_NARRATIVE_STORED = [
  { stepNumber: 1, label: 'entry', description: 'validate the session record shape', type: 'local' },
  { stepNumber: 2, description: 'is the record valid?', type: 'branch', condition: 'record shape is valid', onFalseStep: 7 },
  {
    stepNumber: 3,
    description: 'fan out the write to both sinks',
    type: 'parallel',
    branches: [
      { step: 4, name: 'mirror' },
      { step: 5, name: 'persist' },
    ],
    endStep: 5,
  },
  {
    stepNumber: 4,
    label: 'mirror-arm',
    description: 'mirror the write into the audit log (fire-and-forget)',
    type: 'call',
    targetComponent: 'audit_log',
    targetMethod: 'record',
    detach: true,
  },
  { stepNumber: 5, description: 'persist the record durably', type: 'local' },
  { stepNumber: 6, label: 'done', description: 'report the stored session', type: 'return', outcome: 'success' },
  { stepNumber: 7, label: 'reject', description: 'reject the malformed record', type: 'throw', error: 'invalid session record' },
];

const IFACE_METHODS = [
  {
    name: 'put',
    description: 'store a session record',
    signature: 'put(record: string): void',
    returns: 'void',
    params: [{ name: 'record', type: 'string', description: 'the serialized session record', optional: false }],
    guarantees: ['idempotent'],
    effect: 'write',
  },
  {
    name: 'get',
    description: 'read a session record',
    signature: 'get(id: string): string | null',
    returns: 'string | null',
    params: [{ name: 'id', type: 'string' }],
    effect: 'read',
  },
];

describe('hosted data-plane spec-content round-trip (end-to-end)', () => {
  let dataDir: string;
  let child: ChildProcess;
  let port: number;
  let token: string;

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dp-content-'));

    // Two registered, active, ISOLATED projects in the same server process.
    createProjectRecord(dataDir, 'proj-a');
    createProjectRecord(dataDir, 'proj-b');

    // One author whose grid assignments cover both projects; the token narrows
    // to exactly these two, and the ?project selector binds each request. All
    // of this is on-disk state the child server reads per request.
    allow(dataDir, 'u-author', 'project:read', 'project', 'proj-a');
    allow(dataDir, 'u-author', 'project:write', 'project', 'proj-a');
    allow(dataDir, 'u-author', 'project:read', 'project', 'proj-b');
    allow(dataDir, 'u-author', 'project:write', 'project', 'proj-b');
    token = mintUserToken(dataDir, { id: 'author', userId: 'u-author', projects: ['proj-a', 'proj-b'] });

    port = await freePort();
    const adminPort = await freePort();
    child = spawn(process.execPath, ['--import', TSX_LOADER, DRIVER], {
      // cwd is the throwaway data dir on purpose: were any code path ever to
      // fall back to process.cwd() instead of the request-bound project root,
      // its writes would land in <dataDir>/.wai — asserted absent at the end —
      // rather than silently polluting a real tree.
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

    // Wait until the data plane answers HTTP at all (an unauthenticated probe
    // gets a 401 once the listener is up).
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

  /** One authenticated, project-bound tools/call through the REAL hosted path. */
  const call = async (
    project: 'proj-a' | 'proj-b',
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<{ text: string; isError: boolean }> => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp?project=${project}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RpcResponse;
    return { text: body.result?.content?.[0]?.text ?? '', isError: body.result?.isError === true };
  };

  /** A write that MUST succeed — a silent tool error would make every later
   *  read-back assertion vacuous. */
  const write = async (project: 'proj-a' | 'proj-b', name: string, args: Record<string, unknown>): Promise<void> => {
    const r = await call(project, name, args);
    expect(r.isError, `${name} on ${project} failed: ${r.text}`).toBe(false);
    expect(r.text).toContain('Successfully');
  };

  /** Read a spec back THROUGH THE DATA PLANE and parse the JSON payload. */
  const readSpec = async (
    project: 'proj-a' | 'proj-b',
    kind: string,
    id: string,
  ): Promise<Record<string, any>> => {
    const r = await call(project, 'sdd_get_spec', { kind, id });
    expect(r.isError, `sdd_get_spec ${kind}/${id} on ${project} failed: ${r.text}`).toBe(false);
    return JSON.parse(r.text) as Record<string, any>;
  };

  /** A read that MUST miss — proves an id authored on the other project did not
   *  leak into this project's tree. */
  const expectAbsent = async (project: 'proj-a' | 'proj-b', kind: string, id: string): Promise<void> => {
    const r = await call(project, 'sdd_get_spec', { kind, id });
    expect(r.isError, `${kind}/${id} unexpectedly exists on ${project}: ${r.text}`).toBe(true);
    expect(r.text).toContain('does not exist');
  };

  it('round-trips every new schema field on project A while a warm project B stays byte-identical', async () => {
    // ── Phase 1: warm project B with real authored content ──────────────────
    await write('proj-b', 'sdd_initialize_system', { name: 'sysb', vision: 'inventory system of project B' });
    await write('proj-b', 'sdd_add_subsystem', { id: 'warehouse', name: 'Warehouse', description: 'stock keeping' });
    await write('proj-b', 'sdd_add_component', {
      id: 'inventory_store',
      name: 'Inventory Store',
      description: 'holds stock levels',
      subsystem: 'warehouse',
      componentType: 'Store',
      durability: 'read-through',
    });
    await write('proj-b', 'sdd_update_spec', {
      kind: 'component',
      id: 'inventory_store',
      delta: { ext: B_EXT_BLUE, lint: B_LINT },
    });

    // ── Phase 2: byte-level snapshot of B's whole tree ──────────────────────
    const bRoot = path.join(dataDir, 'projects', 'proj-b');
    const bBefore = snapshotFiles(bRoot);
    expect(bBefore.size).toBeGreaterThan(0);

    // ── Phase 3: author project A exercising EVERY new schema field ─────────
    await write('proj-a', 'sdd_initialize_system', { name: 'sysa', vision: 'session system of project A' });
    await write('proj-a', 'sdd_add_subsystem', { id: 'core', name: 'Core', description: 'session handling' });
    await write('proj-a', 'sdd_add_component', {
      id: 'session_store',
      name: 'Session Store',
      description: 'holds authenticated sessions',
      subsystem: 'core',
      componentType: 'Store',
      durability: 'durable',
      emits: A_EMITS,
      subscribesTo: A_SUBSCRIBES,
    });
    await write('proj-a', 'sdd_add_component', {
      id: 'audit_log',
      name: 'Audit Log',
      description: 'append-only audit sink',
      subsystem: 'core',
      componentType: 'Observer',
      subscribesTo: [{ topic: 'session.events' }],
    });
    // ext + lint have no slot on sdd_add_component — the sanctioned path is a
    // granular sdd_update_spec delta (which also re-saves the spec through the
    // writer, proving a SECOND save does not strip the fields of the first).
    await write('proj-a', 'sdd_update_spec', {
      kind: 'component',
      id: 'session_store',
      delta: { ext: A_EXT, lint: A_LINT },
    });
    await write('proj-a', 'sdd_define_interface', {
      id: 'isession-store',
      name: 'Session Store Contract',
      description: 'session persistence obligations',
      component: 'session_store',
      methods: IFACE_METHODS,
    });
    await write('proj-a', 'sdd_write_narrative', {
      id: 'session_store_impl',
      name: 'Session Store Implementation',
      description: 'durable session persistence',
      contract: 'isession-store',
      sourcePath: 'src/session/store.ts',
      detail: 'full',
      conformance: 'declared',
      methods: [
        { name: 'put', symbol: 'saveSession', narrative: PUT_NARRATIVE_INPUT },
        { name: 'get', detail: 'intent', intent: 'Read the session by id; a missing id returns null, never throws.' },
      ],
    });
    await write('proj-a', 'sdd_update_spec', {
      kind: 'implementation',
      id: 'session_store_impl',
      delta: { lint: IMPL_LINT, ext: IMPL_EXT },
    });

    // Quick liveness read on A before the isolation checks.
    const compAFirst = await readSpec('proj-a', 'component', 'session_store');
    expect(compAFirst.durability).toBe('durable');
    expect(compAFirst.ext).toStrictEqual(A_EXT);

    // ── Phase 4: B is UNTOUCHED — byte-identical, nothing added or removed ──
    const bAfter = snapshotFiles(bRoot);
    expect([...bAfter.keys()].sort()).toStrictEqual([...bBefore.keys()].sort());
    for (const [rel, before] of bBefore) {
      expect(bAfter.get(rel)!.equals(before), `proj-b file changed under A's authoring: ${rel}`).toBe(true);
    }

    // B's content through the data plane is B's own — none of A's values.
    const compB = await readSpec('proj-b', 'component', 'inventory_store');
    expect(compB.durability).toBe('read-through');
    expect(compB.ext).toStrictEqual(B_EXT_BLUE);
    expect(compB.lint).toStrictEqual(B_LINT);
    expect(compB.emits).toBeUndefined();
    expect(compB.subscribesTo).toBeUndefined();

    // And none of A's ids resolve on B (no cross-project spec leak).
    await expectAbsent('proj-b', 'component', 'session_store');
    await expectAbsent('proj-b', 'component', 'audit_log');
    await expectAbsent('proj-b', 'interface', 'isession-store');
    await expectAbsent('proj-b', 'implementation', 'session_store_impl');
    await expectAbsent('proj-a', 'component', 'inventory_store'); // and vice versa

    // ── Phase 5: write into B AGAIN, then deep-verify A (cache thrash) ──────
    await write('proj-b', 'sdd_update_spec', {
      kind: 'component',
      id: 'inventory_store',
      delta: { ext: B_EXT_GREEN },
    });

    const compA = await readSpec('proj-a', 'component', 'session_store');
    expect(compA).toStrictEqual({
      id: 'session_store',
      name: 'Session Store',
      description: 'holds authenticated sessions',
      subsystem: 'core',
      componentType: 'Store',
      owns: [],
      dependsOn: [],
      durability: 'durable',
      emits: A_EMITS,
      subscribesTo: A_SUBSCRIBES,
      lint: A_LINT,
      ext: A_EXT, // still red — B's green write must not bleed back
      status: 'draft',
      createdAt: compA.createdAt,
      updatedAt: compA.updatedAt,
    });
    expect(() => new Date(compA.createdAt).toISOString()).not.toThrow();

    const iface = await readSpec('proj-a', 'interface', 'isession-store');
    expect(iface.methods).toStrictEqual(IFACE_METHODS);

    const impl = await readSpec('proj-a', 'implementation', 'session_store_impl');
    expect(impl).toStrictEqual({
      id: 'session_store_impl',
      name: 'Session Store Implementation',
      description: 'durable session persistence',
      contract: 'isession-store',
      sourcePath: 'src/session/store.ts',
      detail: 'full',
      conformance: 'declared',
      methods: [
        { name: 'put', symbol: 'saveSession', narrative: PUT_NARRATIVE_STORED },
        { name: 'get', detail: 'intent', intent: 'Read the session by id; a missing id returns null, never throws.', narrative: [] },
      ],
      lint: IMPL_LINT,
      ext: IMPL_EXT,
      status: 'draft',
      createdAt: impl.createdAt,
      updatedAt: impl.updatedAt,
    });

    // ── Phase 6: a granular narrative-step delta must not disturb siblings ──
    await write('proj-a', 'sdd_update_spec', {
      kind: 'implementation',
      id: 'session_store_impl',
      delta: {
        methods: [{ name: 'put', narrative: [{ stepNumber: 5, description: 'persist the record durably to disk' }] }],
      },
    });
    const implAfterDelta = await readSpec('proj-a', 'implementation', 'session_store_impl');
    const expectedNarrative = PUT_NARRATIVE_STORED.map((s) =>
      s.stepNumber === 5 ? { ...s, description: 'persist the record durably to disk' } : s,
    );
    expect(implAfterDelta.methods[0].narrative).toStrictEqual(expectedNarrative);
    // The merge re-save kept every sibling field of the spec…
    expect(implAfterDelta.lint).toStrictEqual(IMPL_LINT);
    expect(implAfterDelta.ext).toStrictEqual(IMPL_EXT);
    expect(implAfterDelta.detail).toBe('full');
    expect(implAfterDelta.conformance).toBe('declared');
    expect(implAfterDelta.methods[0].symbol).toBe('saveSession');
    // …and of the sibling method.
    expect(implAfterDelta.methods[1]).toStrictEqual({
      name: 'get',
      detail: 'intent',
      intent: 'Read the session by id; a missing id returns null, never throws.',
      narrative: [],
    });

    // Final cross-check: B holds ITS latest write (green), untouched by phase 6.
    const compBFinal = await readSpec('proj-b', 'component', 'inventory_store');
    expect(compBFinal.ext).toStrictEqual(B_EXT_GREEN);
    expect(compBFinal.durability).toBe('read-through');
    expect(compBFinal.lint).toStrictEqual(B_LINT);

    // Tripwire (see the cwd note in beforeEach): no write ever escaped the
    // bound project roots into the server's working directory.
    expect(fs.existsSync(path.join(dataDir, '.wai'))).toBe(false);
  }, 120_000);
});
