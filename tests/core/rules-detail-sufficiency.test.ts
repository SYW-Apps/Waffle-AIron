import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { RulesConfigSchema } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// Detail-sufficiency lint (Level 3 opener): a method with real branching in
// its realized function may not hide below detail: full without a narrative
// (UNNARRATED_COMPLEXITY, exact AST grade only), and an explicit dial below a
// logic stereotype's full floor is a visible choice (DETAIL_BELOW_STEREOTYPE).
// Both are warnings over DECLARATIONS — never proofs of narrative correctness.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-detail-suff-test-'));

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

const CODES = ['UNNARRATED_COMPLEXITY', 'DETAIL_BELOW_STEREOTYPE'];
const detailIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => CODES.includes(i.code));

const INTENT = (m: string, extra = '') =>
  `  - name: ${m}${extra}\n    detail: intent\n    intent: Performs ${m} against held state and returns nothing; failures surface as thrown errors.`;

// Cyclomatic complexity 11: ten decision points + 1.
const BRANCHY_FN = (name: string) => [
  `export function ${name}(a: number, b: number): number {`,
  '  if (a > 0) { return 1; }',                       // 1
  '  if (b > 0) { return 2; }',                       // 2
  '  for (let i = 0; i < a; i++) { b += i; }',        // 3
  '  while (b > 10) { b--; }',                        // 4
  '  switch (a) { case 1: return 3; case 2: return 4; default: break; }', // 5, 6
  '  try { b = a / b; } catch { b = 0; }',            // 7
  '  const c = a > b ? a : b;',                       // 8
  '  const d = (a && b) || c;',                       // 9, 10
  '  return d;',
  '}',
].join('\n');

const SIMPLE_FN = (name: string) => `export function ${name}(): void {}\n`;

