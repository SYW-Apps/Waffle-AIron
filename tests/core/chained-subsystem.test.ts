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
  listDirectChainedSubprojects,
  provisionProject,
} from '../../src/core/provision.js';
import { resolveAgentTopology } from '../../src/core/agent_resolver.js';
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

describe('layered agent topology', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('resolveAgentTopology generates only the current layer; a chained subproject collapses to ONE delegate', () => {
    rootDir = makeRoot();
    provisionProject('root-system');
    saveSubsystemSpec(subsystemSpec('local-a'));            // a normal local subsystem
    createChainedSubsystem(subsystemSpec('child', 'child'), 'child'); // a chained subproject
    // Give the child internal subsystems — they must NOT appear in the parent layer.
    setProjectRoot(path.join(rootDir, 'child'));
    invalidateSpecCache();
    saveSubsystemSpec({ ...subsystemSpec('childsub'), parentSystem: 'child' });
    setProjectRoot(rootDir);
    invalidateSpecCache();

    const ids = resolveAgentTopology().map(a => a.id);
    expect(ids).toContain('local-a-owner');
    expect(ids).toContain('child-owner');        // the subproject delegate
    expect(ids).not.toContain('childsub-owner'); // the child's internals stay in the child layer
    // Nothing federated (::-namespaced) leaks into this layer.
    expect(ids.every(id => !id.includes('::'))).toBe(true);

    const delegate = resolveAgentTopology().find(a => a.id === 'child-owner')!;
    expect(delegate.tags).toContain('delegate');
    expect(delegate.description).toMatch(/chained subproject/i);
  });

  // The end-to-end file-writing cascade (each layer generated into its own
  // .claude/agents via runGenerate) is verified live through the CLI; here we
  // cover its building blocks — direct-subproject discovery (what the cascade
  // walks) and per-layer topology (what each layer writes) — without loadRegistry
  // (a lazy require inside the loader↔agent_resolver cycle that vitest cannot
  // resolve at call time).
  it('cascade building blocks: direct subprojects are discovered, and each layer resolves its OWN topology', () => {
    rootDir = makeRoot();
    provisionProject('root-system');
    createChainedSubsystem(subsystemSpec('child', 'child'), 'child');
    const childDir = path.join(rootDir, 'child');
    setProjectRoot(childDir);
    invalidateSpecCache();
    saveSubsystemSpec({ ...subsystemSpec('childsub'), parentSystem: 'child' });
    setProjectRoot(rootDir);
    invalidateSpecCache();

    // The cascade walks the DIRECT chained subprojects (one level).
    const direct = listDirectChainedSubprojects(rootDir);
    const childEntry = direct.find(d => path.resolve(d.dir) === path.resolve(childDir));
    expect(childEntry).toBeDefined();
    expect(childEntry!.subsystemId).toBe('child');

    // Root layer writes the delegate, NOT the child's internal owner.
    const rootIds = resolveAgentTopology().map(a => a.id);
    expect(rootIds).toContain('child-owner');
    expect(rootIds).not.toContain('childsub-owner');

    // Child layer (resolved in the child's own root) writes its OWN owner.
    setProjectRoot(childDir);
    invalidateSpecCache();
    const childIds = resolveAgentTopology().map(a => a.id);
    expect(childIds).toContain('childsub-owner');
  });
});

describe('stale-agent reconciliation (pruneStaleAgents)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prunes wairon-owned files no longer in the topology but never hand-authored ones', async () => {
    const { pruneStaleAgents } = await import('../../src/commands/generate.js');
    const { WAIRON_MANAGED_MARKER } = await import('../../src/exporters/base.js');
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-prune-'));

    const w = (name: string, body: string) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      return path.resolve(p);
    };

    // The freshly-generated set (kept):
    const current = w('current-owner.md', `<!-- ${WAIRON_MANAGED_MARKER} -->\nkeep`);
    // Stale but wairon-owned by NAMING (migration of a pre-marker flat file):
    w('old-implementer.md', 'no marker but a wairon-generated name');
    // Stale and wairon-owned by MARKER (odd name, but clearly ours):
    w('renamed.md', `<!-- ${WAIRON_MANAGED_MARKER} -->\nours`);
    // Hand-authored — neither marker nor wairon naming (must survive):
    w('my-notes.md', 'a human wrote this');
    // Non-markdown — ignored entirely:
    w('keep.txt', 'data');

    const pruned = pruneStaleAgents(new Set([current]));

    expect(pruned).toBe(2);
    expect(fs.existsSync(current)).toBe(true);                          // in the set
    expect(fs.existsSync(path.join(dir, 'old-implementer.md'))).toBe(false); // pruned by name
    expect(fs.existsSync(path.join(dir, 'renamed.md'))).toBe(false);        // pruned by marker
    expect(fs.existsSync(path.join(dir, 'my-notes.md'))).toBe(true);        // hand-authored, kept
    expect(fs.existsSync(path.join(dir, 'keep.txt'))).toBe(true);           // not .md, kept
  });
});
