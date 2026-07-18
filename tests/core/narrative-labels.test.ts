import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { resolveNarrativeLabels } from '../../src/core/narrative-labels.js';
import {
  saveSubsystemSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  loadImplementationSpec,
  updateSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';

const now = new Date().toISOString();

// ---------------------------------------------------------------------------
// Symbolic step labels: *Label reference fields resolve to step numbers at
// write time (updateSpec / sdd_write_narrative). Stored specs keep plain
// numbers; labels persist as anchors so later deltas can reference them.
// ---------------------------------------------------------------------------

describe('resolveNarrativeLabels (pure)', () => {
  it('resolves every scalar reference kind and strips the reference fields', () => {
    const steps: Record<string, any>[] = [
      { stepNumber: 1, type: 'branch', description: 'd', condition: 'c', onTrueLabel: 'work', onFalseLabel: 'fail' },
      { stepNumber: 2, label: 'work', type: 'local', description: 'd' },
      { stepNumber: 3, type: 'jump', description: 'd', toLabel: 'work' },
      { stepNumber: 4, label: 'fail', type: 'throw', description: 'd', error: 'boom' },
    ];
    const errors = resolveNarrativeLabels('m', steps);
    expect(errors).toHaveLength(0);
    expect(steps[0]).toMatchObject({ onTrueStep: 2, onFalseStep: 4 });
    expect(steps[0]).not.toHaveProperty('onTrueLabel');
    expect(steps[0]).not.toHaveProperty('onFalseLabel');
    expect(steps[2]).toMatchObject({ toStep: 2 });
    expect(steps[2]).not.toHaveProperty('toLabel');
    expect(steps[1].label).toBe('work'); // anchors persist
  });

  it('resolves switch cases and try catches by label', () => {
    const steps: Record<string, any>[] = [
      { stepNumber: 1, type: 'switch', description: 'd', on: 'kind', cases: [{ value: 'a', label: 'handle-a' }, { value: 'b', step: 3 }], defaultLabel: 'handle-a' },
      { stepNumber: 2, label: 'handle-a', type: 'local', description: 'd' },
      { stepNumber: 3, type: 'try', description: 'd', endLabel: 'body-end', catches: [{ error: 'any', label: 'handler' }], finallyLabel: 'handler' },
      { stepNumber: 4, label: 'body-end', type: 'local', description: 'd' },
      { stepNumber: 5, label: 'handler', type: 'return', description: 'd' },
    ];
    const errors = resolveNarrativeLabels('m', steps);
    expect(errors).toHaveLength(0);
    expect(steps[0].cases).toEqual([{ value: 'a', step: 2 }, { value: 'b', step: 3 }]);
    expect(steps[0].defaultStep).toBe(2);
    expect(steps[2]).toMatchObject({ endStep: 4, finallyStep: 5 });
    expect(steps[2].catches).toEqual([{ error: 'any', step: 5 }]);
  });

  it('reports unknown and duplicate labels, and numeric/symbolic disagreement', () => {
    const steps: Record<string, any>[] = [
      { stepNumber: 1, label: 'dup', type: 'local', description: 'd' },
      { stepNumber: 2, label: 'dup', type: 'local', description: 'd' },
      { stepNumber: 3, type: 'jump', description: 'd', toLabel: 'missing' },
      { stepNumber: 4, type: 'jump', description: 'd', toStep: 9, toLabel: 'dup' },
    ];
    const errors = resolveNarrativeLabels('m', steps);
    expect(errors.some(e => e.includes('duplicate label "dup"'))).toBe(true);
    expect(errors.some(e => e.includes('unknown label "missing"'))).toBe(true);
    expect(errors.some(e => e.includes('they disagree'))).toBe(true);
    expect(errors.every(e => e.startsWith('narrative of "m"'))).toBe(true);
  });

  it('accepts agreeing numeric + symbolic references silently', () => {
    const steps: Record<string, any>[] = [
      { stepNumber: 1, label: 'end', type: 'local', description: 'd' },
      { stepNumber: 2, type: 'jump', description: 'd', toStep: 1, toLabel: 'end' },
    ];
    expect(resolveNarrativeLabels('m', steps)).toHaveLength(0);
    expect(steps[1].toStep).toBe(1);
  });
});

describe('updateSpec label resolution (write path)', () => {
  let proj: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (proj) fs.rmSync(proj, { recursive: true, force: true });
  });

  function setup() {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-labels-test-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
    saveSubsystemSpec({
      schemaVersion: '1.0.0', id: 'billing', name: 'Billing', description: 'd',
      parentSystem: 'GK', publicInterfaces: [], createdAt: now, updatedAt: now,
    });
    saveInterfaceSpec({
      id: 'iflow', name: 'IFlow', description: 'd', component: 'flow-comp',
      methods: [{ name: 'run', signature: 'run()', returns: 'void', description: 'runs the flow' }],
      createdAt: now, updatedAt: now,
    });
    saveImplementationSpec({
      id: 'flow-impl', name: 'FlowImpl', description: 'd', contract: 'iflow',
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, description: 'prepare', type: 'local' },
          { stepNumber: 2, label: 'retry', description: 'attempt the work', type: 'local' },
          { stepNumber: 3, description: 'done', type: 'return' },
        ],
      }],
      createdAt: now, updatedAt: now,
    });
  }

  it('a delta step can reference a label anchored on a PRE-EXISTING step', () => {
    setup();
    updateSpec('implementation', 'flow-impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 3, action: 'insert', description: 'on failure, go again', type: 'jump', toLabel: 'retry' },
        ],
      }],
    });
    const impl = loadImplementationSpec('flow-impl')!;
    const steps = impl.methods.find(m => m.name === 'run')!.narrative;
    expect(steps).toHaveLength(4);
    const jump = steps.find(s => s.type === 'jump')!;
    expect(jump.toStep).toBe(2);
    expect((jump as Record<string, unknown>).toLabel).toBeUndefined();
    expect(steps.find(s => s.stepNumber === 2)!.label).toBe('retry'); // anchor persisted in YAML
  });

  it('an unresolvable label reference aborts the update (nothing saved)', () => {
    setup();
    expect(() => updateSpec('implementation', 'flow-impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 3, action: 'insert', description: 'bad jump', type: 'jump', toLabel: 'no-such-label' },
        ],
      }],
    })).toThrow(/unknown label "no-such-label"/);
    const impl = loadImplementationSpec('flow-impl')!;
    expect(impl.methods.find(m => m.name === 'run')!.narrative).toHaveLength(3);
  });

  it('labels survive insert-renumbering: the reference resolves against the FINAL numbering', () => {
    setup();
    // Insert a new step 1 (shifting "retry" from 2 to 3) AND a jump to it, in one delta.
    updateSpec('implementation', 'flow-impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 1, action: 'insert', description: 'authenticate first', type: 'local' },
          { stepNumber: 5, action: 'insert', description: 'loop back', type: 'jump', toLabel: 'retry' },
        ],
      }],
    });
    const steps = loadImplementationSpec('flow-impl')!.methods.find(m => m.name === 'run')!.narrative;
    const retry = steps.find(s => s.label === 'retry')!;
    expect(retry.stepNumber).toBe(3);
    const jump = steps.find(s => s.type === 'jump')!;
    expect(jump.toStep).toBe(3);
  });
});
