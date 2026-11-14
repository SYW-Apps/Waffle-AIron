import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Store containment doctrine: a Store is the default data component and needs
// no Repository around it (UNOWNED_STORE is retired). Every disallowed link
// INTO a Store prescribes reaching it through an Orchestrator that may, and
// explicitly forbids the worst shortcut — folding the state into the consumer.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-store-contain-test-'));

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
    activate: () => { vi.spyOn(process, 'cwd').mockReturnValue(tempDir); },
    cleanup: () => {
      invalidateSpecCache();
      vi.restoreAllMocks();
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    },
  };
}

const byCode = (res: { issues: { code: string; message: string; severity: string }[] }, code: string) =>
  res.issues.filter(i => i.code === code);

describe('A Store is the default data component', () => {
  it('a standalone Store raises nothing (UNOWNED_STORE is retired)', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'UNOWNED_STORE')).toHaveLength(0);
      expect(byCode(res, 'RETIRED_LINT_ALLOW_CODE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an allow of the retired UNOWNED_STORE is a notice, never UNKNOWN_LINT_ALLOW_CODE', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store', 'lint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: transitional — repository lands with the next subsystem pass');
    proj.activate();
    try {
      const res = validateProject();
      const found = byCode(res, 'RETIRED_LINT_ALLOW_CODE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('notice');
      expect(found[0].message).toContain('UNOWNED_STORE');
      expect(byCode(res, 'UNKNOWN_LINT_ALLOW_CODE')).toHaveLength(0);
      expect(byCode(res, 'UNUSED_LINT_ALLOW')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an allow of a code that never existed is still UNKNOWN_LINT_ALLOW_CODE', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store', 'lint:\n  allow:\n    - code: NEVER_A_CODE\n      reason: typo');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'UNKNOWN_LINT_ALLOW_CODE')).toHaveLength(1);
      expect(byCode(res, 'RETIRED_LINT_ALLOW_CODE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('read logic may depend on a Store directly', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.component('resolver', 'Orchestrator', 'dependencyClass: read\ndependsOn: [loose-store]');
    proj.activate();
    try {
      expect(byCode(validateProject(), 'DEPENDENCY_CLASS_VIOLATION')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('INDEX_DOES_IO — an Index keeps a lookup in memory and does no IO', () => {
  const indexOverAdapter = (proj: ReturnType<typeof createTempProject>, indexExtra = '') => {
    proj.component('slot-store', 'Store');
    proj.component('slot-adapter', 'Adapter');
    proj.component('slot-index', 'Index', `dependsOn: [slot-store, slot-adapter]${indexExtra}`);
    proj.component('slot-repository', 'Repository', 'owns: [slot-store, slot-index]');
  };

  it('reports an Index depending on an Adapter once, sited at the Adapter', () => {
    const proj = createTempProject();
    indexOverAdapter(proj);
    proj.activate();
    try {
      const res = validateProject();
      const found = byCode(res, 'INDEX_DOES_IO');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('slot-index');
      expect(found[0].message).toContain('slot-adapter');
      expect(byCode(res, 'ARCHITECTURE_VIOLATION_INDEX_DEP')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenced by a lint.allow naming the Adapter as its site, and by no other', () => {
    const proj = createTempProject();
    indexOverAdapter(proj, '\nlint:\n  allow:\n    - code: INDEX_DOES_IO\n      at: slot-adapter\n      reason: reads through the adapter until 7.0');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'INDEX_DOES_IO')).toHaveLength(0);
      expect(byCode(res, 'UNUSED_LINT_ALLOW')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('an allow naming no site does not cover the sited finding', () => {
    const proj = createTempProject();
    indexOverAdapter(proj, '\nlint:\n  allow:\n    - code: INDEX_DOES_IO\n      reason: coarse');
    proj.activate();
    try {
      const res = validateProject();
      expect(byCode(res, 'INDEX_DOES_IO')).toHaveLength(1);
      expect(byCode(res, 'UNUSED_LINT_ALLOW')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('an Index over its Store alone is quiet', () => {
    const proj = createTempProject();
    proj.component('slot-store', 'Store');
    proj.component('slot-index', 'Index', 'dependsOn: [slot-store]');
    proj.component('slot-repository', 'Repository', 'owns: [slot-store, slot-index]');
    proj.activate();
    try {
      expect(byCode(validateProject(), 'INDEX_DOES_IO')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('Store-target boundary violations prescribe the fix and forbid the shortcut', () => {
  it('pure logic → Store: reach it through an Orchestrator that may, never inline the state', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.component('resolver', 'Orchestrator', 'dependencyClass: pure\ndependsOn: [loose-store]');
    proj.activate();
    try {
      const found = byCode(validateProject(), 'DEPENDENCY_CLASS_VIOLATION');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('reach "loose-store" through an Orchestrator that may depend on it');
      expect(found[0].message).toContain('a Store needs no Repository around it');
      expect(found[0].message).toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });

  it('Portal → Store: the hop goes through an Orchestrator, never inline the state', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.component('front-portal', 'Portal', 'transport: Custom\ndependsOn: [loose-store]');
    proj.activate();
    try {
      const found = byCode(validateProject(), 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('through an Orchestrator');
      expect(found[0].message).toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });

  it('non-Store targets keep their original messages (no store hint appended)', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.component('resolver', 'Orchestrator', 'dependencyClass: read\ndependsOn: [flow-orch]');
    proj.activate();
    try {
      const found = byCode(validateProject(), 'DEPENDENCY_CLASS_VIOLATION');
      expect(found).toHaveLength(1);
      expect(found[0].message).not.toContain('Repository pattern (owns');
      expect(found[0].message).not.toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });
});
