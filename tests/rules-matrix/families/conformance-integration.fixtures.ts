/**
 * Integration conformance (the static sim gate) —
 * src/core/rules/conformance/integration-conformance.ts (docs/design/integration-conformance.md §4).
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
 *    transitively, exact grade) must reach at least one of the component's
 *    own source modules (its implementation's sourcePath or a method's) and
 *    at least one source module of each direct dependency;
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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

  // -------------------------------------------------------------------------
  // UNWIRED_INTEGRATION_SIM — a component's own modules are all its files,
  // including the modules its methods name
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    severity: 'warning',
    anchoredTo: 'checkout_orchestrator_impl',
    expectFire: true,
    scenario:
      'The checkout orchestrator\'s placeOrder body lives in its own command module, but the checkout harness imports only the pricing engine and reaches neither of the orchestrator\'s modules.',
    tree: placeOrderCommandTree([
      'import { priceCart } from \'../../src/checkout/cart-pricing-engine.js\';',
      '',
      'export function runCheckoutFlowSim(): void {',
      '  priceCart(\'cart-1001\');',
      '}',
      '',
    ].join('\n')),
  }),
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    expectFire: false,
    reason:
      'A module the orchestrator\'s method names is one of the component\'s own modules, and through it the harness reaches the real pricing engine.',
    scenario:
      'The checkout harness drives placeOrder through the orchestrator\'s command module, which imports the real pricing engine.',
    tree: placeOrderCommandTree([
      'import { placeOrder } from \'../../src/checkout/commands/place-order.js\';',
      '',
      'export function runCheckoutFlowSim(): void {',
      '  placeOrder(\'cart-1001\');',
      '}',
      '',
    ].join('\n')),
  }),

  // -------------------------------------------------------------------------
  // UNWIRED_INTEGRATION_SIM — only modules that exist, outside chained
  // subprojects, are modules a harness can be accused of not reaching
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNWIRED_INTEGRATION_SIM',
    expectFire: false,
    reason:
      'A named file that does not exist is structural conformance\'s finding (MISSING_SOURCE_FILE) alone; no harness can import it, so it is not one of the component\'s modules to reach.',
    scenario:
      'The checkout orchestrator\'s module has not been committed yet, and its harness already wires the real pricing engine it will depend on.',
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
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
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
        'src/checkout/cart-pricing-engine.ts': [
          'export function priceCart(cartId: string): number {',
          '  return 0;',
          '}',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { priceCart } from \'../../src/checkout/cart-pricing-engine.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  priceCart(\'cart-1001\');',
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
      'A chained subproject\'s sourcePaths are relative to its own root and the child validates them in its own run; resolved at the parent root they name the parent\'s unrelated module, which is no evidence about the harness.',
    scenario:
      'The storefront checkout depends on the chained billing subproject\'s portal, whose child-relative module path coincides with an unrelated storefront module the harness never imports.',
    tree: {
      system: { name: 'Storefront', vision: 'Online storefront with a chained billing subproject.' },
      subsystems: [
        { id: 'storefront', description: 'Catalogue browsing and checkout.' },
        { id: 'billing', description: 'Chained billing subproject mount.', projectPath: 'packages/billing' },
      ],
      components: [
        {
          id: 'checkout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'storefront',
          description: 'Drives checkout and charges the card through billing.',
          dependsOn: ['billing::billing-portal'],
        },
      ],
      interfaces: [
        {
          id: 'icheckout_orchestrator',
          component: 'checkout-orchestrator',
          methods: [{ name: 'checkout', description: 'Check out the cart and charge the card.' }],
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
              name: 'checkout',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Charge the card through the billing portal and confirm the order.' }],
            },
          ],
        },
      ],
      files: {
        'src/checkout/checkout-orchestrator.ts': [
          'import { chargeCard } from \'../../packages/billing/src/portal.js\';',
          '',
          'export function checkout(cartId: string): void {',
          '  chargeCard(cartId);',
          '}',
          '',
        ].join('\n'),
        'src/portal.ts': [
          'export const storefrontBanner = \'Free shipping over 50\';',
          '',
        ].join('\n'),
        'tests/integration/checkout-flow.sim.ts': [
          'import { checkout } from \'../../src/checkout/checkout-orchestrator.js\';',
          '',
          'export function runCheckoutFlowSim(): void {',
          '  checkout(\'cart-1001\');',
          '}',
          '',
        ].join('\n'),
        ...billingSubprojectFiles(),
      },
    },
  }),
];

/**
 * The chained billing subproject laid down under packages/billing: its portal
 * names src/portal.ts, relative to the billing project's own root. Specs are
 * JSON, which YAML reads as-is.
 */
function billingSubprojectFiles(): Record<string, string> {
  const stamp = { schemaVersion: '1.0.0', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const spec = (data: Record<string, unknown>): string => JSON.stringify({ ...stamp, ...data }, null, 2);
  return {
    'packages/billing/.wai/project.yaml': spec({ name: 'billing', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }], rules: {} }),
    'packages/billing/.wai/specs/.index.yaml': spec({ name: 'Billing', vision: 'Card charging for the storefront family.' }),
    'packages/billing/.wai/specs/subsystems/billing-core.yaml': spec({
      id: 'billing-core', name: 'Billing Core', description: 'Card charging.', parentSystem: 'Billing',
    }),
    'packages/billing/.wai/specs/components/billing-portal.yaml': spec({
      id: 'billing-portal', name: 'Billing Portal', description: 'Accepts card charges.', subsystem: 'billing-core',
      componentType: 'Portal', dependsOn: [], owns: [],
    }),
    'packages/billing/.wai/specs/interfaces/ibilling_portal.yaml': spec({
      id: 'ibilling_portal', name: 'Billing Portal', description: 'The billing portal contract.', component: 'billing-portal',
      methods: [{ name: 'chargeCard', description: 'Charge the card for a cart.', signature: 'chargeCard(): void', returns: 'void' }],
    }),
    'packages/billing/.wai/specs/implementations/billing_portal_impl.yaml': spec({
      id: 'billing_portal_impl', name: 'Billing Portal Impl', description: 'The billing portal realization.', contract: 'ibilling_portal',
      sourcePath: 'src/portal.ts',
      methods: [{ name: 'chargeCard', narrative: [{ stepNumber: 1, type: 'local', description: 'Charge the card with the stored payment method.' }] }],
    }),
    'packages/billing/src/portal.ts': 'export function chargeCard(cartId: string): void {}\n',
  };
}

/**
 * The checkout orchestrator whose placeOrder names its own command module,
 * wired to the real cart pricing engine; only the harness text varies.
 */
function placeOrderCommandTree(harness: string): import('../harness.js').FixtureTree {
  return {
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
        componentType: 'Orchestrator',
        dependencyClass: 'pure',
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
            sourcePath: 'src/checkout/commands/place-order.ts',
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
        'export const orderChannel = \'web\';',
        '',
      ].join('\n'),
      'src/checkout/commands/place-order.ts': [
        'import { priceCart } from \'../cart-pricing-engine.js\';',
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
      'tests/integration/checkout-flow.sim.ts': harness,
    },
  };
}
