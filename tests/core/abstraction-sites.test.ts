import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { renameComponent, renameMethod } from '../../src/core/provision.js';
import { materializeFixtureProject, type FixtureTree } from '../rules-matrix/harness.js';

// A finding of the abstraction rules that a lint.allow silences stays silenced
// when the method or component it names is renamed: the allow follows, as
// sdd_rename_method and sdd_rename_component promise.

const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const ship = (findings?: { code: string; severity: string; summary: string }[]) => ({
  name: 'ship', description: 'Ship one parcel to where it goes.', params: [{ name: 'parcel', type: 'string' }], returns: 'void', ...(findings ? { findings } : {}),
});

function shipping(): void {
  const tree: FixtureTree = {
    system: { name: 'Shipping', vision: 'Ships parcels with several carriers.' },
    subsystems: [{ id: 'shipping', description: 'Shipping of parcels.' }],
    components: [
      {
        id: 'parcel-carrier', componentType: 'Adapter', abstract: true,
        lint: { allow: [{ code: 'ABSTRACTION_FINDING_UNRAISED', at: 'HEAVY_PARCEL', covers: ['parcel-carrier.ship'], reason: 'The heavy carrier is added next quarter.' }] },
      },
      { id: 'dhl-carrier', componentType: 'Adapter' },
      { id: 'ups-carrier', componentType: 'Adapter' },
      {
        id: 'checkout', componentType: 'Orchestrator', dependsOn: ['dhl-carrier'],
        lint: { allow: [{ code: 'ABSTRACTION_BYPASSED', at: 'checkout -> dhl-carrier', covers: ['dhl-carrier.ship'], reason: 'Only DHL serves the pilot lane.' }] },
      },
    ],
    interfaces: [
      { id: 'iparcel_carrier', component: 'parcel-carrier', methods: [ship([{ code: 'HEAVY_PARCEL', severity: 'error', summary: 'The parcel is too heavy for the carrier.' }])] },
      { id: 'idhl_carrier', component: 'dhl-carrier', implements: ['parcel-carrier'], methods: [ship()] },
      { id: 'iups_carrier', component: 'ups-carrier', implements: ['parcel-carrier'], methods: [ship()] },
      { id: 'icheckout', component: 'checkout', methods: [{ name: 'placeOrder' }] },
    ],
    implementations: [
      { id: 'checkout_impl', contract: 'icheckout', methods: [{ name: 'placeOrder', narrative: [{ stepNumber: 1, type: 'call', description: 'Ship the order with DHL.', targetComponent: 'dhl-carrier', targetMethod: 'ship' }] }] },
    ],
  };
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-abstraction-sites-')));
  roots.push(dir);
  materializeFixtureProject(dir, tree);
  setProjectRoot(dir);
  invalidateSpecCache();
}

function judged(): string[] {
  invalidateSpecCache();
  return validateProject().issues
    .filter((i) => i.severity === 'warning' && ['ABSTRACTION_FINDING_UNRAISED', 'ABSTRACTION_BYPASSED', 'STALE_LINT_ALLOW'].includes(i.code))
    .map((i) => `${i.code} @${i.specId}`);
}

describe('the sites of the abstraction findings', () => {
  it('are silenced by an allow naming them', () => {
    shipping();
    expect(judged()).toEqual([]);
  });

  it('follow a method rename', () => {
    shipping();
    renameMethod('parcel-carrier', 'ship', 'dispatch');
    expect(judged()).toEqual([]);
  });

  it('follow a rename of the implementer', () => {
    shipping();
    renameComponent('dhl-carrier', 'dhl-express');
    expect(judged()).toEqual([]);
  });
});
