import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, loadTypeSpecs } from '../../src/core/specs.js';
import { pinExternals, getExternalsStatus, unrecordedUses } from '../../src/core/surfaces.js';
import { remove } from '../../src/core/external-declarations.js';
import { validateProject, validateFamily, computeGateStateId, familyApprovals, implementsProblem } from '../../src/core/validation.js';
import { runLock, checkApproval } from '../../src/commands/lock.js';
import { approvalVerdict, captureApprovedSpecs } from '../../src/core/approval.js';
import { writeLockRecord } from '../../src/core/lockfile.js';
import { updateSpecGated } from '../../src/core/authoring.js';
import * as migrations from '../../src/migrations/index.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { guideBody } from '../../src/utils/ai-guide.js';
import { explain } from '../../src/network/flow-matrix.js';
import { consumerReaches, surfaceChanges, type ExternalConsumer, type SurfaceSnapshot } from '../../src/models/index.js';
import type { ReachModel } from '../../src/models/reach.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { platformFamily } from '../helpers/network-family.js';

// ---------------------------------------------------------------------------
// Round-4 trial fixes in approval, migrations, externals/surfaces and
// MCP-vs-CLI parity, in process against real projects on disk (nothing mocked
// on the path under test). The black-box twins are in
// tests/e2e/trials-r4-approval.test.ts.
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

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `wairon-r4-${prefix}-`)));
  roots.push(dir);
  return dir;
}

function configYaml(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({
    schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES,
    extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS,
  }, { noRefs: true, lineWidth: 200 });
}

function project(dir: string, id: string, tree: FixtureTree, extra: Record<string, unknown> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  materializeFixtureProject(dir, tree);
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml(id, extra));
  return dir;
}

/** GeoKit: an InProcess Portal exported for calling, an extension point exported role implement, an exported type. */
function geoKit(o: { renamedType?: boolean } = {}): FixtureTree {
  const key = o.renamedType ? 'tile-id' : 'tile-key';
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library.', targetLanguage: 'TypeScript',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library' },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', role: 'implement' },
        { from: 'tiling', typeDef: key },
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement' },
        { typeDef: key, details: 'A tile key.' },
      ],
    }],
    components: [
      { id: 'tile-library', componentType: 'Portal', transport: 'InProcess', description: 'The tile API.', invokedBy: { kind: 'entry', caller: 'Applications that link the library and call it.' } },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port tiles load through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tileFor', description: 'The tile for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none' }] },
      { id: 'itile_source_port', component: 'tile-source-port', methods: [{ name: 'loadTile', description: 'Load a tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'bytes' }] },
    ],
    types: [{ id: key, kind: 'value-object', subsystem: 'tiling', description: 'A tile key.', holds: 'string', ...(o.renamedType ? { previousIds: ['tile-key'] } : {}) }],
  };
}

/** TileStudio: calls the library, names the exported type, and optionally implements something. */
function tileStudio(o: { usesGeo?: boolean; implementsRef?: string } = {}): FixtureTree {
  const uses = o.usesGeo ?? true;
  return {
    system: { name: 'TileStudio', vision: 'A map editor.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out the tiles.', ...(uses ? { dependsOn: ['geo::tile-library'] } : {}) },
      ...(o.implementsRef ? [{ id: 'tile-cache', componentType: 'Adapter', description: 'Serves tiles from a cache.' }] : []),
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The centre tile.', params: [{ name: 'key', type: uses ? 'geo::tile-key' : 'string' }], returns: 'string' }] },
      ...(o.implementsRef ? [{ id: 'itile_cache', component: 'tile-cache', implements: o.implementsRef, methods: [{ name: 'tileFor', description: 'Serve one tile.', params: [{ name: 'zoom', type: 'int' }], returns: 'string' }] }] : []),
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      methods: [{
        name: 'visibleTile', narrative: uses
          ? [{ stepNumber: 1, type: 'call', description: 'Ask the library.', targetComponent: 'geo::tile-library', targetMethod: 'tileFor' }]
          : [{ stepNumber: 1, type: 'return', description: 'Answer the centre tile.', outcome: 'the tile' }],
      }],
    }],
  };
}

/** Write an approval of the tree as it stands — what an earlier release's `wairon lock` recorded. */
function approveAsIs(projectId: string): void {
  writeLockRecord({
    stateId: (() => { const s = computeGateStateId(); return { algorithm: s.algorithm, digest: s.digest }; })(),
    lockedAt: TS, lockedBy: { name: 'trial', source: 'git' }, validatorVersion: 'test', status: 'ready',
    validationResult: { errors: 0, warnings: 0, notices: 0 }, projectId,
    specs: captureApprovedSpecs(), specsReading: 'design', format: 3,
  } as never);
}

