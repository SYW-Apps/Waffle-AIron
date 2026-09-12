/**
 * Namespace integrity (src/core/rules/namespace.ts).
 *
 * Documented intents pinned here:
 *  - RESERVED_ID_SEGMENT (error): no id segment may be the reserved namespace
 *    keyword "super" — stored references to such an id would be consumed as a
 *    namespace hop and resolve to a different spec.
 *  - NAMESPACE_SHADOWING (error): a subproject-local name must not shadow a
 *    root-level subsystem id — a bare reference to a shadowed name silently
 *    anchors to the ROOT subsystem, so the local spec becomes unaddressable.
 *  - ROUNDTRIP_SERIALIZATION (error): every loaded spec must re-serialize
 *    through the exact writer pipeline — validate must predict every refusal a
 *    later save or lock would raise. Only the CONTROL is expressible from disk
 *    (see the note at that fixture).
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dumpSpec(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** Minimal chained-child project files: an L0 index plus subsystem files. */
function childProject(
  base: string,
  systemName: string,
  subsystems: Record<string, unknown>[],
  extra?: Record<string, string>,
): Record<string, string> {
  const files: Record<string, string> = {
    [`${base}/.wai/specs/.index.yaml`]: dumpSpec({
      name: systemName,
      vision: `The ${systemName} subproject of this scenario's miniature system family.`,
    }),
  };
  for (const sub of subsystems) {
    files[`${base}/.wai/specs/subsystems/${String(sub.id).replace(/[^a-zA-Z0-9._-]+/g, '_')}.yaml`] = dumpSpec({
      name: String(sub.id),
      description: `The ${String(sub.id)} subsystem of the ${systemName} subproject.`,
      parentSystem: systemName,
      ...sub,
    });
  }
  return { ...files, ...(extra ?? {}) };
}

function surfaceYaml(snapshot: Record<string, unknown>): string {
  return yaml.dump(
    { origin: 'generated', stateId: 'sha256:0123456789abcdef', generatedAt: TS, types: [], ...snapshot },
    { noRefs: true, lineWidth: 200 },
  );
}