describe('buildCodeModel — per-function cyclomatic complexity (exact grade)', () => {
  const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-complexity-'));
  const impl = (sourcePath: string) => ({
    id: 'impl-x', name: 'x', description: 'd', contract: 'ix',
    sourcePath, methods: [], status: 'complete' as const,
    createdAt: '2026-07-18T10:00:00Z', updatedAt: '2026-07-18T10:00:00Z',
  });

  it('measures decision points of named functions, arrows, and class methods', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        BRANCHY_FN('branchy'),
        'export const straight = (): number => 1;',
        'export const ternary = (x: number): number => x > 0 ? x : -x;',
        'export class Box { poke(n: number): number { if (n > 0) { return n; } return 0; } }',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], dir);
      const fc = model.files[0].functionComplexity!;
      expect(model.files[0].analysisGrade).toBe('exact');
      expect(fc.branchy).toBe(11);
      expect(fc.straight).toBe(1);
      expect(fc.ternary).toBe(2);
      expect(fc.poke).toBe(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('counts anonymous callbacks into the enclosing function, but not nested NAMED functions', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        'export function outer(xs: number[]): number[] {',
        '  function innerNamed(x: number): number { if (x > 1) { return x; } if (x > 2) { return x; } return 0; }',
        '  return xs.filter(x => x > 0 ? true : false).map(innerNamed);', // callback ternary counts into outer
        '}',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], dir);
      const fc = model.files[0].functionComplexity!;
      expect(fc.outer).toBe(2);       // 1 + callback ternary
      expect(fc.innerNamed).toBe(3);  // its own entry: 1 + two ifs
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('takes the maximum across same-named functions in one file', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'a.ts'), [
        'export const table = { handle: (x: number) => x > 0 ? 1 : 0 };',
        'export function shell(): void { const handle = (a: number, b: number) => (a && b) || (a > b ? a : b); handle(1, 2); }',
      ].join('\n'));
      const model = buildCodeModel([impl('a.ts')], dir);
      expect(model.files[0].functionComplexity!.handle).toBe(4); // max(2, 1+3)
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('carries a re-exported function\'s complexity onto the barrel (export-* chase)', () => {
    const dir = mkTemp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'impl.ts'), BRANCHY_FN('branchy'));
      fs.writeFileSync(path.join(dir, 'src', 'index.ts'), "export * from './impl.js';\n");
      const model = buildCodeModel([impl('src/index.ts')], dir);
      expect(model.files[0].functionComplexity!.branchy).toBe(11);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('omits the complexity map below exact grade — never guesses', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'flow.py'), 'def run_flow():\n    if True:\n        pass\n');
      const model = buildCodeModel([impl('flow.py')], dir);
      expect(model.files[0].analysisGrade).toBe('pattern');
      expect(model.files[0].functionComplexity).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('UNNARRATED_COMPLEXITY — real branching may not hide below detail: full', () => {
  it('fires on an intent-level method realized by a branchy function', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${INTENT('put')}`);
    proj.source('src/store.ts', BRANCHY_FN('put'));
    proj.activate();
    try {
      const found = detailIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('UNNARRATED_COMPLEXITY');
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('impl-store-a');
      expect(found[0].message).toContain('complexity 11');
    } finally { proj.cleanup(); }
  });

  it('stays silent when the realized function is simple', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${INTENT('put')}`);
    proj.source('src/store.ts', SIMPLE_FN('put'));
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('stays silent when a narrative exists — floors, not ceilings', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', [
      'sourcePath: src/store.ts',
      'methods:',
      '  - name: put',
      '    narrative:',
      '      - stepNumber: 1',
      '        description: Validate and persist the entry into held state',
      '        type: local',
    ].join('\n'));
    proj.source('src/store.ts', BRANCHY_FN('put'));
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('resolves the per-method symbol mapping before looking up complexity', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${INTENT('put', '\n    symbol: saveSnapshot')}`);
    proj.source('src/store.ts', BRANCHY_FN('saveSnapshot'));
    proj.activate();
    try {
      const found = detailIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"saveSnapshot"');
    } finally { proj.cleanup(); }
  });

  it('honors the configured threshold', () => {
    const highLimit = createTempProject();
    highLimit.component('store-a', 'Store');
    highLimit.contract('store-a', ['put']);
    highLimit.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${INTENT('put')}`);
    highLimit.source('src/store.ts', BRANCHY_FN('put'));
    highLimit.activate();
    try {
      const rules = RulesConfigSchema.parse({ complexity: { maxUnnarratedComplexity: 20 } });
      expect(detailIssues(validateSddTree({ rules }))).toHaveLength(0);
    } finally { highLimit.cleanup(); }

    const lowLimit = createTempProject();
    lowLimit.component('store-a', 'Store');
    lowLimit.contract('store-a', ['put']);
    lowLimit.impl('store-a', `sourcePath: src/store.ts\nmethods:\n${INTENT('put')}`);
    lowLimit.source('src/store.ts', 'export function put(x: number): number { return x > 0 ? x : 0; }\n');
    lowLimit.activate();
    try {
      const rules = RulesConfigSchema.parse({ complexity: { maxUnnarratedComplexity: 1 } });
      const found = detailIssues(validateSddTree({ rules }));
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('limit 1');
    } finally { lowLimit.cleanup(); }
  });

  it('skips conformance: off methods — the symbol mapping is untrusted there', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `conformance: off\nsourcePath: src/store.ts\nmethods:\n${INTENT('put')}`);
    proj.source('src/store.ts', BRANCHY_FN('put'));
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('never fires below exact analysis grade', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['run_flow']);
    proj.impl('store-a', `sourcePath: src/flow.py\nmethods:\n${INTENT('run_flow')}`);
    proj.source('src/flow.py', 'def run_flow():\n    if True:\n        if True:\n            pass\n');
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', [
      'sourcePath: src/store.ts',
      'lint:',
      '  allow:',
      '    - code: UNNARRATED_COMPLEXITY',
      '      reason: branching is defensive input normalization, not flow worth choreographing',
      'methods:',
      INTENT('put'),
    ].join('\n'));
    proj.source('src/store.ts', BRANCHY_FN('put'));
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('DETAIL_BELOW_STEREOTYPE — explicit dial below a logic stereotype\'s full floor', () => {
  it('fires on an Orchestrator method explicitly dialed to intent (spec-only, no code needed)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `methods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      const found = detailIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('DETAIL_BELOW_STEREOTYPE');
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('Orchestrator');
    } finally { proj.cleanup(); }
  });

  it('accepts the same dial on a Store — its stereotype floor IS intent', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `methods:\n${INTENT('put')}`);
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('accepts the dial on a Repository — a pattern facade forwards to members, it is not a logic block', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.component('repo-a', 'Repository', 'owns: [store-a]');
    proj.contract('repo-a', ['getRecord']);
    proj.impl('repo-a', `methods:\n${INTENT('getRecord')}`);
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('stays silent when the dialed-down method still has a narrative', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    detail: calls-only',
      '    narrative:',
      '      - stepNumber: 1',
      '        description: Delegate the whole flow to the specialist',
      '        type: local',
    ].join('\n'));
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('yields to UNNARRATED_COMPLEXITY when the code-backed finding fires on the same method', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.source('src/orch.ts', BRANCHY_FN('runFlow'));
    proj.activate();
    try {
      const found = detailIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('UNNARRATED_COMPLEXITY');
    } finally { proj.cleanup(); }
  });

  it('does not fire on stereotype-DEFAULTED gaps (a Portal defaulting to calls-only is fine)', () => {
    const proj = createTempProject();
    proj.component('portal-a', 'Portal', 'portalType: Custom\ndependsOn: [orch-a]');
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', [
      'methods:',
      '  - name: runFlow',
      '    narrative:',
      '      - stepNumber: 1',
      '        description: Run the flow end to end',
      '        type: local',
    ].join('\n'));
    proj.contract('portal-a', ['toolCall']);
    // no detail declared anywhere: Portal stereotype default is calls-only
    proj.impl('portal-a', 'methods:\n  - name: toolCall\n    intent: Forwards the tool invocation to the orchestrator and maps errors onto the wire shape.');
    proj.activate();
    try {
      expect(detailIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
