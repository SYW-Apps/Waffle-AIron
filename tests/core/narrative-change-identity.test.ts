import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec,
  saveInterfaceSpec, saveImplementationSpec, updateSpec,
  loadImplementationSpec, invalidateSpecCache, specChanges,
} from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec, InterfaceSpec, ImplementationSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// F79 — a narrative change is reported by step identity, not by position.
//
// Inserting one step into a 97-step narrative answered with 124 changes: every
// later step reported as its description, target and type "set" to its
// predecessor's values. The write was right; the report described a
// renumbering as a rewrite of fifty steps, which buried the one line that
// mattered. These are the three shapes that failed: one insert into a long
// narrative, four deletes in one delta, and an edit mixed with an insert.
// ---------------------------------------------------------------------------

const now = '2026-09-26T10:00:00Z';
let roots: string[] = [];

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

/** 97 steps: two branches jump to the final return, the rest are plain local steps. */
function longNarrative(): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  for (let n = 1; n <= 97; n++) steps.push({ stepNumber: n, description: `step ${n} does its own thing`, type: 'local' });
  steps[0] = { stepNumber: 1, description: 'is there work at all', type: 'branch', condition: 'work', onTrueStep: 2, onFalseStep: 97 };
  steps[49] = { stepNumber: 50, description: 'is the work finished', type: 'branch', condition: 'done', onTrueStep: 51, onFalseStep: 97 };
  steps[96] = { stepNumber: 97, description: 'answer', type: 'return', outcome: 'done' };
  return steps;
}

function project(): void {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-narrative-identity-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'identity', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'identity', vision: 'narrative identity fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'identity',
    publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker', subsystem: 'dom', componentType: 'Orchestrator',
    dependsOn: [], owns: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'iworker', description: 'contract', component: 'worker',
    methods: [{ name: 'run', description: 'runs', signature: 'run(): void', params: [], returns: 'void' }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveImplementationSpec({
    id: 'worker_impl', name: 'worker_impl', description: 'impl', contract: 'iworker',
    methods: [{ name: 'run', narrative: longNarrative() }],
    status: 'draft', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
}

const N = 'methods.run.narrative';

describe('a narrative change reads by step identity', () => {
  it('one insert into a 97-step narrative is one step added, one renumbered run and the jumps that followed', () => {
    project();
    const report = updateSpec('implementation', 'worker_impl', {
      methods: [{ name: 'run', narrative: [{ stepNumber: 46, action: 'insert', type: 'local', description: 'the new step' }] }],
    });
    expect(report.changes).toEqual([
      { path: `${N}.step 46`, change: 'added', after: expect.stringContaining('the new step') },
      { path: N, change: 'renumbered', before: 'steps 46-97', after: 'steps 47-98' },
      { path: `${N}.step 1.onFalseStep`, change: 'relocated', before: '97', after: '98' },
      { path: `${N}.step 51 (was 50).onTrueStep`, change: 'relocated', before: '51', after: '52' },
      { path: `${N}.step 51 (was 50).onFalseStep`, change: 'relocated', before: '97', after: '98' },
    ]);
    expect(report.summary).toBe('Updated implementation "worker_impl": 5 changes.');
    // The report describes the write; the write itself is unchanged.
    expect(loadImplementationSpec('worker_impl')!.methods[0].narrative).toHaveLength(98);
  });

  it('four deletes in one delta are four steps removed, the runs between them renumbered', () => {
    project();
    // Each entry addresses the numbering the earlier ones left: old 20 is 19
    // once old 10 is gone, old 30 is 28, old 40 is 37.
    const report = updateSpec('implementation', 'worker_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 10, action: 'delete', description: 'step 10 does its own thing' },
          { stepNumber: 19, action: 'delete', description: 'step 20 does its own thing' },
          { stepNumber: 28, action: 'delete', description: 'step 30 does its own thing' },
          { stepNumber: 37, action: 'delete', description: 'step 40 does its own thing' },
        ],
      }],
    });
    expect(report.changes).toEqual([
      { path: `${N}.step 10`, change: 'removed', before: expect.stringContaining('step 10 does') },
      { path: `${N}.step 20`, change: 'removed', before: expect.stringContaining('step 20 does') },
      { path: `${N}.step 30`, change: 'removed', before: expect.stringContaining('step 30 does') },
      { path: `${N}.step 40`, change: 'removed', before: expect.stringContaining('step 40 does') },
      { path: N, change: 'renumbered', before: 'steps 11-19', after: 'steps 10-18' },
      { path: N, change: 'renumbered', before: 'steps 21-29', after: 'steps 19-27' },
      { path: N, change: 'renumbered', before: 'steps 31-39', after: 'steps 28-36' },
      { path: N, change: 'renumbered', before: 'steps 41-97', after: 'steps 37-93' },
      { path: `${N}.step 1.onFalseStep`, change: 'relocated', before: '97', after: '93' },
      { path: `${N}.step 46 (was 50).onTrueStep`, change: 'relocated', before: '51', after: '47' },
      { path: `${N}.step 46 (was 50).onFalseStep`, change: 'relocated', before: '97', after: '93' },
    ]);
  });

  it('an edit mixed with an insert reads as the edit and the insert, not as the shift', () => {
    project();
    const report = updateSpec('implementation', 'worker_impl', {
      methods: [{
        name: 'run',
        narrative: [
          { stepNumber: 46, action: 'insert', type: 'local', description: 'the new step' },
          // Old step 60, numbered 61 once the insert above has landed.
          { stepNumber: 61, description: 'step 60, reworded' },
        ],
      }],
    });
    expect(report.changes).toEqual([
      { path: `${N}.step 46`, change: 'added', after: expect.stringContaining('the new step') },
      { path: `${N}.step 61 (was 60).description`, change: 'set', before: 'step 60 does its own thing', after: 'step 60, reworded' },
      { path: N, change: 'renumbered', before: 'steps 46-59', after: 'steps 47-60' },
      { path: N, change: 'renumbered', before: 'steps 61-97', after: 'steps 62-98' },
      { path: `${N}.step 1.onFalseStep`, change: 'relocated', before: '97', after: '98' },
      { path: `${N}.step 51 (was 50).onTrueStep`, change: 'relocated', before: '51', after: '52' },
      { path: `${N}.step 51 (was 50).onFalseStep`, change: 'relocated', before: '97', after: '98' },
    ]);
  });
});

