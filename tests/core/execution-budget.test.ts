import { describe, it, expect } from 'vitest';
import { createAgentRecord } from '../../src/models/agent.js';
import { BudgetTier, ExecutionConfig } from '../../src/models/execution.js';
import { deriveExecutionProfile } from '../../src/core/execution_profile.js';
import { resolveBudget } from '../../src/core/budget_policy.js';

// ---------------------------------------------------------------------------
// Execution profile derivation + budget policy
//
// These are the two tool-agnostic halves of the resource axis. Nothing here
// may mention a model name or a tool name — that vocabulary belongs to the
// exporters, and a test that reaches for it is testing the wrong layer.
// ---------------------------------------------------------------------------

function cfg(tier: BudgetTier, overrides: ExecutionConfig['overrides'] = {}): ExecutionConfig {
  return { tier, overrides };
}

function agent(partial: Parameters<typeof createAgentRecord>[0]) {
  return createAgentRecord(partial);
}

const owner = () =>
  agent({
    id: 'billing-owner',
    name: 'Billing Owner',
    template: 'domain-owner',
    creationReason: 'test',
    tags: ['owner', 'sdd'],
    ownedPaths: ['.wai/specs/subsystems/billing.yaml'],
    readPaths: ['**'],
  });

const storeImpl = () =>
  agent({
    id: 'ledger-store-implementer',
    name: 'Ledger Store Implementer',
    template: 'implementer',
    creationReason: 'test',
    tags: ['implementer', 'component', 'sdd', 'store'],
    ownedPaths: ['src/billing/ledger_store.ts'],
  });

const orchestratorImpl = () =>
  agent({
    id: 'billing-orchestrator-implementer',
    name: 'Billing Orchestrator Implementer',
    template: 'implementer',
    creationReason: 'test',
    tags: ['implementer', 'component', 'sdd', 'orchestrator'],
    ownedPaths: ['src/billing/billing_orchestrator.ts'],
  });

const reviewer = () =>
  agent({
    id: 'billing-reviewer',
    name: 'Billing Reviewer',
    template: 'reviewer',
    creationReason: 'test',
    tags: ['reviewer'],
    ownedPaths: [],
    readPaths: ['**'],
  });

describe('deriveExecutionProfile', () => {
  it('reads reasoning depth from the component stereotype tag', () => {
    expect(deriveExecutionProfile(storeImpl()).reasoningDepth).toBe('mechanical');
    expect(deriveExecutionProfile(orchestratorImpl()).reasoningDepth).toBe('deep');
  });

  it('marks routing templates as delegating managers', () => {
    expect(deriveExecutionProfile(owner()).delegates).toBe(true);
    expect(deriveExecutionProfile(storeImpl()).delegates).toBe(false);
  });

  it('treats a sweeping readPath as wide breadth for surveying roles', () => {
    expect(deriveExecutionProfile(owner()).breadth).toBe('wide');
    expect(deriveExecutionProfile(reviewer()).breadth).toBe('wide');
  });

  it('scopes a single-file implementer to narrow breadth', () => {
    expect(deriveExecutionProfile(storeImpl()).breadth).toBe('narrow');
  });

  it('marks a reviewer read-only even though it may read everything', () => {
    expect(deriveExecutionProfile(reviewer()).writes).toBe(false);
    expect(deriveExecutionProfile(storeImpl()).writes).toBe(true);
  });

  it('explains itself', () => {
    expect(deriveExecutionProfile(storeImpl()).rationale).toContain('store');
  });
});

