import { describe, it, expect } from 'vitest';
import {
  ComponentSpecSchema,
  ComponentTypeSchema,
  RETIRED_STEREOTYPES,
  defaultNarrativeDetail,
  holdsState,
  isDraftSubsystem,
  isLogic,
  isPattern,
  isRetired,
  type ComponentType,
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
