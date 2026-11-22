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
