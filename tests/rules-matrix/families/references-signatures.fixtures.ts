/**
 * Signatures family (stage 1 of the generic design model):
 *  - src/core/rules/integrity/signature-sources.ts — every `signatureFrom` the
 *    loader met, judged from ctx.signatureFacts: unresolved, ambiguous (both
 *    readings bind), chained, off the dependsOn/owns edges, or restated with
 *    DIFFERENT params/returns (an equal restatement is only redundant).
 *  - src/core/rules/integrity/signature-text.ts — a stored text its params
 *    contradict (SIGNATURE_TEXT_STALE).
 *  - src/core/rules/integrity/signature-types.ts — a signature type is params
 *    and one returns, nothing else (SIGNATURE_TYPE_MEMBERS).
 *  - src/core/rules/heuristic/signature-source-suggestions.ts — a Repository
 *    facade restating exactly the owned member it forwards to
 *    (SIGNATURE_SOURCE_AVAILABLE, a notice, one per facade contract).
 *
 * The harness writes spec files directly, so a fixture can hold what the
 * authoring seam would refuse (a source stated beside params): exactly the
 * hand-edited file the validator exists to report.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'Tollgate',
  vision: 'Road-toll billing: passages are rated against a tariff card and settled onto customer accounts.',
};

const BILLING = { id: 'billing', description: 'Rates toll passages and settles them onto customer accounts.' };

const RATE_PARAMS = [
  { name: 'passage', type: 'string', description: 'The passage being rated' },
  { name: 'vehicleClass', type: 'string', optional: true, description: 'The vehicle class, when the gantry read it' },
];

/** The tariff engine that owns the rating method other components take their signature from. */
const TARIFF_ENGINE = {
  id: 'tariff-engine',
  subsystem: 'billing',
  componentType: 'Orchestrator',
  dependencyClass: 'pure',
  description: 'Rates one toll passage against the current tariff card.',
};
const TARIFF_CONTRACT = {
  id: 'itariff_engine',
  component: 'tariff-engine',
  methods: [{ name: 'rate', description: 'Rate one passage against the tariff card.', params: RATE_PARAMS, returns: 'number' }],
};

/** A settlement workflow whose one method takes its signature from `source`. */
function settlement(source: string, dependsOn: string[] = ['tariff-engine'], extra: Record<string, unknown> = {}) {
  return {
    component: { id: 'settlement-workflow', subsystem: 'billing', description: 'Settles rated passages onto customer accounts.', dependsOn },
    contract: {
      id: 'isettlement_workflow',
      component: 'settlement-workflow',
      methods: [{ name: 'quote', description: 'Quote what a passage will settle for.', signatureFrom: source, ...extra }],
    },
  };
}

function tree(source: string, dependsOn?: string[], extra?: Record<string, unknown>, more: Record<string, unknown[]> = {}) {
  const s = settlement(source, dependsOn, extra);
  return {
    system: SYSTEM,
    subsystems: [BILLING, ...((more.subsystems as object[]) ?? [])],
    components: [TARIFF_ENGINE, s.component, ...((more.components as object[]) ?? [])],
    interfaces: [TARIFF_CONTRACT, s.contract, ...((more.interfaces as object[]) ?? [])],
    types: (more.types as object[]) ?? [],
  } as never;
}

