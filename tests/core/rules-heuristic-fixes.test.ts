import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions, type SddRule } from '../../src/core/rules/index.js';
import { emptyExtensions } from '../../src/core/extensions.js';
import { RulesConfigSchema } from '../../src/models/project.js';
import type { ValidationIssue } from '../../src/core/validation.js';
import { couplingRule } from '../../src/core/rules/heuristic/coupling-health.js';
import { complexityRule } from '../../src/core/rules/heuristic/complexity-and-metadata.js';
import { namingRule } from '../../src/core/rules/heuristic/naming-conventions.js';
import { languageRule } from '../../src/core/rules/heuristic/target-language.js';
import { technologyRule } from '../../src/core/rules/heuristic/technology-boundaries.js';

// ---------------------------------------------------------------------------
// Reported misbehaviour in the heuristic family: GOD_COMPONENT reading a
// different dependency cap than EXCESSIVE_DEPENDENCIES, and findings whose
// draft context was not decided from the spec they report on.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' };

const sub = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} subsystem.`, parentSystem: 'Marketplace', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp, ...extra }) as never;

const comp = (id: string, subsystem: string, extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} component.`, subsystem, componentType: 'Orchestrator', dependsOn: [], owns: [], status: 'complete', ...stamp, ...extra }) as never;

const intf = (id: string, component: string, methodNames: string[], extra: Record<string, unknown> = {}) =>
  ({
    id, name: id, description: `The ${id} contract.`, component,
    methods: methodNames.map(name => ({ name, description: `${name} does its one job.`, signature: `${name}(): void`, returns: 'void' })),
    status: 'complete', ...stamp, ...extra,
  }) as never;

const impl = (id: string, contract: string, methods: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  ({ id, name: id, description: `The ${id} realization.`, contract, methods: methods.map(m => ({ narrative: [], ...m })), status: 'complete', ...stamp, ...extra }) as never;

const step = (stepNumber: number, extra: Record<string, unknown> = {}) =>
  ({ stepNumber, description: `Step ${stepNumber} of the flow.`, type: 'local', ...extra });

function run(rule: SddRule, overrides: Partial<BuildContextOptions>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ctx = buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'Marketplace', vision: 'v', ...stamp } as never,
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    projectType: 'backend',
    roundTripIssues: [],
    knownIssueCodes: new Set<string>(),
    issues,
    ...overrides,
  });
  rule.check(ctx);
  return issues;
}

const found = (issues: ValidationIssue[], code: string, specId: string): ValidationIssue | undefined =>
  issues.find(i => i.code === code && i.specId === specId);

describe('coupling-health — GOD_COMPONENT reads the effective complexity config', () => {
  const collaborators = ['card-adapter', 'fraud-screen', 'ledger-repository', 'receipt-mailer'];

  it("holds a component to its subsystem profile pack's cap — the value EXCESSIVE_DEPENDENCIES reads", () => {
    const ext = emptyExtensions();
    ext.profiles['lean-services'] = {
      family: 'neutral', forbiddenStereotypes: [], discouragedStereotypes: [],
      rules: { complexity: { maxComponentDependencies: 3 } },
    } as never;
    const tree: Partial<BuildContextOptions> = {
      subsystems: [sub('payments', { profile: 'lean-services' }), sub('reporting')],
      components: [
        comp('payment-orchestrator', 'payments', { dependsOn: collaborators }),
        comp('report-orchestrator', 'reporting', { dependsOn: collaborators }),
      ],
      rules: RulesConfigSchema.parse({}),
      extensions: ext,
    };
    expect(run(complexityRule, tree).filter(i => i.code === 'EXCESSIVE_DEPENDENCIES').map(i => i.specId)).toEqual(['payment-orchestrator']);
    expect(run(couplingRule, tree).filter(i => i.code === 'GOD_COMPONENT').map(i => i.specId)).toEqual(['payment-orchestrator']);
  });

  it('keeps the project cap where no pack sets one, and its own default of 8 where nothing does', () => {
    const fanOut = (n: number) => Array.from({ length: n }, (_, i) => `collaborator-${i + 1}`);
    const god = (rules: Record<string, unknown>) => run(couplingRule, {
      subsystems: [sub('payments')],
      components: [
        comp('settlement-orchestrator', 'payments', { dependsOn: fanOut(8) }),
        comp('payout-orchestrator', 'payments', { dependsOn: fanOut(9) }),
        comp('dispute-orchestrator', 'payments', { dependsOn: fanOut(10) }),
        comp('chargeback-orchestrator', 'payments', { dependsOn: fanOut(11) }),
      ],
      rules: RulesConfigSchema.parse(rules),
    }).filter(i => i.code === 'GOD_COMPONENT').map(i => i.specId);
    expect(god({})).toEqual(['payout-orchestrator', 'dispute-orchestrator', 'chargeback-orchestrator']);
    expect(god({ complexity: { maxComponentDependencies: 10 } })).toEqual(['chargeback-orchestrator']);
  });
});

