import { describe, it, expect } from 'vitest';
import {
  ComponentSpecSchema,
  ComponentTypeSchema,
  RETIRED_STEREOTYPES,
  cognitiveScore,
  complexityLevel,
  conceptNoun,
  defaultNarrativeDetail,
  headNoun,
  holdsState,
  isDraftSubsystem,
  isLogic,
  isPattern,
  isRetired,
  type ComponentType,
  type MethodImplementation,
  type NarrativeStep,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Spec type methods realized as pure functions in src/models:
// component_spec.isPattern, isLogic, holdsState, isRetired and
// defaultNarrativeDetail, and subsystem_spec.isDraft.
// ---------------------------------------------------------------------------

const ALL_TYPES = ComponentTypeSchema.options as ComponentType[];

/** Every component type outside `members`, so each predicate is pinned both ways. */
const outside = (members: ComponentType[]): ComponentType[] => ALL_TYPES.filter((t) => !members.includes(t));

describe('component_spec.componentType', () => {
  it('accepts Query, the Repository member for computed reads', () => {
    expect(ComponentTypeSchema.safeParse('Query').success).toBe(true);
  });

  it('still accepts the retired Specialist and Gateway, so a tree using them loads', () => {
    expect(ComponentTypeSchema.safeParse('Specialist').success).toBe(true);
    expect(ComponentTypeSchema.safeParse('Gateway').success).toBe(true);
  });
});

describe('component_spec.dependencyClass', () => {
  const orchestrator = {
    id: 'verdict', name: 'Verdict', description: 'd', subsystem: 'sub', componentType: 'Orchestrator',
    createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z',
  };

  it.each(['pure', 'read'])('keeps dependencyClass %s', (dependencyClass) => {
    expect(ComponentSpecSchema.parse({ ...orchestrator, dependencyClass }).dependencyClass).toBe(dependencyClass);
  });

  it('refuses any other class', () => {
    expect(ComponentSpecSchema.safeParse({ ...orchestrator, dependencyClass: 'write' }).success).toBe(false);
  });

  it('is unset for a workflow', () => {
    expect(ComponentSpecSchema.parse(orchestrator).dependencyClass).toBeUndefined();
  });
});

describe('component_spec.isPattern', () => {
  const patterns: ComponentType[] = ['Repository', 'FeatureComponent', 'RouterComponent'];

  it.each(patterns)('%s is a pattern', (componentType) => {
    expect(isPattern({ componentType })).toBe(true);
  });

  it.each(outside(patterns))('%s is not a pattern', (componentType) => {
    expect(isPattern({ componentType })).toBe(false);
  });
});

describe('component_spec.isLogic', () => {
  const logic: ComponentType[] = ['Orchestrator', 'Supervisor', 'Actor', 'Specialist'];

  it.each(logic)('%s is logic', (componentType) => {
    expect(isLogic({ componentType })).toBe(true);
  });

  it.each(outside(logic))('%s is not logic', (componentType) => {
    expect(isLogic({ componentType })).toBe(false);
  });
});

describe('component_spec.holdsState', () => {
  const stateful: ComponentType[] = ['Store', 'Index', 'Supervisor', 'Actor'];

  it.each(stateful)('%s holds state', (componentType) => {
    expect(holdsState({ componentType })).toBe(true);
  });

  it.each(outside(stateful))('%s holds no state', (componentType) => {
    expect(holdsState({ componentType })).toBe(false);
  });
});

describe('component_spec.isRetired', () => {
  const retired: ComponentType[] = ['Specialist', 'Gateway'];

  it.each(retired)('%s is retired', (componentType) => {
    expect(isRetired({ componentType })).toBe(true);
  });

  it.each(outside(retired))('%s is not retired', (componentType) => {
    expect(isRetired({ componentType })).toBe(false);
  });

  it('RETIRED_STEREOTYPES names exactly the retired types', () => {
    expect([...RETIRED_STEREOTYPES].sort()).toEqual(['Gateway', 'Specialist']);
  });
});

describe('component_spec.defaultNarrativeDetail', () => {
  const callsOnly: ComponentType[] = ['Portal', 'Observer', 'Adapter'];
  const intent: ComponentType[] = ['Store', 'Index', 'Query', 'Registry'];

  it.each(callsOnly)('%s defaults to calls-only', (componentType) => {
    expect(defaultNarrativeDetail({ componentType })).toBe('calls-only');
  });

  it.each(intent)('%s defaults to intent', (componentType) => {
    expect(defaultNarrativeDetail({ componentType })).toBe('intent');
  });

  it.each(outside([...callsOnly, ...intent]))('%s defaults to full', (componentType) => {
    expect(defaultNarrativeDetail({ componentType })).toBe('full');
  });

  it('an unresolved component defaults to full', () => {
    expect(defaultNarrativeDetail(undefined)).toBe('full');
  });
});

describe('subsystem_spec.isDraft', () => {
  it('holds for a draft or design subsystem', () => {
    expect(isDraftSubsystem({ status: 'draft' })).toBe(true);
    expect(isDraftSubsystem({ status: 'design' })).toBe(true);
  });

  it('does not hold for a complete subsystem, or one carrying no status', () => {
    expect(isDraftSubsystem({ status: 'complete' })).toBe(false);
    expect(isDraftSubsystem({} as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// component_spec.headNoun / conceptNoun — the last word of the id (headNoun),
// and the last word that does not name a building block (conceptNoun).
// ---------------------------------------------------------------------------

describe('component_spec.headNoun', () => {
  it('is the last underscore-separated word of the id', () => {
    expect(headNoun({ id: 'credential_write_registry' })).toBe('registry');
    expect(headNoun({ id: 'pack_store_adapter' })).toBe('adapter');
  });

  it('is the whole id when it carries no qualifier', () => {
    expect(headNoun({ id: 'registry' })).toBe('registry');
  });
});

describe('component_spec.conceptNoun', () => {
  it('is the last word that does not name a building block', () => {
    expect(conceptNoun({ id: 'pack_store' })).toBe('pack');
    expect(conceptNoun({ id: 'cli_packs_adapter' })).toBe('packs');
    expect(conceptNoun({ id: 'architecture_diagrams' })).toBe('diagrams');
  });

  it('skips past a run of building-block words to find the concept', () => {
    expect(conceptNoun({ id: 'pack_store_adapter' })).toBe('pack');
  });

  it('is empty when every word names a building block', () => {
    expect(conceptNoun({ id: 'store_registry' })).toBe('');
    expect(conceptNoun({ id: 'repository' })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// method_implementation.cognitiveScore / complexityLevel — the narrative's
// cognitive weight and the band it falls in.
// ---------------------------------------------------------------------------

/** Narrative step builder: only the fields cognitiveScore reads need be set. */
const step = (stepNumber: number, type: NarrativeStep['type'], extra: Partial<NarrativeStep> = {}): NarrativeStep =>
  ({ stepNumber, type, description: 'd', ...extra }) as NarrativeStep;

const impl = (narrative: NarrativeStep[]): Pick<MethodImplementation, 'narrative'> => ({ narrative });

describe('method_implementation.cognitiveScore', () => {
  it('scores a flat sequence of calls and locals as zero however long it is', () => {
    expect(cognitiveScore(impl([
      step(1, 'call', { targetComponent: 'x', targetMethod: 'y' }),
      step(2, 'local'),
      step(3, 'local'),
      step(4, 'return'),
    ]))).toBe(0);
  });

  it('scores an unnested branch, switch, loop or parallel as one', () => {
    expect(cognitiveScore(impl([
      step(1, 'branch', { condition: 'c', onTrueStep: 2, onFalseStep: 2 }),
      step(2, 'return'),
    ]))).toBe(1);
    expect(cognitiveScore(impl([
      step(1, 'switch', { on: 'x', cases: [{ value: 'a', step: 2 }], defaultStep: 2 }),
      step(2, 'return'),
    ]))).toBe(1);
    expect(cognitiveScore(impl([
      step(1, 'loop', { loopKind: 'forEach', over: 'items', endStep: 2 }),
      step(2, 'local'),
    ]))).toBe(1);
    expect(cognitiveScore(impl([
      step(1, 'parallel', { endStep: 3, branches: [{ step: 2 }, { step: 3 }] }),
      step(2, 'local'),
      step(3, 'local'),
    ]))).toBe(1);
  });

  it('adds nesting depth for a step inside a loop/try/parallel region', () => {
    // loop [1,4] contributes 1+0; the nested branch at 2 sits inside it (depth 1) -> 1+1
    expect(cognitiveScore(impl([
      step(1, 'loop', { loopKind: 'forEach', over: 'items', endStep: 4 }),
      step(2, 'branch', { condition: 'c', onTrueStep: 3, onFalseStep: 4 }),
      step(3, 'local'),
      step(4, 'local'),
    ]))).toBe(3);
  });

  it('accumulates depth across doubly-nested regions', () => {
    // outer loop [1,6] (depth 0 -> 1), inner loop [2,5] (depth 1 -> 2),
    // branch at 3 sits inside both (depth 2 -> 3). Total 1+2+3 = 6.
    expect(cognitiveScore(impl([
      step(1, 'loop', { loopKind: 'forEach', over: 'outer', endStep: 6 }),
      step(2, 'loop', { loopKind: 'forEach', over: 'inner', endStep: 5 }),
      step(3, 'branch', { condition: 'c', onTrueStep: 4, onFalseStep: 5 }),
      step(4, 'local'),
      step(5, 'local'),
      step(6, 'local'),
    ]))).toBe(6);
  });

  it('scores each catch clause of a try by one plus its nesting depth, never the try step itself', () => {
    // try [1,6] contributes nothing on its own; its two catches (steps 4, 5)
    // each sit inside the try's own region (depth 1) -> (1+1) + (1+1) = 4.
    expect(cognitiveScore(impl([
      step(1, 'try', { endStep: 6, catches: [{ error: 'A', step: 4 }, { error: 'B', step: 5 }] }),
      step(2, 'local'),
      step(3, 'jump', { toStep: 6 }),
      step(4, 'local'),
      step(5, 'local'),
      step(6, 'local'),
    ]))).toBe(5); // 4 (two catches) + 1 (the jump at step 3)
  });

  it('counts every jump as flat one, ignoring its own nesting depth', () => {
    // loop [1,3] contributes 1+0 = 1; the jump at step 2 sits inside it but
    // still counts flat, not 1+depth.
    expect(cognitiveScore(impl([
      step(1, 'loop', { loopKind: 'forEach', over: 'items', endStep: 3 }),
      step(2, 'jump', { toStep: 3 }),
      step(3, 'local'),
    ]))).toBe(2);
  });
});

describe('method_implementation.complexityLevel', () => {
  it('is linear at score 0', () => {
    expect(complexityLevel(impl([step(1, 'local')]))).toBe('linear');
  });

  it('is simple from 1 to 4', () => {
    expect(complexityLevel(impl([
      step(1, 'branch', { condition: 'c', onTrueStep: 2, onFalseStep: 2 }),
      step(2, 'return'),
    ]))).toBe('simple');
  });

  it('is moderate from 5 to 9', () => {
    // Reuses the doubly-nested-region fixture, which scores 6.
    expect(complexityLevel(impl([
      step(1, 'loop', { loopKind: 'forEach', over: 'outer', endStep: 6 }),
      step(2, 'loop', { loopKind: 'forEach', over: 'inner', endStep: 5 }),
      step(3, 'branch', { condition: 'c', onTrueStep: 4, onFalseStep: 5 }),
      step(4, 'local'),
      step(5, 'local'),
      step(6, 'local'),
    ]))).toBe('moderate');
  });

  it('is complex from 10 to 19, and severe at 20 and above', () => {
    // 10 independent, unnested branches: each contributes exactly 1.
    const tenBranches = Array.from({ length: 10 }, (_, i) =>
      step(i + 1, 'branch', { condition: 'c', onTrueStep: i + 2 > 10 ? 11 : i + 2, onFalseStep: i + 2 > 10 ? 11 : i + 2 }));
    expect(complexityLevel(impl([...tenBranches, step(11, 'return')]))).toBe('complex');

    const twentyBranches = Array.from({ length: 20 }, (_, i) =>
      step(i + 1, 'branch', { condition: 'c', onTrueStep: i + 2 > 20 ? 21 : i + 2, onFalseStep: i + 2 > 20 ? 21 : i + 2 }));
    expect(complexityLevel(impl([...twentyBranches, step(21, 'return')]))).toBe('severe');
  });
});
