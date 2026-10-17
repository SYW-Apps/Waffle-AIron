/**
 * Local ids (src/core/rules/integrity/local-ids.ts), stage 3: inside one
 * project an id names one spec, and an id without `::` is always local.
 *
 * Documented intents pinned here:
 *  - DUPLICATE_SPEC_ID (error): two spec files of one project declare one key.
 *    The loader keeps the first; every reference to the key could mean either,
 *    so the tree has no single reading. Types included (the transpiler's
 *    `cpu-primitive-binding` in two subsystems of one project was the case
 *    that found it).
 *  - LOCAL_ID_SHADOWS_PROJECT (warning): a local spec id equals one of the
 *    project's aliases (a `members` or `externals` key). The grammar keeps
 *    them apart — a bare id is local, `alias::name` crosses — but a reader
 *    cannot, so the shadow is made visible.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** A storefront that declares its pricing engine as a member, with a local subsystem named as given. */
function storefront(localSubsystem: string): FixtureTree {
  return {
    system: { name: 'Storefront', vision: 'An online storefront that prices every basket through its pricing engine.' },
    subsystems: [
      { id: 'checkout', description: 'Basket checkout for shoppers.' },
      { id: localSubsystem, description: 'Storefront-side price display rules.' },
    ],
    files: {
      '.wai/project.yaml': dump({
        id: 'storefront', name: 'Storefront', targets: [], extensions: { packs: [], useGlobalPacks: false },
        members: { pricing: 'packages/pricing' },
      }),
      'packages/pricing/.wai/project.yaml': dump({ id: 'pricing', name: 'Pricing Engine', targets: [] }),
      'packages/pricing/.wai/specs/.index.yaml': dump({ name: 'PricingEngine', vision: 'Computes the price of every basket.' }),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // DUPLICATE_SPEC_ID
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DUPLICATE_SPEC_ID',
    severity: 'error',
    anchoredTo: 'shipping-rate',
    expectFire: true,
    scenario: 'Two type files of the parcel carrier project both declare `shipping-rate` — one for domestic, one for international parcels — so every reference to the type could mean either.',
    tree: {
      system: { name: 'ParcelCarrier', vision: 'Quotes and books parcel shipments.' },
      subsystems: [{ id: 'quoting', description: 'Shipping quotes.' }],
      types: [
        { id: 'shipping-rate', subsystem: 'quoting', fields: [{ name: 'domesticCents', type: 'u64', description: 'Domestic rate', optional: false }] },
        { id: 'shipping-rate', subsystem: 'quoting', fields: [{ name: 'internationalCents', type: 'u64', description: 'International rate', optional: false }] },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DUPLICATE_SPEC_ID',
    expectFire: false,
    reason: 'Each rate type carries its own id, so every reference names one type.',
    scenario: 'The parcel carrier project names its two rate types `domestic-rate` and `international-rate`.',
    tree: {
      system: { name: 'ParcelCarrier', vision: 'Quotes and books parcel shipments.' },
      subsystems: [{ id: 'quoting', description: 'Shipping quotes.' }],
      types: [
        { id: 'domestic-rate', subsystem: 'quoting', fields: [{ name: 'cents', type: 'u64', description: 'Domestic rate', optional: false }] },
        { id: 'international-rate', subsystem: 'quoting', fields: [{ name: 'cents', type: 'u64', description: 'International rate', optional: false }] },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // LOCAL_ID_SHADOWS_PROJECT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LOCAL_ID_SHADOWS_PROJECT',
    severity: 'warning',
    anchoredTo: 'pricing',
    expectFire: true,
    scenario: 'The storefront declares its pricing engine as the member `pricing` and also has a local subsystem `pricing` — a reader seeing `pricing` beside `pricing::quote-portal` cannot tell the subsystem from the member.',
    tree: storefront('pricing'),
  }),
  defineRuleFixture({
    code: 'LOCAL_ID_SHADOWS_PROJECT',
    expectFire: false,
    reason: 'The local subsystem is named `price-display`, so no local id reads like the member alias.',
    scenario: 'The storefront declares the member `pricing` and names its own display subsystem `price-display`.',
    tree: storefront('price-display'),
  }),
];
