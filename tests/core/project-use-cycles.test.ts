import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, getLoaderIssues, scanAllSpecs } from '../../src/core/specs.js';
import { projectFamilyGraph as projectFamily } from '../../src/core/project-family.js';
import { validateProject } from '../../src/core/validation.js';
import { assertApprovable } from '../../src/commands/lock.js';
import * as migrations from '../../src/migrations/index.js';
import { plan as planAt } from '../helpers/family-verbs.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A contained member that declares its parent as a path external is the
// ordinary plugin shape: no circular reference, no use cycle. When the parent
// also uses the member, the uses loop: PROJECT_USE_CYCLE. And a lock refuses a
// tree the loader could not read whole.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

const SEND = { name: 'sendNotice', description: 'Send one notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void', effect: 'none' };

/** The host: exports the abstraction `notice-sender`; optionally uses the plugin's `pager`. */
function hostTree(usesPlugin: boolean): FixtureTree {
  return {
    system: { name: 'Host', vision: 'A host.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'core', component: 'notice-sender' }] },
    subsystems: [{ id: 'core', description: 'The core.', publicInterfaces: [{ component: 'notice-sender', details: 'The abstraction.' }] }],
    components: [
      { id: 'notice-sender', componentType: 'Adapter', abstract: true, description: 'Delivers one notice.' },
      ...(usesPlugin ? [{ id: 'notice-desk', componentType: 'Portal', transport: 'InProcess', description: 'Raises notices.', dependsOn: ['plugin::pager'], invokedBy: { kind: 'entry', caller: 'Applications linking the host.' } }] : []),
    ],
    interfaces: [
      { id: 'inotice_sender', component: 'notice-sender', methods: [SEND] },
      ...(usesPlugin ? [{ id: 'inotice_desk', component: 'notice-desk', methods: [{ name: 'raise', description: 'Raise a notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void', effect: 'none' }] }] : []),
    ],
  };
}

/** The plugin: implements the host's abstraction; exports `pager`. */
function pluginTree(): FixtureTree {
  return {
    system: { name: 'Plugin', vision: 'A plugin.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'ext', component: 'pager' }] },
    subsystems: [{ id: 'ext', description: 'The extension.', publicInterfaces: [{ component: 'pager', details: 'The pager.' }] }],
    components: [{ id: 'pager', componentType: 'Adapter', description: 'Pages the engineer.' }],
    interfaces: [{ id: 'ipager', component: 'pager', implements: ['host::notice-sender'], methods: [SEND] }],
  };
}

function pair(usesPlugin: boolean): { host: string; plugin: string } {
  const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-usecycle-')));
  roots.push(host);
  const plugin = path.join(host, 'parts', 'plugin');
  fs.mkdirSync(plugin, { recursive: true });
  materializeFixtureProject(host, hostTree(usesPlugin));
  materializeFixtureProject(plugin, pluginTree());
  fs.writeFileSync(path.join(host, '.wai', 'project.yaml'), configYaml('host', { members: { plugin: 'parts/plugin' } }));
  fs.writeFileSync(path.join(plugin, '.wai', 'project.yaml'), configYaml('plugin', { externals: { host: { source: { path: '../..' } } } }));
  return { host, plugin };
}

describe('a contained plugin using its host (one way)', () => {
  it('bound at the plugin root: no loader error, two nodes, no circular reference, no use cycle', () => {
    const p = pair(false);
    bind(p.plugin);
    expect(getLoaderIssues().filter((i) => i.severity === 'error')).toEqual([]);
    expect(projectFamily().nodes).toHaveLength(2);
    const codes = validateProject({}).issues.map((i) => i.code);
    expect(codes).not.toContain('CIRCULAR_SUBPROJECT_REFERENCE');
    expect(codes).not.toContain('PROJECT_USE_CYCLE');
  });

  it('bound at the host root: no use cycle', () => {
    const p = pair(false);
    bind(p.host);
    expect(getLoaderIssues().filter((i) => i.severity === 'error')).toEqual([]);
    const codes = validateProject({}).issues.map((i) => i.code);
    expect(codes).not.toContain('CIRCULAR_SUBPROJECT_REFERENCE');
    expect(codes).not.toContain('PROJECT_USE_CYCLE');
  });
});

describe('PROJECT_USE_CYCLE', () => {
  function cycles(root: string) {
    bind(root);
    return validateProject({}).issues.filter((i) => i.code === 'PROJECT_USE_CYCLE');
  }

  it('is one error at the host root, naming both projects and the fix', () => {
    const found = cycles(pair(true).host);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('host');
    expect(found[0].message).toContain('plugin');
    expect(found[0].message).toContain('member demote');
  });

  it('is one error at the plugin root, too', () => {
    const found = cycles(pair(true).plugin);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('host');
    expect(found[0].message).toContain('plugin');
  });

  it('does not fire when only the plugin uses the host', () => {
    expect(cycles(pair(false).host)).toEqual([]);
  });

  // NOTE: a pure containment loop cannot be built from contained member paths
  // (a member path must resolve strictly inside its declaring project), so no
  // genuine-containment-loop control is written.
});

describe('lock refuses a tree the loader could not read whole', () => {
  it('throws, even forced, on a loader error (a member declared by an absolute path)', () => {
    const p = pair(false);
    fs.writeFileSync(path.join(p.host, '.wai', 'project.yaml'), configYaml('host', { members: { plugin: 'parts/plugin', escaping: path.join(os.tmpdir(), 'wairon-elsewhere') } }));
    bind(p.host);
    scanAllSpecs();
    expect(getLoaderIssues().some((i) => i.severity === 'error')).toBe(true);
    expect(() => assertApprovable([], true)).toThrow(/the tree could not be read whole/);
    expect(() => assertApprovable([], false)).toThrow(/the tree could not be read whole/);
  });

  it('control: a clean tree passes the loader check', () => {
    const p = pair(false);
    bind(p.host);
    scanAllSpecs();
    expect(getLoaderIssues().filter((i) => i.severity === 'error')).toEqual([]);
    expect(() => assertApprovable([], true)).not.toThrow();
  });
});

describe('a promote that would make the uses loop foretells it', () => {
  it('the dry run announces PROJECT_USE_CYCLE for a part that implements the host and that the host uses', () => {
    const host = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-usecycle-promote-')));
    roots.push(host);
    const part = path.join(host, 'parts', 'plugin');
    fs.mkdirSync(part, { recursive: true });
    const hostSide = hostTree(false);
    hostSide.components!.push({ id: 'notice-desk', componentType: 'Portal', transport: 'InProcess', description: 'Raises notices.', dependsOn: ['pager'], invokedBy: { kind: 'entry', caller: 'Applications linking the host.' } });
    hostSide.interfaces!.push({ id: 'inotice_desk', component: 'notice-desk', methods: [{ name: 'raise', description: 'Raise a notice.', params: [{ name: 'recipient', type: 'string' }], returns: 'void', effect: 'none' }] });
    // The abstraction is published with role implement, so the entry can cross a boundary.
    hostSide.subsystems![0] = { ...hostSide.subsystems![0], publicInterfaces: [{ component: 'notice-sender', details: 'The abstraction.', role: 'implement' }] };
    materializeFixtureProject(host, hostSide);
    const partSide = pluginTree();
    partSide.subsystems![0] = { ...partSide.subsystems![0], parentSystem: 'Host' };
    // The part is the host's own subsystem: its contract implements the host's abstraction by its local id.
    partSide.interfaces![0] = { ...partSide.interfaces![0], implements: ['notice-sender'] };
    materializeFixtureProject(part, partSide);
    // A part has no id, no L0 and no configuration of its own.
    fs.rmSync(path.join(part, '.wai', 'specs', '.index.yaml'), { force: true });
    fs.rmSync(path.join(part, '.wai', 'project.yaml'), { force: true });
    fs.writeFileSync(path.join(host, '.wai', 'project.yaml'), configYaml('host', { members: { plugin: 'parts/plugin' } }));

    // Before the promote the family has one project and no loop.
    bind(host);
    expect(validateProject({}).issues.filter((i) => i.code === 'PROJECT_USE_CYCLE')).toEqual([]);

    const planned = planAt(host, { verb: 'promote', alias: 'plugin', announce: true });
    expect(planned.refusals).toEqual([]);
    expect(planned.notes.join('\n')).toContain('PROJECT_USE_CYCLE');
    migrations.discard(planned);
  });
});
