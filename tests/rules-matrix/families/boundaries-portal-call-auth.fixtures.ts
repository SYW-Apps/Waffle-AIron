/**
 * Cross-call auth conformance fixtures (src/core/rules/portal-call-auth.ts).
 *
 * Documented intents pinned here (all warnings by default):
 *  - PORTAL_AUTH_UNMET: an outbound narrative `call` into another component's
 *    Portal whose auth is not `none` must declare the credential source via
 *    the step's auth.from.
 *  - AUTH_PRESENTER_NOT_ADAPTER: the credential presenter must be an Adapter
 *    (external I/O is reserved to Adapters).
 *  - UNKNOWN_AUTH_SOURCE: a modeled `component:<id>` source must resolve.
 *  - AUTH_SOURCE_NOT_PROVIDER: the modeled source must be an Adapter or a
 *    Store.
 *  - AUTH_SOURCE_UNWIRED: the presenter must depend on (or own) its modeled
 *    credential source.
 *
 * The base shape is fully legal architecture: the claims subsystem's client
 * Adapter crosses into the settlement subsystem's PUBLISHED, apiKey-authed
 * Portal — so the only findings at issue are the auth-wiring ones.
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, claims, and settlement.',
};

const SETTLEMENT_SUB = {
  id: 'settlement',
  description: 'Payout settlement of adjudicated insurance claims.',
  publicInterfaces: [
    { type: 'Custom', details: 'Settlement submission surface for claim processors.', component: 'settlement-portal', interface: 'isettlement_portal' },
  ],
};

const CLAIMS_SUB = { id: 'claims', description: 'Insurance claim intake and adjudication.' };

const SETTLEMENT_PORTAL = {
  id: 'settlement-portal',
  componentType: 'Portal',
  portalType: 'Custom',
  subsystem: 'settlement',
  description: 'Inbound settlement surface of the settlement subsystem.',
  auth: { scheme: 'apiKey', in: 'header', name: 'X-Api-Key' },
};

const SETTLEMENT_PORTAL_INTERFACE = {
  id: 'isettlement_portal',
  component: 'settlement-portal',
  methods: [{ name: 'submitSettlement', description: 'Accept a settled claim for payout.' }],
};

const VAULT_ADAPTER: FixtureSpecInput = {
  id: 'vault-secret-adapter',
  componentType: 'Adapter',
  subsystem: 'claims',
  description: 'Loads API credentials from the clinic secret vault.',
};

/** The presenting client adapter; dependsOn is injected per fixture. */
const clientAdapter = (dependsOn: string[]): FixtureSpecInput => ({
  id: 'settlement-client-adapter',
  componentType: 'Adapter',
  subsystem: 'claims',
  description: 'Client adapter forwarding adjudicated claims to the settlement subsystem.',
  dependsOn,
});

const CLIENT_INTERFACE = {
  id: 'isettlement_client',
  component: 'settlement-client-adapter',
  methods: [{ name: 'forwardSettlement', description: 'Forward one adjudicated claim to settlement.' }],
};

/** The presenter's narrative call into the authed portal, with optional step auth. */
const clientImpl = (auth?: { from: string }): FixtureSpecInput => ({
  id: 'settlement_client_impl',
  contract: 'isettlement_client',
  methods: [
    {
      name: 'forwardSettlement',
      narrative: [
        {
          stepNumber: 1,
          type: 'call',
          description: 'Submit the adjudicated claim to the settlement portal.',
          targetComponent: 'settlement-portal',
          targetMethod: 'submitSettlement',
          ...(auth ? { auth } : {}),
        },
      ],
    },
  ],
});

