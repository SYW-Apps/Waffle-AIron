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
} from '../../src/core/specs.js';
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

    // Root declares a chained subsystem whose projectPath escapes to ../victim.
    initProject(root, 'root-system');
    saveSubsystemSpec(subsystem('billing', 'root-system', path.relative(root, victim)));

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
