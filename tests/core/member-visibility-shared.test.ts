import { describe, it, expect } from 'vitest';
import { visibilityEdgeFinding } from '../../src/core/rules/doctrine/member-visibility.js';
import type { OwnershipIndex, RuleContext } from '../../src/core/rules/types.js';
import type { ComponentSpec } from '../../src/models/index.js';

// A shared Adapter a pattern owns is owned by mistake: "depend on the facade"
// cannot stand in for generic I/O, so the finding points at the real fault.

const comp = (id: string, componentType: string): ComponentSpec =>
  ({ id, componentType, subsystem: 'billing', dependsOn: [], owns: [] } as unknown as ComponentSpec);

const ownership = { ownerOf: (id: string) => (id === 'files' || id === 'store' ? 'repo' : undefined) } as unknown as OwnershipIndex;

const ctxWith = (shared: string[]): RuleContext => ({
  componentMap: new Map([['repo', comp('repo', 'Repository')]]),
  sharedSet: new Map([['billing', new Set(shared)]]),
} as unknown as RuleContext);

describe('member-visibility on a shared Adapter a pattern owns', () => {
  it('names SHARED_ADAPTER_OWNED and the owns entry to remove, not the facade', () => {
    const finding = visibilityEdgeFinding(ctxWith(['files']), ownership, comp('flow', 'Orchestrator'), 'files');
    expect(finding?.code).toBe('VISIBILITY_VIOLATION');
    expect(finding?.message).toContain('SHARED_ADAPTER_OWNED');
    expect(finding?.message).toContain('Take it out of "repo"\'s owns');
    expect(finding?.message).not.toContain('Depend on the facade');
  });

  it('a private member that is not shared still points at the facade', () => {
    const finding = visibilityEdgeFinding(ctxWith(['files']), ownership, comp('flow', 'Orchestrator'), 'store');
    expect(finding?.message).toContain('Depend on the facade "repo" instead.');
  });
});
