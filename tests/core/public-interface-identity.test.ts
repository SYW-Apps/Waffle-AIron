/**
 * The identity a subsystem's publicInterfaces merge by.
 *
 * An entry bound to a component is that component (and interface). An entry
 * NOT YET BOUND — the design-first state sdd_add_subsystem invites ("add them
 * later with sdd_set_public_interfaces") — names no component, so keyed by
 * component + interface every unbound entry had the same identity, and a delta
 * naming one of them silently folded it into the first. An unbound entry says
 * only its type and details, so that is what it is identified by.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import {
  invalidateSpecCache,
  loadSubsystemSpec,
  saveSubsystemSpec,
  saveSystemSpec,
  updateSpec,
} from '../../src/core/specs.js';
import type { PublicInterface, SubsystemSpec } from '../../src/models/specs.js';

const now = new Date().toISOString();
let roots: string[] = [];

const restA: PublicInterface = { type: 'REST', details: '/a' };
const busB: PublicInterface = { type: 'MessageBus', details: 'orders.created' };

function project(publicInterfaces: PublicInterface[]): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pi-identity-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'pi', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'S', vision: 'v', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now });
  saveSubsystemSpec({
    id: 'shop', name: 'Shop', description: 'd', parentSystem: 'S', publicInterfaces, trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  invalidateSpecCache();
}

const stored = (): PublicInterface[] => {
  invalidateSpecCache();
  return loadSubsystemSpec('shop')!.publicInterfaces;
};

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

describe('publicInterfaces merge — an unbound entry is its type and details', () => {
  it('keeps every unbound entry when a delta names a third one', () => {
    project([restA, busB]);
    const report = updateSpec('subsystem', 'shop', { publicInterfaces: [{ type: 'GraphQL', details: '/graphql' }] });
    expect(stored()).toEqual([restA, busB, { type: 'GraphQL', details: '/graphql' }]);
    // The change report names the new entry by what it says, not by an index.
    expect(report.changes).toEqual([expect.objectContaining({ path: 'publicInterfaces.GraphQL /graphql', change: 'added' })]);
  });

  it('removes exactly the unbound entry a delete marker names', () => {
    project([restA, busB]);
    // The SECOND entry: keyed by component + interface, the marker hit whichever came first.
    updateSpec('subsystem', 'shop', { publicInterfaces: [{ type: 'MessageBus', details: 'orders.created', action: 'delete' }] });
    expect(stored()).toEqual([restA]);
  });

  it('refuses a delete marker that names no stored entry', () => {
    project([restA, busB]);
    expect(() => updateSpec('subsystem', 'shop', { publicInterfaces: [{ type: 'REST', details: '/zzz', action: 'delete' }] }))
      .toThrow(/nothing with that identity exists/);
  });

  it('still keys a bound entry by its component and interface', () => {
    project([{ type: 'REST', details: '/old', component: 'portal' }, restA]);
    updateSpec('subsystem', 'shop', { publicInterfaces: [{ type: 'REST', details: '/new', component: 'portal' }] });
    expect(stored()).toEqual([{ type: 'REST', details: '/new', component: 'portal' }, restA]);
  });

  it('binding an unbound entry is a new identity: the delta adds it, and the unbound one stays until deleted', () => {
    project([restA]);
    updateSpec('subsystem', 'shop', { publicInterfaces: [{ ...restA, component: 'portal' }] });
    expect(stored()).toEqual([restA, { ...restA, component: 'portal' }]);
    // Binding in place is one delta: delete the unbound entry, add the bound one.
    updateSpec('subsystem', 'shop', { publicInterfaces: [{ ...restA, action: 'delete' }] });
    expect(stored()).toEqual([{ ...restA, component: 'portal' }]);
  });
});
