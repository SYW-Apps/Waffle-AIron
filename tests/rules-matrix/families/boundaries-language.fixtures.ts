/**
 * Target-language hygiene fixtures
 * (src/core/rules/heuristic/narrative-language-constructs.ts). What a
 * contract may name is the neutral type grammar's, never a language's — the
 * foreign-builtin check (LANGUAGE_FOREIGN_BUILTIN) is retired.
 *
 * Documented intents pinned here (warnings, opt-in via targetLanguage):
 *  - LANGUAGE_FOREIGN_FLOW: narrative flow constructs the target language
 *    lacks are flagged. Two documented gaps exercised: try-regions in Rust
 *    (errors are values, Result + ?) and do-while in Python.
 */
import { defineRuleFixture } from '../harness.js';

const STAFFING_SUB = { id: 'staffing', description: 'Clinician roster management and export.' };

const ROSTER_COMPONENT = {
  id: 'roster-sync-orchestrator',
  componentType: 'Orchestrator',
  description: 'Synchronizes the clinician roster with the payroll system.',
};

export default [
  // -------------------------------------------------------------------------
  // LANGUAGE_FOREIGN_FLOW — try region in Rust
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LANGUAGE_FOREIGN_FLOW',
    severity: 'warning',
    anchoredTo: 'roster_export_impl',
    expectFire: true,
    scenario:
      'In a Rust-targeted system, the roster export narrative guards the transport with a try region although Rust models errors as values, not exceptions.',
    tree: {
      system: {
        name: 'MediBook',
        vision: 'Clinic appointment booking platform covering scheduling and staffing.',
        targetLanguage: 'rust',
      },
      subsystems: [STAFFING_SUB],
      components: [ROSTER_COMPONENT],
      interfaces: [
        {
          id: 'iroster_sync',
          component: 'roster-sync-orchestrator',
          methods: [{ name: 'exportRoster', description: 'Export the roster to the payroll sink.' }],
        },
      ],
      implementations: [
        {
          id: 'roster_export_impl',
          contract: 'iroster_sync',
          methods: [
            {
              name: 'exportRoster',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'try',
                  description: 'Guard the roster export against transport failures.',
                  endStep: 2,
                  catches: [{ error: 'any', step: 4 }],
                },
                { stepNumber: 2, type: 'local', description: 'Send the roster payload to the export sink.' },
                { stepNumber: 3, type: 'return', description: 'Report the successful export.', outcome: 'export succeeded' },
                { stepNumber: 4, type: 'local', description: 'Record the failed export for retry.' },
                { stepNumber: 5, type: 'return', description: 'Report the failed export.', outcome: 'export failed' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'LANGUAGE_FOREIGN_FLOW',
    expectFire: false,
    reason: 'The failure path is modeled as an explicit error branch — the documented Rust remodeling (Result as a value, no try region).',
    scenario:
      'In a Rust-targeted system, the roster export narrative checks the transport result with an explicit branch instead of a try region.',
    tree: {
      system: {
        name: 'MediBook',
        vision: 'Clinic appointment booking platform covering scheduling and staffing.',
        targetLanguage: 'rust',
      },
      subsystems: [STAFFING_SUB],
      components: [ROSTER_COMPONENT],
      interfaces: [
        {
          id: 'iroster_sync',
          component: 'roster-sync-orchestrator',
          methods: [{ name: 'exportRoster', description: 'Export the roster to the payroll sink.' }],
        },
      ],
      implementations: [
        {
          id: 'roster_export_impl',
          contract: 'iroster_sync',
          methods: [
            {
              name: 'exportRoster',
              narrative: [
                { stepNumber: 1, type: 'local', description: 'Send the roster payload to the export sink and capture the result.' },
                {
                  stepNumber: 2,
                  type: 'branch',
                  description: 'Check whether the export sink returned an error.',
                  condition: 'the export sink returned an error',
                  onTrueStep: 3,
                  onFalseStep: 5,
                },
                { stepNumber: 3, type: 'local', description: 'Record the failed export for retry.' },
                { stepNumber: 4, type: 'return', description: 'Report the failed export.', outcome: 'export failed' },
                { stepNumber: 5, type: 'return', description: 'Report the successful export.', outcome: 'export succeeded' },
              ],
            },
          ],
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // LANGUAGE_FOREIGN_FLOW — do-while loop in Python
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'LANGUAGE_FOREIGN_FLOW',
    severity: 'warning',
    anchoredTo: 'roster_page_impl',
    expectFire: true,
    scenario:
      'In a Python-targeted system, the roster paging narrative uses a do-while loop, a construct Python does not have.',
    tree: {
      system: {
        name: 'MediBook',
        vision: 'Clinic appointment booking platform covering scheduling and staffing.',
        targetLanguage: 'python',
      },
      subsystems: [STAFFING_SUB],
      components: [ROSTER_COMPONENT],
      interfaces: [
        {
          id: 'iroster_sync',
          component: 'roster-sync-orchestrator',
          methods: [{ name: 'pageRoster', description: 'Page through the roster feed.' }],
        },
      ],
      implementations: [
        {
          id: 'roster_page_impl',
          contract: 'iroster_sync',
          methods: [
            {
              name: 'pageRoster',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'loop',
                  loopKind: 'doWhile',
                  description: 'Page through the roster feed at least once.',
                  condition: 'more roster pages remain',
                  endStep: 2,
                },
                { stepNumber: 2, type: 'local', description: 'Fetch the next roster page and append its entries.' },
                { stepNumber: 3, type: 'return', description: 'Report the paged roster.', outcome: 'roster collected' },
              ],
            },
          ],
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'LANGUAGE_FOREIGN_FLOW',
    expectFire: false,
    reason: 'The loop is loopKind while — the documented Python-idiomatic preference over do-while.',
    scenario:
      'In a Python-targeted system, the roster paging narrative uses a plain while loop over the remaining pages.',
    tree: {
      system: {
        name: 'MediBook',
        vision: 'Clinic appointment booking platform covering scheduling and staffing.',
        targetLanguage: 'python',
      },
      subsystems: [STAFFING_SUB],
      components: [ROSTER_COMPONENT],
      interfaces: [
        {
          id: 'iroster_sync',
          component: 'roster-sync-orchestrator',
          methods: [{ name: 'pageRoster', description: 'Page through the roster feed.' }],
        },
      ],
      implementations: [
        {
          id: 'roster_page_impl',
          contract: 'iroster_sync',
          methods: [
            {
              name: 'pageRoster',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'loop',
                  loopKind: 'while',
                  description: 'Page through the roster feed while pages remain.',
                  condition: 'more roster pages remain',
                  endStep: 2,
                },
                { stepNumber: 2, type: 'local', description: 'Fetch the next roster page and append its entries.' },
                { stepNumber: 3, type: 'return', description: 'Report the paged roster.', outcome: 'roster collected' },
              ],
            },
          ],
        },
      ],
    },
  }),
];
