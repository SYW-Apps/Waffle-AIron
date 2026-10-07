import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, resolveProjectExports } from '../../src/core/specs.js';
import { externalsRepository } from '../../src/core/externals.js';
import { pinExternals, getExternalsStatus, listExternals, projectOwnSurface, listConsumers } from '../../src/core/surfaces.js';
import { declare, remove, updateUse } from '../../src/core/external-declarations.js';
import { compose } from '../../src/core/family-validation.js';
import { validateProject, type ValidationIssue } from '../../src/core/validation.js';
import { exportDesign } from '../../src/core/surfaces.js';
import { followProducerRenames } from '../../src/core/exports.js';
import { relationHealth, carriedFactChanges, type ResolvedExportTable } from '../../src/models/index.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';
import { buildContractFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Round-2 trial fixes in the externals / surfaces area, against real projects
// on disk (nothing mocked on the path under test):
//   R2-30  a re-pin refreshes a snapshot whose only change is a carried fact
//          (the producer adds `abi: c`), and status never says ok for a stale one
//   audience  a refusal names the audience; a department export is noted
//   R2-22/23/53  implements compares types semantically; `use` is changed by a
//          command; a cross-project signatureFrom resolves
//   R2-29 + platform  `externals remove`, a malformed source, a dry run that reads the producer
//   platform  an unpinned family use the live producer broke is incompatible
//   R2-10  a library export is InProcess, never Custom
//   platform  renames through a re-export, did-you-mean, the true unresolved reason
//   R2-46  a producer sees its consumers
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows locks */ }
  }
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
  abi?: string;
  audience?: string;
  /** previousIds of the tile library component (a rename trace). */
  formerTiles?: string[];
}

/** GeoKit: a Rust tiling library — an InProcess Portal, a tile-source extension point, an exported tile-key type. */
function geoKit(o: GeoOptions = {}): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library', ...(o.audience ? { audience: o.audience } : {}) },
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
        id: 'tile-library', componentType: 'Portal', transport: 'InProcess', ...(o.abi ? { abi: o.abi } : {}),
        description: 'The crate\'s tile API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' },
        ...(o.formerTiles ? { previousIds: o.formerTiles } : {}),
      },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'tile-key', effect: 'none' }] },
      { id: 'itile_source_port', component: 'tile-source-port', methods: [{ name: 'load_tile', description: 'Load a tile.', params: [{ name: 'key', type: 'tile-key' }], returns: 'bytes' }] },
    ],
    types: [{ id: 'tile-key', kind: 'value-object', subsystem: 'tiling', description: 'A tile key.', holds: 'string' }],
  };
}

interface StudioOptions {
  /** How the tile cache's load_tile names the key type. */
  keyType?: string;
  /** The tile cache takes load_tile's signature from GeoKit's extension point instead of stating it. */
  signatureFrom?: boolean;
  /** The external declaration (default: geo at ../geo). */
  externals?: Record<string, unknown>;
  /** What the renderer depends on (default geo::tile-library). */
  rendererTarget?: string;
}

