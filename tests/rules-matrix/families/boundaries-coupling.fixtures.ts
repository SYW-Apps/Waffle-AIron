/**
 * Coupling-health fixtures (src/core/rules/heuristic/coupling-health.ts).
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
 *    (the same knob EXCESSIVE_DEPENDENCIES reads — documented). A ROUTING
 *    TABLE is exempt: fan-out is coupling only where the component holds flow
 *    of its own with its collaborators, and a switchboard's count tracks how
 *    many areas it publishes rather than how much it knows. Every method that
 *    reaches a collaborator must be a single hand-off; one that reaches none
 *    (a portal serving its own static screen) is neutral. A component with NO
 *    narrated method is not exempt, because absence of narrative is not
 *    evidence of forwarding.
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
  { id: 'eligibility-checker', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Checks a patient\'s insurance eligibility.' },
  { id: 'triage-scorer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Scores intake urgency for triage.' },
  { id: 'consent-verifier', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Verifies the required consent forms are on file.' },
  { id: 'copay-quoter', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Quotes the expected copay for a visit.' },
  { id: 'sms-notify-adapter', componentType: 'Adapter', description: 'Wraps the SMS provider API for patient notifications.' },
  { id: 'email-notify-adapter', componentType: 'Adapter', description: 'Wraps the email provider API for patient notifications.' },
  { id: 'insurance-api-adapter', componentType: 'Adapter', description: 'Wraps the insurer eligibility API.' },
  { id: 'lab-orders-adapter', componentType: 'Adapter', description: 'Wraps the lab information system\'s ordering API.' },
  { id: 'pharmacy-feed-adapter', componentType: 'Adapter', description: 'Wraps the pharmacy formulary feed.' },
];

/**
 * The nine intake steps a clinic front desk hands its counter commands to —
 * each one owns a step of the visit, and each publishes exactly one method.
 */
const INTAKE_STEPS = [
  { id: 'eligibility-check', method: 'check', description: 'Decides whether the patient\'s insurance covers the visit.' },
  { id: 'triage-scoring', method: 'score', description: 'Scores intake urgency so the queue orders itself.' },
  { id: 'consent-capture', method: 'capture', description: 'Captures the consent forms the visit requires.' },
  { id: 'copay-quoting', method: 'quote', description: 'Quotes the copay the patient owes at the counter.' },
  { id: 'room-assignment', method: 'assign', description: 'Assigns an examination room to an admitted patient.' },
  { id: 'chart-opening', method: 'open', description: 'Opens the encounter chart the clinicians write into.' },
  { id: 'lab-ordering', method: 'order', description: 'Places the standing lab orders an intake protocol calls for.' },
  { id: 'patient-notification', method: 'notify', description: 'Tells the patient what happens next, and when.' },
  { id: 'visit-closing', method: 'close', description: 'Closes the encounter once the clinician signs off.' },
];

const intakeStepComponents = INTAKE_STEPS.map(s => ({
  id: s.id,
  componentType: 'Orchestrator',
  subsystem: 'patient-intake',
  description: s.description,
}));

const intakeStepInterfaces = INTAKE_STEPS.map(s => ({
  id: `i${s.id.replace(/-/g, '_')}`,
  component: s.id,
  methods: [{ name: s.method, description: s.description }],
}));

/** A desk method that hands the counter command straight to the step that owns it. */
const handsOff = (s: typeof INTAKE_STEPS[number]) => ({
  name: s.method,
  narrative: [
    {
      stepNumber: 1,
      description: `Hand the ${s.method} command to ${s.id} with the receptionist's credential unchanged.`,
      type: 'call',
      targetComponent: s.id,
      targetMethod: s.method,
    },
    { stepNumber: 2, description: `Return what ${s.id} answered.`, type: 'return', outcome: `${s.method} result` },
  ],
});

const DESK_COMPONENT = {
  id: 'visit-front-desk',
  componentType: 'Orchestrator',
  subsystem: 'patient-intake',
  description: 'The clinic counter: hands each command a receptionist types to the intake step that owns it.',
  dependsOn: INTAKE_STEPS.map(s => s.id),
};

const DESK_INTERFACE = {
  id: 'ivisit_front_desk',
  component: 'visit-front-desk',
  methods: INTAKE_STEPS.map(s => ({ name: s.method, description: `Hand the ${s.method} command to the step that owns it.` })),
};

