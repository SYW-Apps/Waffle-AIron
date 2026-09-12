import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  assertContainedProjectPath,
  saveSystemSpec,
  saveSubsystemSpec,
  scanAllSpecs,
  invalidateSpecCache,
  getLoaderIssues,
  inspectChainedRoots,
} from '../../src/core/specs.js';
import { validateSddTree } from '../../src/core/validation.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Fix B2 — projectPath chaining containment.
//
// A chained subsystem's projectPath must resolve strictly WITHIN its owning
// project root. Absolute paths and ../-escaping paths are rejected at both the
// write/setter guard (assertContainedProjectPath) and the load-time resolver
// (which surfaces PROJECTPATH_ESCAPE and skips the offending child) — so a
// subproject can never federate, or execute a code pack from, another tenant's
// tree. Legitimate nested subprojects still load.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function initProject(dir: string, systemName: string): void {
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(dir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: systemName,
    vision: `vision for ${systemName}`,
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
}

function subsystem(id: string, parentSystem: string, projectPath?: string): SubsystemSpec {
  return {
    id,
    name: id,
    description: `subsystem ${id}`,
    parentSystem,
    publicInterfaces: [],
    projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

describe('assertContainedProjectPath (write/setter guard)', () => {
  const root = path.resolve(os.tmpdir(), 'wairon-b2-unit-root');

  it('allows a nested relative path and returns the resolved child dir', () => {
    const resolved = assertContainedProjectPath(root, 'packages/billing');
    expect(resolved).toBe(path.resolve(root, 'packages/billing'));
  });

  it('allows a deeper nested relative path', () => {
    expect(() => assertContainedProjectPath(root, 'a/b/c')).not.toThrow();
  });

  it('allows a within-root path that dips through .. but stays contained', () => {
    // packages/../billing → root/billing, still inside root.
    const resolved = assertContainedProjectPath(root, 'packages/../billing');
    expect(resolved).toBe(path.resolve(root, 'billing'));
  });

  it('rejects an absolute path', () => {
    const abs = path.resolve(os.tmpdir(), 'wairon-b2-elsewhere');
    expect(() => assertContainedProjectPath(root, abs)).toThrow(/must resolve within the project root/);
  });

  it('rejects a ../-escaping path', () => {
    expect(() => assertContainedProjectPath(root, '../victim')).toThrow(/must resolve within the project root/);
  });

  it('rejects a nested-then-escape path', () => {
    expect(() => assertContainedProjectPath(root, 'packages/../../victim')).toThrow(/must resolve within/);
  });

  it('saveSubsystemSpec refuses to PERSIST an escaping projectPath (defense in depth)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-b2-save-'));
    const proj = path.join(base, 'proj');
    try {
      initProject(proj, 'proj-system');
      expect(() => saveSubsystemSpec(subsystem('billing', 'proj-system', '../escape'))).toThrow(
        /must resolve within the project root/,
      );
    } finally {
      setProjectRoot(null);
      invalidateSpecCache();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('load-time projectPath containment', () => {
  let base: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('surfaces PROJECTPATH_ESCAPE and does NOT federate a ../-escaping victim tree', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-b2-escape-'));
    const root = path.join(base, 'root');
    const victim = path.join(base, 'victim');

    // A separate tenant's project we must never load.
    initProject(victim, 'victim-system');
    saveSubsystemSpec(subsystem('secret', 'victim-system'));

    // Root declares a chained subsystem; save it clean (the write guard would
    // otherwise refuse an escaping projectPath — see the write-guard test below),
    // then inject the ../victim escape directly on disk to simulate a
    // maliciously-written spec, exercising the load-time guard in isolation.
    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('billing', 'root-system'));
    const billingIndex = path.join(root, '.wai', 'specs', 'billing', '.index.yaml');
    fs.appendFileSync(billingIndex, `projectPath: ${path.relative(root, victim)}\n`);

    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    // The loader collected a PROJECTPATH_ESCAPE issue for the escaping child.
    expect(getLoaderIssues().some((i) => i.code === 'PROJECTPATH_ESCAPE')).toBe(true);

    // The mount subsystem itself still exists, but the victim tree was skipped.
    expect(index.subsystems.some((s) => s.id === 'billing')).toBe(true);
    expect(index.subsystems.some((s) => s.id === 'billing::secret')).toBe(false);
    expect(index.subsystems.some((s) => s.id.endsWith('secret'))).toBe(false);
  });

  it('still loads and namespaces a legitimate nested subproject', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-b2-nested-'));
    const root = path.join(base, 'root');
    const child = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('billing', 'root-system', path.relative(root, child)));

    initProject(child, 'child-system');
    saveSubsystemSpec(subsystem('invoice', 'child-system'));

    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    expect(getLoaderIssues().some((i) => i.code === 'PROJECTPATH_ESCAPE')).toBe(false);
    expect(index.subsystems.some((s) => s.id === 'billing')).toBe(true);
    expect(index.subsystems.some((s) => s.id === 'billing::invoice')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Containment is decided by the project that DECLARES a mount — never by the
// root the tree happens to be loaded from — and on paths as the filesystem
// resolves them, so one declaration gets one verdict from every root.
// ---------------------------------------------------------------------------

describe('containment by the declaring project', () => {
  let base: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('refuses a nested mount that leaves its own project from every loading root, even inside the top root', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-owning-'));
    const root = path.join(base, 'root');
    const a = path.join(root, 'packages', 'a');
    const b = path.join(root, 'packages', 'b');

    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('a', 'root-system', 'packages/a'));
    initProject(b, 'b-system');
    saveSubsystemSpec(subsystem('secret', 'b-system'));
    // `a` declares `inner` at ../b — inside the top root, outside a's own
    // project. Written past the write guard, as a hand-edited spec would be.
    initProject(a, 'a-system');
    saveSubsystemSpec(subsystem('inner', 'a-system'));
    fs.appendFileSync(path.join(a, '.wai', 'specs', 'inner', '.index.yaml'), 'projectPath: ../b\n');

    setProjectRoot(root);
    invalidateSpecCache();
    const fromTop = scanAllSpecs();
    expect(getLoaderIssues().find((i) => i.code === 'PROJECTPATH_ESCAPE')?.specId).toBe('a::inner');
    expect(fromTop.subsystems.some((s) => s.id.endsWith('secret'))).toBe(false);
    expect(inspectChainedRoots()).toEqual({
      roots: ['packages/a'],
      skipped: [{ mount: 'a::inner', projectPath: '../b', reason: 'escapes' }],
    });

    setProjectRoot(a);
    invalidateSpecCache();
    const fromChild = scanAllSpecs();
    expect(getLoaderIssues().find((i) => i.code === 'PROJECTPATH_ESCAPE')?.specId).toBe('inner');
    expect(fromChild.subsystems.some((s) => s.id.endsWith('secret'))).toBe(false);
  });

  it('refuses a mount that leaves its project through a link, at write and at load', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-link-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');

    initProject(outside, 'outside-system');
    saveSubsystemSpec(subsystem('secret', 'outside-system'));
    initProject(root, 'root-system');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');

    expect(() => assertContainedProjectPath(root, 'linked')).toThrow(/must resolve within the project root/);

    saveSubsystemSpec(subsystem('billing', 'root-system'));
    fs.appendFileSync(path.join(root, '.wai', 'specs', 'billing', '.index.yaml'), 'projectPath: linked\n');
    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    expect(getLoaderIssues().find((i) => i.code === 'PROJECTPATH_ESCAPE')?.specId).toBe('billing');
    expect(index.subsystems.some((s) => s.id.endsWith('secret'))).toBe(false);
    expect(inspectChainedRoots().skipped).toEqual([{ mount: 'billing', projectPath: 'linked', reason: 'escapes' }]);
  });

  it('still loads a nested subproject when the project itself is reached through a link', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-linked-root-'));
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'), 'junction');
    const root = path.join(base, 'alias', 'root');
    const child = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('billing', 'root-system', 'packages/billing'));
    initProject(child, 'child-system');
    saveSubsystemSpec(subsystem('invoice', 'child-system'));

    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    expect(getLoaderIssues().some((i) => i.code === 'PROJECTPATH_ESCAPE')).toBe(false);
    expect(index.subsystems.some((s) => s.id === 'billing::invoice')).toBe(true);
    expect(inspectChainedRoots()).toEqual({ roots: ['packages/billing'], skipped: [] });
  });
});

