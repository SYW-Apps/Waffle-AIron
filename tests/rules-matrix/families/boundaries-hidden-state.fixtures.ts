/**
 * HIDDEN_STATE fixtures (src/core/rules/hidden-state.ts) — the enforcement
 * half of the fields-vs-Store criterion, statically approximated.
 *
 * Documented intent: module-scope MUTABLE bindings (`let`/`var`) in a source
 * file mapped EXCLUSIVELY to logic-stereotype components (Orchestrator/
 * Supervisor/Actor/Specialist) are held state hiding outside a Store. The
 * check is deliberately conservative (documented):
 *  - exact analysis grade only;
 *  - files also mapped to a data/boundary component are exempt (N:1 collapse);
 *  - mutation of const-bound containers is invisible to the check.
 *
 * The fixtures materialize a real TypeScript source file via tree.files and
 * map it with sourcePath, so the finding is proven through the real
 * source-analysis pipeline.
 */
import { defineRuleFixture } from '../harness.js';

const SYSTEM = {
  name: 'MediBook',
  vision: 'Clinic appointment booking platform covering scheduling, patient records, and partner integrations.',
};

const SCHEDULING_SUB = { id: 'scheduling', description: 'Appointment booking and slot management.' };

const PLANNER_COMPONENT = {
  id: 'visit-planner-orchestrator',
  componentType: 'Orchestrator',
  subsystem: 'scheduling',
  description: 'Plans upcoming visits by matching requests against open slots.',
};

const PLANNER_INTERFACE = {
  id: 'ivisit_planner',
  component: 'visit-planner-orchestrator',
  methods: [{ name: 'planVisit', description: 'Plan the next visit for a patient.' }],
};

const PLANNER_IMPL = {
  id: 'visit_planner_impl',
  contract: 'ivisit_planner',
  sourcePath: 'src/scheduling/visit-planner.ts',
  methods: [
    {
      name: 'planVisit',
      narrative: [{ stepNumber: 1, type: 'local', description: 'Match the request against open slots and emit a visit plan.' }],
    },
  ],
};

export default [
  defineRuleFixture({
    code: 'HIDDEN_STATE',
    severity: 'warning',
    anchoredTo: 'visit_planner_impl',
    expectFire: true,
    scenario:
      'The visit planner orchestrator\'s source file keeps the last planned roster in a module-scope let binding, hiding held state inside a logic component instead of a Store.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [PLANNER_COMPONENT],
      interfaces: [PLANNER_INTERFACE],
      implementations: [PLANNER_IMPL],
      files: {
        'src/scheduling/visit-planner.ts': [
          '// Visit planner — matches booking requests against open clinician slots.',
          'let lastPlannedRoster: string[] = [];',
          '',
          'export function planVisit(patientId: string): void {',
          '  lastPlannedRoster = [...lastPlannedRoster, patientId];',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'HIDDEN_STATE',
    expectFire: false,
    reason:
      'The module holds only a const binding; mutation of const-bound containers is documented as beyond this check, and no let/var module state exists.',
    scenario:
      'The visit planner orchestrator\'s source file keeps its roster cache in a const-bound map, so no module-scope mutable binding exists to flag.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [PLANNER_COMPONENT],
      interfaces: [PLANNER_INTERFACE],
      implementations: [PLANNER_IMPL],
      files: {
        'src/scheduling/visit-planner.ts': [
          '// Visit planner — matches booking requests against open clinician slots.',
          'const plannedRosterCache: Map<string, string[]> = new Map();',
          '',
          'export function planVisit(patientId: string): void {',
          '  plannedRosterCache.set(patientId, []);',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
  defineRuleFixture({
    code: 'HIDDEN_STATE',
    expectFire: false,
    reason:
      'The shared file is ALSO mapped to a Store implementation, and files mapped to any data component are exempt (the documented N:1 collapse — the state is the Store\'s business).',
    scenario:
      'The visit planner file holds a module-scope let binding, but the same file also realizes the roster cache store, so the state belongs to the mapped Store.',
    tree: {
      system: SYSTEM,
      subsystems: [SCHEDULING_SUB],
      components: [
        PLANNER_COMPONENT,
        {
          id: 'roster-cache-store',
          componentType: 'Store',
          subsystem: 'scheduling',
          description: 'Holds the cached roster of planned visits.',
        },
      ],
      interfaces: [
        PLANNER_INTERFACE,
        {
          id: 'iroster_cache',
          component: 'roster-cache-store',
          methods: [{ name: 'rememberRoster', description: 'Remember the latest planned roster.' }],
        },
      ],
      implementations: [
        PLANNER_IMPL,
        {
          id: 'roster_cache_impl',
          contract: 'iroster_cache',
          sourcePath: 'src/scheduling/visit-planner.ts',
          methods: [
            {
              name: 'rememberRoster',
              narrative: [{ stepNumber: 1, type: 'local', description: 'Replace the cached roster with the newly planned one.' }],
            },
          ],
        },
      ],
      files: {
        'src/scheduling/visit-planner.ts': [
          '// Visit planner + its co-located roster cache store realization.',
          'let lastPlannedRoster: string[] = [];',
          '',
          'export function planVisit(patientId: string): void {',
          '  lastPlannedRoster = [...lastPlannedRoster, patientId];',
          '}',
          '',
          'export function rememberRoster(roster: string[]): void {',
          '  lastPlannedRoster = roster;',
          '}',
          '',
        ].join('\n'),
      },
    },
  }),
];
