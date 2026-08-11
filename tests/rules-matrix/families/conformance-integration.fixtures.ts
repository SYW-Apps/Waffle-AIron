/**
 * Integration conformance (the static sim gate) —
 * src/core/rules/integration-conformance.ts (docs/design/integration-conformance.md §4).
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - MISSING_INTEGRATION_SIM (warning): once a subsystem adopts sims (its
 *    first declared simPath), every OTHER complete, non-leaf implementation
 *    of that subsystem must declare one — adoption is subsystem-by-subsystem,
 *    no global flood on trees that have not adopted sims yet; a leaf's unit
 *    suite IS its sim.
 *  - SIM_FILE_MISSING (warning): a declared simPath resolves to no file
 *    inside the project root — the harness must be a committed, re-runnable
 *    file.
 *  - UNWIRED_INTEGRATION_SIM (warning): the sim file's import graph (closed
 *    transitively, exact grade) must reach the component's own sourcePath
 *    module and at least one sourcePath module of each direct dependency;
 *    technology-boundary dependencies are exempt — their contract-faithful
 *    fakes are sanctioned.
 *  - SIM_PATH_UNCOVERED (warning): once a harness carries sim:<component-id>.
 *    anchors, the component claims path coverage: the happy path of every
 *    narrated method and every LABELED throw step need a
 *    sim:<component>.<method>[:<label>] string-literal anchor; dropping the
 *    component's sim: anchors withdraws the claim.
 */
import { defineRuleFixture } from '../harness.js';