export default [
  // -------------------------------------------------------------------------
  // PORTAL_AUTH_UNMET
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PORTAL_AUTH_UNMET',
    severity: 'warning',
    anchoredTo: 'settlement_client_impl',
    expectFire: true,
    scenario:
      'The settlement client adapter calls the apiKey-authed settlement portal without declaring where the credential it presents is loaded from.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal']), SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl()],
    },
  }),
  defineRuleFixture({
    code: 'PORTAL_AUTH_UNMET',
    expectFire: false,
    reason: 'The call step declares its credential source (an env var) via auth.from — the documented design note wairon never resolves.',
    scenario:
      'The settlement client adapter calls the authed settlement portal and declares the SETTLEMENT_API_KEY environment variable as its credential source.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal']), SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'env:SETTLEMENT_API_KEY' })],
    },
  }),

  // -------------------------------------------------------------------------
  // AUTH_PRESENTER_NOT_ADAPTER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'AUTH_PRESENTER_NOT_ADAPTER',
    severity: 'warning',
    anchoredTo: 'claims_payout_impl',
    expectFire: true,
    scenario:
      'The claims payout orchestrator itself authenticates the outbound call to the settlement portal instead of routing the external I/O through a client adapter.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [
        {
          id: 'claims-payout-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'claims',
          description: 'Drives payout of adjudicated claims.',
          dependsOn: ['settlement-portal'],
        },
        SETTLEMENT_PORTAL,
      ],
      interfaces: [
        {
          id: 'iclaims_payout',
          component: 'claims-payout-orchestrator',
          methods: [{ name: 'payoutClaim', description: 'Pay out one adjudicated claim.' }],
        },
        SETTLEMENT_PORTAL_INTERFACE,
      ],
      implementations: [
        {
          id: 'claims_payout_impl',
          contract: 'iclaims_payout',
          methods: [
            {
              name: 'payoutClaim',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  description: 'Submit the adjudicated claim to the settlement portal.',
                  targetComponent: 'settlement-portal',
                  targetMethod: 'submitSettlement',
                  auth: { from: 'env:SETTLEMENT_API_KEY' },
                },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'AUTH_PRESENTER_NOT_ADAPTER',
    expectFire: false,
    reason: 'The presenter is an Adapter — the one block the vocabulary licenses for external I/O, so the authenticated cross-service call is where it belongs.',
    scenario:
      'The settlement client adapter presents the credential on the outbound call to the authed settlement portal.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal']), SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'env:SETTLEMENT_API_KEY' })],
    },
  }),

  // -------------------------------------------------------------------------
  // UNKNOWN_AUTH_SOURCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNKNOWN_AUTH_SOURCE',
    severity: 'warning',
    anchoredTo: 'settlement_client_impl',
    expectFire: true,
    scenario:
      'The settlement client adapter declares component:vault-secret-adapter as its credential source, but no such component exists in the tree.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal']), SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:vault-secret-adapter' })],
    },
  }),
  defineRuleFixture({
    code: 'UNKNOWN_AUTH_SOURCE',
    expectFire: false,
    reason: 'The modeled credential source resolves: the vault secret adapter exists (and is wired to the presenter).',
    scenario:
      'The settlement client adapter loads its credential from the vault secret adapter that exists in the claims subsystem.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal', 'vault-secret-adapter']), VAULT_ADAPTER, SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:vault-secret-adapter' })],
    },
  }),

  // -------------------------------------------------------------------------
  // AUTH_SOURCE_NOT_PROVIDER
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'AUTH_SOURCE_NOT_PROVIDER',
    severity: 'warning',
    anchoredTo: 'settlement_client_impl',
    expectFire: true,
    scenario:
      'The settlement client adapter names the credential-format specialist as its credential source, but a Specialist neither loads nor holds secrets.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [
        clientAdapter(['settlement-portal', 'credential-format-specialist']),
        {
          id: 'credential-format-specialist',
          componentType: 'Specialist',
          subsystem: 'claims',
          description: 'Formats credentials into the header shape the settlement API expects.',
        },
        SETTLEMENT_PORTAL,
      ],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:credential-format-specialist' })],
    },
  }),
  defineRuleFixture({
    code: 'AUTH_SOURCE_NOT_PROVIDER',
    expectFire: false,
    reason: 'The modeled source is an Adapter — a documented credential provider (loads the secret via external I/O).',
    scenario:
      'The settlement client adapter loads its credential from the vault secret adapter, a legitimate provider stereotype.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal', 'vault-secret-adapter']), VAULT_ADAPTER, SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:vault-secret-adapter' })],
    },
  }),

  // -------------------------------------------------------------------------
  // AUTH_SOURCE_UNWIRED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'AUTH_SOURCE_UNWIRED',
    severity: 'warning',
    anchoredTo: 'settlement_client_impl',
    expectFire: true,
    scenario:
      'The settlement client adapter claims to load its credential from the vault secret adapter but neither depends on nor owns it, so the wiring is not real.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal']), VAULT_ADAPTER, SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:vault-secret-adapter' })],
    },
  }),
  defineRuleFixture({
    code: 'AUTH_SOURCE_UNWIRED',
    expectFire: false,
    reason: 'The presenter declares the dependsOn edge to its credential source, so the credential wiring is a checked graph edge.',
    scenario:
      'The settlement client adapter depends on the vault secret adapter it loads its credential from.',
    tree: {
      system: SYSTEM,
      subsystems: [CLAIMS_SUB, SETTLEMENT_SUB],
      components: [clientAdapter(['settlement-portal', 'vault-secret-adapter']), VAULT_ADAPTER, SETTLEMENT_PORTAL],
      interfaces: [CLIENT_INTERFACE, SETTLEMENT_PORTAL_INTERFACE],
      implementations: [clientImpl({ from: 'component:vault-secret-adapter' })],
    },
  }),
];