describe('the identity diff on its own', () => {
  const step = (n: number, description: string, extra: Record<string, unknown> = {}) =>
    ({ stepNumber: n, description, type: 'local', ...extra });

  it('a step edited in place keeps reading as a field change at its number', () => {
    expect(specChanges(
      { narrative: [step(1, 'a'), step(2, 'b'), step(3, 'c')] },
      { narrative: [step(1, 'a'), step(2, 'B'), step(3, 'c')] },
    )).toEqual([{ path: 'narrative.step 2.description', change: 'set', before: 'b', after: 'B' }]);
  });

  it('a jump that no longer follows its target is a real change, not a relocation', () => {
    const before = [{ stepNumber: 1, description: 'go', type: 'jump', toStep: 3 }, step(2, 'b'), step(3, 'c')];
    const after = [{ stepNumber: 1, description: 'go', type: 'jump', toStep: 2 }, step(2, 'b'), step(3, 'c')];
    expect(specChanges({ narrative: before }, { narrative: after })).toEqual([
      { path: 'narrative.step 1.toStep', change: 'set', before: '3', after: '2' },
    ]);
  });

  it('a replaced step with nothing recognisable left is an edit in place when the counts match', () => {
    expect(specChanges(
      { narrative: [step(1, 'a'), step(2, 'b'), step(3, 'c')] },
      { narrative: [step(1, 'a'), { stepNumber: 2, description: 'z', type: 'return', outcome: 'x' }, step(3, 'c')] },
    )).toEqual([
      { path: 'narrative.step 2.description', change: 'set', before: 'b', after: 'z' },
      { path: 'narrative.step 2.type', change: 'set', before: 'local', after: 'return' },
      { path: 'narrative.step 2.outcome', change: 'added', after: 'x' },
    ]);
  });
});
