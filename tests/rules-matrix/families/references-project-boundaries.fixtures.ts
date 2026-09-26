/**
 * The project graph (stage 2b): every project is a crate of its own, reached
 * from another project only through its L0 exports and only as a dependency it
 * declared.
 *
 * Rules pinned here:
 *  - project-boundaries (src/core/rules/doctrine/project-boundaries.ts):
 *    EXTERNAL_UNDECLARED, EXTERNAL_NOT_EXPORTED, TRUSTED_LINK_CROSSES_PROJECT.
 *  - reference-forms (src/core/rules/integrity/reference-forms.ts):
 *    DEPRECATED_REFERENCE_FORM — a leading `::` only; `super::` is not reported.
 *  - external-declarations (src/core/rules/integrity/external-declarations.ts):
 *    EXTERNAL_UNRESOLVED.
 *  - export-tables (EXPORT_WIDENS_AUDIENCE): an L0 re-export of a member's
 *    export that declares a wider audience than the member exports it at.
 *  - project-identity, family half: PROJECT_ID_AMBIGUOUS when two projects of
 *    one family resolve to one id or a member has none, PROJECT_ID_DEFAULTED
 *    when a member declares none (naming its mount's subsystem id).
 *
 * Every fixture is the same FleetWorks family: the bound root mounts two
 * chained members, billing (packages/billing) and dispatch (packages/dispatch).
 * Dispatch's route planner depends on billing's invoice portal — a sibling
 * reference, which is exactly the edge the family rules judge. All three
 * notices never fail CI in stage 2.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** A project.yaml with the identity and externals a scenario sets. */
function projectYaml(identity: { id?: string; name: string }, externals?: Record<string, unknown>): string {
  return dump({
    ...(identity.id !== undefined ? { id: identity.id } : {}),
    name: identity.name,
    targets: [],
    extensions: { packs: [], useGlobalPacks: false },
    ...(externals ? { externals } : {}),
  });
}

interface FleetOptions {
  root?: { id?: string; name: string };
  rootExternals?: Record<string, unknown>;
  rootExports?: Record<string, unknown>[];
  trustedLinks?: { subsystem: string; reason: string }[];
  billing?: { id?: string; name: string };
  billingExports?: Record<string, unknown>[];
  dispatch?: { id?: string; name: string };
  dispatchExternals?: Record<string, unknown>;
  /** The route planner's dependency on billing's invoice portal, as written. */
  plannerDependsOn?: string;
}

/** The billing member: an invoice portal with one contract method. */
function billingFiles(o: FleetOptions): Record<string, string> {
  const base = 'packages/billing/.wai';
  return {
    [`${base}/project.yaml`]: projectYaml(o.billing ?? { id: 'billing', name: 'Billing Service' }),
    [`${base}/specs/.index.yaml`]: dump({
      name: 'BillingService',
      vision: 'Issues invoices for every delivered route and tracks what customers owe.',
      ...(o.billingExports ? { publicInterfaces: o.billingExports } : {}),
    }),
    [`${base}/specs/subsystems/billing.yaml`]: dump({
      id: 'billing', name: 'Billing', description: 'Invoicing for delivered routes.', parentSystem: 'BillingService',
      publicInterfaces: [{ component: 'invoice-portal', type: 'REST', details: 'Issue an invoice for a delivered route.' }],
    }),
    [`${base}/specs/components/invoice-portal.yaml`]: dump({
      id: 'invoice-portal', name: 'Invoice Portal', description: 'REST surface that issues invoices for delivered routes.',
      subsystem: 'billing', componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [],
    }),
    [`${base}/specs/interfaces/iinvoice-portal.yaml`]: dump({
      id: 'iinvoice-portal', name: 'Invoice Portal Interface', description: 'Issue invoices.', component: 'invoice-portal',
      methods: [{ name: 'issueInvoice', description: 'Issue the invoice of one delivered route.', signature: 'issueInvoice(routeId: string): string', returns: 'string', params: [{ name: 'routeId', type: 'string' }] }],
    }),
  };
}

