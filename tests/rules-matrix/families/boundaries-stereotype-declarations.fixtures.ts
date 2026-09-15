/**
 * Stereotype declaration fixtures — the spec-scoped rules that judge one
 * component's own stereotype (src/core/rules/intrinsic/logic-declaration.ts and
 * retired-stereotypes.ts).
 *
 * Documented intents pinned here:
 *  - DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR (error): a dependencyClass is an
 *    Orchestrator property, because logic is an Orchestrator.
 *  - STEREOTYPE_RETIRED (error): a component typed Specialist or Gateway is an
 *    error until it is migrated — a Specialist is an Orchestrator with a
 *    dependencyClass (both messages are pinned), a Gateway is a Portal with the
 *    gateway variant.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const BILLING_SUB = { id: 'billing', description: 'Invoicing and copay collection for booked visits.' };
const PARTNER_SUB = { id: 'partner-integrations', description: 'Partner clinic and lab integrations.' };

export default [
  // -------------------------------------------------------------------------
  // DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR',
    severity: 'error',
    anchoredTo: 'copay-rate-index',
    expectFire: true,
    scenario:
      'The copay rate index declares dependencyClass read as if it were read logic, although only an Orchestrator carries a dependency class.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING_SUB],
      components: [
        {
          id: 'copay-rate-index',
          componentType: 'Index',
          dependencyClass: 'read',
          description: 'Read projection of the copay rates per insurance plan.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR',
    expectFire: false,
    reason: 'The dependencyClass sits on an Orchestrator, the one stereotype it belongs to.',
    scenario:
      'The copay quote projector, an Orchestrator, declares dependencyClass read and reads the copay rate index.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING_SUB],
      components: [
        {
          id: 'copay-quote-projector',
          componentType: 'Orchestrator',
          dependencyClass: 'read',
          description: 'Read logic quoting the expected copay for a visit from the rate index.',
          dependsOn: ['copay-rate-index'],
        },
        { id: 'copay-rate-index', componentType: 'Index', description: 'Read projection of the copay rates per insurance plan.' },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // STEREOTYPE_RETIRED — the Specialist and the Gateway message
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'STEREOTYPE_RETIRED',
    severity: 'error',
    anchoredTo: 'copay-quote-specialist',
    expectFire: true,
    scenario:
      'The copay quote specialist is still typed with the retired Specialist stereotype instead of being logic, an Orchestrator with a dependency class.',
    tree: {
      system: SYSTEM,
      subsystems: [BILLING_SUB],
      components: [
        { id: 'copay-quote-specialist', componentType: 'Specialist', description: 'Quotes the expected copay for a visit.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'STEREOTYPE_RETIRED',
    severity: 'error',
    anchoredTo: 'partner-booking-gateway',
    expectFire: true,
    scenario:
      'The partner booking gateway is still a retired Gateway pattern owning its portal, instead of that portal wearing the gateway variant.',
    tree: {
      system: SYSTEM,
      subsystems: [PARTNER_SUB],
      components: [
        {
          id: 'partner-booking-gateway',
          componentType: 'Gateway',
          description: 'Facade bundling the partner booking portal.',
          owns: ['partner-booking-portal'],
        },
        { id: 'partner-booking-portal', componentType: 'Portal', portalType: 'Custom', description: 'Inbound surface for partner clinic booking requests.' },
      ],
    },
  }),
  defineRuleFixture({
    code: 'STEREOTYPE_RETIRED',
    expectFire: false,
    reason: 'Both components wear live stereotypes: the copay logic is a pure Orchestrator, and the gateway is a Portal with the built-in gateway variant.',
    scenario:
      'The copay quote arbiter is a pure Orchestrator, and the partner booking gateway is a Portal wearing the gateway variant that dispatches to the partner booking orchestrator.',
    tree: {
      system: SYSTEM,
      subsystems: [PARTNER_SUB],
      components: [
        {
          id: 'copay-quote-arbiter',
          componentType: 'Orchestrator',
          dependencyClass: 'pure',
          description: 'Pure logic quoting the expected copay for a visit from the plan facts it is handed.',
        },
        {
          id: 'partner-booking-gateway',
          componentType: 'Portal',
          portalType: 'Custom',
          variant: 'gateway',
          description: 'Front door for partner clinic booking requests.',
          dependsOn: ['partner-booking-orchestrator'],
        },
        { id: 'partner-booking-orchestrator', componentType: 'Orchestrator', description: 'Drives partner-initiated booking flows.' },
      ],
    },
  }),
];
