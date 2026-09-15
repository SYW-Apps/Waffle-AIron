import { describe, it, expect } from 'vitest';
import { isDraftSubsystem, isPattern, type ComponentType } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Spec type methods realized as pure functions in src/models:
// component_spec.isPattern and subsystem_spec.isDraft.
// ---------------------------------------------------------------------------

describe('component_spec.isPattern', () => {
  it.each(['Repository', 'Gateway', 'FeatureComponent', 'RouterComponent'] as ComponentType[])(
    '%s is a pattern',
    (componentType) => {
      expect(isPattern({ componentType })).toBe(true);
    },
  );

  it.each([
    'Portal', 'Orchestrator', 'Supervisor', 'Actor', 'Store', 'Index', 'Registry', 'Adapter', 'Observer', 'Specialist', 'View',
  ] as ComponentType[])('%s is a building block, not a pattern', (componentType) => {
    expect(isPattern({ componentType })).toBe(false);
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