describe('heuristic draft context — naming-conventions', () => {
  const issues = () => run(namingRule, {
    rules: RulesConfigSchema.parse({ naming: { methods: 'camelCase', subsystems: 'kebab-case' } }),
    subsystems: [sub('ledger'), sub('Ledger_Archive', { status: 'draft' })],
    components: [comp('ledger-orchestrator', 'ledger', { status: 'draft' })],
    interfaces: [intf('iledger_orchestrator', 'ledger-orchestrator', ['postEntry'])],
    implementations: [impl('ledger_orchestrator_impl', 'iledger_orchestrator', [{ name: 'Post_Entry' }])],
  });

  it('an implementation method finding under a draft component is in draft context', () => {
    expect(found(issues(), 'NAMING_CONVENTION_VIOLATION', 'ledger_orchestrator_impl')?.draftContext).toBe(true);
  });

  it('a draft subsystem finding is in draft context', () => {
    expect(found(issues(), 'NAMING_CONVENTION_VIOLATION', 'Ledger_Archive')?.draftContext).toBe(true);
  });
});

describe('heuristic draft context — complexity-and-metadata', () => {
  const issues = () => run(complexityRule, {
    rules: RulesConfigSchema.parse({
      complexity: { maxSubsystemComponents: 0 },
      documentation: { requireDescriptions: true },
    }),
    subsystems: [sub('ledger', { status: 'draft', description: '' })],
    components: [comp('ledger-orchestrator', 'ledger')],
    interfaces: [intf('iledger_orchestrator', 'ledger-orchestrator', ['postEntry'], { status: 'draft' })],
    implementations: [impl('ledger_orchestrator_impl', 'iledger_orchestrator', [{ name: 'postEntry', narrative: [step(1), step(2)] }])],
  });

  // EXCESSIVE_NARRATIVE_STEPS moved to narrative-complexity, which judges both
  // narrative axes; its draft context is asserted beside that rule's own tests.

  it("a draft subsystem's missing description is in draft context", () => {
    expect(found(issues(), 'MISSING_DESCRIPTION', 'ledger')?.draftContext).toBe(true);
  });

  it("a draft subsystem's component count is in draft context", () => {
    expect(found(issues(), 'EXCESSIVE_SUBSYSTEM_COMPONENTS', 'ledger')?.draftContext).toBe(true);
  });
});

describe('heuristic draft context — target-language', () => {
  it('an implementation whose contract is draft is in draft context (the shared recipe, unchanged)', () => {
    const issues = run(languageRule, {
      system: { schemaVersion: '1.0.0', name: 'Marketplace', vision: 'v', targetLanguage: 'rust', ...stamp } as never,
      subsystems: [sub('ledger')],
      components: [comp('ledger-orchestrator', 'ledger')],
      interfaces: [intf('iledger_orchestrator', 'ledger-orchestrator', ['postEntry'], { status: 'draft' })],
      implementations: [impl('ledger_orchestrator_impl', 'iledger_orchestrator', [{ name: 'postEntry', narrative: [step(1, { type: 'throw', error: 'Unbalanced' })] }])],
    });
    expect(found(issues, 'LANGUAGE_FOREIGN_FLOW', 'ledger_orchestrator_impl')?.draftContext).toBe(true);
  });
});

describe('heuristic draft context — technology-boundaries', () => {
  const issues = () => run(technologyRule, {
    subsystems: [
      sub('crm'),
      sub('analytics', { status: 'draft', description: 'Nightly MySQL exports for the finance team.' }),
      sub('insights'),
    ],
    components: [
      comp('customer-db-adapter', 'crm', { componentType: 'Adapter' }),
      comp('insight-orchestrator', 'insights'),
      comp('session-orchestrator', 'insights'),
      comp('report-orchestrator', 'insights'),
    ],
    interfaces: [
      intf('icustomer_db_adapter', 'customer-db-adapter', ['fetchCustomer']),
      intf('iinsight_orchestrator', 'insight-orchestrator', ['summarize']),
      intf('isession_orchestrator', 'session-orchestrator', ['resumeSession']),
      intf('ireport_orchestrator', 'report-orchestrator', ['exportToMysql'], { status: 'draft', description: 'Streams report rows out of MySQL.' }),
    ],
    implementations: [
      impl('customer_db_adapter_impl', 'icustomer_db_adapter', [{ name: 'fetchCustomer' }], { technologies: ['mysql'] }),
      impl('insight_orchestrator_impl', 'iinsight_orchestrator', [{ name: 'summarize' }], { status: 'draft', description: 'Reads the mysql replica directly.' }),
      impl('session_orchestrator_impl', 'isession_orchestrator', [{ name: 'resumeSession' }], { status: 'draft', technologies: ['redis'] }),
    ],
  });

  it('a draft subsystem leaking the technology is in draft context', () => {
    expect(found(issues(), 'TECH_LEAKAGE', 'analytics')?.draftContext).toBe(true);
  });

  it('a draft implementation leaking the technology is in draft context', () => {
    expect(found(issues(), 'TECH_LEAKAGE', 'insight_orchestrator_impl')?.draftContext).toBe(true);
  });

  it('a draft implementation binding a technology on a logic component is in draft context', () => {
    expect(found(issues(), 'TECH_ON_LOGIC_COMPONENT', 'session_orchestrator_impl')?.draftContext).toBe(true);
  });

  it('a draft interface naming the vendor in its identifiers is in draft context', () => {
    expect(found(issues(), 'VENDOR_NAME_IN_CONTRACT', 'ireport_orchestrator')?.draftContext).toBe(true);
  });

  it('a draft interface describing the technology is in draft context', () => {
    expect(found(issues(), 'TECH_LEAKAGE', 'ireport_orchestrator')?.draftContext).toBe(true);
  });

  it('a complete interface in a complete subsystem reports nothing here', () => {
    expect(found(issues(), 'VENDOR_NAME_IN_CONTRACT', 'icustomer_db_adapter')).toBeUndefined();
  });
});