// ---------------------------------------------------------------------------

describe('1 — the approval state agrees with lock-check after a project rename', () => {
  it('a renamed id makes the own entry drifted with what it owes; the verdict text never stops at "no spec has changed since."', () => {
    const dir = project(tmp('rename'), 'route-planner', tileStudio({ usesGeo: false }));
    bind(dir);
    approveAsIs('route-planner');
    expect(familyApprovals().find((a) => a.key === '')?.state).toBe('approved');
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('route-planner-v2', { previousIds: ['route-planner'] }));
    invalidateSpecCache();
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.owed).toContain('renamed since the approval (route-planner → route-planner-v2)');
    const verdict = approvalVerdict(familyApprovals());
    expect(verdict.drifted).toBe(true);
    expect(verdict.text).toContain('no spec has changed since. But the approval does not cover this project');
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('PROJECT_ID_RENAMED');
  });

  it('the PROJECT_ID_RENAMED notice names the new id where the new id belongs', () => {
    const dir = project(tmp('notice'), 'route-planner', tileStudio({ usesGeo: false }));
    bind(dir);
    approveAsIs('route-planner');
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), configYaml('route-planner-v2', { previousIds: ['route-planner'], name: 'route-planner' }));
    invalidateSpecCache();
    const notice = validateProject().issues.find((i) => i.code === 'PROJECT_ID_RENAMED');
    expect(notice?.message).toContain('Project "route-planner-v2" was renamed from "route-planner"');
  });
});

describe('2 — storage moves', () => {
  function habitly(): FixtureTree {
    return {
      system: { name: 'Habitly', vision: 'A habit tracker.' },
      subsystems: [{ id: 'habits', description: 'Habits.' }],
      components: [{ id: 'habit_store', componentType: 'Store', description: 'Holds the habits.' }],
      interfaces: [{ id: 'ihabit_store', component: 'habit_store', methods: [{ name: 'save', description: 'Save one.', signature: 'save(): void', returns: 'void' }] }],
      types: [{ id: 'habit', kind: 'value-object', subsystem: 'habits', description: 'A habit.', sourcePath: 'src/domain/habit.ts', fields: [{ name: 'title', type: 'string' }] }],
    };
  }

  it('a part\'s type paths, stored part-relative, read back relative to the project root — as an implementation\'s do', () => {
    const dir = project(tmp('part-types'), 'habitly', habitly());
    bind(dir);
    const report = migrations.apply(migrations.plan({ verb: 'externalize', subsystem: 'habits', path: 'services/habits' }));
    expect(report.applied).toBe(true);
    invalidateSpecCache();
    const stored = fs.readdirSync(path.join(dir, 'services', 'habits', '.wai', 'specs'), { recursive: true }).map(String).find((f) => f.endsWith('habit.yaml'))!;
    expect(fs.readFileSync(path.join(dir, 'services', 'habits', '.wai', 'specs', stored), 'utf8')).toContain('../../src/domain/habit.ts');
    expect(loadTypeSpecs().find((t) => t.id === 'habit' || t.id.endsWith('::habit'))?.sourcePath).toBe('src/domain/habit.ts');
    expect(validateProject().issues.filter((i) => i.code === 'SOURCE_PATH_ESCAPES_ROOT')).toEqual([]);
  });

  it('internalizing a part owes no re-lock when the approval still covers every spec', () => {
    const dir = project(tmp('internalize'), 'habitly', habitly());
    bind(dir);
    expect(migrations.apply(migrations.plan({ verb: 'externalize', subsystem: 'habits', path: 'services/habits' })).applied).toBe(true);
    invalidateSpecCache();
    approveAsIs('habitly');
    const planned = migrations.plan({ verb: 'internalize', alias: 'habits' });
    expect(planned.refusals).toEqual([]);
    // Round 4: the plan listed this project as one to re-lock.
    expect(planned.relock).toEqual([]);
    migrations.discard(planned);
  });
});

