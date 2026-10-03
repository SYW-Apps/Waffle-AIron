/**
 * Rule family: parts and projects (stage 8).
 *
 * Codes covered:
 *  - member-declarations (src/core/rules/integrity/member-declarations.ts):
 *    MEMBER_KIND_MISMATCH — what a member's content makes it (an id, an L0 or
 *    a lock: a project; else a part) contradicts what is declared or written
 *    about it; PART_UNAVAILABLE — a part whose files could not be read, so the
 *    project's own subsystems are missing; DEPRECATED_MOUNT_FORM in its stage-8
 *    shape — a member declared with the long-form `path` key.
 *
 * PART_UNPINNED and PART_JUDGED_ALONE are the owner's gate's own findings at a
 * part opened alone (validateProject), not a rule's: no rule declares them, so
 * they are outside this matrix's universe (meta.test.ts refuses a fixture for a
 * code no rule can emit). Their fire and control cases live in
 * tests/core/stage8-parts.test.ts (property: part-alone-judges-against-pin).
 *
 * Every fixture is the same clinic: the bound root keeps its front desk (the
 * patient registry) in its own specs folder, and its scheduling subsystem
 * lives in a part — a folder under services/, or a checkout validated alone.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** The clinic's project.yaml, declaring the scheduling member as written. */
function clinicYaml(scheduling: unknown): string {
  return dump({
    id: 'clinic', name: 'Clinic',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    extensions: { packs: [], useGlobalPacks: false },
    members: { scheduling },
  });
}

/** The scheduling subsystem as stored in a part rooted at `base`: an appointment planner reaching the patient registry by local id. */
function schedulingFiles(base: string): Record<string, string> {
  return {
    [`${base}/.wai/specs/scheduling/.index.yaml`]: dump({
      id: 'scheduling', name: 'Scheduling', description: 'Books appointments for registered patients.', parentSystem: 'RuleMatrixSystem',
    }),
    [`${base}/.wai/specs/scheduling/appointment-planner/.index.yaml`]: dump({
      id: 'appointment-planner', name: 'Appointment Planner', description: 'Plans appointments for registered patients.',
      subsystem: 'scheduling', componentType: 'Orchestrator', owns: [], dependsOn: ['patient-registry'],
    }),
  };
}

/** The clinic with its scheduling part declared as written, the part's files present or not. */
function clinic(scheduling: unknown, partPresent = true): FixtureTree {
  return {
    subsystems: [{ id: 'frontdesk', description: 'Checks patients in at the front desk.' }],
    components: [{ id: 'patient-registry', subsystem: 'frontdesk', description: 'Keeps the registered patients.' }],
    files: {
      '.wai/project.yaml': clinicYaml(scheduling),
      ...(partPresent ? schedulingFiles('services/scheduling') : {}),
    },
  };
}

export default [
  // -------------------------------------------------------------------------
  // MEMBER_KIND_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'MEMBER_KIND_MISMATCH',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The clinic asserts `scheduling: { source: services/scheduling, as: project }`, but the scheduling folder holds only its subsystem — no id, no L0, no lock — so its content makes it a part.',
    tree: clinic({ source: 'services/scheduling', as: 'project' }),
  }),
  defineRuleFixture({
    code: 'MEMBER_KIND_MISMATCH',
    expectFire: false,
    reason: 'Nothing asserts what the member is: its content makes it a part, and the shorthand says only where it lives.',
    scenario: 'The clinic declares `scheduling: services/scheduling`, a folder holding only the scheduling subsystem.',
    tree: clinic('services/scheduling'),
  }),

  // -------------------------------------------------------------------------
  // PART_UNAVAILABLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PART_UNAVAILABLE',
    severity: 'error',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The clinic declares its scheduling part at services/scheduling, but nobody checked the folder out: the clinic\'s own scheduling subsystem is missing.',
    tree: clinic({ source: 'services/scheduling', as: 'part' }, false),
  }),
  defineRuleFixture({
    code: 'PART_UNAVAILABLE',
    expectFire: false,
    reason: 'The part\'s folder is there, so its subsystem is read into the clinic.',
    scenario: 'The clinic declares its scheduling part at services/scheduling, and the folder holds the scheduling subsystem.',
    tree: clinic({ source: 'services/scheduling', as: 'part' }),
  }),

  // -------------------------------------------------------------------------
  // DEPRECATED_MOUNT_FORM — the stage-8 long-form `path`
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DEPRECATED_MOUNT_FORM',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The clinic still declares `scheduling: { path: services/scheduling, description: ... }` — the pre-stage-8 long-form key that `source` replaced.',
    tree: clinic({ path: 'services/scheduling', description: 'Books appointments' }),
  }),
  defineRuleFixture({
    code: 'DEPRECATED_MOUNT_FORM',
    expectFire: false,
    reason: 'The long form names its location with the one key, `source`.',
    scenario: 'The clinic declares `scheduling: { source: services/scheduling, description: ... }`.',
    tree: clinic({ source: 'services/scheduling', description: 'Books appointments' }),
  }),

];
