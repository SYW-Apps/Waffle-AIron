import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  loadSubsystemSpec,
  invalidateSpecCache,
  graph,
} from '../../src/core/specs.js';
import {
  createMember,
  moveMember,
  backfillChainedSubprojectConfigs,
  findChainingSubprojectsMissingConfig,
  listDirectChainedSubprojects,
  provisionProject,
} from '../../src/core/provision.js';
import { projectConfigRepository, projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import { resolveAgentTopology } from '../../src/core/agent_resolver.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Members (stage 3): createMember scaffolds a member project and declares it
// in project.yaml `members` — never an L1 spec in the parent; moveMember
// relocates one, moving a legacy L1 mount into `members` first; discovery and
// the doctor backfill read `members` plus the legacy form. Real temp dirs,
// nothing mocked.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function makeRoot(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-member-'));
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  provisionProject('root-system');
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

/** The bound project's `members` as written. */
function membersOf(dir: string): Record<string, unknown> | undefined {
  return projectConfigRepositoryAt(dir).load()?.members as Record<string, unknown> | undefined;
}

/** Every spec file of a root's own tree, relative to it. */
function specFilesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(dir, '.wai', 'specs'));
  return out.sort();
}

describe('createMember', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('scaffolds the member project and declares it in `members`, writing no L1 spec', () => {
    rootDir = makeRoot();
    const before = specFilesOf(rootDir);
    createMember('billing', 'packages/billing', 'Invoices and payments');

    // Declared in the parent's project.yaml, long form (it carries a description).
    expect(membersOf(rootDir)).toEqual({ billing: { path: 'packages/billing', description: 'Invoices and payments' } });
    // Nothing was written into the parent's spec tree: a member carries no content there.
    expect(specFilesOf(rootDir)).toEqual(before);
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toBeNull();

    // The member project: its configuration declares the alias as its id; its L0's vision is the description.
    const memberDir = path.join(rootDir, 'packages', 'billing');
    expect(projectConfigRepositoryAt(memberDir).load()?.id).toBe('billing');
    const l0 = readYamlFile(path.join(memberDir, '.wai', 'specs', '.index.yaml')) as { vision: string };
    expect(l0.vision).toBe('Invoices and payments');

    // The graph reads it as a member project.
    const node = graph().nodes.find((n) => n.mountAlias === 'billing');
    expect(node).toMatchObject({ parent: '', mountForm: 'members', id: 'billing', memberDescription: 'Invoices and payments' });
  });

  it('writes the shorthand without a description, and a vision naming the member of this project', () => {
    rootDir = makeRoot();
    createMember('ledger', 'services\\ledger');
    expect(membersOf(rootDir)).toEqual({ ledger: 'services/ledger' });
    const l0 = readYamlFile(path.join(rootDir, 'services', 'ledger', '.wai', 'specs', '.index.yaml')) as { vision: string };
    expect(l0.vision).toBe('Member ledger of the root-system project');
  });

  it('is idempotent and never clobbers an existing member project', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing');
    const configFile = path.join(rootDir, '.wai', 'project.yaml');
    const configBytes = fs.readFileSync(configFile);
    const marker = path.join(rootDir, 'packages', 'billing', '.wai', 'keep.txt');
    fs.writeFileSync(marker, 'keep');

    createMember('billing', 'packages/billing');
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(configFile).equals(configBytes)).toBe(true);
  });

  it('completes a partially scaffolded member without overwriting its spec tree', () => {
    rootDir = makeRoot();
    const memberDir = path.join(rootDir, 'packages', 'billing');
    fs.mkdirSync(path.join(memberDir, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(
      path.join(memberDir, '.wai', 'specs', '.index.yaml'),
      `schemaVersion: 1.0.0\nname: PreExistingBilling\nvision: keep me\nboundaries: []\nglobalRequirements: []\ncreatedAt: '${now}'\nupdatedAt: '${now}'\n`,
    );
    createMember('billing', 'packages/billing');
    expect(fs.existsSync(path.join(memberDir, '.wai', 'project.yaml'))).toBe(true);
    const sys = fs.readFileSync(path.join(memberDir, '.wai', 'specs', '.index.yaml'), 'utf8');
    expect(sys).toMatch(/PreExistingBilling/);
    expect(sys).toMatch(/keep me/);
  });

  it('refuses a malformed alias or an empty path before anything is written', () => {
    rootDir = makeRoot();
    expect(() => createMember('Billing!', 'packages/billing')).toThrow(/an alias and a path are required/);
    expect(() => createMember('billing', '  ')).toThrow(/an alias and a path are required/);
    expect(fs.existsSync(path.join(rootDir, 'packages'))).toBe(false);
    expect(membersOf(rootDir)).toBeUndefined();
  });

  it('refuses an escaping or absolute path before anything is scaffolded', () => {
    rootDir = makeRoot();
    expect(() => createMember('outside', '../outside')).toThrow();
    expect(() => createMember('abs', path.join(os.tmpdir(), 'abs-member'))).toThrow();
    expect(membersOf(rootDir)).toBeUndefined();
  });

  it('refuses a different member under an alias already declared', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing');
    expect(() => createMember('billing', 'packages/other')).toThrow(/already declared/);
    expect(membersOf(rootDir)).toEqual({ billing: 'packages/billing' });
  });
});