describe('3 — uses a pin does not record', () => {
  function pairWithZeroUsePin(): { geo: string; studio: string } {
    const folder = tmp('unrecorded');
    const geo = project(path.join(folder, 'geo'), 'geo', geoKit());
    const studio = project(path.join(folder, 'studio'), 'studio', tileStudio({ usesGeo: false }), { externals: { geo: { source: '../geo' } } });
    bind(studio);
    expect(pinExternals(['geo'])[0].outcome).toBe('pinned');
    // The references come after the pin, which records none of them.
    fs.rmSync(path.join(studio, '.wai', 'specs'), { recursive: true, force: true });
    materializeFixtureProject(path.join(folder, 'studio-new'), tileStudio());
    fs.renameSync(path.join(folder, 'studio-new', '.wai', 'specs'), path.join(studio, '.wai', 'specs'));
    invalidateSpecCache();
    return { geo, studio };
  }

  it('unrecordedUses names each used name and method the pin lacks', () => {
    pairWithZeroUsePin();
    expect(unrecordedUses()).toEqual({ geo: ['tile-key', 'tile-library.tileFor'] });
  });

  it('`wairon lock` refuses it as it refuses a never-pinned external, writing nothing', async () => {
    const { studio } = pairWithZeroUsePin();
    await expect(runLock({ yes: true }, { valid: true, issues: [] } as never, computeGateStateId())).rejects.toThrow(/used beyond their pin — "geo": tile-key, tile-library\.tileFor/);
    expect(fs.existsSync(path.join(studio, '.wai', 'lock.json'))).toBe(false);
  });

  it('an approval taken over it (an earlier release) fails lock-check and reads drifted, with the same reason', () => {
    pairWithZeroUsePin();
    approveAsIs('studio');
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.owed).toContain('external "geo" is used beyond its pin: tile-key, tile-library.tileFor');
    const check = checkApproval(false);
    // Round 4: "✔ The design in this tree is the approved design".
    expect(check.approved).toBe(false);
    expect(check.message).toContain('pin first (`wairon externals pin`), then run `wairon lock`');
  });
});

describe('4 — surface diff covers every fact a pin drifts by', () => {
  const snapshot = (o: { abi?: string; effect?: string; keyFields?: string[] }): SurfaceSnapshot => ({
    projectName: 'geo', projectId: 'geo', origin: 'generated', generatedAt: TS,
    interfaces: [{
      id: 'tile-library', component: 'tile-library', type: 'InProcess', audience: 'external', transport: 'InProcess',
      ...(o.abi ? { abi: o.abi } : {}),
      methods: [{ name: 'tileFor', description: 'd', signature: 'tileFor(zoom: int): tile-key', params: [{ name: 'zoom', type: 'int' }], returns: 'tile-key', ...(o.effect ? { effect: o.effect } : {}) }],
    }],
    types: [{ id: 'tile-key', kind: 'value-object', fields: (o.keyFields ?? ['x']).map((name) => ({ name, type: 'int' })) }],
    exportedTypes: [],
  } as unknown as SurfaceSnapshot);

  it('an abi or an effect change is a change; a closure type that changed shape is said as such, never as "signature A → A"', () => {
    const changes = surfaceChanges(snapshot({ abi: 'c', effect: 'io', keyFields: ['x', 'y'] }), snapshot({ effect: 'none' }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile-library', detail: 'abi none → c' }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile-library', member: 'tileFor', detail: 'effect none → io' }));
    const sig = changes.find((c) => c.member === 'tileFor' && c.detail.startsWith('signature'))!;
    expect(sig.detail).toBe('signature reads the same, but a type it names changed shape: "tile-key"');
  });

  it('control: identical snapshots, no change', () => {
    expect(surfaceChanges(snapshot({ abi: 'c' }), snapshot({ abi: 'c' }))).toEqual([]);
  });
});