const INTAKE_SUB = { id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' };

/** The check-in kiosk: a Portal reaching the same nine intake steps, which also serves its own screen. */
const KIOSK_COMPONENT = {
  id: 'checkin-kiosk-portal',
  componentType: 'Portal',
  portalType: 'HTTP_API',
  subsystem: 'patient-intake',
  description: 'The waiting-room check-in kiosk: hands each command a patient taps to the intake step that owns it.',
  dependsOn: INTAKE_STEPS.map(s => s.id),
};

const KIOSK_INTERFACE = {
  id: 'icheckin_kiosk_portal',
  component: 'checkin-kiosk-portal',
  methods: [
    ...INTAKE_STEPS.map(s => ({ name: s.method, description: `Hand the ${s.method} command to the step that owns it.` })),
    { name: 'serveKioskScreen', description: 'Serve the static check-in screen the kiosk displays.' },
  ],
};

/** A method that reaches NO collaborator: the kiosk serves its screen from its own file. */
const SERVES_KIOSK_SCREEN = {
  name: 'serveKioskScreen',
  narrative: [
    { stepNumber: 1, description: 'Answer with the check-in screen embedded in the kiosk portal\'s own module.', type: 'local' },
  ],
};

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
  // -------------------------------------------------------------------------
  // GOD_COMPONENT — the pure-forwarder exemption, and its two boundaries
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    expectFire: false,
    reason:
      'Every narrated method of the desk is a single hand-off, so it holds no responsibility of its own to split: the responsibility lives in the nine steps it forwards to. Its fan-out counts how many intake steps the clinic publishes, not how much the desk knows — the same judgement INCOHESIVE_METHODS already makes, and the reason splitting it would answer a question nobody asked.',
    scenario:
      'A clinic front desk hands each counter command straight to the intake step that owns it, reaching nine of them and doing nothing else in any method.',
    tree: {
      system: SYSTEM,
      subsystems: [INTAKE_SUB],
      components: [DESK_COMPONENT, ...intakeStepComponents],
      interfaces: [DESK_INTERFACE, ...intakeStepInterfaces],
      implementations: [
        { id: 'visit_front_desk_impl', contract: 'ivisit_front_desk', methods: INTAKE_STEPS.map(handsOff) },
      ],
    },
  }),
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    severity: 'warning',
    anchoredTo: 'visit-front-desk',
    expectFire: true,
    scenario:
      'The same nine-step front desk carries an implementation nobody has narrated yet, so nothing in the tree says its methods only hand off.',
    tree: {
      system: SYSTEM,
      subsystems: [INTAKE_SUB],
      components: [DESK_COMPONENT, ...intakeStepComponents],
      interfaces: [DESK_INTERFACE, ...intakeStepInterfaces],
      implementations: [
        {
          id: 'visit_front_desk_impl',
          contract: 'ivisit_front_desk',
          methods: INTAKE_STEPS.map(s => ({ name: s.method })),
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    severity: 'warning',
    anchoredTo: 'visit-front-desk',
    expectFire: true,
    scenario:
      'The front desk stops forwarding and starts deciding: its admission method drives eligibility, triage and room assignment itself, branching on what each answers.',
    tree: {
      system: SYSTEM,
      subsystems: [INTAKE_SUB],
      components: [DESK_COMPONENT, ...intakeStepComponents],
      interfaces: [DESK_INTERFACE, ...intakeStepInterfaces],
      implementations: [
        {
          id: 'visit_front_desk_impl',
          contract: 'ivisit_front_desk',
          methods: [
            {
              name: 'check',
              narrative: [
                { stepNumber: 1, description: 'Ask eligibility-check whether the insurance covers this visit.', type: 'call', targetComponent: 'eligibility-check', targetMethod: 'check' },
                { stepNumber: 2, description: 'Is the patient covered?', type: 'branch', condition: 'eligibility came back covered', onTrueStep: 3, onFalseStep: 5 },
                { stepNumber: 3, description: 'Ask triage-scoring how urgent the visit is.', type: 'call', targetComponent: 'triage-scoring', targetMethod: 'score' },
                { stepNumber: 4, description: 'Ask room-assignment for a room matching that urgency.', type: 'call', targetComponent: 'room-assignment', targetMethod: 'assign' },
                { stepNumber: 5, description: 'Answer the counter with the admission decision.', type: 'return', outcome: 'admission decided' },
              ],
            },
            ...INTAKE_STEPS.filter(s => s.method !== 'check').map(handsOff),
          ],
        },
      ],
    },
  }),
  // -------------------------------------------------------------------------
  // GOD_COMPONENT — a ROUTING TABLE: a method that reaches no collaborator is
  // neutral, one that reaches a collaborator with flow of its own is not
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    expectFire: false,
    reason:
      'Every method of the kiosk portal that reaches a collaborator is a single hand-off; the one that does not — serving the check-in screen from the portal\'s own file — touches none of the nine dependencies the count is about. The fan-out is still a routing table, so it is not reported.',
    scenario:
      'A clinic check-in kiosk portal hands each command straight to the intake step that owns it and also serves its own static check-in screen, reaching nine steps and holding no flow with any of them.',
    tree: {
      system: SYSTEM,
      subsystems: [INTAKE_SUB],
      components: [KIOSK_COMPONENT, ...intakeStepComponents],
      interfaces: [KIOSK_INTERFACE, ...intakeStepInterfaces],
      implementations: [
        {
          id: 'checkin_kiosk_portal_impl',
          contract: 'icheckin_kiosk_portal',
          methods: [...INTAKE_STEPS.map(handsOff), SERVES_KIOSK_SCREEN],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'GOD_COMPONENT',
    severity: 'warning',
    anchoredTo: 'checkin-kiosk-portal',
    expectFire: true,
    scenario:
      'The same check-in kiosk portal normalises the insurance member number itself before asking the eligibility step — flow of its own with a collaborator, so its nine-way fan-out is knowledge rather than routing.',
    tree: {
      system: SYSTEM,
      subsystems: [INTAKE_SUB],
      components: [KIOSK_COMPONENT, ...intakeStepComponents],
      interfaces: [KIOSK_INTERFACE, ...intakeStepInterfaces],
      implementations: [
        {
          id: 'checkin_kiosk_portal_impl',
          contract: 'icheckin_kiosk_portal',
          methods: [
            {
              name: 'check',
              narrative: [
                { stepNumber: 1, description: 'Strip the spaces and the insurer prefix from the member number the patient typed.', type: 'local' },
                { stepNumber: 2, description: 'Ask eligibility-check whether the insurance covers this visit.', type: 'call', targetComponent: 'eligibility-check', targetMethod: 'check' },
                { stepNumber: 3, description: 'Return what eligibility-check answered.', type: 'return', outcome: 'check result' },
              ],
            },
            ...INTAKE_STEPS.filter(s => s.method !== 'check').map(handsOff),
            SERVES_KIOSK_SCREEN,
          ],
        },
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
