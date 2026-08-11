/**
 * Coupling-health fixtures (src/core/rules/coupling.ts).
 *
 * Documented intents pinned here:
 *  - MUTUAL_SUBSYSTEM_DEPENDENCY (warning): two subsystems depending on each
 *    other is allowed but must be acknowledged with a trustedLinks declaration
 *    on EITHER side.
 *  - INVALID_TRUSTED_LINK (error): trustedLinks must reference a real peer.
 *  - UNUSED_TRUSTED_LINK (warning): a trusted link no actual dependency
 *    crosses is stale spec.
 *  - GOD_COMPONENT (warning): excessive dependsOn fan-out; threshold defaults
 *    to 8 and is overridable via rules.complexity.maxComponentDependencies
 *    (the same knob EXCESSIVE_DEPENDENCIES reads — documented).
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

// Two subsystems that genuinely call each other: scheduling reads invoices,
// billing reads the schedule — each through the sanctioned client-Adapter →
// published-Portal shape, so the ONLY finding at issue is the coupling one.
const MUTUAL_COMPONENTS = [
  {
    id: 'schedule-portal',
    componentType: 'Portal',
    portalType: 'Custom',
    subsystem: 'scheduling',
    description: 'Inbound scheduling surface published to sibling subsystems.',
  },
  {
    id: 'billing-client-adapter',
    componentType: 'Adapter',
    subsystem: 'scheduling',
    description: 'Client adapter abstracting the hop to the billing subsystem.',
    dependsOn: ['invoice-portal'],
  },
  {
    id: 'invoice-portal',
    componentType: 'Portal',
    portalType: 'Custom',
    subsystem: 'billing',
    description: 'Inbound invoicing surface published to sibling subsystems.',
  },
  {
    id: 'schedule-feed-adapter',
    componentType: 'Adapter',
    subsystem: 'billing',
    description: 'Client adapter reading the visit schedule for invoice drafting.',
    dependsOn: ['schedule-portal'],
  },
];

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management.', publicInterfaces: [{ type: 'Custom', details: 'Scheduling surface for sibling subsystems.', component: 'schedule-portal' }] };
const BILLING_SUB = { id: 'billing', description: 'Invoicing and payment collection for booked visits.', publicInterfaces: [{ type: 'Custom', details: 'Invoice surface for sibling subsystems.', component: 'invoice-portal' }] };

/** N existing collaborator components for the god-component fan-out trees. */
const INTAKE_COLLABORATORS: FixtureSpecInput[] = [
  { id: 'eligibility-specialist', componentType: 'Specialist', description: 'Checks a patient\'s insurance eligibility.' },
  { id: 'triage-specialist', componentType: 'Specialist', description: 'Scores intake urgency for triage.' },
  { id: 'consent-specialist', componentType: 'Specialist', description: 'Verifies the required consent forms are on file.' },
  { id: 'copay-quote-specialist', componentType: 'Specialist', description: 'Quotes the expected copay for a visit.' },
  { id: 'sms-notify-adapter', componentType: 'Adapter', description: 'Wraps the SMS provider API for patient notifications.' },
  { id: 'email-notify-adapter', componentType: 'Adapter', description: 'Wraps the email provider API for patient notifications.' },
  { id: 'insurance-api-adapter', componentType: 'Adapter', description: 'Wraps the insurer eligibility API.' },
  { id: 'lab-orders-adapter', componentType: 'Adapter', description: 'Wraps the lab information system\'s ordering API.' },
  { id: 'pharmacy-feed-adapter', componentType: 'Adapter', description: 'Wraps the pharmacy formulary feed.' },
];

