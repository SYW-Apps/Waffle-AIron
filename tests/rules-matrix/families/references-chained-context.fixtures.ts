/**
 * Chained-subproject reference honesty (the post-rule pass in
 * src/core/validation.ts; step-19 semantics in
 * .wai/specs/implementations/spec_validator_impl.yaml).
 *
 * Documented intent:
 *  - When the VALIDATED ROOT is a chained subproject of a DISCOVERABLE parent
 *    (the loader's findChainingParent walks UP the filesystem from the root
 *    looking for an ancestor project whose subsystem projectPath resolves to
 *    this exact root), each cross-tree reference NO vendored surface snapshot
 *    covers is REPLACED by one precise UNVERIFIED_EXTERNAL_REF warning
 *    (crossTreeContext, --ci waives it; the replaced finding's specId is
 *    preserved), and ONE CHAINED_SUBPROJECT_CONTEXT warning notice is
 *    PREPENDED (tree-level: NO specId anchor), counting the unverified refs.
 *  - Snapshot-COVERED references never enter this path: they validate at full
 *    strength (contract mismatches and boundary violations stay errors).
 *  - The pass is gated on discoverability: a top-level root — and the parent
 *    root itself, which is authoritative — keeps every raw verdict.
 *
 * VERIFIED PRODUCT BEHAVIOR (ad-hoc probe through validateSddTree, parent
 * project on disk above the bound child root): intent and behavior AGREE —
 *   CHAINED_SUBPROJECT_CONTEXT  → severity 'warning', specId ABSENT, crossTreeContext true, first in the list
 *   UNVERIFIED_EXTERNAL_REF     → severity 'warning', specId = the replaced finding's anchor, crossTreeContext true
 *   (with a covering snapshot both codes disappear and the same edge produced
 *   a full-strength CROSS_SUBSYSTEM_NON_ADAPTER error — exactly as documented)
 * So there is NO product finding here.
 *
 * The FIRE halves need the VALIDATED ROOT itself to be a chained child of an
 * ANCESTOR project, which the plain harness layout cannot express (fixture
 * trees materialize at a fresh OS-temp root whose ancestors are bare temp
 * dirs). They use the harness's `validateFromSubdir` seam: the PARENT project
 * (with the `projectPath` mount subsystem) materializes at the temp root as
 * usual, the CHILD project is laid down under `tree.files`, and the validated
 * root is bound to the child directory — so findChainingParent's walk-up
 * discovers the materialized parent. `anchoredTo: null` on the context-notice
 * fixture asserts the verified "NO specId anchor" (tree-level finding).
 *
 * Also pinned live below are the documented QUIET
 * boundaries of the pass, which are exactly its dangerous regression
 * directions (the honesty rewrite softening verdicts where the root is
 * authoritative would hide real defects):
 *  1. a TOP-LEVEL root keeps the raw cross-tree warning — no rewrite;
 *  2. a TOP-LEVEL root gets no context notice;
 *  3. a snapshot-covered reference is never rewritten (full-strength path);
 *  4. the PARENT root of a chained family is authoritative — no notice there.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dumpSpec(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

function surfaceYaml(snapshot: Record<string, unknown>): string {
  return yaml.dump(
    { origin: 'generated', stateId: 'sha256:feedc0defeedc0de', generatedAt: TS, types: [], ...snapshot },
    { noRefs: true, lineWidth: 200 },
  );
}

/** A top-level tree holding one uncovered cross-tree call (super:: form). */
const standaloneEdgeTree = (files?: Record<string, string>) => ({
  subsystems: [{ id: 'edge-telemetry', description: 'Edge telemetry forwarding toward the family hub.' }],
  components: [
    {
      id: 'telemetry-forwarder',
      componentType: 'Orchestrator',
      subsystem: 'edge-telemetry',
      description: 'Forwards enriched telemetry batches to the family telemetry hub.',
      dependsOn: ['super::telemetry-hub'],
    },
  ],
  interfaces: [
    {
      id: 'itelemetry_forwarder',
      component: 'telemetry-forwarder',
      methods: [{ name: 'forwardBatch', description: 'Forward one enriched telemetry batch upstream.' }],
    },
  ],
  implementations: [
    {
      id: 'telemetry_forwarder_impl',
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
    },
  ],
  ...(files ? { files } : {}),
});

