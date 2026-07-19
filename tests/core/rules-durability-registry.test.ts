import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { validateSddTree } from '../../src/core/validation.js';
import { invalidateSpecCache, saveComponentSpec, loadComponentSpec, updateSpec } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// The durability axis (required on Stores; read-through/cache modes) and the
// Registry matrix (outbound rule + REGISTRY_WITHOUT_STORE tripwire) — the
// enforcement half of the registry-taxonomy ruling. Plus the opaque ext
// extension-data channel round-trip.
// ---------------------------------------------------------------------------

function createTempProject() {
  invalidateSpecCache();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dur-reg-test-'));

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
  writeSpec('subsystem', 'sub-a', 'schemaVersion: 1.0.0\nid: sub-a\nname: SubA\ndescription: d\nparentSystem: TestSystem\nlifecycle:\n  - phase: init\n    component: boot-orch\n    method: boot');

  return {
    tempDir,
    component: (id: string, type: string, extra = '') =>
      writeSpec('component', id, `schemaVersion: 1.0.0\nid: ${id}\nname: ${id}\ndescription: d\nsubsystem: sub-a\ncomponentType: ${type}\n${extra}`),
    contract: (compId: string, methods: { name: string; effect?: string }[]) =>
      writeSpec('interface', `i${compId}`, [
        'schemaVersion: 1.0.0',
        `id: i${compId}`,
        `name: I${compId}`,
        'description: contract',
        `component: ${compId}`,
        'methods:',
        ...methods.map(m => [
          `  - name: ${m.name}`,
          `    description: ${m.name} does its one thing, carefully and observably`,
          `    signature: "${m.name}(): void"`,
          '    returns: "void"',
          ...(m.effect ? [`    effect: ${m.effect}`] : []),
        ].join('\n')),
      ].join('\n')),
    impl: (compId: string, body: string) =>
      writeSpec('implementation', `impl-${compId}`, `schemaVersion: 1.0.0\nid: impl-${compId}\nname: Impl${compId}\ndescription: impl\ncontract: i${compId}\n${body}`),
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

// A store with tagged read/write methods, owned by a repository (so
// UNOWNED_STORE stays out of these assertions).
function ownedStore(proj: ReturnType<typeof createTempProject>, durability?: string) {
  proj.component('rec-store', 'Store', durability ? `durability: ${durability}` : '');
  proj.contract('rec-store', [{ name: 'get', effect: 'read' }, { name: 'put', effect: 'write' }]);
  proj.impl('rec-store', 'methods:\n  - name: get\n    intent: Reads the record from held state by id and returns it, or null when absent entirely.\n  - name: put\n    intent: Writes the record into held state keyed by id; overwrites silently on collision.');
  proj.component('rec-registry', 'Registry', 'dependsOn: [rec-store]');
  proj.component('rec-index', 'Index', 'dependsOn: [rec-store]');
  proj.component('rec-repository', 'Repository', 'owns: [rec-store, rec-registry, rec-index]');
}

describe('MISSING_DURABILITY — the axis is opt-out by declaration, never absent', () => {
  it('fires on a Store with no durability', () => {
    const proj = createTempProject();
    ownedStore(proj);
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'MISSING_DURABILITY');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].specId).toBe('rec-store');
    } finally { proj.cleanup(); }
  });

  it('stays silent once any mode is declared, and never fires on non-Stores', () => {
    const proj = createTempProject();
    ownedStore(proj, 'ram-projection');
    proj.component('flow-orch', 'Orchestrator');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'MISSING_DURABILITY')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('durability modes — only durable demands the boot read-back', () => {
  it('read-through and cache Stores are hydration-exempt', () => {
    for (const mode of ['read-through', 'cache']) {
      const proj = createTempProject();
      ownedStore(proj, mode);
      proj.activate();
      try {
        expect(byCode(validateSddTree(), 'MISSING_HYDRATION')).toHaveLength(0);
      } finally { proj.cleanup(); }
    }
  });

  it('durable still demands a read-back reachable from a lifecycle init flow', () => {
    const proj = createTempProject();
    ownedStore(proj, 'durable');
    proj.activate();
    try {
      // No init flow reaches the store's read — the round-trip must fire.
      expect(byCode(validateSddTree(), 'MISSING_HYDRATION')).toHaveLength(1);
    } finally { proj.cleanup(); }
  });

  it('DURABILITY_ON_NON_STORE still rejects the new modes on non-Stores', () => {
    const proj = createTempProject();
    proj.component('sneaky-specialist', 'Specialist', 'durability: cache');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'DURABILITY_ON_NON_STORE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('error');
    } finally { proj.cleanup(); }
  });
});

