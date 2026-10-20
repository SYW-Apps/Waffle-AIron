import { describe, it, expect } from 'vitest';
import { defineRuleFixture, runRuleFixture, type FixtureTree } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// A call through a published Portal that forwards another subsystem's
// function by identity IS the Portal's verb: it is judged as that verb, never
// as the internal component the function belongs to. Stated detail makes the
// narrative the whole list; unstated leaves the route open and says so.
// ---------------------------------------------------------------------------

/**
 * Shop's billing client Adapter depends on billing's published Portal, which
 * re-exports the pricing Orchestrator's `quote` by identity. The adapter's
 * `charge` calls `quote` through that Portal module and records the charge
 * through a verb the narrative always names.
 */
function shopTree(opts: { stated: boolean; narratesQuote: boolean }): FixtureTree {
  return {
    subsystems: [
      { id: 'shop', description: 'Takes orders and charges customers for them.' },
      {
        id: 'billing',
        description: 'Prices orders and records charges.',
        publicInterfaces: [{ details: 'Pricing and charging for sibling subsystems.', component: 'billing-portal' }],
      },
    ],
    components: [
      { id: 'billing-client', subsystem: 'shop', componentType: 'Adapter', description: 'Reaches billing for the shop.', dependsOn: ['billing-portal'] },
      {
        id: 'billing-portal', subsystem: 'billing', componentType: 'Portal', transport: 'InProcess', abi: 'typescript',
        description: 'Billing\'s in-process front door.', dependsOn: ['pricing'],
        invokedBy: { kind: 'entry', caller: 'sibling subsystems linking billing in process' },
      },
      { id: 'pricing', subsystem: 'billing', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Prices an order.' },
    ],
    interfaces: [
      {
        id: 'ibilling_client', component: 'billing-client',
        methods: [{ name: 'charge', description: 'Price an order and charge it.', signature: 'charge(orderId: string): int', returns: 'int', params: [{ name: 'orderId', type: 'string' }], effect: 'io' }],
      },
      {
        id: 'ibilling_portal', component: 'billing-portal',
        methods: [
          { name: 'quote', description: 'Answer the price of an order.', signature: 'quote(orderId: string): int', returns: 'int', params: [{ name: 'orderId', type: 'string' }], effect: 'none' },
          { name: 'record', description: 'Record a charge.', signature: 'record(orderId: string, amount: int): void', returns: 'void', params: [{ name: 'orderId', type: 'string' }, { name: 'amount', type: 'int' }], effect: 'none' },
        ],
      },
      {
        id: 'ipricing', component: 'pricing',
        methods: [{ name: 'quote', description: 'Answer the price of an order.', signature: 'quote(orderId: string): int', returns: 'int', params: [{ name: 'orderId', type: 'string' }], effect: 'none' }],
      },
    ],
    implementations: [
      {
        id: 'billing_client_impl', contract: 'ibilling_client', sourcePath: 'src/shop/billing-client.ts',
        ...(opts.stated ? { detail: 'calls-only' } : {}),
        methods: [{
          name: 'charge',
          narrative: [
            opts.narratesQuote
              ? { stepNumber: 1, type: 'call', targetComponent: 'billing-portal', targetMethod: 'quote', description: 'Ask billing for the order\'s price.' }
              : { stepNumber: 1, type: 'local', description: 'Work out the order\'s price.' },
            { stepNumber: 2, type: 'call', targetComponent: 'billing-portal', targetMethod: 'record', description: 'Record the charge with billing.' },
            { stepNumber: 3, type: 'return', outcome: 'success', description: 'Answer the amount charged.' },
          ],
        }],
      },
      {
        id: 'billing_portal_impl', contract: 'ibilling_portal', sourcePath: 'src/billing/portal.ts',
        methods: [
          { name: 'quote', narrative: [{ stepNumber: 1, type: 'call', targetComponent: 'pricing', targetMethod: 'quote', description: 'Price it with the pricing rules.' }, { stepNumber: 2, type: 'return', outcome: 'success', description: 'Answer the price.' }] },
          { name: 'record', detail: 'intent', narrative: [], intent: 'Records the charged amount for the order; it never fails.' },
        ],
      },
      {
        id: 'pricing_impl', contract: 'ipricing', sourcePath: 'src/billing/pricing.ts',
        methods: [{ name: 'quote', detail: 'intent', narrative: [], intent: 'Answers the order price, derived from the order id alone; it never fails.' }],
      },
    ],
    files: {
      'src/billing/pricing.ts': 'export function quote(orderId: string): number {\n  return orderId.length * 100;\n}\n',
      'src/billing/portal.ts': 'export { quote } from \'./pricing.js\';\n\nexport function record(orderId: string, amount: number): void {\n  void orderId;\n  void amount;\n}\n',
      'src/shop/billing-client.ts': 'import { quote, record } from \'../billing/portal.js\';\n\nexport function charge(orderId: string): number {\n  const amount = quote(orderId);\n  record(orderId, amount);\n  return amount;\n}\n',
    },
  };
}

const run = (code: string, tree: FixtureTree) => runRuleFixture(defineRuleFixture({
  code,
  expectFire: false,
  reason: 'Read directly by the assertions below.',
  scenario: 'The shop charges an order through billing\'s published Portal, which re-exports the pricing function.',
  tree,
}));

describe('calls judged by how much the method states', () => {
  it('stated detail: a call through the published Portal that the narrative leaves out is UNNARRATED_CALL on the Portal verb, never on the internal', () => {
    const { matching } = run('UNNARRATED_CALL', shopTree({ stated: true, narratesQuote: false }));
    expect(matching).toHaveLength(1);
    expect(matching[0].message).toContain('billing-portal.quote');
    expect(matching[0].message).not.toContain('pricing.quote');
  });

  it('stated detail: the narrated call through the Portal is the Portal verb, so nothing is reported', () => {
    const tree = shopTree({ stated: true, narratesQuote: true });
    expect(run('UNNARRATED_CALL', tree).matching).toEqual([]);
    expect(run('OPEN_ROUTE_CALL', tree).matching).toEqual([]);
  });

  it('unstated detail: leaving out a verb of a collaborator the narrative names is still UNNARRATED_CALL', () => {
    const { matching } = run('UNNARRATED_CALL', shopTree({ stated: false, narratesQuote: false }));
    expect(matching).toHaveLength(1);
    expect(matching[0].message).toContain('billing-portal.quote');
  });
});