export default [
  // -------------------------------------------------------------------------
  // RESERVED_ID_SEGMENT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'RESERVED_ID_SEGMENT',
    severity: 'error',
    anchoredTo: 'super',
    expectFire: true,
    scenario:
      'An ops team abbreviates its batch run supervisor component to the id super, which the :: namespace grammar reserves as the parent hop keyword.',
    tree: {
      subsystems: [{ id: 'batch-runs', description: 'Nightly batch execution and babysitting.' }],
      components: [
        {
          // The defect: "super" is the reserved namespace keyword.
          id: 'super',
          componentType: 'Supervisor',
          subsystem: 'batch-runs',
          description: 'Supervises nightly batch runs and restarts failed steps.',
        },
      ],
    },
  }),
  defineRuleFixture({
    code: 'RESERVED_ID_SEGMENT',
    expectFire: false,
    reason: 'The supervisor carries a real domain name; no id segment collides with the reserved keyword.',
    scenario:
      'The nightly batch run supervisor is named batch-supervisor, avoiding the reserved namespace keyword.',
    tree: {
      subsystems: [{ id: 'batch-runs', description: 'Nightly batch execution and babysitting.' }],
      components: [
        {
          id: 'batch-supervisor',
          componentType: 'Supervisor',
          subsystem: 'batch-runs',
          description: 'Supervises nightly batch runs and restarts failed steps.',
        },
      ],
    },
  }),

  // -------------------------------------------------------------------------
  // NAMESPACE_SHADOWING
  // -------------------------------------------------------------------------
  // Regression for the qualifyId declaration/reference bug: the loader used to
  // root-anchor a bare child DECLARATION whose name collided with a root
  // subsystem id, silently merging it into the root id space so this tripwire
  // was structurally unreachable from disk. Declarations now always
  // mount-qualify (qualifyDeclaredId in src/core/specs.ts); only reference
  // sites keep the root-subsystem anchor.
  defineRuleFixture({
    code: 'NAMESPACE_SHADOWING',
    severity: 'error',
    expectFire: true,
    scenario:
      'The chained partner-billing subproject defines its own ledger subsystem while the root project already has a ledger subsystem, so bare ledger references inside the subproject silently anchor to the root.',
    tree: {
      system: { name: 'CommerceOS', vision: 'Order-to-cash commerce platform with chained partner billing.' },
      subsystems: [
        { id: 'ledger', description: 'The root double-entry ledger of record.' },
        {
          id: 'partner-billing',
          description: 'Chained partner billing subproject mount.',
          projectPath: 'packages/partner-billing',
        },
      ],
      files: childProject('packages/partner-billing', 'PartnerBilling', [
        { id: 'partner-billing', description: 'Partner billing workflows.' },
        // The defect: a subproject-local subsystem named like the ROOT ledger subsystem.
        { id: 'ledger', description: 'Partner-side billing ledger.' },
      ]),
    },
  }),
  defineRuleFixture({
    code: 'NAMESPACE_SHADOWING',
    expectFire: false,
    reason: 'The subproject-local subsystem carries a name no root subsystem uses, so every bare reference resolves unambiguously.',
    scenario:
      'The chained partner-billing subproject names its ledger partner-ledger, avoiding the root ledger subsystem name.',
    tree: {
      system: { name: 'CommerceOS', vision: 'Order-to-cash commerce platform with chained partner billing.' },
      subsystems: [
        { id: 'ledger', description: 'The root double-entry ledger of record.' },
        {
          id: 'partner-billing',
          description: 'Chained partner billing subproject mount.',
          projectPath: 'packages/partner-billing',
        },
      ],
      files: childProject('packages/partner-billing', 'PartnerBilling', [
        { id: 'partner-billing', description: 'Partner billing workflows.' },
        { id: 'partner-ledger', description: 'Partner-side billing ledger.' },
      ]),
    },
  }),

  // -------------------------------------------------------------------------
  // ROUNDTRIP_SERIALIZATION — control only.
  //
  // NO fire fixture is expressible through the real product path: the loader
  // parses spec files with the SAME strict zod schemas the writer refuses on,
  // and qualifyId/relativizeId are exact inverses, so any tree that LOADS also
  // re-serializes (that inverse property is precisely what this tripwire rule
  // guards). The historical refusal (a root-mounted external subsystem whose
  // qualified publicInterfaces/lifecycle members failed the writer schema on
  // lock) is pinned here as the control: the exact shape that once refused must
  // now round-trip quietly.
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'ROUNDTRIP_SERIALIZATION',
    expectFire: false,
    reason:
      'A root-mounted external subsystem with publicInterfaces and lifecycle entries is the historical lock-refusal shape; the writer pipeline must relativize its qualified members back to the child-local form without a refusal.',
    scenario:
      'A root-mounted external network-http subsystem publishes its portal and declares an init lifecycle entry, and every loaded spec re-serializes through the writer pipeline.',
    tree: {
      system: { name: 'MeshWorks', vision: 'Service mesh platform with chained protocol subprojects.' },
      subsystems: [
        {
          id: 'network-http',
          description: 'Chained HTTP protocol stack mount.',
          projectPath: 'services/network-http',
        },
      ],
      files: childProject(
        'services/network-http',
        'NetworkHttp',
        [
          {
            id: 'network-http',
            description: 'HTTP protocol stack of the mesh.',
            publicInterfaces: [
              { type: 'MessageBus', details: 'net.http capability provider surface.', component: 'http-portal' },
            ],
            lifecycle: [
              { phase: 'init', component: 'http-portal', method: 'provision', description: 'Bind listeners and announce the capability.' },
            ],
          },
        ],
        {
          'services/network-http/.wai/specs/components/http_portal.yaml': dumpSpec({
            id: 'http-portal',
            name: 'Http Portal',
            description: 'MessageBus portal serving the net.http capability.',
            subsystem: 'network-http',
            componentType: 'Portal',
            portalType: 'MessageBus',
            owns: [],
            dependsOn: [],
          }),
          'services/network-http/.wai/specs/interfaces/ihttp_portal.yaml': dumpSpec({
            id: 'ihttp_portal',
            name: 'Http Portal',
            description: 'Contract of the HTTP capability portal.',
            component: 'http-portal',
            methods: [
              {
                name: 'provision',
                description: 'Bind listeners and announce the net.http capability.',
                signature: 'provision(): void',
                returns: 'void',
              },
            ],
          }),
        },
      ),
    },
  }),
];
