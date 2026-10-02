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
// Two merge defects of sdd_update_spec (friction F86 and F87).
//
// F86: a delta that ADDS an element whose stored form always carries an array
// (an implementation method's `narrative`) crashed with a raw TypeError when
// the delta left the array out. An absent narrative on a new method now reads
// as [] — the intent-level method it is everywhere else in the schema.
//
// F87: a jump the delta WRITES is in the numbering the delta leaves behind,
// after all of its inserts and deletes. A later insert of the same delta used
// to relocate it as if it were a stored jump, so a branch inserted together
// with a later step pointed one step too far.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function seedTree(proj: string): void {
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  setProjectRoot(proj);
  saveSpec('subsystem', {
    schemaVersion: '1.0.0',
    id: 'billing',
    name: 'Billing',
    description: 'Billing',
    parentSystem: 'GK',
    publicInterfaces: [],
    createdAt: now,
    updatedAt: now,
  });
  saveInterfaceSpec({
    id: 'iflow',
    name: 'IFlow',
    description: 'The flow contract',
    component: 'flow_comp',
    methods: [
      { name: 'run', description: 'runs the flow', signature: 'run(): void', returns: 'void', params: [] },
      { name: 'drain', description: 'drains the flow', signature: 'drain(): void', returns: 'void', params: [] },
    ],
    createdAt: now,
    updatedAt: now,
  });
}

function saveNarrative(narrative: Record<string, unknown>[]): void {
  saveImplementationSpec({
    id: 'flow_impl',
    name: 'FlowImpl',
    description: 'The flow implementation',
    contract: 'iflow',
    methods: [{ name: 'run', narrative } as never],
    createdAt: now,
    updatedAt: now,
  } as never);
}

const steps = (): Record<string, any>[] =>
  loadImplementationSpec('flow_impl')!.methods[0].narrative as unknown as Record<string, any>[];

/** The control flow alone: number, type and every jump, one line per step. */
const flow = (): string[] => steps().map((s) => {
  const jumps = ['onTrueStep', 'onFalseStep', 'toStep', 'endStep', 'defaultStep', 'finallyStep']
    .filter((f) => s[f] !== undefined).map((f) => `${f}=${s[f]}`);
  for (const c of s.cases ?? []) jumps.push(`case ${c.value}=${c.step}`);
  return `${s.stepNumber} ${s.type}${jumps.length ? ` ${jumps.join(' ')}` : ''}`;
});

describe('delta merge: new elements without their arrays (F86)', () => {
  let proj = '';
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('adds an implementation method with no narrative as an intent-level method', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f86-'));
    seedTree(proj);
    saveNarrative([{ stepNumber: 1, description: 'run it', type: 'local' }]);

    const report = updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'drain', detail: 'intent', intent: 'Drains every queued item, then returns.' }],
    });

    const drain = loadImplementationSpec('flow_impl')!.methods.find((m) => m.name === 'drain')!;
    expect(drain).toMatchObject({ name: 'drain', detail: 'intent', intent: 'Drains every queued item, then returns.' });
    expect(drain.narrative).toEqual([]);
    expect(report.written).toBe(true);
  });

  it('adds a method whose narrative is given, and one with an empty narrative, in one delta', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f86-both-'));
    seedTree(proj);
    saveImplementationSpec({
      id: 'flow_impl', name: 'FlowImpl', description: 'The flow implementation', contract: 'iflow',
      methods: [], createdAt: now, updatedAt: now,
    } as never);

    updateSpec('implementation', 'flow_impl', {
      methods: [
        { name: 'run', narrative: [{ stepNumber: 1, description: 'run it', type: 'local' }] },
        { name: 'drain' },
      ],
    });

    const methods = loadImplementationSpec('flow_impl')!.methods;
    expect(methods.map((m) => [m.name, m.narrative.length])).toEqual([['run', 1], ['drain', 0]]);
  });

  it('adds an interface method with no params', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f86-intf-'));
    seedTree(proj);

    updateSpec('interface', 'iflow', {
      methods: [{ name: 'pause', description: 'pauses the flow', signature: 'pause(): void', returns: 'void' }],
    });

    expect(loadInterfaceSpec('iflow')!.methods.map((m) => m.name)).toEqual(['run', 'drain', 'pause']);
  });

  it('writes a spec whose defaulted list an unset removed, instead of throwing on it', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f86-unset-'));
    seedTree(proj);

    // The same crash class one step over: the write path read these lists
    // before the schema could default them, so removing one threw a TypeError.
    updateSpec('subsystem', 'billing', { description: 'Billing, renamed', unset: ['publicInterfaces'] });
    updateSpec('interface', 'iflow', { description: 'The flow contract, restated', unset: ['methods'] });

    expect(loadInterfaceSpec('iflow')!.methods).toEqual([]);
  });

  it('still refuses a new method whose narrative is not a list, naming the field', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f86-bad-'));
    seedTree(proj);
    saveNarrative([{ stepNumber: 1, description: 'run it', type: 'local' }]);

    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'drain', narrative: 'drain the queue' }],
    })).toThrow(/narrative/);
  });
});

