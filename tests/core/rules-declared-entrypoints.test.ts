import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Declared entrypoints — the two mechanisms that keep unused-detection honest
// about callers the narrative graph cannot model:
//
//   `register` step  — a runtime-callback HANDOFF (same target shape as a call
//                      step). Reachability follows the edge; nothing else
//                      does: not call-graph conformance, not cycle detection,
//                      not the durability boot walk.
//   `invokedBy` (L3) — a typed acknowledgment of a caller OUTSIDE the modeled
//                      graph. Seeds the walk (reachability PROPAGATES, unlike
//                      lint.allow) and is itself audited: thin caller prose is
//                      INVOKED_BY_UNDESCRIBED, an internally-reached method is
//                      INVOKED_BY_REDUNDANT.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-entry-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true },
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-08-10T10:00:00Z'\nupdatedAt: '2026-08-10T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');

  return {
    tempDir,
    writeSpec,
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    /** methods: name → extra YAML lines (indented under the method) appended verbatim. */
    contract: (compId: string, methods: Record<string, string[]>) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        ...Object.entries(methods).map(([m, extra]) => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(): void"`,
          '    returns: "void"',
          ...extra,
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
    source: (relPath: string, content: string) => {
      const abs = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    },
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const byCode = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);
const unusedMessages = (res: { issues: { code: string; message: string }[] }) =>
  res.issues.filter(i => i.code === 'UNUSED_COMPONENT' || i.code === 'UNUSED_METHOD').map(i => i.message).join('\n');

const REGISTER = (n: number, comp: string, method: string) =>
  `      - { stepNumber: ${n}, description: Hand the ${method} callback to the runtime scheduler, type: register, targetComponent: ${comp}, targetMethod: ${method} }`;
const CALL = (n: number, comp: string, method: string) =>
  `      - { stepNumber: ${n}, description: Delegate to ${comp}, type: call, targetComponent: ${comp}, targetMethod: ${method} }`;
const RETURN = (n: number) =>
  `      - { stepNumber: ${n}, description: Done, type: return, outcome: done }`;

// Portal → (call) sched-orch.start → (register) worker-spec.tick; the callback's
// own narrative calls audit-store.append — reachability must flow through ALL of it.
function registerChainFixture(proj: ReturnType<typeof createTempProject>, opts: { portal: boolean }) {
  proj.subsystem('sub-a');
  if (opts.portal) {
    proj.component('api-portal', 'Portal', 'portalType: Custom\ndependsOn: [sched-orch]');
    proj.contract('api-portal', { boot: [] });
    proj.impl('api-portal', ['methods:', '  - name: boot', '    narrative:', CALL(1, 'sched-orch', 'start'), RETURN(2)].join('\n'));
  }
  proj.component('sched-orch', 'Orchestrator', 'dependsOn: [worker-spec]');
  proj.contract('sched-orch', { start: [] });
  proj.impl('sched-orch', ['methods:', '  - name: start', '    narrative:', REGISTER(1, 'worker-spec', 'tick'), RETURN(2)].join('\n'));
  proj.component('worker-spec', 'Specialist', 'dependsOn: [audit-store]');
  proj.contract('worker-spec', { tick: [] });
  proj.impl('worker-spec', ['methods:', '  - name: tick', '    narrative:', CALL(1, 'audit-store', 'append'), RETURN(2)].join('\n'));
  proj.component('audit-store', 'Store', 'durability: ram-projection');
  proj.contract('audit-store', { append: [] });
}

describe('register steps — reachability edges for unused-detection', () => {
  it('a registered callback (and its own callees) is reached when the registrar is reached', () => {
    const proj = createTempProject();
    registerChainFixture(proj, { portal: true });
    proj.activate();
    try {
      const res = validateSddTree();
      const unused = unusedMessages(res);
      expect(unused).not.toMatch(/worker-spec|tick/);
      expect(unused).not.toMatch(/audit-store|append/);
      // The register step is structurally a plain sequential step: nothing
      // after it goes dead, nothing about it is malformed.
      expect(byCode(res, 'UNREACHABLE_STEP')).toHaveLength(0);
      expect(byCode(res, 'MALFORMED_FLOW_STEP')).toHaveLength(0);
      // And the whole tree (register step included) survives the writer dry-run.
      expect(byCode(res, 'ROUNDTRIP_SERIALIZATION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a registered callback stays UNUSED when the registrar itself is unreached (derived staleness)', () => {
    const proj = createTempProject();
    registerChainFixture(proj, { portal: false }); // nothing seeds sched-orch
    proj.activate();
    try {
      const res = validateSddTree();
      const unusedComponents = byCode(res, 'UNUSED_COMPONENT').map(i => i.message).join('\n');
      expect(unusedComponents).toMatch(/sched-orch/);
      expect(unusedComponents).toMatch(/worker-spec/);
    } finally { proj.cleanup(); }
  });

  it('registering itself on the runtime (self-reschedule) is NOT an unconditional call cycle', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('cycle-orch', 'Orchestrator');
    proj.contract('cycle-orch', { ping: [] });
    proj.impl('cycle-orch', ['methods:', '  - name: ping', '    narrative:', REGISTER(1, 'cycle-orch', 'ping'), RETURN(2)].join('\n'));
    proj.activate();
    try {
      // The same shape as a `call` self-recursion (which IS flagged) — but a
      // handoff defers to the runtime, so it cannot recurse by construction.
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('register steps — the durability boot walk must NOT take the edge', () => {
  it('an init flow that only REGISTERS the hydrating read still flags MISSING_HYDRATION (while unused-detection follows the same edge)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'lifecycle:\n  - { phase: init, component: boot-orch, method: hydrate }');
    proj.component('state-store', 'Store', 'durability: durable');
    proj.component('boot-orch', 'Orchestrator', 'dependsOn: [state-store]');
    proj.contract('state-store', { save: ['    effect: write'], load: ['    effect: read'] });
    proj.contract('boot-orch', { hydrate: [], mutate: [] });
    proj.impl('boot-orch', [
      'methods:',
      '  - name: hydrate',
      '    narrative:',
      REGISTER(1, 'state-store', 'load'), // registered for later — NOT a boot-time read-back
      RETURN(2),
      '  - name: mutate',
      '    narrative:',
      CALL(1, 'state-store', 'save'),
      RETURN(2),
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      const hydration = byCode(res, 'MISSING_HYDRATION');
      expect(hydration).toHaveLength(1);
      expect(hydration[0].message).toMatch(/state-store/);
      // Contrast: unused-detection DOES follow the register edge — load is not unused.
      expect(unusedMessages(res)).not.toMatch(/"load"/);
    } finally { proj.cleanup(); }
  });

  it('control: the same init flow with a real call step hydrates cleanly', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a', 'lifecycle:\n  - { phase: init, component: boot-orch, method: hydrate }');
    proj.component('state-store', 'Store', 'durability: durable');
    proj.component('boot-orch', 'Orchestrator', 'dependsOn: [state-store]');
    proj.contract('state-store', { save: ['    effect: write'], load: ['    effect: read'] });
    proj.contract('boot-orch', { hydrate: [], mutate: [] });
    proj.impl('boot-orch', [
      'methods:',
      '  - name: hydrate',
      '    narrative:',
      CALL(1, 'state-store', 'load'),
      RETURN(2),
      '  - name: mutate',
      '    narrative:',
      CALL(1, 'state-store', 'save'),
      RETURN(2),
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'MISSING_HYDRATION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('register steps — contract validation identical to call steps', () => {
  it('dangling targets, undeclared dependencies, and a missing targetMethod error like call steps', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('sched-orch', 'Orchestrator', 'dependsOn: [worker-spec]');
    proj.contract('sched-orch', { start: [] });
    proj.component('worker-spec', 'Specialist');
    proj.contract('worker-spec', { tick: [] });
    proj.component('lone-spec', 'Specialist'); // exists, but not a declared dependency
    proj.contract('lone-spec', { run: [] });
    proj.impl('sched-orch', [
      'methods:',
      '  - name: start',
      '    narrative:',
      REGISTER(1, 'ghost-comp', 'run'),        // non-existent component
      REGISTER(2, 'worker-spec', 'noSuchTick'), // method not on the contract
      REGISTER(3, 'lone-spec', 'run'),          // undeclared dependency
      '      - { stepNumber: 4, description: Register with no target method, type: register, targetComponent: worker-spec }',
      RETURN(5),
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      const badComp = byCode(res, 'INVALID_TARGET_COMPONENT_REFERENCE');
      expect(badComp).toHaveLength(1);
      expect(badComp[0].message).toMatch(/registers callback component "ghost-comp"/);
      const badMethod = byCode(res, 'INVALID_TARGET_METHOD_REFERENCE');
      expect(badMethod).toHaveLength(1);
      expect(badMethod[0].message).toMatch(/noSuchTick/);
      const undeclared = byCode(res, 'UNDECLARED_DEPENDENCY_CALL');
      expect(undeclared).toHaveLength(1);
      expect(undeclared[0].message).toMatch(/lone-spec/);
      const missingMethod = byCode(res, 'MISSING_TARGET_METHOD');
      expect(missingMethod).toHaveLength(1);
      expect(missingMethod[0].message).toMatch(/register step \(4\)/);
    } finally { proj.cleanup(); }
  });
});

describe('register steps — exempt from call-graph conformance', () => {
  const workerSide = (proj: ReturnType<typeof createTempProject>) => {
    proj.component('worker-spec', 'Specialist');
    proj.contract('worker-spec', { tick: [] });
    proj.impl('worker-spec', 'sourcePath: src/worker.ts\nmethods:\n  - name: tick\n    detail: intent\n    intent: Drains the pending queue once per invocation; failures are logged and the entry is retried on the next tick.');
    proj.source('src/worker.ts', 'export function tick(): void {}\n');
  };

  it('a register step never demands a code callee (no CALL_STEP_UNREALIZED)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('sched-orch', 'Orchestrator', 'dependsOn: [worker-spec]');
    proj.contract('sched-orch', { start: [] });
    workerSide(proj);
    proj.impl('sched-orch', [
      'sourcePath: src/orch.ts',
      'methods:',
      '  - name: start',
      '    narrative:',
      REGISTER(1, 'worker-spec', 'tick'),
      RETURN(2),
    ].join('\n'));
    // The realized function never names tick() — a timer API takes the reference.
    proj.source('src/orch.ts', 'export function start(): void { /* setInterval(tickRef, 30_000) via the host runtime */ }\n');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('control: the same narrative as a call step IS held to realization', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('sched-orch', 'Orchestrator', 'dependsOn: [worker-spec]');
    proj.contract('sched-orch', { start: [] });
    workerSide(proj);
    proj.impl('sched-orch', [
      'sourcePath: src/orch.ts',
      'methods:',
      '  - name: start',
      '    narrative:',
      CALL(1, 'worker-spec', 'tick'),
      RETURN(2),
    ].join('\n'));
    proj.source('src/orch.ts', 'export function start(): void { /* forgot the call */ }\n');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });
});

const WELL_DESCRIBED_CALLER =
  '    invokedBy:\n      kind: runtime\n      caller: The host scheduler fires this every 30 seconds once the service enters the running state.';

describe('invokedBy — seeding, propagation, and the declaration audit', () => {
  it('seeds the method as an entrypoint: not unused, and reachability propagates through its narrative', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('worker-orch', 'Orchestrator', 'dependsOn: [audit-store]');
    proj.contract('worker-orch', { onTimer: [WELL_DESCRIBED_CALLER] });
    proj.impl('worker-orch', ['methods:', '  - name: onTimer', '    narrative:', CALL(1, 'audit-store', 'append'), RETURN(2)].join('\n'));
    proj.component('audit-store', 'Store', 'durability: ram-projection');
    proj.contract('audit-store', { append: [] });
    proj.activate();
    try {
      const res = validateSddTree();
      const unused = unusedMessages(res);
      expect(unused).not.toMatch(/worker-orch|onTimer/);
      expect(unused).not.toMatch(/audit-store|append/); // propagation — lint.allow could never do this
      expect(byCode(res, 'INVOKED_BY_UNDESCRIBED')).toHaveLength(0);
      expect(byCode(res, 'INVOKED_BY_REDUNDANT')).toHaveLength(0);
      // The interface carrying invokedBy survives the writer dry-run.
      expect(byCode(res, 'ROUNDTRIP_SERIALIZATION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags missing and placeholder-thin caller prose (INVOKED_BY_UNDESCRIBED) — while still seeding', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('worker-orch', 'Orchestrator');
    proj.contract('worker-orch', {
      onTimer: ['    invokedBy:\n      kind: runtime'],                       // no caller at all
      onShutdown: ['    invokedBy:\n      kind: runtime\n      caller: timer'], // placeholder-thin
    });
    proj.impl('worker-orch', [
      'methods:',
      '  - name: onTimer',
      '    narrative:',
      RETURN(1),
      '  - name: onShutdown',
      '    narrative:',
      RETURN(1),
    ].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      const undescribed = byCode(res, 'INVOKED_BY_UNDESCRIBED');
      expect(undescribed).toHaveLength(2);
      expect(undescribed.map(i => i.specId)).toEqual(['iworker-orch', 'iworker-orch']);
      // Under-described, but the seeding still works — the lint is about prose, not reachability.
      expect(unusedMessages(res)).not.toMatch(/worker-orch|onTimer|onShutdown/);
    } finally { proj.cleanup(); }
  });

  it('flags a declaration on a method the internal walk already reaches (INVOKED_BY_REDUNDANT)', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('api-portal', 'Portal', 'portalType: Custom\ndependsOn: [run-orch]');
    proj.contract('api-portal', { handle: [] });
    proj.impl('api-portal', ['methods:', '  - name: handle', '    narrative:', CALL(1, 'run-orch', 'run'), RETURN(2)].join('\n'));
    proj.component('run-orch', 'Orchestrator');
    proj.contract('run-orch', { run: [WELL_DESCRIBED_CALLER] });
    proj.impl('run-orch', ['methods:', '  - name: run', '    narrative:', RETURN(1)].join('\n'));
    proj.activate();
    try {
      const res = validateSddTree();
      const redundant = byCode(res, 'INVOKED_BY_REDUNDANT');
      expect(redundant).toHaveLength(1);
      expect(redundant[0].specId).toBe('irun-orch');
      expect(redundant[0].message).toMatch(/"run" on component "run-orch"/);
      expect(redundant[0].severity).toBe('warning');
    } finally { proj.cleanup(); }
  });

  it('is suppressible per spec via lint.allow on the interface', () => {
    const proj = createTempProject();
    proj.subsystem('sub-a');
    proj.component('worker-orch', 'Orchestrator');
    proj.writeSpec('interface', 'iworker-orch', [
      'schemaVersion: 1.0.0',
      'id: iworker-orch',
      'name: IWorkerOrch',
      'description: contract',
      'component: worker-orch',
      'lint:',
      '  allow:',
      '    - code: INVOKED_BY_UNDESCRIBED',
      '      reason: the caller table lives in the ops runbook, linked from the subsystem description',
      'methods:',
      '  - name: onTimer',
      '    description: onTimer drains the queue on the periodic wakeup',
      '    signature: "onTimer(): void"',
      '    returns: "void"',
      '    invokedBy:',
      '      kind: runtime',
    ].join('\n'));
    proj.impl('worker-orch', ['methods:', '  - name: onTimer', '    narrative:', RETURN(1)].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'INVOKED_BY_UNDESCRIBED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