/** TileStudio: a TypeScript map editor calling GeoKit and implementing its tile source. */
function tileStudio(o: StudioOptions = {}): FixtureTree {
  const target = o.rendererTarget ?? 'geo::tile-library';
  return {
    system: { name: 'TileStudio', vision: 'A map editor that renders tiles computed by GeoKit.', targetLanguage: 'TypeScript' },
    subsystems: [{ id: 'editor', description: 'The map editing canvas.' }],
    components: [
      { id: 'map-renderer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Works out which tiles the map needs.', dependsOn: [target] },
      { id: 'tile-cache', componentType: 'Adapter', description: 'Serves GeoKit tiles from a local cache.' },
    ],
    interfaces: [
      { id: 'imap_renderer', component: 'map-renderer', methods: [{ name: 'visibleTile', description: 'The tile the map centre needs.', params: [{ name: 'zoom', type: 'int' }], returns: 'string' }] },
      {
        id: 'itile_cache', component: 'tile-cache', implements: 'geo::tile-source',
        methods: [o.signatureFrom
          ? { name: 'load_tile', description: 'Load one tile from the cache.', signatureFrom: 'geo::tile-source.load_tile' }
          : { name: 'load_tile', description: 'Load one tile from the cache.', params: [{ name: 'key', type: o.keyType ?? 'geo::tile-key' }], returns: 'bytes' }],
        lint: { allow: [{ code: 'NAMING_CONVENTION_VIOLATION', reason: 'The extension point dictates the snake_case name.' }] },
      },
    ],
    implementations: [{
      id: 'map_renderer_impl', contract: 'imap_renderer',
      methods: [{ name: 'visibleTile', narrative: [
        { stepNumber: 1, type: 'call', description: 'Ask GeoKit for the tile key.', targetComponent: target, targetMethod: 'tile_for' },
        { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the tile key' },
      ] }],
    }],
  };
}

/** GeoKit at <root>/geo and TileStudio at <root>/studio, the studio declaring `geo` at ../geo (unpinned). */
function pair(geo: GeoOptions = {}, studio: StudioOptions = {}): { root: string; geo: string; studio: string; rewriteGeo(o: GeoOptions): void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r2ext-')));
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
  materializeFixtureProject(studioDir, tileStudio(studio));
  fs.writeFileSync(path.join(studioDir, '.wai', 'project.yaml'), configYaml('studio', { externals: studio.externals ?? { geo: { source: { path: '../geo' } } } }));
  invalidateSpecCache();
  return { root, geo: geoDir, studio: studioDir, rewriteGeo: (o) => { writeGeo(o); invalidateSpecCache(); } };
}

const codes = (issues: ValidationIssue[], code: string): ValidationIssue[] => issues.filter((i) => i.code === code);

function studioConfig(dir: string): Record<string, any> {
  return yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as Record<string, any>;
}

describe('R2-30 — a re-pin refreshes every carried fact, and a stale snapshot is never ok', () => {
  it('the producer adds `abi: c`: status says drifted (stale abi), the re-pin rewrites the snapshot, the bridge error clears', () => {
    const p = pair();
    bind(p.studio);
    expect(pinExternals()[0].outcome).toBe('pinned');
    expect(codes(validateProject({}).issues, 'LANGUAGE_BRIDGE_MISSING')).toHaveLength(1);

    // The producer declares the abi the bridge rule asks for — no signature moves.
    p.rewriteGeo({ abi: 'c' });
    bind(p.studio);
    const before = externalsRepository.readLock()!.externals.geo.digest;
    const [status] = getExternalsStatus();
    expect(status.staleFacts).toContain('abi of tile-library');
    expect(relationHealth(status)).toBe('drifted');

    // Old code answered `unchanged` and kept the abi-less snapshot.
    const [pin] = pinExternals();
    expect(pin.outcome).toBe('pinned');
    expect(pin.digest).toBe(before);
    expect(externalsRepository.readSnapshot('geo')!.interfaces.find((e) => e.id === 'tile-library')!.abi).toBe('c');
    bind(p.studio);
    expect(codes(validateProject({}).issues, 'LANGUAGE_BRIDGE_MISSING')).toEqual([]);
    const [after] = getExternalsStatus();
    expect(after.staleFacts).toBeUndefined();
    expect(relationHealth(after)).toBe('ok');
    // And now nothing moved: unchanged.
    expect(pinExternals()[0].outcome).toBe('unchanged');
  });

  it('carriedFactChanges names each carried fact where it sits, and ignores prose', () => {
    const p = pair();
    bind(p.geo);
    const live = projectOwnSurface('instance');
    const pinned = { ...live, targetLanguage: undefined, interfaces: live.interfaces.map((e) => ({ ...e, details: 'other prose', role: undefined })) };
    expect(carriedFactChanges(pinned, live)).toEqual(['targetLanguage', 'role of tile-source']);
  });
});

describe('R2-10 — a library export is InProcess, never Custom', () => {
  it('the snapshot and the design export carry the real kind', () => {
    const p = pair();
    bind(p.geo);
    expect(projectOwnSurface('instance').interfaces.find((e) => e.id === 'tile-library')).toMatchObject({ type: 'InProcess', transport: 'InProcess' });
    expect(resolveProjectExports().entries.find((e) => e.publicName === 'tile-library')!.type).toBe('InProcess');
    const design = exportDesign();
    expect(JSON.stringify(design.project)).not.toMatch(/"type":"Custom"/);
  });
});

describe('export audiences', () => {
  it('a refusal names the audience, this project\'s and the ranking; the dry run reads the producer too', () => {
    const p = pair({ audience: 'department' }, { externals: {} });
    bind(p.studio);
    for (const dryRun of [true, false]) {
      const answer = declare({ alias: 'geo', source: '../geo', use: ['tile-library'], ...(dryRun ? { dryRun } : {}) });
      expect(answer.refusal).toMatch(/exports "tile-library" to `department` only/);
      expect(answer.refusal).toMatch(/reads the producer at `instance`/);
      expect(answer.refusal).toMatch(/project < department < instance < partner < external/);
      expect(studioConfig(p.studio).externals ?? {}).toEqual({});
    }
    // A name that does not exist at all still gets the closest names.
    expect(declare({ alias: 'geo', source: '../geo', use: ['tile-sauce'], dryRun: true }).refusal).toMatch(/closest: "tile-source"/);
  });

  it('the producer is noted for a department export (EXPORT_AUDIENCE_NARROW), never failed', () => {
    const p = pair({ audience: 'department' });
    bind(p.geo);
    const res = validateProject({});
    const notes = codes(res.issues, 'EXPORT_AUDIENCE_NARROW');
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe('notice');
    expect(notes[0].message).toMatch(/cannot be told from this tree/);
    bind(pair().geo);
    expect(codes(validateProject({}).issues, 'EXPORT_AUDIENCE_NARROW')).toEqual([]);
  });
});

describe('implementing an exported trait (R2-22, R2-23, R2-53)', () => {
  it('IMPLEMENTS_MISMATCH reads `geo::tile-key` and the producer\'s bare `tile-key` as one type', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    bind(p.studio);
    expect(codes(validateProject({}).issues, 'IMPLEMENTS_MISMATCH')).toEqual([]);
  });

  it('a different type still mismatches', () => {
    const p = pair({}, { keyType: 'string' });
    bind(p.studio);
    pinExternals();
    bind(p.studio);
    expect(codes(validateProject({}).issues, 'IMPLEMENTS_MISMATCH')).toHaveLength(1);
  });

  it('a cross-project signatureFrom resolves from the pin, spelled as the referrer writes it', () => {
    const p = pair({}, { signatureFrom: true });
    bind(p.studio);
    pinExternals();
    bind(p.studio);
    const issues = validateProject({}).issues;
    expect(codes(issues, 'SIGNATURE_SOURCE_UNRESOLVED')).toEqual([]);
    expect(codes(issues, 'SIGNATURE_SOURCE_OFF_EDGE')).toEqual([]);
    expect(codes(issues, 'IMPLEMENTS_MISMATCH')).toEqual([]);
  });

  it('`externals use` adds and removes imports without a hand edit, refusing an unexported name', () => {
    const p = pair();
    bind(p.studio);
    expect(updateUse({ alias: 'geo', add: ['tile-key', 'tile-source'] })).toMatchObject({ written: true, use: ['tile-key', 'tile-source'], added: ['tile-key', 'tile-source'] });
    expect(studioConfig(p.studio).externals.geo.use).toEqual(['tile-key', 'tile-source']);
    expect(updateUse({ alias: 'geo', remove: ['tile-source'], dryRun: true })).toMatchObject({ written: false, use: ['tile-key'] });
    expect(studioConfig(p.studio).externals.geo.use).toEqual(['tile-key', 'tile-source']);
    expect(updateUse({ alias: 'geo', remove: ['tile-source'] })).toMatchObject({ written: true, use: ['tile-key'], removed: ['tile-source'] });
    expect(studioConfig(p.studio).externals.geo).toEqual({ source: { path: '../geo' }, use: ['tile-key'] });
    expect(updateUse({ alias: 'geo', add: ['tiles-libary'] }).refusal).toMatch(/closest: "tile-library"/);
    expect(updateUse({ alias: 'nope', add: ['x'] }).refusal).toMatch(/not a declared external/);
  });
});

