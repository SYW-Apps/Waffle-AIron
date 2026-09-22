import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as adapter from '../../src/commands/subsystem.js';
import * as portal from '../../src/core/index.js';
import { deriveExecutionProfile as coreDerive } from '../../src/core/execution_profile.js';
import { resolveBudget as coreResolve } from '../../src/core/budget_policy.js';
import { summarize } from '../../src/models/execution.js';
import { createAgentRecord } from '../../src/models/agent.js';
import type { ExecutionBudget, ExecutionConfig, ExecutionProfile } from '../../src/models/execution.js';

// ---------------------------------------------------------------------------
// Where `wairon execution` is allowed to reach the resource axis, and where
// printing an allowance lives.
//
// The command imported resolveAgentTopology out of ../core/agent_resolver.js,
// deriveExecutionProfile out of ../core/execution_profile.js and resolveBudget
// out of ../core/budget_policy.js — sdd_cli reaching into three sdd_core
// modules while core_portal publishes all three calls. It is the seventh time
// that reach has been found; the first six are listed in
// tests/commands/domains-boundary.test.ts.
//
// `summarize` moved the other way. Printing an allowance is pure projection
// over the budget's own fields, so it belongs to the VALUE — which takes the
// CLI and the MCP server out of sdd_core entirely, because neither ever wanted
// anything but to print one.
//
// Nothing was broken by any of it, which is why it survived: both spellings
// compile, so only the import SITE says which side of a boundary a file is on.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const cfg = (tier: ExecutionConfig['tier'], overrides: ExecutionConfig['overrides'] = {}): ExecutionConfig =>
  ({ tier, overrides });

const storeImplementer = () =>
  createAgentRecord({
    id: 'ledger-store-implementer',
    name: 'Ledger Store Implementer',
    template: 'implementer',
    creationReason: 'test',
    tags: ['implementer', 'component', 'sdd', 'store'],
    ownedPaths: ['src/billing/ledger_store.ts'],
  });

const billingOwner = () =>
  createAgentRecord({
    id: 'billing-owner',
    name: 'Billing Owner',
    template: 'domain-owner',
    creationReason: 'test',
    tags: ['owner', 'sdd'],
    ownedPaths: ['.wai/specs/subsystems/billing.yaml'],
    readPaths: ['**'],
  });

describe('summarize is the budget\'s own projection, and prints what describeBudget printed', () => {
  // The text these assertions pin is the text `describeBudget(profile, budget)`
  // produced before the move — line for line, including the parenthetical on
  // the turn ceiling. The function changed file, name and argument order; the
  // output is the one thing that had to stay put, because it is what a brief
  // and the CLI both render.
  const profile: ExecutionProfile = {
    breadth: 'moderate',
    writes: true,
    reasoningDepth: 'deep',
    delegates: true,
    rationale: 'orchestrator work carries the decision logic; owns a whole package',
  };
  const budget: ExecutionBudget = {
    modelTier: 'large',
    effort: 'high',
    maxTurns: 40,
    toolClass: 'implement',
    allowNestedDelegation: true,
    mcp: 'project',
  };

  it('renders every field a full allowance carries, in order', () => {
    expect(summarize(budget, profile)).toEqual([
      '- **Work shape**: moderate breadth, deep reasoning, delegating',
      '- **Why**: orchestrator work carries the decision logic; owns a whole package',
      '- **Capability tier**: large',
      '- **Effort**: high',
      '- **Turn ceiling**: 40 (a circuit breaker — hitting it should read as a scoping error, not a limit to work up to)',
      '- **Tool grant**: implement',
      '- **May delegate further**: yes',
      '- **MCP access**: project',
    ]);
  });

  it('omits the three optional lines rather than defaulting them, and says read-only in the work shape', () => {
    // The `free` tier expresses no model choice at all, and an exporter must
    // omit the field rather than substitute a default. The printer has to
    // agree, or a brief would announce a tier nobody chose.
    const readOnly: ExecutionProfile = {
      breadth: 'narrow', writes: false, reasoningDepth: 'mechanical', delegates: false,
      rationale: 'store implementer: plumbing fully described by its contract',
    };
    const bare: ExecutionBudget = { toolClass: 'read-only', allowNestedDelegation: false, mcp: 'none' };

    expect(summarize(bare, readOnly)).toEqual([
      '- **Work shape**: narrow breadth, mechanical reasoning, read-only',
      '- **Why**: store implementer: plumbing fully described by its contract',
      '- **Tool grant**: read-only',
      '- **May delegate further**: no',
      '- **MCP access**: none',
    ]);
  });

  it('prints a budget the real derivation produced, value first', () => {
    const p = coreDerive(storeImplementer());
    const b = coreResolve(p, cfg('trade'), 'ledger-store-implementer')!;

    const lines = summarize(b, p);
    expect(lines[0]).toBe('- **Work shape**: narrow breadth, mechanical reasoning');
    expect(lines).toContain('- **Capability tier**: small');
    expect(lines).toContain('- **Effort**: medium');
    expect(lines).toContain('- **Tool grant**: implement');
    expect(lines).toContain('- **MCP access**: none');
  });
});