describe('5 — method renames across projects', () => {
  it('INVALID_TARGET_METHOD_REFERENCE carries "renamed to" from the target\'s rename trace', () => {
    const dir = project(tmp('rename-hint'), 'shop', {
      system: { name: 'Shop', vision: 'A shop.' },
      subsystems: [{ id: 'orders', description: 'Orders.' }],
      components: [
        { id: 'order_flow', componentType: 'Orchestrator', dependsOn: ['order_store'] },
        { id: 'order_store', componentType: 'Store' },
      ],
      interfaces: [
        { id: 'iorder_flow', component: 'order_flow', methods: [{ name: 'place', description: 'Place one.', signature: 'place(): void', returns: 'void' }] },
        { id: 'iorder_store', component: 'order_store', methods: [{ name: 'insertOrder', description: 'Insert one.', signature: 'insertOrder(): void', returns: 'void', previousNames: ['iorder_store.saveOrder'] }] },
      ],
      implementations: [{ id: 'order_flow_impl', contract: 'iorder_flow', methods: [{ name: 'place', narrative: [{ stepNumber: 1, type: 'call', description: 'Save it.', targetComponent: 'order_store', targetMethod: 'saveOrder' }] }] }],
    });
    bind(dir);
    const issue = validateProject().issues.find((i) => i.code === 'INVALID_TARGET_METHOD_REFERENCE');
    expect(issue?.message).toContain('It was renamed to "insertOrder" (the rename trace of "order_store" records "saveOrder") — did you mean "insertOrder"?');
  });

  it('a consumer reaches a method only on a name that publishes it', () => {
    const consumer = { project: 'p', key: '', directory: '.', alias: 'o', section: 'members', names: ['orders'], uses: [{ publicName: 'orders', kind: 'component', members: ['create'] }] } as ExternalConsumer;
    expect(consumerReaches(consumer, ['orders'], 'create')).toBe(true);
    expect(consumerReaches(consumer, ['orders'], 'get')).toBe(false);
    expect(consumerReaches(consumer, ['billing'], 'create')).toBe(false);
  });

  it('sdd_rename_method dryRun names the consumers it breaks and writes nothing; sdd_list_consumers is method-granular', async () => {
    const root = tmp('mcp-rename');
    materializeFixtureProject(root, platformFamily());
    const orders = path.join(root, 'services', 'orders');
    bind(orders);
    const server = createMcpServer() as McpServer;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const spec = path.join(orders, '.wai', 'specs', 'interfaces', 'iorders_api.yaml');
    const before = fs.readFileSync(spec, 'utf8');
    const dry = await client.callTool({ name: 'sdd_rename_method', arguments: { id: 'orders_api', method: 'create', newName: 'placeOrder', dryRun: true } });
    expect(dry.isError).toBeFalsy();
    const report = JSON.parse((dry.content as { text: string }[])[0].text) as { dryRun?: boolean; breaks?: ExternalConsumer[]; publishedIn: string[] };
    expect(report.dryRun).toBe(true);
    expect(report.publishedIn).toContain('orders');
    expect(report.breaks?.map((c) => c.project)).toEqual(['platform']);
    expect(fs.readFileSync(spec, 'utf8')).toBe(before);
    const consumers = await client.callTool({ name: 'sdd_list_consumers', arguments: {} });
    expect((consumers.content as { text: string }[])[0].text).toContain('calls orders.create');
    const structured = consumers.structuredContent as { consumers: ExternalConsumer[] };
    expect(structured.consumers[0].uses).toContainEqual(expect.objectContaining({ publicName: 'orders', members: ['create'] }));
    await client.close();
  });
});

describe('6 — the family run at a member\'s root', () => {
  it('judges its network from the enclosing family, and every project count matches the findings listed under it', () => {
    const root = tmp('member-family');
    materializeFixtureProject(root, platformFamily());
    bind(path.join(root, 'services', 'orders'));
    const result = validateFamily({ family: true });
    expect(result.issues.filter((i) => i.code === 'ENTRY_SCOPE_UNBOUNDED')).toEqual([]);
    expect(result.issues.some((i) => i.code === 'ENTRY_UNPROVEN' && /orders_api\.create/.test(i.message))).toBe(false);
    for (const p of result.projects ?? []) {
      const mine = result.issues.filter((i) => (i.project ?? '') === p.key);
      expect(p.warnings).toBe(mine.filter((i) => i.severity === 'warning').length);
      expect(p.errors).toBe(mine.filter((i) => i.severity === 'error').length);
    }
  });

  it('sdd_validate_tree at the member says what `wairon validate` says: its network proofs are judged at the family root', async () => {
    const root = tmp('member-mcp');
    materializeFixtureProject(root, platformFamily());
    bind(path.join(root, 'services', 'orders'));
    const server = createMcpServer() as McpServer;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: 'sdd_validate_tree', arguments: { family: true } });
    const out = r.structuredContent as { hint?: string; warnings: { code: string }[]; notices: { code: string }[] };
    expect(out.hint).toContain('its network proofs are judged at the family root');
    expect(out.notices.some((n) => n.code === 'ENTRY_SCOPE_UNBOUNDED')).toBe(false);
    await client.close();
  });
});

describe('7 — network why reads a former id and a member\'s bare names', () => {
  const model = (o: Partial<ReachModel>): ReachModel => ({
    scope: 'family', networks: [], calls: [], placements: [], topics: [],
    verbs: [{ portal: 'orders_svc::orders_api', verb: 'create', project: 'orders_svc', transport: 'HTTP' }],
    ...o,
  } as unknown as ReachModel);

  it('a former id is read as the renamed project\'s, with a note at the head of the chain', () => {
    const answer = explain([], 'outside', 'orders::orders_api.create', model({ formerNames: { orders: 'orders_svc' } }));
    expect(answer.unknown).toBeUndefined();
    expect(answer.chain[0]).toContain('"orders::orders_api.create" names the renamed project "orders_svc" by its former name');
  });

  it('at a member\'s root its bare names are read under it; a real typo stays unknown', () => {
    expect(explain([], 'outside', 'orders_api.create', model({ focus: 'orders_svc' })).unknown).toBeUndefined();
    expect(explain([], 'outside', 'ordrs_api.create', model({ focus: 'orders_svc' })).unknown).toEqual(['ordrs_api.create']);
  });
});

