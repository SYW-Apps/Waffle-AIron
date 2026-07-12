import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  loadSubsystemSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  createChainedSubsystem,
  moveSubsystemProject,
  backfillChainedSubprojectConfigs,
  findChainingSubprojectsMissingConfig,
} from '../../src/core/provision.js';
import type { SubsystemSpec } from '../../src/models/index.js';

const now = new Date().toISOString();

function makeRoot(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-chain-'));
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'root-system',
    vision: 'A system of systems',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  return rootDir;
}

function subsystemSpec(id: string, projectPath?: string): SubsystemSpec {
  return {
    id,
    name: id,
    description: `subsystem ${id}`,
    parentSystem: 'root-system',
    publicInterfaces: [],
    projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

describe('createChainedSubsystem', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('wires the parent subsystem and scaffolds the child project', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');

    // Parent link persisted with the projectPath.
    invalidateSpecCache();
    const sub = loadSubsystemSpec('billing');
    expect(sub?.projectPath).toBe('packages/billing');

    // Child project scaffolded (its own project.yaml + L0 system spec).
    const childDir = path.join(rootDir, 'packages', 'billing');
    expect(fs.existsSync(path.join(childDir, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(childDir, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('normalizes the stored projectPath to forward slashes', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('shipping', 'packages\\shipping'), 'shipping');
    invalidateSpecCache();
    expect(loadSubsystemSpec('shipping')?.projectPath).toBe('packages/shipping');
  });

  it('is idempotent: re-running does not clobber an initialized child', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');

    const marker = path.join(rootDir, 'packages', 'billing', '.wai', 'keep.txt');
    fs.writeFileSync(marker, 'keep');

    // Re-run against the already-initialized child.
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('throws when projectPath is missing', () => {
    rootDir = makeRoot();
    expect(() => createChainedSubsystem(subsystemSpec('nopath'), 'nopath')).toThrow(/projectPath is required/);
  });

  it('is NON-DESTRUCTIVE: backfills project.yaml on a child that has specs but no config, preserving the existing system spec', () => {
    rootDir = makeRoot();
    // Pre-existing child tree: a system spec with its OWN name, but no project.yaml
    // (the partially-scaffolded state that makes it un-runnable standalone).
    const childDir = path.join(rootDir, 'packages', 'billing');
    fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(childDir, '.wai', 'specs', '.index.yaml'),
      `schemaVersion: 1.0.0\nname: PreExistingBilling\nvision: keep me\nboundaries: []\nglobalRequirements: []\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n`,
    );

    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');

    // project.yaml was backfilled…
    expect(fs.existsSync(path.join(childDir, '.wai', 'project.yaml'))).toBe(true);
    // …and the pre-existing system spec was NOT overwritten (name + vision intact).
    const sys = fs.readFileSync(path.join(childDir, '.wai', 'specs', '.index.yaml'), 'utf8');
    expect(sys).toMatch(/PreExistingBilling/);
    expect(sys).toMatch(/keep me/);
  });

  it('doctor backfill: detects + repairs a chained subproject missing project.yaml', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');
    const childDir = path.join(rootDir, 'packages', 'billing');

    // Simulate the broken on-disk state: specs present, project.yaml removed.
    fs.rmSync(path.join(childDir, '.wai', 'project.yaml'));
    invalidateSpecCache();

    // Detection finds it.
    expect(findChainingSubprojectsMissingConfig(rootDir).map(d => path.resolve(d)))
      .toContain(path.resolve(childDir));

    // Backfill repairs it (non-destructively).
    const repaired = backfillChainedSubprojectConfigs(rootDir);
    expect(repaired.map(d => path.resolve(d))).toContain(path.resolve(childDir));
    expect(fs.existsSync(path.join(childDir, '.wai', 'project.yaml'))).toBe(true);

    // Nothing missing after the fix.
    expect(findChainingSubprojectsMissingConfig(rootDir)).toHaveLength(0);
  });
});

describe('moveSubsystemProject', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('relocates the subproject directory and updates the link', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');

    moveSubsystemProject('billing', 'services/billing');

    expect(fs.existsSync(path.join(rootDir, 'packages', 'billing'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')?.projectPath).toBe('services/billing');
  });

  it('throws for a non-external (in-tree) subsystem', () => {
    rootDir = makeRoot();
    // An in-tree subsystem has no projectPath.
    saveSubsystemSpec(subsystemSpec('intree'));
    invalidateSpecCache();
    expect(() => moveSubsystemProject('intree', 'somewhere')).toThrow(/not an external subproject/);
  });

  it('throws when the target directory already exists', () => {
    rootDir = makeRoot();
    createChainedSubsystem(subsystemSpec('billing', 'packages/billing'), 'billing');
    fs.mkdirSync(path.join(rootDir, 'services', 'billing'), { recursive: true });
    expect(() => moveSubsystemProject('billing', 'services/billing')).toThrow(/already exists/);
  });
});
