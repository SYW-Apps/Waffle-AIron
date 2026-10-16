/**
 * One refusal, one sentence: every spec write tool answers an id it cannot
 * write the same way. A member project's spec — named through its alias, or
 * by a bare id only the member holds — "lives in another project", naming the
 * member, its folder and the call to make there; an external's `alias::name`
 * lives in another project too, read-only here; an id no project in reach
 * holds is missing, in one shared wording. Before this, the rename and move
 * tools said "lives in another project" while the others said the spec did
 * not exist, for the same id. Nothing in the member or the producer changes.
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
import { pinExternals } from '../../src/core/surfaces.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { renameField, renameMethod, renameParam } from '../../src/core/provision.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

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

/** Every file under a project's specs folder with its bytes. */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const base = path.join(dir, '.wai', 'specs');
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(base, p).split(path.sep).join('/')] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(base);
  return out;
}

/** The ids one scenario addresses, one per kind. */
type Ids = { sub: string; comp: string; iface: string; impl: string; type: string };

/** An id's local name: what the owning project's own session calls it. */
const local = (id: string): string => id.slice(id.lastIndexOf('::') + 2);

/** Each spec write tool with the arguments addressing the scenario's ids, and the kind and id its refusal names. */
function walk(ids: Ids): { tool: string; args: Record<string, unknown>; kind: string; id: string }[] {
  return [
    { tool: 'sdd_update_spec', args: { kind: 'subsystem', id: ids.sub, delta: { description: 'x' } }, kind: 'subsystem', id: ids.sub },
    { tool: 'sdd_update_spec', args: { kind: 'component', id: ids.comp, delta: { description: 'x' } }, kind: 'component', id: ids.comp },
    { tool: 'sdd_update_spec', args: { kind: 'interface', id: ids.iface, delta: { description: 'x' } }, kind: 'interface', id: ids.iface },
    { tool: 'sdd_update_spec', args: { kind: 'implementation', id: ids.impl, delta: { description: 'x' } }, kind: 'implementation', id: ids.impl },
    { tool: 'sdd_update_spec', args: { kind: 'type', id: ids.type, delta: { name: 'X' } }, kind: 'type', id: ids.type },
    { tool: 'sdd_delete_spec', args: { kind: 'component', id: ids.comp }, kind: 'component', id: ids.comp },
    { tool: 'sdd_delete_spec', args: { kind: 'interface', id: ids.iface, dryRun: true }, kind: 'interface', id: ids.iface },
    { tool: 'sdd_delete_spec', args: { kind: 'type', id: ids.type }, kind: 'type', id: ids.type },
    { tool: 'sdd_rename_component', args: { id: ids.comp, newId: 'renamed' }, kind: 'component', id: ids.comp },
    { tool: 'sdd_rename_method', args: { id: ids.comp, method: 'list', newName: 'all' }, kind: 'component', id: ids.comp },
    { tool: 'sdd_rename_param', args: { id: ids.comp, method: 'list', param: 'user', newName: 'who' }, kind: 'component', id: ids.comp },
    { tool: 'sdd_rename_type', args: { id: ids.type, newId: 'renamed_type' }, kind: 'type', id: ids.type },
    { tool: 'sdd_rename_field', args: { id: ids.type, field: 'n', newName: 'm' }, kind: 'type', id: ids.type },
    { tool: 'sdd_rename_spec', args: { kind: 'interface', id: ids.iface, newId: 'irenamed' }, kind: 'interface', id: ids.iface },
    { tool: 'sdd_rename_spec', args: { kind: 'implementation', id: ids.impl, newId: 'renamed_impl' }, kind: 'implementation', id: ids.impl },
    { tool: 'sdd_move_spec', args: { kind: 'component', id: ids.comp, subsystem: 'habit' }, kind: 'component', id: ids.comp },
    { tool: 'sdd_move_spec', args: { kind: 'type', id: ids.type, subsystem: 'habit', dryRun: true }, kind: 'type', id: ids.type },
    { tool: 'sdd_move_methods', args: { from: ids.comp, to: 'habit_flow', methods: ['list'] }, kind: 'component', id: ids.comp },
    { tool: 'sdd_move_methods', args: { from: 'habit_flow', to: ids.comp, methods: ['track'] }, kind: 'component', id: ids.comp },
    { tool: 'sdd_set_endpoints', args: { interface: ids.iface, endpoints: [{ method: 'list', transport: 'CLI', command: 'list' }] }, kind: 'interface', id: ids.iface },
    { tool: 'sdd_set_public_interfaces', args: { subsystem: ids.sub, publicInterfaces: [] }, kind: 'subsystem', id: ids.sub },
    { tool: 'sdd_add_component', args: { id: 'probe', name: 'P', description: 'p', subsystem: ids.sub, componentType: 'Orchestrator' }, kind: 'subsystem', id: ids.sub },
    { tool: 'sdd_add_type', args: { kind: 'value-object', id: 'probe_t', name: 'P', subsystem: ids.sub, fields: [] }, kind: 'subsystem', id: ids.sub },
    { tool: 'sdd_define_interface', args: { id: 'iprobe', name: 'P', description: 'p', component: ids.comp, methods: [] }, kind: 'component', id: ids.comp },
    { tool: 'sdd_write_narrative', args: { id: 'probe_impl', name: 'P', description: 'p', contract: ids.iface, methods: [] }, kind: 'interface', id: ids.iface },
  ];
}

