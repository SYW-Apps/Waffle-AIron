/**
 * Documentation-completeness + complexity-cap fixtures
 * (src/core/rules/heuristic/complexity-and-metadata.ts). All warnings; all config-gated, so each
 * tree opts in via rules.documentation / rules.complexity.
 *
 * Documented intents pinned here:
 *  - MISSING_DESCRIPTION: requireDescriptions demands non-empty descriptions.
 *  - DESCRIPTION_TOO_SHORT: minDescriptionLength floors description length.
 *  - EXCESSIVE_METHODS: maxInterfaceMethods caps methods per interface.
 *  - EXCESSIVE_METHOD_PARAMS: maxMethodParams caps params per method.
 *  - EXCESSIVE_DEPENDENCIES: maxComponentDependencies caps dependsOn size,
 *    except on a PURE FORWARDER (every narrated method a single hand-off),
 *    which the cap would otherwise punish for the size of the subsystem behind
 *    it. A component with NO narrated method is not exempt.
 *  - EXCESSIVE_SUBSYSTEM_COMPONENTS: maxSubsystemComponents caps direct
 *    components per subsystem.
 * Every cap fires only ABOVE the limit; controls sit exactly AT it.
 * EXCESSIVE_NARRATIVE_STEPS is NOT here: the step axis moved to the
 * narrative-complexity rule, and its fixtures moved with it (see
 * boundaries-narrative-complexity.fixtures.ts).
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management for the clinic and its satellite locations.' };

/** The intake checks: pure logic with no dependencies of their own. */
const INTAKE_CHECKS: FixtureSpecInput[] = [
  { id: 'eligibility-checker', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Checks a patient\'s insurance eligibility.' },
  { id: 'triage-scorer', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Scores intake urgency for triage.' },
  { id: 'consent-verifier', componentType: 'Orchestrator', dependencyClass: 'pure', description: 'Verifies the required consent forms are on file.' },
];

/**
 * The same three checks, paired with the method each one publishes — what the
 * intake counter's hand-offs call, for the pure-forwarder fixtures below.
 */
const COUNTER_CHECKS = [
  { id: 'eligibility-checker', method: 'check', description: 'Checks a patient\'s insurance eligibility.' },
  { id: 'triage-scorer', method: 'score', description: 'Scores intake urgency for triage.' },
  { id: 'consent-verifier', method: 'verify', description: 'Verifies the required consent forms are on file.' },
];

const checkInterfaces = COUNTER_CHECKS.map(c => ({
  id: `i${c.id.replace(/-/g, '_')}`,
  component: c.id,
  methods: [{ name: c.method, description: c.description }],
}));

/** A counter method that hands the command straight to the check that owns it. */
const handsOff = (c: typeof COUNTER_CHECKS[number]) => ({
  name: c.method,
  narrative: [
    {
      stepNumber: 1,
      description: `Hand the ${c.method} command to ${c.id} with the receptionist's credential unchanged.`,
      type: 'call',
      targetComponent: c.id,
      targetMethod: c.method,
    },
    { stepNumber: 2, description: `Return what ${c.id} answered.`, type: 'return', outcome: `${c.method} result` },
  ],
});

const COUNTER_COMPONENT = {
  id: 'intake-counter',
  componentType: 'Orchestrator',
  subsystem: 'patient-intake',
  description: 'The intake counter: hands each command a receptionist types to the check that owns it.',
  dependsOn: COUNTER_CHECKS.map(c => c.id),
};

const COUNTER_INTERFACE = {
  id: 'iintake_counter',
  component: 'intake-counter',
  methods: COUNTER_CHECKS.map(c => ({ name: c.method, description: `Hand the ${c.method} command to the check that owns it.` })),
};

export default [
  // -------------------------------------------------------------------------
  // MISSING_DESCRIPTION
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MISSING_DESCRIPTION',
    severity: 'warning',
    anchoredTo: 'appointment-orchestrator',
    expectFire: true,
    scenario:
      'With requireDescriptions enabled, the appointment orchestrator ships an empty description.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { documentation: { requireDescriptions: true } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: '' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'MISSING_DESCRIPTION',
    expectFire: false,
    reason: 'Every spec carries a non-empty description, which is all requireDescriptions demands.',
    scenario:
      'With requireDescriptions enabled, the appointment orchestrator states what it coordinates.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { documentation: { requireDescriptions: true } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // DESCRIPTION_TOO_SHORT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DESCRIPTION_TOO_SHORT',
    severity: 'warning',
    anchoredTo: 'appointment-orchestrator',
    expectFire: true,
    scenario:
      'With an 80-character description floor, the appointment orchestrator\'s two-word description falls far short.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management for the clinic and all of its satellite locations.' },
      ],
      rules: { documentation: { minDescriptionLength: 80 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Books visits.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DESCRIPTION_TOO_SHORT',
    expectFire: false,
    reason: 'Every description in the tree meets the configured 80-character minimum.',
    scenario:
      'With an 80-character description floor, the appointment orchestrator documents its workflow in full sentences.',
    tree: {
      system: SYSTEM,
      subsystems: [
        { id: 'scheduling', description: 'Appointment booking and slot management for the clinic and all of its satellite locations.' },
      ],
      rules: { documentation: { minDescriptionLength: 80 } },
      components: [
        {
          id: 'appointment-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates the appointment booking workflow end to end, from slot matching through confirmation notifications.',
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_METHODS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_METHODS',
    severity: 'warning',
    anchoredTo: 'ischeduling_api',
    expectFire: true,
    scenario:
      'With interfaces capped at two methods, the scheduling API contract declares three.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxInterfaceMethods: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [
            { name: 'bookVisit', description: 'Book a visit for a patient.' },
            { name: 'cancelVisit', description: 'Cancel a booked visit.' },
            { name: 'rescheduleVisit', description: 'Move a booked visit to a new slot.' },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_METHODS',
    expectFire: false,
    reason: 'The interface declares exactly the configured maximum (2) — the cap fires only above the limit.',
    scenario:
      'With interfaces capped at two methods, the scheduling API contract declares booking and cancellation only.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxInterfaceMethods: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [
            { name: 'bookVisit', description: 'Book a visit for a patient.' },
            { name: 'cancelVisit', description: 'Cancel a booked visit.' },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_METHOD_PARAMS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_METHOD_PARAMS',
    severity: 'warning',
    anchoredTo: 'ischeduling_api',
    expectFire: true,
    scenario:
      'With method parameters capped at two, bookVisit takes patient, slot, and clinician parameters.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxMethodParams: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [
            {
              name: 'bookVisit',
              description: 'Book a visit for a patient.',
              params: [
                { name: 'patientId', type: 'string' },
                { name: 'slotId', type: 'string' },
                { name: 'clinicianId', type: 'string' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_METHOD_PARAMS',
    expectFire: false,
    reason: 'The method declares exactly the configured maximum (2 params) — the cap fires only above the limit.',
    scenario:
      'With method parameters capped at two, bookVisit takes only the patient and the chosen slot.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxMethodParams: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [
            {
              name: 'bookVisit',
              description: 'Book a visit for a patient.',
              params: [
                { name: 'patientId', type: 'string' },
                { name: 'slotId', type: 'string' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_DEPENDENCIES
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    severity: 'warning',
    anchoredTo: 'visit-intake-orchestrator',
    expectFire: true,
    scenario:
      'With component dependencies capped at two, the visit intake orchestrator coordinates three intake checks.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates the intake flow from eligibility to consent.',
          dependsOn: INTAKE_CHECKS.map(s => s.id),
        },
        ...INTAKE_CHECKS.map(s => ({ ...s, subsystem: 'patient-intake' })),
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    expectFire: false,
    reason:
      'The counter is a pure forwarder: every narrated method is one hand-off and nothing else, so its three dependencies count how many intake checks the clinic publishes rather than how much the counter knows. Capping it would ask the counter to shrink because the subsystem behind it grew.',
    scenario:
      'With component dependencies capped at two, an intake counter hands each of its three commands straight to the check that owns it.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [COUNTER_COMPONENT, ...INTAKE_CHECKS.map(s => ({ ...s, subsystem: 'patient-intake' }))],
      interfaces: [COUNTER_INTERFACE, ...checkInterfaces],
      implementations: [
        { id: 'intake_counter_impl', contract: 'iintake_counter', methods: COUNTER_CHECKS.map(handsOff) },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    severity: 'warning',
    anchoredTo: 'intake-counter',
    expectFire: true,
    scenario:
      'The same three-check intake counter carries an implementation nobody has narrated yet, so nothing in the tree says its methods only hand off.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [COUNTER_COMPONENT, ...INTAKE_CHECKS.map(s => ({ ...s, subsystem: 'patient-intake' }))],
      interfaces: [COUNTER_INTERFACE, ...checkInterfaces],
      implementations: [
        {
          id: 'intake_counter_impl',
          contract: 'iintake_counter',
          methods: COUNTER_CHECKS.map(c => ({ name: c.method })),
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    severity: 'warning',
    anchoredTo: 'intake-counter',
    expectFire: true,
    scenario:
      'The intake counter stops forwarding and starts deciding: its eligibility method scores triage and verifies consent itself, branching on what eligibility answered.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [COUNTER_COMPONENT, ...INTAKE_CHECKS.map(s => ({ ...s, subsystem: 'patient-intake' }))],
      interfaces: [COUNTER_INTERFACE, ...checkInterfaces],
      implementations: [
        {
          id: 'intake_counter_impl',
          contract: 'iintake_counter',
          methods: [
            {
              name: 'check',
              narrative: [
                { stepNumber: 1, description: 'Ask eligibility-checker whether the insurance covers this visit.', type: 'call', targetComponent: 'eligibility-checker', targetMethod: 'check' },
                { stepNumber: 2, description: 'Is the patient covered?', type: 'branch', condition: 'eligibility came back covered', onTrueStep: 3, onFalseStep: 5 },
                { stepNumber: 3, description: 'Ask triage-scorer how urgent the visit is.', type: 'call', targetComponent: 'triage-scorer', targetMethod: 'score' },
                { stepNumber: 4, description: 'Ask consent-verifier whether the forms that urgency needs are on file.', type: 'call', targetComponent: 'consent-verifier', targetMethod: 'verify' },
                { stepNumber: 5, description: 'Answer the counter with the intake decision.', type: 'return', outcome: 'intake decided' },
              ],
            },
            ...COUNTER_CHECKS.filter(c => c.method !== 'check').map(handsOff),
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    expectFire: false,
    reason: 'The component declares exactly the configured maximum (2 dependencies) — the cap fires only above the limit.',
    scenario:
      'With component dependencies capped at two, the visit intake orchestrator coordinates the eligibility checker and the triage scorer.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates the intake flow from eligibility to consent.',
          dependsOn: INTAKE_CHECKS.slice(0, 2).map(s => s.id),
        },
        ...INTAKE_CHECKS.slice(0, 2).map(s => ({ ...s, subsystem: 'patient-intake' })),
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_SUBSYSTEM_COMPONENTS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_SUBSYSTEM_COMPONENTS',
    severity: 'warning',
    anchoredTo: 'patient-intake',
    expectFire: true,
    scenario:
      'With subsystems capped at two direct components, patient intake hosts three intake checks.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxSubsystemComponents: 2 } },
      components: INTAKE_CHECKS.map(s => ({ ...s, subsystem: 'patient-intake' })),
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_SUBSYSTEM_COMPONENTS',
    expectFire: false,
    reason: 'The subsystem hosts exactly the configured maximum (2 components) — the cap fires only above the limit.',
    scenario:
      'With subsystems capped at two direct components, patient intake hosts the eligibility checker and the triage scorer.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxSubsystemComponents: 2 } },
      components: INTAKE_CHECKS.slice(0, 2).map(s => ({ ...s, subsystem: 'patient-intake' })),
    },
  }),
];
