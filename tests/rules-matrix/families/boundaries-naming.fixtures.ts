/**
 * Naming-convention fixtures (src/core/rules/naming.ts). Config-gated via
 * rules.naming.
 *
 * Documented intents pinned here:
 *  - NAMING_CONVENTION_VIOLATION (warning): names/IDs must match the
 *    configured casing style or regex.
 *  - STEREOTYPE_NAMING_VIOLATION (warning): per-stereotype prefix/suffix/
 *    regex rules — the suffix and prefix behaviors each get a pair.
 *  - INVALID_NAMING_PATTERN (error): a configured pattern that is neither a
 *    known casing style nor a valid regex — both the general and the
 *    stereotype config sites get a fire.
 *
 * Where names are checked alongside ids (checkNamedValue tests both), the
 * fixtures set explicit conforming `name` fields so only the deliberate
 * defect fires.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management.' };

export default [
  // -------------------------------------------------------------------------
  // NAMING_CONVENTION_VIOLATION — method casing
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'NAMING_CONVENTION_VIOLATION',
    severity: 'warning',
    anchoredTo: 'ischeduling_api',
    expectFire: true,
    scenario:
      'With methods configured camelCase, the scheduling API contract names its booking method Schedule_Visit.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { methods: 'camelCase' } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'Schedule_Visit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'NAMING_CONVENTION_VIOLATION',
    expectFire: false,
    reason: 'The method name (scheduleVisit) matches the configured camelCase convention.',
    scenario:
      'With methods configured camelCase, the scheduling API contract names its booking method scheduleVisit.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { methods: 'camelCase' } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'scheduleVisit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // STEREOTYPE_NAMING_VIOLATION — suffix behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'STEREOTYPE_NAMING_VIOLATION',
    severity: 'warning',
    anchoredTo: 'patient-records',
    expectFire: true,
    scenario:
      'With Store ids required to end in -store, the patient records store is named just patient-records.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { stereotypes: { Store: { suffix: '-store', match: 'id' } } } },
      components: [
        { id: 'patient-records', componentType: 'Store', description: 'Holds the patient master records.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'STEREOTYPE_NAMING_VIOLATION',
    expectFire: false,
    reason: 'The Store id carries the configured -store suffix.',
    scenario:
      'With Store ids required to end in -store, the patient record store is named patient-record-store.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { stereotypes: { Store: { suffix: '-store', match: 'id' } } } },
      components: [
        { id: 'patient-record-store', componentType: 'Store', description: 'Holds the patient master records.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // STEREOTYPE_NAMING_VIOLATION — prefix behavior
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'STEREOTYPE_NAMING_VIOLATION',
    severity: 'warning',
    anchoredTo: 'insurance-claims-adapter',
    expectFire: true,
    scenario:
      'With Adapter ids required to start with ext-, the insurance claims adapter lacks the prefix marking it as an external boundary.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      rules: { naming: { stereotypes: { Adapter: { prefix: 'ext-', match: 'id' } } } },
      components: [
        { id: 'insurance-claims-adapter', componentType: 'Adapter', description: 'Wraps the insurer claim submission API.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'STEREOTYPE_NAMING_VIOLATION',
    expectFire: false,
    reason: 'The Adapter id carries the configured ext- prefix.',
    scenario:
      'With Adapter ids required to start with ext-, the insurance claims adapter is named ext-insurance-claims-adapter.',
    tree: {
      system: SYSTEM,
      subsystems: [{ id: 'claims', description: 'Insurance claim intake and adjudication.' }],
      rules: { naming: { stereotypes: { Adapter: { prefix: 'ext-', match: 'id' } } } },
      components: [
        { id: 'ext-insurance-claims-adapter', componentType: 'Adapter', description: 'Wraps the insurer claim submission API.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_NAMING_PATTERN — general config site
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_NAMING_PATTERN',
    severity: 'error',
    anchoredTo: 'ischeduling_api',
    expectFire: true,
    scenario:
      'The project configures the methods naming pattern as an unclosed regular expression that is also no known casing style.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { methods: '([unclosed' } },
      components: [
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'scheduleVisit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // INVALID_NAMING_PATTERN — stereotype regex config site
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_NAMING_PATTERN',
    severity: 'error',
    anchoredTo: 'patient-record-store',
    expectFire: true,
    scenario:
      'The Store stereotype naming rule carries an unclosed regular expression, so no Store name can ever be checked against it.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { stereotypes: { Store: { regex: '([broken', match: 'id' } } } },
      components: [
        { id: 'patient-record-store', componentType: 'Store', description: 'Holds the patient master records.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'INVALID_NAMING_PATTERN',
    expectFire: false,
    reason: 'Both configured patterns are valid: methods uses a known casing style and the Store stereotype rule a well-formed regex.',
    scenario:
      'The project configures camelCase methods and a valid Store id regex, so every naming pattern compiles.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      rules: { naming: { methods: 'camelCase', stereotypes: { Store: { regex: '^[a-z0-9-]+-store$', match: 'id' } } } },
      components: [
        { id: 'patient-record-store', componentType: 'Store', description: 'Holds the patient master records.' },
        { id: 'appointment-orchestrator', componentType: 'Orchestrator', description: 'Coordinates the appointment booking workflow end to end.' },
      ],
      interfaces: [
        {
          id: 'ischeduling_api',
          component: 'appointment-orchestrator',
          methods: [{ name: 'scheduleVisit', description: 'Book a visit for a patient.' }],
        },
      ],
    },
  }),
];
