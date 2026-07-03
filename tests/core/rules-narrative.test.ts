import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Narrative control flow (branch/switch/loop/try/jump/return/throw) and the
// narrative detail dial (full | calls-only | intent with stereotype defaults).
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-narr-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta'],
      enforceReproducibility: true,
    },
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-06-10T22:00:00Z'\nupdatedAt: '2026-06-10T22:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return {
    writeSpec,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const codes = (res: { issues: { code: string }[] }) => res.issues.map(i => i.code);

describe('narrative control flow validation', () => {
  it('accepts a fully flow-structured narrative (branch, loop, try, jump, return, throw)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [repo-a]');
    proj.component('repo-a', 'Repository');
    proj.writeSpec('interface', 'iorch-a', `schemaVersion: 1.0.0
id: iorch-a
name: IOrch
description: d
component: orch-a
methods:
  - name: runNext
    description: Executes the next pending job with retry and cleanup semantics.
    signature: "runNext(): Promise<void>"
    returns: "Promise<void>"`);
    proj.writeSpec('interface', 'irepo-a', `schemaVersion: 1.0.0
id: irepo-a
name: IRepo
description: d
component: repo-a
methods:
  - name: nextPending
    description: Returns the oldest pending job, or null when the queue is empty.
    signature: "nextPending(): Promise<Job | null>"
    returns: "Promise<string>"`);
    proj.writeSpec('implementation', 'impl-orch-a', `schemaVersion: 1.0.0
id: impl-orch-a
name: ImplOrch
description: d
contract: iorch-a
methods:
  - name: runNext
    narrative:
      - { stepNumber: 1, description: fetch next pending job, type: call, targetComponent: repo-a, targetMethod: nextPending }
      - { stepNumber: 2, description: a job was found, type: branch, condition: job != null, onFalseStep: 10 }
      - { stepNumber: 3, description: guard the execution, type: try, endStep: 6, catches: [{ error: TimeoutError, step: 7 }] }
      - { stepNumber: 4, description: retry loop over attempts, type: loop, loopKind: for, over: attempt in 1..3, endStep: 5 }
      - { stepNumber: 5, description: execute the attempt, type: local }
      - { stepNumber: 6, description: skip the handlers, type: jump, toStep: 9 }
      - { stepNumber: 7, description: log the timeout, type: local }
      - { stepNumber: 8, description: retries exhausted, type: throw, error: DispatchFailedError }
      - { stepNumber: 9, description: record the result, type: local }
      - { stepNumber: 10, description: nothing to do, type: return, outcome: idle }`);
    // repo-a is intent-level by stereotype default... Repository is 'full'; give it a narrative
    proj.writeSpec('implementation', 'impl-repo-a', `schemaVersion: 1.0.0
id: impl-repo-a
name: ImplRepo
description: d
contract: irepo-a
methods:
  - name: nextPending
    detail: intent
    intent: Pops the oldest pending job from the backing store; returns null on an empty queue. No locking — single consumer by design.`);
    proj.activate();
    try {
      const res = validateSddTree();
      const flowIssues = res.issues.filter(i => ['MALFORMED_FLOW_STEP', 'INVALID_STEP_JUMP', 'UNREACHABLE_STEP', 'MISSING_NARRATIVE', 'INTENT_FLOOR'].includes(i.code));
      expect(flowIssues).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags malformed flow steps, dangling jumps, and unreachable steps', () => {
    const proj = createTempProject();
    proj.component('orch-b', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-b', `schemaVersion: 1.0.0
id: iorch-b
name: IOrchB
description: d
component: orch-b
methods:
  - name: run
    description: Runs the thing end to end with all its edge cases handled.
    signature: "run(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-orch-b', `schemaVersion: 1.0.0
id: impl-orch-b
name: ImplOrchB
description: d
contract: iorch-b
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: branch missing config, type: branch }
      - { stepNumber: 2, description: loop missing endStep, type: loop, condition: has more }
      - { stepNumber: 3, description: local step smuggling flow config, type: local, toStep: 1 }
      - { stepNumber: 4, description: dangling jump, type: jump, toStep: 99 }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const cs = codes(res);
      expect(cs).toContain('MALFORMED_FLOW_STEP');
      expect(cs).toContain('INVALID_STEP_JUMP');
      // branch without condition AND without onFalseStep = 2 malformed; loop = 1; local+toStep = 1
      expect(res.issues.filter(i => i.code === 'MALFORMED_FLOW_STEP').length).toBe(4);
      expect(res.valid).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('flags interleaved regions, jumps into region bodies, handler fall-through, and unstructured backward jumps', () => {
    const proj = createTempProject();
    proj.component('orch-s', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-s', `schemaVersion: 1.0.0
id: iorch-s
name: IOrchS
description: d
component: orch-s
methods:
  - name: run
    description: Runs everything with structure problems for the linter to find.
    signature: "run(): void"
    returns: "void"
  - name: retryish
    description: Emulates a loop with a backward branch instead of a loop step.
    signature: "retryish(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-orch-s', `schemaVersion: 1.0.0
id: impl-orch-s
name: ImplOrchS
description: d
contract: iorch-s
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: outer loop, type: loop, loopKind: while, condition: pending, endStep: 3 }
      - { stepNumber: 2, description: interleaving try, type: try, endStep: 4, catches: [{ error: any, step: 5 }] }
      - { stepNumber: 3, description: work, type: local }
      - { stepNumber: 4, description: more work, type: local }
      - { stepNumber: 5, description: handler entered by fall-through too, type: local }
      - { stepNumber: 6, description: jump into the loop body from outside, type: jump, toStep: 3 }
  - name: retryish
    narrative:
      - { stepNumber: 1, description: attempt the call, type: local }
      - { stepNumber: 2, description: retry on failure, type: branch, condition: failed, onFalseStep: 4, onTrueStep: 1 }
      - { stepNumber: 3, description: give up, type: throw, error: RetriesExhausted }
      - { stepNumber: 4, description: done, type: return, outcome: success }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const cs = codes(res);
      expect(cs).toContain('REGION_OVERLAP');       // loop 1..3 vs try 2..4 interleave
      expect(cs).toContain('JUMP_INTO_REGION');     // step 6 jumps to 3, inside the loop body
      expect(cs).toContain('FALLTHROUGH_INTO_HANDLER'); // try body ends at 4 (local), next is catch step 5
      expect(cs).toContain('BACKWARD_JUMP');        // branch onTrueStep 1 with no enclosing loop
    } finally { proj.cleanup(); }
  });

  it('allows continue-to-loop-header backward jumps and properly nested regions', () => {
    const proj = createTempProject();
    proj.component('orch-t', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-t', `schemaVersion: 1.0.0
id: iorch-t
name: IOrchT
description: d
component: orch-t
methods:
  - name: run
    description: A well-structured loop with a continue jump back to its header.
    signature: "run(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-orch-t', `schemaVersion: 1.0.0
id: impl-orch-t
name: ImplOrchT
description: d
contract: iorch-t
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: each pending job, type: loop, loopKind: forEach, over: pending jobs, endStep: 4 }
      - { stepNumber: 2, description: already handled, type: branch, condition: job.done, onFalseStep: 4 }
      - { stepNumber: 3, description: skip it (continue), type: jump, toStep: 1 }
      - { stepNumber: 4, description: process the job, type: local }
      - { stepNumber: 5, description: all done, type: return, outcome: success }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const structural = res.issues.filter(i => ['REGION_OVERLAP', 'JUMP_INTO_REGION', 'FALLTHROUGH_INTO_HANDLER', 'BACKWARD_JUMP'].includes(i.code));
      expect(structural).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('warns about steps no path reaches', () => {
    const proj = createTempProject();
    proj.component('orch-c', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-c', `schemaVersion: 1.0.0
id: iorch-c
name: IOrchC
description: d
component: orch-c
methods:
  - name: run
    description: Runs the thing end to end with all its edge cases handled.
    signature: "run(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-orch-c', `schemaVersion: 1.0.0
id: impl-orch-c
name: ImplOrchC
description: d
contract: iorch-c
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: do the work, type: local }
      - { stepNumber: 2, description: done early, type: return, outcome: success }
      - { stepNumber: 3, description: dead code after the terminator, type: local }`);
    proj.activate();
    try {
      const res = validateSddTree();
      const unreachable = res.issues.filter(i => i.code === 'UNREACHABLE_STEP');
      expect(unreachable).toHaveLength(1);
      expect(unreachable[0].message).toContain('step(s) 3');
    } finally { proj.cleanup(); }
  });
});

describe('type shape rules', () => {
  it('flags a type with no fields and no methods as HOLLOW_TYPE', () => {
    const proj = createTempProject();
    proj.writeSpec('type', 'ghost-shape', 'kind: value-object\nid: ghost-shape\nname: GhostShape\ndescription: a placeholder\nfields: []\nmethods: []');
    proj.activate();
    try {
      const res = validateSddTree();
      const hollow = res.issues.filter(i => i.code === 'HOLLOW_TYPE');
      expect(hollow).toHaveLength(1);
      expect(hollow[0].specId).toBe('ghost-shape');
      expect(hollow[0].severity).toBe('warning');
    } finally { proj.cleanup(); }
  });
});

describe('per-spec lint allows (#[allow] for the conformance gate)', () => {
  it('a reasoned allow silences a warning on that spec only, and counts as used', () => {
    const proj = createTempProject();
    proj.writeSpec('type', 'marker', `kind: value-object
id: marker
name: Marker
description: intentionally opaque
fields: []
methods: []
lint:
  allow:
    - code: HOLLOW_TYPE
      reason: opaque marker type — shape is deliberately unspecified`);
    proj.writeSpec('type', 'other-hollow', 'kind: value-object\nid: other-hollow\nname: OtherHollow\ndescription: d\nfields: []\nmethods: []');
    proj.activate();
    try {
      const res = validateSddTree();
      const hollow = res.issues.filter(i => i.code === 'HOLLOW_TYPE');
      expect(hollow).toHaveLength(1); // only the spec WITHOUT the allow
      expect(hollow[0].specId).toBe('other-hollow');
      expect(res.issues.filter(i => i.code === 'UNUSED_LINT_ALLOW')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('never suppresses error-severity findings, but the matching allow is not flagged stale', () => {
    const proj = createTempProject();
    proj.writeSpec('type', 'broken', `kind: value-object
id: broken
name: Broken
description: d
fields:
  - name: ref
    type: NoSuchType
methods: []
lint:
  allow:
    - code: UNDEFINED_TYPE_REFERENCE
      reason: trying to silence an architecture error`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'UNDEFINED_TYPE_REFERENCE')).toHaveLength(1); // error survives
      expect(res.issues.filter(i => i.code === 'UNUSED_LINT_ALLOW')).toHaveLength(0); // but the allow matched
      expect(res.valid).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('flags unknown codes and stale allows', () => {
    const proj = createTempProject();
    proj.writeSpec('type', 'tidy', `kind: value-object
id: tidy
name: Tidy
description: d
fields:
  - name: label
    type: string
methods: []
lint:
  allow:
    - code: TOTALLY_MADE_UP
      reason: typo
    - code: HOLLOW_TYPE
      reason: it used to be hollow but is filled now`);
    proj.activate();
    try {
      const res = validateSddTree();
      const unknown = res.issues.filter(i => i.code === 'UNKNOWN_LINT_ALLOW_CODE');
      const stale = res.issues.filter(i => i.code === 'UNUSED_LINT_ALLOW');
      expect(unknown).toHaveLength(1);
      expect(unknown[0].specId).toBe('tidy');
      expect(stale).toHaveLength(1);
      expect(stale[0].message).toContain('HOLLOW_TYPE');
    } finally { proj.cleanup(); }
  });
});

describe('language-aware flow constraints', () => {
  it('flags try/throw/do-while in a Rust subsystem, and stays silent without a targetLanguage', () => {
    const proj = createTempProject();
    proj.writeSpec('subsystem', 'sub-r', 'schemaVersion: 1.0.0\nid: sub-r\nname: SubR\ndescription: d\nparentSystem: TestSystem\ntargetLanguage: rust');
    proj.writeSpec('component', 'orch-r', 'schemaVersion: 1.0.0\nid: orch-r\nname: orch-r\ndescription: d\nsubsystem: sub-r\ncomponentType: Orchestrator');
    proj.component('orch-u', 'Orchestrator'); // sub-a: no targetLanguage anywhere
    const iface = (id: string, comp: string) => `schemaVersion: 1.0.0
id: ${id}
name: I
description: d
component: ${comp}
methods:
  - name: run
    description: Runs the pipeline with retries and error propagation handled.
    signature: "run()"
    returns: "unit"`;
    proj.writeSpec('interface', 'iorch-r', iface('iorch-r', 'orch-r'));
    proj.writeSpec('interface', 'iorch-u', iface('iorch-u', 'orch-u'));
    const implBody = (id: string, contract: string) => `schemaVersion: 1.0.0
id: ${id}
name: Impl
description: d
contract: ${contract}
methods:
  - name: run
    narrative:
      - { stepNumber: 1, description: guard the work, type: try, endStep: 3, catches: [{ error: any, step: 4 }] }
      - { stepNumber: 2, description: poll until drained, type: loop, loopKind: doWhile, condition: more work, endStep: 3 }
      - { stepNumber: 3, description: drain one, type: local }
      - { stepNumber: 4, description: propagate, type: throw, error: DrainFailed }`;
    proj.writeSpec('implementation', 'impl-orch-r', implBody('impl-orch-r', 'iorch-r'));
    proj.writeSpec('implementation', 'impl-orch-u', implBody('impl-orch-u', 'iorch-u'));
    proj.activate();
    try {
      const res = validateSddTree();
      const flow = res.issues.filter(i => i.code === 'LANGUAGE_FOREIGN_FLOW');
      expect(flow).toHaveLength(3); // try + doWhile + throw, only in the rust subsystem
      expect(flow.every(i => i.specId === 'impl-orch-r')).toBe(true);
      expect(flow.map(i => i.message).join(' ')).toContain('do-while');
    } finally { proj.cleanup(); }
  });
});

describe('narrative detail dial', () => {
  it('stereotype defaults: Store falls to intent — thin description trips the INTENT_FLOOR as a warning', () => {
    const proj = createTempProject();
    proj.component('portal-d', 'Portal', 'portalType: HTTP_API\ndependsOn: [store-d]');
    proj.component('store-d', 'Store');
    proj.writeSpec('interface', 'iportal-d', `schemaVersion: 1.0.0
id: iportal-d
name: IPortalD
description: d
component: portal-d
methods:
  - name: get
    description: Fetches the record by delegating straight to the backing store.
    signature: "get(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'istore-d', `schemaVersion: 1.0.0
id: istore-d
name: IStoreD
description: d
component: store-d
methods:
  - name: read
    description: read
    signature: "read(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-portal-d', `schemaVersion: 1.0.0
id: impl-portal-d
name: ImplPortalD
description: d
contract: iportal-d
methods:
  - name: get
    narrative:
      - { stepNumber: 1, description: forward to the store, type: call, targetComponent: store-d, targetMethod: read }`);
    proj.writeSpec('implementation', 'impl-store-d', `schemaVersion: 1.0.0
id: impl-store-d
name: ImplStoreD
description: d
contract: istore-d
methods:
  - name: read`);
    proj.activate();
    try {
      const res = validateSddTree();
      const floor = res.issues.filter(i => i.code === 'INTENT_FLOOR');
      expect(floor).toHaveLength(1);
      expect(floor[0].severity).toBe('warning'); // stereotype-defaulted, not declared
      expect(res.issues.filter(i => i.code === 'MISSING_NARRATIVE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a substantive L3 description satisfies the intent floor without any L4 prose', () => {
    const proj = createTempProject();
    proj.component('portal-e', 'Portal', 'portalType: HTTP_API\ndependsOn: [store-e]');
    proj.component('store-e', 'Store');
    proj.writeSpec('interface', 'iportal-e', `schemaVersion: 1.0.0
id: iportal-e
name: IPortalE
description: d
component: portal-e
methods:
  - name: get
    description: Fetches the record by delegating straight to the backing store.
    signature: "get(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'istore-e', `schemaVersion: 1.0.0
id: istore-e
name: IStoreE
description: d
component: store-e
methods:
  - name: read
    description: Reads the record by key from the persisted index; returns null when absent, never throws.
    signature: "read(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-portal-e', `schemaVersion: 1.0.0
id: impl-portal-e
name: ImplPortalE
description: d
contract: iportal-e
methods:
  - name: get
    narrative:
      - { stepNumber: 1, description: forward to the store, type: call, targetComponent: store-e, targetMethod: read }`);
    proj.writeSpec('implementation', 'impl-store-e', `schemaVersion: 1.0.0
id: impl-store-e
name: ImplStoreE
description: d
contract: istore-e
methods:
  - name: read`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'INTENT_FLOOR')).toHaveLength(0);
      expect(res.issues.filter(i => i.code === 'MISSING_NARRATIVE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('explicit detail declarations are held to their promise as errors', () => {
    const proj = createTempProject();
    proj.component('orch-f', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-f', `schemaVersion: 1.0.0
id: iorch-f
name: IOrchF
description: d
component: orch-f
methods:
  - name: run
    description: Runs the whole pipeline end to end, including compensation on failure.
    signature: "run(): void"
    returns: "void"
  - name: ping
    description: ping
    signature: "ping(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-orch-f', `schemaVersion: 1.0.0
id: impl-orch-f
name: ImplOrchF
description: d
contract: iorch-f
methods:
  - name: run
    detail: full
  - name: ping
    detail: intent`);
    proj.activate();
    try {
      const res = validateSddTree();
      const missing = res.issues.filter(i => i.code === 'MISSING_NARRATIVE');
      const floor = res.issues.filter(i => i.code === 'INTENT_FLOOR');
      expect(missing).toHaveLength(1);
      expect(missing[0].severity).toBe('error');
      expect(floor).toHaveLength(1);
      expect(floor[0].severity).toBe('error');
    } finally { proj.cleanup(); }
  });

  it('unused-detection falls back to L2 edges for intent-level methods (no false UNUSED for their collaborators)', () => {
    const proj = createTempProject();
    proj.component('portal-g', 'Portal', 'portalType: HTTP_API\ndependsOn: [adapter-g]');
    proj.component('adapter-g', 'Adapter', 'dependsOn: [orch-g]');
    proj.component('orch-g', 'Orchestrator');
    proj.writeSpec('interface', 'iportal-g', `schemaVersion: 1.0.0
id: iportal-g
name: IPortalG
description: d
component: portal-g
methods:
  - name: handle
    description: Accepts the request and forwards it through the boundary adapter.
    signature: "handle(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'iadapter-g', `schemaVersion: 1.0.0
id: iadapter-g
name: IAdapterG
description: d
component: adapter-g
methods:
  - name: forward
    description: Translates the transport payload and forwards it to the orchestrator unchanged.
    signature: "forward(): void"
    returns: "void"`);
    proj.writeSpec('interface', 'iorch-g', `schemaVersion: 1.0.0
id: iorch-g
name: IOrchG
description: d
component: orch-g
methods:
  - name: process
    description: Processes the request with full business logic and persistence.
    signature: "process(): void"
    returns: "void"`);
    proj.writeSpec('implementation', 'impl-portal-g', `schemaVersion: 1.0.0
id: impl-portal-g
name: ImplPortalG
description: d
contract: iportal-g
methods:
  - name: handle
    narrative:
      - { stepNumber: 1, description: forward through the adapter, type: call, targetComponent: adapter-g, targetMethod: forward }`);
    // Adapter: calls-only stereotype default, EMPTY narrative — falls to the
    // intent floor (passes via its L3 description) and must not orphan orch-g.
    proj.writeSpec('implementation', 'impl-adapter-g', `schemaVersion: 1.0.0
id: impl-adapter-g
name: ImplAdapterG
description: d
contract: iadapter-g
methods:
  - name: forward`);
    proj.writeSpec('implementation', 'impl-orch-g', `schemaVersion: 1.0.0
id: impl-orch-g
name: ImplOrchG
description: d
contract: iorch-g
methods:
  - name: process
    narrative:
      - { stepNumber: 1, description: run the business logic, type: local }`);
    proj.activate();
    try {
      const res = validateSddTree();
      expect(res.issues.filter(i => i.code === 'UNUSED_COMPONENT')).toHaveLength(0);
      expect(res.issues.filter(i => i.code === 'UNUSED_METHOD')).toHaveLength(0);
      expect(res.issues.filter(i => i.code === 'INTENT_FLOOR')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