/** The dispatch member: a route planner that depends on billing's invoice portal. */
function dispatchFiles(o: FleetOptions): Record<string, string> {
  const base = 'packages/dispatch/.wai';
  return {
    [`${base}/project.yaml`]: projectYaml(o.dispatch ?? { id: 'dispatch', name: 'Dispatch Service' }, o.dispatchExternals),
    [`${base}/specs/.index.yaml`]: dump({ name: 'DispatchService', vision: 'Plans delivery routes and bills each delivered one.' }),
    [`${base}/specs/subsystems/dispatch.yaml`]: dump({
      id: 'dispatch', name: 'Dispatch', description: 'Route planning for the delivery fleet.', parentSystem: 'DispatchService',
    }),
    [`${base}/specs/components/route-planner.yaml`]: dump({
      id: 'route-planner', name: 'Route Planner', description: 'Plans delivery routes and bills each one once delivered.',
      subsystem: 'dispatch', componentType: 'Orchestrator', owns: [],
      dependsOn: [o.plannerDependsOn ?? 'super::billing::invoice-portal'],
    }),
  };
}

/** The FleetWorks family: a root with an operations console, mounting billing and dispatch. */
function fleet(o: FleetOptions = {}): FixtureTree {
  return {
    system: {
      name: 'FleetWorks',
      vision: 'Delivery fleet platform: route planning, billing and an operations console over both.',
      ...(o.rootExports ? { publicInterfaces: o.rootExports } : {}),
    },
    subsystems: [
      { id: 'operations', description: 'The operations console dispatchers work in.', ...(o.trustedLinks ? { trustedLinks: o.trustedLinks } : {}) },
      { id: 'billing', description: 'Chained billing member.', projectPath: 'packages/billing' },
      { id: 'dispatch', description: 'Chained dispatch member.', projectPath: 'packages/dispatch' },
      { id: 'fleet-registry', description: 'The registry of vehicles and drivers.' },
    ],
    components: [
      { id: 'ops-console', subsystem: 'operations', componentType: 'Portal', portalType: 'HTTP_API', description: 'REST surface of the operations console.' },
    ],
    files: {
      '.wai/project.yaml': projectYaml(o.root ?? { id: 'fleetworks', name: 'FleetWorks' }, o.rootExternals),
      ...billingFiles(o),
      ...dispatchFiles(o),
    },
  };
}

/** Billing exports its invoice portal to the family, at audience project. */
const BILLING_EXPORTS = [{ from: 'billing', component: 'invoice-portal', as: 'invoicing', audience: 'project', type: 'REST' }];

