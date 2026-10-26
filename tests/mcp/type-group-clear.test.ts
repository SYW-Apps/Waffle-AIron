/**
 * A type's group can be removed. Both documented routes (sdd_update_spec with
 * unset: ['group'], and re-defining the type through sdd_add_type without the
 * argument) reported the group gone while the saver put the stored group
 * back, so a type naming a group nothing declares could never reach zero
 * errors. A save that states no group now removes it; leaving a DECLARED group
 * also takes the file out of the group's folder. Every assertion reads the
 * YAML back from disk, not from the receipt.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };
type Call = (tool: string, args: Record<string, unknown>) => Promise<{ isError: boolean; text: string }>;

const roots: string[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function project(dir: string, tree: FixtureTree, id: string, extra: Record<string, unknown> = {}): string {
  materializeFixtureProject(dir, tree);
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, id, name: id, ...extra }));
  return dir;
}

const files = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out.push(p);
    }
  };
  walk(dir);
  return out;
};

/** The one file named <id>.yaml under a project's specs, read from disk. */
function onDisk(dir: string, id: string): { rel: string; doc: Record<string, unknown> } | undefined {
  const base = path.join(dir, '.wai', 'specs');
  const hit = files(base).find((f) => path.basename(f) === `${id}.yaml`);
  return hit ? { rel: path.relative(base, hit).split(path.sep).join('/'), doc: yaml.load(fs.readFileSync(hit, 'utf8')) as Record<string, unknown> } : undefined;
}

async function connect(): Promise<Call> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'type-group-clear', version: '0.0.1' });
  clients.push(client);
  await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
  return async (tool, args) => {
    const r = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
    return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
}

function habits(): string {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-group-')));
  roots.push(base);
  const dir = project(path.join(base, 'habits'), {
    system: { name: 'habits', vision: 'Habits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habit', status: 'complete' }],
    components: [{ id: 'habit_flow', subsystem: 'habit', componentType: 'Orchestrator', status: 'complete' }],
    interfaces: [{ id: 'ihabit_flow', component: 'habit_flow', methods: [{ name: 'track', description: 'Track.', params: [], returns: 'void' }] }],
    types: [{ id: 'cadence', kind: 'value-object', subsystem: 'habit', fields: [{ name: 'n', type: 'int' }] }],
  }, 'habits');
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

const addType = (call: Call, id: string, extra: Record<string, unknown> = {}) =>
  call('sdd_add_type', { kind: 'value-object', id, name: id, subsystem: 'habit', holds: 'string', ...extra });

