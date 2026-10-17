import { describe, expect, it } from 'vitest';
import { resolveTree } from '../../src/core/signature-sources.js';
import {
  carriedFactChanges,
  consumerReaches,
  fieldRenamesSince,
  memberDigest,
  narrowedToMember,
  surfaceChanges,
  type ComponentSpec,
  type ExternalConsumer,
  type InterfaceSpec,
  type MethodSignature,
  type SurfaceSnapshot,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-5 trials (lib-and-app R5-11, R5-16, R5-19, R5-30): effect travels
// through signatureFrom; an undeclared effect is never printed as `none`;
// field and parameter renames reach the consumer with their new names; the
// rename dry run's breaks are narrowed to the method.
// ---------------------------------------------------------------------------

const TS = '2026-10-07T00:00:00.000Z';

const component = (id: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: TS, updatedAt: TS, ...over,
} as ComponentSpec);

const contract = (comp: string, methods: Partial<MethodSignature>[]): InterfaceSpec => ({
  id: `i${comp}`, name: `i${comp}`, description: 'd', component: comp, status: 'complete', createdAt: TS, updatedAt: TS,
  methods: methods.map((m) => ({ name: 'm', description: 'd', ...m })) as MethodSignature[],
});

const DISTANCE = { name: 'haversine', description: 'd', params: [{ name: 'a', type: 'float' }], returns: 'float', effect: 'none' as const };

describe('3 — effect travels through signatureFrom (R5-11)', () => {
  const components = [component('distance_portal', { componentType: 'Portal', dependsOn: ['calculator'] }), component('calculator')];

  it('a verb whose signature comes from a pure method is pure', () => {
    const result = resolveTree([
      contract('distance_portal', [{ name: 'haversine', signatureFrom: 'calculator.haversine' }]),
      contract('calculator', [DISTANCE]),
    ], components, []);
    expect(result.interfaces[0].methods[0].effect).toBe('none');
  });

  it('an effect the verb declares itself wins', () => {
    const result = resolveTree([
      contract('distance_portal', [{ name: 'haversine', signatureFrom: 'calculator.haversine', effect: 'io' }]),
      contract('calculator', [DISTANCE]),
    ], components, []);
    expect(result.interfaces[0].methods[0].effect).toBe('io');
  });

  it('a source that declares no effect leaves the verb undeclared', () => {
    const { effect: _none, ...undeclared } = DISTANCE;
    const result = resolveTree([
      contract('distance_portal', [{ name: 'haversine', signatureFrom: 'calculator.haversine' }]),
      contract('calculator', [undeclared]),
    ], components, []);
    expect(result.interfaces[0].methods[0].effect).toBeUndefined();
  });
});

interface SnapOptions {
  effect?: string;
  param?: { name: string; previousNames?: string[] };
  zoomField?: { name: string; formerly?: string[] };
  extraField?: boolean;
}

const snapshot = (o: SnapOptions = {}): SurfaceSnapshot => ({
  projectName: 'geo', projectId: 'geo', origin: 'generated', generatedAt: TS,
  interfaces: [{
    id: 'tiles', component: 'tile_portal', type: 'InProcess', audience: 'external', transport: 'InProcess',
    methods: [{
      name: 'tileAt', description: 'd', signature: 'tileAt(q: string): tile_coord',
      params: [{ name: o.param?.name ?? 'address', type: 'string', ...(o.param?.previousNames ? { previousNames: o.param.previousNames } : {}) }],
      returns: 'tile_coord', ...(o.effect ? { effect: o.effect } : {}),
    }],
  }],
  types: [{
    id: 'tile_coord', name: 'tile_coord', kind: 'value-object',
    fields: [
      { name: 'x', type: 'int' },
      { name: o.zoomField?.name ?? 'zoom', type: 'int', ...(o.zoomField?.formerly ? { formerly: o.zoomField.formerly } : {}) },
      ...(o.extraField ? [{ name: 'tilt', type: 'int' }] : []),
    ],
  }],
  exportedTypes: [{ id: 'tile_coord', type: 'tile_coord', audience: 'external' }],
} as unknown as SurfaceSnapshot);

