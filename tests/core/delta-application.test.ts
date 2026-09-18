import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSubsystemSpec,
  saveInterfaceSpec,
  loadInterfaceSpec,
  saveImplementationSpec,
  loadImplementationSpec,
  updateSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { stepConfigVerdict } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// How an update DELTA applies to a stored spec.
//
// The merge is the part of authoring a caller cannot see: it answers
// "successfully updated" whatever it did, so a rule it gets wrong shows up as a
// spec nobody remembers writing. These are the four rules that were not true
// of it — a retype that left the old type's fields standing, a label that could
// not retarget a jump, a region header that could be deleted out from under its
// body, and the identity promise that stopped one level below the spec's own
// fields.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function seedTree(proj: string): void {
  fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
  setProjectRoot(proj);
  saveSubsystemSpec({
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
    methods: [{
      name: 'run',
      description: 'runs the flow',
      signature: 'run(payload: string, attempts: number)',
      returns: 'void',
      params: [
        { name: 'payload', type: 'string', description: 'what to run' },
        { name: 'attempts', type: 'number', description: 'how often to retry' },
      ],
    }],
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

describe('delta application', () => {
  let proj = '';
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  // -- A3: a type change rebuilds the step ----------------------------------

  it('rebuilds a step whose type changes, keeping its description and label', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-retype-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, label: 'check', description: 'decide whether the payload is usable', type: 'branch', condition: 'payload is valid', onFalseStep: 2 },
      { stepNumber: 2, description: 'bail out', type: 'return', outcome: 'invalid' },
    ]);

    const report = updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'flow_store', targetMethod: 'put' }],
      }],
    });

    // The rebuilt step carries exactly what a call step may carry — the branch's
    // condition and onFalseStep are gone, the human's own words are not.
    expect(steps()[0]).toEqual({
      stepNumber: 1,
      label: 'check',
      description: 'decide whether the payload is usable',
      type: 'call',
      targetComponent: 'flow_store',
      targetMethod: 'put',
    });

    // Left standing, those leftovers are a MALFORMED_FLOW_STEP at the next validate.
    expect(stepConfigVerdict({ narrative: steps() as never }).problems).toEqual([]);

    expect(report.notices.join('\n')).toMatch(
      /step 1 of "run" was retyped branch -> call: condition, onFalseStep dropped/i,
    );
    expect(report.changes.map(c => `${c.path} ${c.change}`)).toContain(
      'methods.run.narrative.step 1.condition removed',
    );
  });

  it('refuses a retype whose own delta sets a field the new type cannot carry', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-retype-clash-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'payload is valid', onFalseStep: 2 },
      { stepNumber: 2, description: 'bail out', type: 'return', outcome: 'invalid' },
    ]);

    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'flow_store', targetMethod: 'put', condition: 'still valid' }],
      }],
    })).toThrow(/retype narrative step 1 of "run" from "branch" to "call": the same delta sets "condition"/);

    expect(steps()[0]).toMatchObject({ type: 'branch', condition: 'payload is valid' });
  });

  // -- A5: a label retargets an existing jump -------------------------------

  it('lets a label in the delta retarget a jump the stored step already has', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-retarget-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'payload is valid', onFalseStep: 2 },
      { stepNumber: 2, description: 'bail out', type: 'return', outcome: 'invalid' },
      { stepNumber: 3, label: 'cleanup', description: 'release the lease', type: 'local' },
    ]);

    updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, onFalseLabel: 'cleanup' }] }],
    });

    // The label is the new intent; the stored number is what it replaces.
    expect(steps()[0]).toMatchObject({ stepNumber: 1, type: 'branch', onFalseStep: 3 });
    expect(steps()[0].onFalseLabel).toBeUndefined();
  });

  it('still refuses a delta that sets a jump number and its label twin at once', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-retarget-clash-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'decide', type: 'branch', condition: 'payload is valid', onFalseStep: 2 },
      { stepNumber: 2, description: 'bail out', type: 'return', outcome: 'invalid' },
      { stepNumber: 3, label: 'cleanup', description: 'release the lease', type: 'local' },
    ]);

    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, onFalseStep: 2, onFalseLabel: 'cleanup' }] }],
    })).toThrow(/sets both onFalseStep=2 and onFalseLabel="cleanup"/);
  });

  it('retargets a try catch clause by label without touching its siblings', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-catch-label-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'guard the write', type: 'try', endStep: 2, catches: [{ error: 'Conflict', step: 3 }, { error: 'Timeout', step: 4 }] },
      { stepNumber: 2, description: 'write it', type: 'local' },
      { stepNumber: 3, description: 'reconcile', type: 'local' },
      { stepNumber: 4, label: 'retry', description: 'try again', type: 'local' },
    ]);

    updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, catches: [{ error: 'Conflict', label: 'retry' }] }] }],
    });

    expect(steps()[0].catches).toEqual([{ error: 'Conflict', step: 4 }, { error: 'Timeout', step: 4 }]);
  });

  // -- A6: step delete guards -----------------------------------------------

  it('refuses to delete a region header while its body is still there, and takes the dissolved header', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-region-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'prepare', type: 'local' },
      { stepNumber: 2, description: 'guard the write', type: 'try', endStep: 3, catches: [{ error: 'Conflict', step: 4 }] },
      { stepNumber: 3, description: 'write it', type: 'local' },
      { stepNumber: 4, description: 'reconcile', type: 'local' },
    ]);

    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 2, action: 'delete' }] }],
    })).toThrow(/it is a try header and step 3 is still its body/);

    expect(steps()).toHaveLength(4);
    expect(steps()[1]).toMatchObject({ type: 'try', endStep: 3 });

    // The sanctioned route: dissolve the region first, which is reported, then delete.
    updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 2, type: 'local' }] }],
    });
    expect(steps()[1]).toEqual({ stepNumber: 2, description: 'guard the write', type: 'local' });

    updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 2, action: 'delete' }] }],
    });
    expect(steps().map(s => s.description)).toEqual(['prepare', 'write it', 'reconcile']);
  });

  it('refuses a delete whose restated label or description does not match the step it addresses', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-delete-guard-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'prepare', type: 'local' },
      { stepNumber: 2, description: 'log the attempt', type: 'local' },
      { stepNumber: 3, description: 'write it', type: 'local' },
      { stepNumber: 4, label: 'audit', description: 'record the outcome', type: 'local' },
      { stepNumber: 5, description: 'finish', type: 'local' },
    ]);

    // Two deletes in one delta: the second addresses the numbering the first
    // left behind, so "4" is no longer the step the author was looking at.
    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'delete' },
          { stepNumber: 4, action: 'delete', label: 'audit' },
        ],
      }],
    })).toThrow(/the delta states label "audit", but step 4 holds null/);

    expect(steps()).toHaveLength(5);

    // Restated correctly, it deletes what the author named.
    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 2, action: 'delete' },
          { stepNumber: 3, action: 'delete', label: 'audit' },
        ],
      }],
    });
    expect(steps().map(s => s.description)).toEqual(['prepare', 'write it', 'finish']);
  });

  it('refuses a delete of a step the narrative does not have', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-phantom-step-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'prepare', type: 'local' },
      { stepNumber: 2, description: 'write it', type: 'local' },
    ]);

    expect(() => updateSpec('implementation', 'flow_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 7, action: 'delete' }] }],
    })).toThrow(/this narrative has no step 7 . it has steps 1-2/);

    expect(steps()).toHaveLength(2);
  });

  it('refuses a step marker the merge would ignore', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-step-marker-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'prepare', type: 'local' },
      { stepNumber: 2, description: 'write it', type: 'local' },
    ]);

    const attempt = (step: Record<string, unknown>): (() => unknown) => () => updateSpec(
      'implementation', 'flow_impl', { methods: [{ name: 'run', narrative: [step] }] },
    );

    expect(attempt({ stepNumber: 2, remove: 'true' })).toThrow(/"remove" must be the boolean true/);
    expect(attempt({ stepNumber: 2, action: 'remove' })).toThrow(/unknown action "remove"/);
    expect(attempt({ stepNumber: 2, captureJumps: true, description: 'moved' }))
      .toThrow(/"captureJumps" only means anything on an inserted step/);
    expect(attempt({ description: 'no number at all', type: 'local' }))
      .toThrow(/a step delta must carry the "stepNumber" it addresses/);

    expect(steps().map(s => s.description)).toEqual(['prepare', 'write it']);
  });

  // -- A7: arrays inside elements merge by identity --------------------------

  it('merges a method\'s params by name instead of replacing the list', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-params-'));
    seedTree(proj);

    updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', params: [{ name: 'attempts', type: 'number', description: 'how many retries are left' }] }],
    });

    expect(loadInterfaceSpec('iflow')!.methods[0].params).toEqual([
      { name: 'payload', type: 'string', description: 'what to run' },
      { name: 'attempts', type: 'number', description: 'how many retries are left' },
    ]);
  });

  it('merges a step\'s catch clauses by error and its switch cases by value', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-nested-flow-'));
    seedTree(proj);
    saveNarrative([
      { stepNumber: 1, description: 'guard the write', type: 'try', endStep: 2, catches: [{ error: 'Conflict', step: 3 }, { error: 'Timeout', step: 4 }] },
      { stepNumber: 2, description: 'write it', type: 'local' },
      { stepNumber: 3, description: 'reconcile', type: 'local' },
      { stepNumber: 4, description: 'try again', type: 'local' },
      { stepNumber: 5, description: 'route the outcome', type: 'switch', on: 'outcome', cases: [{ value: 'ok', step: 6 }, { value: 'retry', step: 7 }] },
      { stepNumber: 6, description: 'finish', type: 'local' },
      { stepNumber: 7, description: 'requeue', type: 'local' },
    ]);

    updateSpec('implementation', 'flow_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, catches: [{ error: 'Conflict', step: 4 }] },
          { stepNumber: 5, cases: [{ value: 'retry', step: 6 }] },
        ],
      }],
    });

    expect(steps()[0].catches).toEqual([{ error: 'Conflict', step: 4 }, { error: 'Timeout', step: 4 }]);
    expect(steps()[4].cases).toEqual([{ value: 'ok', step: 6 }, { value: 'retry', step: 6 }]);
  });

  it('refuses a nested delete that addresses nothing, instead of stripping the marker', () => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delta-nested-delete-'));
    seedTree(proj);

    expect(() => updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', params: [{ name: 'timeout', type: 'number', action: 'delete' }] }],
    })).toThrow(/Refusing to delete params "timeout": nothing with that identity exists/);

    // And a real one removes exactly the element it names.
    updateSpec('interface', 'iflow', {
      methods: [{ name: 'run', params: [{ name: 'attempts', type: 'number', action: 'delete' }] }],
    });
    expect(loadInterfaceSpec('iflow')!.methods[0].params).toEqual([
      { name: 'payload', type: 'string', description: 'what to run' },
    ]);
  });
});
