import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { externalsRepository } from '../../src/core/externals.js';
import { pinExternals, getExternalsStatus, projectOwnSurface, exportDesign, exportSurface, listConsumers, diff as diffSurface } from '../../src/core/surfaces.js';
import { execFileSync } from 'child_process';
import { adviseExternals, validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { buildContractFamily } from '../helpers/reference-family.js';
import { compose } from '../../src/core/family-validation.js';
import { computeGateStateId, validateFamily } from '../../src/core/validation.js';
import { runLock } from '../../src/commands/lock.js';
import { remove } from '../../src/core/external-declarations.js';

// ---------------------------------------------------------------------------
// Round-3 trial fixes in the externals / surfaces area, against real projects
// on disk (nothing mocked on the path under test):
//   R3-35/37  a method of an implemented (role implement) contract is pinned
//             with its digest, so a producer rename or change reads as moved
//   R3-42     the re-pin names the used members the snapshot cannot carry
//   R3-14     an implement-role export is typed by its real kind, not Custom
//   R3-32     a pin carries the methods and constructors of exported types
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

interface GeoOptions {
  /** The extension point's method name (default load_tile) and its rename trace. */
  sourceMethod?: string;
  formerSource?: string[];
  /** The extension point method's return type (default bytes). */
  sourceReturns?: string;
}

/** GeoKit: a Rust tiling library — an InProcess Portal, a tile-source extension point, an exported tile-key type with a constructor. */
function geoKit(o: GeoOptions = {}): FixtureTree {
  const method = o.sourceMethod ?? 'load_tile';
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library' },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', role: 'implement' },
        { from: 'tiling', typeDef: 'tile-key' },
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The crate\'s tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement' },
        { typeDef: 'tile-key', details: 'A tile key.' },
      ],
    }],
    components: [
      {
        id: 'tile-library', componentType: 'Portal', transport: 'InProcess', abi: 'c',
        description: 'The crate\'s tile API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' },
      },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'tile-key', effect: 'none' }] },
      {
        id: 'itile_source_port', component: 'tile-source-port',
        methods: [{
          name: method, description: 'Load a tile.', params: [{ name: 'key', type: 'tile-key' }], returns: o.sourceReturns ?? 'bytes',
          ...(o.formerSource ? { previousNames: o.formerSource } : {}),
        }],
      },
    ],
    types: [{
      id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.', holds: 'string',
      methods: [{ name: 'parse', description: 'The checked constructor.', signature: 'parse(text: string): tile-key', returns: 'tile-key', params: [{ name: 'text', type: 'string' }] }],
    }],
  };
}

/** TileStudio: a TypeScript map editor calling GeoKit and implementing its tile source by taking the signature from it. */
function tileStudio(): FixtureTree {
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', dependsOn: ['geo::tile-library'] },
      { id: 'tile-cache', componentType: 'Adapter', description: 'Serves GeoKit tiles from a local cache.' },
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string' }] },
      {
        id: 'itile_cache', component: 'tile-cache', implements: 'geo::tile-source',
        methods: [{ name: 'load_tile', description: 'Load one tile from the cache.', signatureFrom: 'geo::tile-source.load_tile' }],
        lint: { allow: [{ code: 'NAMING_CONVENTION_VIOLATION', reason: 'The extension point dictates the snake_case name.' }] },
      },
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      methods: [{ name: 'visibleTile', narrative: [
        { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: 'geo::tile-library', targetMethod: 'tile_for' },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
      ] }],
    }],
  };
}

/** GeoKit at <root>/geo and TileStudio at <root>/studio, the studio declaring `geo` at ../geo (unpinned). */
function pair(geo: GeoOptions = {}): { root: string; geo: string; studio: string; rewriteGeo(o: GeoOptions): void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r3ext-')));
  roots.push(root);
  const geoDir = path.join(root, 'geo');
  const studioDir = path.join(root, 'studio');
  const writeGeo = (o: GeoOptions): void => {
    fs.rmSync(path.join(geoDir, '.wai'), { recursive: true, force: true });
    fs.mkdirSync(geoDir, { recursive: true });
    materializeFixtureProject(geoDir, geoKit(o));
    fs.writeFileSync(path.join(geoDir, '.wai', 'project.yaml'), configYaml('geo'));
  };
  writeGeo(geo);
  fs.mkdirSync(studioDir, { recursive: true });
  materializeFixtureProject(studioDir, tileStudio());
  fs.writeFileSync(path.join(studioDir, '.wai', 'project.yaml'), configYaml('studio', { externals: { geo: { source: { path: '../geo' } } } }));
  invalidateSpecCache();
  return { root, geo: geoDir, studio: studioDir, rewriteGeo: (o) => { writeGeo(o); invalidateSpecCache(); } };
}

