/**
 * Code↔spec for an ENUM's values and for ASYNC —
 * src/core/rules/conformance/enum-values.ts and async-conformance.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - UNREALIZED_ENUM_VALUE (warning): an enum lists a value the declaration at
 *    its sourcePath does not hold — the design promises a value the code would
 *    reject. Read off a string-literal union alias here.
 *  - UNDECLARED_ENUM_VALUE (warning): the declaration holds a value the enum
 *    does not list. Read off a z.enum constant, through the alias inferring
 *    from it (the one hop a derived shape takes).
 *  - ASYNC_MISMATCH (warning): the contract's returns and the realizing
 *    function disagree about whether the call completes later — here the code
 *    is declared async and the returns does not say so.
 *
 * Each control is the same file with the spec saying what the code does.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const DISPATCH_SUB = { id: 'outbound-dispatch', description: 'Hands packed parcels to carriers at the outbound dock.' };

/** The shipment-status enum, claimed by the file that declares it. */
function statusTree(values: string[], source: string): FixtureTree {
  return {
    subsystems: [DISPATCH_SUB],
    types: [{
      id: 'shipment-status',
      name: 'ShipmentStatus',
      kind: 'enum',
      subsystem: 'outbound-dispatch',
      description: 'Where an outbound shipment stands, earliest first.',
      sourcePath: 'src/dispatch/shipment-status.ts',
      values: values.map((name) => ({ name })),
    }],
    files: { 'src/dispatch/shipment-status.ts': source },
  };
}

const LITERAL_UNION = "export type ShipmentStatus = 'picked' | 'delivered';\n";

const ZOD_ENUM = [
  "import { z } from 'zod';",
  '',
  "export const ShipmentStatusSchema = z.enum(['picked', 'in-transit', 'delivered', 'returned']);",
  '',
  'export type ShipmentStatus = z.infer<typeof ShipmentStatusSchema>;',
  '',
].join('\n');

/** The carrier hand-off: one contract method, realized in one file. */
function handOffTree(returns: string): FixtureTree {
  return {
    subsystems: [DISPATCH_SUB],
    components: [{
      id: 'carrier-handoff-orchestrator',
      componentType: 'Orchestrator',
      subsystem: 'outbound-dispatch',
      description: 'Books the carrier collection for a packed parcel.',
    }],
    interfaces: [{
      id: 'icarrier_handoff',
      component: 'carrier-handoff-orchestrator',
      methods: [{
        name: 'bookCollection',
        description: 'Book the carrier collection for one packed parcel.',
        params: [{ name: 'parcelId', type: 'string' }],
        returns,
      }],
    }],
    implementations: [{
      id: 'carrier_handoff_impl',
      contract: 'icarrier_handoff',
      sourcePath: 'src/dispatch/handoff.ts',
      methods: [{
        name: 'bookCollection',
        narrative: [{ stepNumber: 1, type: 'local', description: 'Post the collection request to the carrier and wait for its booking reference.' }],
      }],
    }],
    files: {
      'src/dispatch/handoff.ts': [
        'export async function bookCollection(parcelId: string): Promise<void> {',
        '  await Promise.resolve(parcelId);',
        '}',
        '',
      ].join('\n'),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // UNREALIZED_ENUM_VALUE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_ENUM_VALUE',
    severity: 'warning',
    anchoredTo: 'shipment-status',
    expectFire: true,
    scenario: 'The shipment status enum lists in-transit, but the literal union the dispatch code declares holds only picked and delivered.',
    tree: statusTree(['picked', 'in-transit', 'delivered'], LITERAL_UNION),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_ENUM_VALUE',
    expectFire: false,
    reason: 'Every value the enum lists is one the declaration holds.',
    scenario: 'The shipment status enum lists picked and delivered, exactly the literal union the dispatch code declares.',
    tree: statusTree(['picked', 'delivered'], LITERAL_UNION),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_ENUM_VALUE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_ENUM_VALUE',
    severity: 'warning',
    anchoredTo: 'shipment-status',
    expectFire: true,
    scenario: 'The dispatch code\'s z.enum schema accepts a returned status that the shipment status enum never lists.',
    tree: statusTree(['picked', 'in-transit', 'delivered'], ZOD_ENUM),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_ENUM_VALUE',
    expectFire: false,
    reason: 'The enum lists every value the schema accepts; order is not judged.',
    scenario: 'The shipment status enum lists picked, in-transit, delivered and returned, the values the dispatch code\'s z.enum schema accepts.',
    tree: statusTree(['picked', 'in-transit', 'returned', 'delivered'], ZOD_ENUM),
  }),

  // -------------------------------------------------------------------------
  // ASYNC_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ASYNC_MISMATCH',
    severity: 'warning',
    anchoredTo: 'carrier_handoff_impl',
    expectFire: true,
    scenario: 'The carrier hand-off contract says bookCollection returns void, but the function booking the collection is declared async and completes later.',
    tree: handOffTree('void'),
  }),
  defineRuleFixture({
    code: 'ASYNC_MISMATCH',
    expectFire: false,
    reason: 'The returns says `async void`, which is what an async function answering nothing is.',
    scenario: 'The carrier hand-off contract says bookCollection returns async void, matching the async function that books the collection.',
    tree: handOffTree('async void'),
  }),
];
