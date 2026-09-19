import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// L5 semantic lints — spec-level bug detection, restricted to what structure
// PROVES: inescapable step cycles, meaningless branches, unconditional
// cross-component call cycles (Wave 1), and call-step realization against the
// realized function's callees (Wave 2, the Level-3 opener).
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-nar-sem-test-'));

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

  const stamp = "createdAt: '2026-07-18T10:00:00Z'\nupdatedAt: '2026-07-18T10:00:00Z'";
  const writeSpec = (type: string, name: string, content: string) => {
    const filePath = type === 'system'
      ? path.join(specsDir, '.index.yaml')
      : path.join(specsDir, `${type}s`, `${name}.yaml`);
    fs.writeFileSync(filePath, `${content}\n${stamp}\n`);
  };

  writeSpec('system', 'system', 'schemaVersion: 1.0.0\nname: TestSystem\nvision: testing');
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem');

  return {
    tempDir,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: string[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        ...methods.map(m => [
          `  - name: ${m}`,
          `    description: ${m} does its one thing, carefully and observably`,
          `    signature: "${m}(): void"`,
          '    returns: "void"',
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

describe('INESCAPABLE_CYCLE — provable non-termination in one narrative', () => {
  it('flags a jump cycle with no exit edge and no terminator', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Prepare the run context, type: local }',
      '      - { stepNumber: 2, description: Poll the state again, type: local }',
      '      - { stepNumber: 3, description: Loop back forever, type: jump, toStep: 2 }',
    ].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'INESCAPABLE_CYCLE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('2 → 3');
      expect(found[0].message).toContain('never terminates');
    } finally { proj.cleanup(); }
  });

  it('stays silent when the cycle has an exit branch', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Poll the state, type: local }',
      '      - { stepNumber: 2, description: Check whether the state settled, type: branch, condition: state settled, onTrueStep: 4, onFalseStep: 3 }',
      '      - { stepNumber: 3, description: Wait and retry, type: jump, toStep: 1 }',
      '      - { stepNumber: 4, description: Done, type: return, outcome: settled state }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'INESCAPABLE_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('stays silent for loop steps — a loop header always carries its after-region exit', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Repeat until drained, type: loop, loopKind: while, condition: queue not empty, endStep: 2 }',
      '      - { stepNumber: 2, description: Drain one entry, type: local }',
      '      - { stepNumber: 3, description: Done, type: return, outcome: drained }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'INESCAPABLE_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('MEANINGLESS_BRANCH — decisions that decide nothing', () => {
  it('flags a branch whose arms land on the same step', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Check the flag, type: branch, condition: flag set, onTrueStep: 2, onFalseStep: 2 }',
      '      - { stepNumber: 2, description: Do the thing either way, type: local }',
      '      - { stepNumber: 3, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'MEANINGLESS_BRANCH');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('decides nothing');
    } finally { proj.cleanup(); }
  });

  it('flags a switch whose every case and default target the same step', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - stepNumber: 1',
      '        description: Dispatch on kind',
      '        type: switch',
      '        on: kind',
      '        cases:',
      '          - { value: a, step: 2 }',
      '          - { value: b, step: 2 }',
      '        defaultStep: 2',
      '      - { stepNumber: 2, description: Handle every kind identically, type: local }',
      '      - { stepNumber: 3, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'MEANINGLESS_BRANCH')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('stays silent for a real decision', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Check the flag, type: branch, condition: flag set, onTrueStep: 2, onFalseStep: 3 }',
      '      - { stepNumber: 2, description: Fast path, type: return, outcome: fast }',
      '      - { stepNumber: 3, description: Slow path, type: return, outcome: slow }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'MEANINGLESS_BRANCH')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('UNCONDITIONAL_CALL_CYCLE — unbounded recursion across components', () => {
  const CALL = (n: number, comp: string, method: string) =>
    `      - { stepNumber: ${n}, description: Call ${comp}.${method}, type: call, targetComponent: ${comp}, targetMethod: ${method} }`;

  it('flags a two-component cycle whose every edge is unavoidable', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [orch-b]');
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [orch-a]');
    proj.contract('orch-a', ['ping']);
    proj.contract('orch-b', ['pong']);
    proj.impl('orch-a', ['methods:', '  - name: ping', '    narrative:', CALL(1, 'orch-b', 'pong'), '      - { stepNumber: 2, description: Done, type: return, outcome: done }'].join('\n'));
    proj.impl('orch-b', ['methods:', '  - name: pong', '    narrative:', CALL(1, 'orch-a', 'ping'), '      - { stepNumber: 2, description: Done, type: return, outcome: done }'].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('orch-a::ping');
      expect(found[0].message).toContain('orch-b::pong');
      expect(found[0].message).toContain('recurses without a base case');
    } finally { proj.cleanup(); }
  });

  it('stays silent when one edge is guarded by a branch that can skip it', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [orch-b]');
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [orch-a]');
    proj.contract('orch-a', ['ping']);
    proj.contract('orch-b', ['pong']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: ping',
      '    narrative:',
      '      - { stepNumber: 1, description: Base case reached, type: branch, condition: depth exhausted, onTrueStep: 3, onFalseStep: 2 }',
      CALL(2, 'orch-b', 'pong'),
      '      - { stepNumber: 3, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.impl('orch-b', ['methods:', '  - name: pong', '    narrative:', CALL(1, 'orch-a', 'ping'), '      - { stepNumber: 2, description: Done, type: return, outcome: done }'].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags an unconditional self-recursion', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['ping']);
    proj.impl('orch-a', ['methods:', '  - name: ping', '    narrative:', CALL(1, 'orch-a', 'ping'), '      - { stepNumber: 2, description: Done, type: return, outcome: done }'].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow on the anchor implementation', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['ping']);
    proj.impl('orch-a', [
      'lint:',
      '  allow:',
      '    - code: UNCONDITIONAL_CALL_CYCLE',
      '      reason: bounded by the queue the callee drains — termination argued in the design record',
      'methods:',
      '  - name: ping',
      '    narrative:',
      CALL(1, 'orch-a', 'ping'),
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('antipatterns follow the step graph — parallel joins and completion', () => {
  const CALL = (n: number, comp: string, method: string) =>
    `      - { stepNumber: ${n}, description: Call ${comp}.${method}, type: call, targetComponent: ${comp}, targetMethod: ${method} }`;
  const DONE = (n: number) => `      - { stepNumber: ${n}, description: Done, type: return, outcome: done }`;

  it('MEANINGLESS_BRANCH: a branch ending a parallel arm falls through to the join, not into the next arm', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Fan out the lookups, type: parallel, branches: [{ step: 2 }, { step: 4 }], endStep: 5 }',
      '      - { stepNumber: 2, description: Warm the cache, type: local }',
      '      - { stepNumber: 3, description: Skip to the join once the cache is warm, type: branch, condition: cache is warm, onFalseStep: 6 }',
      '      - { stepNumber: 4, description: Fetch the profile, type: local }',
      '      - { stepNumber: 5, description: Fetch the settings, type: local }',
      DONE(6),
    ].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'MEANINGLESS_BRANCH');
      expect(found.map(i => i.message)).toEqual([expect.stringContaining('branch step 3 sends both arms to step 6')]);
    } finally { proj.cleanup(); }
  });

  it('MEANINGLESS_BRANCH: a switch default ending a parallel arm falls through to the join', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Fan out the lookups, type: parallel, branches: [{ step: 2 }, { step: 4 }], endStep: 5 }',
      '      - { stepNumber: 2, description: Classify the request, type: local }',
      '      - { stepNumber: 3, description: Skip to the join for bulk requests, type: switch, on: request kind, cases: [{ value: bulk, step: 6 }] }',
      '      - { stepNumber: 4, description: Fetch the profile, type: local }',
      '      - { stepNumber: 5, description: Fetch the settings, type: local }',
      DONE(6),
    ].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'MEANINGLESS_BRANCH');
      expect(found.map(i => i.message)).toEqual([expect.stringContaining('switch step 3 sends every case (and the default) to step 6')]);
    } finally { proj.cleanup(); }
  });

  it('MEANINGLESS_BRANCH stays silent for a switch whose default completes the method off the end', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Read the job state, type: local }',
      '      - { stepNumber: 2, description: Handle the job once more, type: local }',
      '      - { stepNumber: 3, description: Route the job by its state, type: switch, on: job state, cases: [{ value: retry, step: 2 }, { value: requeue, step: 2 }] }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'MEANINGLESS_BRANCH')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('INESCAPABLE_CYCLE stays silent when the cycle exits by falling off the end of the narrative', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Prepare the run context, type: local }',
      '      - { stepNumber: 2, description: Poll the state, type: local }',
      '      - { stepNumber: 3, description: Poll again until the state settles, type: branch, condition: state settled, onFalseStep: 2 }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'INESCAPABLE_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('UNCONDITIONAL_CALL_CYCLE: every parallel arm runs, so a call inside an arm is unavoidable', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [orch-b]');
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [orch-a]');
    proj.contract('orch-a', ['ping']);
    proj.contract('orch-b', ['pong']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: ping',
      '    narrative:',
      '      - { stepNumber: 1, description: Fan out the notification and the audit, type: parallel, branches: [{ step: 2 }, { step: 3 }], endStep: 3 }',
      CALL(2, 'orch-b', 'pong'),
      '      - { stepNumber: 3, description: Record the audit entry, type: local }',
      DONE(4),
    ].join('\n'));
    proj.impl('orch-b', ['methods:', '  - name: pong', '    narrative:', CALL(1, 'orch-a', 'ping'), DONE(2)].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('UNCONDITIONAL_CALL_CYCLE: an arm that can skip its call guards the cycle, even when the arm completes at a join past the end', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [orch-b]');
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [orch-a]');
    proj.contract('orch-a', ['ping']);
    proj.contract('orch-b', ['pong']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: ping',
      '    narrative:',
      '      - { stepNumber: 1, description: Fan out the notification and the audit, type: parallel, branches: [{ step: 2 }, { step: 5 }], endStep: 5 }',
      '      - { stepNumber: 2, description: Skip the notification once it was sent, type: branch, condition: already notified, onTrueStep: 4, onFalseStep: 3 }',
      CALL(3, 'orch-b', 'pong'),
      '      - { stepNumber: 4, description: Note the notification outcome, type: local }',
      '      - { stepNumber: 5, description: Record the audit entry, type: local }',
    ].join('\n'));
    proj.impl('orch-b', ['methods:', '  - name: pong', '    narrative:', CALL(1, 'orch-a', 'ping'), DONE(2)].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('UNCONDITIONAL_CALL_CYCLE anchors on the first cycle member by code unit, not by locale collation', () => {
    // By code unit "-" (U+002D) sorts before "_" (U+005F), while locale
    // collation puts "_" first. The anchor follows the order the path reports.
    const proj = createTempProject();
    proj.component('orch_a', 'Orchestrator', 'dependsOn: [orch-b]');
    proj.component('orch-b', 'Orchestrator', 'dependsOn: [orch_a]');
    proj.contract('orch_a', ['ping']);
    proj.contract('orch-b', ['pong']);
    proj.impl('orch_a', ['methods:', '  - name: ping', '    narrative:', CALL(1, 'orch-b', 'pong'), DONE(2)].join('\n'));
    proj.impl('orch-b', ['methods:', '  - name: pong', '    narrative:', CALL(1, 'orch_a', 'ping'), DONE(2)].join('\n'));
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'UNCONDITIONAL_CALL_CYCLE');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('orch-b::pong → orch_a::ping');
      expect(found[0].specId).toBe('impl-orch-b');
    } finally { proj.cleanup(); }
  });
});

