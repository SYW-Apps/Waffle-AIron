/**
 * An abstraction's declaration in code (rule param-conformance):
 *
 *  - ABSTRACTION_DECLARATION_UNCOMPARED, a notice: a contract method of an
 *    abstraction implementation whose file holds it but whose declaration
 *    nothing compared (a language with no reader of member signatures, below
 *    exact grade, or the member only on a concrete class).
 *
 * The scenario: a shipping service. The desk dispatches an order through one
 * abstract carrier; DHL and UPS implement it.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const SUB = { id: 'shipping', description: 'Ships orders with a carrier.' };
const SHIP = { name: 'ship', description: 'Ship one order.', params: [{ name: 'order', type: 'string' }], returns: 'string' };

function carriers(carrier: string): FixtureTree {
  return {
    system: { name: 'ShippingService', vision: 'Ships orders with one of several carriers.', targetLanguage: 'typescript' },
    subsystems: [SUB],
    components: [
      { id: 'carrier', subsystem: SUB.id, componentType: 'Adapter', abstract: true, description: 'Ships one order.' },
      { id: 'dhl', subsystem: SUB.id, componentType: 'Adapter', description: 'Ships by DHL.' },
      { id: 'ups', subsystem: SUB.id, componentType: 'Adapter', description: 'Ships by UPS.' },
      { id: 'desk', subsystem: SUB.id, componentType: 'Orchestrator', description: 'Dispatches orders.', dependsOn: ['carrier'], invokedBy: { kind: 'runtime', caller: 'The composition root calls the desk once per order.' } },
    ],
    interfaces: [
      { id: 'icarrier', component: 'carrier', methods: [SHIP] },
      { id: 'idhl', component: 'dhl', implements: ['carrier'], methods: [SHIP] },
      { id: 'iups', component: 'ups', implements: ['carrier'], methods: [SHIP] },
      { id: 'idesk', component: 'desk', methods: [{ name: 'dispatch', description: 'Dispatch one order.', params: [{ name: 'order', type: 'string' }], returns: 'string' }] },
    ],
    implementations: [
      { id: 'carrier_impl', contract: 'icarrier', sourcePath: 'src/carrier.ts', methods: [{ name: 'ship' }] },
      { id: 'dhl_impl', contract: 'idhl', sourcePath: 'src/dhl.ts', methods: [{ name: 'ship', narrative: [{ stepNumber: 1, type: 'local', description: 'Return the DHL tracking code.' }] }] },
      { id: 'ups_impl', contract: 'iups', sourcePath: 'src/ups.ts', methods: [{ name: 'ship', narrative: [{ stepNumber: 1, type: 'local', description: 'Return the UPS tracking code.' }] }] },
      { id: 'desk_impl', contract: 'idesk', sourcePath: 'src/desk.ts', methods: [{ name: 'dispatch', narrative: [{ stepNumber: 1, type: 'call', description: 'Ship with the carrier.', targetComponent: 'carrier', targetMethod: 'ship' }] }] },
    ],
    files: {
      'src/carrier.ts': carrier,
      'src/dhl.ts': "import { Carrier } from './carrier.js';\n\nexport class Dhl extends Carrier {\n  ship(order: string): string {\n    return 'dhl' + order;\n  }\n}\n",
      'src/ups.ts': "import { Carrier } from './carrier.js';\n\nexport class Ups extends Carrier {\n  ship(order: string): string {\n    return 'ups' + order;\n  }\n}\n",
      'src/desk.ts': "import { Carrier } from './carrier.js';\n\nexport class Desk {\n  constructor(private readonly carrier: Carrier) {}\n\n  dispatch(order: string): string {\n    return this.carrier.ship(order);\n  }\n}\n",
    },
  } as unknown as FixtureTree;
}

export default [
  defineRuleFixture({
    code: 'ABSTRACTION_DECLARATION_UNCOMPARED',
    expectFire: true,
    severity: 'notice',
    scenario: 'The carrier abstraction is written as a concrete class holding ship: it declares nothing, so nothing is compared with the contract and the notice says so.',
    tree: carriers('export class Carrier {\n  ship(order: string): string {\n    return order;\n  }\n}\n'),
  }),
  defineRuleFixture({
    code: 'ABSTRACTION_DECLARATION_UNCOMPARED',
    expectFire: false,
    reason: 'An abstract class with a protected helper is a declaration: its ship signature was compared with the contract.',
    scenario: 'The carrier abstraction is an abstract class declaring ship beside a protected helper.',
    tree: carriers('export abstract class Carrier {\n  abstract ship(order: string): string;\n\n  protected trim(value: string): string {\n    return value.trim();\n  }\n}\n'),
  }),
];