describe('a type\'s group can be removed', () => {
  it('sdd_update_spec unset group clears an undeclared group on disk', async () => {
    const dir = habits();
    const call = await connect();
    expect((await addType(call, 'streak', { group: 'not-declared' })).isError).toBe(false);
    expect(onDisk(dir, 'streak')?.doc.group).toBe('not-declared');
    const r = await call('sdd_update_spec', { kind: 'type', id: 'streak', delta: { unset: ['group'] } });
    expect(r.isError, r.text).toBe(false);
    invalidateSpecCache();
    const after = onDisk(dir, 'streak');
    expect(after && 'group' in after.doc).toBe(false);
  });

  it('sdd_add_type re-defining a type without group clears it on disk', async () => {
    const dir = habits();
    const call = await connect();
    await addType(call, 'streak', { group: 'not-declared' });
    const r = await addType(call, 'streak');
    expect(r.isError, r.text).toBe(false);
    invalidateSpecCache();
    const after = onDisk(dir, 'streak');
    expect(after && 'group' in after.doc).toBe(false);
  });

  it('a declared group that is cleared takes the file out of the group folder, with a notice', async () => {
    const dir = habits();
    const call = await connect();
    expect((await call('sdd_add_group', { id: 'cadences', name: 'Cadences', subsystem: 'habit' })).isError).toBe(false);
    await addType(call, 'streak', { group: 'cadences' });
    const before = onDisk(dir, 'streak')!;
    expect(before.rel).toContain('cadences/');
    const r = await call('sdd_update_spec', { kind: 'type', id: 'streak', delta: { unset: ['group'] } });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/type "streak" left group "cadences": its file is now /);
    invalidateSpecCache();
    const after = onDisk(dir, 'streak')!;
    expect(after.rel).not.toContain('cadences/');
    expect('group' in after.doc).toBe(false);
    expect(files(path.join(dir, '.wai', 'specs')).filter((f) => path.basename(f) === 'streak.yaml')).toHaveLength(1);
  });

  it('setting a group and regrouping still work', async () => {
    const dir = habits();
    const call = await connect();
    await call('sdd_add_group', { id: 'cadences', name: 'Cadences', subsystem: 'habit' });
    await call('sdd_add_group', { id: 'rhythms', name: 'Rhythms', subsystem: 'habit' });
    expect((await call('sdd_update_spec', { kind: 'type', id: 'cadence', delta: { group: 'cadences' } })).isError).toBe(false);
    invalidateSpecCache();
    expect(onDisk(dir, 'cadence')).toMatchObject({ doc: { group: 'cadences' } });
    expect(onDisk(dir, 'cadence')!.rel).toContain('cadences/');
    const r = await call('sdd_update_spec', { kind: 'type', id: 'cadence', delta: { group: 'rhythms' } });
    expect(r.text).toMatch(/moved to group "rhythms"/);
    invalidateSpecCache();
    expect(onDisk(dir, 'cadence')).toMatchObject({ doc: { group: 'rhythms' } });
    expect(onDisk(dir, 'cadence')!.rel).toContain('rhythms/');
  });

  it('a type leaving its group for a home another file holds is refused, naming both files, and nothing changes', async () => {
    const dir = habits();
    const call = await connect();
    await call('sdd_add_group', { id: 'cadences', name: 'Cadences', subsystem: 'habit' });
    await addType(call, 'streak', { group: 'cadences' });
    const specs = path.join(dir, '.wai', 'specs');
    const before = onDisk(dir, 'streak')!;
    const stray = path.join(specs, before.rel.replace('cadences/', ''));
    fs.writeFileSync(stray, 'a stray file\n');
    const r = await call('sdd_update_spec', { kind: 'type', id: 'streak', delta: { unset: ['group'] } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('Refusing to move type "streak" out of group "cadences"');
    expect(r.text).toContain(before.rel.split('/').pop()!);
    expect(fs.readFileSync(stray, 'utf8')).toBe('a stray file\n');
    invalidateSpecCache();
    expect(yaml.load(fs.readFileSync(path.join(specs, before.rel), 'utf8'))).toMatchObject({ group: 'cadences' });
  });

  it('a type joining a group whose folder already holds its file name is refused, and nothing changes', async () => {
    const dir = habits();
    const call = await connect();
    await call('sdd_add_group', { id: 'cadences', name: 'Cadences', subsystem: 'habit' });
    await call('sdd_add_group', { id: 'rhythms', name: 'Rhythms', subsystem: 'habit' });
    await call('sdd_update_spec', { kind: 'type', id: 'cadence', delta: { group: 'cadences' } });
    invalidateSpecCache();
    const specs = path.join(dir, '.wai', 'specs');
    const before = onDisk(dir, 'cadence')!;
    const stray = path.join(specs, before.rel.replace('cadences/', 'rhythms/'));
    fs.writeFileSync(stray, 'a stray file\n');
    const r = await call('sdd_update_spec', { kind: 'type', id: 'cadence', delta: { group: 'rhythms' } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('Refusing to move type "cadence" into group "rhythms"');
    expect(fs.readFileSync(stray, 'utf8')).toBe('a stray file\n');
    invalidateSpecCache();
    expect(yaml.load(fs.readFileSync(path.join(specs, before.rel), 'utf8'))).toMatchObject({ group: 'cadences' });
  });

  it('a part\'s type that leaves a declared group stays in the part', async () => {
    const dir = habits();
    const file = path.join(dir, '.wai', 'project.yaml');
    fs.writeFileSync(file, yaml.dump({ ...(yaml.load(fs.readFileSync(file, 'utf8')) as object), members: { shared: 'parts/shared' } }));
    const part = path.join(dir, 'parts', 'shared');
    const stamp = '2026-10-25T00:00:00.000Z';
    fs.mkdirSync(path.join(part, '.wai', 'specs', 'types', 'kinds'), { recursive: true });
    fs.writeFileSync(path.join(part, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0' }));
    fs.writeFileSync(path.join(part, '.wai', 'specs', 'types', 'kinds', '.index.yaml'),
      yaml.dump({ kind: 'group', id: 'kinds', name: 'Kinds', createdAt: stamp, updatedAt: stamp }));
    fs.writeFileSync(path.join(part, '.wai', 'specs', 'types', 'kinds', 'token.yaml'),
      yaml.dump({ id: 'token', name: 'Token', kind: 'value-object', group: 'kinds', holds: 'string', createdAt: stamp, updatedAt: stamp }));
    invalidateSpecCache();
    const call = await connect();
    const r = await call('sdd_update_spec', { kind: 'type', id: 'token', delta: { unset: ['group'] } });
    expect(r.isError, r.text).toBe(false);
    invalidateSpecCache();
    const after = onDisk(part, 'token')!;
    expect(after.rel).toBe('types/token.yaml');
    expect('group' in after.doc).toBe(false);
    expect(onDisk(dir, 'token')).toBeUndefined();
  });

  it('an unrelated update keeps the group', async () => {
    const dir = habits();
    const call = await connect();
    await addType(call, 'streak', { group: 'not-declared' });
    await call('sdd_update_spec', { kind: 'type', id: 'streak', delta: { description: 'A streak.' } });
    invalidateSpecCache();
    expect(onDisk(dir, 'streak')?.doc.group).toBe('not-declared');
  });
});

describe('a member project of a member project', () => {
  it('a refusal from the family root names the project that holds the spec and the id its own root spells', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-depth-')));
    roots.push(base);
    const app = project(path.join(base, 'app'), {
      system: { name: 'app', vision: 'App.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'front', status: 'complete' }],
      components: [{ id: 'front_flow', subsystem: 'front', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'ifront_flow', component: 'front_flow', methods: [{ name: 'run', description: 'Run.', params: [], returns: 'void' }] }],
    }, 'app', { members: { outer: 'libs/outer' } });
    const outer = project(path.join(app, 'libs', 'outer'), {
      system: { name: 'outer', vision: 'Outer.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'core', status: 'complete' }],
      components: [{ id: 'core_flow', subsystem: 'core', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'icore_flow', component: 'core_flow', methods: [{ name: 'run', description: 'Run.', params: [], returns: 'void' }] }],
    }, 'outer', { members: { inner: 'inner' } });
    project(path.join(outer, 'inner'), {
      system: { name: 'inner', vision: 'Inner.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'deep', status: 'complete' }],
      components: [{ id: 'deep_flow', subsystem: 'deep', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'ideep_flow', component: 'deep_flow', methods: [{ name: 'run', description: 'Run.', params: [], returns: 'void' }] }],
      types: [{ id: 'depth_probe', kind: 'value-object', subsystem: 'deep', fields: [{ name: 'n', type: 'int' }] }],
    }, 'inner');
    setProjectRoot(app);
    invalidateSpecCache();
    const call = await connect();
    const r = await call('sdd_update_spec', { kind: 'type', id: 'outer::inner::depth_probe', delta: { unset: ['group'] } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).toContain('It belongs to the member project "inner" at libs/outer/inner:');
    expect(r.text).toContain('call sdd_update_spec type depth_probe there.');
    expect(r.text).not.toContain('"outer" at');
    // The id it names resolves at that root: opened there, the bare id is the project's own type.
    setProjectRoot(path.join(outer, 'inner'));
    invalidateSpecCache();
    const there = await call('sdd_update_spec', { kind: 'type', id: 'depth_probe', delta: { description: 'Probe.' } });
    expect(there.isError, there.text).toBe(false);
  });

  it('a sibling whose folder name merely extends the named member\'s is never taken for a deeper project', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-sibling-')));
    roots.push(base);
    const flow = (id: string) => ({
      system: { name: id, vision: `${id}.`, targetLanguage: 'TypeScript' },
      subsystems: [{ id: `${id.replace('-', '_')}_sub`, status: 'complete' as const }],
      components: [{ id: `${id.replace('-', '_')}_flow`, subsystem: `${id.replace('-', '_')}_sub`, componentType: 'Orchestrator', status: 'complete' as const }],
      interfaces: [{ id: `i${id.replace('-', '_')}_flow`, component: `${id.replace('-', '_')}_flow`, methods: [{ name: 'run', description: 'Run.', params: [], returns: 'void' }] }],
      types: [{ id: 'probe', kind: 'value-object', subsystem: `${id.replace('-', '_')}_sub`, fields: [{ name: 'n', type: 'int' }] }],
    });
    const app = project(path.join(base, 'app'), {
      system: { name: 'app', vision: 'App.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'front', status: 'complete' }],
      components: [{ id: 'front_flow', subsystem: 'front', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'ifront_flow', component: 'front_flow', methods: [{ name: 'run', description: 'Run.', params: [], returns: 'void' }] }],
    }, 'app', { members: { inner: 'libs/inner', 'inner-helper': 'libs/inner-helper' } });
    project(path.join(app, 'libs', 'inner'), flow('inner'), 'inner');
    project(path.join(app, 'libs', 'inner-helper'), flow('inner-helper'), 'inner-helper');
    setProjectRoot(app);
    invalidateSpecCache();
    const call = await connect();
    const r = await call('sdd_update_spec', { kind: 'type', id: 'inner::inner-helper::probe', delta: { description: 'P.' } });
    expect(r.isError, r.text).toBe(true);
    expect(r.text).not.toContain('"inner-helper" at');
  });
});
