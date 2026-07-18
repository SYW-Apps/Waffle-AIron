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
      expect(found[0].message).toContain('set membership');
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
});

describe('buildCodeModel — per-function callee facts (exact grade)', () => {
  const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-callees-'));
  const impl = (sourcePath: string) => ({
    id: 'impl-x', name: 'x', description: 'd', contract: 'ix',
    sourcePath, methods: [], status: 'complete' as const,
    createdAt: '2026-07-18T10:00:00Z', updatedAt: '2026-07-18T10:00:00Z',
  });

  it('collects direct identifier and property-access callees per named function', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        "import { helper } from './b.js';",
        'export function driver(specs: { load(): void }): void { helper(); specs.load(); }',
        'export function bystander(): void {}',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], dir);
      const fc = model.files[0].functionCalls!;
      expect(fc.driver).toEqual(expect.arrayContaining(['helper', 'load']));
      expect(fc.bystander).toEqual([]);
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
      const model = buildCodeModel([impl('a.ts')], dir);
      const fc = model.files[0].functionCalls!;
      expect(fc.outer).toEqual(expect.arrayContaining(['nested', 'outerOnly']));
      expect(fc.outer).not.toContain('inner');
      expect(fc.nested).toEqual(['inner']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