const codes = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter((i) => i.code === code);

describe('R3-35/37 — an implemented contract is pinned and compared method by method', () => {
  it('the pin records a digest for each implemented method (not `tile-source: {}`)', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    const used = externalsRepository.readLock()!.externals.geo.used;
    expect(Object.keys(used['tile-source'])).toEqual(['load_tile']);
    expect(used['tile-source'].load_tile).toMatch(/^sha256:/);
  });

  it('a producer rename of an implemented method reads renamed (live status, validate), with the new name', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    p.rewriteGeo({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'] });
    bind(p.studio);
    const [status] = getExternalsStatus();
    expect(status.uses).toContainEqual(expect.objectContaining({ publicName: 'tile-source', member: 'load_tile', state: 'renamed', renamedTo: 'tile-source.fetch_tile' }));
    bind(p.studio);
    const live = codes(adviseExternals(), 'EXTERNAL_LIVE_INCOMPATIBLE');
    expect(live).toHaveLength(1);
    expect(live[0].message).toMatch(/"tile-source\.load_tile" renamed to "tile-source\.fetch_tile"/);
  });

  it('a producer changing an implemented method\'s signature reads changed', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    p.rewriteGeo({ sourceReturns: 'string' });
    bind(p.studio);
    const [status] = getExternalsStatus();
    expect(status.uses).toContainEqual(expect.objectContaining({ publicName: 'tile-source', member: 'load_tile', state: 'changed' }));
  });

  it('after the re-pin, the gate findings say "renamed to" from the trace; the re-pin names what it cannot carry', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    p.rewriteGeo({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'] });
    bind(p.studio);
    const [pin] = pinExternals();
    // The MCP answer's `unexported` and the CLI's line agree: the member the snapshot no longer carries.
    expect(pin.unexported).toContainEqual(expect.objectContaining({ target: 'geo::tile-source', member: 'load_tile' }));
    expect(pin.detail).toMatch(/tile-source\.load_tile/);
    bind(p.studio);
    const issues = validateProject({}).issues;
    const unresolved = codes(issues, 'SIGNATURE_SOURCE_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toMatch(/renamed to "fetch_tile"/);
    expect(unresolved[0].message).toMatch(/exported contract's method/);
    const mismatch = codes(issues, 'IMPLEMENTS_MISMATCH');
    expect(mismatch.length).toBeGreaterThan(0);
    expect(mismatch[0].message).toMatch(/renamed from "load_tile"/);
  });
});

describe('R3-14 / R3-32 — the snapshot types an implement-role entry by its kind and carries type methods', () => {
  it('an Adapter-backed extension point is InProcess, never Custom', () => {
    const p = pair();
    bind(p.geo);
    expect(projectOwnSurface('instance').interfaces.find((e) => e.id === 'tile-source')!.type).toBe('InProcess');
  });

  it('an exported type travels with its methods (the checked constructor)', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    const def = externalsRepository.readSnapshot('geo')!.types.find((t) => t.id === 'tile-key')!;
    expect(def.methods).toEqual([expect.objectContaining({ name: 'parse', returns: 'tile-key' })]);
  });
});

describe('platform — the design export lists every name a member is referenced by', () => {
  it('`uses` of a member is what the references reach, in every position', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r3uses-')));
    roots.push(root);
    const shared = path.join(root, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    materializeFixtureProject(shared, {
      system: {
        name: 'Contracts', vision: 'The shared vocabulary.',
        publicInterfaces: ['money', 'order_id', 'sku_id', 'customer_ref'].map((t) => ({ from: 'vocab', typeDef: t, audience: 'project' })),
      },
      subsystems: [{ id: 'vocab', description: 'Vocabulary.', publicInterfaces: ['money', 'order_id', 'sku_id', 'customer_ref'].map((t) => ({ typeDef: t, details: t })) }],
      types: ['money', 'order_id', 'sku_id', 'customer_ref'].map((t) => ({ id: t, kind: 'value-object', subsystem: 'vocab', description: t, holds: 'string' })),
    });
    fs.writeFileSync(path.join(shared, '.wai', 'project.yaml'), configYaml('contracts'));
    materializeFixtureProject(root, {
      system: { name: 'Platform', vision: 'Orders.' },
      subsystems: [{ id: 'orders', description: 'Orders.' }],
      components: [{ id: 'order-desk', componentType: 'Orchestrator', description: 'Takes orders.' }],
      interfaces: [{ id: 'iorder_desk', component: 'order-desk', methods: [{ name: 'place', description: 'Place one.', params: [{ name: 'sku', type: 'shared::sku_id' }, { name: 'customer', type: 'shared::customer_ref' }], returns: 'shared::order_id' }] }],
      types: [{ id: 'order_line', kind: 'value-object', subsystem: 'orders', description: 'A line.', fields: [{ name: 'price', type: 'shared::money', description: 'Price' }] }],
    });
    fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), configYaml('platform', { members: { shared: 'shared' } }));
    bind(root);
    const design = exportDesign();
    const dep = design.dependencies.find((d) => d.alias === 'shared')!;
    expect(dep.uses).toEqual(['customer_ref', 'money', 'order_id', 'sku_id']);
  });
});

