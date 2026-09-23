/**
 * Export conformance (code↔spec for the SURFACE) — src/core/rules/conformance/export-conformance.ts.
 *
 * Documented intents pinned here (rule description + module doc comment):
 *  - UNDECLARED_EXPORT (warning): a file realizing a component publishes a
 *    name that no contract of the components it realizes declares, and a file
 *    realizing a DIFFERENT component imports it. Read the other way round from
 *    the rest of the conformance set, which asks whether the code holds what a
 *    spec claims and so never looks at what else the module publishes.
 *  - UNREALIZED_EXPORT_HANDLE (warning): an implementation method declares
 *    an `exportedVia` handle — the export a consumer imports to REACH the
 *    method, which `symbol` cannot name because `symbol` names the function
 *    inside — that its own source file does not export. Reported instead of
 *    allowed, so the field can never be a free-text way to silence the rule.
 *
 * The quiet shapes, each with a control:
 *  - a name the CONTRACT declares is surface the design promised, however far
 *    across the tree it is imported;
 *  - an undeclared export is a candidate and not a finding until somebody
 *    OUTSIDE takes it, and two files realizing the SAME component are one
 *    component's implementation spread over two files (overlap, not subset),
 *    which the source-path model has always allowed;
 *  - a handle the file DOES export is a route a consumer can import, and the
 *    name it publishes is promised surface — one tree, asserted from both
 *    sides, because silence on either half alone would leave the other free.
 */
import { defineRuleFixture, type FixtureTree } from '../harness.js';

/**
 * One tree, read from both sides below. The quote orchestrator is published as
 * a single composed object, the label orchestrator imports THAT, and the
 * implementation declares the object as the pricing method's `exportedVia`
 * handle. Without the declaration this is exactly the crossing the first
 * fixture in this file reports; with it the name is promised surface AND the
 * handle is realized, so both codes must stay quiet — which is what pins the
 * two halves of the field's meaning to one scenario.
 */
const COMPOSED_QUOTE_ORCHESTRATOR: FixtureTree = {
  subsystems: [{ id: 'shipping', description: 'Rate quotes and carrier labels for outbound parcels.' }],
  components: [
    {
      id: 'quote-orchestrator',
      componentType: 'Orchestrator',
      subsystem: 'shipping',
      description: 'Prices an outbound parcel against the carrier rate card.',
    },
    {
      id: 'label-orchestrator',
      componentType: 'Orchestrator',
      subsystem: 'shipping',
      description: 'Renders the carrier label for a booked shipment.',
      dependsOn: ['quote-orchestrator'],
    },
  ],
  interfaces: [
    {
      id: 'iquote_orchestrator',
      component: 'quote-orchestrator',
      methods: [{ name: 'calculateQuote', description: 'Price an outbound parcel for a destination.' }],
    },
    {
      id: 'ilabel_orchestrator',
      component: 'label-orchestrator',
      methods: [{ name: 'generateLabel', description: 'Render the carrier label for a booked shipment.' }],
    },
  ],
  implementations: [
    {
      id: 'quote_orchestrator_impl',
      contract: 'iquote_orchestrator',
      sourcePath: 'src/shipping/quote-orchestrator.ts',
      methods: [
        {
          name: 'calculateQuote',
          exportedVia: 'quoteOrchestrator',
          narrative: [
            { stepNumber: 1, type: 'local', description: 'Multiply the rate-card band for the destination by the parcel weight.' },
          ],
        },
      ],
    },
    {
      id: 'label_orchestrator_impl',
      contract: 'ilabel_orchestrator',
      sourcePath: 'src/shipping/label-orchestrator.ts',
      methods: [
        {
          name: 'generateLabel',
          narrative: [
            {
              stepNumber: 1,
              type: 'call',
              description: 'Ask the quote orchestrator for the price to print on the label.',
              targetComponent: 'quote-orchestrator',
              targetMethod: 'calculateQuote',
            },
            { stepNumber: 2, type: 'local', description: 'Render the quoted price onto the label line.' },
          ],
        },
      ],
    },
  ],
  files: {
    'src/shipping/quote-orchestrator.ts': [
      'export const quoteOrchestrator = {',
      '  calculateQuote(destination: string, grams: number): number {',
      '    return destination.length * grams;',
      '  },',
      '};',
      '',
    ].join('\n'),
    'src/shipping/label-orchestrator.ts': [
      'import { quoteOrchestrator } from \'./quote-orchestrator.js\';',
      '',
      'export function generateLabel(destination: string, grams: number): string {',
      '  return \'LABEL:\' + quoteOrchestrator.calculateQuote(destination, grams);',
      '}',
      '',
    ].join('\n'),
  },
};

