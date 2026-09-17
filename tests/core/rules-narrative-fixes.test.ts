import { describe, it, expect } from 'vitest';
import * as yaml from 'js-yaml';
import { defineRuleFixture, runRuleFixture, type FixtureRun } from '../rules-matrix/harness.js';

// ---------------------------------------------------------------------------
// surface-reference-backing: a narrative target that resolves against a
// surface snapshot is a collaborator like a local one, so the calling component
// must declare it (UNDECLARED_DEPENDENCY_CALL). The loader qualifies a
// cross-tree dependsOn entry exactly as it qualifies the step's target, so the
// declared edge carries the same reference.
// ---------------------------------------------------------------------------

const FAMILY_SURFACE = yaml.dump(
  {
    projectName: 'FleetWorks',
    origin: 'generated',
    stateId: 'sha256:cafebabecafebabe',
    generatedAt: '2026-01-01T00:00:00.000Z',
    types: [],
    interfaces: [
      {
        id: 'itelemetry_hub',
        name: 'Telemetry Hub',
        component: 'telemetry-hub',
        audience: 'project',
        type: 'MessageBus',
        details: 'Family-wide telemetry ingestion surface.',
        methods: [{
          name: 'streamTelemetry',
          description: 'Ingest one telemetry batch from a family member.',
          signature: 'streamTelemetry(batchId: string): void',
          returns: 'void',
        }],
      },
      {
        id: 'irelay_gateway',
        name: 'Relay Gateway',
        component: 'relay-gateway',
        audience: 'project',
        type: 'Custom',
        details: 'Generic capability relay for the fleet family.',
        methods: [{
          name: 'handleCapability',
          description: 'Generic capability envelope dispatched by capability name.',
          signature: 'handleCapability(envelope: Json): Json',
          returns: 'Json',
        }],
        dispatch: [{ capability: 'telemetry.replay', component: 'telemetry-ingestor', method: 'replayBatch' }],
      },
    ],
  },
  { noRefs: true, lineWidth: 200 },
);

const HUB_CALL = {
  type: 'call',
  description: 'Stream the enriched batch to the family telemetry hub.',
  targetComponent: 'super::telemetry-hub',
  targetMethod: 'streamTelemetry',
};
const HUB_REGISTER = {
  type: 'register',
  description: 'Hand the hub stream to the flush timer.',
  targetComponent: 'super::telemetry-hub',
  targetMethod: 'streamTelemetry',
};
const RELAY_DISPATCH = {
  type: 'dispatch',
  description: 'Replay the missed batches through the family relay gateway.',
  targetComponent: 'super::relay-gateway',
  capability: 'telemetry.replay',
};

/** A telemetry client Adapter whose one narrative reaches the family surfaces. */
function clientRun(
  dependsOn: string[],
  steps: Record<string, unknown>[],
  files: Record<string, string> = { '.wai/surfaces/FleetWorks.yaml': FAMILY_SURFACE },
): FixtureRun {
  return runRuleFixture(defineRuleFixture({
    code: 'UNDECLARED_DEPENDENCY_CALL',
    expectFire: true,
    scenario: 'A telemetry client in a chained subproject reaches the family telemetry hub and relay gateway through their pinned surfaces.',
    tree: {
      subsystems: [{ id: 'route-telemetry', description: 'Telemetry forwarding for the fleet routing family.' }],
      components: [{
        id: 'telemetry-client',
        componentType: 'Adapter',
        subsystem: 'route-telemetry',
        description: 'Client for the family telemetry surfaces.',
        dependsOn,
      }],
      interfaces: [{
        id: 'itelemetry_client',
        component: 'telemetry-client',
        methods: [{ name: 'forwardBatch', description: 'Forward one enriched telemetry batch upstream.' }],
      }],
      implementations: [{
        id: 'telemetry_client_impl',
        contract: 'itelemetry_client',
        methods: [{ name: 'forwardBatch', narrative: steps.map((s, i) => ({ stepNumber: i + 1, ...s })) }],
      }],
      files,
    },
  }));
}

const undeclared = (run: FixtureRun) => run.issues.filter(i => i.code === 'UNDECLARED_DEPENDENCY_CALL');

describe('UNDECLARED_DEPENDENCY_CALL — surface-resolved cross-tree targets', () => {
  it.each([
    ['call', HUB_CALL, 'calls component "super::telemetry-hub" (step 1)'],
    ['register', HUB_REGISTER, 'registers callback component "super::telemetry-hub" (step 1)'],
    ['dispatch', RELAY_DISPATCH, 'dispatches through component "super::relay-gateway" (step 1)'],
  ])('reports a surface-resolved %s target the caller does not declare', (_kind, step, phrase) => {
    const run = clientRun([], [step]);
    const codes = run.issues.map(i => i.code);
    // The reference resolved against the pinned surface.
    expect(codes).not.toContain('CROSS_TREE_REF_UNRESOLVED');
    expect(codes).not.toContain('SURFACE_REF_NOT_EXPOSED');
    const found = undeclared(run);
    expect(found.map(i => [i.severity, i.specId])).toEqual([['error', 'telemetry_client_impl']]);
    expect(found[0].message).toContain(phrase);
    expect(found[0].surfaceResolved).toBe(true);
  });

  it('stays silent when the caller declares every cross-tree collaborator it reaches', () => {
    const run = clientRun(['super::telemetry-hub', 'super::relay-gateway'], [HUB_CALL, HUB_REGISTER, RELAY_DISPATCH]);
    expect(undeclared(run)).toEqual([]);
  });

  it('judges no dependency on a cross-tree target no surface covers, as for a local target that does not resolve', () => {
    const run = clientRun([], [HUB_CALL, RELAY_DISPATCH], {});
    expect(run.issues.map(i => i.code)).toContain('CROSS_TREE_REF_UNRESOLVED');
    expect(undeclared(run)).toEqual([]);
  });
});