/**
 * The chained-child layout for the FIRE fixtures: the parent (materialized at
 * the temp root) mounts `packages/edge-telemetry` via projectPath; the child
 * project — the standalone edge tree's content, as raw specs — lives under
 * tree.files; validateFromSubdir binds the validated root to the child, so the
 * loader's walk-up discovers the parent and the honesty pass runs.
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

export default [
  // -------------------------------------------------------------------------
  // UNVERIFIED_EXTERNAL_REF — fire: chained child below a discoverable parent
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNVERIFIED_EXTERNAL_REF',
    severity: 'warning',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject validated standalone below its discoverable parent calls super::telemetry-hub with no vendored snapshot covering it, so the unresolvable finding is replaced by one honest unverified-external-ref warning.',
    tree: chainedChildTree(),
  }),

  // -------------------------------------------------------------------------
  // CHAINED_SUBPROJECT_CONTEXT — fire: one prepended notice, NO specId anchor
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CHAINED_SUBPROJECT_CONTEXT',
    severity: 'warning',
    anchoredTo: null, // verified: the context notice is tree-level, no specId
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject validated standalone below its discoverable parent has unverifiable cross-tree references, so one chained-subproject context notice is prepended to the report.',
    tree: chainedChildTree(),
  }),

  // -------------------------------------------------------------------------
  // UNVERIFIED_EXTERNAL_REF — control: top-level root, rewrite gated OFF
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNVERIFIED_EXTERNAL_REF',
    expectFire: false,
    reason:
      'The honesty rewrite is gated on a DISCOVERABLE chaining parent above the validated root; a top-level root keeps the raw CROSS_TREE_REF_UNRESOLVED verdict, and rewriting it here would soften findings where this root is the authority.',
    scenario:
      'A top-level telemetry project with an uncovered super::telemetry-hub call keeps its raw cross-tree warning instead of the chained-subproject rewrite.',
    tree: standaloneEdgeTree(),
  }),

  // -------------------------------------------------------------------------
  // CHAINED_SUBPROJECT_CONTEXT — control: top-level root gets no notice
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CHAINED_SUBPROJECT_CONTEXT',
    expectFire: false,
    reason:
      'The context notice announces "this root is a chained subproject of the parent at <root>"; with no discoverable parent above the validated root there is nothing to announce.',
    scenario:
      'A top-level telemetry project with unresolved cross-tree references receives no chained-subproject context notice.',
    tree: standaloneEdgeTree(),
  }),

  // -------------------------------------------------------------------------
  // UNVERIFIED_EXTERNAL_REF — control: snapshot-covered refs never enter the path
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNVERIFIED_EXTERNAL_REF',
    expectFire: false,
    reason:
      'A cross-tree reference covered by a vendored surface snapshot validates at FULL strength against the declared contract — the documented intent says such references never enter the unverified-external-ref path at all.',
    scenario:
      'A telemetry project calls super::telemetry-hub and holds the parent surface snapshot exposing streamTelemetry, so the edge is verified against the declared contract.',
    tree: standaloneEdgeTree({
      '.wai/surfaces/FleetWorks.yaml': surfaceYaml({
        projectName: 'FleetWorks',
        interfaces: [
          {
            id: 'itelemetry_hub',
            name: 'Telemetry Hub',
            component: 'telemetry-hub',
            audience: 'project',
            type: 'MessageBus',
            details: 'Family-wide telemetry ingestion surface.',
            methods: [
              {
                name: 'streamTelemetry',
                description: 'Ingest one telemetry batch from a family member.',
                signature: 'streamTelemetry(batchId: string): void',
                returns: 'void',
              },
            ],
          },
        ],
      }),
    }),
  }),

  // -------------------------------------------------------------------------
  // CHAINED_SUBPROJECT_CONTEXT — control: the PARENT root is authoritative
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CHAINED_SUBPROJECT_CONTEXT',
    expectFire: false,
    reason:
      'Full cross-tree verification runs FROM the parent root: even with a chained child mounted and unresolved cross-tree suspects present, the parent root is not itself a chained subproject, so no context notice may soften its report.',
    scenario:
      'A fleet parent project that mounts a chained field-unit subproject and itself carries an unresolved partner-net cross-tree reference keeps its raw report without a chained-subproject notice.',
    tree: {
      system: { name: 'FleetWorks', vision: 'Fleet coordination platform with chained field-unit subprojects.' },
      subsystems: [
        { id: 'route-planning', description: 'Route planning across the managed fleet.' },
        {
          id: 'field-unit',
          description: 'Chained field-unit subproject mount.',
          projectPath: 'packages/field-unit',
        },
      ],
      components: [
        {
          id: 'route-planner',
          componentType: 'Orchestrator',
          subsystem: 'route-planning',
          description: 'Plans fleet routes and syncs corridors with the partner network.',
          dependsOn: ['partner-net::corridor-hub'],
        },
      ],
      interfaces: [
        {
          id: 'iroute_planner',
          component: 'route-planner',
          methods: [{ name: 'planRoutes', description: 'Plan the next dispatch window\'s routes.' }],
        },
      ],
      implementations: [
        {
          id: 'route_planner_impl',
          contract: 'iroute_planner',
          methods: [
            {
              name: 'planRoutes',
              narrative: [
                {
                  stepNumber: 1,
                  type: 'call',
                  // A genuine cross-tree suspect AT the parent root: partner-net
                  // is not a subsystem of this tree and no snapshot covers it.
                  description: 'Sync the planned corridors with the partner network hub.',
                  targetComponent: 'partner-net::corridor-hub',
                  targetMethod: 'syncCorridors',
                },
              ],
            },
          ],
        },
      ],
      files: {
        'packages/field-unit/.wai/specs/.index.yaml': dumpSpec({
          name: 'FieldUnit',
          vision: 'Field-unit subproject of the fleet platform.',
        }),
        'packages/field-unit/.wai/specs/subsystems/field-unit.yaml': dumpSpec({
          id: 'field-unit',
          name: 'Field Unit',
          description: 'On-vehicle field unit software.',
          parentSystem: 'FieldUnit',
        }),
      },
    },
  }),
];
