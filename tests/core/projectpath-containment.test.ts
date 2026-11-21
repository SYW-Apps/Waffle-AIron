import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  assertContainedProjectPath,
  saveSystemSpec,
  saveSpec,
  scanAllSpecs,
  invalidateSpecCache,
  getLoaderIssues,
  inspectChainedRoots,
  graph as projectFamily,
} from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Fix B2 — member path containment.
//
// A member's path must resolve strictly WITHIN its owning project root. Absolute paths and ../-escaping paths are rejected at both the
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

/** Declare `alias` as a member of the project at `dir`, at `source`, in its project.yaml. */
function declare(dir: string, alias: string, source: string): void {
  const file = path.join(dir, '.wai', 'project.yaml');
  const held = fs.existsSync(file) ? (readYamlFile(file) as Record<string, unknown>) : { schemaVersion: '1.0.0', name: path.basename(dir), createdAt: now, updatedAt: now };
  writeYamlFile(file, { ...held, members: { ...((held.members as Record<string, unknown> | undefined) ?? {}), [alias]: source } });
  invalidateSpecCache();
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

});

describe('load-time projectPath containment', () => {
  let base: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (base) fs.rmSync(base, { recursive: true, force: true });
  });

  it('still loads and namespaces a legitimate nested subproject', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-b2-nested-'));
    const root = path.join(base, 'root');
    const child = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    declare(root, 'billing', path.relative(root, child).split(path.sep).join('/'));

    initProject(child, 'child-system');
    saveSpec('subsystem', subsystem('invoice', 'child-system'));

    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    expect(getLoaderIssues().some((i) => i.code === 'PROJECTPATH_ESCAPE')).toBe(false);
    // The member (no id of its own) is keyed by its alias.
    expect(index.subsystems.some((s) => s.id === 'billing')).toBe(false);
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

  it('refuses a member that leaves its project through a link, at write and at load', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-link-'));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');

    initProject(outside, 'outside-system');
    saveSpec('subsystem', subsystem('secret', 'outside-system'));
    initProject(root, 'root-system');
    fs.symlinkSync(outside, path.join(root, 'linked'), 'junction');

    expect(() => assertContainedProjectPath(root, 'linked')).toThrow(/must resolve within the project root/);

    declare(root, 'billing', 'linked');
    setProjectRoot(root);
    invalidateSpecCache();
    const index = scanAllSpecs();

    expect(getLoaderIssues().find((i) => i.code === 'PROJECTPATH_ESCAPE')?.specId).toBe('billing');
    expect(index.subsystems.some((s) => s.id.endsWith('secret'))).toBe(false);
    expect(inspectChainedRoots().skipped).toEqual([{ mount: 'billing', alias: 'billing', form: 'members', projectPath: 'linked', reason: 'escapes' }]);
  });

  it('still loads a nested subproject when the project itself is reached through a link', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-linked-root-'));
    fs.mkdirSync(path.join(base, 'real'));
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'alias'), 'junction');
    const root = path.join(base, 'alias', 'root');
    const child = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    declare(root, 'billing', 'packages/billing');
    initProject(child, 'child-system');
    saveSpec('subsystem', subsystem('invoice', 'child-system'));

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

  it('keeps a nested member issue in a validation scoped to the enclosing member', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-nested-diag-'));
    const root = path.join(base, 'root');
    const billing = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', name: 'root',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    declare(root, 'billing', 'packages/billing');
    initProject(billing, 'billing-system');
    // `ledger` points at a directory nobody created.
    declare(billing, 'ledger', 'vendor/ledger');

    setProjectRoot(root);
    invalidateSpecCache();
    const scoped = validateProject({ scopeSubsystem: 'billing' });

    // Stage 4 retires SUBPROJECT_NOT_FOUND: the absent member is a fact of the
    // graph, recorded on the project that declares it (a family run reports it
    // as MEMBER_NOT_FOUND), and never a loader issue of the bound root.
    expect(scoped.issues.filter((i) => i.code === 'SUBPROJECT_NOT_FOUND')).toEqual([]);
    const absent = projectFamily().problems.filter((p) => p.kind === 'member-absent');
    expect(absent.map((p) => [p.id, p.projects])).toEqual([['ledger', ['billing']]]);
  });

  it('reports each member a whole-tree walk cannot follow, and why', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-inspect-'));
    const root = path.join(base, 'root');
    const billing = path.join(root, 'packages', 'billing');

    initProject(root, 'root-system');
    declare(root, 'billing', 'packages/billing');
    declare(root, 'gone', 'packages/gone');
    initProject(billing, 'billing-system');
    declare(billing, 'ledger', 'vendor/ledger');
    declare(billing, 'again', '.');

    setProjectRoot(root);
    const inspection = inspectChainedRoots();

    expect(inspection.roots).toEqual(['packages/billing']);
    expect(inspection.skipped).toHaveLength(3);
    expect(inspection.skipped).toEqual(expect.arrayContaining([
      { mount: 'gone', alias: 'gone', form: 'members', projectPath: 'packages/gone', reason: 'missing' },
      { mount: 'billing::ledger', alias: 'ledger', form: 'members', projectPath: 'vendor/ledger', reason: 'missing' },
      { mount: 'billing::again', alias: 'again', form: 'members', projectPath: '.', reason: 'cyclic' },
    ]));
  });

  it('reports a member nested past the walk bound as too deep', () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-deep-'));
    let dir = path.join(base, 'root');
    const ids: string[] = [];
    for (let level = 1; level <= 33; level++) {
      initProject(dir, `system-${level}`);
      declare(dir, `n${level}`, `n${level}`);
      ids.push(`n${level}`);
      dir = path.join(dir, `n${level}`);
    }
    fs.mkdirSync(dir, { recursive: true });

    setProjectRoot(path.join(base, 'root'));
    const inspection = inspectChainedRoots();

    expect(inspection.roots).toHaveLength(32);
    expect(inspection.skipped).toEqual([{ mount: ids.join('::'), alias: 'n33', form: 'members', projectPath: 'n33', reason: 'too-deep' }]);
  });
});
