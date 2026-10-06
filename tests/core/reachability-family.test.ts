/**
 * Reachability, waves 2 and 3 (docs/design/reachability.md): the reach model
 * the validator projects and composes, the network verdicts only the family
 * run can make (ENTRY_UNPROVEN, ENTRY_SCOPE_UNBOUNDED, a call bypassing a
 * member's gateway), the gate identity's `network` key — present only when a
 * project declares one, so no lock taken before stales — and the surface
 * snapshot carrying transport, abi, role and targetLanguage without moving a
 * pin taken before it carried them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { compose, project } from '../../src/core/rules/reach-model-projector.js';
import { judge } from '../../src/core/rules/network-arbiter.js';
import { computeGateIdentity } from '../../src/core/rules/gate-identity.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { ownReachModel, reachModel, validateFamily, validateProject } from '../../src/core/validation.js';
import { projectOwnSurface } from '../../src/core/surfaces.js';
import { contentDigest, memberDigest, type ProjectFamily, type ReachModel, type StateId } from '../../src/models/index.js';
import { BASE_FIXTURE_RULES, materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

const TS = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of roots.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* windows locks */ }
  }
});

function bindTree(tree: FixtureTree): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-reach-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

function projectYaml(name: string, extra: Record<string, unknown> = {}): string {
  return dump({ name, targets: [], rules: BASE_FIXTURE_RULES, extensions: { packs: [], useGlobalPacks: false }, ...extra });
}

// ---------------------------------------------------------------------------
// The pure halves: the projector's composition and the arbiter's verdicts
// ---------------------------------------------------------------------------

/** A minimal project graph: the root, and members by key with their parents. */
function familyOf(members: Record<string, string>, references: ProjectFamily['references'] = []): ProjectFamily {
  return {
    nodes: [
      { namespace: '' },
      ...Object.entries(members).map(([namespace, parent]) => ({ namespace, parent })),
    ],
    owners: new Map(),
    authoredReferences: [],
    problems: [],
    references,
  } as unknown as ProjectFamily;
}

/** One project's own model holding one HTTP verb with the entry given. */
function ownModel(portal: string, verb: string, entry: Record<string, unknown> | undefined, gateway = false): ReachModel {
  return {
    scope: 'own',
    networks: [],
    verbs: [{ project: '', portal, verb, transport: 'HTTP', binding: `POST /${verb}`, gateway, ...(entry ? { entry: entry as never } : {}) }],
    calls: [],
  };
}

const networkEntry = { kind: 'entry', scope: 'network', caller: 'The checkout service inside the order network.' };

