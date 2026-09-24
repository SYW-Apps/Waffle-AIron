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
 *    The same holds for a listener mount's `via` — the router entry the
 *    listener calls to hand a portal its requests — which the MOUNTED portal's
 *    files must export, reported against the listener that declares it.
 *
 * The quiet shapes, each with a control:
 *  - a name the CONTRACT declares is surface the design promised, however far
 *    across the tree it is imported;
 *  - an undeclared export is a candidate and not a finding until somebody
 *    OUTSIDE takes it, and two files realizing the SAME component are one
 *    component's implementation spread over two files (overlap, not subset),
 *    which the source-path model has always allowed;
 *  - a NAMESPACE import takes each name the file calls through it, exactly as
 *    a named import takes the name it binds, and one bound but never called
 *    through takes nothing — each quiet shape above is asserted again through
 *    a namespace, so its silence is the rule's verdict and not a blind spot;
 *  - a handle the file DOES export is a route a consumer can import, and the
 *    name it publishes is promised surface — one tree, asserted from both
 *    sides, because silence on either half alone would leave the other free;
 *    a mount `via` the portal's file exports is read from both sides the same
 *    way.
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

/**
 * The quote orchestrator and a label orchestrator that reaches it through a
 * NAMESPACE import (`import * as quotes`), with the label module's source
 * supplied per fixture. The quote module exports its declared pricing method
 * and a postal-code normalizer no contract declares; what the label module
 * CALLS through the namespace is what decides whether anything crossed. When
 * the label orchestrator calls the declared method its narrative says so, and
 * it depends on the quote orchestrator.
 */
function namespaceLabelTree(labelSource: string[], callsDeclaredQuote: boolean): FixtureTree {
  return {
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
        ...(callsDeclaredQuote ? { dependsOn: ['quote-orchestrator'] } : {}),
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
            narrative: callsDeclaredQuote
              ? [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Ask the quote orchestrator for the price to print on the label.',
                  targetComponent: 'quote-orchestrator',
                  targetMethod: 'calculateQuote',
                },
                { stepNumber: 2, type: 'local', description: 'Render the quoted price onto the label line.' },
              ]
              : [
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
      'src/shipping/label-orchestrator.ts': labelSource.join('\n'),
    },
  };
}

/**
 * A clinic host whose public listener mounts the booking portal under /booking
 * through a router entry, `handleBookingRequest`, that the listener imports
 * from the booking portal's own module. No contract declares that entry: the
 * booking portal's contract is its routes, and the entry is how the LISTENER
 * hands it a request. The mount's `via` is the only thing that promises it, so
 * one tree reads both ways — with the entry exported, the handle is realized
 * and the listener's import is promised surface; `bookingExports` swaps in a
 * module that publishes the entry under another name.
 */
