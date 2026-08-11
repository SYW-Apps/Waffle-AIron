/**
 * Dependency conformance (code↔spec Level 2) — src/core/rules/dependency-conformance.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - UNDECLARED_DEPENDENCY (warning): a runtime import edge between
 *    component-mapped source files that no declared relation justifies.
 *    Justified when the files share a component, a component pair has a
 *    direct dependsOn/owns edge, the target is a member of a depended-on
 *    pattern, or — across subsystems — the importer declares an edge to the
 *    target subsystem's PUBLISHED surface (the in-process import may land in
 *    the subsystem's concrete modules; the published-portal declaration is
 *    the sanctioned hop, its barrel is cosmetic at runtime). Type-only
 *    imports are exempt (excluded at collection).
 *  - UNREALIZED_DEPENDENCY (warning): a declared dependsOn/owns edge between
 *    components realized in different files with no import edge realizing it.
 *    Skipped when either side shares a file (N:1 collapse); a mounting
 *    declarer (Portal/Observer) is satisfied by the REVERSE import (the
 *    server file imports the portal's file).
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // UNDECLARED_DEPENDENCY — fire 1: same-subsystem import with no declared edge
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'payment_orchestrator_impl',
    expectFire: true,
    scenario:
      'The payment orchestrator module imports and calls the payment gateway adapter, but the component declares no dependsOn edge, so the code collaborates behind the spec\'s back.',
    tree: {
      subsystems: [{ id: 'payments', description: 'Payment capture and refunds for placed orders.' }],
      components: [
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Drives the capture flow for authorized orders.',
        },
        {
          id: 'payment-gateway-adapter',
          componentType: 'Adapter',
          subsystem: 'payments',
          description: 'Wraps the external PSP charge API.',
        },
      ],
      interfaces: [
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for an order.' }],
        },
        {
          id: 'ipayment_gateway_adapter',
          component: 'payment-gateway-adapter',
          methods: [{ name: 'chargeCard', description: 'Charge the stored card via the PSP.' }],
        },
      ],
      implementations: [
        {
          id: 'payment_orchestrator_impl',
          contract: 'ipayment_orchestrator',
          sourcePath: 'src/payments/payment-orchestrator.ts',
          methods: [
            {
              name: 'capturePayment',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Look up the authorization and capture the amount.' }],
            },
          ],
        },
        {
          id: 'payment_gateway_adapter_impl',
          contract: 'ipayment_gateway_adapter',
          sourcePath: 'src/payments/payment-gateway-adapter.ts',
          methods: [
            {
              name: 'chargeCard',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Send the charge request to the PSP over HTTPS.' }],
            },
          ],
        },
      ],
      files: {
        'src/payments/payment-orchestrator.ts': [
          'import { chargeCard } from \'./payment-gateway-adapter.js\';',
          '',
          'export function capturePayment(orderId: string): void {',
          '  chargeCard(orderId);',
          '}',
          '',
        ].join('\n'),
        'src/payments/payment-gateway-adapter.ts': [
          'export function chargeCard(orderId: string): void {',
          '  // POST the charge to the PSP',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason: 'The importing component declares the dependsOn edge, which is the primary documented justification for a runtime import.',
    scenario:
      'The payment orchestrator imports the payment gateway adapter and declares the matching dependsOn edge on the component.',
    tree: {
      subsystems: [{ id: 'payments', description: 'Payment capture and refunds for placed orders.' }],
      components: [
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Drives the capture flow for authorized orders.',
          dependsOn: ['payment-gateway-adapter'],
        },
        {
          id: 'payment-gateway-adapter',
          componentType: 'Adapter',
          subsystem: 'payments',
          description: 'Wraps the external PSP charge API.',
        },
      ],
      interfaces: [
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for an order.' }],
        },
        {
          id: 'ipayment_gateway_adapter',
          component: 'payment-gateway-adapter',
          methods: [{ name: 'chargeCard', description: 'Charge the stored card via the PSP.' }],
        },
      ],
      implementations: [
        {
          id: 'payment_orchestrator_impl',
          contract: 'ipayment_orchestrator',
          sourcePath: 'src/payments/payment-orchestrator.ts',
          methods: [
            {
              name: 'capturePayment',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Look up the authorization and capture the amount.' }],
            },
          ],
        },
        {
          id: 'payment_gateway_adapter_impl',
          contract: 'ipayment_gateway_adapter',
          sourcePath: 'src/payments/payment-gateway-adapter.ts',
          methods: [
            {
              name: 'chargeCard',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Send the charge request to the PSP over HTTPS.' }],
            },
          ],
        },
      ],
      files: {
        'src/payments/payment-orchestrator.ts': [
          'import { chargeCard } from \'./payment-gateway-adapter.js\';',
          '',
          'export function capturePayment(orderId: string): void {',
          '  chargeCard(orderId);',
          '}',
          '',
        ].join('\n'),
        'src/payments/payment-gateway-adapter.ts': [
          'export function chargeCard(orderId: string): void {',
          '  // POST the charge to the PSP',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason:
      'Type-only imports never reach the code model (documented: type coupling is allowed by default and excluded at collection), so the undeclared edge is only about types and stays quiet.',
    scenario:
      'The payment orchestrator imports only the ChargeReceipt type from the gateway adapter module, with no declared edge and no runtime collaboration.',
    tree: {
      subsystems: [{ id: 'payments', description: 'Payment capture and refunds for placed orders.' }],
      components: [
        {
          id: 'payment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'payments',
          description: 'Drives the capture flow for authorized orders.',
        },
        {
          id: 'payment-gateway-adapter',
          componentType: 'Adapter',
          subsystem: 'payments',
          description: 'Wraps the external PSP charge API.',
        },
      ],
      interfaces: [
        {
          id: 'ipayment_orchestrator',
          component: 'payment-orchestrator',
          methods: [{ name: 'capturePayment', description: 'Capture the authorized amount for an order.' }],
        },
        {
          id: 'ipayment_gateway_adapter',
          component: 'payment-gateway-adapter',
          methods: [{ name: 'chargeCard', description: 'Charge the stored card via the PSP.' }],
        },
      ],
      implementations: [
        {
          id: 'payment_orchestrator_impl',
          contract: 'ipayment_orchestrator',
          sourcePath: 'src/payments/payment-orchestrator.ts',
          methods: [
            {
              name: 'capturePayment',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Look up the authorization and capture the amount.' }],
            },
          ],
        },
        {
          id: 'payment_gateway_adapter_impl',
          contract: 'ipayment_gateway_adapter',
          sourcePath: 'src/payments/payment-gateway-adapter.ts',
          methods: [
            {
              name: 'chargeCard',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Send the charge request to the PSP over HTTPS.' }],
            },
          ],
        },
      ],
      files: {
        'src/payments/payment-orchestrator.ts': [
          'import type { ChargeReceipt } from \'./payment-gateway-adapter.js\';',
          '',
          'export function capturePayment(orderId: string): ChargeReceipt | null {',
          '  return null;',
          '}',
          '',
        ].join('\n'),
        'src/payments/payment-gateway-adapter.ts': [
          'export interface ChargeReceipt {',
          '  orderId: string;',
          '  capturedAmount: number;',
          '}',
          '',
          'export function chargeCard(orderId: string): ChargeReceipt {',
          '  return { orderId, capturedAmount: 0 };',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_DEPENDENCY — fire 2 + control: the cross-subsystem
  // published-surface justification
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout orchestrator imports the billing subsystem\'s concrete invoicing engine module without declaring any edge to billing\'s published surface, an unsanctioned cross-subsystem hop.',
    tree: {
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
        },
        {
          id: 'billing-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          subsystem: 'billing',
          description: 'Billing\'s published invoicing API.',
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
          'import { generateInvoice } from \'../billing/invoicing-engine.js\';',
          '',
          'export function placeOrder(orderId: string): void {',
          '  generateInvoice(orderId);',
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
    },
  }),
  defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY',
    expectFire: false,
    reason:
      'The importer declares an edge to the target subsystem\'s PUBLISHED surface (billing-portal), and the documented justification says the in-process import may land in the subsystem\'s concrete modules — the barrel is cosmetic at runtime.',
    scenario:
      'The checkout orchestrator declares its edge to billing\'s published portal while the in-process import physically lands in billing\'s concrete invoicing engine module.',
    tree: {
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
          'import { generateInvoice } from \'../billing/invoicing-engine.js\';',
          '',
          'export function placeOrder(orderId: string): void {',
          '  generateInvoice(orderId);',
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
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_DEPENDENCY — fire: declared edge with no physical import
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    severity: 'warning',
    anchoredTo: 'order_notifier_impl',
    expectFire: true,
    scenario:
      'The order notifier declares a dependsOn edge to the email dispatch adapter, but no runtime import connects their modules — the declared collaboration is stale or wired invisibly.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer-facing order status notifications.' }],
      components: [
        {
          id: 'order-notifier',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Decides which order events notify the customer.',
          dependsOn: ['email-dispatch-adapter'],
        },
        {
          id: 'email-dispatch-adapter',
          componentType: 'Adapter',
          subsystem: 'notifications',
          description: 'Wraps the transactional email provider.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_notifier',
          component: 'order-notifier',
          methods: [{ name: 'notifyOrderShipped', description: 'Notify the customer their order shipped.' }],
        },
        {
          id: 'iemail_dispatch_adapter',
          component: 'email-dispatch-adapter',
          methods: [{ name: 'sendEmail', description: 'Send one transactional email.' }],
        },
      ],
      implementations: [
        {
          id: 'order_notifier_impl',
          contract: 'iorder_notifier',
          sourcePath: 'src/notifications/order-notifier.ts',
          methods: [
            {
              name: 'notifyOrderShipped',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Render the shipped-order template for the customer.' }],
            },
          ],
        },
        {
          id: 'email_dispatch_adapter_impl',
          contract: 'iemail_dispatch_adapter',
          sourcePath: 'src/notifications/email-dispatch-adapter.ts',
          methods: [
            {
              name: 'sendEmail',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Deliver the rendered email via the provider API.' }],
            },
          ],
        },
      ],
      files: {
        'src/notifications/order-notifier.ts': [
          'export function notifyOrderShipped(orderId: string): void {',
          '  // renders the template; the send call was never wired up',
          '}',
          '',
        ].join('\n'),
        'src/notifications/email-dispatch-adapter.ts': [
          'export function sendEmail(to: string, body: string): void {',
          '  // deliver via the provider API',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    expectFire: false,
    reason: 'The declared edge is realized by a runtime import between the two modules.',
    scenario:
      'The order notifier imports the email dispatch adapter it declares, so the declared collaboration is physically realized.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer-facing order status notifications.' }],
      components: [
        {
          id: 'order-notifier',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Decides which order events notify the customer.',
          dependsOn: ['email-dispatch-adapter'],
        },
        {
          id: 'email-dispatch-adapter',
          componentType: 'Adapter',
          subsystem: 'notifications',
          description: 'Wraps the transactional email provider.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_notifier',
          component: 'order-notifier',
          methods: [{ name: 'notifyOrderShipped', description: 'Notify the customer their order shipped.' }],
        },
        {
          id: 'iemail_dispatch_adapter',
          component: 'email-dispatch-adapter',
          methods: [{ name: 'sendEmail', description: 'Send one transactional email.' }],
        },
      ],
      implementations: [
        {
          id: 'order_notifier_impl',
          contract: 'iorder_notifier',
          sourcePath: 'src/notifications/order-notifier.ts',
          methods: [
            {
              name: 'notifyOrderShipped',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Render the shipped-order template for the customer.' }],
            },
          ],
        },
        {
          id: 'email_dispatch_adapter_impl',
          contract: 'iemail_dispatch_adapter',
          sourcePath: 'src/notifications/email-dispatch-adapter.ts',
          methods: [
            {
              name: 'sendEmail',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Deliver the rendered email via the provider API.' }],
            },
          ],
        },
      ],
      files: {
        'src/notifications/order-notifier.ts': [
          'import { sendEmail } from \'./email-dispatch-adapter.js\';',
          '',
          'export function notifyOrderShipped(orderId: string): void {',
          '  sendEmail(\'customer@example.test\', orderId);',
          '}',
          '',
        ].join('\n'),
        'src/notifications/email-dispatch-adapter.ts': [
          'export function sendEmail(to: string, body: string): void {',
          '  // deliver via the provider API',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    expectFire: false,
    reason:
      'Both components are realized in the SAME file, and the documented N:1 collapse skips the check when either side shares a file.',
    scenario:
      'The order notifier and the email dispatch adapter are both realized N:1 in one notifications module, so the declared edge needs no import.',
    tree: {
      subsystems: [{ id: 'notifications', description: 'Customer-facing order status notifications.' }],
      components: [
        {
          id: 'order-notifier',
          componentType: 'Orchestrator',
          subsystem: 'notifications',
          description: 'Decides which order events notify the customer.',
          dependsOn: ['email-dispatch-adapter'],
        },
        {
          id: 'email-dispatch-adapter',
          componentType: 'Adapter',
          subsystem: 'notifications',
          description: 'Wraps the transactional email provider.',
        },
      ],
      interfaces: [
        {
          id: 'iorder_notifier',
          component: 'order-notifier',
          methods: [{ name: 'notifyOrderShipped', description: 'Notify the customer their order shipped.' }],
        },
        {
          id: 'iemail_dispatch_adapter',
          component: 'email-dispatch-adapter',
          methods: [{ name: 'sendEmail', description: 'Send one transactional email.' }],
        },
      ],
      implementations: [
        {
          id: 'order_notifier_impl',
          contract: 'iorder_notifier',
          sourcePath: 'src/notifications/notifications.ts',
          methods: [
            {
              name: 'notifyOrderShipped',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Render the shipped-order template for the customer.' }],
            },
          ],
        },
        {
          id: 'email_dispatch_adapter_impl',
          contract: 'iemail_dispatch_adapter',
          sourcePath: 'src/notifications/notifications.ts',
          methods: [
            {
              name: 'sendEmail',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Deliver the rendered email via the provider API.' }],
            },
          ],
        },
      ],
      files: {
        'src/notifications/notifications.ts': [
          'export function notifyOrderShipped(orderId: string): void {',
          '  sendEmail(\'customer@example.test\', orderId);',
          '}',
          '',
          'export function sendEmail(to: string, body: string): void {',
          '  // deliver via the provider API',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNREALIZED_DEPENDENCY',
    expectFire: false,
    reason:
      'The declarer is a Portal (a mounting declarer), and the documented mounting shape accepts the REVERSE import: the server file imports the portal\'s file to mount it.',
    scenario:
      'The storefront API portal declares it mounts onto the HTTP server supervisor, while physically the server module imports the portal\'s router file to mount it.',
    tree: {
      subsystems: [{ id: 'storefront-web', description: 'Public storefront HTTP entry.' }],
      components: [
        {
          id: 'storefront-api-portal',
          componentType: 'Portal',
          portalType: 'HTTP_API',
          subsystem: 'storefront-web',
          description: 'The storefront\'s public REST API surface.',
          dependsOn: ['http-server-supervisor'],
        },
        {
          id: 'http-server-supervisor',
          componentType: 'Supervisor',
          subsystem: 'storefront-web',
          description: 'Owns the HTTP listener lifecycle and mounts routers.',
        },
      ],
      interfaces: [
        {
          id: 'istorefront_api_portal',
          component: 'storefront-api-portal',
          methods: [{ name: 'getCatalogPage', description: 'Serve one catalog page to the storefront.' }],
        },
        {
          id: 'ihttp_server_supervisor',
          component: 'http-server-supervisor',
          methods: [{ name: 'startServer', description: 'Start the HTTP listener and mount all routers.' }],
        },
      ],
      implementations: [
        {
          id: 'storefront_api_portal_impl',
          contract: 'istorefront_api_portal',
          sourcePath: 'src/web/storefront-api-portal.ts',
          methods: [
            {
              name: 'getCatalogPage',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Serve the requested catalog page.' }],
            },
          ],
        },
        {
          id: 'http_server_supervisor_impl',
          contract: 'ihttp_server_supervisor',
          sourcePath: 'src/web/http-server.ts',
          methods: [
            {
              name: 'startServer',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Bind the port and mount the storefront router.' }],
            },
          ],
        },
      ],
      files: {
        'src/web/storefront-api-portal.ts': [
          'export function getCatalogPage(page: number): string {',
          '  return \'catalog page \' + String(page);',
          '}',
          '',
        ].join('\n'),
        'src/web/http-server.ts': [
          'import { getCatalogPage } from \'./storefront-api-portal.js\';',
          '',
          'export function startServer(port: number): void {',
          '  // bind the listener and dispatch inward to the portal routes',
          '  getCatalogPage(1);',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
];
