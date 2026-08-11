/**
 * Documentation-completeness + complexity-cap fixtures
 * (src/core/rules/complexity.ts). All warnings; all config-gated, so each
 * tree opts in via rules.documentation / rules.complexity.
 *
 * Documented intents pinned here:
 *  - MISSING_DESCRIPTION: requireDescriptions demands non-empty descriptions.
 *  - DESCRIPTION_TOO_SHORT: minDescriptionLength floors description length.
 *  - EXCESSIVE_METHODS: maxInterfaceMethods caps methods per interface.
 *  - EXCESSIVE_METHOD_PARAMS: maxMethodParams caps params per method.
 *  - EXCESSIVE_DEPENDENCIES: maxComponentDependencies caps dependsOn size.
 *  - EXCESSIVE_NARRATIVE_STEPS: maxNarrativeSteps caps steps per method.
 *  - EXCESSIVE_SUBSYSTEM_COMPONENTS: maxSubsystemComponents caps direct
 *    components per subsystem.
 * Every cap fires only ABOVE the limit; controls sit exactly AT it.
 */
import { defineRuleFixture, type FixtureSpecInput } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management for the clinic and its satellite locations.' };

const SPECIALISTS: FixtureSpecInput[] = [
  { id: 'eligibility-specialist', componentType: 'Specialist', description: 'Checks a patient\'s insurance eligibility.' },
  { id: 'triage-specialist', componentType: 'Specialist', description: 'Scores intake urgency for triage.' },
  { id: 'consent-specialist', componentType: 'Specialist', description: 'Verifies the required consent forms are on file.' },
];

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
      'With component dependencies capped at two, the visit intake orchestrator coordinates three specialists.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates the intake flow from eligibility to consent.',
          dependsOn: SPECIALISTS.map(s => s.id),
        },
        ...SPECIALISTS.map(s => ({ ...s, subsystem: 'patient-intake' })),
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_DEPENDENCIES',
    expectFire: false,
    reason: 'The component declares exactly the configured maximum (2 dependencies) — the cap fires only above the limit.',
    scenario:
      'With component dependencies capped at two, the visit intake orchestrator coordinates the eligibility and triage specialists.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxComponentDependencies: 2 } },
      components: [
        {
          id: 'visit-intake-orchestrator',
          componentType: 'Orchestrator',
          description: 'Coordinates the intake flow from eligibility to consent.',
          dependsOn: SPECIALISTS.slice(0, 2).map(s => s.id),
        },
        ...SPECIALISTS.slice(0, 2).map(s => ({ ...s, subsystem: 'patient-intake' })),
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // EXCESSIVE_NARRATIVE_STEPS
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    severity: 'warning',
    anchoredTo: 'booking_flow_impl',
    expectFire: true,
    scenario:
      'With narratives capped at two steps, the booking flow\'s bookVisit method spells out three.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxNarrativeSteps: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
      ],
      implementations: [
        {
          id: 'booking_flow_impl',
          contract: 'ischeduling_api',
          methods: [
            {
              name: 'bookVisit',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Match the request against open slots.' },
                { stepNumber: 2, type: 'local', description: 'Reserve the chosen slot for the patient.' },
                { stepNumber: 3, type: 'local', description: 'Queue the booking confirmation notification.' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_NARRATIVE_STEPS',
    expectFire: false,
    reason: 'The narrative has exactly the configured maximum (2 steps) — the cap fires only above the limit.',
    scenario:
      'With narratives capped at two steps, the booking flow\'s bookVisit method matches a slot and reserves it.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { complexity: { maxNarrativeSteps: 2 } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'bookVisit', description: 'Book a visit for a patient.' }],
        },
      ],
      implementations: [
        {
          id: 'booking_flow_impl',
          contract: 'ischeduling_api',
          methods: [
            {
              name: 'bookVisit',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Match the request against open slots.' },
                { stepNumber: 2, type: 'local', description: 'Reserve the chosen slot for the patient.' },
              ],
            },
          ],
        },
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
      'With subsystems capped at two direct components, patient intake hosts three specialists.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxSubsystemComponents: 2 } },
      components: SPECIALISTS.map(s => ({ ...s, subsystem: 'patient-intake' })),
    },
  }),
  defineRuleFixture({
    code: 'EXCESSIVE_SUBSYSTEM_COMPONENTS',
    expectFire: false,
    reason: 'The subsystem hosts exactly the configured maximum (2 components) — the cap fires only above the limit.',
    scenario:
      'With subsystems capped at two direct components, patient intake hosts the eligibility and triage specialists.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'patient-intake', description: 'Patient intake, eligibility, and consent handling.' }],
      rules: { complexity: { maxSubsystemComponents: 2 } },
      components: SPECIALISTS.slice(0, 2).map(s => ({ ...s, subsystem: 'patient-intake' })),
    },
  }),
];
