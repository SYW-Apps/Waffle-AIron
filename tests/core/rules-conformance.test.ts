import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree, type ValidationIssue } from '../../src/core/validation.js';
import { buildCodeModel } from '../../src/core/source-analysis.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { knownIssueCodes, registerBuiltinRules, registerPackRules } from '../../src/core/rules/repository.js';
import { emptyExtensions, type LoadedExtensions } from '../../src/core/extensions.js';
import { structuralConformanceRule } from '../../src/core/rules/conformance.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

/** The known issue codes a rule context carries, gathered as the validator gathers them. */
function gatherKnownIssueCodes(extensions: LoadedExtensions = emptyExtensions()): Set<string> {
  registerBuiltinRules();
  registerPackRules(extensions.rules);
  return new Set([...knownIssueCodes().map((c) => c.code), ...extensions.assertions.map((a) => a.fullCode)]);
}

// ---------------------------------------------------------------------------
// Structural conformance (code↔spec Level 1): sourcePaths must resolve to real
// files inside the project root, and contract methods must be realized in
// those files at the implementation's conformance tier.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-conform-test-'));

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

  const stamp = "createdAt: '2026-07-11T10:00:00Z'\nupdatedAt: '2026-07-11T10:00:00Z'";
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
    writeSpec,
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
          `    description: ${m} does its one thing`,
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

const CODES = ['MISSING_SOURCE_PATH', 'MISSING_SOURCE_FILE', 'SOURCE_PATH_ESCAPES_ROOT', 'UNREALIZED_METHOD', 'CONFORMANCE_ANALYSIS_SKIPPED'];
const conformanceIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => CODES.includes(i.code));

const INTENT = (m: string) =>
  `  - name: ${m}\n    detail: intent\n    intent: Performs ${m} against held state and returns nothing; failures surface as thrown errors.`;

describe('structural conformance — file level', () => {
  it('flags a sourcePath that resolves to no file as an error', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `sourcePath: src/gone.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('MISSING_SOURCE_FILE');
      expect(found[0].severity).toBe('error');
      expect(found[0].specId).toBe('impl-orch-a');
    } finally { proj.cleanup(); }
  });

  it('refuses absolute and parent-escaping sourcePaths (containment)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `sourcePath: ../outside.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['SOURCE_PATH_ESCAPES_ROOT']);
      expect(found[0].severity).toBe('error');
    } finally { proj.cleanup(); }
  });

  it('warns about a complete implementation with no sourcePath at all', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `methods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['MISSING_SOURCE_PATH']);
      expect(found[0].severity).toBe('warning');
    } finally { proj.cleanup(); }
  });

  it('fires MISSING_SOURCE_PATH when the implementation names no source file at all and the contract has no methods', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.writeSpec('interface', 'iorch-a', [
      'schemaVersion: 1.0.0',
      'id: iorch-a',
      'name: IOrchA',
      'description: contract',
      'component: orch-a',
    ].join('\n'));
    proj.impl('orch-a', '');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['MISSING_SOURCE_PATH']);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('names no source file at all');
    } finally { proj.cleanup(); }
  });

  it('the `implementation` external link suppression also holds when the contract has no methods', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'externalLinks:\n  - url: "https://make.com/scenarios/42"\n    type: implementation\n    label: "Make scenario"');
    proj.writeSpec('interface', 'iorch-a', [
      'schemaVersion: 1.0.0',
      'id: iorch-a',
      'name: IOrchA',
      'description: contract',
      'component: orch-a',
    ].join('\n'));
    proj.impl('orch-a', '');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an `implementation` external link on the component satisfies the source requirement (no MISSING_SOURCE_PATH)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'externalLinks:\n  - url: "https://make.com/scenarios/42"\n    type: implementation\n    label: "Make scenario"');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `methods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      // The external source-of-record stands in for a local sourcePath — nothing to check.
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an `informative` external link does NOT satisfy the source requirement (still MISSING_SOURCE_PATH)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'externalLinks:\n  - url: "https://docs.example.com"\n    type: informative');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `methods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree()).map(i => i.code)).toEqual(['MISSING_SOURCE_PATH']);
    } finally { proj.cleanup(); }
  });

  it('waives conformance findings to draft context on draft implementations', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `status: draft\nsourcePath: src/gone.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found).toHaveLength(1);
      // completeness-classed: error downgrades to warning in a draft context
      expect(found[0].severity).toBe('warning');
      expect((found[0] as { draftContext?: boolean }).draftContext).toBe(true);
    } finally { proj.cleanup(); }
  });
});

