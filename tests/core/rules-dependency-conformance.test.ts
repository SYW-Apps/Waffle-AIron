import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Dependency conformance (code↔spec Level 2): runtime import edges between
// component-mapped files must match declared dependsOn/owns relations.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-depconf-test-'));

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
    subsystem: (id: string, extra = '') =>
      writeSpec('subsystem', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nparentSystem: TestSystem\n${extra}`),
    component: (id: string, type: string, sub = 'sub-a', extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: ${sub}\ncomponentType: ${type}\n${extra}`),
    wire: (compId: string, file: string, extraImpl = '') => {
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        `  - name: run${compId.replace(/-/g, '')}`,
        `    description: does its one thing`,
        `    signature: "run${compId.replace(/-/g, '')}(): void"`,
        '    returns: "void"',
      ].join('\n'));
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\nsourcePath: ${file}\n${extraImpl}methods:\n  - name: run${compId.replace(/-/g, '')}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`);
    },
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

const depIssues = (res: { issues: { code: string; specId?: string; message: string }[] }) =>
  res.issues.filter(i => i.code === 'UNDECLARED_DEPENDENCY' || i.code === 'UNREALIZED_DEPENDENCY');

// each component realizes runX; files export it so structural conformance stays quiet
const body = (name: string, extra = '') => `export function run${name}(): void {}\n${extra}`;

describe('dependency conformance — UNDECLARED_DEPENDENCY', () => {
  it('flags a runtime import between mapped files with no declared relation', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runstoreb } from './b.js';\nrunstoreb();\n"));
    proj.source('src/b.ts', body('storeb'));
    proj.activate();
    try {
      const found = depIssues(validateSddTree());
      expect(found.map(i => i.code)).toContain('UNDECLARED_DEPENDENCY');
      expect(found.find(i => i.code === 'UNDECLARED_DEPENDENCY')?.specId).toBe('impl-orch-a');
    } finally { proj.cleanup(); }
  });

  it('a declared dependsOn edge justifies the import (and realizes it — fully clean)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'sub-a', 'dependsOn: [store-b]');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runstoreb } from './b.js';\nrunstoreb();\n"));
    proj.source('src/b.ts', body('storeb'));
    proj.activate();
    try {
      expect(depIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('mutual wiring: the declared reverse edge (same subsystem) justifies the import direction', () => {
    const proj = createTempProject();
    // portal declares it mounts onto the server; the server file imports the portal file
    proj.component('server-s', 'Supervisor');
    proj.component('portal-p', 'Portal', 'sub-a', 'portalType: Custom\ndependsOn: [server-s]');
    proj.wire('server-s', 'src/server.ts');
    proj.wire('portal-p', 'src/portal.ts');
    proj.source('src/server.ts', body('servers', "import { runportalp } from './portal.js';\nrunportalp();\n"));
    proj.source('src/portal.ts', body('portalp'));
    proj.activate();
    try {
      expect(depIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('the reverse edge does NOT forgive a Store importing its consumer (mounting shapes only)', () => {
    const proj = createTempProject();
    // orchestrator declares dependsOn store (correct direction) — but the STORE
    // file imports the orchestrator: a real inversion, not portal mounting.
    proj.component('orch-a', 'Orchestrator', 'sub-a', 'dependsOn: [store-b]');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runstoreb } from './b.js';\nrunstoreb();\n"));
    proj.source('src/b.ts', body('storeb', "import { runorcha } from './a.js';\nvoid runorcha;\n"));
    proj.activate();
    try {
      const found = depIssues(validateSddTree());
      expect(found.map(i => i.code)).toContain('UNDECLARED_DEPENDENCY');
      expect(found.find(i => i.code === 'UNDECLARED_DEPENDENCY')?.specId).toBe('impl-store-b');
    } finally { proj.cleanup(); }
  });

  it('type-only imports never form an edge', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import type { Thing } from './b.js';\nexport const t: Thing | null = null;\n"));
    proj.source('src/b.ts', body('storeb', 'export interface Thing { id: string }\n'));
    proj.activate();
    try {
      expect(depIssues(validateSddTree()).map(i => i.code)).not.toContain('UNDECLARED_DEPENDENCY');
    } finally { proj.cleanup(); }
  });

  it('cross-subsystem: a declared edge to the published surface justifies imports of that subsystem\'s files', () => {
    const proj = createTempProject();
    proj.subsystem('sub-b', 'publicInterfaces:\n  - type: Custom\n    details: in-process portal\n    component: portal-b');
    proj.component('portal-b', 'Portal', 'sub-b', 'portalType: Custom\ndependsOn: [inner-b]');
    proj.component('inner-b', 'Specialist', 'sub-b');
    proj.component('adapter-a', 'Adapter', 'sub-a', 'dependsOn: [portal-b]');
    proj.wire('portal-b', 'src/b/portal.ts');
    proj.wire('inner-b', 'src/b/inner.ts');
    proj.wire('adapter-a', 'src/a/adapter.ts');
    proj.source('src/b/portal.ts', body('portalb', "import { runinnerb } from './inner.js';\nruninnerb();\n"));
    proj.source('src/b/inner.ts', body('innerb'));
    // the adapter imports the sibling subsystem's CONCRETE module — sanctioned
    // because it declares the edge to that subsystem's published portal
    proj.source('src/a/adapter.ts', body('adaptera', "import { runinnerb } from '../b/inner.js';\nruninnerb();\n"));
    proj.activate();
    try {
      expect(depIssues(validateSddTree()).map(i => i.code)).not.toContain('UNDECLARED_DEPENDENCY');
    } finally { proj.cleanup(); }
  });

  it('lint.allow silences the warning per spec', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts', 'lint:\n  allow:\n    - code: UNDECLARED_DEPENDENCY\n      reason: documented exception for the test\n');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runstoreb } from './b.js';\nrunstoreb();\n"));
    proj.source('src/b.ts', body('storeb'));
    proj.activate();
    try {
      expect(depIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('dependency conformance — UNREALIZED_DEPENDENCY', () => {
  it('flags a declared edge with no realizing import between different files', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'sub-a', 'dependsOn: [store-b]');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha'));
    proj.source('src/b.ts', body('storeb'));
    proj.activate();
    try {
      const found = depIssues(validateSddTree());
      expect(found.map(i => i.code)).toEqual(['UNREALIZED_DEPENDENCY']);
      expect(found[0].specId).toBe('impl-orch-a');
    } finally { proj.cleanup(); }
  });

  it('same-file N:1 realization satisfies the declared edge trivially', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'sub-a', 'dependsOn: [store-b]');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/shared.ts');
    proj.wire('store-b', 'src/shared.ts');
    proj.source('src/shared.ts', body('orcha', body('storeb')));
    proj.activate();
    try {
      expect(depIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a re-export barrel realizes the declared forwarding edge without being accused', () => {
    const proj = createTempProject();
    proj.component('portal-p', 'Portal', 'sub-a', 'portalType: Custom\ndependsOn: [orch-a]');
    proj.component('orch-a', 'Orchestrator');
    proj.wire('portal-p', 'src/index.ts');
    proj.wire('orch-a', 'src/orch.ts');
    // pure republication: satisfies portal→orchestrator, never flags a dependency
    proj.source('src/index.ts', "export * from './orch.js';\n");
    proj.source('src/orch.ts', body('orcha', body('portalp')));
    proj.activate();
    try {
      expect(depIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('draft implementations carry draftContext on the finding', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'sub-a', 'dependsOn: [store-b]');
    proj.component('store-b', 'Store');
    proj.wire('orch-a', 'src/a.ts', 'status: draft\n');
    proj.wire('store-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha'));
    proj.source('src/b.ts', body('storeb'));
    proj.activate();
    try {
      const found = depIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect((found[0] as { draftContext?: boolean }).draftContext).toBe(true);
    } finally { proj.cleanup(); }
  });
});
