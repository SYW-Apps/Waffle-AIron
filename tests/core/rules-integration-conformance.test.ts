import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Integration conformance (docs/design/integration-conformance.md §4): the
// committed sim harness must EXIST and WIRE the real modules; execution is
// CI's job. MISSING_INTEGRATION_SIM activates per subsystem on first simPath.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-intconf-test-'));

  const waiDir = path.join(tempDir, '.wai');
  fs.mkdirSync(waiDir);
  fs.writeFileSync(path.join(waiDir, 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'test-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
  }));

  const specsDir = path.join(waiDir, 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) {
    fs.mkdirSync(path.join(specsDir, d), { recursive: true });
  }

  const stamp = "createdAt: '2026-07-19T10:00:00Z'\nupdatedAt: '2026-07-19T10:00:00Z'";
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
    wire: (compId: string, file: string, extraImpl = '') => {
      const m = `run${compId.replace(/-/g, '')}`;
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        `  - name: ${m}`,
        '    description: does its one thing, carefully and observably',
        `    signature: "${m}(): void"`,
        '    returns: "void"',
      ].join('\n'));
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\nsourcePath: ${file}\n${extraImpl}methods:\n  - name: ${m}\n    detail: intent\n    intent: Performs its one thing against held state; failures surface as thrown errors.`);
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

const simIssues = (res: { issues: { code: string; specId?: string; message: string; severity: string }[] }) =>
  res.issues.filter(i => ['MISSING_INTEGRATION_SIM', 'SIM_FILE_MISSING', 'UNWIRED_INTEGRATION_SIM'].includes(i.code));

const body = (name: string, extra = '') => `export function run${name}(): void {}\n${extra}`;

describe('integration conformance — subsystem adoption + wiring proof', () => {
  it('stays silent on a subsystem that has not adopted sims', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('spec-b', 'Specialist');
    proj.wire('orch-a', 'src/a.ts');
    proj.wire('spec-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('src/b.ts', body('specb'));
    proj.activate();
    try {
      expect(simIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('a wired sim is clean; siblings without sims get MISSING_INTEGRATION_SIM; leaves are exempt', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('orch-c', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('spec-b', 'Specialist');
    proj.wire('orch-a', 'src/a.ts', 'simPath: tests/integration/a.sim.ts\n');
    proj.wire('orch-c', 'src/c.ts');
    proj.wire('spec-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('src/b.ts', body('specb'));
    proj.source('src/c.ts', body('orchc', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('tests/integration/a.sim.ts', "import { runorcha } from '../../src/a.js';\nrunorcha();\n");
    proj.activate();
    try {
      const found = simIssues(validateSddTree());
      expect(found).toHaveLength(1);
      expect(found[0].code).toBe('MISSING_INTEGRATION_SIM');
      expect(found[0].specId).toBe('impl-orch-c');
      expect(found[0].severity).toBe('warning');
      // spec-b is a leaf (no deps) — exempt even though the subsystem adopted.
      expect(found.some(i => i.specId === 'impl-spec-b')).toBe(false);
    } finally { proj.cleanup(); }
  });

  it('flags a simPath that resolves to no file (SIM_FILE_MISSING), incl. root escapes', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('spec-b', 'Specialist');
    proj.wire('orch-a', 'src/a.ts', 'simPath: tests/integration/gone.sim.ts\n');
    proj.wire('spec-b', 'src/b.ts', 'simPath: ../outside.sim.ts\n');
    proj.source('src/a.ts', body('orcha', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('src/b.ts', body('specb'));
    proj.activate();
    try {
      const found = simIssues(validateSddTree()).filter(i => i.code === 'SIM_FILE_MISSING');
      expect(found).toHaveLength(2);
      expect(found.find(i => i.specId === 'impl-orch-a')!.message).toContain('resolves to no file');
      expect(found.find(i => i.specId === 'impl-spec-b')!.message).toContain('escapes the project root');
    } finally { proj.cleanup(); }
  });

  it('flags a sim that does not import the real modules (UNWIRED_INTEGRATION_SIM)', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('spec-b', 'Specialist');
    proj.wire('orch-a', 'src/a.ts', 'simPath: tests/integration/a.sim.ts\n');
    proj.wire('spec-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha'));
    proj.source('src/b.ts', body('specb'));
    proj.source('tests/integration/a.sim.ts', 'export const nothing = 1;\n');
    proj.activate();
    try {
      const found = simIssues(validateSddTree()).filter(i => i.code === 'UNWIRED_INTEGRATION_SIM');
      expect(found).toHaveLength(1);
      expect(found[0].specId).toBe('impl-orch-a');
      expect(found[0].message).toContain("the component's own module");
      expect(found[0].message).toContain('"spec-b"');
    } finally { proj.cleanup(); }
  });

  it('reach is transitive through the component module, and technology-boundary deps stay exempt', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b, mail-adapter]');
    proj.component('spec-b', 'Specialist');
    proj.component('mail-adapter', 'Adapter');
    proj.wire('orch-a', 'src/a.ts', 'simPath: tests/integration/a.sim.ts\n');
    proj.wire('spec-b', 'src/b.ts');
    proj.wire('mail-adapter', 'src/mail.ts', 'technologies: [sendgrid]\n');
    // The sim imports only the component; the component imports its dep —
    // transitive reach over the analyzed set covers spec-b. The mail adapter
    // is a declared technology boundary: a contract-faithful fake is fine.
    proj.source('src/a.ts', body('orcha', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('src/b.ts', body('specb'));
    proj.source('src/mail.ts', body('mailadapter'));
    proj.source('tests/integration/a.sim.ts', "import { runorcha } from '../../src/a.js';\nrunorcha();\n");
    proj.activate();
    try {
      expect(simIssues(validateSddTree())).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('draft implementations in an adopted subsystem are not expected to have sims yet', () => {
    const proj = createTempProject();
    proj.component('orch-a', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('orch-c', 'Orchestrator', 'dependsOn: [spec-b]');
    proj.component('spec-b', 'Specialist');
    proj.wire('orch-a', 'src/a.ts', 'simPath: tests/integration/a.sim.ts\n');
    proj.wire('orch-c', 'src/c.ts', 'status: draft\n');
    proj.wire('spec-b', 'src/b.ts');
    proj.source('src/a.ts', body('orcha', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('src/b.ts', body('specb'));
    proj.source('src/c.ts', body('orchc', "import { runspecb } from './b.js';\nrunspecb();\n"));
    proj.source('tests/integration/a.sim.ts', "import { runorcha } from '../../src/a.js';\nrunorcha();\n");
    proj.activate();
    try {
      expect(simIssues(validateSddTree()).filter(i => i.code === 'MISSING_INTEGRATION_SIM')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});
