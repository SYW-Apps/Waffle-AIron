import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache } from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// Store containment doctrine: a Store is held state and belongs INSIDE a
// Repository. A standalone Store is flagged (UNOWNED_STORE), and every
// disallowed link INTO a Store now prescribes the Repository resolution and
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

describe('UNOWNED_STORE — a Store belongs inside a Repository', () => {
  it('flags a standalone Store with the two sanctioned paths and the anti-shortcut warning', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'UNOWNED_STORE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('recommended shape for held state is a Repository');
      expect(found[0].message).toContain('sanctioned lightweight form');
      expect(found[0].message).toContain('lint.allow');
      expect(found[0].message).toContain('Never take the third path of merging');
    } finally { proj.cleanup(); }
  });

  it('stays silent for a Repository-owned Store', () => {
    const proj = createTempProject();
    proj.component('unit-store', 'Store');
    proj.component('unit-registry', 'Registry', 'dependsOn: [unit-store]');
    proj.component('unit-index', 'Index', 'dependsOn: [unit-store]');
    proj.component('unit-repository', 'Repository', 'owns: [unit-store, unit-registry, unit-index]');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNOWNED_STORE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow (a deliberate standalone Store)', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store', 'lint:\n  allow:\n    - code: UNOWNED_STORE\n      reason: transitional — repository lands with the next subsystem pass');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'UNOWNED_STORE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('Store-target boundary violations prescribe the fix and forbid the shortcut', () => {
  it('Specialist → Store: wrap in a Repository, depend on the facade, never inline the state', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.component('resolver', 'Specialist', 'dependsOn: [loose-store]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('wrap "loose-store" in a Repository pattern');
      expect(found[0].message).toContain('depend on that Repository facade');
      expect(found[0].message).toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });

  it('Portal → Store: the hop goes through an Orchestrator, never inline the state', () => {
    const proj = createTempProject();
    proj.component('loose-store', 'Store');
    proj.component('front-portal', 'Portal', 'portalType: Custom\ndependsOn: [loose-store]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_PORTAL_FORBIDDEN_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('through an Orchestrator');
      expect(found[0].message).toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });

  it('non-Store targets keep their original messages (no store hint appended)', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.component('resolver', 'Specialist', 'dependsOn: [flow-orch]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_SPECIALIST_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].message).not.toContain('Repository pattern (owns');
      expect(found[0].message).not.toContain('Never resolve this by merging');
    } finally { proj.cleanup(); }
  });
});