describe('Registry matrix — write path to its Store, nothing else', () => {
  it('warns on Registry depending on an Orchestrator (layering inversion)', () => {
    const proj = createTempProject();
    proj.component('flow-orch', 'Orchestrator');
    proj.component('rec-store2', 'Store', 'durability: ram-projection');
    proj.component('loose-registry', 'Registry', 'dependsOn: [rec-store2, flow-orch]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_REGISTRY_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('flow-orch');
    } finally { proj.cleanup(); }
  });

  it('accepts Registry → Store and Registry → Adapter', () => {
    const proj = createTempProject();
    proj.component('rec-store2', 'Store', 'durability: ram-projection');
    proj.component('db-adapter', 'Adapter');
    proj.component('rec-registry2', 'Registry', 'dependsOn: [rec-store2, db-adapter]');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_REGISTRY_DEP')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('Store → Registry is now the error the docs always claimed', () => {
    const proj = createTempProject();
    proj.component('rec-registry2', 'Registry');
    proj.component('inverted-store', 'Store', 'durability: ram-projection\ndependsOn: [rec-registry2]');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'ARCHITECTURE_VIOLATION_STORE_DEP');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('error');
      expect(found[0].message).toContain('never the reverse');
    } finally { proj.cleanup(); }
  });
});

describe('REGISTRY_WITHOUT_STORE — the symmetric tripwire', () => {
  it('flags a standalone Registry with no Store to write to, prescribing the retype', () => {
    const proj = createTempProject();
    proj.component('file-registry', 'Registry');
    proj.activate();
    try {
      const found = byCode(validateSddTree(), 'REGISTRY_WITHOUT_STORE');
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe('warning');
      expect(found[0].message).toContain('retype it as a Store');
      expect(found[0].message).toContain('read-through');
    } finally { proj.cleanup(); }
  });

  it('stays silent for Repository-owned Registries and for standalone ones wired to a Store', () => {
    const proj = createTempProject();
    ownedStore(proj, 'ram-projection'); // rec-registry is repo-owned, depends on rec-store
    proj.component('wired-store', 'Store', 'durability: ram-projection');
    proj.component('wired-registry', 'Registry', 'dependsOn: [wired-store]');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'REGISTRY_WITHOUT_STORE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });

  it('is silenceable per spec via lint.allow', () => {
    const proj = createTempProject();
    proj.component('file-registry', 'Registry', 'lint:\n  allow:\n    - code: REGISTRY_WITHOUT_STORE\n      reason: retype to read-through Store scheduled with the taxonomy migration');
    proj.activate();
    try {
      expect(byCode(validateSddTree(), 'REGISTRY_WITHOUT_STORE')).toHaveLength(0);
    } finally { proj.cleanup(); }
  });
});

describe('ext — the opaque extension-data channel round-trips', () => {
  it('survives save → load and merges through sdd_update_spec', () => {
    invalidateSpecCache();
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs', 'subsystems'), { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(
      path.join(proj, '.wai', 'specs', 'subsystems', 'billing.yaml'),
      `schemaVersion: 1.0.0\nid: billing\nname: B\ndescription: d\nparentSystem: T\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n`,
    );
    setProjectRoot(proj);
    invalidateSpecCache();
    try {
      saveComponentSpec({
        id: 'isr-observer', name: 'ISR Observer', description: 'd', subsystem: 'billing',
        componentType: 'Observer', owns: [], dependsOn: [],
        ext: { 'rtospack:priority': 7, 'rtospack:isr-safe': true },
        status: 'draft', createdAt: now, updatedAt: now,
      });
      invalidateSpecCache();
      const loaded = loadComponentSpec('isr-observer');
      expect(loaded?.ext).toEqual({ 'rtospack:priority': 7, 'rtospack:isr-safe': true });

      updateSpec('component', 'isr-observer', { ext: { 'rtospack:priority': 3, 'otherpack:budget': '4k' } });
      invalidateSpecCache();
      const merged = loadComponentSpec('isr-observer');
      expect(merged?.ext?.['rtospack:priority']).toBe(3);
      expect(merged?.ext?.['otherpack:budget']).toBe('4k');
      expect(merged?.ext?.['rtospack:isr-safe']).toBe(true); // object merge preserves untouched keys
    } finally {
      setProjectRoot(null);
      invalidateSpecCache();
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });
});
