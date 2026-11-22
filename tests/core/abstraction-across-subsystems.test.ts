import { describe, it, expect } from 'vitest';
import { runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// An abstraction published with role implement and implemented from another
// subsystem, with its code: the implementer's import of the interface crosses
// the boundary the publication opened, so nothing is above a notice.

function payments(published: boolean): FixtureTree {
  const method = { name: 'capture', description: 'Capture one authorized amount of money.', params: [{ name: 'amount', type: 'int' }], returns: 'void', effect: 'write' };
  const gateway = (id: string) => ({
    component: { id, componentType: 'Adapter', subsystem: 'providers', description: 'One live provider that captures money.' },
    contract: { id: `i${id.split('-').join('_')}`, component: id, implements: ['money-taker'], methods: [method] },
    impl: {
      id: `${id.split('-').join('_')}_impl`, contract: `i${id.split('-').join('_')}`, sourcePath: `src/providers/${id}.ts`,
      methods: [{ name: 'capture', narrative: [{ stepNumber: 1, type: 'local', description: 'Capture the amount through this provider and keep its receipt.' }] }],
    },
  });
  const providers = [gateway('stripe-adapter'), gateway('adyen-adapter')];
  const className = (id: string): string => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return {
    system: { name: 'Checkout', vision: 'Takes money through several live providers.' },
    subsystems: [
      {
        id: 'payments', description: 'Takes payment for each order.',
        ...(published ? { publicInterfaces: [{ component: 'money-taker', role: 'implement', details: 'The contract each provider implements.' }] } : {}),
      },
      { id: 'providers', description: 'The providers money is taken through.' },
    ],
    components: [
      { id: 'money-taker', componentType: 'Adapter', abstract: true, subsystem: 'payments', description: 'The contract every provider implements.', invokedBy: { kind: 'runtime', caller: 'The composition root hands each payment to the chosen provider.' } },
      ...providers.map((p) => p.component),
    ],
    interfaces: [{ id: 'imoney_taker', component: 'money-taker', methods: [method] }, ...providers.map((p) => p.contract)],
    implementations: [{ id: 'money_taker_impl', contract: 'imoney_taker', sourcePath: 'src/payments/money-taker.ts', methods: [{ name: 'capture' }] }, ...providers.map((p) => p.impl)],
    files: {
      'src/payments/money-taker.ts': 'export abstract class MoneyTaker { abstract capture(amount: number): void }\n',
      ...Object.fromEntries(providers.map((p) => [
        `src/providers/${p.component.id}.ts`,
        `import { MoneyTaker } from '../payments/money-taker';\nexport class ${className(p.component.id)} extends MoneyTaker { capture(amount: number): void { void amount; } }\n`,
      ])),
    },
  };
}

const findings = (tree: FixtureTree): string[] => runRuleFixture({ code: 'NONE', expectFire: false, scenario: 'A checkout whose payment providers live in a subsystem of their own.', tree })
  .issues.filter((i) => i.severity !== 'notice').map((i) => `${i.code} @${i.specId}`);

describe('an abstraction implemented from another subsystem', () => {
  it('raises nothing when its subsystem publishes it with role implement', () => {
    expect(findings(payments(true))).toEqual([]);
  });

  it('is ABSTRACTION_UNPUBLISHED on each implementer without the publication', () => {
    expect(findings(payments(false)).filter((f) => f.startsWith('ABSTRACTION_UNPUBLISHED')).sort())
      .toEqual(['ABSTRACTION_UNPUBLISHED @adyen-adapter', 'ABSTRACTION_UNPUBLISHED @stripe-adapter']);
  });
});