describe('`externals remove`, malformed sources and the dry run (R2-29, platform)', () => {
  it('removes the declaration and its pin together, and an orphaned pin alone', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    // A dry run answers what the real run then does (platform R4: it said removed: false).
    expect(remove('geo', true)).toEqual({ alias: 'geo', removed: true, unpinned: true });
    expect(remove('geo')).toEqual({ alias: 'geo', removed: true, unpinned: true });
    expect(studioConfig(p.studio).externals).toBeUndefined();
    expect(externalsRepository.readSnapshot('geo')).toBeNull();
    expect(externalsRepository.readLock()?.externals.geo).toBeUndefined();
    expect(remove('geo').refusal).toMatch(/neither declared nor pinned/);
  });

  it('lists an orphaned pin, and removes it', () => {
    const p = pair();
    bind(p.studio);
    pinExternals();
    // The declaration deleted by hand: the pin stays behind.
    fs.writeFileSync(path.join(p.studio, '.wai', 'project.yaml'), configYaml('studio'));
    bind(p.studio);
    expect(listExternals()).toEqual([expect.objectContaining({ alias: 'geo', problem: expect.stringMatching(/pinned but no longer declared/) })]);
    expect(remove('geo')).toEqual({ alias: 'geo', removed: false, unpinned: true });
    expect(listExternals()).toEqual([]);
  });

  it('refuses a source that is no location, and a dry run with an unexported name writes nothing', () => {
    const p = pair({}, { externals: {} });
    bind(p.studio);
    expect(declare({ alias: 'bad', source: '{ path: ../x }' }).refusal).toMatch(/is not a location/);
    expect(declare({ alias: 'geo2', source: '../geo', project: 'geo', use: ['not_a_type'], dryRun: true }).refusal).toMatch(/does not export "not_a_type"/);
    expect(studioConfig(p.studio).externals ?? {}).toEqual({});
    // A producer that answers: the dry run says so, and writes nothing.
    const dry = declare({ alias: 'geo', source: '../geo', dryRun: true });
    expect(dry).toMatchObject({ written: false, project: 'geo' });
    expect(dry.unreachable).toBeUndefined();
    expect(declare({ alias: 'far', source: '../nowhere', dryRun: true }).unreachable).toMatch(/could not be read/);
  });
});