export default [
  // ---- SIGNATURE_SOURCE_UNRESOLVED ---------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_UNRESOLVED',
    severity: 'error',
    anchoredTo: 'isettlement_workflow',
    expectFire: true,
    scenario: 'The settlement workflow takes its quote signature from "tariff-engine.price", a method the tariff engine does not declare.',
    tree: tree('tariff-engine.price'),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_UNRESOLVED',
    expectFire: false,
    reason: 'The source names the tariff engine\'s real rating method, so it binds.',
    scenario: 'The settlement workflow takes its quote signature from the tariff engine\'s rate method, which it depends on.',
    tree: tree('tariff-engine.rate'),
  }),

  // ---- SIGNATURE_SOURCE_AMBIGUOUS ----------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_AMBIGUOUS',
    severity: 'error',
    anchoredTo: 'isettlement_workflow',
    expectFire: true,
    scenario:
      'A "tariff-engine" subsystem also declares a signature type "rate", so "tariff-engine.rate" names both the tariff engine component\'s rate method and that signature type.',
    tree: tree('tariff-engine.rate', ['tariff-engine'], {}, {
      subsystems: [{ id: 'tariff-engine', description: 'The shared vocabulary of tariff rating.' }],
      types: [{
        id: 'rate', kind: 'signature', subsystem: 'tariff-engine', description: 'Rates a passage.',
        params: [{ name: 'passage', type: 'string' }], returns: 'number',
      }],
    }),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_AMBIGUOUS',
    expectFire: false,
    reason: 'The signature type is named "passage-rater", so "tariff-engine.rate" can only be the method.',
    scenario: 'The tariff vocabulary subsystem names its signature type passage-rater; the settlement quote takes the tariff engine\'s rate method unambiguously.',
    tree: tree('tariff-engine.rate', ['tariff-engine'], {}, {
      subsystems: [{ id: 'tariff-engine', description: 'The shared vocabulary of tariff rating.' }],
      types: [{
        id: 'passage-rater', kind: 'signature', subsystem: 'tariff-engine', description: 'Rates a passage.',
        params: [{ name: 'passage', type: 'string' }], returns: 'number',
      }],
    }),
  }),

  // ---- SIGNATURE_SOURCE_CHAINED ------------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_CHAINED',
    severity: 'error',
    anchoredTo: 'iinvoice_portal',
    expectFire: true,
    scenario:
      'The invoice portal takes its quote signature from the settlement workflow\'s quote, which itself takes its signature from the tariff engine — a chain, never followed.',
    tree: tree('tariff-engine.rate', ['tariff-engine'], {}, {
      components: [{ id: 'invoice-portal', subsystem: 'billing', componentType: 'Portal', portalType: 'REST', description: 'Customer-facing quote endpoint.', dependsOn: ['settlement-workflow'] }],
      interfaces: [{ id: 'iinvoice_portal', component: 'invoice-portal', methods: [{ name: 'quote', description: 'Quote a passage for a customer.', signatureFrom: 'settlement-workflow.quote' }] }],
    }),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_CHAINED',
    expectFire: false,
    reason: 'The settlement workflow states its own params, so the portal\'s source declares its signature itself.',
    scenario: 'The settlement workflow states the quote params itself, and the invoice portal takes its signature from it.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING],
      components: [
        { id: 'settlement-workflow', description: 'Settles rated passages onto customer accounts.' },
        { id: 'invoice-portal', subsystem: 'billing', componentType: 'Portal', portalType: 'REST', description: 'Customer-facing quote endpoint.', dependsOn: ['settlement-workflow'] },
      ],
      interfaces: [
        { id: 'isettlement_workflow', component: 'settlement-workflow', methods: [{ name: 'quote', description: 'Quote what a passage will settle for.', params: RATE_PARAMS, returns: 'number' }] },
        { id: 'iinvoice_portal', component: 'invoice-portal', methods: [{ name: 'quote', description: 'Quote a passage for a customer.', signatureFrom: 'settlement-workflow.quote' }] },
      ],
    },
  }),

  // ---- SIGNATURE_SOURCE_OFF_EDGE -----------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_OFF_EDGE',
    severity: 'error',
    anchoredTo: 'isettlement_workflow',
    expectFire: true,
    scenario: 'The settlement workflow takes its quote signature from the tariff engine without depending on it.',
    tree: tree('tariff-engine.rate', []),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_OFF_EDGE',
    expectFire: false,
    reason: 'The settlement workflow depends on the tariff engine, so the source lies along a design edge.',
    scenario: 'The settlement workflow depends on the tariff engine and takes its quote signature from the engine\'s rate method.',
    tree: tree('tariff-engine.rate', ['tariff-engine']),
  }),

  // ---- SIGNATURE_SOURCE_RESTATED -----------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_RESTATED',
    severity: 'error',
    anchoredTo: 'isettlement_workflow',
    expectFire: true,
    scenario:
      'A hand edit left the settlement quote naming the tariff engine as its source while also stating a different return type — two contracts in one method.',
    tree: tree('tariff-engine.rate', ['tariff-engine'], { params: RATE_PARAMS, returns: 'string' }),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_RESTATED',
    expectFire: false,
    reason: 'The restated params and returns equal the source\'s: redundant (the doctor drops them), never a second contract.',
    scenario: 'The settlement quote names the tariff engine as its source and still carries an identical copy of the rate params and returns.',
    tree: tree('tariff-engine.rate', ['tariff-engine'], { params: RATE_PARAMS, returns: 'number' }),
  }),

  // ---- SIGNATURE_TEXT_STALE ----------------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_TEXT_STALE',
    severity: 'warning',
    anchoredTo: 'itariff_engine',
    expectFire: true,
    scenario: 'The tariff engine\'s stored rate text still lists the vehicle class as required, although its params mark it optional.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING],
      components: [TARIFF_ENGINE],
      interfaces: [{
        ...TARIFF_CONTRACT,
        methods: [{ ...TARIFF_CONTRACT.methods[0], signature: 'rate(passage: string, vehicleClass: string): number' }],
      }],
    },
  }),
  defineRuleFixture({
    code: 'SIGNATURE_TEXT_STALE',
    expectFire: false,
    reason: 'The stored text is exactly what the params derive, optional marker included.',
    scenario: 'The tariff engine\'s stored rate text matches its params, the vehicle class marked optional.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING],
      components: [TARIFF_ENGINE],
      interfaces: [{
        ...TARIFF_CONTRACT,
        methods: [{ ...TARIFF_CONTRACT.methods[0], signature: 'rate(passage: string, vehicleClass?: string): number' }],
      }],
    },
  }),

  // ---- SIGNATURE_TYPE_MEMBERS --------------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_TYPE_MEMBERS',
    severity: 'error',
    anchoredTo: 'passage-rater',
    expectFire: true,
    scenario: 'The passage-rater signature type also carries a data field, as if it were a record.',
    tree: tree('passage-rater', [], {}, {
      types: [{
        id: 'passage-rater', kind: 'signature', subsystem: 'billing', description: 'Rates a passage.',
        params: [{ name: 'passage', type: 'string' }], returns: 'number',
        fields: [{ name: 'currency', type: 'string', description: 'The rated currency', optional: false }],
      }],
    }),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_TYPE_MEMBERS',
    expectFire: false,
    reason: 'The signature type carries params and one returns, nothing else.',
    scenario: 'The passage-rater signature type is a plain function type the settlement quote takes its signature from.',
    tree: tree('passage-rater', [], {}, {
      types: [{
        id: 'passage-rater', kind: 'signature', subsystem: 'billing', description: 'Rates a passage.',
        params: [{ name: 'passage', type: 'string' }], returns: 'number',
      }],
    }),
  }),

  // ---- SIGNATURE_SOURCE_AVAILABLE ----------------------------------------
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_AVAILABLE',
    severity: 'notice',
    anchoredTo: 'iaccount_repository',
    expectFire: true,
    scenario: 'The account repository facade restates exactly the owned account index\'s balance lookup it forwards to.',
    tree: accountRepository([{ name: 'accountId', type: 'string', description: 'The account to read' }]),
  }),
  defineRuleFixture({
    code: 'SIGNATURE_SOURCE_AVAILABLE',
    expectFire: false,
    reason: 'The facade\'s param is named differently from the member\'s, so the signatures are not one contract and nothing is suggested.',
    scenario: 'The account repository facade forwards its balance lookup to the owned account index under a different param name.',
    tree: accountRepository([{ name: 'customerAccount', type: 'string', description: 'The account to read' }]),
  }),
];

