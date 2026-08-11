/**
 * Portal field + endpoint-binding fixtures (src/core/rules/portals.ts —
 * portalFieldsRule and portalsRule).
 *
 * Documented intents pinned here:
 *  - MISSING_PORTAL_TYPE (error): a Portal declares its portalType.
 *  - UNEXPECTED_PORTAL_FIELD (error): non-Portal components carry no
 *    portalType or basePath — both behaviors get a fire.
 *  - AUTH_ON_NON_PORTAL (warning): auth is inbound transport auth, only
 *    meaningful on a Portal; a Gateway carries it on the Portal it owns
 *    (the documented example, modeled literally).
 *  - MISSING_ENDPOINT (error): a Portal whose portalType maps to a transport
 *    binds every interface method to a concrete endpoint.
 *  - ENDPOINT_TRANSPORT_MISMATCH (error): the endpoint's transport must match
 *    the Portal's portalType.
 *  - ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT (error): only Portal
 *    components may carry endpoints on their interface methods.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management.' };

export default [
  // -------------------------------------------------------------------------
  // MISSING_PORTAL_TYPE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_PORTAL_TYPE',
    severity: 'error',
    anchoredTo: 'patient-booking-portal',
    expectFire: true,
    scenario:
      'The patient booking portal is declared as a Portal but never states which portalType (HTTP, gRPC, CLI, ...) it exposes.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_PORTAL_TYPE',
    expectFire: false,
    reason: 'The Portal declares its portalType (HTTP_API), which is all this completeness code demands.',
    scenario:
      'The patient booking portal declares itself an HTTP_API portal.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // UNEXPECTED_PORTAL_FIELD — both documented fields
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    severity: 'error',
    anchoredTo: 'billing-export-orchestrator',
    expectFire: true,
    scenario:
      'The billing export orchestrator carries a portalType although it is an Orchestrator, not a Portal.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        {
          id: 'billing-export-orchestrator',
          componentType: 'Orchestrator',
          portalType: 'HTTP_API',
          description: 'Drives the nightly billing export run.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    severity: 'error',
    anchoredTo: 'invoice-archive-store',
    expectFire: true,
    scenario:
      'The invoice archive store carries a basePath as if it exposed a wire surface, but basePath is a Portal-only field.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        {
          id: 'invoice-archive-store',
          componentType: 'Store',
          basePath: '/invoices',
          description: 'Holds archived invoices for audit retrieval.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNEXPECTED_PORTAL_FIELD',
    expectFire: false,
    reason: 'The non-Portal component carries neither portalType nor basePath; the wire fields live on the Portal that exposes the surface.',
    scenario:
      'The billing export orchestrator carries no wire fields, and the invoice API portal owns the basePath of the billing surface.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'billing', description: 'Invoicing and payment collection for booked visits.' }],
      components: [
        { id: 'billing-export-orchestrator', componentType: 'Orchestrator', description: 'Drives the nightly billing export run.' },
        { id: 'invoice-api-portal', componentType: 'Portal', portalType: 'HTTP_API', basePath: '/invoices', description: 'Inbound invoicing surface of the billing subsystem.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // AUTH_ON_NON_PORTAL — the documented Gateway example, literally
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'AUTH_ON_NON_PORTAL',
    severity: 'warning',
    anchoredTo: 'partner-api-gateway',
    expectFire: true,
    scenario:
      'The partner API gateway declares the apiKey auth scheme on itself instead of on the partner portal it owns, so the OpenAPI projection would ignore it.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'partner-integrations', description: 'Partner clinic and lab integrations.' }],
      components: [
        {
          id: 'partner-api-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the partner API portal and its orchestrator.',
          owns: ['partner-api-portal', 'partner-request-orchestrator'],
          auth: { scheme: 'apiKey', in: 'header', name: 'X-Partner-Key' },
        },
        { id: 'partner-api-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for partner requests.' },
        { id: 'partner-request-orchestrator', componentType: 'Orchestrator', description: 'Drives partner-initiated request flows.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'AUTH_ON_NON_PORTAL',
    expectFire: false,
    reason: 'Auth sits on the exposed Portal — the documented resolution ("a Gateway carries it on the Portal it owns").',
    scenario:
      'The partner API gateway leaves auth to the partner portal it owns, which declares the apiKey scheme on the exposed surface.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'partner-integrations', description: 'Partner clinic and lab integrations.' }],
      components: [
        {
          id: 'partner-api-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the partner API portal and its orchestrator.',
          owns: ['partner-api-portal', 'partner-request-orchestrator'],
        },
        {
          id: 'partner-api-portal',
          componentType: 'Portal',
          portalType: 'Custom',
          description: 'Inbound surface for partner requests.',
          auth: { scheme: 'apiKey', in: 'header', name: 'X-Partner-Key' },
        },
        { id: 'partner-request-orchestrator', componentType: 'Orchestrator', description: 'Drives partner-initiated request flows.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // MISSING_ENDPOINT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_ENDPOINT',
    severity: 'error',
    anchoredTo: 'ipatient_booking',
    expectFire: true,
    scenario:
      'The HTTP patient booking portal\'s bookVisit contract method has no endpoint binding, so no wire route exists for it.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
      interfaces: [
        {
          id: 'ipatient_booking',
          component: 'patient-booking-portal',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_ENDPOINT',
    expectFire: false,
    reason: 'Every interface method of the HTTP portal is bound to a concrete HTTP endpoint of the matching transport.',
    scenario:
      'The HTTP patient booking portal binds bookVisit to POST /visits.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        { id: 'patient-booking-portal', componentType: 'Portal', portalType: 'HTTP_API', description: 'Patient-facing surface for booking visits.' },
      ],
      interfaces: [
        {
          id: 'ipatient_booking',
          component: 'patient-booking-portal',
          methods: [
            {
              name: 'bookVisit',
              description: 'Book a visit for a patient.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/visits' },
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // ENDPOINT_TRANSPORT_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ENDPOINT_TRANSPORT_MISMATCH',
    severity: 'error',
    anchoredTo: 'ireferral_exchange',
    expectFire: true,
    scenario:
      'The referral exchange portal is declared gRPC, but its submitReferral method still carries the old HTTP endpoint binding.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'referrals', description: 'Inter-clinic referral exchange.' }],
      components: [
        { id: 'referral-exchange-portal', componentType: 'Portal', portalType: 'gRPC', description: 'Inbound referral exchange surface.' },
      ],
      interfaces: [
        {
          id: 'ireferral_exchange',
          component: 'referral-exchange-portal',
          methods: [
            {
              name: 'submitReferral',
              description: 'Submit a referral to the receiving clinic.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/referrals' },
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ENDPOINT_TRANSPORT_MISMATCH',
    expectFire: false,
    reason: 'The endpoint\'s transport (gRPC) matches the Portal\'s portalType (gRPC).',
    scenario:
      'The gRPC referral exchange portal binds submitReferral to the ReferralExchange service\'s SubmitReferral rpc.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'referrals', description: 'Inter-clinic referral exchange.' }],
      components: [
        { id: 'referral-exchange-portal', componentType: 'Portal', portalType: 'gRPC', description: 'Inbound referral exchange surface.' },
      ],
      interfaces: [
        {
          id: 'ireferral_exchange',
          component: 'referral-exchange-portal',
          methods: [
            {
              name: 'submitReferral',
              description: 'Submit a referral to the receiving clinic.',
              endpoint: { transport: 'gRPC', service: 'ReferralExchange', method: 'SubmitReferral' },
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
    severity: 'error',
    anchoredTo: 'claims-scoring-specialist',
    expectFire: true,
    scenario:
      'The claims scoring specialist\'s contract method declares an HTTP endpoint although only Portal components may carry wire endpoints.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-scoring-specialist', componentType: 'Specialist', description: 'Scores a claim against the payer\'s adjudication rules.' },
      ],
      interfaces: [
        {
          id: 'iclaims_scoring',
          component: 'claims-scoring-specialist',
          methods: [
            {
              name: 'scoreClaim',
              description: 'Score one claim for adjudication.',
              endpoint: { transport: 'HTTP', method: 'POST', path: '/claims/score' },
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'ARCHITECTURE_VIOLATION_NON_PORTAL_ENDPOINT',
    expectFire: false,
    reason: 'The Specialist\'s contract carries no endpoint; wire bindings belong to the Portal that exposes the capability.',
    scenario:
      'The claims scoring specialist exposes scoreClaim as a plain in-process contract method with no wire endpoint.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      components: [
        { id: 'claims-scoring-specialist', componentType: 'Specialist', description: 'Scores a claim against the payer\'s adjudication rules.' },
      ],
      interfaces: [
        {
          id: 'iclaims_scoring',
          component: 'claims-scoring-specialist',
          methods: [{ name: 'scoreClaim', description: 'Score one claim for adjudication.' }],
        },
      ],
    },
  }),
];
