/**
 * Callers to review: a write that changes a contract method's signature names who
 * calls it, design and code, as information only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { updateSpecGated, writeSpec } from '../../src/core/authoring.js';

const now = new Date().toISOString();
let projects: string[] = [];

afterEach(() => {
  for (const proj of projects) fs.rmSync(proj, { recursive: true, force: true });
  projects = [];
  invalidateSpecCache();
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** carrier.ship(order) called by desk.dispatch (desk_impl), realized in src/desk.ts line 7. */
function seed(): string {
  invalidateSpecCache();
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-callers-')));
  projects.push(proj);
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'callers-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    createdAt: now, updatedAt: now,
  }));
  setProjectRoot(proj);
  saveSpec('subsystem', {
    schemaVersion: '1.0.0', id: 'shipping', name: 'Shipping', description: 'Shipping',
    parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
  });
  saveComponentSpec({
    id: 'carrier', name: 'Carrier', description: 'Ships', subsystem: 'shipping',
    componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  });
  saveComponentSpec({
    id: 'desk', name: 'Desk', description: 'Dispatches', subsystem: 'shipping',
    componentType: 'Orchestrator', owns: [], dependsOn: ['carrier'], status: 'complete', createdAt: now, updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'icarrier', name: 'ICarrier', description: 'carrier', component: 'carrier',
    methods: [{
      name: 'ship', description: 'ships', signature: 'ship(order: string)', returns: 'void',
      params: [{ name: 'order', type: 'string', description: 'the order' }],
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'idesk', name: 'IDesk', description: 'desk', component: 'desk',
    methods: [{
      name: 'dispatch', description: 'dispatches', signature: 'dispatch(order: string)', returns: 'void',
      params: [{ name: 'order', type: 'string', description: 'the order' }],
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  saveImplementationSpec({
    id: 'carrier_impl', name: 'CarrierImpl', description: 'carrier impl', contract: 'icarrier',
    sourcePath: 'src/carrier.ts',
    methods: [{ name: 'ship', symbol: 'ship', narrative: [{ stepNumber: 1, description: 'ship it', type: 'local' }] } as never],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  saveImplementationSpec({
    id: 'desk_impl', name: 'DeskImpl', description: 'desk impl', contract: 'idesk',
    sourcePath: 'src/desk.ts',
    methods: [{
      name: 'dispatch', symbol: 'dispatch',
      narrative: [{ stepNumber: 1, description: 'hand it to the carrier', type: 'call', targetComponent: 'carrier', targetMethod: 'ship' }],
    } as never],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  write(proj, 'src/carrier.ts', 'export function ship(order: string): void {\n  void order;\n}\n');
  write(proj, 'src/desk.ts', [
    "import { ship } from './carrier.js';",
    '',
    '// the desk',
    'export function dispatch(order: string): void {',
    '  // step 1',
    '',
    '  ship(order);',
    '}',
    '',
  ].join('\n'));
  invalidateSpecCache();
  return proj;
}

const addReference = {
  methods: [{
    name: 'ship',
    params: [
      { name: 'order', type: 'string', description: 'the order' },
      { name: 'reference', type: 'string', description: 'the reference', optional: true },
    ],
  }],
};

describe('callersToReview on a change report', () => {
  it('names the calling spec and the code site when a parameter is added', () => {
    seed();
    const report = updateSpecGated('interface', 'icarrier', addReference);
    expect(report.written).toBe(true);
    expect(report.callersToReview).toHaveLength(1);
    const [entry] = report.callersToReview!;
    expect(entry.method).toBe('carrier.ship');
    expect(entry.change).toMatch(/reference/);
    expect(entry.callers).toContain('desk.dispatch');
    expect(entry.callers).toContain('src/desk.ts:7');
    expect(entry.total).toBe(entry.callers.length);
  });

  it('names them on a dry run too', () => {
    seed();
    const report = updateSpecGated('interface', 'icarrier', addReference, true);
    expect(report.dryRun).toBe(true);
    expect(report.written).toBe(false);
    expect(report.callersToReview?.[0]?.callers).toContain('desk.dispatch');
  });

  it('names none when only a description changed', () => {
    seed();
    const report = updateSpecGated('interface', 'icarrier', { methods: [{ name: 'ship', description: 'ships again' }] });
    expect(report.written).toBe(true);
    expect(report.callersToReview).toBeUndefined();
  });

  it('names a returns change', () => {
    seed();
    const report = updateSpecGated('interface', 'icarrier', { methods: [{ name: 'ship', returns: 'async void' }] });
    expect(report.callersToReview?.[0]?.change).toMatch(/returns/);
  });
});

describe('callersToReview — cap and abstraction', () => {
  it('lists at most ten callers and states the total', () => {
    seed();
    for (let i = 0; i < 12; i += 1) {
      saveComponentSpec({
        id: `extra${i}`, name: `Extra${i}`, description: 'Calls', subsystem: 'shipping',
        componentType: 'Orchestrator', owns: [], dependsOn: ['carrier'], status: 'complete', createdAt: now, updatedAt: now,
      });
      saveInterfaceSpec({
        id: `iextra${i}`, name: `IExtra${i}`, description: 'extra', component: `extra${i}`,
        methods: [{ name: 'go', description: 'goes', signature: 'go(): void', returns: 'void' }],
        status: 'complete', createdAt: now, updatedAt: now,
      });
      saveImplementationSpec({
        id: `extra${i}_impl`, name: `Extra${i}Impl`, description: 'extra impl', contract: `iextra${i}`,
        methods: [{ name: 'go', narrative: [{ stepNumber: 1, description: 'ship', type: 'call', targetComponent: 'carrier', targetMethod: 'ship' }] } as never],
        status: 'complete', createdAt: now, updatedAt: now,
      });
    }
    invalidateSpecCache();
    const report = updateSpecGated('interface', 'icarrier', addReference, true);
    const [entry] = report.callersToReview!;
    expect(entry.callers).toHaveLength(10);
    expect(entry.total).toBeGreaterThan(10);
  });

  it('names the callers of the abstraction method the contract implements', () => {
    seed();
    saveComponentSpec({
      id: 'shipper', name: 'Shipper', description: 'abstract', subsystem: 'shipping', abstract: true,
      componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveComponentSpec({
      id: 'yard', name: 'Yard', description: 'Calls the abstraction', subsystem: 'shipping',
      componentType: 'Orchestrator', owns: [], dependsOn: ['shipper'], status: 'complete', createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'ishipper', name: 'IShipper', description: 'shipper', component: 'shipper',
      methods: [{
        name: 'ship', description: 'ships', signature: 'ship(order: string)', returns: 'void',
        params: [{ name: 'order', type: 'string', description: 'the order' }],
      }],
      status: 'complete', createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'iyard', name: 'IYard', description: 'yard', component: 'yard',
      methods: [{ name: 'load', description: 'loads', signature: 'load(order: string)', returns: 'void', params: [{ name: 'order', type: 'string', description: 'the order' }] }],
      status: 'complete', createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'yard_impl', name: 'YardImpl', description: 'yard impl', contract: 'iyard',
      methods: [{ name: 'load', narrative: [{ stepNumber: 1, description: 'ship through the abstraction', type: 'call', targetComponent: 'shipper', targetMethod: 'ship' }] } as never],
      status: 'complete', createdAt: now, updatedAt: now,
    });
    updateSpecGated('interface', 'icarrier', { implements: ['shipper'] });
    invalidateSpecCache();
    const report = updateSpecGated('interface', 'icarrier', addReference, true);
    expect(report.callersToReview?.[0]?.callers).toContain('yard.load');
  });
});

describe('callersToReview on a write receipt', () => {
  it('names the callers when a restated contract changes a signature', () => {
    seed();
    const receipt = writeSpec({
      kind: 'interface',
      spec: {
        id: 'icarrier', name: 'ICarrier', description: 'carrier', component: 'carrier',
        methods: [{
          name: 'ship', description: 'ships', returns: 'void',
          params: [
            { name: 'order', type: 'string', description: 'the order' },
            { name: 'reference', type: 'string', description: 'the reference', optional: true },
          ],
        }],
      },
      fields: ['id', 'name', 'description', 'component', 'methods'],
      memberFields: ['name', 'description', 'returns', 'params'],
    } as never);
    expect(receipt.callersToReview?.[0]?.method).toBe('carrier.ship');
    expect(receipt.callersToReview?.[0]?.callers).toContain('desk.dispatch');
  });
});

/** carrier <- parcel_carrier <- dhl, each restating quote(weight) and book(order); `hall` calls parcel_carrier.book and .quote. */
function seedChain(): void {
  invalidateSpecCache();
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-chain-')));
  projects.push(proj);
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'chain-project',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    createdAt: now, updatedAt: now,
  }));
  setProjectRoot(proj);
  saveSpec('subsystem', {
    schemaVersion: '1.0.0', id: 'shipping', name: 'Shipping', description: 'Shipping',
    parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
  });
  const component = (id: string, extra: Record<string, unknown>) => saveComponentSpec({
    id, name: id, description: id, subsystem: 'shipping', componentType: 'Orchestrator', owns: [], dependsOn: [],
    status: 'complete', createdAt: now, updatedAt: now, ...extra,
  } as never);
  component('carrier', { abstract: true });
  component('parcel_carrier', { abstract: true });
  component('dhl', {});
  component('hall', { dependsOn: ['parcel_carrier'] });
  const methods = [
    { name: 'quote', description: 'quotes', signature: 'quote(weight: string)', returns: 'void', params: [{ name: 'weight', type: 'string', description: 'w' }] },
    { name: 'book', description: 'books', signature: 'book(order: string)', returns: 'void', params: [{ name: 'order', type: 'string', description: 'o' }] },
  ];
  saveInterfaceSpec({ id: 'icarrier', name: 'ICarrier', description: 'c', component: 'carrier', methods, status: 'complete', createdAt: now, updatedAt: now } as never);
  saveInterfaceSpec({ id: 'iparcel_carrier', name: 'IParcel', description: 'c', component: 'parcel_carrier', implements: ['carrier'], methods, status: 'complete', createdAt: now, updatedAt: now } as never);
  saveInterfaceSpec({ id: 'idhl', name: 'IDhl', description: 'c', component: 'dhl', implements: ['parcel_carrier'], methods, status: 'complete', createdAt: now, updatedAt: now } as never);
  saveInterfaceSpec({
    id: 'ihall', name: 'IHall', description: 'h', component: 'hall', status: 'complete', createdAt: now, updatedAt: now,
    methods: [{ name: 'run', description: 'runs', signature: 'run(): void', returns: 'void' }],
  } as never);
  saveImplementationSpec({
    id: 'hall_impl', name: 'HallImpl', description: 'hall', contract: 'ihall',
    methods: [{
      name: 'run',
      narrative: [
        { stepNumber: 1, description: 'book', type: 'call', targetComponent: 'parcel_carrier', targetMethod: 'book' },
        { stepNumber: 2, description: 'quote', type: 'call', targetComponent: 'parcel_carrier', targetMethod: 'quote' },
      ],
    } as never],
    status: 'complete', createdAt: now, updatedAt: now,
  });
  invalidateSpecCache();
}

describe('an abstraction chain', () => {
  it('lists the callers through a narrower abstraction and the contracts restating the method', async () => {
    seedChain();
    const { findReferences } = await import('../../src/core/validation.js');
    const found = findReferences('carrier.book', false);
    expect(found.target?.id).toBe('carrier.book');
    const callers = found.references.filter((r) => r.kind === 'call-step');
    expect(callers).toEqual([expect.objectContaining({ fromSpec: 'hall_impl', fromMember: 'run', through: 'parcel_carrier' })]);
    expect(found.references.filter((r) => r.kind === 'implements').map((r) => r.fromSpec).sort()).toEqual(['idhl', 'iparcel_carrier']);
    expect(found.impact).not.toBe('none');
  });

  it('confirms a code call through a narrower declaration on abstractions whose implementations list no methods', async () => {
    seedChain();
    const proj = projects[projects.length - 1];
    write(proj, 'src/carrier.ts', 'export interface Carrier { quote(weight: string): void; book(order: string): void; }\n');
    write(proj, 'src/parcel.ts', "import { Carrier } from './carrier';\nexport interface ParcelCarrier extends Carrier { }\n");
    write(proj, 'src/hall.ts', "import { ParcelCarrier } from './parcel';\nexport class Hall {\n  constructor(private readonly parcel: ParcelCarrier) {}\n  run(): void { this.parcel.book('o'); this.parcel.quote('1'); }\n}\n");
    // Code linkage only: the abstractions' implementations name their file and list no methods.
    saveImplementationSpec({ id: 'carrier_impl', name: 'CarrierImpl', description: 'c', contract: 'icarrier', sourcePath: 'src/carrier.ts', methods: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveImplementationSpec({ id: 'parcel_carrier_impl', name: 'ParcelImpl', description: 'p', contract: 'iparcel_carrier', sourcePath: 'src/parcel.ts', methods: [], status: 'complete', createdAt: now, updatedAt: now } as never);
    saveImplementationSpec({
      id: 'hall_impl', name: 'HallImpl', description: 'hall', contract: 'ihall', sourcePath: 'src/hall.ts',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'book', type: 'call', targetComponent: 'parcel_carrier', targetMethod: 'book' },
          { stepNumber: 2, description: 'quote', type: 'call', targetComponent: 'parcel_carrier', targetMethod: 'quote' },
        ],
      } as never],
      status: 'complete', createdAt: now, updatedAt: now,
    });
    invalidateSpecCache();
    const { findReferences } = await import('../../src/core/validation.js');
    for (const target of ['parcel_carrier.book', 'carrier.book']) {
      const found = findReferences(target, false);
      const step = found.references.find((r) => r.kind === 'call-step' && r.fromSpec === 'hall_impl');
      expect(step?.agreement, target).toBe('confirmed');
      expect(found.references.some((r) => r.kind === 'code-call' && r.file === 'src/hall.ts' && r.agreement === 'confirmed'), target).toBe(true);
    }
  });

  it('names the callers and the implementers when a signature of the topmost abstraction changes', () => {
    seedChain();
    const report = updateSpecGated('interface', 'icarrier', {
      methods: [{ name: 'quote', params: [{ name: 'weight', type: 'string', description: 'w' }, { name: 'zone', type: 'string', description: 'z', optional: true }] }],
    }, true);
    const [entry] = report.callersToReview!;
    expect(entry.method).toBe('carrier.quote');
    expect(entry.callers).toContain('hall.run');
    expect(entry.implementers?.sort()).toEqual(['idhl.quote', 'iparcel_carrier.quote']);
  });

  it('leaves out an implementer that already restates the new signature', () => {
    seedChain();
    updateSpecGated('interface', 'idhl', { methods: [{ name: 'quote', params: [{ name: 'weight', type: 'string', description: 'w' }, { name: 'zone', type: 'string', description: 'z', optional: true }] }] });
    invalidateSpecCache();
    const report = updateSpecGated('interface', 'icarrier', {
      methods: [{ name: 'quote', params: [{ name: 'weight', type: 'string', description: 'w' }, { name: 'zone', type: 'string', description: 'z', optional: true }] }],
    }, true);
    expect(report.callersToReview?.[0]?.implementers).toEqual(['iparcel_carrier.quote']);
  });
});
