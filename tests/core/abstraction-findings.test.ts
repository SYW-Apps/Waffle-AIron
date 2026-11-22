import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { composeAgentBrief } from '../../src/core/agent_resolver.js';
import { materializeFixtureProject, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// The finding codes and invariants of an abstraction, end to end: the whole
// rule set over real code files, then the brief of a caller of the same tree.
// A parcel carrier abstraction declares MULTI_COLLO_UNSUPPORTED; only some
// carriers refuse several parcels, and one carrier has a state of its own.
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const SUB = { id: 'shipping', description: 'Booking parcels with the carriers.' };
const MULTI = { code: 'MULTI_COLLO_UNSUPPORTED', severity: 'warning', summary: 'The carrier takes one parcel per shipment' };
const HANDOVER = { code: 'UPS_MANUAL_HANDOVER', severity: 'warning', summary: 'The parcel needs a manual handover at an access point' };
const BOOK = { name: 'bookShipment', description: 'Book one shipment with the carrier.', params: [{ name: 'shipment', type: 'Shipment' }], returns: 'void', effect: 'write' };
const ASSERT = { assertsInvariants: ['shipment.one-label-per-parcel'] };

interface Options {
  postnl?: unknown[];
  upsRaises?: boolean;
  asserting?: { postnl?: boolean; ups?: boolean; dhl?: boolean };
}

function carriers(over: Options = {}): FixtureTree {
  const asserting = { postnl: true, ups: true, dhl: true, ...over.asserting };
  const method = (findings: unknown[] | undefined) => ({ ...BOOK, ...(findings ? { findings } : {}) });
  const step = (who: string, asserts: boolean) => [
    { stepNumber: 1, type: 'local', description: `Book the shipment with ${who}.`, ...(asserts ? ASSERT : {}) },
  ];
  const postnl = over.postnl ?? [MULTI];
  const upsBody = over.upsRaises === false ? 'return' : "throw new Error('UPS_MANUAL_HANDOVER')";
  return {
    system: { name: 'ParcelDesk', vision: 'Books parcels with several carriers.' },
    subsystems: [SUB],
    components: [
      { id: 'parcel-carrier', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Books one shipment with some carrier.' },
      { id: 'postnl-carrier', subsystem: SUB.id, componentType: 'Adapter', description: 'Books with PostNL.' },
      { id: 'ups-carrier', subsystem: SUB.id, componentType: 'Adapter', description: 'Books with UPS.' },
      { id: 'dhl-carrier', subsystem: SUB.id, componentType: 'Adapter', description: 'Books with DHL.' },
      { id: 'shipment-planner', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Plans a shipment.', dependsOn: ['parcel-carrier'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the planner at boot.' } },
    ],
    interfaces: [
      { id: 'iparcel_carrier', component: 'parcel-carrier', methods: [method([MULTI])] },
      { id: 'ipostnl_carrier', component: 'postnl-carrier', implements: ['parcel-carrier'], methods: [method(postnl)] },
      { id: 'iups_carrier', component: 'ups-carrier', implements: ['parcel-carrier'], methods: [method([HANDOVER])] },
      { id: 'idhl_carrier', component: 'dhl-carrier', implements: ['parcel-carrier'], methods: [method(undefined)] },
      { id: 'ishipment_planner', component: 'shipment-planner', methods: [{ name: 'planShipment', description: 'Plan one shipment.' }] },
    ],
    implementations: [
      { id: 'parcel_carrier_impl', contract: 'iparcel_carrier', sourcePath: 'src/parcel_carrier.ts', methods: [{ name: 'bookShipment' }] },
      { id: 'postnl_carrier_impl', contract: 'ipostnl_carrier', sourcePath: 'src/postnl_carrier.ts', methods: [{ name: 'bookShipment', narrative: step('PostNL', asserting.postnl) }] },
      { id: 'ups_carrier_impl', contract: 'iups_carrier', sourcePath: 'src/ups_carrier.ts', methods: [{ name: 'bookShipment', narrative: step('UPS', asserting.ups) }] },
      { id: 'dhl_carrier_impl', contract: 'idhl_carrier', sourcePath: 'src/dhl_carrier.ts', methods: [{ name: 'bookShipment', narrative: step('DHL', asserting.dhl) }] },
      { id: 'shipment_planner_impl', contract: 'ishipment_planner', sourcePath: 'src/shipment_planner.ts', methods: [{ name: 'planShipment', narrative: [{ stepNumber: 1, type: 'call', description: 'Book the shipment through the carrier.', targetComponent: 'parcel-carrier', targetMethod: 'bookShipment' }] }] },
    ],
    types: [
      {
        id: 'shipment', name: 'Shipment', kind: 'entity', subsystem: SUB.id, componentClass: 'parcel-carrier',
        description: 'One booked shipment.',
        sourcePath: 'src/shipment.ts',
        fields: [{ name: 'parcelCount', type: 'int', description: 'Parcels in the shipment.' }],
        invariants: [{ id: 'one-label-per-parcel', description: 'Every parcel of a shipment carries its own label.' }],
      },
    ],
    files: {
      'src/parcel_carrier.ts': "import type { Shipment } from './shipment';\nexport interface ParcelCarrier { bookShipment(shipment: Shipment): void }\n",
      'src/shipment.ts': 'export interface Shipment { parcelCount: number }\n',
      'src/postnl_carrier.ts': "import type { ParcelCarrier } from './parcel_carrier';\nimport type { Shipment } from './shipment';\nexport class PostnlCarrier implements ParcelCarrier {\n  bookShipment(shipment: Shipment): void {\n    if (shipment.parcelCount > 1) throw new Error('MULTI_COLLO_UNSUPPORTED');\n  }\n}\n",
      'src/ups_carrier.ts': `import type { ParcelCarrier } from './parcel_carrier';\nimport type { Shipment } from './shipment';\nexport class UpsCarrier implements ParcelCarrier {\n  bookShipment(shipment: Shipment): void {\n    if (shipment.parcelCount > 0) ${upsBody};\n  }\n}\n`,
      'src/dhl_carrier.ts': "import type { ParcelCarrier } from './parcel_carrier';\nimport type { Shipment } from './shipment';\nexport class DhlCarrier implements ParcelCarrier {\n  bookShipment(shipment: Shipment): void { void shipment; }\n}\n",
      'src/shipment_planner.ts': "import type { ParcelCarrier } from './parcel_carrier';\nimport type { Shipment } from './shipment';\nexport class ShipmentPlanner {\n  constructor(private readonly carrier: ParcelCarrier) {}\n  planShipment(): void { this.carrier.bookShipment({ parcelCount: 1 }); }\n}\n",
    },
  };
}

const issuesOf = (tree: FixtureTree) =>
  runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A probe tree whose findings the test reads directly.', tree }).issues;
const warned = (tree: FixtureTree) => issuesOf(tree).filter((i) => i.severity !== 'notice').map((i) => `${i.code} on ${i.specId}`);

describe('finding codes and invariants of an abstraction, over the whole rule set', () => {
  it('draws no warning when one carrier declares and raises the shared code and another its own', () => {
    expect(warned(carriers())).toEqual([]);
  });

  it('reports exactly ABSTRACTION_FINDING_UNRAISED when nobody declares the shared code', () => {
    expect(warned(carriers({ postnl: [] }))).toEqual(['ABSTRACTION_FINDING_UNRAISED on parcel-carrier']);
  });

  it('reports UNREALIZED_FINDING on the carrier that declares its own code and does not raise it, and on it alone', () => {
    expect(warned(carriers({ upsRaises: false }))).toEqual(['UNREALIZED_FINDING on ups_carrier_impl']);
  });

  it('is silent on an invariant the abstraction owns when every carrier asserts it', () => {
    expect(issuesOf(carriers()).filter((i) => i.code === 'UNASSERTED_INVARIANT')).toEqual([]);
  });

  it('reports the one carrier that leaves an invariant of the abstraction unasserted', () => {
    const found = issuesOf(carriers({ asserting: { dhl: false } })).filter((i) => i.code === 'UNASSERTED_INVARIANT');
    expect(found.map((i) => i.specId)).toEqual(['dhl_carrier_impl']);
    expect(found[0].message).toContain('dhl-carrier');
  });
});

describe('the invariant of an abstraction, which its concrete implementers assert', () => {
  type Spec = Record<string, unknown> & { id: string; methods?: Record<string, unknown>[] };
  const edit = (tree: FixtureTree, id: string, change: (spec: Spec) => Spec): FixtureTree => ({
    ...tree,
    interfaces: (tree.interfaces ?? []).map((i) => (i.id === id ? change(i as Spec) : i)),
  });
  const unasserted = (tree: FixtureTree) => issuesOf(tree).filter((i) => i.code === 'UNASSERTED_INVARIANT').map((i) => i.specId);

  it('moves the obligation through a chain of abstractions to the concrete implementer below', () => {
    let tree = carriers({ asserting: { ups: false } });
    tree = {
      ...tree,
      components: [...(tree.components ?? []), { id: 'express-carrier', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Books an express shipment with some carrier.' }],
      interfaces: [
        ...(tree.interfaces ?? []).map((i) => (i.id === 'iups_carrier' ? { ...i, implements: ['express-carrier'] } : i)),
        { id: 'iexpress_carrier', component: 'express-carrier', implements: ['parcel-carrier'], methods: [{ ...BOOK }] },
      ],
    };
    expect(unasserted(tree)).toEqual(['ups_carrier_impl']);
  });

  it('skips an implementer whose own method states an effect other than write', () => {
    const tree = edit(carriers({ asserting: { dhl: false } }), 'idhl_carrier', (i) => ({ ...i, methods: [{ ...BOOK, effect: 'read' }] }));
    expect(unasserted(tree)).toEqual([]);
  });

  it('skips an implementer that does not declare the method', () => {
    const tree = edit(carriers({ asserting: { dhl: false } }), 'idhl_carrier', (i) => ({ ...i, methods: [] }));
    expect(unasserted(tree)).toEqual([]);
  });

  it('holds an implementer that states no effect to the obligation, as the abstraction\'s write stands', () => {
    const { effect: _effect, ...unstated } = BOOK;
    const tree = edit(carriers({ asserting: { dhl: false } }), 'idhl_carrier', (i) => ({ ...i, methods: [unstated] }));
    expect(unasserted(tree)).toEqual(['dhl_carrier_impl']);
  });

  it('leaves a component that is not an abstraction exactly as before: its own write path is judged, its implementations\' alone', () => {
    const tree = carriers();
    const plain: FixtureTree = {
      ...tree,
      types: (tree.types ?? []).map((t) => ({ ...t, componentClass: 'dhl-carrier' })),
    };
    expect(unasserted(plain)).toEqual([]);
    const dropped: FixtureTree = {
      ...plain,
      implementations: (plain.implementations ?? []).map((impl) => (impl.id === 'dhl_carrier_impl'
        ? { ...impl, methods: [{ name: 'bookShipment', narrative: [{ stepNumber: 1, type: 'local', description: 'Book the shipment with DHL.' }] }] }
        : impl)),
    };
    expect(unasserted(dropped)).toEqual(['dhl_carrier_impl']);
  });
});

describe('the brief of an implementer of the carriers', () => {
  const brief = (tree: FixtureTree, agent: string): string => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-abstraction-findings-')));
    roots.push(dir);
    materializeFixtureProject(dir, tree);
    setProjectRoot(dir);
    invalidateSpecCache();
    return composeAgentBrief(agent).instructions;
  };

  it('lists the codes the abstraction declares and tells it to declare those it raises beside its own', () => {
    const text = brief(carriers(), 'dhl-carrier-implementer');
    expect(text).toMatch(/declares finding codes: `MULTI_COLLO_UNSUPPORTED` on `bookShipment` \(warning: /);
    expect(text).toMatch(/Declare on your own contract, on the method of that name, each of them your code raises/);
  });

  it('adds no finding line to a caller or an implementer when the abstraction declares no code', () => {
    const tree = carriers();
    const bare: FixtureTree = {
      ...tree,
      interfaces: (tree.interfaces ?? []).map((i) => ({ ...i, methods: (i.methods as Record<string, unknown>[] | undefined)?.map(({ findings: _findings, ...m }) => m) })),
    };
    for (const agent of ['dhl-carrier-implementer', 'shipment-planner-implementer']) {
      const text = brief(bare, agent);
      expect(text).toContain('## Abstractions');
      expect(text).not.toMatch(/finding code/i);
    }
  });

  it('shows a code a new implementer declares on the next brief', () => {
    const tree = carriers();
    const grown: FixtureTree = {
      ...tree,
      interfaces: (tree.interfaces ?? []).map((i) => (i.id === 'idhl_carrier'
        ? { ...i, methods: [{ ...BOOK, findings: [{ code: 'DHL_SERVICE_POINT_ONLY', severity: 'warning', summary: 'The parcel can only go to a service point' }] }] }
        : i)),
    };
    const text = brief(grown, 'shipment-planner-implementer');
    expect(text).toMatch(/DHL_SERVICE_POINT_ONLY[^\n]*`dhl-carrier`/);
  });
});

describe('the brief of a caller of the carriers', () => {
  it('lists both codes with who raises them, and tells the caller to handle one by code and relay the other', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-abstraction-findings-')));
    roots.push(dir);
    materializeFixtureProject(dir, carriers());
    setProjectRoot(dir);
    invalidateSpecCache();
    const text = composeAgentBrief('shipment-planner-implementer').instructions;
    expect(text).toContain('MULTI_COLLO_UNSUPPORTED');
    expect(text).toContain('UPS_MANUAL_HANDOVER');
    expect(text).toMatch(/MULTI_COLLO_UNSUPPORTED[^\n]*`postnl-carrier`/);
    expect(text).toMatch(/UPS_MANUAL_HANDOVER[^\n]*`ups-carrier`/);
    expect(text).not.toMatch(/MULTI_COLLO_UNSUPPORTED[^\n]*`(ups|dhl)-carrier`/);
  });
});
