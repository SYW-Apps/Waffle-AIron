import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { runWithProjectBinding, setProjectRoot } from '../../src/utils/fs.js';
import { projectFamilyGraph } from '../../src/core/project-family.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateFamily, type ValidationIssue } from '../../src/core/validation.js';
import { pinExternals } from '../../src/core/surfaces.js';
import { remove as removeExternal } from '../../src/core/external-declarations.js';
import * as migrations from '../../src/migrations/index.js';
import { migrate, plan } from '../helpers/family-verbs.js';
import { isolateGlobals, tempDir } from '../helpers/stage8-family.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// Round 8 (lib-and-app R8-26, R8-24, R8-6): a `../` sibling member.
//
// `member attach geo ../geo-sdk` while the external `geo` existed pointed at
// `member adopt geo`, and adopt refused the `../` sibling as not-contained — a
// loop. And once attached (after `externals remove`), the sibling member was
// judged as a never-pinned EXTERNAL: EXTERNAL_CHECK_UNAVAILABLE on every use,
// `externals pin geo` pinning it under its alias as its id, and a trait
// implementer red with SIGNATURE_SOURCE_UNRESOLVED and IMPLEMENTS_MISMATCH.
// A sibling path member now behaves like a contained one: followed by the
// family scan and composed live — no pin.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows locks */ }
  }
});