export default [
  // -------------------------------------------------------------------------
  // MUTUAL_SUBSYSTEM_DEPENDENCY
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MUTUAL_SUBSYSTEM_DEPENDENCY',
    severity: 'warning',
    expectFire: true,
    scenario:
      'Scheduling and billing depend on each other through their client adapters without either side declaring a trustedLink acknowledging the mutual coupling.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB, BILLING_SUB],
      components: MUTUAL_COMPONENTS,
    },
  }),
  defineRuleFixture({
    code: 'MUTUAL_SUBSYSTEM_DEPENDENCY',
    expectFire: false,
    reason: 'A trustedLinks declaration on EITHER side acknowledges the mutual pair (documented); scheduling declares one toward billing with the reason.',
    scenario:
      'Scheduling and billing depend on each other, and scheduling declares a trustedLink to billing sanctioning the invoicing fast lane.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          ...SCHEDULING_SUB,
          trustedLinks: [{ subsystem: 'billing', reason: 'Invoice drafting needs same-transaction booking reads; a bus round-trip breaks the checkout flow.' }],
        },
        BILLING_SUB,
      ],
      components: MUTUAL_COMPONENTS,
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_TRUSTED_LINK
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_TRUSTED_LINK',
    severity: 'error',
    anchoredTo: 'scheduling',
    expectFire: true,
    scenario:
      'The scheduling subsystem declares a trustedLink to the claims-adjudication subsystem, which was removed from the platform and no longer exists.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'scheduling',
          description: 'Appointment booking and slot management.',
          trustedLinks: [{ subsystem: 'claims-adjudication', reason: 'Legacy fast lane into the retired claims service.' }],
        },
        { id: 'billing', description: 'Invoicing and payment collection for booked visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_TRUSTED_LINK',
    expectFire: false,
    reason: 'The trusted link references billing, a subsystem that exists (and a real dependency crosses to it, so the link is also in use).',
    scenario:
      'The scheduling subsystem declares a trustedLink to the existing billing subsystem, which its client adapter actually reaches.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          ...SCHEDULING_SUB,
          trustedLinks: [{ subsystem: 'billing', reason: 'Invoicing fast lane for the monolith deployment.' }],
        },
        BILLING_SUB,
      ],
      components: MUTUAL_COMPONENTS,
    },
  }),

  // -------------------------------------------------------------------------
  // UNUSED_TRUSTED_LINK
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNUSED_TRUSTED_LINK',
    severity: 'warning',
    anchoredTo: 'scheduling',
    expectFire: true,
    scenario:
      'The scheduling subsystem keeps a trustedLink to billing although no component dependency crosses between the two subsystems anymore.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          id: 'scheduling',
          description: 'Appointment booking and slot management.',
          trustedLinks: [{ subsystem: 'billing', reason: 'Invoicing fast lane retained from the old monolith deployment.' }],
        },
        { id: 'billing', description: 'Invoicing and payment collection for booked visits.' },
      ],
      components: [
        {
          id: 'appointment-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'scheduling',
          description: 'Coordinates the appointment booking workflow end to end.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'UNUSED_TRUSTED_LINK',
    expectFire: false,
    reason: 'A real dependency (billing-client-adapter → invoice-portal) crosses between the linked subsystems, so the trusted link is in use.',
    scenario:
      'The scheduling subsystem\'s trustedLink to billing is exercised by its billing client adapter, which depends on billing\'s invoice portal.',
    tree: {
      system: SYSTEM,
      subsystems: [
        {
          ...SCHEDULING_SUB,
          trustedLinks: [{ subsystem: 'billing', reason: 'Invoicing fast lane for the monolith deployment.' }],
        },
        BILLING_SUB,
      ],
      components: MUTUAL_COMPONENTS,
    },
  }),

  // -------------------------------------------------------------------------
  // GOD_COMPONENT — default threshold (8) and the documented project knob
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    severity: 'warning',
    anchoredTo: 'visit-intake-orchestrator',
    expectFire: true,
    scenario:
      'The visit intake orchestrator fans out to nine collaborators, exceeding the default god-component threshold of eight dependencies.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'patient-intake',
          description: 'Coordinates the whole intake flow from eligibility to notifications.',
          dependsOn: INTAKE_COLLABORATORS.map(c => c.id),
        },
        ...INTAKE_COLLABORATORS.map(c => ({ ...c, subsystem: 'patient-intake' })),
      ],
    },
  }),
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    severity: 'warning',
    anchoredTo: 'visit-intake-orchestrator',
    expectFire: true,
    scenario:
      'With the project capping component dependencies at three, the visit intake orchestrator\'s four collaborators already exceed the god-component threshold.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 3 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'patient-intake',
          description: 'Coordinates the intake flow from eligibility to notifications.',
          dependsOn: INTAKE_COLLABORATORS.slice(0, 4).map(c => c.id),
        },
        ...INTAKE_COLLABORATORS.slice(0, 4).map(c => ({ ...c, subsystem: 'patient-intake' })),
      ],
    },
  }),
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    expectFire: false,
    reason: 'The fan-out (3) does not exceed the configured maxComponentDependencies threshold (3) — the rule fires only ABOVE the cap.',
    scenario:
      'The visit intake orchestrator coordinates exactly three collaborators, at but not over the project\'s configured dependency cap.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 3 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          subsystem: 'patient-intake',
          description: 'Coordinates the intake flow from eligibility to notifications.',
          dependsOn: INTAKE_COLLABORATORS.slice(0, 3).map(c => c.id),
        },
        ...INTAKE_COLLABORATORS.slice(0, 3).map(c => ({ ...c, subsystem: 'patient-intake' })),
      ],
    },
  }),
];