describe('structural conformance — method realization (exact TS analysis)', () => {
  it('passes when contract methods are exported functions', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow', 'stopFlow']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${INTENT('runFlow')}\n${INTENT('stopFlow')}`);
    proj.source('src/orch.ts', 'export function runFlow(): void {}\nexport function stopFlow(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('flags a contract method with no anchor in the file (declared tier)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow', 'vanished']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${INTENT('runFlow')}\n${INTENT('vanished')}`);
    proj.source('src/orch.ts', 'export function runFlow(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('UNREALIZED_METHOD');
      expect(found[0].message).toContain('"vanished"');
      expect(found[0].message).toContain('analysis grade: exact');
    } finally { proj.cleanup(); }
  });

  it('accepts nested declarations, destructured bindings, and object-literal keys at the declared tier', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['inner', 'destructured', 'propertyKey']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${INTENT('inner')}\n${INTENT('destructured')}\n${INTENT('propertyKey')}`);
    proj.source('src/orch.ts', [
      'export function outer(): void {',
      '  function inner(): void {}',
      '  inner();',
      '}',
      "const { destructured } = require('./elsewhere');",
      'export const table = { propertyKey: () => undefined };',
    ].join('\n'));
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('Portals default to the anchored tier: a string-literal registration realizes the method', () => {
    const proj = createTempProject();
    proj.component('portal-a', 'Portal', 'portalType: Custom\ndependsOn: [orch-a]');
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `sourcePath: src/portal.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.contract('portal-a', ['toolCall']);
    proj.impl('portal-a', `sourcePath: src/portal.ts\nmethods:\n${INTENT('toolCall')}`);
    proj.source('src/portal.ts', "export function runFlow(): void {}\nregisterTool('toolCall', () => runFlow());\nfunction registerTool(name: string, fn: () => void): void { fn(); }\n");
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a non-Portal is NOT satisfied by a bare string anchor, and the hint names the weak anchor', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['ghostly']);
    proj.impl('orch-a', `sourcePath: src/orch.ts\nmethods:\n${INTENT('ghostly')}`);
    proj.source('src/orch.ts', "export const label = 'ghostly';\n");
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('UNREALIZED_METHOD');
      expect(found[0].message).toContain('weak string/word anchor');
    } finally { proj.cleanup(); }
  });

  it('per-method symbol maps an intent-language contract name onto the code name', () => {
    const proj = createTempProject();
    proj.component('store-a', 'Store');
    proj.contract('store-a', ['put']);
    proj.impl('store-a', `sourcePath: src/store.ts\nmethods:\n  - name: put\n    symbol: saveSnapshot\n    detail: intent\n    intent: Persists the snapshot into held state keyed by project; overwrites silently.`);
    proj.source('src/store.ts', 'export function saveSnapshot(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('the conformance dial: off skips method checks but never the file check', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['generatedThing']);
    proj.impl('orch-a', `conformance: off\nsourcePath: src/generated.ts\nmethods:\n${INTENT('generatedThing')}`);
    proj.source('src/generated.ts', '// generated artifact — names mangled\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }

    const proj2 = createTempProject();
    proj2.component('orch-a', 'Orchestrator');
    proj2.contract('orch-a', ['generatedThing']);
    proj2.impl('orch-a', `conformance: off\nsourcePath: src/gone.ts\nmethods:\n${INTENT('generatedThing')}`);
    proj2.activate();
    try {
      expect(conformanceIssues(validateSddTree()).map(i => i.code)).toEqual(['MISSING_SOURCE_FILE']);
    } finally { proj2.cleanup(); }
  });

  it('chases export-* barrels so a re-export file realizes what it publishes', () => {
    const proj = createTempProject();
    proj.component('portal-a', 'Portal', 'portalType: Custom\ndependsOn: [orch-a]');
    proj.component('orch-a', 'Orchestrator');
    proj.contract('orch-a', ['runFlow']);
    proj.impl('orch-a', `sourcePath: src/impl.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.contract('portal-a', ['runFlow']);
    proj.impl('portal-a', `sourcePath: src/index.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.source('src/impl.ts', 'export function runFlow(): void {}\n');
    proj.source('src/index.ts', "export * from './impl.js';\n");
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('lint.allow silences UNREALIZED_METHOD per spec, and N:1 file sharing is native', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.component('orch-b', 'Orchestrator');
    proj.contract('orch-a', ['sharedThing']);
    proj.contract('orch-b', ['oddOne']);
    proj.impl('orch-a', `sourcePath: src/shared.ts\nmethods:\n${INTENT('sharedThing')}`);
    proj.impl('orch-b', `sourcePath: src/shared.ts\nlint:\n  allow:\n    - code: UNREALIZED_METHOD\n      reason: realized dynamically via metaprogramming — documented exception\nmethods:\n${INTENT('oddOne')}`);
    proj.source('src/shared.ts', 'export function sharedThing(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

// A method naming its own source file (extra lines ride under the same list item).
const INTENT_AT = (m: string, file: string, extra = '') => `${INTENT(m)}\n    sourcePath: ${file}${extra}`;

describe('structural conformance — each method against its own source file', () => {
  it('checks a method against the file it names, not the implementation file, and names that file', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    // the implementation file still carries a stale lockSpecs; the file the method names does not
    proj.source('src/cli.ts', 'export function listTargets(): void {}\nexport function lockSpecs(): void {}\n');
    proj.source('src/commands/lock.ts', 'export function readLockFile(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['UNREALIZED_METHOD']);
      expect(found[0].message).toContain('"lockSpecs"');
      expect(found[0].message).toContain('"src/commands/lock.ts"');
    } finally { proj.cleanup(); }
  });

  it('a method realized in the file it names passes even when the implementation file lacks it', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/cli.ts', 'export function listTargets(): void {}\n');
    proj.source('src/commands/lock.ts', 'export function lockSpecs(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('reports a missing method file once, naming the file and every method using it', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs', 'unlockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}\n${INTENT_AT('unlockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/cli.ts', 'export function listTargets(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['MISSING_SOURCE_FILE']);
      expect(found[0].severity).toBe('error');
      expect(found[0].specId).toBe('impl-cli-orch');
      expect(found[0].message).toContain('"src/commands/lock.ts"');
      expect(found[0].message).toContain('methods "lockSpecs", "unlockSpecs"');
    } finally { proj.cleanup(); }
  });

  it('a missing implementation file blocks only the methods realized in it', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/gone.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/commands/lock.ts', 'export function readLockFile(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code).sort()).toEqual(['MISSING_SOURCE_FILE', 'UNREALIZED_METHOD']);
      const unrealized = found.find(i => i.code === 'UNREALIZED_METHOD')!;
      expect(unrealized.message).toContain('"lockSpecs"');
      expect(found.some(i => i.message.includes('"listTargets"'))).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('a missing method file blocks only that method — the implementation file is still checked', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/cli.ts', 'export function printBanner(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code).sort()).toEqual(['MISSING_SOURCE_FILE', 'UNREALIZED_METHOD']);
      const unrealized = found.find(i => i.code === 'UNREALIZED_METHOD')!;
      expect(unrealized.message).toContain('"listTargets"');
      expect(unrealized.message).toContain('"src/cli.ts"');
    } finally { proj.cleanup(); }
  });

  it('escaping and unreadable method files report once each, naming the method', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs', 'exportBundle']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', '../outside/lock.ts')}\n${INTENT_AT('exportBundle', 'native/bundle.node')}`);
    proj.source('src/cli.ts', 'export function listTargets(): void {}\n');
    proj.source('native/bundle.node', 'MZ\u0000\u0003bundle\u0000');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code).sort()).toEqual(['CONFORMANCE_ANALYSIS_SKIPPED', 'SOURCE_PATH_ESCAPES_ROOT']);
      const escaped = found.find(i => i.code === 'SOURCE_PATH_ESCAPES_ROOT')!;
      expect(escaped.message).toContain('method "lockSpecs"');
      expect(escaped.message).toContain('"../outside/lock.ts"');
      const skipped = found.find(i => i.code === 'CONFORMANCE_ANALYSIS_SKIPPED')!;
      expect(skipped.message).toContain('method "exportBundle"');
      expect(skipped.message).toContain('"native/bundle.node"');
    } finally { proj.cleanup(); }
  });

  it('the existence check of a method file applies at the off tier', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `sourcePath: src/cli.ts\nmethods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts', '\n    conformance: off')}`);
    proj.source('src/cli.ts', 'export function listTargets(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree()).map(i => i.code)).toEqual(['MISSING_SOURCE_FILE']);
    } finally { proj.cleanup(); }
  });

  it('no MISSING_SOURCE_PATH when the implementation has no path but every contract method names its own file', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs']);
    proj.impl('cli-orch', `methods:\n${INTENT_AT('listTargets', 'src/commands/list.ts')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/commands/list.ts', 'export function listTargets(): void {}\n');
    proj.source('src/commands/lock.ts', 'export function lockSpecs(): void {}\n');
    proj.activate();
    try {
      expect(conformanceIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('MISSING_SOURCE_PATH names only the contract methods left without a file, and the rest are still checked', () => {
    const proj = createTempProject();
    proj.component('cli-orch', 'Orchestrator');
    proj.contract('cli-orch', ['listTargets', 'lockSpecs', 'unlockSpecs']);
    // unlockSpecs has no L4 method entry at all, so it has no file either
    proj.impl('cli-orch', `methods:\n${INTENT('listTargets')}\n${INTENT_AT('lockSpecs', 'src/commands/lock.ts')}`);
    proj.source('src/commands/lock.ts', 'export function readLockFile(): void {}\n');
    proj.activate();
    try {
      const found = conformanceIssues(validateSddTree());
      expect(found.map(i => i.code).sort()).toEqual(['MISSING_SOURCE_PATH', 'UNREALIZED_METHOD']);
      const missingPath = found.find(i => i.code === 'MISSING_SOURCE_PATH')!;
      expect(missingPath.message).toContain('"listTargets", "unlockSpecs"');
      expect(missingPath.message).not.toContain('"lockSpecs"');
      expect(found.find(i => i.code === 'UNREALIZED_METHOD')!.message).toContain('"src/commands/lock.ts"');
    } finally { proj.cleanup(); }
  });
});

describe('UNREALIZED_FINDING — declared finding codes appear as string literals in the method source file', () => {
  // An auditor contract whose methods declare the finding codes they report.
  const auditContract = (proj: ReturnType<typeof createTempProject>, methods: { name: string; findings: string[] }[]) =>
    proj.writeSpec('interface', 'iaudit-orch', [
      'schemaVersion: 1.0.0',
      'id: iaudit-orch',
      'name: IAuditOrch',
      'description: contract',
      'component: audit-orch',
      'methods:',
      ...methods.map(m => [
        `  - name: ${m.name}`,
        `    description: ${m.name} audits one record and reports each discrepancy`,
        `    signature: "${m.name}(): void"`,
        '    returns: "void"',
        ...(m.findings.length ? ['    findings:'] : []),
        ...m.findings.map(code => [
          `      - code: ${code}`,
          '        severity: warning',
          '        summary: The audited record disagrees with its source',
        ].join('\n')),
      ].join('\n')),
    ].join('\n'));
  const findingIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
    res.issues.filter(i => i.code === 'UNREALIZED_FINDING');

  it('fires for a declared code missing from the file, naming code, method, contract, file and grade', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['INVOICE_TOTAL_MISMATCH', 'MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT('auditInvoice')}`);
    proj.source('src/audit.ts', "export function auditInvoice(report: (code: string) => void): void {\n  report('INVOICE_TOTAL_MISMATCH');\n  report('TAX_ID_MISSING');\n}\n");
    proj.activate();
    try {
      const found = findingIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('impl-audit-orch');
      expect(found[0].message).toContain('"MISSING_TAX_ID"');
      expect(found[0].message).toContain('"auditInvoice"');
      expect(found[0].message).toContain('"iaudit-orch"');
      expect(found[0].message).toContain('"src/audit.ts"');
      expect(found[0].message).toContain('analysis grade: exact');
    } finally { proj.cleanup(); }
  });

  it('stays quiet when every declared code appears as a string literal', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['INVOICE_TOTAL_MISMATCH', 'MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT('auditInvoice')}`);
    proj.source('src/audit.ts', "export function auditInvoice(report: (code: string) => void): void {\n  report('INVOICE_TOTAL_MISMATCH');\n  report('MISSING_TAX_ID');\n}\n");
    proj.activate();
    try {
      expect(findingIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('reads the method\'s own source file, not the implementation file', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT_AT('auditInvoice', 'src/commands/audit-invoice.ts')}`);
    // the implementation file still reports the code; the method's own file does not
    proj.source('src/audit.ts', "export const legacyCodes = ['MISSING_TAX_ID'];\n");
    proj.source('src/commands/audit-invoice.ts', "export function auditInvoice(report: (code: string) => void): void {\n  report('TAX_ID_MISSING');\n}\n");
    proj.activate();
    try {
      const found = findingIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"src/commands/audit-invoice.ts"');
    } finally { proj.cleanup(); }
  });

  it('a declaration or a comment naming the code is not a string literal at exact grade', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT('auditInvoice')}`);
    proj.source('src/audit.ts', "// reports MISSING_TAX_ID\nconst MISSING_TAX_ID = 42;\nexport function auditInvoice(report: (code: number) => void): void {\n  report(MISSING_TAX_ID);\n}\n");
    proj.activate();
    try {
      expect(findingIssues(validateSddTree())).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('skips methods at the off tier', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT('auditInvoice')}\n    conformance: off`);
    proj.source('src/audit.ts', 'export function auditInvoice(): void {}\n');
    proj.activate();
    try {
      expect(findingIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('skips files that were not analyzed — their own finding covers them', () => {
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT_AT('auditInvoice', 'src/commands/audit-invoice.ts')}`);
    proj.source('src/audit.ts', "export const legacyCodes = ['MISSING_TAX_ID'];\n");
    proj.activate();
    try {
      const res = validateSddTree();
      expect(conformanceIssues(res).map(i => i.code)).toEqual(['MISSING_SOURCE_FILE']);
      expect(findingIssues(res)).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is completeness-classed: an error-severity UNREALIZED_FINDING downgrades to warning in a draft context, like its sibling UNREALIZED_METHOD', () => {
    // NOTE: this is exercised directly against buildRuleContext/addIssue,
    // rather than through a project `rules.sddRuleSeverity` override, because
    // getRuleSeverity resolves an explicit project (or pack profile) severity
    // override BEFORE the draft-context downgrade — "explicit project config
    // wins over everything" — so an override to 'error' reports as 'error'
    // even on a draft implementation, for every completeness-classed code
    // (this is pre-existing behavior, also true of UNREALIZED_METHOD, and out
    // of scope for this fix). What COMPLETENESS_RULES membership actually
    // gates is a code raised at 'error' with no such override in play.
    const stamp = { createdAt: '2026-07-12T10:00:00Z', updatedAt: '2026-07-12T10:00:00Z' };
    const issues: ValidationIssue[] = [];
    const ctx = buildRuleContext({
      system: { schemaVersion: '1.0.0', name: 'S', vision: 'v', ...stamp } as never,
      subsystems: [],
      components: [],
      interfaces: [],
      implementations: [],
      types: [],
      projectType: 'backend',
      roundTripIssues: [],
      knownIssueCodes: gatherKnownIssueCodes(),
      issues,
    });
    ctx.addIssue('error', 'UNREALIZED_FINDING', 'declared finding code missing from the realized file', 'impl-audit-orch', true);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].draftContext).toBe(true);
  });

  it('is an implementations-depth expectation: gated away at interfaces design depth', async () => {
    const { RulesConfigSchema } = await import('../../src/models/project.js');
    const proj = createTempProject();
    proj.component('audit-orch', 'Orchestrator');
    auditContract(proj, [{ name: 'auditInvoice', findings: ['MISSING_TAX_ID'] }]);
    proj.impl('audit-orch', `sourcePath: src/audit.ts\nmethods:\n${INTENT('auditInvoice')}`);
    proj.source('src/audit.ts', 'export function auditInvoice(): void {}\n');
    proj.activate();
    try {
      expect(findingIssues(validateSddTree())).toHaveLength(1);
      invalidateSpecCache();
      const gated = validateSddTree({ rules: RulesConfigSchema.parse({ designDepth: 'interfaces' }) });
      expect(findingIssues(gated)).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('conformance degradation visibility', () => {
  it('fires CONFORMANCE_DEGRADED once when ts/js files were analyzed below exact grade', () => {
    // The dev environment always resolves the TypeScript compiler, so the
    // degraded state is fabricated directly: a ts file at pattern grade means
    // the compiler was unavailable in the analyzed environment.
    const issues: ValidationIssue[] = [];
    const stamp = { createdAt: '2026-07-12T10:00:00Z', updatedAt: '2026-07-12T10:00:00Z' };
    const ctx = buildRuleContext({
      system: { schemaVersion: '1.0.0', name: 'S', vision: 'v', ...stamp } as never,
      subsystems: [],
      components: [],
      interfaces: [],
      implementations: [],
      types: [],
      projectType: 'backend',
      codeModel: {
        projectRoot: '/proj',
        files: [{
          path: 'src/a.ts', status: 'analyzed', language: 'typescript', analysisGrade: 'pattern',
          declaredNames: [], anchoredNames: [], exportedNames: [], imports: [], reexports: [],
        }],
      },
      roundTripIssues: [],
      knownIssueCodes: gatherKnownIssueCodes(),
      issues,
    });
    structuralConformanceRule.check(ctx);
    const degraded = issues.filter(i => i.code === 'CONFORMANCE_DEGRADED');
    expect(degraded).toHaveLength(1);
    expect(degraded[0].message).toContain('below exact grade');
  });
});

describe('buildCodeModel — analyzer grades', () => {
  const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-codemodel-'));
  const impl = (sourcePath: string) => ({
    id: 'impl-x', name: 'x', description: 'd', contract: 'ix',
    sourcePath, methods: [], status: 'complete' as const,
    createdAt: '2026-07-11T10:00:00Z', updatedAt: '2026-07-11T10:00:00Z',
  });

  it('grades TS files exact (compiler resolvable here) and collects imports for Level 2', () => {
    const dir = mkTemp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), [
        "import { helper } from './b.js';",
        'export class Widget { spin(): void { helper(); } }',
      ].join('\n'));
      const model = buildCodeModel([impl('src/a.ts')], dir);
      expect(model.files).toHaveLength(1);
      const facts = model.files[0];
      expect(facts.status).toBe('analyzed');
      expect(facts.analysisGrade).toBe('exact');
      expect(facts.declaredNames).toContain('Widget');
      expect(facts.declaredNames).toContain('spin');     // class member
      expect(facts.declaredNames).toContain('helper');   // import binding
      expect(facts.exportedNames).toContain('Widget');
      expect(facts.imports).toContain('./b.js');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('grades a pattern-table language (python) pattern, with declarations found', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'flow.py'), 'def run_flow():\n    pass\n\nclass FlowRunner:\n    pass\n');
      const model = buildCodeModel([impl('flow.py')], dir);
      const facts = model.files[0];
      expect(facts.analysisGrade).toBe('pattern');
      expect(facts.declaredNames).toContain('run_flow');
      expect(facts.declaredNames).toContain('FlowRunner');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('grades an unknown language generic, where any word occurrence anchors', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'prog.xyz'), 'PROCEDURE DoWork; BEGIN END;\n');
      const model = buildCodeModel([impl('prog.xyz')], dir);
      const facts = model.files[0];
      expect(facts.analysisGrade).toBe('generic');
      expect(facts.declaredNames).toContain('DoWork');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('classifies binary content unreadable and never throws', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'blob.ts'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
      const model = buildCodeModel([impl('blob.ts')], dir);
      expect(model.files[0].status).toBe('unreadable');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('caps pattern analysis by size: a huge C# file degrades to the linear generic scan', () => {
    const dir = mkTemp();
    try {
      // > 1MB of realistic-but-pathological input for the C# declaration regex
      const filler = `public ${'x'.repeat(120)}\n`.repeat(12000);
      fs.writeFileSync(path.join(dir, 'gen.cs'), `${filler}public void DoWork() {}\n`);
      const started = Date.now();
      const model = buildCodeModel([impl('gen.cs')], dir);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(model.files[0].analysisGrade).toBe('generic');
      expect(model.files[0].declaredNames).toContain('DoWork');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('normalizes backslash-authored sourcePaths into one shared facts entry', () => {
    const dir = mkTemp();
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function one(): void {}\n');
      const a = { ...impl('src/a.ts'), id: 'impl-a' };
      const b = { ...impl('src\\a.ts'), id: 'impl-b' };
      const model = buildCodeModel([a, b], dir);
      expect(model.files).toHaveLength(1);
      expect(model.files[0].path).toBe('src/a.ts');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('analyzes each method\'s own source file next to the implementation\'s, deduplicated', () => {
    const dir = mkTemp();
    try {
      fs.mkdirSync(path.join(dir, 'src', 'commands'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'cli.ts'), 'export function listTargets(): void {}\n');
      fs.writeFileSync(path.join(dir, 'src', 'commands', 'lock.ts'), 'export function lockSpecs(): void {}\n');
      const withMethodFiles = {
        ...impl('src/cli.ts'),
        methods: [
          { name: 'lockSpecs', sourcePath: 'src/commands/lock.ts', narrative: [] },
          { name: 'listTargets', sourcePath: 'src/cli.ts', narrative: [] },
          { name: 'unlockSpecs', sourcePath: 'src/commands/unlock.ts', narrative: [] },
        ],
      };
      const model = buildCodeModel([withMethodFiles], dir);
      expect(model.files.map(f => f.path)).toEqual(['src/cli.ts', 'src/commands/lock.ts', 'src/commands/unlock.ts']);
      const lock = model.files.find(f => f.path === 'src/commands/lock.ts')!;
      expect(lock.status).toBe('analyzed');
      expect(lock.declaredNames).toContain('lockSpecs');
      expect(model.files.find(f => f.path === 'src/commands/unlock.ts')!.status).toBe('missing');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('analyzes method source files even when the implementation names no path of its own', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'lock.ts'), 'export function lockSpecs(): void {}\n');
      const pathless = { ...impl('lock.ts'), sourcePath: undefined, methods: [{ name: 'lockSpecs', sourcePath: 'lock.ts', narrative: [] }] };
      const model = buildCodeModel([pathless], dir);
      expect(model.files.map(f => f.path)).toEqual(['lock.ts']);
      expect(model.files[0].analysisGrade).toBe('exact');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('deduplicates N:1 sourcePaths into one facts entry', () => {
    const dir = mkTemp();
    try {
      fs.writeFileSync(path.join(dir, 'shared.ts'), 'export function one(): void {}\n');
      const a = { ...impl('shared.ts'), id: 'impl-a' };
      const b = { ...impl('shared.ts'), id: 'impl-b' };
      const model = buildCodeModel([a, b], dir);
      expect(model.files).toHaveLength(1);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
