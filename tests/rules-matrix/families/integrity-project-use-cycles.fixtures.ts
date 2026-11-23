/**
 * Rule family: project use cycles (stage 8).
 *
 * Codes covered:
 *  - project-use-cycles (src/core/rules/integrity/project-use-cycles.ts):
 *    PROJECT_USE_CYCLE — the bound project uses a project that directly or
 *    through others uses it back (consumer to producer, from the family's
 *    references). Membership and containment are not a use.
 *
 * Every fixture is the same clinic: the bound root keeps its front desk (the
 * patient registry) and exports it; its scheduling member is a contained
 * PROJECT (an id, an L0) that declares the clinic as a path external — the
 * ordinary plugin shape. The fire case adds the clinic's own use of the
 * scheduling planner, so the two projects use each other.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

const BASE = 'services/scheduling';

/** The scheduling project: its own L0 exporting the planner, which uses the clinic's patient registry. */
function schedulingFiles(): Record<string, string> {
  return {
    [`${BASE}/.wai/project.yaml`]: dump({
      id: 'scheduling', name: 'Scheduling',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      extensions: { packs: [], useGlobalPacks: false },
      externals: { clinic: { source: { path: '../..' } } },
    }),
    [`${BASE}/.wai/specs/.index.yaml`]: dump({
      name: 'Scheduling', vision: 'Books appointments for the clinic\'s registered patients.',
      publicInterfaces: [{ from: 'booking', component: 'appointment-planner' }],
    }),
    [`${BASE}/.wai/specs/booking/.index.yaml`]: dump({
      id: 'booking', name: 'Booking', description: 'Books appointments for registered patients.', parentSystem: 'Scheduling',
      publicInterfaces: [{ component: 'appointment-planner', details: 'Plans appointments.' }],
    }),
    [`${BASE}/.wai/specs/booking/appointment-planner/.index.yaml`]: dump({
      id: 'appointment-planner', name: 'Appointment Planner', description: 'Plans appointments for registered patients.',
      subsystem: 'booking', componentType: 'Orchestrator', owns: [], dependsOn: ['clinic::patient-registry'],
    }),
  };
}

/** The clinic, exporting its patient registry, with the scheduling project contained; `usesScheduling` makes the clinic reach the planner back. */
function clinic(usesScheduling: boolean): FixtureTree {
  return {
    system: { name: 'Clinic', publicInterfaces: [{ from: 'frontdesk', component: 'patient-registry' }] },
    subsystems: [{ id: 'frontdesk', description: 'Checks patients in at the front desk.', publicInterfaces: [{ component: 'patient-registry', details: 'The registered patients.' }] }],
    components: [
      { id: 'patient-registry', subsystem: 'frontdesk', description: 'Keeps the registered patients.', ...(usesScheduling ? { dependsOn: ['scheduling::appointment-planner'] } : {}) },
    ],
    files: {
      '.wai/project.yaml': dump({
        id: 'clinic', name: 'Clinic',
        targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
        extensions: { packs: [], useGlobalPacks: false },
        members: { scheduling: BASE },
      }),
      ...schedulingFiles(),
    },
  };
}

export default [
  defineRuleFixture({
    code: 'PROJECT_USE_CYCLE',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The clinic uses the scheduling project\'s appointment planner while the planner uses the clinic\'s patient registry, so the two projects use each other.',
    tree: clinic(true),
  }),
  defineRuleFixture({
    code: 'PROJECT_USE_CYCLE',
    expectFire: false,
    reason: 'Only the scheduling project uses the clinic: containment is not a use, and the uses run one way.',
    scenario: 'The clinic contains the scheduling project, which uses the clinic\'s patient registry; the clinic uses nothing of scheduling (the ordinary plugin shape).',
    tree: clinic(false),
  }),
];
