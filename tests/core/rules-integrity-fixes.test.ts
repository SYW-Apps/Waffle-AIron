import { describe, it, expect } from 'vitest';
import { buildRuleContext, type BuildContextOptions } from '../../src/core/rules/index.js';
import { typeReferencesRule } from '../../src/core/rules/integrity/type-references.js';
import { hierarchyRule } from '../../src/core/rules/integrity/hierarchy-integrity.js';
import { fieldTypeRefs } from '../../src/models/index.js';
import type { ValidationIssue } from '../../src/core/validation.js';

// ---------------------------------------------------------------------------
// Integrity family: equivalence pins for two refactors that must not change a
// single verdict. Field type references resolve through the shared
// ctx.isTypeResolved, as method references already did; an implementation
// whose contract does not resolve takes its draft context from the shared
// ctx.isImplementationDraft recipe.
// ---------------------------------------------------------------------------

const stamp = { createdAt: '2026-09-15T10:00:00Z', updatedAt: '2026-09-15T10:00:00Z' };

function context(overrides: Partial<BuildContextOptions>) {
  const issues: ValidationIssue[] = [];
  const ctx = buildRuleContext({
    system: { schemaVersion: '1.0.0', name: 'LedgerSystem', vision: 'v', ...stamp } as never,
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
  return { ctx, issues };
}

describe('type-references — field references resolve exactly as ctx.isTypeResolved does', () => {
  const FIELD_TYPES = [
    'STRING', 'List<T>', 't', 'Map<string, T>', 'billing::money', 'Money', 'ledger::money',
    'Customer', 'Page<Customer>', 'decimal // minor units', "'pending' | 'settled'",
  ];

  it('reports as undefined precisely the field references isTypeResolved cannot resolve', () => {
    const money = { id: 'money', name: 'Money', kind: 'value-object', subsystem: 'billing', fields: [{ name: 'amount', type: 'decimal' }], ...stamp };
    const page = { id: 'page', name: 'Page<T>', kind: 'value-object', fields: FIELD_TYPES.map((type, i) => ({ name: `field${i}`, type })), ...stamp };
    const billing = { id: 'billing', name: 'billing', description: 'd', parentSystem: 'LedgerSystem', publicInterfaces: [], trustedLinks: [], status: 'complete', ...stamp };
    const { ctx, issues } = context({ subsystems: [billing] as never, types: [money, page] as never });

    typeReferencesRule.check(ctx);

    const reported = issues
      .filter(i => i.code === 'UNDEFINED_TYPE_REFERENCE' && i.specId === 'page')
      .map(i => /references undefined type "([^"]+)" in "([^"]+)"/.exec(i.message)!.slice(1).join(' in '));
    const unresolvedByContext = FIELD_TYPES.flatMap(type =>
      fieldTypeRefs(page, type).filter(ref => !ctx.isTypeResolved(ref, new Set())).map(ref => `${ref} in ${type}`));
    expect(reported).toEqual(unresolvedByContext);
    expect(reported).toEqual(['ledger::money in ledger::money', 'Customer in Customer', 'Customer in Page<Customer>']);
  });
});

describe('hierarchy-integrity — an unresolved contract takes its draft context from the implementation alone', () => {
  it('marks the finding draft for a draft implementation and never for a complete one, whatever interfaces share an id', () => {
    const intf = (status: string) => ({ id: 'iledger_poster', name: 'LedgerPoster', description: 'd', component: 'ledger-poster', methods: [], status, ...stamp });
    const impl = (id: string, contract: string, status: string) => ({ id, name: id, description: 'd', contract, methods: [], status, ...stamp });
    const { ctx, issues } = context({
      interfaces: [intf('draft'), intf('complete')] as never,
      implementations: [
        impl('draft_archive_impl', 'iledger_archive', 'draft'),
        impl('complete_archive_impl', 'iledger_archive', 'complete'),
        impl('ledger_poster_impl', 'iledger_poster', 'complete'),
      ] as never,
    });

    hierarchyRule.check(ctx);

    expect(issues.filter(i => i.code === 'INVALID_INTERFACE_REFERENCE').map(i => [i.specId, i.draftContext ?? false])).toEqual([
      ['draft_archive_impl', true],
      ['complete_archive_impl', false],
    ]);
  });
});
