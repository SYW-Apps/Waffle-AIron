/**
 * Export-table fixtures — src/core/rules/integrity/export-tables.ts, judging
 * the problems the export index (src/core/exports.ts) meets while it follows
 * every `from` re-export to its canonical target.
 *
 * Documented intents pinned here:
 *  - EXPORT_ID_DUPLICATE (error): one public name bound to two different
 *    targets — two wildcards bringing the same name from different sources —
 *    is a clash at the definition; the name is left out of the table. An
 *    explicit entry shadows what a wildcard brings in, silently.
 *  - EXPORT_CYCLE: a named re-export chain that leads back to itself without
 *    reaching the item is an error; two subsystems re-exporting each other
 *    through wildcards resolve to the union and are a warning.
 *  - EXPORT_INVALID (notice): an entry whose item its source does not export,
 *    or an L0 entry that names no source at all.
 *  - EXPORT_UNCONSUMABLE (notice): a re-export whose target no caller across
 *    the boundary may reach — neither a Portal nor an Observer.
 *  - A re-export is not an own item: the public-surface rules do not accuse
 *    it of publishing a foreign component.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'ParcelHub',
  vision: 'Parcel shipping platform: carrier rates, price quotes and a storefront facade for partner shops.',
};

const CARRIERS = { id: 'carriers', description: 'Carrier contracts and the live rates they publish.' };
const PRICING = { id: 'pricing', description: 'Price quotes for a parcel, surcharges included.' };
const STOREFRONT = { id: 'storefront', description: 'The facade partner shops integrate against.' };

const CARRIER_RATE_PORTAL = {
  id: 'carrier-rate-portal',
  componentType: 'Portal',
  portalType: 'HTTP_API',
  subsystem: 'carriers',
  description: 'REST surface answering the live rate of every contracted carrier.',
};
const QUOTE_PORTAL = {
  id: 'quote-portal',
  componentType: 'Portal',
  portalType: 'HTTP_API',
  subsystem: 'pricing',
  description: 'REST surface answering a price quote for one parcel.',
};
const QUOTE_CALCULATOR = {
  id: 'quote-calculator',
  componentType: 'Orchestrator',
  dependencyClass: 'pure',
  subsystem: 'pricing',
  description: 'Computes a quote from a rate sheet and the parcel dimensions.',
};
const SURCHARGE_PORTAL = {
  id: 'surcharge-portal',
  componentType: 'Portal',
  portalType: 'HTTP_API',
  subsystem: 'surcharges',
  description: 'REST surface answering the fuel and remote-area surcharges.',
};

const RATES = { type: 'REST', details: 'Live carrier rates.', component: 'carrier-rate-portal', as: 'rates' };
const QUOTES = { type: 'REST', details: 'Parcel price quotes.', component: 'quote-portal' };

export default [
  // -------------------------------------------------------------------------
  // EXPORT_ID_DUPLICATE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_ID_DUPLICATE',
    severity: 'error',
    anchoredTo: 'storefront',
    expectFire: true,
    scenario:
      'The storefront facade re-exports everything carriers and pricing export, and both export a surface named "rates" backed by different portals.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...CARRIERS, publicInterfaces: [RATES] },
        { ...PRICING, publicInterfaces: [{ ...QUOTES, as: 'rates' }] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'carriers' }, { from: 'pricing' }] },
      ],
      components: [CARRIER_RATE_PORTAL, QUOTE_PORTAL],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_ID_DUPLICATE',
    expectFire: false,
    reason: 'An explicit entry picks the carriers portal for "rates", and an explicit entry shadows what a wildcard brings in.',
    scenario:
      'The storefront facade re-exports everything carriers and pricing export, and settles the clash on "rates" by re-exporting the carrier rate portal explicitly.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...CARRIERS, publicInterfaces: [RATES] },
        { ...PRICING, publicInterfaces: [{ ...QUOTES, as: 'rates' }] },
        {
          ...STOREFRONT,
          publicInterfaces: [{ from: 'carriers' }, { from: 'pricing' }, { from: 'carriers', component: 'carrier-rate-portal', as: 'rates' }],
        },
      ],
      components: [CARRIER_RATE_PORTAL, QUOTE_PORTAL],
    },
  }),

  // -------------------------------------------------------------------------
  // EXPORT_CYCLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_CYCLE',
    severity: 'error',
    anchoredTo: 'carriers',
    expectFire: true,
    scenario:
      'Carriers re-exports the surcharge portal from pricing, and pricing re-exports it from carriers, but neither exports it itself — the chain never reaches the portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...CARRIERS, publicInterfaces: [RATES, { from: 'pricing', component: 'surcharge-portal' }] },
        { ...PRICING, publicInterfaces: [QUOTES, { from: 'carriers', component: 'surcharge-portal' }] },
        { id: 'surcharges', description: 'Fuel and remote-area surcharges.' },
      ],
      components: [CARRIER_RATE_PORTAL, QUOTE_PORTAL, SURCHARGE_PORTAL],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_CYCLE',
    severity: 'warning',
    anchoredTo: 'carriers',
    expectFire: true,
    scenario:
      'Carriers re-exports everything pricing exports and pricing re-exports everything carriers exports, so the two form one circular module surface.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...CARRIERS, publicInterfaces: [RATES, { from: 'pricing' }] },
        { ...PRICING, publicInterfaces: [QUOTES, { from: 'carriers' }] },
      ],
      components: [CARRIER_RATE_PORTAL, QUOTE_PORTAL],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_CYCLE',
    expectFire: false,
    reason: 'Only the storefront re-exports, in one direction, so no chain leads back to where it started.',
    scenario:
      'The storefront facade re-exports everything carriers and pricing export, and neither of them re-exports anything.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...CARRIERS, publicInterfaces: [RATES] },
        { ...PRICING, publicInterfaces: [QUOTES] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'carriers' }, { from: 'pricing' }] },
      ],
      components: [CARRIER_RATE_PORTAL, QUOTE_PORTAL],
    },
  }),

  // -------------------------------------------------------------------------
  // EXPORT_INVALID
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_INVALID',
    severity: 'notice',
    anchoredTo: 'storefront',
    expectFire: true,
    scenario:
      'The storefront facade re-exports the quote portal from pricing, but pricing never publishes it.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...PRICING, publicInterfaces: [] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'pricing', component: 'quote-portal' }] },
      ],
      components: [QUOTE_PORTAL],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_INVALID',
    severity: 'notice',
    anchoredTo: 'ParcelHub',
    expectFire: true,
    scenario:
      'The project exports a "partner-api" entry at L0 that names neither a source subsystem nor a component to take one from.',
    tree: {
      system: { ...SYSTEM, publicInterfaces: [{ id: 'partner-api', name: 'Partner API', type: 'REST', details: 'Everything a partner shop calls.' }] },
      subsystems: [{ ...PRICING, publicInterfaces: [QUOTES] }],
      components: [QUOTE_PORTAL],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_INVALID',
    expectFire: false,
    reason: 'Pricing publishes the quote portal, so the storefront re-exports something its source exports, and the L0 entry names its source.',
    scenario:
      'The storefront facade re-exports the quote portal pricing publishes, and the project exports it at L0 as "partner-api" from the storefront.',
    tree: {
      system: { ...SYSTEM, publicInterfaces: [{ from: 'storefront', component: 'quote-portal', as: 'partner-api' }] },
      subsystems: [
        { ...PRICING, publicInterfaces: [QUOTES] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'pricing', component: 'quote-portal' }] },
      ],
      components: [QUOTE_PORTAL],
    },
  }),

  // -------------------------------------------------------------------------
  // EXPORT_UNCONSUMABLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_UNCONSUMABLE',
    severity: 'notice',
    anchoredTo: 'storefront',
    expectFire: true,
    scenario:
      'The storefront facade re-exports the quote calculator — pure logic pricing publishes as a Custom entry — which no partner shop can call across the boundary.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...PRICING, publicInterfaces: [{ type: 'Custom', details: 'In-process quote arithmetic.', component: 'quote-calculator' }] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'pricing', component: 'quote-calculator' }] },
      ],
      components: [QUOTE_CALCULATOR],
    },
  }),
  defineRuleFixture({
    code: 'EXPORT_UNCONSUMABLE',
    expectFire: false,
    reason: 'The re-exported target is the quote portal, a Portal a caller across the boundary may reach.',
    scenario: 'The storefront facade re-exports the quote portal pricing publishes.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...PRICING, publicInterfaces: [QUOTES] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'pricing', component: 'quote-portal' }] },
      ],
      components: [QUOTE_PORTAL],
    },
  }),

  // -------------------------------------------------------------------------
  // A re-export is not an own item
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT',
    expectFire: false,
    reason: 'The storefront entry is a re-export from pricing, not an own item, so it publishes no foreign component.',
    scenario: 'The storefront facade re-exports the quote portal pricing owns and publishes.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { ...PRICING, publicInterfaces: [QUOTES] },
        { ...STOREFRONT, publicInterfaces: [{ from: 'pricing', component: 'quote-portal' }] },
      ],
      components: [QUOTE_PORTAL],
    },
  }),
];
