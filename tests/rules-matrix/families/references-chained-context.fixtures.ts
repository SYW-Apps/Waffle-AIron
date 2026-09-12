/**
 * Chained-subproject resolution (the post-rule pass in src/core/validation.ts;
 * step-20 semantics in .wai/specs/implementations/spec_validator_impl.yaml).
 *
 * Documented intent:
 *  - When the VALIDATED ROOT is a chained subproject of a DISCOVERABLE, LOADABLE
 *    parent (the loader's findChainingParent walks UP the filesystem from the
 *    root looking for an ancestor project whose subsystem projectPath resolves
 *    to this exact root), references this root cannot resolve are judged
 *    THROUGH that parent: the top root is validated scoped to the mount chain
 *    and its findings are renamed into the child's own ids — so an edge the
 *    parent rejects is the same error from the child, and the raw cross-tree
 *    warning gives way to that verdict.
 *  - When the parent is discoverable but cannot be loaded, every reference keeps
 *    its raw verdict: a cross-tree form stays a CROSS_TREE_REF_UNRESOLVED warning
 *    that --ci does not waive, and a typo stays an error. Nothing is rewritten
 *    and no notice is prepended — a child that cannot be judged through its
 *    parent pins its family surfaces or fails its gate.
 *
 * The top-level and snapshot-covered boundaries of CROSS_TREE_REF_UNRESOLVED
 * are pinned in references-cross-tree.fixtures.ts.
 *
 * These fixtures need the VALIDATED ROOT itself to be a chained child of an
 * ANCESTOR project, which the plain harness layout cannot express (fixture
 * trees materialize at a fresh OS-temp root whose ancestors are bare temp
 * dirs). They use the harness's `validateFromSubdir` seam: the PARENT project
 * (with the `projectPath` mount subsystem) materializes at the temp root as
 * usual, the CHILD project is laid down under `tree.files`, and the validated
 * root is bound to the child directory. The fallback fire additionally
 * overrides the parent's own L0 through `tree.files`, so the parent is found but
 * cannot be loaded.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dumpSpec(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/**
 * The chained-child layout: the parent (materialized at the temp root) mounts
 * `packages/edge-telemetry` via projectPath and defines no telemetry-hub; the
 * child project — an edge-telemetry forwarder that depends on and calls
 * super::telemetry-hub — lives under tree.files; validateFromSubdir binds the
 * validated root to the child, so the loader's walk-up discovers the parent.
 */
const chainedChildTree = () => ({
  system: { name: 'FleetWorks', vision: 'Fleet coordination platform with chained edge-telemetry subprojects.' },
  subsystems: [
    {
      id: 'edge-telemetry',
      description: 'Chained edge-telemetry subproject mount.',
      projectPath: 'packages/edge-telemetry',
    },
  ],
  validateFromSubdir: 'packages/edge-telemetry',
  files: {
    'packages/edge-telemetry/.wai/project.yaml': dumpSpec({
      name: 'edge-telemetry-child',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {},
    }),
    'packages/edge-telemetry/.wai/specs/.index.yaml': dumpSpec({
      name: 'EdgeTelemetry',
      vision: 'Edge telemetry subproject forwarding enriched batches to the family hub.',
    }),
    'packages/edge-telemetry/.wai/specs/subsystems/edge-telemetry.yaml': dumpSpec({
      id: 'edge-telemetry',
      name: 'Edge Telemetry',
      description: 'Edge telemetry forwarding toward the family hub.',
      parentSystem: 'EdgeTelemetry',
    }),
    'packages/edge-telemetry/.wai/specs/components/telemetry-forwarder.yaml': dumpSpec({
      id: 'telemetry-forwarder',
      name: 'Telemetry Forwarder',
      description: 'Forwards enriched telemetry batches to the family telemetry hub.',
      subsystem: 'edge-telemetry',
      componentType: 'Orchestrator',
      dependsOn: ['super::telemetry-hub'],
      owns: [],
    }),
    'packages/edge-telemetry/.wai/specs/interfaces/itelemetry_forwarder.yaml': dumpSpec({
      id: 'itelemetry_forwarder',
      name: 'Telemetry Forwarder',
      description: 'The contract of the telemetry forwarder in the edge subproject.',
      component: 'telemetry-forwarder',
      methods: [
        {
          name: 'forwardBatch',
          description: 'Forward one enriched telemetry batch upstream.',
          signature: 'forwardBatch(): void',
          returns: 'void',
        },
      ],
    }),
    'packages/edge-telemetry/.wai/specs/implementations/telemetry_forwarder_impl.yaml': dumpSpec({
      id: 'telemetry_forwarder_impl',
      name: 'Telemetry Forwarder Impl',
      description: 'The telemetry forwarder realization in the edge subproject.',
      contract: 'itelemetry_forwarder',
      methods: [
        {
          name: 'forwardBatch',
          narrative: [
            {
              stepNumber: 1,
              type: 'call',
              description: 'Stream the enriched batch to the family telemetry hub.',
              targetComponent: 'super::telemetry-hub',
              targetMethod: 'streamTelemetry',
            },
          ],
        },
      ],
    }),
  },
});

/**
 * The same family, but the parent's own L0 no longer parses. The mount is still
 * discoverable (findChainingParent reads subsystem files), so the child is known
 * to be chained — yet there is no parent tree to resolve through.
 */
const unloadableParentTree = () => {
  const tree = chainedChildTree();
  return { ...tree, files: { ...tree.files, '.wai/specs/.index.yaml': 'name: FleetWorks\n' } };
};

export default [
  // -------------------------------------------------------------------------
  // Resolved THROUGH the parent — a loadable parent judges the child's edges
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'INVALID_DEPENDENCY_REFERENCE',
    severity: 'error',
    anchoredTo: 'telemetry-forwarder',
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject depends on super::telemetry-hub while its FleetWorks parent is on disk and defines no telemetry-hub, so the dependency is judged through the parent as an invalid reference, reported under the child id.',
    tree: chainedChildTree(),
  }),

  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    severity: 'error',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject calls streamTelemetry on super::telemetry-hub while its FleetWorks parent is on disk and defines no telemetry-hub, so the call target is judged through the parent as an invalid component reference, reported under the child id.',
    tree: chainedChildTree(),
  }),

  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    expectFire: false,
    reason:
      'With a loadable parent on disk the reference is judged through the parent, so the raw cross-tree warning gives way to the verdict of the parent (the invalid-reference errors above) instead of standing beside it.',
    scenario:
      'A chained edge-telemetry subproject whose FleetWorks parent loads calls super::telemetry-hub and is judged through the parent, leaving no raw cross-tree warning behind.',
    tree: chainedChildTree(),
  }),

  // -------------------------------------------------------------------------
  // No usable parent — the raw verdict stands
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'telemetry-forwarder',
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject depends on super::telemetry-hub with no vendored snapshot covering it, below a discoverable parent whose own spec tree cannot be loaded, so there is nothing to resolve through and the reference keeps its raw cross-tree warning instead of being rewritten into a waived one.',
    tree: unloadableParentTree(),
  }),
];