describe('delta merge: jumps a delta writes are in its final numbering (F87)', () => {
  let proj = '';
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  it('keeps an inserted branch on its target when a later step is inserted in the same delta', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'read the order', type: 'local' },
      { stepNumber: 2, description: 'charge it', type: 'local' },
      { stepNumber: 3, description: 'done', type: 'return', outcome: 'charged' },
    ]);

    // Final narrative: 1 read, 2 branch (false -> 4), 3 charge, 4 throw, 5 return.
    // The branch's onFalseStep names step 4 in THAT numbering.
    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'insert', description: 'is it payable?', type: 'branch', condition: 'payable', onFalseStep: 4 },
          { stepNumber: 4, action: 'insert', description: 'refuse it', type: 'throw', error: 'NotPayable' },
        ],
      }],
    });

    expect(flow()).toEqual([
      '1 local',
      '2 branch onFalseStep=4',
      '3 local',
      '4 throw',
      '5 return',
    ]);
  });

  it('keeps a written jump in final numbering across a delete and an insert', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-del-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'fast path', onFalseStep: 4 },
      { stepNumber: 2, description: 'obsolete note', type: 'local' },
      { stepNumber: 3, description: 'fast', type: 'return', outcome: 'fast' },
      { stepNumber: 4, description: 'slow', type: 'local' },
      { stepNumber: 5, description: 'done', type: 'return', outcome: 'slow' },
    ]);

    // Delete step 2, then (in the numbering that leaves) insert a jump at 3 aimed
    // at final step 5, and a local at 4. Final: 1 branch, 2 return fast, 3 jump,
    // 4 local (new), 5 slow, 6 return slow.
    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'delete', description: 'obsolete note' },
          { stepNumber: 3, action: 'insert', description: 'skip to the slow path', type: 'jump', toStep: 5 },
          { stepNumber: 4, action: 'insert', description: 'log it', type: 'local' },
        ],
      }],
    });

    expect(flow()).toEqual([
      // The STORED jump (1 -> slow, was 4) follows its target through the
      // delete and both inserts: 4 -> 3 -> 4 -> 5.
      '1 branch onFalseStep=5',
      '2 return',
      '3 jump toStep=5',
      '4 local',
      '5 local',
      '6 return',
    ]);
  });

  it('keeps a jump an in-place edit writes in final numbering when a later insert follows', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-edit-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'ok', onFalseStep: 2 },
      { stepNumber: 2, description: 'fail', type: 'return', outcome: 'failed' },
      { stepNumber: 3, description: 'work', type: 'local' },
      { stepNumber: 4, description: 'done', type: 'return', outcome: 'ok' },
    ]);

    // Retarget step 1 to final step 5 ("done") and insert a step at 3.
    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, onFalseStep: 5 },
          { stepNumber: 3, action: 'insert', description: 'prepare', type: 'local' },
        ],
      }],
    });

    expect(flow()).toEqual(['1 branch onFalseStep=5', '2 return', '3 local', '4 local', '5 return']);
    expect(steps()[4].outcome).toBe('ok');
  });

  it('resolves label jumps alongside numeric ones in the same delta', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-label-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'read', type: 'local' },
      { stepNumber: 2, label: 'finish', description: 'done', type: 'return', outcome: 'ok' },
    ]);

    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'insert', description: 'valid?', type: 'branch', condition: 'valid', onFalseStep: 4, onTrueLabel: 'finish' },
          { stepNumber: 3, action: 'insert', description: 'skip', type: 'jump', toLabel: 'finish' },
          { stepNumber: 4, action: 'insert', description: 'reject', type: 'throw', error: 'Invalid' },
        ],
      }],
    });

    expect(flow()).toEqual([
      '1 local',
      '2 branch onTrueStep=5 onFalseStep=4',
      '3 jump toStep=5',
      '4 throw',
      '5 return',
    ]);
  });

  it('still relocates stored jumps around an insert, and captureJumps still captures them', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-stored-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'ok', onFalseStep: 3 },
      { stepNumber: 2, description: 'work', type: 'local' },
      { stepNumber: 3, description: 'fail', type: 'return', outcome: 'failed' },
    ]);

    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'insert', description: 'prepare', type: 'local' },
          { stepNumber: 4, action: 'insert', description: 'audit the failure', type: 'local', captureJumps: true },
        ],
      }],
    });

    // The stored jump at 3 followed the first insert to 4, then the second
    // insert at 4 captured it.
    expect(flow()).toEqual(['1 branch onFalseStep=4', '2 local', '3 local', '4 local', '5 return']);
  });

  it('does not refuse a delete because a jump the delta wrote names that number in the final numbering', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-f87-guard-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'read', type: 'local' },
      { stepNumber: 2, description: 'stale', type: 'local' },
      { stepNumber: 3, description: 'note', type: 'local' },
      { stepNumber: 4, description: 'done', type: 'return', outcome: 'ok' },
    ]);

    // Insert at 2 a jump to final 4; then delete step 4 (the stale step, now at
    // 3 + 1). Final: 1 read, 2 jump -> 4, 3 note, 4 return.
    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'insert', description: 'skip ahead', type: 'jump', toStep: 4 },
          { stepNumber: 3, action: 'delete', description: 'stale' },
        ],
      }],
    });

    expect(flow()).toEqual(['1 local', '2 jump toStep=4', '3 local', '4 return']);
  });
});