export default [
  // -------------------------------------------------------------------------
  // MISSING_INTEGRATION_SIM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_INTEGRATION_SIM',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout subsystem has adopted integration sims via the cart pricing engine, but the checkout orchestrator — complete, with a declared dependency — still ships with only its mocked unit suite.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['cart-pricing-engine'],
        },
        {
          id: 'cart-pricing-engine',
          componentType: 'Specialist',
          subsystem: 'checkout',
          description: 'Prices the cart including promotions and tax.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'icart_pricing_engine',
          component: 'cart-pricing-engine',
          methods: [{ name: 'priceCart', description: 'Price the cart including promotions and tax.' }],
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
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'cart_pricing_engine_impl',
          contract: 'icart_pricing_engine',
          sourcePath: 'src/checkout/cart-pricing-engine.ts',
          simPath: 'tests/integration/cart-pricing.sim.ts',
          methods: [
            {
              name: 'priceCart',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply promotions and tax to every cart line.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { priceCart } from \'./cart-pricing-engine.js\';',
          '',
          'export function placeOrder(cartId: string): void {',
          '  priceCart(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/cart-pricing.sim.ts': [
          'import { priceCart } from \'../../src/checkout/cart-pricing-engine.js\';',
          '',
          'export function runCartPricingSim(): void {',
          '  priceCart(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'MISSING_INTEGRATION_SIM',
    expectFire: false,
    reason: 'Every complete non-leaf implementation of the adopting subsystem declares its committed harness.',
    scenario:
      'The checkout subsystem adopted sims and the checkout orchestrator declares its own committed integration harness alongside the pricing engine\'s.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['cart-pricing-engine'],
        },
        {
          id: 'cart-pricing-engine',
          componentType: 'Specialist',
          subsystem: 'checkout',
          description: 'Prices the cart including promotions and tax.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'icart_pricing_engine',
          component: 'cart-pricing-engine',
          methods: [{ name: 'priceCart', description: 'Price the cart including promotions and tax.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'cart_pricing_engine_impl',
          contract: 'icart_pricing_engine',
          sourcePath: 'src/checkout/cart-pricing-engine.ts',
          simPath: 'tests/integration/cart-pricing.sim.ts',
          methods: [
            {
              name: 'priceCart',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply promotions and tax to every cart line.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { priceCart } from \'./cart-pricing-engine.js\';',
          '',
          'export function placeOrder(cartId: string): void {',
          '  priceCart(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  placeOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
        'tests/integration/cart-pricing.sim.ts': [
          'import { priceCart } from \'../../src/checkout/cart-pricing-engine.js\';',
          '',
          'export function runCartPricingSim(): void {',
          '  priceCart(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'MISSING_INTEGRATION_SIM',
    expectFire: false,
    reason:
      'No implementation of the subsystem declares a simPath, so the subsystem has not adopted sims — the documented activation gate keeps unadopted trees quiet (no global flood).',
    scenario:
      'The checkout subsystem has not adopted integration sims yet, so the orchestrator with only a mocked unit suite is not flagged.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['cart-pricing-engine'],
        },
        {
          id: 'cart-pricing-engine',
          componentType: 'Specialist',
          subsystem: 'checkout',
          description: 'Prices the cart including promotions and tax.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'icart_pricing_engine',
          component: 'cart-pricing-engine',
          methods: [{ name: 'priceCart', description: 'Price the cart including promotions and tax.' }],
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
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'cart_pricing_engine_impl',
          contract: 'icart_pricing_engine',
          sourcePath: 'src/checkout/cart-pricing-engine.ts',
          methods: [
            {
              name: 'priceCart',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply promotions and tax to every cart line.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { priceCart } from \'./cart-pricing-engine.js\';',
          '',
          'export function placeOrder(cartId: string): void {',
          '  priceCart(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // SIM_FILE_MISSING
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SIM_FILE_MISSING',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout orchestrator declares an integration harness at tests/integration/checkout-flow.sim.ts, but the file was never committed — the spec claims a harness that does not exist.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): void {',
          '  // validate and persist the order',
          '}',
          '',
        ].join('\n'),
        // deliberately NO tests/integration/checkout-flow.sim.ts
      },
    },
  }),
  defineRuleFixture({
    code: 'SIM_FILE_MISSING',
    expectFire: false,
    reason: 'The declared simPath resolves to a committed file inside the project root.',
    scenario:
      'The checkout orchestrator\'s declared integration harness is committed at the declared path and wires the real module.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): void {',
          '  // validate and persist the order',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  placeOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNWIRED_INTEGRATION_SIM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout orchestrator\'s committed harness still drives a hand-rolled stub, importing neither the orchestrator\'s own module nor the pricing engine it declares.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['cart-pricing-engine'],
        },
        {
          id: 'cart-pricing-engine',
          componentType: 'Specialist',
          subsystem: 'checkout',
          description: 'Prices the cart including promotions and tax.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'icart_pricing_engine',
          component: 'cart-pricing-engine',
          methods: [{ name: 'priceCart', description: 'Price the cart including promotions and tax.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'cart_pricing_engine_impl',
          contract: 'icart_pricing_engine',
          sourcePath: 'src/checkout/cart-pricing-engine.ts',
          methods: [
            {
              name: 'priceCart',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply promotions and tax to every cart line.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { priceCart } from \'./cart-pricing-engine.js\';',
          '',
          'export function placeOrder(cartId: string): void {',
          '  priceCart(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          '// TODO: still exercising the hand-rolled stub, not the real modules',
          'const stubOrchestrator = {',
          '  placeStubOrder: (cartId: string): void => undefined,',
          '};',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  stubOrchestrator.placeStubOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    expectFire: false,
    reason: 'The harness imports the component\'s own module and its declared dependency\'s module, which is exactly the wiring the gate proves.',
    scenario:
      'The checkout orchestrator\'s harness constructs the real orchestrator with the real cart pricing engine through direct imports.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['cart-pricing-engine'],
        },
        {
          id: 'cart-pricing-engine',
          componentType: 'Specialist',
          subsystem: 'checkout',
          description: 'Prices the cart including promotions and tax.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'icart_pricing_engine',
          component: 'cart-pricing-engine',
          methods: [{ name: 'priceCart', description: 'Price the cart including promotions and tax.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'cart_pricing_engine_impl',
          contract: 'icart_pricing_engine',
          sourcePath: 'src/checkout/cart-pricing-engine.ts',
          methods: [
            {
              name: 'priceCart',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Apply promotions and tax to every cart line.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { priceCart } from \'./cart-pricing-engine.js\';',
          '',
          'export function placeOrder(cartId: string): void {',
          '  priceCart(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          'import { priceCart } from \'../../src/checkout/cart-pricing-engine.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  priceCart(\'cart-1001\');',
          '  placeOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    expectFire: false,
    reason:
      'The only unreached dependency is a technology boundary (its implementation declares technologies), and the documented exemption sanctions its contract-faithful fake in the harness.',
    scenario:
      'The checkout orchestrator\'s harness wires the real orchestrator but fakes the Stripe-bound payment gateway adapter, which the technology-boundary exemption sanctions.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
          dependsOn: ['payment-gateway-adapter'],
        },
        {
          id: 'payment-gateway-adapter',
          componentType: 'Adapter',
          subsystem: 'checkout',
          description: 'Wraps the external PSP charge API.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
        {
          id: 'ipayment_gateway_adapter',
          component: 'payment-gateway-adapter',
          methods: [{ name: 'chargeCard', description: 'Charge the stored card via the PSP.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Validate the priced cart and persist the order.' }],
            },
          ],
        },
        {
          id: 'payment_gateway_adapter_impl',
          contract: 'ipayment_gateway_adapter',
          sourcePath: 'src/checkout/payment-gateway-adapter.ts',
          technologies: ['stripe'],
          methods: [
            {
              name: 'chargeCard',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Send the charge request to the PSP over HTTPS.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): void {',
          '  // validate and persist the order, then request the charge',
          '}',
          '',
        ].join('\n'),
        'src/checkout/payment-gateway-adapter.ts': [
          'export function chargeCard(orderId: string): void {',
          '  // POST the charge to the PSP',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'const fakeGateway = {',
          '  chargeCard: (orderId: string): void => undefined,',
          '};',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  fakeGateway.chargeCard(\'order-1001\');',
          '  placeOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // SIM_PATH_UNCOVERED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SIM_PATH_UNCOVERED',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout harness claims path coverage with a sim: anchor for the happy path of placeOrder, but never names the labeled card-declined error path the narrative declares.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Validate the cart contents and total the order.' },
                {
                  stepNumber: 2,
                  type: 'branch',
                  description: 'Check whether the payment authorization succeeded.',
                  condition: 'payment authorized',
                  onFalseStep: 4,
                },
                { stepNumber: 3, type: 'return', outcome: 'success', description: 'Confirm the order to the shopper.' },
                {
                  stepNumber: 4,
                  type: 'throw',
                  label: 'card-declined',
                  error: 'CardDeclinedError',
                  description: 'Reject the order when the card is declined.',
                },
              ],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): string {',
          '  if (!authorizePayment(cartId)) {',
          '    throw new Error(\'card declined for \' + cartId);',
          '  }',
          '  return \'confirmed\';',
          '}',
          '',
          'function authorizePayment(cartId: string): boolean {',
          '  return cartId.length > 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'function scenario(name: string, run: () => void): void {',
          '  run();',
          '}',
          '',
          'scenario(\'sim:checkout-orchestrator.placeOrder\', () => {',
          '  placeOrder(\'cart-1001\');',
          '});',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'SIM_PATH_UNCOVERED',
    expectFire: false,
    reason: 'Both the happy path and the labeled card-declined error path carry their exact sim: string-literal anchors in the harness.',
    scenario:
      'The checkout harness names the happy path and the labeled card-declined error path of placeOrder with exact sim: anchors.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Validate the cart contents and total the order.' },
                {
                  stepNumber: 2,
                  type: 'branch',
                  description: 'Check whether the payment authorization succeeded.',
                  condition: 'payment authorized',
                  onFalseStep: 4,
                },
                { stepNumber: 3, type: 'return', outcome: 'success', description: 'Confirm the order to the shopper.' },
                {
                  stepNumber: 4,
                  type: 'throw',
                  label: 'card-declined',
                  error: 'CardDeclinedError',
                  description: 'Reject the order when the card is declined.',
                },
              ],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): string {',
          '  if (!authorizePayment(cartId)) {',
          '    throw new Error(\'card declined for \' + cartId);',
          '  }',
          '  return \'confirmed\';',
          '}',
          '',
          'function authorizePayment(cartId: string): boolean {',
          '  return cartId.length > 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'function scenario(name: string, run: () => void): void {',
          '  run();',
          '}',
          '',
          'scenario(\'sim:checkout-orchestrator.placeOrder\', () => {',
          '  placeOrder(\'cart-1001\');',
          '});',
          '',
          'scenario(\'sim:checkout-orchestrator.placeOrder:card-declined\', () => {',
          '  placeOrder(\'\');',
          '});',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'SIM_PATH_UNCOVERED',
    expectFire: false,
    reason:
      'Path coverage is documented as opt-in PER COMPONENT: with no sim: anchors in the harness, the component makes no coverage claim and the check stays quiet.',
    scenario:
      'The checkout harness wires the real orchestrator but carries no sim: anchors, deliberately withdrawing the path-coverage claim.',
    tree: {
      subsystems: [{ id: 'checkout', description: 'Cart pricing and order placement.' }],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'checkout',
          description: 'Drives order placement over the priced cart.',
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'placeOrder', description: 'Place the order for the priced cart.' }],
        },
      ],
      implementations: [
        {
          id: 'checkout_orchestrator_impl',
          contract: 'icheckout_orchestrator',
          sourcePath: 'src/checkout/checkout-orchestrator.ts',
          simPath: 'tests/integration/checkout-flow.sim.ts',
          methods: [
            {
              name: 'placeOrder',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Validate the cart contents and total the order.' },
                {
                  stepNumber: 2,
                  type: 'branch',
                  description: 'Check whether the payment authorization succeeded.',
                  condition: 'payment authorized',
                  onFalseStep: 4,
                },
                { stepNumber: 3, type: 'return', outcome: 'success', description: 'Confirm the order to the shopper.' },
                {
                  stepNumber: 4,
                  type: 'throw',
                  label: 'card-declined',
                  error: 'CardDeclinedError',
                  description: 'Reject the order when the card is declined.',
                },
              ],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'export function placeOrder(cartId: string): string {',
          '  if (!authorizePayment(cartId)) {',
          '    throw new Error(\'card declined for \' + cartId);',
          '  }',
          '  return \'confirmed\';',
          '}',
          '',
          'function authorizePayment(cartId: string): boolean {',
          '  return cartId.length > 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { placeOrder } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  placeOrder(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
];
