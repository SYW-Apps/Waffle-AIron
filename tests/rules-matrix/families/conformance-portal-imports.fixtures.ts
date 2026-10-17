/**
 * Portal imports (code↔spec Level 2, where a crossing lands) —
 * src/core/rules/conformance/portal-imports.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - IMPORT_BYPASSES_PORTAL (warning): a runtime import that crosses a
 *    subsystem boundary must land on a file realizing one of the target
 *    subsystem's PUBLISHED components — its portal file. dependency-
 *    conformance asks whether the hop is declared; this asks where it lands.
 *    An import between files of one subsystem crosses nothing.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

export default [
  defineRuleFixture({
    code: 'IMPORT_BYPASSES_PORTAL',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout orchestrator declares its edge to billing\'s published portal, but its in-process import lands in billing\'s concrete invoicing engine module, past the portal.',
    tree: checkoutTree('../billing/invoicing-engine.js', 'generateInvoice'),
  }),
  defineRuleFixture({
    code: 'IMPORT_BYPASSES_PORTAL',
    expectFire: false,
    reason: 'The crossing import lands on the file that realizes billing\'s published portal, which is the sanctioned landing.',
    scenario:
      'The checkout orchestrator imports requestInvoice from billing\'s portal file, the component billing publishes.',
    tree: checkoutTree('../billing/billing-portal.js', 'requestInvoice'),
  }),
  defineRuleFixture({
    code: 'IMPORT_BYPASSES_PORTAL',
    expectFire: false,
    reason: 'An import between two files of one subsystem crosses no boundary, whatever it lands on.',
    scenario:
      'Billing\'s portal imports its own invoicing engine module to dispatch inward; both files realize billing components.',
    tree: {
      ...checkoutTree('../billing/billing-portal.js', 'requestInvoice'),
      files: {
        ...checkoutTree('../billing/billing-portal.js', 'requestInvoice').files,
        'src/billing/billing-portal.ts': [
          'import { generateInvoice } from \'./invoicing-engine.js\';',
          '',
          'export function requestInvoice(orderId: string): void {',
          '  generateInvoice(orderId);',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
];

/**
 * Checkout depends on billing's published portal; only where its import lands
 * varies.
 */
function checkoutTree(importPath: string, importedName: string): FixtureTree {
  return {
    subsystems: [
      { id: 'checkout', description: 'Cart, order placement, and hand-off to billing.' },
      {
        id: 'billing',
        description: 'Invoicing for placed orders.',
        publicInterfaces: [{ type: 'REST', details: 'Invoicing REST API for sibling subsystems.', component: 'billing-portal' }],
      },
    ],
    components: [
      {
        id: 'checkout-orchestrator',
        componentType: 'Orchestrator',
        subsystem: 'checkout',
        description: 'Places the order and requests the invoice.',
        dependsOn: ['billing-portal'],
      },
      {
        id: 'billing-portal',
        componentType: 'Portal',
        portalType: 'HTTP_API',
        subsystem: 'billing',
        description: 'Billing\'s published invoicing API.',
        dependsOn: ['invoicing-engine'],
      },
      {
        id: 'invoicing-engine',
        componentType: 'Orchestrator',
        subsystem: 'billing',
        description: 'Turns placed orders into issued invoices.',
      },
    ],
    interfaces: [
      {
        id: 'icheckout_orchestrator',
        component: 'checkout-orchestrator',
        methods: [{ name: 'placeOrder', description: 'Place the order and request its invoice.' }],
      },
      {
        id: 'ibilling_portal',
        component: 'billing-portal',
        methods: [{ name: 'requestInvoice', description: 'Request an invoice for a placed order.' }],
      },
      {
        id: 'iinvoicing_engine',
        component: 'invoicing-engine',
        methods: [{ name: 'generateInvoice', description: 'Assemble and issue the invoice.' }],
      },
    ],
    implementations: [
      {
        id: 'checkout_orchestrator_impl',
        contract: 'icheckout_orchestrator',
        sourcePath: 'src/checkout/checkout-orchestrator.ts',
        methods: [
          {
            name: 'placeOrder',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Persist the order and trigger invoicing.' }],
          },
        ],
      },
      {
        id: 'billing_portal_impl',
        contract: 'ibilling_portal',
        sourcePath: 'src/billing/billing-portal.ts',
        methods: [
          {
            name: 'requestInvoice',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the request and forward it to the invoicing engine.' }],
          },
        ],
      },
      {
        id: 'invoicing_engine_impl',
        contract: 'iinvoicing_engine',
        sourcePath: 'src/billing/invoicing-engine.ts',
        methods: [
          {
            name: 'generateInvoice',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Assemble the order\'s line items into an invoice.' }],
          },
        ],
      },
    ],
    files: {
      'src/checkout/checkout-orchestrator.ts': [
        `import { ${importedName} } from '${importPath}';`,
        '',
        'export function placeOrder(orderId: string): void {',
        `  ${importedName}(orderId);`,
        '}',
        '',
      ].join('\n'),
      'src/billing/billing-portal.ts': [
        'export function requestInvoice(orderId: string): void {',
        '  // validate and forward to the invoicing engine',
        '}',
        '',
      ].join('\n'),
      'src/billing/invoicing-engine.ts': [
        'export function generateInvoice(orderId: string): void {',
        '  // assemble line items and issue the invoice',
        '}',
        '',
      ].join('\n'),
    },
  };
}
