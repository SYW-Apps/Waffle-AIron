/**
 * Cross-tree reference resolution (src/core/rules/contracts.ts +
 * isExternalNamespaceRef/resolveSurfaceRef in src/core/rules/namespace.ts).
 *
 * Documented intents pinned here:
 *  - CROSS_TREE_REF_UNRESOLVED (warning): an unresolved narrative target that
 *    points OUTSIDE this loading root — an explicit relative form
 *    (`super::x` / `::x`) OR a qualified id whose leading namespace segment is
 *    not a subsystem in THIS tree — with NO surface snapshot covering it.
 *    Only the parent project can verify it, so it warns instead of raising the
 *    hard error a genuine local typo gets (a BARE unresolved id stays a typo:
 *    INVALID_TARGET_COMPONENT_REFERENCE, never this code). Both recognized
 *    cross-tree shapes get a fire fixture; both documented "this is NOT
 *    cross-tree" boundaries get a control.
 *  - SURFACE_REF_NOT_EXPOSED (error): the cross-tree reference DOES resolve
 *    against a vendored surface snapshot, but the snapshot does not expose the
 *    called method (call/register shape) or does not serve the dispatched
 *    capability (dispatch shape). A snapshot is the declared contract, so this
 *    stays a hard error. Both documented behaviors get a pair.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function surfaceYaml(snapshot: Record<string, unknown>): string {
  return yaml.dump(
    { origin: 'generated', stateId: 'sha256:cafebabecafebabe', generatedAt: TS, types: [], ...snapshot },
    { noRefs: true, lineWidth: 200 },
  );
}

/** The chained fleet-telemetry subproject each fixture varies. */
function telemetryTree(
  narrativeStep: Record<string, unknown>,
  files?: Record<string, string>,
  dependsOn: string[] = ['super::telemetry-hub'],
) {
  return {
    subsystems: [{ id: 'route-telemetry', description: 'Telemetry forwarding for the fleet routing family.' }],
    components: [
      {
        id: 'telemetry-forwarder',
        componentType: 'Orchestrator',
        subsystem: 'route-telemetry',
        description: 'Forwards enriched route telemetry to the family telemetry hub.',
        dependsOn,
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
            narrative: [narrativeStep],
          },
        ],
      },
    ],
    ...(files ? { files } : {}),
  };
}