export default [
  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — fire: a private helper reached from another component
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    severity: 'warning',
    anchoredTo: 'quote_orchestrator_impl',
    expectFire: true,
    scenario:
      'The shipping label orchestrator imports a postal-code normalizer that the quote orchestrator\'s module exports but no contract of it declares, so a second component reaches a surface the design never promised.',
    tree: {
      subsystems: [{ id: 'shipping', description: 'Rate quotes and carrier labels for outbound parcels.' }],
      components: [
        {
          id: 'quote-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'shipping',
          description: 'Prices an outbound parcel against the carrier rate card.',
        },
        {
          id: 'label-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'shipping',
          description: 'Renders the carrier label for a booked shipment.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_orchestrator',
          component: 'quote-orchestrator',
          methods: [{ name: 'calculateQuote', description: 'Price an outbound parcel for a destination.' }],
        },
        {
          id: 'ilabel_orchestrator',
          component: 'label-orchestrator',
          methods: [{ name: 'generateLabel', description: 'Render the carrier label for a booked shipment.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_orchestrator_impl',
          contract: 'iquote_orchestrator',
          sourcePath: 'src/shipping/quote-orchestrator.ts',
          methods: [
            {
              name: 'calculateQuote',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Normalize the destination postal code to its canonical form.' },
                { stepNumber: 2, type: 'local', description: 'Multiply the rate-card band for that code by the parcel weight.' },
              ],
            },
          ],
        },
        {
          id: 'label_orchestrator_impl',
          contract: 'ilabel_orchestrator',
          sourcePath: 'src/shipping/label-orchestrator.ts',
          methods: [
            {
              name: 'generateLabel',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Normalize the destination postal code and render it onto the label line.' },
              ],
            },
          ],
        },
      ],
      files: {
        'src/shipping/quote-orchestrator.ts': [
          'export function normalizePostalCode(raw: string): string {',
          '  return raw.trim().toUpperCase();',
          '}',
          '',
          'export function calculateQuote(destination: string, grams: number): number {',
          '  return normalizePostalCode(destination).length * grams;',
          '}',
          '',
        ].join('\n'),
        'src/shipping/label-orchestrator.ts': [
          'import { normalizePostalCode } from \'./quote-orchestrator.js\';',
          '',
          'export function generateLabel(destination: string): string {',
          '  return \'LABEL:\' + normalizePostalCode(destination);',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — control: the name crossing the boundary IS a contract
  // method, and the private helper nobody outside takes stays a candidate.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'The name the second component imports is a method the quote orchestrator\'s contract declares, so the surface it reaches was promised by the design; the postal-code helper is still exported, but only its own file\'s component uses it, which is the module\'s private factoring and not a crossing.',
    scenario:
      'The shipping label orchestrator imports the quote orchestrator\'s declared calculateQuote method, while the postal-code normalizer stays a helper nothing outside the module takes.',
    tree: {
      subsystems: [{ id: 'shipping', description: 'Rate quotes and carrier labels for outbound parcels.' }],
      components: [
        {
          id: 'quote-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'shipping',
          description: 'Prices an outbound parcel against the carrier rate card.',
        },
        {
          id: 'label-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'shipping',
          description: 'Renders the carrier label for a booked shipment.',
          dependsOn: ['quote-orchestrator'],
        },
      ],
      interfaces: [
        {
          id: 'iquote_orchestrator',
          component: 'quote-orchestrator',
          methods: [{ name: 'calculateQuote', description: 'Price an outbound parcel for a destination.' }],
        },
        {
          id: 'ilabel_orchestrator',
          component: 'label-orchestrator',
          methods: [{ name: 'generateLabel', description: 'Render the carrier label for a booked shipment.' }],
        },
      ],
      implementations: [
        {
          id: 'quote_orchestrator_impl',
          contract: 'iquote_orchestrator',
          sourcePath: 'src/shipping/quote-orchestrator.ts',
          methods: [
            {
              name: 'calculateQuote',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Normalize the destination postal code to its canonical form.' },
                { stepNumber: 2, type: 'local', description: 'Multiply the rate-card band for that code by the parcel weight.' },
              ],
            },
          ],
        },
        {
          id: 'label_orchestrator_impl',
          contract: 'ilabel_orchestrator',
          sourcePath: 'src/shipping/label-orchestrator.ts',
          methods: [
            {
              name: 'generateLabel',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Ask the quote orchestrator for the price to print on the label.',
                  targetComponent: 'quote-orchestrator',
                  targetMethod: 'calculateQuote',
                },
                { stepNumber: 2, type: 'local', description: 'Render the quoted price onto the label line.' },
              ],
            },
          ],
        },
      ],
      files: {
        'src/shipping/quote-orchestrator.ts': [
          'export function normalizePostalCode(raw: string): string {',
          '  return raw.trim().toUpperCase();',
          '}',
          '',
          'export function calculateQuote(destination: string, grams: number): number {',
          '  return normalizePostalCode(destination).length * grams;',
          '}',
          '',
        ].join('\n'),
        'src/shipping/label-orchestrator.ts': [
          'import { calculateQuote } from \'./quote-orchestrator.js\';',
          '',
          'export function generateLabel(destination: string, grams: number): string {',
          '  return \'LABEL:\' + calculateQuote(destination, grams);',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — control: overlap, not subset. One component written
  // across two files shares a helper between them.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'Both files realize the quote orchestrator — its rate-card refresh lives in its own module — so the consumer shares a component with the exporter and has crossed nothing. Two files realizing the same component are that component\'s own implementation spread over two files, which the source-path model has always allowed.',
    scenario:
      'The quote orchestrator is written across two modules, and its entry point imports a rate-row parser the rate-card module exports but no contract names.',
    tree: {
      subsystems: [{ id: 'shipping', description: 'Rate quotes and carrier labels for outbound parcels.' }],
      components: [
        {
          id: 'quote-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'shipping',
          description: 'Prices an outbound parcel against the carrier rate card and keeps that card fresh.',
        },
      ],
      interfaces: [
        {
          id: 'iquote_orchestrator',
          component: 'quote-orchestrator',
          methods: [
            { name: 'calculateQuote', description: 'Price an outbound parcel for a destination.' },
            { name: 'refreshRateCard', description: 'Reload the carrier rate card from the published tariff.' },
          ],
        },
      ],
      implementations: [
        {
          id: 'quote_orchestrator_impl',
          contract: 'iquote_orchestrator',
          sourcePath: 'src/shipping/quote-orchestrator.ts',
          methods: [
            {
              name: 'calculateQuote',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Parse the rate row for the destination band.' },
                { stepNumber: 2, type: 'local', description: 'Multiply the parsed band by the parcel weight.' },
              ],
            },
            {
              name: 'refreshRateCard',
              sourcePath: 'src/shipping/rate-card.ts',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Read the published tariff lines and parse each rate row.' },
              ],
            },
          ],
        },
      ],
      files: {
        'src/shipping/rate-card.ts': [
          'export function parseRateRow(row: string): number {',
          '  return Number(row.split(\':\')[1] ?? 0);',
          '}',
          '',
          'export function refreshRateCard(tariff: string[]): number[] {',
          '  return tariff.map(parseRateRow);',
          '}',
          '',
        ].join('\n'),
        'src/shipping/quote-orchestrator.ts': [
          'import { parseRateRow } from \'./rate-card.js\';',
          '',
          'export function calculateQuote(band: string, grams: number): number {',
          '  return parseRateRow(band) * grams;',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_EXPORT_HANDLE — fire: the declared handle is not exported
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    severity: 'warning',
    anchoredTo: 'tariff_adapter_impl',
    expectFire: true,
    scenario:
      'The carrier tariff adapter is published as one composed object, and its implementation names carrierTariffPlugin as the handle a consumer imports to reach the method — a binding the module never exports.',
    tree: {
      subsystems: [{ id: 'shipping', description: 'Rate quotes and carrier labels for outbound parcels.' }],
      components: [
        {
          id: 'tariff-adapter',
          componentType: 'Adapter',
          subsystem: 'shipping',
          description: 'Reads the carrier tariff feed the rate card is priced from.',
        },
      ],
      interfaces: [
        {
          id: 'itariff_adapter',
          component: 'tariff-adapter',
          methods: [{ name: 'readTariff', description: 'Read the published carrier tariff lines.' }],
        },
      ],
      implementations: [
        {
          id: 'tariff_adapter_impl',
          contract: 'itariff_adapter',
          sourcePath: 'src/shipping/tariff-adapter.ts',
          methods: [
            {
              name: 'readTariff',
              symbol: 'read',
              exportedVia: 'carrierTariffPlugin',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Split the carrier tariff feed into its published rate lines.' },
              ],
            },
          ],
        },
      ],
      files: {
        'src/shipping/tariff-adapter.ts': [
          'export const carrierTariffAdapter = {',
          '  read(feed: string): string[] {',
          '    return feed.split(\';\');',
          '  },',
          '};',
          '',
        ].join('\n'),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNREALIZED_EXPORT_HANDLE — control, and the other half of the field's
  // meaning. One tree, asserted from both sides: the handle IS exported, so
  // nothing is reported (here), and the name it publishes is promised surface
  // rather than a crossing (the UNDECLARED_EXPORT control below, over the same
  // tree — without the handle that import is exactly the fire fixture at the
  // top of this file).
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    expectFire: false,
    reason:
      'The handle the quote orchestrator declares is a binding its own module really exports, so the spec names a route a consumer can genuinely import and there is nothing to report.',
    scenario: 'The quote orchestrator is published as one composed object, and its implementation names that object as the handle a consumer imports to reach the pricing method.',
    tree: COMPOSED_QUOTE_ORCHESTRATOR,
  }),

  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'The name the label orchestrator imports is the quote orchestrator\'s declared exportedVia handle — the export a consumer takes to REACH calculateQuote, which `symbol` cannot name because `symbol` names the function inside. Declared, it is promised surface, and the crossing the same tree would otherwise be reported for is no longer one.',
    scenario: 'The shipping label orchestrator imports the quote orchestrator\'s published object, the handle the quote orchestrator\'s implementation declares for its pricing method.',
    tree: COMPOSED_QUOTE_ORCHESTRATOR,
  }),
];
