import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readBindingModules, readDeclarations } from '../../src/core/binding-modules.js';

// ---------------------------------------------------------------------------
// binding_module_adapter: a hand-written binding module read by its syntax —
// the declarations binding conformance compares with a pinned snapshot.
// ---------------------------------------------------------------------------

const BINDING = [
  '// Thin typed binding for the geo-sdk native addon.',
  "import { createRequire } from 'node:module';",
  '',
  'export type Latitude = number;',
  '',
  'export interface TileCoord {',
  '  x: number;',
  '  y: number;',
  '  zoom: number;',
  '}',
  '',
  "export type PlaceKind = 'street' | 'city';",
  '',
  '/** geo::geocoding_provider — the trait the addon calls back into. */',
  'export interface GeocodingProvider {',
  '  forward(address: string): Promise<Coordinate[]>;',
  '  reverse(coordinate: Coordinate): Promise<Address | null>;',
  '}',
  '',
  '/** geo::tiles */',
  'export interface TilesApi {',
  '  tile_for_coordinate(coordinate: Coordinate, zoom: number): TileCoord;',
  '  tile_url(template: string, tile: TileCoord): string;',
  '  onTile: (tile: TileCoord, { signal }: Options) => void;',
  '  readonly label?: string;',
  '}',
  '',
  'export class GeoError extends Error {',
  '  constructor(readonly kind: string, message: string = kind) { super(message); }',
  '  describe(prefix: string): string { return `${prefix}: ${this.kind}`; }',
  '  private secret(x: number) { return x; }',
  '}',
  '',
  'export type Bounds = { north: number, south: Map<string, number> };',
  '',
  'export enum Unit { Meters = "m", Miles = "mi" }',
  '',
  'export function loadGeoSdk(addonPath: string = "geo", ...rest: string[]): unknown {',
  '  const req = createRequire("x"); // a } in a comment',
  '  return req(addonPath);',
  '}',
  '',
  'export declare function haversine_distance(from: Coordinate, to: Coordinate): number;',
].join('\n');