export default [
  // -------------------------------------------------------------------------
  // CROSS_TREE_REF_UNRESOLVED — explicit relative form (super::)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'A chained telemetry subproject opened standalone calls super::telemetry-hub in the parent tree, and no vendored surface snapshot covers the reference.',
    tree: telemetryTree({
      stepNumber: 1,
      type: 'call',
      description: 'Stream the enriched batch to the family telemetry hub.',
      targetComponent: 'super::telemetry-hub',
      targetMethod: 'streamTelemetry',
    }),
  }),

  // -------------------------------------------------------------------------
  // CROSS_TREE_REF_UNRESOLVED — qualified foreign-namespace form
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    severity: 'warning',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'A telemetry narrative authored from the parent root calls fleet-core::route-planner, but fleet-core is not a subsystem of this standalone tree, so only the parent can verify the edge.',
    tree: telemetryTree({
      stepNumber: 1,
      type: 'call',
      description: 'Ask the family route planner to recompute the corridor for the batch.',
      targetComponent: 'fleet-core::route-planner',
      targetMethod: 'recomputeCorridor',
    }),
  }),

  // -------------------------------------------------------------------------
  // CROSS_TREE_REF_UNRESOLVED — control: a vendored snapshot covers the ref
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    expectFire: false,
    reason:
      'A vendored parent surface snapshot covers super::telemetry-hub, so the edge is validated against the DECLARED contract instead of being unresolvable.',
    scenario:
      'A chained telemetry subproject calls super::telemetry-hub and holds the parent surface snapshot that exposes the streamTelemetry method.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'call',
        description: 'Stream the enriched batch to the family telemetry hub.',
        targetComponent: 'super::telemetry-hub',
        targetMethod: 'streamTelemetry',
      },
      {
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
      },
    ),
  }),

  // -------------------------------------------------------------------------
  // CROSS_TREE_REF_UNRESOLVED — control: a bare unresolved id is a local typo
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'CROSS_TREE_REF_UNRESOLVED',
    expectFire: false,
    reason:
      'A bare unresolved id carries no namespace shape, so per the documented boundary it is a local typo (the hard INVALID_TARGET_COMPONENT_REFERENCE error), never the softer cross-tree warning.',
    scenario:
      'A telemetry narrative calls a misspelled bare telemetry-hub-svc component id, which must be reported as a local typo rather than a cross-tree reference.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'call',
        description: 'Stream the enriched batch to the family telemetry hub.',
        targetComponent: 'telemetry-hub-svc',
        targetMethod: 'streamTelemetry',
      },
      undefined,
      // No cross-tree edges anywhere in this tree: the dependency edge would
      // otherwise legitimately raise this code for the dependsOn reference.
      [],
    ),
  }),

  // -------------------------------------------------------------------------
  // SURFACE_REF_NOT_EXPOSED — method not exposed (call shape)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SURFACE_REF_NOT_EXPOSED',
    severity: 'error',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'The chained telemetry subproject calls purgeTelemetry on the family hub, but the vendored parent surface snapshot only exposes streamTelemetry on that entry.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'call',
        description: 'Purge the already-forwarded batches from the family hub.',
        targetComponent: 'super::telemetry-hub',
        // The defect: the snapshot does not expose this method.
        targetMethod: 'purgeTelemetry',
      },
      {
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
      },
    ),
  }),
  defineRuleFixture({
    code: 'SURFACE_REF_NOT_EXPOSED',
    expectFire: false,
    reason: 'The snapshot exposes the exact method the narrative calls, so the declared contract backs the edge.',
    scenario:
      'The chained telemetry subproject calls streamTelemetry, which the vendored parent surface snapshot exposes on the telemetry hub entry.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'call',
        description: 'Stream the enriched batch to the family telemetry hub.',
        targetComponent: 'super::telemetry-hub',
        targetMethod: 'streamTelemetry',
      },
      {
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
      },
    ),
  }),

  // -------------------------------------------------------------------------
  // SURFACE_REF_NOT_EXPOSED — capability not served (dispatch shape)
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'SURFACE_REF_NOT_EXPOSED',
    severity: 'error',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'The chained telemetry subproject dispatches the telemetry.replay capability through the family relay gateway, but the vendored snapshot only serves telemetry.ingest on that portal.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'dispatch',
        description: 'Replay the missed batches through the family relay gateway.',
        targetComponent: 'super::relay-gateway',
        // The defect: the snapshot dispatch table does not serve this capability.
        capability: 'telemetry.replay',
      },
      {
        '.wai/surfaces/FleetWorks.yaml': surfaceYaml({
          projectName: 'FleetWorks',
          interfaces: [
            {
              id: 'irelay_gateway',
              name: 'Relay Gateway',
              component: 'relay-gateway',
              audience: 'project',
              type: 'Custom',
              details: 'Generic capability relay for the fleet family.',
              methods: [
                {
                  name: 'handleCapability',
                  description: 'Generic capability envelope dispatched by capability name.',
                  signature: 'handleCapability(envelope: Json): Json',
                  returns: 'Json',
                },
              ],
              dispatch: [
                { capability: 'telemetry.ingest', component: 'telemetry-ingestor', method: 'ingestBatch' },
              ],
            },
          ],
        }),
      },
    ),
  }),
  defineRuleFixture({
    code: 'SURFACE_REF_NOT_EXPOSED',
    expectFire: false,
    reason: 'The snapshot dispatch table serves the exact capability the narrative dispatches.',
    scenario:
      'The chained telemetry subproject dispatches telemetry.replay through the family relay gateway, whose vendored snapshot serves that capability.',
    tree: telemetryTree(
      {
        stepNumber: 1,
        type: 'dispatch',
        description: 'Replay the missed batches through the family relay gateway.',
        targetComponent: 'super::relay-gateway',
        capability: 'telemetry.replay',
      },
      {
        '.wai/surfaces/FleetWorks.yaml': surfaceYaml({
          projectName: 'FleetWorks',
          interfaces: [
            {
              id: 'irelay_gateway',
              name: 'Relay Gateway',
              component: 'relay-gateway',
              audience: 'project',
              type: 'Custom',
              details: 'Generic capability relay for the fleet family.',
              methods: [
                {
                  name: 'handleCapability',
                  description: 'Generic capability envelope dispatched by capability name.',
                  signature: 'handleCapability(envelope: Json): Json',
                  returns: 'Json',
                },
              ],
              dispatch: [
                { capability: 'telemetry.ingest', component: 'telemetry-ingestor', method: 'ingestBatch' },
                { capability: 'telemetry.replay', component: 'telemetry-ingestor', method: 'replayBatch' },
              ],
            },
          ],
        }),
      },
    ),
  }),
];