// ---------------------------------------------------------------------------
// A loader issue about a nested mount names the mount by its qualified id, so a
// validation scoped to the enclosing mount keeps it; and a whole-tree walk
// reports every mount it cannot follow instead of silently skipping it.
// ---------------------------------------------------------------------------

describe('nested mounts: qualified diagnostics and the chained-roots inspection', () => {
  let base: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('keeps a nested mount issue in a validation scoped to the enclosing mount', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-nested-diag-'));
    const root = path.join(base, 'root');
    const billing = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', name: 'root',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    saveSubsystemSpec(subsystem('billing', 'root-system', 'packages/billing'));
    initProject(billing, 'billing-system');
    // `ledger` points at a directory nobody created.
    saveSubsystemSpec(subsystem('ledger', 'billing-system', 'vendor/ledger'));

    setProjectRoot(root);
    invalidateSpecCache();
    const scoped = validateSddTree({ scopeSubsystem: 'billing' });

    const notFound = scoped.issues.filter((i) => i.code === 'SUBPROJECT_NOT_FOUND');
    expect(notFound.length).toBeGreaterThan(0);
    expect(notFound.every((i) => i.specId === 'billing::ledger')).toBe(true);
  });

  it('reports each mount a whole-tree walk cannot follow, and why', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-inspect-'));
    const root = path.join(base, 'root');
    const billing = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('billing', 'root-system', 'packages/billing'));
    saveSubsystemSpec(subsystem('gone', 'root-system', 'packages/gone'));
    initProject(billing, 'billing-system');
    saveSubsystemSpec(subsystem('ledger', 'billing-system', 'vendor/ledger'));
    saveSubsystemSpec(subsystem('again', 'billing-system', '.'));

    setProjectRoot(root);
    const inspection = inspectChainedRoots();

    expect(inspection.roots).toEqual(['packages/billing']);
    expect(inspection.skipped).toHaveLength(3);
    expect(inspection.skipped).toEqual(expect.arrayContaining([
      { mount: 'gone', projectPath: 'packages/gone', reason: 'missing' },
      { mount: 'billing::ledger', projectPath: 'vendor/ledger', reason: 'missing' },
      { mount: 'billing::again', projectPath: '.', reason: 'cyclic' },
    ]));
  });

  it('reports a mount nested past the walk bound as too deep', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-deep-'));
    let dir = path.join(base, 'root');
    const ids: string[] = [];
    for (let level = 1; level <= 33; level++) {
      initProject(dir, `system-${level}`);
      saveSubsystemSpec(subsystem(`n${level}`, `system-${level}`, `n${level}`));
      ids.push(`n${level}`);
      dir = path.join(dir, `n${level}`);
    }
    fs.mkdirSync(dir, { recursive: true });

    setProjectRoot(path.join(base, 'root'));
    const inspection = inspectChainedRoots();

    expect(inspection.roots).toHaveLength(32);
    expect(inspection.skipped).toEqual([{ mount: ids.join('::'), projectPath: 'n33', reason: 'too-deep' }]);
  });
});