/** geo-sdk: a Rust library — an InProcess Portal and a geocoding-provider extension point consumers implement. */
const GEO: FixtureTree = {
  system: {
    name: 'geo-sdk', vision: 'A geospatial library other programs link against.', targetLanguage: 'Rust',
    publicInterfaces: [
      { from: 'geocoding', component: 'geocoding-portal', as: 'geocoding', audience: 'external' },
      { from: 'geocoding', component: 'provider-port', as: 'geocoding_provider', role: 'implement', audience: 'external' },
      { from: 'geocoding', typeDef: 'coordinate', audience: 'external' },
    ],
  },
  subsystems: [{
    id: 'geocoding', description: 'Geocoding over a provider the consumer supplies.',
    publicInterfaces: [
      { component: 'geocoding-portal', details: 'The geocoder.' },
      { component: 'provider-port', details: 'The provider consumers implement.', role: 'implement' },
      { typeDef: 'coordinate', details: 'A coordinate.' },
    ],
  }],
  components: [
    { id: 'geocoding-portal', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The geocoder API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' } },
    { id: 'provider-port', componentType: 'Adapter', description: 'The port geocoding goes through.' },
  ],
  interfaces: [
    { id: 'igeocoding_portal', component: 'geocoding-portal', methods: [{ name: 'locate', description: 'Locate an address.', params: [{ name: 'query', type: 'string' }], returns: 'coordinate', effect: 'none' }] },
    { id: 'iprovider_port', component: 'provider-port', methods: [{ name: 'forward', description: 'Resolve an address to a coordinate.', params: [{ name: 'query', type: 'string' }], returns: 'coordinate' }] },
  ],
  types: [{ id: 'coordinate', kind: 'value-object', subsystem: 'geocoding', description: 'A coordinate.', holds: 'string' }],
};

/** route-planner: implements geo's provider (its signature taken across) and calls its geocoder. */
const PLANNER: FixtureTree = {
  system: { name: 'route-planner', vision: 'Plans routes over the geo-sdk geocoder.', targetLanguage: 'Rust' },
  subsystems: [{ id: 'routing', description: 'Route planning.' }],
  components: [
    { id: 'route-planner', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Plans a route.', dependsOn: ['geo::geocoding'] },
    { id: 'nominatim-provider', componentType: 'Adapter', description: 'Our geocoding provider over Nominatim.' },
  ],
  interfaces: [
    { id: 'iroute_planner', component: 'route-planner', methods: [{ name: 'plan', description: 'Plan a route to an address.', params: [{ name: 'to', type: 'string' }], returns: 'geo::coordinate' }] },
    { id: 'inominatim_provider', component: 'nominatim-provider', implements: 'geo::geocoding_provider', methods: [{ name: 'forward', description: 'Nominatim search.', signatureFrom: 'geo::geocoding_provider.forward' }] },
  ],
  implementations: [{
    id: 'route_planner_impl', contract: 'iroute_planner',
    methods: [{ name: 'plan', narrative: [
      { stepNumber: 1, type: 'call', description: 'Locate the destination.', targetComponent: 'geo::geocoding', targetMethod: 'locate' },
      { stepNumber: 2, type: 'return', description: 'Answer it.', outcome: 'the coordinate' },
    ] }],
  }],
};

function config(id: string, extra: Record<string, unknown> = {}): string {
  return yaml.dump({ schemaVersion: '1.0.0', id, name: id, targets: [], rules: BASE_FIXTURE_RULES, extensions: { packs: [], useGlobalPacks: false }, ...extra, createdAt: TS, updatedAt: TS });
}

/** geo-sdk (id geo-sdk) and route-planner side by side; the planner declares geo-sdk as the external `geo` at ../geo-sdk, pinned. */
function pair(): { planner: string; sdk: string } {
  const base = tempDir(cleanups, 'wairon-r8-sibling-');
  const sdk = path.join(base, 'geo-sdk');
  const planner = path.join(base, 'route-planner');
  materializeFixtureProject(sdk, GEO);
  fs.writeFileSync(path.join(sdk, '.wai', 'project.yaml'), config('geo-sdk'));
  materializeFixtureProject(planner, PLANNER);
  fs.writeFileSync(path.join(planner, '.wai', 'project.yaml'), config('route-planner', { externals: { geo: { project: 'geo-sdk', source: { path: '../geo-sdk' } } } }));
  at(planner, () => pinExternals());
  return { planner, sdk };
}

function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

/** The codes R8-26 met on a sibling member, as the family run reports them from the planner. */
const R8_26 = ['EXTERNAL_CHECK_UNAVAILABLE', 'SIGNATURE_SOURCE_UNRESOLVED', 'IMPLEMENTS_MISMATCH', 'EXTERNAL_UNPINNED', 'EXTERNAL_UNDECLARED'];
const red = (dir: string): string[] => at(dir, () => validateFamily({ family: true })).issues
  .filter((i: ValidationIssue) => R8_26.includes(i.code)).map((i) => `${i.code} ${i.message.slice(0, 140)}`);

const configOf = (dir: string): Record<string, any> => yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as Record<string, any>;

describe('round 8 — a `../` sibling member behaves like a contained one', () => {
  it('green as an external first: the fixture is sound', () => {
    const { planner } = pair();
    expect(red(planner)).toEqual([]);
  }, 120_000);

  it('attach while the external exists points at adopt, and adopt takes the `../` sibling — no loop', () => {
    const { planner } = pair();
    const attach = plan(planner, { verb: 'attach', alias: 'geo', path: '../geo-sdk' });
    expect(attach.refusals.map((r) => r.code)).toContain('already-member');
    expect(attach.refusals.map((r) => r.detail).join('\n')).toMatch(/wairon member adopt geo/);
    migrations.discard(attach);
    const adopt = plan(planner, { verb: 'adopt', alias: 'geo' });
    expect(adopt.refusals).toEqual([]);
    expect(adopt.edits.map((e) => e.detail).join('\n')).toMatch(/members: geo → \.\.\/geo-sdk/);
    at(planner, () => migrations.apply(adopt));
    expect(configOf(planner).members).toEqual({ geo: '../geo-sdk' });
    expect(configOf(planner).externals).toBeUndefined();
  }, 120_000);

  it('once a member, it is composed live: no unavailable check, the trait implementer resolves, and no pin is needed or taken', () => {
    const { planner } = pair();
    migrate(planner, { verb: 'adopt', alias: 'geo' });
    expect(red(planner)).toEqual([]);
    expect(at(planner, () => pinExternals())).toEqual([]);
    expect(() => at(planner, () => pinExternals(['geo']))).toThrow(/"geo" is a member of this project, read live .* never pinned/);
    // Its own gate ran in the family run, keyed as a member.
    expect((at(planner, () => validateFamily({ family: true })).projects ?? []).map((p) => p.key)).toContain('geo-sdk');
  }, 120_000);

  it('R8-26: removed as an external, then attached from the sibling path — the same green, no pin', () => {
    const { planner } = pair();
    at(planner, () => removeExternal('geo'));
    const attached = migrate(planner, { verb: 'attach', alias: 'geo', path: '../geo-sdk' });
    expect(attached.applied).toBe(true);
    expect(red(planner)).toEqual([]);
    expect(fs.existsSync(path.join(planner, '.wai', 'externals', 'geo.yaml'))).toBe(false);
  }, 120_000);

  it('a hosted instance still never reads the `../` source: the sibling is no node there', () => {
    const { planner } = pair();
    migrate(planner, { verb: 'adopt', alias: 'geo' });
    invalidateSpecCache();
    const hosted = runWithProjectBinding(planner, { topRoot: planner, parentReach: true, hostedLookup: () => null }, () => {
      invalidateSpecCache();
      return projectFamilyGraph();
    });
    expect(hosted.nodes.map((n) => n.namespace)).toEqual(['']);
    invalidateSpecCache();
    expect(at(planner, () => projectFamilyGraph()).nodes.map((n) => n.namespace)).toContain('geo-sdk');
  }, 120_000);

  it('detach takes it back to a pinned external by path, green again', () => {
    const { planner } = pair();
    migrate(planner, { verb: 'adopt', alias: 'geo' });
    const detached = migrate(planner, { verb: 'detach', alias: 'geo' });
    expect(detached.applied).toBe(true);
    expect(configOf(planner).externals.geo).toMatchObject({ project: 'geo-sdk', source: { path: '../geo-sdk' } });
    expect(red(planner)).toEqual([]);
  }, 120_000);
});