describe('binding module reader', () => {
  it('reads the exported functions, interfaces, classes, object types and enums with their members', () => {
    const decls = readDeclarations(BINDING);
    const byName = new Map(decls.map((d) => [d.name, d]));
    expect(byName.get('Latitude')).toMatchObject({ kind: 'alias', members: [] });
    expect(byName.get('TileCoord')).toMatchObject({ kind: 'interface', members: [{ name: 'x' }, { name: 'y' }, { name: 'zoom' }] });
    expect(byName.get('PlaceKind')?.kind).toBe('alias');
    expect(byName.get('GeocodingProvider')).toMatchObject({
      kind: 'interface',
      tag: 'geo::geocoding_provider',
      members: [{ name: 'forward', params: ['address'] }, { name: 'reverse', params: ['coordinate'] }],
    });
    expect(byName.get('TilesApi')).toMatchObject({
      tag: 'geo::tiles',
      members: [
        { name: 'tile_for_coordinate', params: ['coordinate', 'zoom'] },
        { name: 'tile_url', params: ['template', 'tile'] },
        { name: 'onTile', params: ['tile', ''] },
        { name: 'label' },
      ],
    });
    // A class: the constructor and private members are not its surface.
    expect(byName.get('GeoError')?.members).toEqual([{ name: 'describe', params: ['prefix'] }]);
    expect(byName.get('Bounds')).toMatchObject({ kind: 'type', members: [{ name: 'north' }, { name: 'south' }] });
    expect(byName.get('Unit')).toMatchObject({ kind: 'enum', members: [{ name: 'Meters' }, { name: 'Miles' }] });
    expect(byName.get('loadGeoSdk')).toMatchObject({ kind: 'function', params: ['addonPath', 'rest'] });
    expect(byName.get('haversine_distance')).toMatchObject({ kind: 'function', params: ['from', 'to'] });
    expect(byName.get('TilesApi')?.line).toBe(21);
  });

  it('answers each named path once with its status, never reading outside the root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-binding-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'geo.ts'), 'export function tile_at(c: C, z: number): T;\n');
      fs.writeFileSync(path.join(root, 'src', 'geo.py'), 'def tile_at(c, z): ...\n');
      const out = readBindingModules(['src/geo.ts', 'src/geo.ts', 'src/planned.ts', '../outside.ts', 'src/geo.py'], root);
      expect(out.map((m) => [m.path, m.status])).toEqual([
        ['src/geo.ts', 'read'],
        ['src/planned.ts', 'missing'],
        ['../outside.ts', 'escaped'],
        ['src/geo.py', 'unsupported'],
      ]);
      expect(out[0].declarations).toEqual([{ name: 'tile_at', kind: 'function', params: ['c', 'z'], members: [], line: 1 }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// binding conformance (rule binding-modules): the binding compared with the
// pin, rename hints taken from the snapshot's traces.
// ---------------------------------------------------------------------------

import * as yaml from 'js-yaml';
import fixtures from '../rules-matrix/families/conformance-binding.fixtures.js';
import { runRuleFixture } from '../rules-matrix/harness.js';

describe('binding conformance', () => {
  it('names the rename to follow for a verb and a field the pin renamed (and nothing on a binding that follows the pin)', () => {
    const [fire, control] = fixtures;
    const drift = runRuleFixture(fire).matching;
    expect(drift).toHaveLength(2);
    const text = drift.map((i) => i.message).join('\n');
    expect(text).toContain('"tileFor" was renamed to "tileAt" in geokit::tiles — follow the rename');
    expect(text).toContain('field "zoom" was renamed to "z" — follow the rename');
    expect(text).toContain('src/editor/geokit-binding.ts');
    // The rename explains the missing `z`: no second complaint about it.
    expect(text).not.toContain('the pinned type has field "z"');
    expect(runRuleFixture(control).matching).toEqual([]);
  });

  it('reports a removed verb, a renamed parameter and an arity change against the pinned method', () => {
    const [fire] = fixtures;
    const tree = structuredClone(fire.tree);
    const pin = tree.files!['.wai/externals/geokit.yaml'];
    const snapshot = yaml.load(pin) as { interfaces: { methods: { params: { name: string; previousNames?: string[] }[] }[] }[] };
    snapshot.interfaces[0].methods[0].params[2] = { ...snapshot.interfaces[0].methods[0].params[2], name: 'level', previousNames: ['zoom'] };
    tree.files!['.wai/externals/geokit.yaml'] = yaml.dump(snapshot);
    tree.files!['src/editor/geokit-binding.ts'] = [
      '/** geokit::tiles */',
      'export interface TileLibrary {',
      '  tileAt(lat: number, lon: number, zoom: number): unknown;',
      '  vincentyDistance(a: number, b: number): number;',
      '}',
      'export function tile_at(lat: number): unknown;',
      '',
    ].join('\n');
    const text = runRuleFixture({ ...fire, tree }).matching.map((i) => i.message).join('\n');
    expect(text).toContain('parameter "zoom" of "tileAt" was renamed to "level" — follow the rename');
    expect(text).toContain('"vincentyDistance" is not exported by geokit::tiles any more');
    expect(text).toContain('"tile_at" takes 1 parameter(s) (lat), the pin\'s "tileAt" takes 3');
  });
});

describe('binding conformance against a member project (round 6)', () => {
  it('names a member\'s parameter and field renames at validate time, read live — no pin involved', () => {
    const [memberFire, memberControl] = fixtures.slice(-2);
    const drift = runRuleFixture(memberFire).matching;
    const text = drift.map((i) => i.message).join('\n');
    expect(text).toContain('parameter "zoom" of "tileAt" was renamed to "z" — follow the rename');
    expect(text).toContain('field "zoom" was renamed to "z" — follow the rename');
    expect(text).toContain('geokit::tiles as its member project exports it now');
    expect(text).toContain('update the binding to the member\'s export');
    expect(text).not.toContain('pin it');
    expect(runRuleFixture(memberControl).matching).toEqual([]);
    // Compared, so never reported unread for want of a pin.
    expect(runRuleFixture({ ...memberControl, code: 'BINDING_UNREAD' }).matching).toEqual([]);
  });
});