describe('CALL_STEP_UNREALIZED — the narrative call must exist in the realized function', () => {
  const NARRATIVE_CALL = [
    'methods:',
    '  - name: runFlow',
    '    narrative:',
    '      - { stepNumber: 1, description: Delegate to the store, type: call, targetComponent: store-a, targetMethod: put }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n');

  const storeSide = (proj: ReturnType<typeof createTempProject>) => {
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', 'sourcePath: src/store.ts\nmethods:\n  - name: put\n    detail: intent\n    intent: Persists the entry into held state keyed by id; overwrites silently on collision.');
    proj.source('src/store.ts', 'export function put(): void {}\n');
  };

  it('passes when the realized function makes the call', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', `sourcePath: src/orch.ts\n${NARRATIVE_CALL}`);
    proj.source('src/orch.ts', "import { put } from './store.js';\nexport function runFlow(): void { put(); }\n");
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags a claimed call the realized function never makes', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', `sourcePath: src/orch.ts\n${NARRATIVE_CALL}`);
    proj.source('src/orch.ts', 'export function runFlow(): void { /* forgot the store */ }\n');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'CALL_STEP_UNREALIZED');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('store-a.put');
      expect(found[0].message).toContain('resolves to the target');
    } finally { proj.cleanup(); }
  });

  it('sees calls made through same-file named helpers (transitive closure)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', `sourcePath: src/orch.ts\n${NARRATIVE_CALL}`);
    proj.source('src/orch.ts', [
      "import { put } from './store.js';",
      'function persistViaHelper(): void { put(); }',
      'export function runFlow(): void { persistViaHelper(); }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('accepts the target method\'s symbol override as the realized callee', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', 'sourcePath: src/store.ts\nmethods:\n  - name: put\n    symbol: saveSnapshot\n    detail: intent\n    intent: Persists the snapshot into held state keyed by project; overwrites silently.');
    proj.source('src/store.ts', 'export function saveSnapshot(): void {}\n');
    proj.impl('orch-a', `sourcePath: src/orch.ts\n${NARRATIVE_CALL}`);
    proj.source('src/orch.ts', "import { saveSnapshot } from './store.js';\nexport function runFlow(): void { saveSnapshot(); }\n");
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('accepts N:1 identity forwarding — the facade method\'s symbol IS the target function', () => {
    const proj = createTempProject();
    proj.component('facade-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('facade-a', ['save']);
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', 'sourcePath: src/store.ts\nmethods:\n  - name: put\n    detail: intent\n    intent: Persists the entry into held state keyed by id; overwrites silently on collision.');
    // Facade and target seated on the SAME function via the symbol map: the
    // facade's `save` is realized by the code name `put` — pure 1:1 forwarding
    // collapsed onto one function, exactly as Level 1's N:1 sharing blesses.
    // `put` calls nothing, so the narrative call step is realized ONLY through
    // the identity collapse (fnSymbol ∈ accepted), never through the callees.
    proj.impl('facade-a', [
      'sourcePath: src/store.ts',
      'methods:',
      '  - name: save',
      '    symbol: put',
      '    narrative:',
      '      - { stepNumber: 1, description: Delegate to the store, type: call, targetComponent: store-a, targetMethod: put }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.source('src/store.ts', 'export function put(): void {}\n');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('the identity collapse is load-bearing: the same shape WITHOUT the symbol identity flags the step', () => {
    // Identical fixture minus the identity condition: the facade seats on its
    // own name (`save` exists in the same file, callees defined and empty), so
    // nothing collapses and the claimed call to `put` must actually appear.
    const proj = createTempProject();
    proj.component('facade-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('facade-a', ['save']);
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', 'sourcePath: src/store.ts\nmethods:\n  - name: put\n    detail: intent\n    intent: Persists the entry into held state keyed by id; overwrites silently on collision.');
    proj.impl('facade-a', [
      'sourcePath: src/store.ts',
      'methods:',
      '  - name: save',
      '    narrative:',
      '      - { stepNumber: 1, description: Delegate to the store, type: call, targetComponent: store-a, targetMethod: put }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.source('src/store.ts', 'export function put(): void {}\nexport function save(): void { /* forwards nothing */ }\n');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'CALL_STEP_UNREALIZED');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('store-a.put');
      expect(found[0].message).toContain('"save"');
    } finally { proj.cleanup(); }
  });

  it('skips conformance: off methods and never fires below exact grade', () => {
    const offProj = createTempProject();
    offProj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    offProj.contract('orch-a', ['runFlow']);
    storeSide(offProj);
    offProj.impl('orch-a', `conformance: off\nsourcePath: src/orch.ts\n${NARRATIVE_CALL}`);
    offProj.source('src/orch.ts', 'export function runFlow(): void {}\n');
    offProj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { offProj.cleanup(); }

    const pyProj = createTempProject();
    pyProj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    pyProj.contract('orch-a', ['runFlow']);
    storeSide(pyProj);
    pyProj.impl('orch-a', `sourcePath: src/orch.py\n${NARRATIVE_CALL}`);
    pyProj.source('src/orch.py', 'def runFlow():\n    pass\n');
    pyProj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { pyProj.cleanup(); }
  });

  // A narrated runFlow whose own body lives in a command module of its own.
  const METHOD_FILE_CALL = (implPath: string | undefined) => [
    ...(implPath ? [`sourcePath: ${implPath}`] : []),
    'methods:',
    '  - name: runFlow',
    '    sourcePath: src/commands/run-flow.ts',
    '    narrative:',
    '      - { stepNumber: 1, description: Delegate to the store, type: call, targetComponent: store-a, targetMethod: put }',
    '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
  ].join('\n');

  it('reads the realized function in the method\'s own source file, naming that file', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', METHOD_FILE_CALL('src/orch.ts'));
    // the implementation file keeps a stale runFlow that still calls the store
    proj.source('src/orch.ts', "import { put } from './store.js';\nexport function runFlow(): void { put(); }\n");
    proj.source('src/commands/run-flow.ts', 'export function runFlow(): void { /* the store call was dropped */ }\n');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'CALL_STEP_UNREALIZED');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"src/commands/run-flow.ts"');
    } finally { proj.cleanup(); }
  });

  it('a call made in the method\'s own source file is realized even when the implementation file lacks it', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', METHOD_FILE_CALL('src/orch.ts'));
    proj.source('src/orch.ts', 'export function runFlow(): void {}\n');
    proj.source('src/commands/run-flow.ts', "import { put } from '../store.js';\nexport function runFlow(): void { put(); }\n");
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a method naming its own source file is checked even when the implementation names no path', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    storeSide(proj);
    proj.impl('orch-a', METHOD_FILE_CALL(undefined));
    proj.source('src/commands/run-flow.ts', 'export function runFlow(): void { /* forgot the store */ }\n');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });
});

describe('buildCodeModel — per-function callee facts (exact grade)', () => {
  const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-callees-'));
  const impl = (sourcePath: string) => ({
    id: 'impl-x', name: 'x', description: 'd', contract: 'ix',
    sourcePath, methods: [], status: 'complete' as const,
    createdAt: '2026-07-18T10:00:00Z', updatedAt: '2026-07-18T10:00:00Z',
  });

  /** The callee names of one named function-like, off its recorded call sites. */
  const calleeNames = (facts: { functionCallSites?: Record<string, { name: string }[]> }, fn: string): string[] =>
    (facts.functionCallSites ?? {})[fn].map((s) => s.name);

  it('collects direct identifier and property-access call sites per named function, each carrying its shape', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        "import { helper } from './b.js';",
        'export function driver(specs: { load(): void }): void { helper(); specs.load(); }',
        'export function bystander(): void {}',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], [], dir);
      const sites = model.files[0].functionCallSites!;
      expect(calleeNames(model.files[0], 'driver')).toEqual(expect.arrayContaining(['helper', 'load']));
      // Shape is the fact a name alone would lose: `helper()` resolves through
      // this file's import binding, `specs.load()` through its receiver.
      expect(sites.driver).toEqual(expect.arrayContaining([
        { name: 'helper', member: false },
        { name: 'load', member: true, via: 'specs' },
      ]));
      expect(sites.bystander).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('survives callee names that collide with Object.prototype members (toString, constructor)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [store-a]');
    proj.contract('orch-a', ['runFlow']);
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', 'sourcePath: src/store.ts\nmethods:\n  - name: put\n    detail: intent\n    intent: Persists the entry into held state keyed by id; overwrites silently on collision.');
    proj.source('src/store.ts', 'export function put(): void {}\n');
    proj.impl('orch-a', [
      'sourcePath: src/orch.ts',
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - { stepNumber: 1, description: Delegate to the store, type: call, targetComponent: store-a, targetMethod: put }',
      '      - { stepNumber: 2, description: Done, type: return, outcome: done }',
    ].join('\n'));
    proj.source('src/orch.ts', [
      "import { put } from './store.js';",
      // callees include prototype-member names — the closure walk must not
      // resolve them to Object.prototype functions
      'export function runFlow(x: object): void { x.toString(); (x as { hasOwnProperty(k: string): boolean }).hasOwnProperty("y"); put(); }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'CALL_STEP_UNREALIZED')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('excludes nested NAMED functions\' callees from the parent (they get their own entries)', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        'declare function inner(): void; declare function outerOnly(): void;',
        'export function outer(): void { function nested(): void { inner(); } nested(); outerOnly(); }',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], [], dir);
      expect(calleeNames(model.files[0], 'outer')).toEqual(expect.arrayContaining(['nested', 'outerOnly']));
      expect(calleeNames(model.files[0], 'outer')).not.toContain('inner');
      expect(calleeNames(model.files[0], 'nested')).toEqual(['inner']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