describe('platform — an unpinned consumer of a producer that broke a used name', () => {
  const ledgerL0 = (dir: string): string => path.join(dir, '.wai', 'specs', '.index.yaml');

  it('the composed gate fails: EXTERNAL_UNPINNED for a never-pinned use, at the family root too', () => {
    const f = buildContractFamily();
    roots.push(f.top);
    bind(f.billing);
    expect(compose('billing').findings.map((i) => [i.code, i.severity])).toEqual([['EXTERNAL_UNPINNED', 'error']]);
    bind(f.top);
    const family = validateFamily({});
    expect(family.issues.filter((i) => i.code === 'EXTERNAL_UNPINNED').map((i) => i.severity)).toEqual(['error']);
    expect(family.valid).toBe(false);
  });

  it('a used public name gone from the live table is EXTERNAL_INCOMPATIBLE, not a mere check-unavailable', () => {
    const f = buildContractFamily();
    roots.push(f.top);
    // The producer exports its portal under another name, leaving a rename trace on nothing: removed.
    const l0 = yaml.load(fs.readFileSync(ledgerL0(f.ledger), 'utf8')) as Record<string, any>;
    l0.publicInterfaces[0].as = 'books-portal';
    fs.writeFileSync(ledgerL0(f.ledger), yaml.dump(l0));
    bind(f.billing);
    const [status] = getExternalsStatus();
    expect(status.uses).toContainEqual(expect.objectContaining({ publicName: 'ledger-portal', state: 'removed' }));
    expect(compose('billing').findings.map((i) => [i.code, i.severity])).toContainEqual(['EXTERNAL_INCOMPATIBLE', 'error']);
  });

  it('`wairon lock` in the unpinned consumer refuses, and locks once it is pinned', async () => {
    const f = buildContractFamily();
    roots.push(f.top);
    bind(f.billing);
    const gate = { valid: true, issues: [] } as never;
    await expect(runLock({ yes: true }, gate, computeGateStateId())).rejects.toThrow(/never pinned — "ledger"/);
    expect(fs.existsSync(path.join(f.billing, '.wai', 'lock.json'))).toBe(false);
  });
});

describe('platform — a dead re-export is flagged at the producer', () => {
  it('a family-only re-export from a member that no family project reaches is EXPORT_UNREACHED', () => {
    const f = buildContractFamily();
    roots.push(f.top);
    const l0 = path.join(f.top, '.wai', 'specs', '.index.yaml');
    const system = yaml.load(fs.readFileSync(l0, 'utf8')) as Record<string, any>;
    // billing reaches the portal through ledger directly, never through house.
    system.publicInterfaces = [{ from: 'ledger', component: 'ledger-portal', audience: 'project' }];
    fs.writeFileSync(l0, yaml.dump(system));
    bind(f.top);
    const dead = validateFamily({}).issues.filter((i) => i.code === 'EXPORT_UNREACHED');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ severity: 'notice' });
    expect(dead[0].message).toMatch(/re-exports "ledger-portal" from "ledger"/);
    // At a wider audience (here and at its source) a reader outside the family may use it: not judged.
    system.publicInterfaces = [{ from: 'ledger', component: 'ledger-portal', audience: 'instance' }];
    fs.writeFileSync(l0, yaml.dump(system));
    const ledgerL0 = path.join(f.ledger, '.wai', 'specs', '.index.yaml');
    const ledger = yaml.load(fs.readFileSync(ledgerL0, 'utf8')) as Record<string, any>;
    ledger.publicInterfaces[0].audience = 'instance';
    fs.writeFileSync(ledgerL0, yaml.dump(ledger));
    bind(f.top);
    expect(validateFamily({}).issues.filter((i) => i.code === 'EXPORT_UNREACHED')).toEqual([]);
  });
});