describe('reach_model_projector.compose and network_arbiter.judge (family scope)', () => {
  it('reports a network-scoped entry no modelled caller inside its boundary reaches (ENTRY_UNPROVEN)', () => {
    const models = new Map([['', { scope: 'own', networks: [], verbs: [], calls: [] } as ReachModel], ['settlement', ownModel('settle-api', 'settle', networkEntry)]]);
    const model = compose(models, familyOf({ settlement: '' }), new Map([['', {}]]));
    expect(model.scope).toBe('family');
    expect(model.verbs[0]).toMatchObject({ project: 'settlement', portal: 'settlement::settle-api', network: '' });
    const findings = judge(model);
    expect(findings.map((f) => [f.code, f.specId, f.at])).toEqual([['ENTRY_UNPROVEN', 'settlement::settle-api', 'settle']]);
  });

  it('proves it with a cross-project call the family references record', () => {
    const models = new Map([['', { scope: 'own', networks: [], verbs: [], calls: [] } as ReachModel], ['settlement', ownModel('settle-api', 'settle', networkEntry)]]);
    const references: ProjectFamily['references'] = [
      { specId: 'checkout-adapter', position: 'dependsOn', target: 'settlement::settle-api', consumer: '', producer: 'settlement', authored: 'settlement::settlement' },
      { specId: 'checkout_adapter_impl', position: 'call', target: 'settlement::settle-api', member: 'settle', consumer: '', producer: 'settlement', authored: 'settlement::settlement' },
    ];
    const model = compose(models, familyOf({ settlement: '' }, references), new Map([['', {}]]));
    expect(model.calls).toEqual([expect.objectContaining({ fromProject: '', fromComponent: 'checkout-adapter', fromNetwork: '', toPortal: 'settlement::settle-api', verb: 'settle' })]);
    expect(judge(model).filter((f) => f.code === 'ENTRY_UNPROVEN')).toEqual([]);
  });

  it('names a network-scoped entry with no declared network around it (ENTRY_SCOPE_UNBOUNDED), proving it against the whole family', () => {
    const models = new Map([['settlement', ownModel('settle-api', 'settle', networkEntry)]]);
    const findings = judge(compose(models, familyOf({ settlement: '' }), new Map()));
    expect(findings.map((f) => [f.code, f.severity])).toEqual([['ENTRY_SCOPE_UNBOUNDED', 'notice'], ['ENTRY_UNPROVEN', 'warning']]);
  });

  it('reports a call from outside a member\'s network that lands on a non-gateway (GATEWAY_BYPASSED)', () => {
    const models = new Map([['settlement', ownModel('settle-api', 'settle', { kind: 'entry', scope: 'network', caller: 'Siblings.' })]]);
    const references: ProjectFamily['references'] = [
      { specId: 'checkout-adapter', position: 'calls', target: 'settlement::settle-api', member: 'settle', consumer: '', producer: 'settlement', authored: 'settlement::settlement' },
    ];
    const findings = judge(compose(models, familyOf({ settlement: '' }, references), new Map([['settlement', {}]])));
    expect(findings.filter((f) => f.code === 'GATEWAY_BYPASSED').map((f) => f.specId)).toEqual(['checkout-adapter']);
  });

  it('never proves or bounds entries on a project\'s own model: one project alone cannot see its siblings', () => {
    expect(judge(ownModel('settle-api', 'settle', networkEntry))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The family run: ENTRY_UNPROVEN is the family's, never a member's own gate's
// ---------------------------------------------------------------------------

/** A shop root (declaring the network) with a settlement member whose API takes a network-scoped entry. */
function shopFamily(o: { rootCalls: boolean; allow?: boolean }): FixtureTree {
  const base = 'packages/settlement/.wai';
  return {
    system: {
      name: 'Shop', vision: 'A web shop whose checkout settles orders through the settlement service.',
    },
    subsystems: [{ id: 'checkout', description: 'Order checkout.' }],
    components: o.rootCalls ? [{
      id: 'checkout-adapter', componentType: 'Adapter', description: 'Calls the settlement service over HTTP.', dependsOn: ['settlement::settlement'],
    }] : [],
    interfaces: o.rootCalls ? [{
      id: 'icheckout_adapter', component: 'checkout-adapter',
      methods: [{ name: 'settleOrder', description: 'Settle one order.', invokedBy: { kind: 'runtime', caller: 'The checkout worker of this process, once per paid order.' } }],
    }] : [],
    implementations: o.rootCalls ? [{
      id: 'checkout_adapter_impl', contract: 'icheckout_adapter',
      methods: [{ name: 'settleOrder', narrative: [{ stepNumber: 1, type: 'call', description: 'Ask the settlement service to settle the order.', targetComponent: 'settlement::settlement', targetMethod: 'settle' }] }],
    }] : [],
    files: {
      '.wai/project.yaml': projectYaml('shop', { id: 'shop', network: true, members: { settlement: 'packages/settlement' } }),
      [`${base}/project.yaml`]: projectYaml('settlement', { id: 'settlement' }),
      [`${base}/specs/.index.yaml`]: dump({
        name: 'Settlement', vision: 'Settles paid orders for the shop.',
        publicInterfaces: [{ from: 'settling', component: 'settle-api', as: 'settlement', audience: 'project' }],
      }),
      [`${base}/specs/subsystems/settling.yaml`]: dump({
        id: 'settling', name: 'Settling', description: 'Order settlement.', parentSystem: 'Settlement',
        publicInterfaces: [{ component: 'settle-api', details: 'Settle a paid order.' }],
      }),
      [`${base}/specs/components/settle-api.yaml`]: dump({
        id: 'settle-api', name: 'Settle API', description: 'HTTP API the shop\'s services settle orders through.',
        subsystem: 'settling', componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: [],
        invokedBy: { kind: 'entry', scope: 'network', caller: 'The shop\'s checkout service, inside the shop network.' },
        ...(o.allow ? { lint: { allow: [{ code: 'ENTRY_UNPROVEN', at: 'settle', reason: 'The nightly reconciliation job, not modelled in wairon, calls it inside the network.' }] } } : {}),
      }),
      [`${base}/specs/interfaces/isettle-api.yaml`]: dump({
        id: 'isettle-api', name: 'Settle API Interface', description: 'Settle orders.', component: 'settle-api',
        methods: [{ name: 'settle', description: 'Settle one paid order.', signature: 'settle(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'POST', path: '/settle' } }],
      }),
    },
  };
}

describe('family_validator.checkReach (the family run)', () => {
  it('reports a member\'s unproven network entry in the family run, never in the member\'s own gate', () => {
    const root = bindTree(shopFamily({ rootCalls: false }));
    const family = validateFamily({});
    const unproven = family.issues.filter((i) => i.code === 'ENTRY_UNPROVEN');
    expect(unproven).toHaveLength(1);
    expect(unproven[0]).toMatchObject({ project: 'settlement', severity: 'warning' });
    // The member judged alone counts its network entry as declared.
    setProjectRoot(path.join(root, 'packages', 'settlement'));
    invalidateSpecCache();
    expect(validateProject({}).issues.some((i) => i.code === 'ENTRY_UNPROVEN')).toBe(false);
  });

  it('is proven by the root\'s modelled cross-project call', () => {
    bindTree(shopFamily({ rootCalls: true }));
    const family = validateFamily({});
    expect(family.issues.filter((i) => i.code === 'ENTRY_UNPROVEN')).toEqual([]);
    const model = reachModel({});
    expect(model.scope).toBe('family');
    expect(model.calls.some((c) => c.toPortal === 'settlement::settle-api' && c.verb === 'settle')).toBe(true);
  });

  it('honours a lint.allow on the member\'s spec at the verb', () => {
    bindTree(shopFamily({ rootCalls: false, allow: true }));
    expect(validateFamily({}).issues.filter((i) => i.code === 'ENTRY_UNPROVEN')).toEqual([]);
  });

  it('answers the bound project\'s own model from spec_validator.reachModel', () => {
    const root = bindTree(shopFamily({ rootCalls: false }));
    setProjectRoot(path.join(root, 'packages', 'settlement'));
    invalidateSpecCache();
    const own = ownReachModel();
    expect(own.scope).toBe('own');
    expect(own.verbs.map((v) => `${v.portal}.${v.verb}`)).toEqual(['settle-api.settle']);
    expect(own.verbs[0].entry).toMatchObject({ kind: 'entry', scope: 'network' });
  });
});

// ---------------------------------------------------------------------------
// The gate identity: `network` only when declared
// ---------------------------------------------------------------------------

describe('gate_identity.compute and the network declaration', () => {
  const content: StateId = { algorithm: 'sha256-design', digest: 'abc123' } as StateId;
  const gate = { projectType: 'backend', rules: { designDepth: 'narratives' } as never, composition: null };
  const members = { billing: 'sha256+design+doctrine+inputs+members:ffff' };

  it('digests a project that declares no network exactly as before networks existed, so no existing lock stales', () => {
    // Pinned from the gate identity at 0f4a1050, before the network key existed.
    const before = 'a3021dc8657886a206a3995f54084f741160c616f4e020a0265eae277bf21752';
    expect(computeGateIdentity(content, emptyExtensions(), [], ['in-a'], gate, members).digest).toBe(before);
    expect(computeGateIdentity(content, emptyExtensions(), [], ['in-a'], { ...gate, network: undefined }, members).digest).toBe(before);
    expect(computeGateIdentity(content, emptyExtensions(), [], ['in-a'], { ...gate, network: null }, members).digest).toBe(before);
  });

  it('moves the identity when a project declares, or redescribes, a network', () => {
    const none = computeGateIdentity(content, emptyExtensions(), [], ['in-a'], gate, members).digest;
    const declared = computeGateIdentity(content, emptyExtensions(), [], ['in-a'], { ...gate, network: {} }, members).digest;
    const described = computeGateIdentity(content, emptyExtensions(), [], ['in-a'], { ...gate, network: { description: 'Order services' } }, members).digest;
    expect(new Set([none, declared, described]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// The surface snapshot: transport, abi, role and targetLanguage, never digested
// ---------------------------------------------------------------------------

function geoKit(): FixtureTree {
  return {
    system: {
      name: 'GeoKit', vision: 'A tiling library for map applications.', targetLanguage: 'Rust',
      publicInterfaces: [
        { from: 'tiling', component: 'tile-library', as: 'tiles', audience: 'external' },
        { from: 'tiling', component: 'tile-source-port', as: 'tile-source', audience: 'external', role: 'implement' },
      ],
    },
    subsystems: [{
      id: 'tiling', description: 'Tile arithmetic.',
      publicInterfaces: [
        { component: 'tile-library', details: 'The crate\'s tile API.' },
        { component: 'tile-source-port', details: 'Where tiles load from.', role: 'implement' },
      ],
    }],
    components: [
      { id: 'tile-library', componentType: 'Portal', transport: 'InProcess', abi: 'c', description: 'The crate\'s tile API.', invokedBy: { kind: 'entry', caller: 'Applications linking the crate.' } },
      { id: 'tile-source-port', componentType: 'Adapter', description: 'The port GeoKit loads tiles through.' },
    ],
    interfaces: [
      { id: 'itile_library', component: 'tile-library', methods: [{ name: 'tile_for', description: 'The tile key for a zoom.', params: [{ name: 'zoom', type: 'int' }], returns: 'string', effect: 'none' }] },
      { id: 'itile_source_port', component: 'tile-source-port', methods: [{ name: 'load_tile', description: 'Load a tile.', params: [{ name: 'key', type: 'string' }], returns: 'bytes' }] },
    ],
  };
}

describe('surface_projector.projectOwnSurface (transport, abi, role, targetLanguage)', () => {
  it('carries the backing Portal\'s transport and abi, the entry\'s role, the derived kind and the producer\'s language', () => {
    bindTree(geoKit());
    const snapshot = projectOwnSurface('project');
    expect(snapshot.targetLanguage).toBe('rust');
    const tiles = snapshot.interfaces.find((e) => e.id === 'tiles')!;
    expect(tiles).toMatchObject({ transport: 'InProcess', abi: 'c', type: 'Custom' });
    expect(tiles.role).toBeUndefined();
    expect(snapshot.interfaces.find((e) => e.id === 'tile-source')!.role).toBe('implement');
  });

  it('keeps a pin taken before they were carried current: an absent field reads as derived, never drifted', () => {
    bindTree(geoKit());
    const live = projectOwnSurface('project');
    // The same contract as an older wairon wrote it: no transport, abi, role or targetLanguage.
    const { targetLanguage: _language, ...rest } = live;
    const pinned = { ...rest, interfaces: live.interfaces.map(({ transport: _t, abi: _a, role: _r, ...entry }) => entry) };
    expect(contentDigest(pinned)).toBe(contentDigest(live));
    expect(memberDigest(pinned, 'tiles', 'tile_for')).toBe(memberDigest(live, 'tiles', 'tile_for'));
  });
});