describe('8 — implements, alias forms, dry runs, duplicated statuses', () => {
  function pinnedPair(studio: FixtureTree): { geo: string; studio: string } {
    const folder = tmp('pair');
    const geo = project(path.join(folder, 'geo'), 'geo', geoKit());
    const consumer = project(path.join(folder, 'studio'), 'studio', studio, { externals: { geo: { source: '../geo' } } });
    bind(consumer);
    expect(pinExternals(['geo'])[0].outcome).toBe('pinned');
    invalidateSpecCache();
    return { geo, studio: consumer };
  }

  it('implements of a call-role export is EXTERNAL_NOT_EXPORTED; of the extension point it is not', () => {
    pinnedPair(tileStudio({ implementsRef: 'geo::tile-library' }));
    const bad = validateProject().issues.filter((i) => i.code === 'EXTERNAL_NOT_EXPORTED' && i.specId === 'itile_cache');
    expect(bad).toHaveLength(1);
    expect(bad[0].message).toContain('exports for consumers to call (role call), not as an extension point');
    expect(implementsProblem('geo::tile-library')).toMatch(/^EXTERNAL_NOT_EXPORTED: "geo::tile-library" is exported for consumers to call/);
    expect(implementsProblem('geo::tile-source')).toBeNull();
    expect(implementsProblem('nope::thing')).toMatch(/^EXTERNAL_UNDECLARED/);
  });

  it('a dry run of `implements` reports what validate will say — before it is written', () => {
    pinnedPair(tileStudio({ implementsRef: 'geo::tile-source' }));
    const report = updateSpecGated('interface', 'itile_cache', { implements: 'geo::tile-library' }, true);
    expect(report.notices.some((n) => n.startsWith('EXTERNAL_NOT_EXPORTED: "geo::tile-library" is exported for consumers to call'))).toBe(true);
  });

  it('an undeclared alias is EXTERNAL_UNDECLARED alone — never a DEPRECATED_REFERENCE_FORM "member path"', () => {
    const dir = project(tmp('undeclared'), 'studio', tileStudio());
    bind(dir);
    const issues = validateProject().issues;
    expect(issues.some((i) => i.code === 'EXTERNAL_UNDECLARED')).toBe(true);
    expect(issues.filter((i) => i.code === 'DEPRECATED_REFERENCE_FORM')).toEqual([]);
  });

  it('`sdd_remove_external` dry run answers removed: true for a declared external, as the real run then does', () => {
    pinnedPair(tileStudio());
    const dry = remove('geo', true);
    expect(dry).toEqual({ alias: 'geo', removed: true, unpinned: true });
    expect(fs.existsSync(path.join(process.cwd(), 'never'))).toBe(false);
  });

  it('a renamed exported type is listed once in the externals status, not twice', () => {
    const { geo } = pinnedPair(tileStudio());
    fs.rmSync(path.join(geo, '.wai', 'specs'), { recursive: true, force: true });
    materializeFixtureProject(path.join(path.dirname(geo), 'geo-v2'), geoKit({ renamedType: true }));
    fs.renameSync(path.join(path.dirname(geo), 'geo-v2', '.wai', 'specs'), path.join(geo, '.wai', 'specs'));
    invalidateSpecCache();
    const status = getExternalsStatus().find((s) => s.alias === 'geo')!;
    const keyed = status.uses.filter((u) => u.publicName === 'tile-key');
    expect(keyed).toHaveLength(1);
    expect(keyed[0].state).toBe('renamed');
  });
});

describe('9 — the generated guide', () => {
  it('names every sdd_* tool the server registers, and says prose is design while linkage is not', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'mcp', 'server.ts'), 'utf8');
    const tools = [...new Set([...server.matchAll(/^\s+'(sdd_[a-z_]+)',\r?$/gm)].map((m) => m[1]))];
    expect(tools.length).toBeGreaterThan(40);
    const guide = guideBody('local');
    const missing = tools.filter((t) => !guide.includes(`\`${t}\``));
    expect(missing).toEqual([]);
    expect(guide).toContain('Prose is design; linkage is not');
  });
});