describe('renames, did-you-mean and the true reason (platform)', () => {
  it('EXTERNAL_NOT_EXPORTED follows the producer\'s rename trace', () => {
    const p = pair({ formerTiles: ['tile-lib'] }, { rendererTarget: 'geo::tile-lib' });
    bind(p.studio);
    pinExternals();
    bind(p.studio);
    const notExported = codes(validateProject({}).issues, 'EXTERNAL_NOT_EXPORTED');
    expect(notExported.length).toBeGreaterThan(0);
    expect(notExported[0].message).toMatch(/renamed to "tile-library".*did you mean "tile-library"\?/);
  });

  it('a re-export of a name its producer renamed is told the new name', () => {
    const table: ResolvedExportTable = {
      owner: 'Platform', level: 'project', entries: [],
      problems: [{ kind: 'invalid', owner: 'Platform', publicName: 'email_address', source: 'shared', detail: 're-exports "email_address" from the member "shared", whose export table has no such public name — another project is reached only through its L0 exports' }],
    };
    const producer: ResolvedExportTable = {
      owner: 'shared', level: 'project', problems: [],
      entries: [{ publicName: 'email', kind: 'type', source: 'contracts', typeDef: 'email', via: [] } as never],
    };
    followProducerRenames(table, (source) => (source === 'shared'
      ? { table: producer, specs: { components: [], interfaces: [], types: [{ id: 'email', previousIds: ['email_address'] }] } }
      : undefined));
    expect(table.problems[0]).toMatchObject({ renamedTo: 'email' });
    expect(table.problems[0].detail).toMatch(/did you mean "email"\?/);
  });

  it('EXTERNAL_UNRESOLVED gives the true reason for an unpinned family external at a member root', () => {
    const f = buildContractFamily();
    cleanups.push(() => f.cleanup());
    bind(f.billing);
    const unresolved = codes(validateProject({}).issues, 'EXTERNAL_UNRESOLVED');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].message).toMatch(/never climbed to/);
    expect(unresolved[0].message).toMatch(/wairon externals pin ledger/);
  });
});

describe('an unpinned family use the live producer broke (platform)', () => {
  it('composes as EXTERNAL_INCOMPATIBLE, not as a mere check-unavailable', () => {
    const f = buildContractFamily();
    cleanups.push(() => f.cleanup());
    // Never pinned; the producer renames the used verb away.
    f.setLedgerContract('record');
    bind(f.billing);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([expect.objectContaining({ publicName: 'ledger-portal', member: 'post', state: 'removed' })]);
    const composed = compose('billing').findings;
    expect(composed.map((i) => [i.code, i.severity])).toContainEqual(['EXTERNAL_INCOMPATIBLE', 'error']);
  });

  it('an unpinned use still present live fails the composed gate as EXTERNAL_UNPINNED (never a pass, never a false break)', () => {
    const f = buildContractFamily();
    cleanups.push(() => f.cleanup());
    bind(f.billing);
    const [status] = getExternalsStatus();
    expect(status.uses).toEqual([expect.objectContaining({ publicName: 'ledger-portal', state: 'unlocked' })]);
    // Round 3: a never-pinned use is no warning — the composed gate cannot tell what it was judged against.
    expect(compose('billing').findings.map((i) => i.code)).toEqual(['EXTERNAL_UNPINNED']);
  });
});

describe('a producer sees its consumers (R2-46)', () => {
  it('lists the family projects that consume it, with the names each uses', () => {
    const f = buildContractFamily();
    cleanups.push(() => f.cleanup());
    bind(f.ledger);
    const consumers = listConsumers();
    expect(consumers).toContainEqual(expect.objectContaining({ project: 'billing', alias: 'ledger', section: 'externals', names: ['ledger-portal'] }));
    expect(consumers).toContainEqual(expect.objectContaining({ project: 'house', alias: 'ledger', section: 'members', names: [] }));
    bind(f.billing);
    expect(listConsumers()).toContainEqual(expect.objectContaining({ project: 'house', section: 'members' }));
  });
});
