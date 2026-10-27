/**
 * architecture_diagrams.renderTypeDiagrams — the project's own types drawn as
 * Mermaid per type group: an index of the groups (the tree, type counts, the
 * references between groups added up), one class diagram per group holding
 * types with stubs for the types it references elsewhere, and the ungrouped
 * types. And `wairon diagram --types | --group <id>`, which writes them.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveGroupSpec, saveTypeSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { renderTypeDiagrams, generateDiagramSet } from '../../src/core/diagram.js';
import { runDiagram } from '../../src/commands/diagram.js';

const now = '2026-01-01T00:00:00.000Z';
const group = (id: string, over: Record<string, unknown> = {}) => saveGroupSpec({ kind: 'group', id, name: id, createdAt: now, updatedAt: now, ...over } as any);
const put = (id: string, over: Record<string, unknown> = {}) => saveTypeSpec({ kind: 'value-object', id, name: id, description: 'd', fields: [], methods: [], createdAt: now, updatedAt: now, ...over } as any);
const field = (name: string, type: string, optional = false) => ({ name, type, description: 'd', optional });

describe('type diagrams per group', () => {
  let proj: string;
  const savedCwd = process.cwd();
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-type-diagrams-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), 'schemaVersion: 1.0.0\nname: contracts\ntargets: []\n');
    setProjectRoot(proj);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'contracts', vision: 'Shared contracts', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as any);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    setProjectRoot(null);
    invalidateSpecCache();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  /** platform > runtime, and wire; types in each, two ungrouped, references across them. */
  function seed(): void {
    group('platform', { name: 'Platform' });
    group('runtime', { name: 'Runtime', parent: 'platform' });
    group('wire', { name: 'Wire' });
    put('status', { kind: 'enum', group: 'wire', values: [{ name: 'active' }, { name: 'retired' }] });
    put('frame', { group: 'wire', fields: [field('state', 'Status'), field('body', 'bytes')] });
    put('vm', { group: 'runtime', fields: [field('frames', 'list<Frame>'), field('host', 'Host', true)] });
    put('host', { group: 'platform', fields: [field('name', 'string')], methods: [{ name: 'boot', description: 'd', params: [{ name: 'vm', type: 'Vm' }], returns: 'Status' }] });
    put('loose', { fields: [field('frame', 'Frame')] });
    put('lonely');
  }

  it('answers nothing for a project without types of its own', () => {
    expect(renderTypeDiagrams()).toEqual([]);
  });

  it('answers the index, then each group holding types parents first, then the ungrouped types', () => {
    seed();
    const diagrams = renderTypeDiagrams();
    expect(diagrams.map((d) => [d.scope, d.group ?? null, d.relPath])).toEqual([
      ['index', null, 'types/index.md'],
      ['group', 'platform', 'types/groups/platform.md'],
      ['group', 'wire', 'types/groups/wire.md'],
      ['group', 'runtime', 'types/groups/platform/runtime.md'],
      ['ungrouped', null, 'types/ungrouped.md'],
    ]);
  });

  it('the index nests a child group inside its parent and adds the references between groups into one counted edge per pair', () => {
    seed();
    const index = renderTypeDiagrams()[0].mermaid;
    expect(index.split('\n')[0]).toBe('flowchart LR');
    expect(index).toMatch(/subgraph \w+\["Platform"\]/);
    expect(index).toContain('Runtime<br/>1 type"]');
    expect(index).toContain('Wire<br/>2 types"]');
    expect(index).toContain('Ungrouped<br/>2 types"]');
    // vm (runtime) refers to frame (wire) once and host (platform) once; host refers to vm and status.
    expect(index).toContain('runtime -->|1| wire');
    expect(index).toContain('runtime -->|1| platform');
    expect(index).toContain('platform -->|1| runtime');
    expect(index).toContain('platform -->|1| wire');
    expect(index).toContain('_ungrouped -->|1| wire');
    // A reference within one group (frame -> status, both wire) draws no edge.
    expect(index).not.toContain('wire -->');
  });

  it('a group diagram draws its types with their members, and the types it references elsewhere as stubs naming their group', () => {
    seed();
    const runtime = renderTypeDiagrams().find((d) => d.group === 'runtime')!.mermaid;
    expect(runtime.split('\n')[0]).toBe('classDiagram');
    expect(runtime).toContain('class vm["vm"]');
    expect(runtime).toContain('vm : +list~Frame~ frames');
    expect(runtime).toContain('vm : +Host? host');
    expect(runtime).toContain('class frame["frame — in Wire"]');
    expect(runtime).toContain('class host["host — in Platform"]');
    expect(runtime).toContain('vm --> frame : frames');
    expect(runtime).toContain('vm --> host : host');
    // A stub carries no members.
    expect(runtime).not.toMatch(/^\s+frame : /m);

    const wire = renderTypeDiagrams().find((d) => d.group === 'wire')!.mermaid;
    expect(wire).toContain('<<enumeration>> status');
    expect(wire).toContain('status : active');
    expect(wire).toContain('frame --> status : state');
    // A primitive stays in the member line and draws no edge.
    expect(wire).toContain('frame : +bytes body');

    const platform = renderTypeDiagrams().find((d) => d.group === 'platform')!.mermaid;
    expect(platform).toContain('host : +boot(Vm vm) Status');
    expect(platform).toContain('host --> vm : boot()');
  });

  it('a method written as a prose signature lists its params as the structured ones do, with no colon to end the member line', () => {
    put('ledger', { methods: [{ name: 'hashOf', description: 'd', signature: 'hashOf(token: string, salt?: map<string, int>): string', returns: 'string' }] });
    const ungrouped = renderTypeDiagrams().find((d) => d.scope === 'ungrouped')!.mermaid;
    expect(ungrouped).toContain('ledger : +hashOf(string token, map~string, int~? salt) string');
  });

  it('a type naming a group no spec declares is drawn with the ungrouped types', () => {
    seed();
    put('stray', { group: 'nowhere' });
    const ungrouped = renderTypeDiagrams().find((d) => d.scope === 'ungrouped')!.mermaid;
    expect(ungrouped).toContain('class stray["stray"]');
  });

  it('--all writes the type diagrams with the rest of the set', () => {
    seed();
    expect(generateDiagramSet().map((f) => f.relPath)).toEqual(expect.arrayContaining([
      'types/index.md', 'types/groups/platform/runtime.md', 'types/ungrouped.md',
    ]));
  });

  describe('wairon diagram --types | --group', () => {
    it('--types writes the index, --group the named group\'s diagram where the group tree puts it', async () => {
      seed();
      process.chdir(proj);
      await runDiagram({ types: true });
      await runDiagram({ group: 'runtime' });
      const dir = path.join(proj, '.wai', 'docs', 'diagrams', 'types');
      expect(fs.readFileSync(path.join(dir, 'index.md'), 'utf8')).toContain('# Type groups');
      const runtime = fs.readFileSync(path.join(dir, 'groups', 'platform', 'runtime.md'), 'utf8');
      expect(runtime).toContain('# Runtime — types');
      expect(runtime).toContain('```mermaid\nclassDiagram');
    });

    it('refuses an unknown group, a group holding no types of its own, and a format other than Mermaid, writing nothing', async () => {
      seed();
      group('empty');
      process.chdir(proj);
      await expect(runDiagram({ group: 'nowhere' })).rejects.toThrow(/No type group "nowhere" in this tree — it holds .*platform.*Nothing was written/);
      await expect(runDiagram({ group: 'empty' })).rejects.toThrow(/"empty" holds no types of its own/);
      await expect(runDiagram({ types: true, format: 'canvas' })).rejects.toThrow(/Mermaid only/);
      expect(fs.existsSync(path.join(proj, '.wai', 'docs', 'diagrams'))).toBe(false);
    });
  });
});