describe('wairon execution reaches the resource axis through cli_core_adapter, not through sdd_core modules', () => {
  it('answers, for the same agent, exactly what the Portal and the two Orchestrators answer', () => {
    const agent = billingOwner();

    expect(adapter.deriveExecutionProfile(agent)).toEqual(portal.deriveExecutionProfile(agent));
    expect(adapter.deriveExecutionProfile(agent)).toEqual(coreDerive(agent));

    const profile = adapter.deriveExecutionProfile(agent);
    expect(adapter.resolveBudget(profile, cfg('default'), agent.id))
      .toEqual(portal.resolveBudget(profile, cfg('default'), agent.id));
    expect(adapter.resolveBudget(profile, cfg('default'), agent.id))
      .toEqual(coreResolve(profile, cfg('default'), agent.id));
  });

  it('still answers nothing at all at the off tier, all the way through the adapter', () => {
    // `off` is the default, and returning nothing is the point of the tier
    // rather than a failure: enabling the feature must never silently change
    // an existing project's generated output. A forward that substituted a
    // default here would undo that guarantee without changing one signature.
    const profile = adapter.deriveExecutionProfile(billingOwner());
    expect(adapter.resolveBudget(profile, cfg('off'), 'billing-owner')).toBeUndefined();
  });

  it('still lets a per-agent override beat derivation through the adapter', () => {
    const agent = storeImplementer();
    const profile = adapter.deriveExecutionProfile(agent);
    const budget = adapter.resolveBudget(
      profile,
      cfg('default', { 'ledger-store-implementer': { modelTier: 'frontier', maxTurns: 200 } }),
      'ledger-store-implementer',
    );

    expect(budget?.modelTier).toBe('frontier');
    expect(budget?.maxTurns).toBe(200);
    // The override merges LAST over everything derived; untouched fields stay derived.
    expect(budget?.toolClass).toBe('implement');
    // And the agentId is really carried across the hop: another agent's id
    // finds no override, which a forward that dropped the argument would miss.
    expect(adapter.resolveBudget(
      profile,
      cfg('default', { 'ledger-store-implementer': { modelTier: 'frontier' } }),
      'some-other-agent',
    )?.modelTier).toBe('small');
  });

  // -- the import site, which no type-check can assert ------------------------

  it('is the only way the command reaches sdd_core — it names no core module', () => {
    // Literal lines, not patterns: an escaped regex has quietly matched
    // nothing here five times.
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/execution.ts'), 'utf8');
    expect(source).not.toContain("from '../core/agent_resolver.js'");
    expect(source).not.toContain("from '../core/execution_profile.js'");
    expect(source).not.toContain("from '../core/budget_policy.js'");
    expect(source).not.toContain("from '../core/index.js'");
    expect(source).toContain("} from './subsystem.js';");
    expect(source).toContain('  resolveAgentTopology,');
    expect(source).toContain('  deriveExecutionProfile,');
    expect(source).toContain('  resolveBudget,');
  });

  it('is published on the core Portal, and forwarded by the adapter in the shape the contract names', () => {
    const portalSource = fs.readFileSync(path.join(REPO_ROOT, 'src/core/index.ts'), 'utf8');
    expect(portalSource).toContain("export { deriveExecutionProfile } from './execution_profile.js';");
    expect(portalSource).toContain("export { resolveBudget } from './budget_policy.js';");

    const adapterSource = fs.readFileSync(path.join(REPO_ROOT, 'src/commands/subsystem.ts'), 'utf8');
    expect(adapterSource).toContain('export function deriveExecutionProfile(agent: AgentRecord): ExecutionProfile {');
    expect(adapterSource).toContain('  return coreDeriveExecutionProfile(agent);');
    expect(adapterSource).toContain('export function resolveBudget(');
    expect(adapterSource).toContain('  return coreResolveBudget(profile, config, agentId);');
  });

  it('leaves the two printers holding a budget and nothing of sdd_core', () => {
    // Both only ever wanted to PRINT an allowance. Now that printing is the
    // budget's own, neither has a reason to name a core module at all — and
    // `src/models/execution.ts` is a type spec's file, not a component's, so
    // naming it is shared vocabulary rather than a crossing.
    for (const file of ['src/cli/index.ts', 'src/mcp/server.ts']) {
      const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
      expect(source, file).not.toContain("from '../core/budget_policy.js'");
      expect(source, file).not.toContain('describeBudget');
      expect(source, file).toContain("import { summarize } from '../models/execution.js';");
      expect(source, file).toContain('summarize(brief.budget, brief.profile)');
    }
  });

  it('leaves the policy deciding an allowance and never rendering one', () => {
    const source = fs.readFileSync(path.join(REPO_ROOT, 'src/core/budget_policy.ts'), 'utf8');
    expect(source).not.toContain('describeBudget');
    expect(source).not.toContain('- **Capability tier**');
    expect(source).toContain('export function resolveBudget(');
  });
});
