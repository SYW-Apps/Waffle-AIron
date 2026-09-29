/**
 * A chained child judged by its OWN gate (stage 4 — validateProject in
 * src/core/validation.ts; resolveCrossProject in src/core/rules/index.ts).
 *
 * Documented intent:
 *  - The owner's gate judges a project from its own files alone. A chained
 *    child is never resolved through its parent: the same reference gets the
 *    same verdict whether the parent is on disk and loadable, on disk and
 *    broken, or absent (no-softening-by-location, location-independent).
 *  - A deprecated `super::` form names no alias of the child, so it has
 *    nothing to be judged against: EXTERNAL_CHECK_UNAVAILABLE (warning), never
 *    a pass and never the typo-grade INVALID_* error.
 *  - Written `alias::name` through a declared external the child has pinned,
 *    the reference resolves against the pin and nothing is unavailable.
 *
 * These fixtures bind the VALIDATED ROOT to the child with the harness's
 * `validateFromSubdir` seam: the parent (with its legacy `projectPath` mount)
 * materializes at the temp root, the child under `tree.files`.
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

/** The child declares the family's top as an external and holds its pin: the hub, written `fleet::telemetry-hub`. */
const pinnedChildTree = () => {
  const tree = chainedChildTree();
  const child = 'packages/edge-telemetry/.wai';
  const hubSnapshot = {
    projectName: 'FleetWorks', projectId: 'fleetworks', origin: 'generated', generatedAt: TS,
    interfaces: [{
      id: 'telemetry-hub', name: 'Telemetry Hub', component: 'telemetry-hub', audience: 'project', type: 'MessageBus', componentType: 'Portal',
      details: 'Family-wide telemetry ingestion surface.',
      methods: [{ name: 'streamTelemetry', description: 'Ingest one telemetry batch.', signature: 'streamTelemetry(): void', returns: 'void' }],
    }],
    types: [],
  };
  const files: Record<string, string> = {
    ...tree.files,
    [`${child}/project.yaml`]: dumpSpec({
      name: 'edge-telemetry-child',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {},
      externals: { fleet: { project: 'fleetworks' } },
    }),
    [`${child}/externals.lock.yaml`]: yaml.dump({ externals: { fleet: { project: 'fleetworks', snapshot: '.wai/externals/fleet.yaml', digest: 'sha256:pinned', used: {} } } }),
    [`${child}/externals/fleet.yaml`]: yaml.dump(hubSnapshot, { noRefs: true, lineWidth: 200 }),
  };
  for (const [file, text] of Object.entries(files)) {
    if (file.endsWith('telemetry-forwarder.yaml') || file.endsWith('telemetry_forwarder_impl.yaml')) {
      files[file] = text.split('super::telemetry-hub').join('fleet::telemetry-hub');
    }
  }
  return { ...tree, files };
};

export default [
  // -------------------------------------------------------------------------
  // The child's own gate: a deprecated form naming no alias is unavailable,
  // with the parent loadable or not — the same verdict either way.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXTERNAL_CHECK_UNAVAILABLE',
    severity: 'warning',
    anchoredTo: 'telemetry-forwarder',
    expectFire: true,
    scenario:
      'A chained edge-telemetry subproject depends on super::telemetry-hub while its loadable FleetWorks parent is on disk; its own gate never walks up, and the deprecated form names no alias, so there is nothing to judge the dependency against.',
    tree: chainedChildTree(),
  }),

  defineRuleFixture({
    code: 'EXTERNAL_CHECK_UNAVAILABLE',
    severity: 'warning',
    anchoredTo: 'telemetry_forwarder_impl',
    expectFire: true,
    scenario:
      'The same edge-telemetry subproject below a parent whose own spec tree cannot be loaded calls streamTelemetry on super::telemetry-hub — the same unavailable verdict as with a healthy parent, neither softened nor hardened by where it lies.',
    tree: unloadableParentTree(),
  }),

  defineRuleFixture({
    code: 'INVALID_TARGET_COMPONENT_REFERENCE',
    expectFire: false,
    reason:
      'A reference that leaves the project is judged once, by project-boundaries, with its resolution; it is never mistaken for a local typo.',
    scenario:
      'A chained edge-telemetry subproject calls streamTelemetry on super::telemetry-hub, a reference that leaves the project rather than a misspelled local component.',
    tree: chainedChildTree(),
  }),

  defineRuleFixture({
    code: 'EXTERNAL_CHECK_UNAVAILABLE',
    expectFire: false,
    reason:
      'The child declares the family top as an external and holds its pin, so `fleet::telemetry-hub` is judged against the pinned contract and resolves.',
    scenario:
      'The edge-telemetry subproject writes the hub as fleet::telemetry-hub through its declared, pinned external and calls streamTelemetry, which the pinned FleetWorks contract exposes.',
    tree: pinnedChildTree(),
  }),
];
