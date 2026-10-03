/**
 * The neutral type grammar — src/core/rules/integrity/type-expressions.ts and
 * enum-types.ts.
 *
 * Documented intents pinned here (rule descriptions):
 *  - TYPE_EXPRESSION_INVALID (error): a structured type position does not
 *    parse under the grammar — anything left over after the grammar finishes
 *    is invalid, so a position carries no trailing prose.
 *  - TYPE_POSITION_INVALID (error): a position rule is broken — void or async
 *    out of place, a map key that is not string, int or an enum, or T??.
 *  - TYPE_FORM_UNSUPPORTED (warning): a form the grammar leaves out — here a
 *    string-literal union, whose replacement is an enum.
 *  - TYPE_NOT_NEUTRAL (warning): `number`, which does not say int or float.
 *  - TYPE_SPELLING_STALE (warning): a stored alias of the canonical spelling
 *    (TypeScript's `string[]` for `list<string>`), which any save rewrites.
 *  - ENUM_MEMBERS (error): an enum with no values, two values one name apart,
 *    or a member an enum cannot carry; or values on a type of another kind.
 *
 * Every tree is written raw, the way a hand edit or a tree from before the
 * grammar lands on disk: the loader reads each position once and these rules
 * report what it recorded. Each control is the same contract with the
 * position written canonically.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const SHIPPING_SUB = { id: 'parcel-shipping', description: 'Parcel rating and dispatch for the warehouse outbound dock.' };

/** One parcel-rating contract whose single param (the service level, unless named) and returns carry the spelling under test. */
function rateTree(paramType: string, returns = 'Quote', paramName = 'serviceLevel'): FixtureTree {
  return {
    subsystems: [SHIPPING_SUB],
    components: [{
      id: 'parcel-rate-calculator',
      componentType: 'Orchestrator',
      dependencyClass: 'pure',
      description: 'Prices one outbound parcel against the carrier rate card.',
    }],
    interfaces: [{
      id: 'iparcel_rates',
      component: 'parcel-rate-calculator',
      methods: [{
        name: 'quoteParcel',
        description: 'Price one parcel for its service level.',
        params: [{ name: paramName, type: paramType }],
        returns,
      }],
    }],
    types: [{
      id: 'quote',
      kind: 'value-object',
      description: 'A carrier price for one parcel.',
      fields: [{ name: 'amountCents', type: 'int', description: 'The price in cents.' }],
    }],
  };
}

/** One shipment-status enum, written as the tree states it. */
function statusTree(type: Record<string, unknown>): FixtureTree {
  return {
    subsystems: [SHIPPING_SUB],
    types: [{
      id: 'shipment-status',
      subsystem: 'parcel-shipping',
      description: 'Where an outbound shipment stands, earliest first.',
      ...type,
    }],
  };
}

export default [
  // -------------------------------------------------------------------------
  // TYPE_EXPRESSION_INVALID
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_EXPRESSION_INVALID',
    severity: 'error',
    anchoredTo: 'iparcel_rates',
    expectFire: true,
    scenario:
      'The parcel rating contract types its service level as "string (standard or express)", carrying prose the grammar cannot read after the type.',
    tree: rateTree('string (standard or express)'),
  }),
  defineRuleFixture({
    code: 'TYPE_EXPRESSION_INVALID',
    expectFire: false,
    reason: 'The type is just `string`; the allowed service levels belong in the description (or an enum), never in the type position.',
    scenario: 'The parcel rating contract types its service level as a plain string.',
    tree: rateTree('string'),
  }),

  // -------------------------------------------------------------------------
  // TYPE_POSITION_INVALID
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_POSITION_INVALID',
    severity: 'error',
    anchoredTo: 'iparcel_rates',
    expectFire: true,
    scenario: 'The parcel rating contract takes its service level as `async string`, though async may stand only at the top of a returns.',
    tree: rateTree('async string'),
  }),
  defineRuleFixture({
    code: 'TYPE_POSITION_INVALID',
    expectFire: false,
    reason: 'async marks the returns — the call completes later — and the param is a plain string.',
    scenario: 'The parcel rating contract takes its service level as a string and answers `async Quote`.',
    tree: rateTree('string', 'async Quote'),
  }),

  // -------------------------------------------------------------------------
  // TYPE_FORM_UNSUPPORTED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_FORM_UNSUPPORTED',
    severity: 'warning',
    anchoredTo: 'iparcel_rates',
    expectFire: true,
    scenario: "The parcel rating contract types its service level as the literal union 'standard' | 'express' rather than naming an enum.",
    tree: rateTree("'standard' | 'express'"),
  }),
  defineRuleFixture({
    code: 'TYPE_FORM_UNSUPPORTED',
    expectFire: false,
    reason: 'The service levels are a named enum type, the replacement the grammar names for a literal union.',
    scenario: 'The parcel rating contract types its service level as the service_level enum.',
    tree: {
      ...rateTree('service_level'),
      types: [
        ...(rateTree('service_level').types ?? []),
        { id: 'service_level', kind: 'enum', description: 'How fast a parcel travels.', values: [{ name: 'standard' }, { name: 'express' }] },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // TYPE_NOT_NEUTRAL
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_NOT_NEUTRAL',
    severity: 'warning',
    anchoredTo: 'iparcel_rates',
    expectFire: true,
    scenario: 'The parcel rating contract takes the parcel weight as `number`, which does not say whether grams are whole or fractional.',
    tree: rateTree('number', 'Quote', 'weightGrams'),
  }),
  defineRuleFixture({
    code: 'TYPE_NOT_NEUTRAL',
    expectFire: false,
    reason: 'The weight is `int` (whole grams): the author chose, which is what the finding asks for.',
    scenario: 'The parcel rating contract takes the parcel weight as whole grams, typed int.',
    tree: rateTree('int', 'Quote', 'weightGrams'),
  }),

  // -------------------------------------------------------------------------
  // TYPE_SPELLING_STALE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TYPE_SPELLING_STALE',
    severity: 'warning',
    anchoredTo: 'iparcel_rates',
    expectFire: true,
    scenario: 'The parcel rating contract, written before the grammar, stores its accepted service levels as TypeScript\'s string[].',
    tree: rateTree('string[]'),
  }),
  defineRuleFixture({
    code: 'TYPE_SPELLING_STALE',
    expectFire: false,
    reason: 'The position is stored in its canonical spelling, list<string>, which is what every reader is shown anyway.',
    scenario: 'The parcel rating contract stores its accepted service levels as list<string>.',
    tree: rateTree('list<string>'),
  }),

  // -------------------------------------------------------------------------
  // ENUM_MEMBERS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENUM_MEMBERS',
    severity: 'error',
    anchoredTo: 'shipment-status',
    expectFire: true,
    scenario:
      'The shipment status enum lists "in-transit" and "in_transit" as two values, which every language derives one identifier from, and also carries a field.',
    tree: statusTree({
      kind: 'enum',
      values: [{ name: 'picked' }, { name: 'in-transit' }, { name: 'in_transit' }, { name: 'delivered' }],
      fields: [{ name: 'label', type: 'string', description: 'A display label.' }],
    }),
  }),
  defineRuleFixture({
    code: 'ENUM_MEMBERS',
    expectFire: false,
    reason: 'An enum of distinct values with nothing else on it is exactly the kind.',
    scenario: 'The shipment status enum lists picked, in-transit and delivered, in order, and nothing else.',
    tree: statusTree({
      kind: 'enum',
      values: [{ name: 'picked' }, { name: 'in-transit', description: 'Handed to the carrier.' }, { name: 'delivered' }],
    }),
  }),
];