describe('moveMember', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('relocates a `members` member and points its entry there, keeping its description', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing', 'Invoices');
    moveMember('billing', 'services/billing');

    expect(fs.existsSync(path.join(rootDir, 'packages', 'billing'))).toBe(false);
    expect(fs.existsSync(path.join(rootDir, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);
    expect(membersOf(rootDir)).toEqual({ billing: { path: 'services/billing', description: 'Invoices' } });
  });

  it('moves a legacy L1 mount into `members` first, deleting the L1 document, then relocates it', () => {
    rootDir = makeRoot();
    writeLegacyMount(subsystemSpec('billing', 'packages/billing'), 'billing');
    const mountFile = path.join(rootDir, '.wai', 'specs', 'billing', '.index.yaml');
    expect(fs.existsSync(mountFile)).toBe(true);

    moveMember('billing', 'services/billing');

    // wairon never rewrites the L1 form: the mount document is gone …
    expect(fs.existsSync(mountFile)).toBe(false);
    // … and the member is declared in `members`, at its new path, its description carried.
    expect(membersOf(rootDir)).toEqual({ billing: { path: 'services/billing', description: 'subsystem billing' } });
    expect(fs.existsSync(path.join(rootDir, 'services', 'billing', '.wai', 'project.yaml'))).toBe(true);
    invalidateSpecCache();
    expect(graph().nodes.find((n) => n.mountAlias === 'billing')?.mountForm).toBe('members');
  });

  it('refuses an alias that declares no member — an internal subsystem included', () => {
    rootDir = makeRoot();
    saveSpec('subsystem', subsystemSpec('intree'));
    invalidateSpecCache();
    expect(() => moveMember('intree', 'somewhere')).toThrow(/no member is declared under that alias/);
    expect(() => moveMember('ghost', 'somewhere')).toThrow(/no member is declared under that alias/);
  });

  it('refuses a target that already exists, leaving the member where it was', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing');
    fs.mkdirSync(path.join(rootDir, 'services', 'billing'), { recursive: true });
    expect(() => moveMember('billing', 'services/billing')).toThrow(/already exists/);
    expect(membersOf(rootDir)).toEqual({ billing: 'packages/billing' });
  });

  it('refuses a new path that escapes the project', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing');
    expect(() => moveMember('billing', '../escaped')).toThrow();
    expect(membersOf(rootDir)).toEqual({ billing: 'packages/billing' });
  });
});

