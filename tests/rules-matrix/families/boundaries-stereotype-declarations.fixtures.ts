/**
 * Stereotype declaration fixtures — the spec-scoped rules that judge one
 * component's own stereotype (src/core/rules/intrinsic/logic-declaration.ts).
 *
 * Documented intents pinned here:
 *  - DEPENDENCY_CLASS_ON_NON_ORCHESTRATOR (error): a dependencyClass is an
 *    Orchestrator property, because logic is an Orchestrator.
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

];