describe('3 — surface diff names an undeclared effect (R5-16)', () => {
  it('a newly declared `effect: none` reads `undeclared → none`, never `none → none`', () => {
    const changes = surfaceChanges(snapshot({ effect: 'none' }), snapshot());
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tiles', member: 'tileAt', detail: 'effect undeclared → none' }));
  });
});

describe('4 — field and parameter renames across projects (R5-19)', () => {
  it('surface diff: a traced field rename is a rename with its new name, and no anonymous shape row', () => {
    const changes = surfaceChanges(snapshot({ zoomField: { name: 'z', formerly: ['zoom'] } }), snapshot());
    expect(changes).toContainEqual({ kind: 'renamed', name: 'tile_coord', member: 'z', from: 'zoom', detail: 'field "zoom" renamed to "z"' });
    expect(changes.some((c) => c.detail.startsWith('type shape changed'))).toBe(false);
  });

  it('surface diff: a rename beside another shape change keeps the shape row too', () => {
    const changes = surfaceChanges(snapshot({ zoomField: { name: 'z', formerly: ['zoom'] }, extraField: true }), snapshot());
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'renamed', member: 'z', from: 'zoom' }));
    expect(changes).toContainEqual(expect.objectContaining({ kind: 'changed', name: 'tile_coord', detail: expect.stringContaining('type shape changed') }));
  });

  it('surface diff: a traced parameter rename is listed (round 5 listed nothing)', () => {
    const changes = surfaceChanges(snapshot({ param: { name: 'query', previousNames: ['address'] } }), snapshot());
    expect(changes).toEqual([{ kind: 'renamed', name: 'tiles', member: 'tileAt', from: 'address', detail: 'parameter "address" renamed to "query"' }]);
  });

  it('the pin: a parameter rename is a stale fact naming the new name; a field rename too', () => {
    const facts = carriedFactChanges(snapshot(), snapshot({ param: { name: 'query', previousNames: ['address'] }, zoomField: { name: 'z', formerly: ['zoom'] } }));
    expect(facts).toContain('parameter "address" of tiles.tileAt (renamed to "query")');
    expect(facts).toContain('field "zoom" of tile_coord (renamed to "z")');
  });

  it('the consumer: a used member whose closure field was renamed is told the rename, and that it is the whole change', () => {
    const pinned = snapshot();
    const live = snapshot({ zoomField: { name: 'z', formerly: ['zoom'] } });
    const digest = memberDigest(pinned, 'tiles', 'tileAt')!;
    expect(memberDigest(live, 'tiles', 'tileAt')).not.toBe(digest);
    expect(fieldRenamesSince(pinned, live, 'tiles', 'tileAt', digest)).toEqual({ renames: ['field "tile_coord.zoom" renamed to "z"'], renameOnly: true });
    const both = snapshot({ zoomField: { name: 'z', formerly: ['zoom'] }, extraField: true });
    expect(fieldRenamesSince(pinned, both, 'tiles', 'tileAt', digest).renameOnly).toBe(false);
  });
});

describe('4 — the rename dry run\'s breaks name only the method that breaks (R5-30)', () => {
  const consumer: ExternalConsumer = {
    project: 'route-planner', key: '', directory: '/x', alias: 'geo', section: 'externals', names: ['distance', 'tiles'],
    uses: [
      { publicName: 'tiles', kind: 'component', members: ['tileAt', 'tileBounds'], specs: ['route_viewer'] },
      { publicName: 'distance', kind: 'component', members: ['haversine'], specs: ['stop_sequencer'] },
    ],
  };

  it('keeps the public names publishing the method, each with that one member', () => {
    expect(consumerReaches(consumer, ['tiles'], 'tileAt')).toBe(true);
    const narrowed = narrowedToMember(consumer, ['tiles'], 'tileAt');
    expect(narrowed.uses).toEqual([{ publicName: 'tiles', kind: 'component', members: ['tileAt'], specs: ['route_viewer'] }]);
    expect(narrowed.names).toEqual(['tiles']);
  });
});
