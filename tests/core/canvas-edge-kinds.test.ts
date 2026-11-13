import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { buildCanvasModel, type CanvasModel } from '../../src/core/canvas.js';
import {
  tempDir, isolateGlobals, projectYaml, system, subsystem, component, contract, implementation, type, specs, writeLedger,
} from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Canvas edges by kind: every dependency between drawn nodes shows, tagged
// with the strongest form it is stated in — `depends` (dependsOn), `calls` (a
// narrative call with no dependsOn beside it), `uses` (a type another project
// owns, named in a contract) and `declared` (a project declaring a member or
// external no other edge between the two shows). Real temp directories.
// ---------------------------------------------------------------------------

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
    try { c(); } catch { /* windows file locks */ }
  }
});

/**
 * A family: root `fam` with three contained project members — `ledger` (a
 * portal), `shared` (types only, nothing depends on it) and `sdk` (declares
 * ledger as an external and uses nothing of it). The root's checkout calls the
 * ledger in its narrative without a dependsOn, and names shared's money type.
 */
function writeFamily(): string {
  const root = tempDir(cleanups, 'wairon-kinds-');
  projectYaml(root, { id: 'fam', name: 'Fam', members: { ledger: 'ledger', shared: 'shared', sdk: 'sdk' } });
  system(root, 'Fam');
  subsystem(root, 'Fam', 'sales');
  component(root, 'sales', 'checkout', 'Adapter', ['basket']);
  component(root, 'sales', 'basket', 'Store');
  contract(root, 'sales', 'checkout', [{
    name: 'pay', description: 'Pay for the basket', signature: 'pay(amount: shared::money): void', returns: 'void',
    params: [{ name: 'amount', type: 'shared::money', description: 'The amount' }],
  }]);
  implementation(root, 'sales', 'checkout', 'icheckout', [{
    name: 'pay',
    narrative: [
      { stepNumber: 1, description: 'Read the basket', type: 'call', targetComponent: 'basket', targetMethod: 'read' },
      { stepNumber: 2, description: 'Post the amount to the ledger', type: 'call', targetComponent: 'ledger::ledger-portal', targetMethod: 'post' },
    ],
  }]);

  writeLedger(path.join(root, 'ledger'));

  const shared = path.join(root, 'shared');
  projectYaml(shared, { id: 'shared', name: 'Shared' });
  system(shared, 'Shared', [{ type: 'money', audience: 'instance' }]);
  type(specs(shared, 'types', 'money.yaml'), 'money', [{ name: 'cents', type: 'number' }]);

  const sdk = path.join(root, 'sdk');
  projectYaml(sdk, { id: 'sdk', name: 'Sdk', externals: { ledger: { source: { path: '../ledger' } } } });
  system(sdk, 'Sdk');
  subsystem(sdk, 'Sdk', 'kit');
  component(sdk, 'kit', 'runner', 'Orchestrator');
  return root;
}

function modelAt(dir: string): CanvasModel {
  setProjectRoot(dir);
  invalidateSpecCache();
  return buildCanvasModel([]);
}

const edge = (model: CanvasModel, from: string, to: string) => model.edges.find((e) => e.from === from && e.to === to);

describe('canvas edges by kind', () => {
  it('tags a dependsOn as depends, a narrative-only call as calls, a foreign type as uses, a bare declaration as declared', () => {
    const model = modelAt(writeFamily());
    expect(edge(model, 'checkout', 'basket'), JSON.stringify(model.edges)).toMatchObject({ kind: 'depends', cross: false });
    expect(edge(model, 'checkout', 'ledger::ledger-portal'), JSON.stringify(model.edges)).toMatchObject({ kind: 'calls', consumption: true });
    expect(edge(model, 'checkout', 'shared'), JSON.stringify(model.edges)).toMatchObject({ kind: 'uses', consumption: true, cross: true });
    expect(edge(model, 'sdk', 'ledger'), JSON.stringify(model.edges)).toMatchObject({ kind: 'declared', consumption: true });
  });

  it('keeps one edge per pair with the strongest kind', () => {
    const root = writeFamily();
    // The checkout now also states the ledger dependency: the call no longer adds its own edge.
    component(root, 'sales', 'checkout', 'Adapter', ['basket', 'ledger::ledger-portal']);
    const model = modelAt(root);
    const toLedger = model.edges.filter((e) => e.from === 'checkout' && e.to === 'ledger::ledger-portal');
    expect(toLedger).toEqual([expect.objectContaining({ kind: 'depends' })]);
    expect(model.edges.filter((e) => e.from === 'checkout' && e.to === 'basket')).toHaveLength(1);
  });

  it('draws no declared edge when another edge between the two projects already shows the relation', () => {
    const root = writeFamily();
    const sdk = path.join(root, 'sdk');
    component(sdk, 'kit', 'runner', 'Orchestrator', ['ledger::ledger-portal']);
    const model = modelAt(root);
    expect(edge(model, 'sdk::runner', 'ledger::ledger-portal') ?? edge(model, 'runner', 'ledger::ledger-portal'), JSON.stringify(model.edges)).toMatchObject({ kind: 'depends' });
    expect(edge(model, 'sdk', 'ledger')).toBeUndefined();
  });
});