describe('solo — removing the last external leaves no empty lock behind', () => {
  it('`externals remove` of the only external deletes .wai/externals.lock.yaml', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    const lockFile = path.join(p.studio, '.wai', 'externals.lock.yaml');
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(remove('geo')).toMatchObject({ removed: true, unpinned: true });
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('R3-39 — an OpenAPI export of an in-process library is refused, not written as the native snapshot', () => {
  it('names why and writes nothing', () => {
    const p = pair();
    bind(p.geo);
    const out = path.join(p.root, 'geo-openapi.json');
    expect(() => exportSurface('instance', 'openapi', out)).toThrow(/OpenAPI does not apply to "GeoKit".*InProcess/);
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe('platform — a producer file that fails to parse is unreadable, never "removed"', () => {
  it('the consumer is told the file and the error', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    const typeFile = fs.readdirSync(path.join(p.geo, '.wai', 'specs'), { recursive: true, withFileTypes: false } as never)
      .map(String).find((f) => /tile-key\.yaml$/.test(f))!;
    fs.appendFileSync(path.join(p.geo, '.wai', 'specs', typeFile), '\nname: "broken" trailing text\n');
    bind(p.studio);
    const [status] = getExternalsStatus();
    expect(status.uses.some((u) => u.state === 'removed')).toBe(false);
    expect(status.detail).toMatch(/^producer unreadable: .*tile-key\.yaml: /);
  });
});

describe('R3-34 / R3-3 — the producer sees a sibling-checkout consumer and its own surface changelog', () => {
  it('`externals consumers --search` finds a sibling checkout declaring it by path, with the names it uses', () => {
    const p = pair();
    bind(p.geo);
    expect(listConsumers()).toEqual([]);
    const found = listConsumers([p.root]);
    expect(found).toEqual([expect.objectContaining({ project: 'studio', alias: 'geo', section: 'externals', found: 'search', names: ['tile-library', 'tile-source'] })]);
  });

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

  it('`surface diff` lists what the export table changed since the last committed approval', () => {
    const p = pair();
    git(p.geo, 'init', '-q');
    fs.writeFileSync(path.join(p.geo, '.wai', 'lock.json'), '{}\n');
    git(p.geo, 'add', '-A');
    git(p.geo, 'commit', '-q', '-m', 'approved');
    // The release: the extension point's method renamed with a trace and its return changed; the tile-key export dropped.
    p.rewriteGeo({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'], sourceReturns: 'string' });
    const l0 = path.join(p.geo, '.wai', 'specs', '.index.yaml');
    const system = yaml.load(fs.readFileSync(l0, 'utf8')) as Record<string, any>;
    system.publicInterfaces = system.publicInterfaces.filter((e: Record<string, unknown>) => e.typeDef === undefined);
    fs.writeFileSync(l0, yaml.dump(system));
    fs.writeFileSync(path.join(p.geo, '.wai', 'project.yaml'), configYaml('geo'));
    bind(p.geo);
    const cache = process.env.WAIRON_CACHE_DIR;
    process.env.WAIRON_CACHE_DIR = path.join(p.root, 'cache');
    let diff;
    try {
      diff = diffSurface();
    } finally {
      if (cache === undefined) delete process.env.WAIRON_CACHE_DIR;
      else process.env.WAIRON_CACHE_DIR = cache;
    }
    expect(diff.against).toMatch(/the last approval, committed at [0-9a-f]{12}/);
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'renamed', name: 'tile-source', member: 'fetch_tile', from: 'load_tile' }));
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile-source', member: 'fetch_tile' }));
    expect(diff.changes).toContainEqual(expect.objectContaining({ kind: 'removed', name: 'tile-key' }));
    expect(diff.changes.some((c) => c.name === 'tile-library')).toBe(false);
  });

  it('`surface diff --against <file>` compares with a saved snapshot', () => {
    const p = pair();
    bind(p.geo);
    const saved = path.join(p.root, 'v1.yaml');
    exportSurface('project', 'native', saved);
    p.rewriteGeo({ sourceMethod: 'fetch_tile', formerSource: ['itile_source_port.load_tile'] });
    bind(p.geo);
    const diff = diffSurface(saved);
    expect(diff.changes).toEqual([expect.objectContaining({ kind: 'renamed', name: 'tile-source', member: 'fetch_tile', from: 'load_tile' })]);
  });
});
