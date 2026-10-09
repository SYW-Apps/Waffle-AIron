import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadComponentSpec, loadSubsystemSpec, loadTypeSpec, scanAllSpecs } from '../../src/core/specs.js';
import { moveSpec, updateSpecGated, writeSpec } from '../../src/core/authoring.js';
import { renameMethod, renameType } from '../../src/core/provision.js';
import { validateProject } from '../../src/core/validation.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { migrate, plan } from '../helpers/family-verbs.js';

// ---------------------------------------------------------------------------
// Round-9 trial findings on the authoring tools and the family migrations
// (platform, solo-app, lib-and-app, tinkerer — dev.113). Every test here failed
// on dev.113.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** A fresh scratch folder (realpath'd), removed after the test. */
function scratch(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wairon-r9-${prefix}-`)));
  roots.push(dir);
  return dir;
}

/** A project materialized at `dir` from a fixture tree, its project.yaml given an id and extra fields. */
function project(dir: string, tree: FixtureTree, id?: string, extra: Record<string, unknown> = {}): string {
  materializeFixtureProject(dir, tree);
  const file = path.join(dir, '.wai', 'project.yaml');
  const config = yaml.load(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(file, yaml.dump({ ...config, ...(id ? { id, name: id } : {}), ...extra }));
  return dir;
}

/** Bind a root, reading it fresh. */
function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Every spec file's text under a project's specs folder, joined: what a respelling must show up in. */
function specText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(dir, '.wai', 'specs'));
  return out.join('\n');
}

/** The codes of a validation's errors. */
const errorCodes = (): string[] => {
  invalidateSpecCache();
  return validateProject().issues.filter((i) => i.severity === 'error').map((i) => i.code);
};

describe('item 1 (platform top-1): sdd_move_spec of a TYPE follows every spelling of a reference', () => {
  it('rewrites the dot form and the :: form, inside generics, optionals and returns; the tree stays green', () => {
    const dir = project(scratch('typemove'), {
      subsystems: [{ id: 'api', status: 'complete' }, { id: 'orders', status: 'complete' }],
      components: [{ id: 'order_flow', subsystem: 'orders', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{
        id: 'iorder_flow', component: 'order_flow', methods: [
          { name: 'status', description: 'Read a status.', params: [{ name: 'history', type: 'list<api::order_status>' }], returns: 'api.order_status' },
          { name: 'maybe', description: 'Maybe a status.', params: [{ name: 'prev', type: 'api.order_status?' }], returns: 'result<api::order_status, string>' },
        ],
      }],
      types: [
        { id: 'order_status', kind: 'value-object', subsystem: 'api', fields: [{ name: 'code', type: 'string' }] },
        { id: 'order', kind: 'value-object', subsystem: 'orders', fields: [
          { name: 'status', type: 'api.order_status' },
          { name: 'history', type: 'list<api.order_status>' },
          { name: 'byDay', type: 'map<string, api::order_status>' },
        ] },
      ],
    });
    bind(dir);
    expect(errorCodes()).not.toContain('UNDEFINED_TYPE_REFERENCE');

    const dry = moveSpec('type', 'order_status', 'orders', true);
    expect(dry.rewritten).toEqual(expect.arrayContaining(['order', 'iorder_flow']));
    const report = moveSpec('type', 'order_status', 'orders');
    expect(report.rewritten).toEqual(expect.arrayContaining(['order', 'iorder_flow']));

    const text = specText(dir);
    expect(text).not.toMatch(/api(::|\.)order_status/);
    expect(text).toContain('list<orders::order_status>');
    expect(text).toContain('orders.order_status?');
    expect(text).toContain('result<orders::order_status, string>');
    expect(text).toContain('list<orders.order_status>');
    expect(text).toContain('map<string, orders::order_status>');
    expect(errorCodes()).not.toContain('UNDEFINED_TYPE_REFERENCE');
  });

  it('to system level, the qualifier goes with its separator in either spelling', () => {
    const dir = project(scratch('typeflat'), {
      subsystems: [{ id: 'api', status: 'complete' }, { id: 'orders', status: 'complete' }],
      types: [
        { id: 'money', kind: 'value-object', subsystem: 'api', fields: [{ name: 'cents', type: 'int' }] },
        { id: 'invoice', kind: 'value-object', subsystem: 'orders', fields: [{ name: 'total', type: 'api.money' }, { name: 'parts', type: 'list<api::money>' }] },
      ],
    });
    bind(dir);
    moveSpec('type', 'money', undefined);
    const text = specText(dir);
    expect(text).not.toMatch(/api(::|\.)money/);
    expect(text).toContain('list<money>');
    expect(errorCodes()).not.toContain('UNDEFINED_TYPE_REFERENCE');
  });
});

describe('item 2 (solo-app): sdd_move_spec moves a connected cluster as one move', () => {
  const cluster = (): string => project(scratch('cluster'), {
    subsystems: [{ id: 'app', status: 'complete' }, { id: 'accounts', status: 'complete' }],
    components: [
      { id: 'account_portal', subsystem: 'app', componentType: 'Portal', transport: 'HTTP', dependsOn: ['account_orchestrator'], invokedBy: { kind: 'entry', caller: 'Browsers signing in.' }, status: 'complete' },
      { id: 'account_orchestrator', subsystem: 'app', componentType: 'Orchestrator', dependsOn: ['user_store'], status: 'complete' },
      { id: 'user_store', subsystem: 'app', componentType: 'Store', durability: 'ram-projection', status: 'complete' },
    ],
  });

  it('a single move is refused naming the collaborators as the `together` list; the cluster moves together', () => {
    const dir = cluster();
    bind(dir);
    expect(() => moveSpec('component', 'account_orchestrator', 'accounts', true))
      .toThrow(/together: \["account_portal", "user_store"\]/);
    const dry = moveSpec('component', 'account_orchestrator', 'accounts', true, ['account_portal', 'user_store']);
    expect(dry.dryRun).toBe(true);
    expect(dry.moved.filter((m) => m.kind === 'component').map((m) => m.id).sort()).toEqual(['account_orchestrator', 'account_portal', 'user_store']);
    // The dry run wrote nothing.
    bind(dir);
    expect(loadComponentSpec('user_store')?.subsystem).toBe('app');

    moveSpec('component', 'account_orchestrator', 'accounts', false, ['account_portal', 'user_store']);
    bind(dir);
    for (const id of ['account_orchestrator', 'account_portal', 'user_store']) expect(loadComponentSpec(id)?.subsystem).toBe('accounts');
    expect(errorCodes().filter((c) => c.startsWith('CROSS_SUBSYSTEM'))).toEqual([]);
  });
});

describe('item 3 (tinkerer, EDGE): a path-shaped name never writes outside the tree', () => {
  it('a subsystem, a type subsystem or a parent spelled as a path, or in another case, is refused and nothing lands anywhere', () => {
    const base = scratch('paths');
    const dir = project(path.join(base, 'proj'), {
      subsystems: [{ id: 'links', status: 'complete' }, { id: 'analytics', status: 'complete' }],
      components: [{ id: 'link_flow', subsystem: 'links', componentType: 'Orchestrator', status: 'complete' }],
    });
    // A sibling project whose spec tree a climbing path would reach.
    const sibling = project(path.join(base, 'dashboard'), { subsystems: [{ id: 'dashboard', status: 'complete' }] });
    const siblingBefore = specText(sibling);
    bind(dir);
    const component = (subsystem: string) => writeSpec({
      kind: 'component',
      spec: { id: 'boundary_probe', name: 'Probe', description: 'probe', subsystem, componentType: 'Orchestrator', owns: [], dependsOn: [] } as never,
      fields: ['id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn'],
    });
    for (const bad of ['../../../dashboard/.wai/specs/dashboard', '../../dashboard/.wai/specs/subsystems/dashboard', 'links/../analytics', 'links/', '..\\..\\dashboard']) {
      expect(() => component(bad), bad).toThrow(/not-an-id/);
    }
    // Another case is no id this tree holds, though a case-insensitive filesystem finds its file.
    expect(() => component('Links')).toThrow(/does not exist/);
    expect(() => writeSpec({
      kind: 'type',
      spec: { id: 'bt', name: 'Bt', kind: 'value-object', subsystem: 'links/../analytics', fields: [{ name: 'v', type: 'string' }], methods: [] } as never,
      fields: ['id', 'name', 'kind', 'subsystem', 'fields', 'methods'],
    })).toThrow(/not-an-id/);
    expect(loadSubsystemSpec('Links')).toBeNull();
    expect(loadSubsystemSpec('../analytics')).toBeNull();
    expect(specText(sibling)).toBe(siblingBefore);
    expect(scanAllSpecs().components.map((c) => c.id)).not.toContain('boundary_probe');
  });
});

/** geo: a project member exporting `distance_portal` as `distance`, and a trait `geocoding_provider` consumers implement. */
function geoMember(dir: string): string {
  return project(dir, {
    system: {
      name: 'geo-lib', vision: 'A geo library.', targetLanguage: 'TypeScript',
      publicInterfaces: [
        { from: 'math', component: 'distance_portal', as: 'distance', audience: 'project' },
        { from: 'math', component: 'provider_port', as: 'geocoding_provider', role: 'implement', audience: 'project' },
        { from: 'math', typeDef: 'point', audience: 'project' },
      ],
    },
    subsystems: [{
      id: 'math', status: 'complete', publicInterfaces: [
        { component: 'distance_portal', details: 'Distances.' },
        { component: 'provider_port', details: 'The provider consumers implement.', role: 'implement' },
        { typeDef: 'point', details: 'A point.' },
      ],
    }],
    components: [
      { id: 'distance_portal', subsystem: 'math', componentType: 'Portal', transport: 'InProcess', invokedBy: { kind: 'entry', caller: 'Applications linking the library.' }, status: 'complete' },
      { id: 'provider_port', subsystem: 'math', componentType: 'Adapter', status: 'complete' },
    ],
    interfaces: [
      { id: 'idistance_portal', component: 'distance_portal', methods: [{ name: 'between', description: 'Distance between two points.', params: [{ name: 'a', type: 'point' }, { name: 'b', type: 'point' }], returns: 'float', effect: 'none' }] },
      { id: 'iprovider_port', component: 'provider_port', methods: [
        { name: 'forward', description: 'Address to point.', params: [{ name: 'query', type: 'string' }], returns: 'point' },
        { name: 'reverse', description: 'Point to address.', params: [{ name: 'at', type: 'point' }], returns: 'string' },
      ] },
    ],
    types: [{ id: 'point', kind: 'value-object', subsystem: 'math', fields: [{ name: 'x', type: 'float' }, { name: 'y', type: 'float' }] }],
  }, 'geo-lib');
}

/** route-planner: consumes geo (a member under libs/geo) — by its internal id, and implementing its trait. */
function routePlanner(base: string): { app: string; geo: string } {
  const app = project(path.join(base, 'app'), {
    system: { name: 'route-planner', vision: 'Plans routes.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'routing', status: 'complete' }],
    components: [
      { id: 'stop_sequencer', subsystem: 'routing', componentType: 'Orchestrator', dependencyClass: 'pure', dependsOn: ['geo::distance_portal'], status: 'complete' },
      { id: 'nominatim_provider', subsystem: 'routing', componentType: 'Adapter', status: 'complete' },
    ],
    interfaces: [
      { id: 'istop_sequencer', component: 'stop_sequencer', methods: [{ name: 'order', description: 'Order stops.', params: [{ name: 'stops', type: 'list<geo::point>' }], returns: 'list<geo::point>' }] },
      { id: 'inominatim_provider', component: 'nominatim_provider', implements: 'geo::geocoding_provider', methods: [
        { name: 'forward', description: 'Nominatim search.', signatureFrom: 'geo::geocoding_provider.forward' },
        { name: 'reverse', description: 'Nominatim reverse.', signatureFrom: 'geo::geocoding_provider.reverse' },
      ] },
    ],
  }, 'route-planner', { members: { geo: 'libs/geo' } });
  const geo = geoMember(path.join(app, 'libs', 'geo'));
  return { app, geo };
}

describe('item 6 (lib-and-app R9-19): sdd_update_spec compares references by their written text', () => {
  it('respelling an internal id to the public name is a change, written at its position', () => {
    const { app } = routePlanner(scratch('respell'));
    bind(app);
    const dry = updateSpecGated('component', 'stop_sequencer', { dependsOn: ['geo::distance'] }, true);
    expect(dry.changes, JSON.stringify(dry)).toEqual([expect.objectContaining({ path: 'dependsOn', change: 'set', before: 'geo::distance_portal', after: 'geo::distance' })]);
    expect(dry.summary).not.toMatch(/No change/);
    const report = updateSpecGated('component', 'stop_sequencer', { dependsOn: ['geo::distance'] });
    expect(report.written).toBe(true);
    const text = fs.readFileSync(path.join(app, '.wai', 'specs', 'components', 'stop_sequencer.yaml'), 'utf8');
    expect(text).toContain('geo::distance');
    expect(text).not.toContain('geo::distance_portal');
    // Restated now, it matches: no change.
    bind(app);
    expect(updateSpecGated('component', 'stop_sequencer', { dependsOn: ['geo::distance'] }, true).changes).toEqual([]);
  });

  it('a methods delta that leaves a method out answers how to remove one', () => {
    const { app } = routePlanner(scratch('omitted'));
    bind(app);
    const report = updateSpecGated('interface', 'inominatim_provider', { methods: [{ name: 'forward' }] }, true);
    expect(report.changes).toEqual([]);
    expect(report.notices.join('\n')).toMatch(/"reverse".*upserts.*\{"methods": \[\{"name": "reverse", "action": "delete"\}\]\}/s);
  });
});

describe('item 7 (lib-and-app R9-11): member rename-alias rewrites one text repeated under implements and signatureFrom', () => {
  it('plans and applies on the trait-implementer shape, every occurrence respelled', () => {
    const { app } = routePlanner(scratch('alias'));
    const planned = plan(app, { verb: 'rename-alias', alias: 'geo', newAlias: 'sdk' });
    expect(planned.refusals).toEqual([]);
    migrate(app, { verb: 'rename-alias', alias: 'geo', newAlias: 'sdk' });
    const text = fs.readFileSync(path.join(app, '.wai', 'specs', 'interfaces', 'inominatim_provider.yaml'), 'utf8');
    expect(text).toContain('implements: sdk::geocoding_provider');
    expect(text).toContain('sdk::geocoding_provider.forward');
    expect(text).toContain('sdk::geocoding_provider.reverse');
    expect(specText(app)).not.toMatch(/\bgeo::/);
  });
});

describe('item 9 (solo-app): reads resolve an `alias::name` the way writes do', () => {
  it('a member component and type read by alias::id', () => {
    const { app } = routePlanner(scratch('readalias'));
    bind(app);
    expect(loadComponentSpec('geo::distance_portal')?.id).toMatch(/::distance_portal$/);
    expect(loadTypeSpec('geo::point')?.id).toMatch(/point$/);
  });
});

describe('item 10: the rename tools give the project boundary\'s refusal and name the member by its id', () => {
  it('rename_type through the alias names the member project by its id; rename_method by its alias is no component-missing', () => {
    const { app } = routePlanner(scratch('wording'));
    bind(app);
    expect(() => renameType('geo::point', 'pt')).toThrow(/member project "geo-lib"/);
    expect(() => renameMethod('geo::distance_portal', 'between', 'span')).toThrow(/chained-component:.*member project "geo-lib" at libs\/geo/s);
  });

  it('rename_method pins no symbol when no code exists, and pins when the file is there', () => {
    const dir = project(scratch('pin'), {
      subsystems: [{ id: 'core', status: 'complete' }],
      components: [{ id: 'clock', subsystem: 'core', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'iclock', component: 'clock', methods: [{ name: 'tick', description: 'Tick.', params: [{ name: 'n', type: 'int' }], returns: 'void' }, { name: 'tock', description: 'Tock.', params: [{ name: 'n', type: 'int' }], returns: 'void' }] }],
      implementations: [{ id: 'clock_impl', contract: 'iclock', sourcePath: 'src/clock.ts', methods: [{ name: 'tick', narrative: [] }, { name: 'tock', narrative: [] }] }],
    });
    bind(dir);
    const unwritten = renameMethod('clock', 'tick', 'advance');
    expect(unwritten.pinnedSymbol).toBeUndefined();
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'clock.ts'), 'export function tock(n: number) { return n; }\n');
    bind(dir);
    expect(renameMethod('clock', 'tock', 'settle').pinnedSymbol).toBe('tock');
  });

  it('injectedParams restated replaces what is stored', () => {
    const dir = project(scratch('inject'), {
      subsystems: [{ id: 'web', status: 'complete' }],
      components: [{ id: 'web_flow', subsystem: 'web', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'iweb_flow', component: 'web_flow', methods: [{ name: 'run', description: 'Run.', params: [{ name: 'code', type: 'string' }], returns: 'void' }] }],
      implementations: [{ id: 'web_flow_impl', contract: 'iweb_flow', injectedParams: ['_ctx', 'req', 'res'], methods: [{ name: 'run', narrative: [] }] }],
    });
    bind(dir);
    updateSpecGated('implementation', 'web_flow_impl', { injectedParams: ['ctx', 'req', 'res'] });
    bind(dir);
    expect(scanAllSpecs().implementations.find((i) => i.id === 'web_flow_impl')?.injectedParams).toEqual(['ctx', 'req', 'res']);
    updateSpecGated('implementation', 'web_flow_impl', { injectedParams: ['ctx', 'res'] });
    bind(dir);
    expect(scanAllSpecs().implementations.find((i) => i.id === 'web_flow_impl')?.injectedParams).toEqual(['ctx', 'res']);
    // A removal marker still merges.
    updateSpecGated('implementation', 'web_flow_impl', { injectedParams: [{ value: 'ctx', action: 'delete' }] });
    bind(dir);
    expect(scanAllSpecs().implementations.find((i) => i.id === 'web_flow_impl')?.injectedParams).toEqual(['res']);
  });

  it('attach of an alias already attached says so instead of an empty plan', () => {
    const { app } = routePlanner(scratch('attach'));
    const planned = plan(app, { verb: 'attach', alias: 'geo', path: 'libs/geo' });
    expect(planned.edits).toEqual([]);
    expect(planned.notes.join('\n')).toMatch(/"geo" is already attached/);
  });
});

describe('item 8 (platform, EDGE): internalize de-aliases every type position, generics and returns included', () => {
  it('list<alias::x>, alias::x? and a returns lose the dead alias; the result has no EXTERNAL_UNDECLARED', () => {
    const base = scratch('internalize');
    const shop = project(path.join(base, 'shop'), {
      system: { name: 'shop', vision: 'A shop.', targetLanguage: 'TypeScript' },
      subsystems: [{ id: 'orders', status: 'complete' }],
      components: [{ id: 'order_flow', subsystem: 'orders', componentType: 'Orchestrator', status: 'complete' }],
      interfaces: [{ id: 'iorder_flow', component: 'order_flow', methods: [
        { name: 'place', description: 'Place an order.', params: [{ name: 'customer', type: 'shared::customer_ref?' }, { name: 'lines', type: 'list<shared::order_line>' }], returns: 'async shared::order_line' },
        { name: 'byCustomer', description: 'Orders by customer.', params: [{ name: 'customer', type: 'shared::customer_ref' }], returns: 'map<string, shared::order_line>' },
      ] }],
      types: [{ id: 'basket', kind: 'value-object', subsystem: 'orders', fields: [{ name: 'lines', type: 'list<shared::order_line>' }, { name: 'owner', type: 'shared::customer_ref?' }] }],
    }, 'shop', { members: { shared: 'libs/contracts' } });
    project(path.join(shop, 'libs', 'contracts'), {
      system: {
        name: 'contracts', vision: 'Shared contracts.', targetLanguage: 'TypeScript',
        publicInterfaces: [{ from: 'contracts', typeDef: 'order_line', audience: 'project' }, { from: 'contracts', typeDef: 'customer_ref', audience: 'project' }],
      },
      subsystems: [{ id: 'contracts', status: 'complete', publicInterfaces: [{ typeDef: 'order_line', details: 'A line.' }, { typeDef: 'customer_ref', details: 'A customer.' }] }],
      types: [
        { id: 'order_line', kind: 'value-object', subsystem: 'contracts', fields: [{ name: 'sku', type: 'string' }] },
        { id: 'customer_ref', kind: 'value-object', subsystem: 'contracts', fields: [{ name: 'id', type: 'string' }] },
      ],
    }, 'contracts');
    migrate(shop, { verb: 'internalize', alias: 'shared', destination: { home: 'contracts' } });
    const text = specText(shop);
    expect(text).not.toMatch(/shared::/);
    bind(shop);
    const codes = validateProject().issues.map((i) => i.code);
    expect(codes).not.toContain('EXTERNAL_UNDECLARED');
    expect(codes).not.toContain('UNDEFINED_TYPE_REFERENCE');
  });
});