describe('resolveBudget', () => {
  it('emits nothing at tier off, so enabling the feature is the only thing that changes files', () => {
    expect(resolveBudget(deriveExecutionProfile(owner()), cfg('off'), 'billing-owner')).toBeUndefined();
  });

  it('expresses no model choice at the free tier', () => {
    const b = resolveBudget(deriveExecutionProfile(storeImpl()), cfg('free'), 'x');
    expect(b?.modelTier).toBeUndefined();
    expect(b?.effort).toBeUndefined();
    expect(b?.maxTurns).toBeUndefined();
  });

  it('still applies structural constraints at the free tier', () => {
    const b = resolveBudget(deriveExecutionProfile(reviewer()), cfg('free'), 'x');
    expect(b?.toolClass).toBe('read-only');
    expect(b?.allowNestedDelegation).toBe(false);
  });

  it('gives mechanical work the small tier and deep work the large tier by default', () => {
    expect(resolveBudget(deriveExecutionProfile(storeImpl()), cfg('default'), 'x')?.modelTier).toBe('small');
    expect(
      resolveBudget(deriveExecutionProfile(orchestratorImpl()), cfg('default'), 'x')?.modelTier,
    ).toBe('large');
  });

  it('never reduces the tier for deep reasoning, even when aggressive', () => {
    for (const tier of ['default', 'trade', 'aggressive'] as BudgetTier[]) {
      expect(
        resolveBudget(deriveExecutionProfile(orchestratorImpl()), cfg(tier), 'x')?.modelTier,
      ).toBe('large');
    }
  });

  it('only lowers effort for mechanical work, and only past the trade tier', () => {
    expect(resolveBudget(deriveExecutionProfile(storeImpl()), cfg('default'), 'x')?.effort).toBeUndefined();
    expect(resolveBudget(deriveExecutionProfile(storeImpl()), cfg('trade'), 'x')?.effort).toBe('medium');
    expect(resolveBudget(deriveExecutionProfile(storeImpl()), cfg('aggressive'), 'x')?.effort).toBe('low');
    expect(
      resolveBudget(deriveExecutionProfile(orchestratorImpl()), cfg('aggressive'), 'x')?.effort,
    ).toBeUndefined();
  });

  it('keeps write tools for a manager that owns paths, and still lets it delegate', () => {
    // Regression: wairon's domain owners both route work AND author the specs
    // and source they own. An earlier policy stripped their bulk-content tools
    // on the grounds that "managers should stay thin", which would have left
    // every agent in a real wairon topology unable to touch its own files.
    const b = resolveBudget(deriveExecutionProfile(owner()), cfg('default'), 'billing-owner');
    expect(b?.toolClass).toBe('implement');
    expect(b?.allowNestedDelegation).toBe(true);
  });

  it('keeps an implementer writable even when no owned path resolved', () => {
    // Regression: writes used to be inferred from owned-path count, so an
    // implementer whose source path could not be inferred silently came out
    // read-only — an implementer that cannot implement. A missing path is a
    // topology gap to fix, not a reason to demote the role.
    const pathless = agent({
      id: 'unresolved-implementer',
      name: 'Unresolved Implementer',
      template: 'implementer',
      creationReason: 'test',
      tags: ['implementer', 'component', 'sdd', 'store'],
      ownedPaths: [],
    });
    const p = deriveExecutionProfile(pathless);
    expect(p.writes).toBe(true);
    expect(resolveBudget(p, cfg('default'), 'x')?.toolClass).toBe('implement');
  });

  it('never derives the orchestrate class — it is override-only', () => {
    const everyRole = [owner(), storeImpl(), orchestratorImpl(), reviewer()];
    for (const a of everyRole) {
      const b = resolveBudget(deriveExecutionProfile(a), cfg('default'), a.id);
      expect(b?.toolClass).not.toBe('orchestrate');
    }
    // Still selectable by hand, for a manager someone defines themselves.
    const forced = resolveBudget(
      deriveExecutionProfile(owner()),
      cfg('default', { 'billing-owner': { toolClass: 'orchestrate' } }),
      'billing-owner',
    );
    expect(forced?.toolClass).toBe('orchestrate');
  });

  it('withholds delegation from workers', () => {
    expect(
      resolveBudget(deriveExecutionProfile(storeImpl()), cfg('default'), 'x')?.allowNestedDelegation,
    ).toBe(false);
  });

  it('sizes turn ceilings by breadth, so a focused worker is capped tighter than a wide surveyor', () => {
    const focused = resolveBudget(deriveExecutionProfile(storeImpl()), cfg('default'), 'x')!;
    const surveyor = resolveBudget(deriveExecutionProfile(reviewer()), cfg('default'), 'x')!;
    expect(focused.maxTurns).toBeLessThan(surveyor.maxTurns!);
  });

  it('drops MCP for narrow workers and keeps it for managers', () => {
    expect(resolveBudget(deriveExecutionProfile(storeImpl()), cfg('default'), 'x')?.mcp).toBe('none');
    expect(resolveBudget(deriveExecutionProfile(owner()), cfg('default'), 'x')?.mcp).toBe('project');
  });

  it('raising the tier only ever tightens the budget', () => {
    const seq = (['free', 'default', 'trade', 'aggressive'] as BudgetTier[]).map(
      (t) => resolveBudget(deriveExecutionProfile(storeImpl()), cfg(t), 'x')!,
    );
    const turns = seq.map((b) => b.maxTurns ?? Infinity);
    for (let i = 1; i < turns.length; i++) {
      expect(turns[i]).toBeLessThanOrEqual(turns[i - 1]);
    }
  });

  it('lets an explicit override beat derivation', () => {
    const b = resolveBudget(
      deriveExecutionProfile(storeImpl()),
      cfg('default', { 'ledger-store-implementer': { modelTier: 'frontier', maxTurns: 200 } }),
      'ledger-store-implementer',
    );
    expect(b?.modelTier).toBe('frontier');
    expect(b?.maxTurns).toBe(200);
    // Untouched fields still come from derivation.
    expect(b?.toolClass).toBe('implement');
  });
});