function mountedBookingTree(bookingExports: 'handleBookingRequest' | 'routeBooking', via: string | undefined): FixtureTree {
  return {
    subsystems: [{ id: 'clinic', description: 'Patient booking for an outpatient clinic.' }],
    components: [
      {
        id: 'clinic-listener',
        componentType: 'Portal',
        portalType: 'HTTP_API',
        subsystem: 'clinic',
        description: 'The clinic host\'s public HTTP listener; routes each request to the portal that owns its path.',
        mounts: [{ portal: 'booking-portal', prefixes: ['/booking'], ...(via ? { via } : {}) }],
      },
      {
        id: 'booking-portal',
        componentType: 'Portal',
        portalType: 'HTTP_API',
        subsystem: 'clinic',
        description: 'Lets patients book their clinic visits.',
      },
    ],
    interfaces: [
      {
        id: 'iclinic_listener',
        component: 'clinic-listener',
        methods: [
          {
            name: 'reportHealth',
            description: 'Report whether the clinic host is serving.',
            endpoint: { transport: 'HTTP', method: 'GET', path: '/healthz' },
          },
        ],
      },
      {
        id: 'ibooking_portal',
        component: 'booking-portal',
        methods: [
          {
            name: 'bookVisit',
            description: 'Book a visit for a patient.',
            endpoint: { transport: 'HTTP', method: 'POST', path: '/booking/visits' },
          },
        ],
      },
    ],
    implementations: [
      {
        id: 'clinic_listener_impl',
        contract: 'iclinic_listener',
        sourcePath: 'src/clinic/listener.ts',
        methods: [
          {
            name: 'reportHealth',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Answer that the clinic host is serving.' }],
          },
        ],
      },
      {
        id: 'booking_portal_impl',
        contract: 'ibooking_portal',
        sourcePath: 'src/clinic/booking-portal.ts',
        methods: [
          {
            name: 'bookVisit',
            narrative: [{ stepNumber: 1, type: 'local', description: 'Record the requested visit for the patient.' }],
          },
        ],
      },
    ],
    files: {
      'src/clinic/booking-portal.ts': [
        'export function bookVisit(patient: string): string {',
        '  return \'visit:\' + patient;',
        '}',
        '',
        `export function ${bookingExports}(path: string, body: string): string | undefined {`,
        '  return path === \'/booking/visits\' ? bookVisit(body) : undefined;',
        '}',
        '',
      ].join('\n'),
      'src/clinic/listener.ts': [
        `import { ${bookingExports} } from './booking-portal.js';`,
        '',
        'export function reportHealth(): string {',
        '  return \'ok\';',
        '}',
        '',
        'export function route(path: string, body: string): string | undefined {',
        `  return path.startsWith('/booking/') ? ${bookingExports}(path, body) : reportHealth();`,
        '}',
        '',
      ].join('\n'),
    },
  };
}

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
  // UNDECLARED_EXPORT — fire: the private helper reached through a NAMESPACE.
  // The call names the export exactly as a named import would.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    severity: 'warning',
    anchoredTo: 'quote_orchestrator_impl',
    expectFire: true,
    scenario:
      'The shipping label orchestrator imports the quote orchestrator\'s whole module as a namespace and calls its postal-code normalizer through it, a name the module exports but no contract of the quote orchestrator declares.',
    tree: namespaceLabelTree(
      [
        'import * as quotes from \'./quote-orchestrator.js\';',
        '',
        'export function generateLabel(destination: string): string {',
        '  return \'LABEL:\' + quotes.normalizePostalCode(destination);',
        '}',
        '',
      ],
      false,
    ),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — control: a namespace bound and never called through
  // names nothing, so it takes nothing.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'The label orchestrator binds the quote module as a namespace but never calls anything through it — it only files the module in its table of pricing sources — so no call site names an export and nothing is taken. A namespace is read as taking what it provably names, never as taking everything the module publishes.',
    scenario:
      'The shipping label orchestrator imports the quote orchestrator\'s module as a namespace only to list it among its pricing sources, and renders the label without calling into it.',
    tree: namespaceLabelTree(
      [
        'import * as quotes from \'./quote-orchestrator.js\';',
        '',
        'const pricingSources = { standard: quotes };',
        '',
        'export function generateLabel(destination: string): string {',
        '  return \'LABEL:\' + destination + \':\' + Object.keys(pricingSources).join(\',\');',
        '}',
        '',
      ],
      false,
    ),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — control: the name called through the namespace IS a
  // contract method.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'The one name the label orchestrator calls through the quote namespace is calculateQuote, a method the quote orchestrator\'s contract declares, so the surface it reaches was promised by the design. The postal-code normalizer is exported too, but nothing outside the module calls it.',
    scenario:
      'The shipping label orchestrator imports the quote orchestrator\'s module as a namespace and calls its declared calculateQuote method through it to price the label.',
    tree: namespaceLabelTree(
      [
        'import * as quotes from \'./quote-orchestrator.js\';',
        '',
        'export function generateLabel(destination: string, grams: number): string {',
        '  return \'LABEL:\' + quotes.calculateQuote(destination, grams);',
        '}',
        '',
      ],
      true,
    ),
  }),

  // -------------------------------------------------------------------------
  // UNDECLARED_EXPORT — control: overlap, not subset, through a namespace.
  // One component written across two files calls its own helper.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'Both files realize the quote orchestrator, so the entry point calling the rate-card module\'s parser through a namespace shares a component with the exporter and has crossed nothing — the call is seen, and it is that component\'s own implementation spread over two files.',
    scenario:
      'The quote orchestrator is written across two modules, and its entry point imports the rate-card module as a namespace and calls a rate-row parser through it that no contract names.',
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
          'import * as rateCard from \'./rate-card.js\';',
          '',
          'export function calculateQuote(band: string, grams: number): number {',
          '  return rateCard.parseRateRow(band) * grams;',
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
  // -------------------------------------------------------------------------
  // UNREALIZED_EXPORT_HANDLE — a listener mount's `via`, the router entry the
  // listener calls to hand a portal its requests. It belongs to the MOUNTED
  // portal's files and is reported against the listener that declares it.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    severity: 'warning',
    anchoredTo: 'clinic-listener',
    expectFire: true,
    scenario:
      'The clinic\'s public listener declares that it mounts the booking portal through handleBookingRequest, but the booking portal\'s module publishes its router entry as routeBooking — the mount names a route into the portal that nobody can import.',
    tree: mountedBookingTree('routeBooking', 'handleBookingRequest'),
  }),
  defineRuleFixture({
    code: 'UNREALIZED_EXPORT_HANDLE',
    expectFire: false,
    reason:
      'The router entry the mount names is a binding the booking portal\'s own module really exports, so the listener\'s declaration names a route it can genuinely import.',
    scenario: 'The clinic\'s public listener mounts the booking portal through handleBookingRequest, the router entry the booking portal\'s module exports.',
    tree: mountedBookingTree('handleBookingRequest', 'handleBookingRequest'),
  }),
  defineRuleFixture({
    code: 'UNDECLARED_EXPORT',
    expectFire: false,
    reason:
      'No contract of the booking portal declares handleBookingRequest — its contract is its routes — and the listener, a different component, imports it. The mount\'s `via` declares that entry as the portal\'s published router surface, so the import is promised rather than a crossing; without the `via` this same tree is reported.',
    scenario: 'The clinic\'s public listener imports the booking portal\'s router entry, which its mount of the booking portal declares as the entry it calls.',
    tree: mountedBookingTree('handleBookingRequest', 'handleBookingRequest'),
  }),
];
