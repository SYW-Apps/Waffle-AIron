import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// HIDDEN_STATE — module-scope mutable bindings in files that realize only
// logic-stereotype components. The static approximation of "state folded into
// a logic class", conservative by construction.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-hidden-state-test-'));

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
  byCodeImpl(res, code);
const byCodeImpl = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

const INTENT = (m: string) =>
  `  - name: ${m}\n    detail: intent\n    intent: Performs ${m} against inputs and returns nothing; failures surface as thrown errors.`;

const STATEFUL_ORCH = [
  "let sessionCache: Record<string, string> = {};",
  'export function runFlow(id: string): void { sessionCache[id] = new Date().toISOString(); }',
].join('\n');

describe('HIDDEN_STATE — mutable module state in logic-only files', () => {
  it('flags a module-level let in a file realizing only an Orchestrator', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.contract('flow-orch', ['runFlow']);
    proj.impl('flow-orch', `sourcePath: src/orch.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.source('src/orch.ts', STATEFUL_ORCH);
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'HIDDEN_STATE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('"sessionCache"');
      expect(found[0].message).toContain('durability: cache');
    } finally { proj.cleanup(); }
  });

  it('stays silent for const bindings and function-local lets', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.contract('flow-orch', ['runFlow']);
    proj.impl('flow-orch', `sourcePath: src/orch.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.source('src/orch.ts', [
      "const config = { retries: 3 };",
      'export function runFlow(): void { let local = 0; local += config.retries; }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'HIDDEN_STATE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('exempts files also mapped to a data component (N:1 collapse — the state is the Store\'s)', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator', 'dependsOn: [rec-store]');
    proj.component('rec-store', 'Store', 'durability: ram-projection');
    proj.contract('flow-orch', ['runFlow']);
    proj.contract('rec-store', ['put']);
    proj.impl('flow-orch', `sourcePath: src/shared.ts\nmethods:\n${INTENT('runFlow')}`);
    proj.impl('rec-store', `sourcePath: src/shared.ts\nmethods:\n${INTENT('put')}`);
    proj.source('src/shared.ts', [
      "let held: Record<string, string> = {};",
      'export function put(k: string, v: string): void { held[k] = v; }',
      'export function runFlow(k: string): void { put(k, "x"); }',
    ].join('\n'));
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'HIDDEN_STATE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow (genuinely ephemeral wiring)', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.contract('flow-orch', ['runFlow']);
    proj.impl('flow-orch', [
      'sourcePath: src/orch.ts',
      'lint:',
      '  allow:',
      '    - code: HIDDEN_STATE',
      '      reason: lazily-initialized wiring handle, written once at first use — not domain state',
      'methods:',
      INTENT('runFlow'),
    ].join('\n'));
    proj.source('src/orch.ts', STATEFUL_ORCH);
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'HIDDEN_STATE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('never fires below exact grade', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.contract('flow-orch', ['run_flow']);
    proj.impl('flow-orch', `sourcePath: src/orch.py\nmethods:\n${INTENT('run_flow')}`);
    proj.source('src/orch.py', 'session_cache = {}\n\ndef run_flow(id):\n    session_cache[id] = 1\n');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'HIDDEN_STATE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