/** A Repository facade forwarding balanceOf 1:1 to its owned index; the facade states `facadeParams`. */
function accountRepository(facadeParams: Record<string, unknown>[]) {
  return {
    system: SYSTEM,
    subsystems: [BILLING],
    components: [
      { id: 'account-repository', componentType: 'Repository', description: 'Facade over the account store and its balance index.', owns: ['account-store', 'account-index'] },
      { id: 'account-store', componentType: 'Store', description: 'Backing store of customer accounts.', durability: 'read-through' },
      { id: 'account-index', componentType: 'Index', description: 'Balance lookup over customer accounts.' },
    ],
    interfaces: [
      { id: 'iaccount_repository', component: 'account-repository', methods: [{ name: 'balanceOf', description: 'Read an account\'s balance.', params: facadeParams, returns: 'number' }] },
      { id: 'iaccount_store', component: 'account-store', methods: [{ name: 'getById', description: 'Read one account by id.', effect: 'read' }] },
      { id: 'iaccount_index', component: 'account-index', methods: [{ name: 'balanceOf', description: 'Look up an account\'s balance.', params: [{ name: 'accountId', type: 'string', description: 'The account to read' }], returns: 'number' }] },
    ],
    implementations: [{
      id: 'account_repository_impl',
      contract: 'iaccount_repository',
      methods: [{
        name: 'balanceOf',
        narrative: [{ stepNumber: 1, type: 'call', description: 'Forward the balance lookup to the owned account index.', targetComponent: 'account-index', targetMethod: 'balanceOf' }],
      }],
    }],
  } as never;
}