describe('member discovery and the doctor backfill', () => {
  let rootDir: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('lists the direct members in both forms, `members` first, each with its alias and form', () => {
    rootDir = makeRoot();
    writeLegacyMount(subsystemSpec('legacy', 'packages/legacy'), 'legacy');
    createMember('billing', 'packages/billing');
    const direct = listDirectChainedSubprojects(rootDir).map((m) => ({ ...m, dir: path.relative(rootDir, m.dir).split(path.sep).join('/') }));
    expect(direct).toEqual([
      { dir: 'packages/billing', alias: 'billing', form: 'members' },
      { dir: 'packages/legacy', alias: 'legacy', form: 'mount' },
    ]);
  });

  it('a `members` entry wins over a legacy mount under the same alias', () => {
    rootDir = makeRoot();
    writeLegacyMount(subsystemSpec('billing', 'packages/old'), 'billing');
    projectConfigRepository.declareMember('billing', { path: 'packages/new' });
    fs.mkdirSync(path.join(rootDir, 'packages', 'new'), { recursive: true });
    const direct = listDirectChainedSubprojects(rootDir);
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ alias: 'billing', form: 'members' });
    expect(path.relative(rootDir, direct[0].dir).split(path.sep).join('/')).toBe('packages/new');
  });

  it('detects and backfills a member missing project.yaml, in either form, declaring the alias as its id', () => {
    rootDir = makeRoot();
    createMember('billing', 'packages/billing');
    writeLegacyMount(subsystemSpec('legacy', 'packages/legacy'), 'legacy');
    const billing = path.join(rootDir, 'packages', 'billing');
    const legacy = path.join(rootDir, 'packages', 'legacy');
    fs.rmSync(path.join(billing, '.wai', 'project.yaml'));
    fs.rmSync(path.join(legacy, '.wai', 'project.yaml'));
    invalidateSpecCache();

    const missing = findChainingSubprojectsMissingConfig(rootDir).map((d) => path.resolve(d)).sort();
    expect(missing).toEqual([path.resolve(billing), path.resolve(legacy)].sort());

    const repaired = backfillChainedSubprojectConfigs(rootDir).map((d) => path.resolve(d)).sort();
    expect(repaired).toEqual(missing);
    expect(projectConfigRepositoryAt(billing).load()?.id).toBe('billing');
    expect(projectConfigRepositoryAt(legacy).load()?.id).toBe('legacy');
    expect(findChainingSubprojectsMissingConfig(rootDir)).toHaveLength(0);
  });

  it('walks nested members recursively', () => {
    rootDir = makeRoot();
    createMember('core', 'core');
    setProjectRoot(path.join(rootDir, 'core'));
    createMember('transpiler', 'transpiler');
    setProjectRoot(rootDir);
    invalidateSpecCache();
    const nested = path.join(rootDir, 'core', 'transpiler');
    fs.rmSync(path.join(nested, '.wai', 'project.yaml'));
    expect(findChainingSubprojectsMissingConfig(rootDir).map((d) => path.resolve(d))).toEqual([path.resolve(nested)]);
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
    saveSpec('subsystem', subsystemSpec('local-a'));            // a normal local subsystem
    writeLegacyMount(subsystemSpec('child', 'child'), 'child'); // a chained subproject
    // Give the child internal subsystems — they must NOT appear in the parent layer.
    setProjectRoot(path.join(rootDir, 'child'));
    invalidateSpecCache();
    saveSpec('subsystem', { ...subsystemSpec('childsub'), parentSystem: 'child' });
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
    writeLegacyMount(subsystemSpec('child', 'child'), 'child');
    const childDir = path.join(rootDir, 'child');
    setProjectRoot(childDir);
    invalidateSpecCache();
    saveSpec('subsystem', { ...subsystemSpec('childsub'), parentSystem: 'child' });
    setProjectRoot(rootDir);
    invalidateSpecCache();

    // The cascade walks the DIRECT chained subprojects (one level).
    const direct = listDirectChainedSubprojects(rootDir);
    const childEntry = direct.find(d => path.resolve(d.dir) === path.resolve(childDir));
    expect(childEntry).toBeDefined();
    expect(childEntry!.alias).toBe('child');
    expect(childEntry!.form).toBe('mount');

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