/** The tools that author a project's own specs, other than the family migrations and the member and external declarations. */
const NOT_SPEC_AUTHORING = new Set([
  'sdd_add_member', 'sdd_move_member', 'sdd_rename_project', 'sdd_rename_member_alias', 'sdd_add_external',
  'sdd_update_external', 'sdd_set_network',
]);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);

/** habits, binding the member `legacy` (vendor/legacy) and consuming cal-lib as the external `ext`, pinned. */
function family(): { app: string; member: string; cal: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-wording-')));
  roots.push(base);
  // cal: an independent project, consumed as the external `ext`.
  const cal = project(path.join(base, 'cal'), {
    system: { name: 'cal-lib', vision: 'A calendar library.', targetLanguage: 'TypeScript', publicInterfaces: [{ from: 'cal', component: 'cal_portal', as: 'calendar', audience: 'external' }, { from: 'cal', typeDef: 'cadence', audience: 'external' }] },
    subsystems: [{ id: 'cal', status: 'complete', publicInterfaces: [{ component: 'cal_portal', details: 'Calendars.' }, { typeDef: 'cadence', details: 'A cadence.' }] }],
    components: [{ id: 'cal_portal', subsystem: 'cal', componentType: 'Portal', transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'Applications linking it.' }, status: 'complete' }],
    interfaces: [{ id: 'ical_portal', component: 'cal_portal', methods: [{ name: 'list', description: 'Dates.', params: [{ name: 'user', type: 'string' }], returns: 'string', effect: 'none' }] }],
    implementations: [{ id: 'cal_portal_impl', contract: 'ical_portal', methods: [{ name: 'list', narrative: [] }] }],
    types: [{ id: 'cadence', kind: 'value-object', subsystem: 'cal', fields: [{ name: 'n', type: 'int' }] }],
  }, 'cal-lib');
  // habits: the bound project, with the member `legacy` under vendor/legacy.
  const app = project(path.join(base, 'habits'), {
    system: { name: 'habits', vision: 'Habits.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'habit', status: 'complete' }],
    components: [{ id: 'habit_flow', subsystem: 'habit', componentType: 'Orchestrator', status: 'complete' }],
    interfaces: [{ id: 'ihabit_flow', component: 'habit_flow', methods: [{ name: 'track', description: 'Track.', params: [], returns: 'void' }] }],
  }, 'habits', { externals: { ext: { project: 'cal-lib', source: { path: '../cal' } } }, members: { legacy: 'vendor/legacy' } });
  const member = project(path.join(app, 'vendor', 'legacy'), {
    system: { name: 'legacy-api', vision: 'The old API.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'old', status: 'complete' }],
    components: [{ id: 'habit_store', subsystem: 'old', componentType: 'Store', durability: 'ram-projection', status: 'complete' }],
    interfaces: [{ id: 'ihabit_store', component: 'habit_store', methods: [{ name: 'list', description: 'List.', params: [{ name: 'user', type: 'string' }], returns: 'list<string>', effect: 'read' }] }],
    implementations: [{ id: 'habit_store_mem', contract: 'ihabit_store', methods: [{ name: 'list', narrative: [] }] }],
    types: [{ id: 'streak', kind: 'value-object', subsystem: 'old', fields: [{ name: 'n', type: 'int' }] }],
  }, 'legacy-api');
  setProjectRoot(app);
  invalidateSpecCache();
  pinExternals(['ext']);
  invalidateSpecCache();
  return { app, member, cal };
}

describe('every spec write tool words a refusal of an id it cannot write the same way', () => {
  it('a member\'s spec (bare or by alias), an external\'s alias::name, and a missing id: one sentence each, nothing written', async () => {
    const { app, member, cal } = family();
    const before = { member: contents(member), cal: contents(cal), app: contents(app) };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'write-refusal-wording', version: '0.0.1' });
    clients.push(client);
    await Promise.all([createMcpServer().connect(serverTransport), client.connect(clientTransport)]);
    const call = async (tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
      const r = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      return { isError: r.isError === true, text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
    };

    // The walk covers every advertised tool that authors a spec under an existing one.
    const advertised = (await client.listTools()).tools.map((t) => t.name)
      .filter((n) => /^sdd_(update|delete|rename|move|set|add|define|write)_/.test(n) && !NOT_SPEC_AUTHORING.has(n));
    const walked = new Set([...walk({ sub: 'x', comp: 'x', iface: 'x', impl: 'x', type: 'x' }).map((w) => w.tool), 'sdd_add_subsystem']);
    expect(advertised.filter((n) => !walked.has(n)), 'a write tool the walk does not cover').toEqual([]);

    const head = 'lives in another project, and a project\'s specs are changed only from its own root\\. ';
    const memberSentence = (id: string, tool: string): RegExp => new RegExp(
      `^Error: chained-spec: "[^"]*${escape(local(id))}" ${head}`
      + 'It belongs to the member project "legacy-api" at vendor/legacy: open a session in that folder \\(its own guide and \\.mcp\\.json'
      + `.* and call ${tool}\\b[^\\n]* there\\.( This project has no \\w+ "${escape(id)}" of its own: a bare id always names this project's own spec\\.)? Nothing was written\\.$`,
      's',
    );
    const externalSentence = (id: string): RegExp => new RegExp(
      `^Error: chained-spec: "${escape(id)}" ${head}`
      + 'It belongs to "cal-lib", the project this one declares as the external "ext": it is read-only here — this project reads it only through its pin — '
      + 'and its owner changes it from that project\'s own root with sdd_\\w+[^\\n]*\\. Nothing was written\\.$',
      's',
    );
    const missingSentence = (kind: string, id: string): RegExp => new RegExp(`^Error: spec-missing: this project has no ${kind} "${escape(id)}"\\.( [^\\n]*)? Nothing was written\\.`);

    const scenarios: { what: string; ids: Ids; expected: (kind: string, id: string, tool: string) => RegExp }[] = [
      { what: 'a bare id only the member holds', ids: { sub: 'old', comp: 'habit_store', iface: 'ihabit_store', impl: 'habit_store_mem', type: 'streak' }, expected: (_k, id, tool) => memberSentence(id, tool) },
      { what: 'a member spec by its alias', ids: { sub: 'legacy::old', comp: 'legacy::habit_store', iface: 'legacy::ihabit_store', impl: 'legacy::habit_store_mem', type: 'legacy::streak' }, expected: (_k, id, tool) => memberSentence(id, tool) },
      { what: 'an external\'s alias::name', ids: { sub: 'ext::cal', comp: 'ext::cal_portal', iface: 'ext::ical_portal', impl: 'ext::cal_portal_impl', type: 'ext::cadence' }, expected: (_k, id) => externalSentence(id) },
      { what: 'an id no project holds', ids: { sub: 'nowhere', comp: 'nowhere', iface: 'inowhere', impl: 'nowhere_impl', type: 'nowhere_t' }, expected: (kind, id) => missingSentence(kind, id) },
    ];
    for (const scenario of scenarios) {
      for (const { tool, args, kind, id } of walk(scenario.ids)) {
        const { isError, text } = await call(tool, args);
        expect(isError, `${scenario.what}: ${tool} ${JSON.stringify(args)} answered: ${text}`).toBe(true);
        expect(text, `${scenario.what}: ${tool} ${JSON.stringify(args)}`).toMatch(scenario.expected(kind, id, tool));
      }
    }
    // A create never takes another project's id: by a member's alias or an external's, the same sentence.
    expect((await call('sdd_add_subsystem', { id: 'legacy::probe', name: 'P', description: 'p' })).text).toMatch(memberSentence('legacy::probe', 'sdd_add_subsystem'));
    expect((await call('sdd_add_subsystem', { id: 'ext::probe', name: 'P', description: 'p' })).text).toMatch(externalSentence('ext::probe'));

    invalidateSpecCache();
    expect(contents(member), 'the member changed').toEqual(before.member);
    expect(contents(cal), 'the producer changed').toEqual(before.cal);
    expect(contents(app), 'the bound project changed').toEqual(before.app);
  }, 180_000);
  it('the CLI twins (wairon method rename, method rename-param, type rename-field) answer with the same sentences', () => {
    const { member } = family();
    const before = contents(member);
    const cases: { run: (id: string) => unknown; id: string; tool: string; kind: string }[] = [
      { run: (id) => renameMethod(id, 'list', 'all'), id: 'legacy::habit_store', tool: 'sdd_rename_method', kind: 'component' },
      { run: (id) => renameParam(id, 'list', 'user', 'who'), id: 'legacy::habit_store', tool: 'sdd_rename_param', kind: 'component' },
      { run: (id) => renameField(id, 'n', 'm'), id: 'legacy::streak', tool: 'sdd_rename_field', kind: 'type' },
      { run: (id) => renameField(id, 'n', 'm'), id: 'streak', tool: 'sdd_rename_field', kind: 'type' },
    ];
    for (const c of cases) {
      expect(() => c.run(c.id), `${c.tool} ${c.id}`).toThrow(/^chained-spec: "[^"]+" lives in another project, and a project's specs are changed only from its own root\. It belongs to the member project "legacy-api" at vendor\/legacy: .* Nothing was written\.$/s);
      expect(() => c.run(`ext::${c.kind === 'type' ? 'cadence' : 'cal_portal'}`), `${c.tool} ext`).toThrow(/^chained-spec: "ext::\w+" lives in another project.*It belongs to "cal-lib", the project this one declares as the external "ext": it is read-only here/s);
      expect(() => c.run('nowhere'), `${c.tool} nowhere`).toThrow(new RegExp(`^spec-missing: this project has no ${c.kind} "nowhere"\\. Nothing was written\\.$`));
    }
    invalidateSpecCache();
    expect(contents(member)).toEqual(before);
  });
});
