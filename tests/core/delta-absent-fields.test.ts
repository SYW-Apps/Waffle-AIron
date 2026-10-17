import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadImplementationSpec,
  loadInterfaceSpec,
  updateSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';

// ---------------------------------------------------------------------------
// F88: a field an sdd_update_spec delta element leaves out never resets the
// stored value — at any depth.
//
// An element merges field by field. Absent, null and undefined all mean "no
// change" (the tool's contract, honoured at the top level for a long time);
// only an explicit `[]` or an `unset` clears. The element merge was a shallow
// spread, so a key present with no value replaced the stored one: undefined
// erased an interface method's params or a try step's catches, and null was
// refused by the schema instead of being "no change".
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function seedTree(proj: string): void {
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  setProjectRoot(proj);
  saveSpec('subsystem', {
    schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'Billing', parentSystem: 'GK',
    publicInterfaces: [], createdAt: now, updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'iflow', name: 'IFlow', description: 'The flow contract', component: 'flow_comp',
    methods: [
      {
        name: 'run', description: 'runs the flow', signature: 'run(order: string): void', returns: 'void',
        params: [{ name: 'order', type: 'string' }],
      },
      { name: 'drain', description: 'drains the flow', signature: 'drain(): void', returns: 'void', params: [] },
    ],
    createdAt: now, updatedAt: now,
  } as never);
  saveImplementationSpec({
    id: 'flow_impl', name: 'FlowImpl', description: 'The flow implementation', contract: 'iflow',
    methods: [
      {
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'charge it', type: 'try', endStep: 2, catches: [{ error: 'Declined', step: 3 }] },
          { stepNumber: 2, description: 'record it', type: 'local' },
          { stepNumber: 3, description: 'done', type: 'return', outcome: 'charged' },
        ],
      },
      {
        name: 'drain',
        narrative: [
          { stepNumber: 1, description: 'drain the queue', type: 'local' },
          { stepNumber: 2, description: 'done', type: 'return', outcome: 'drained' },
        ],
      },
    ],
    createdAt: now, updatedAt: now,
  } as never);
}

const implMethod = (name: string) => loadImplementationSpec('flow_impl')!.methods.find((m) => m.name === name)!;
const intfMethod = (name: string) => loadInterfaceSpec('iflow')!.methods.find((m) => m.name === name)!;

describe('delta merge: a field an element leaves out keeps its stored value (F88)', () => {
  let proj = '';
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  const fresh = (tag: string): void => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), `wairon-delta-f88-${tag}-`));
    seedTree(proj);
  };

  const strays: [string, Record<string, unknown>][] = [
    ['absent', { name: 'drain' }],
    ['undefined', { name: 'drain', narrative: undefined }],
    ['null', { name: 'drain', narrative: null }],
    ['absent, another field set', { name: 'drain', detail: 'intent', intent: 'Drains every queued item.' }],
  ];
  for (const [label, stray] of strays) {
    it(`keeps a stray method's narrative when the delta names it with its narrative ${label}`, () => {
      fresh('stray');
      const before = implMethod('drain').narrative;
      const report = updateSpec('implementation', 'flow_impl', {
        methods: [{ name: 'run', narrative: [{ stepNumber: 2, description: 'record the charge' }] }, stray],
      });
      expect(implMethod('drain').narrative).toEqual(before);
      expect(implMethod('run').narrative[1].description).toBe('record the charge');
      expect(report.changes.some((c) => c.path.startsWith('methods.drain.narrative'))).toBe(false);
    });
  }

  it('clears a narrative only when the delta says so with [], and reports it as cleared', () => {
    // The shape of the incident that raised F88: the stray entry carried an
    // explicit `narrative: []`, which is the documented way to clear a list —
    // and the change report names it, by path, as "cleared".
    fresh('clear');
    const report = updateSpec('implementation', 'flow_impl', { methods: [{ name: 'drain', narrative: [] }] }, undefined, true);
    expect(report.changes.find((c) => c.path === 'methods.drain.narrative')?.change).toBe('cleared');
    expect(implMethod('drain').narrative).toHaveLength(2); // a dry run writes nothing
  });

  for (const [label, value] of [['undefined', undefined], ['null', null]] as const) {
    it(`keeps an interface method's params when the delta passes them ${label}`, () => {
      fresh(`params-${label}`);
      updateSpec('interface', 'iflow', { methods: [{ name: 'run', description: 'runs the whole flow', params: value }] });
      expect(intfMethod('run')).toMatchObject({ description: 'runs the whole flow', params: [{ name: 'order', type: 'string' }] });
    });

    it(`keeps a step's catches and region when the delta passes them ${label}`, () => {
      fresh(`catches-${label}`);
      updateSpec('implementation', 'flow_impl', {
        methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'charge the card', catches: value, endStep: value }] }],
      });
      expect(implMethod('run').narrative[0]).toMatchObject({
        description: 'charge the card', endStep: 2, catches: [{ error: 'Declined', step: 3 }],
      });
    });

    it(`keeps a method's description when the delta passes it ${label}`, () => {
      fresh(`desc-${label}`);
      updateSpec('interface', 'iflow', { methods: [{ name: 'run', description: value, returns: 'boolean' }] });
      // The alias the delta writes is stored canonical (stage 2: the writer respells it).
      expect(intfMethod('run')).toMatchObject({ description: 'runs the flow', returns: 'bool' });
    });
  }

  it('still clears params with [] and removes a field with unset', () => {
    fresh('explicit');
    updateSpec('interface', 'iflow', { methods: [{ name: 'run', params: [] }] });
    expect(intfMethod('run').params ?? []).toEqual([]);
    updateSpec('implementation', 'flow_impl', { methods: [{ name: 'drain', detail: 'intent' }] });
    updateSpec('implementation', 'flow_impl', { methods: [{ name: 'drain', unset: ['detail'] }] });
    expect(implMethod('drain').detail).toBeUndefined();
    expect(implMethod('drain').narrative).toHaveLength(2);
  });
});