export default [
  // -------------------------------------------------------------------------
  // EXTERNAL_UNDECLARED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXTERNAL_UNDECLARED',
    severity: 'notice',
    anchoredTo: 'dispatch::route-planner',
    expectFire: true,
    scenario: 'The dispatch member\'s route planner depends on billing\'s invoice portal, a sibling project, but dispatch\'s project.yaml declares no externals — the dependency on another project was never declared.',
    tree: fleet({ billingExports: BILLING_EXPORTS }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_UNDECLARED',
    expectFire: false,
    reason: 'Dispatch declares billing under `externals`, so the sibling reference is a declared dependency.',
    scenario: 'The dispatch member declares `externals: { billing: {} }` and its route planner depends on billing\'s exported invoice portal.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} } }),
  }),

  // -------------------------------------------------------------------------
  // EXTERNAL_NOT_EXPORTED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXTERNAL_NOT_EXPORTED',
    severity: 'notice',
    anchoredTo: 'dispatch::route-planner',
    expectFire: true,
    scenario: 'Dispatch declares billing as an external and its route planner depends on billing\'s invoice portal, but billing\'s L0 exports nothing — the portal is only L1-published inside billing, which another project may not reach.',
    tree: fleet({ dispatchExternals: { billing: {} } }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_NOT_EXPORTED',
    expectFire: false,
    reason: 'Billing\'s L0 exports the invoice portal at audience project, which covers every project of the family.',
    scenario: 'Billing re-exports its invoice portal from its L0 as "invoicing" at audience project, and dispatch depends on it through its declared external.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} } }),
  }),

  // -------------------------------------------------------------------------
  // TRUSTED_LINK_CROSSES_PROJECT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TRUSTED_LINK_CROSSES_PROJECT',
    severity: 'notice',
    anchoredTo: 'operations',
    expectFire: true,
    scenario: 'The root\'s operations subsystem declares a trusted link to billing, the subsystem that mounts the billing member project — a fast lane that would pierce a project boundary.',
    tree: fleet({ trustedLinks: [{ subsystem: 'billing', reason: 'console renders invoices inline' }] }),
  }),
  defineRuleFixture({
    code: 'TRUSTED_LINK_CROSSES_PROJECT',
    expectFire: false,
    reason: 'The fleet registry is a subsystem of the root project itself, so the trusted link stays inside one project.',
    scenario: 'The root\'s operations subsystem declares a trusted link to the fleet registry, another subsystem of the same project.',
    tree: fleet({ trustedLinks: [{ subsystem: 'fleet-registry', reason: 'console reads the vehicle list on every frame' }] }),
  }),

  // -------------------------------------------------------------------------
  // DEPRECATED_REFERENCE_FORM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DEPRECATED_REFERENCE_FORM',
    severity: 'notice',
    anchoredTo: 'dispatch::route-planner',
    expectFire: true,
    scenario: 'The dispatch member\'s route planner names billing\'s invoice portal as `::billing::invoice-portal` — a leading `::` that names the portal by its place in whichever checkout loads it.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, plannerDependsOn: '::billing::invoice-portal' }),
  }),
  defineRuleFixture({
    code: 'DEPRECATED_REFERENCE_FORM',
    expectFire: false,
    reason: '`super::` is not reported in stage 2: wairon\'s own writer emits it, and no alternative exists before stage 3\'s alias::name.',
    scenario: 'The dispatch member\'s route planner names billing\'s invoice portal as `super::billing::invoice-portal`.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} } }),
  }),

  // -------------------------------------------------------------------------
  // EXTERNAL_UNRESOLVED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXTERNAL_UNRESOLVED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The FleetWorks root declares `externals: { ledger: {} }`, but no project of the family answers to "ledger" and no source.path says where it lives — a misspelled or missing producer.',
    tree: fleet({ rootExternals: { ledger: {} } }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_UNRESOLVED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The dispatch member declares `externals: { acme.ledger: {} }` — a dotted producer id used as its own alias, which is not a reference name.',
    tree: fleet({ dispatchExternals: { 'acme.ledger': {} } }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_UNRESOLVED',
    expectFire: false,
    reason: 'Exactly one project of the family answers to "billing", so the declaration resolves.',
    scenario: 'The dispatch member declares `externals: { billing: {} }`, and the billing member declares `id: billing`.',
    tree: fleet({ dispatchExternals: { billing: {} } }),
  }),

  // -------------------------------------------------------------------------
  // EXPORT_WIDENS_AUDIENCE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXPORT_WIDENS_AUDIENCE',
    severity: 'error',
    anchoredTo: 'FleetWorks',
    expectFire: true,
    scenario: 'The FleetWorks root re-exports billing\'s "invoicing" at audience external, although billing exports it only to its family (audience project) — a re-export that widens reach.',
    tree: fleet({ billingExports: BILLING_EXPORTS, rootExports: [{ from: 'billing', component: 'invoicing', audience: 'external', type: 'REST' }] }),
  }),
  defineRuleFixture({
    code: 'EXPORT_WIDENS_AUDIENCE',
    expectFire: false,
    reason: 'The root re-exports "invoicing" at the audience billing exports it at, so reach is not widened.',
    scenario: 'The FleetWorks root re-exports billing\'s "invoicing" at audience project, the audience billing exports it at.',
    tree: fleet({ billingExports: BILLING_EXPORTS, rootExports: [{ from: 'billing', component: 'invoicing', audience: 'project', type: 'REST' }] }),
  }),

  // -------------------------------------------------------------------------
  // PROJECT_ID_AMBIGUOUS / PROJECT_ID_DEFAULTED — the family half
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'Both chained members of FleetWorks declare `id: fleet-service` — two projects of one family answer to one id, so every declaration keyed on it could mean either.',
    tree: fleet({ billing: { id: 'fleet-service', name: 'Billing Service' }, dispatch: { id: 'fleet-service', name: 'Dispatch Service' } }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    severity: 'warning',
    anchoredTo: 'billing',
    expectFire: true,
    scenario: 'The billing member is named only in Japanese ("請求") and declares no id, so no id can be derived for it and none is invented.',
    tree: fleet({ billing: { name: '請求' } }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    expectFire: false,
    reason: 'Every project of the family declares its own well-formed id.',
    scenario: 'FleetWorks declares `id: fleetworks`, billing `id: billing` and dispatch `id: dispatch`.',
    tree: fleet(),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    severity: 'notice',
    anchoredTo: 'billing',
    expectFire: true,
    scenario: 'The billing member declares no id, so it answers to "billing-service", its name slug — the finding names its mount\'s subsystem id "billing" as the id to declare.',
    tree: fleet({ billing: { name: 'Billing Service' } }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    expectFire: false,
    reason: 'The root and both members declare their ids, so nothing answers to a derived one.',
    scenario: 'FleetWorks, billing and dispatch each declare an explicit id in their project.yaml.',
    tree: fleet(),
  }),
];
