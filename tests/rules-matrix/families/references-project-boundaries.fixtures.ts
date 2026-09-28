/**
 * The project graph (stage 2b): every project is a crate of its own, reached
 * from another project only through its L0 exports and only as a dependency it
 * declared.
 *
 * Rules pinned here:
 *  - project-boundaries (src/core/rules/doctrine/project-boundaries.ts):
 *    EXTERNAL_UNDECLARED, EXTERNAL_NOT_EXPORTED, TRUSTED_LINK_CROSSES_PROJECT.
 *  - reference-forms (src/core/rules/integrity/reference-forms.ts):
 *    DEPRECATED_REFERENCE_FORM — a leading `::`, `super::` or a member path
 *    (stage 3); `alias::name` is the one canonical form.
 *  - member-declarations (src/core/rules/integrity/member-declarations.ts):
 *    DEPRECATED_MOUNT_FORM — a member declared as an L1 subsystem carrying
 *    projectPath instead of a project.yaml `members` entry.
 *  - external-declarations (src/core/rules/integrity/external-declarations.ts):
 *    EXTERNAL_UNRESOLVED.
 *  - export-tables (EXPORT_WIDENS_AUDIENCE): an L0 re-export of a member's
 *    export that declares a wider audience than the member exports it at.
 *  - project-identity: the bound project's own id — PROJECT_ID_AMBIGUOUS when
 *    it has none, PROJECT_ID_DEFAULTED when it declares none. The family half
 *    (a member's id, two members resolving to one id) and the dependency
 *    loop are family checks since stage 4, never the owner's gate.
 *
 * Stage 4: the owner's gate judges a project's own references only — a
 * member's references are its own gate's, so a fixture about dispatch's
 * references binds the validated root to dispatch (`validateFromSubdir`),
 * where billing is a sibling outside the scan, judged against dispatch's pin.
 *
 * A member is keyed by its project id (stage 3): billing's portal is
 * `billing::invoice-portal` because billing declares `id: billing`, and a
 * member that declares none is keyed by its name slug.
 *
 * Every fixture is the same FleetWorks family: the bound root mounts two
 * chained members, billing (packages/billing) and dispatch (packages/dispatch).
 * Dispatch's route planner depends on billing's invoice portal — a sibling
 * reference, which is exactly the edge the family rules judge.
 */
import * as yaml from 'js-yaml';
import { defineRuleFixture, type FixtureTree } from '../harness.js';

const TS = '2026-01-01T00:00:00.000Z';

function dump(spec: Record<string, unknown>): string {
  return yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });
}

/** A project.yaml with the identity, externals and members a scenario sets. */
function projectYaml(identity: { id?: string; name: string }, externals?: Record<string, unknown>, members?: Record<string, unknown>): string {
  return dump({
    ...(identity.id !== undefined ? { id: identity.id } : {}),
    name: identity.name,
    targets: [],
    extensions: { packs: [], useGlobalPacks: false },
    ...(externals ? { externals } : {}),
    ...(members ? { members } : {}),
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
  /** Declare both members in the root's project.yaml `members` instead of legacy L1 mounts. */
  membersForm?: boolean;
  /** Billing's externals, and what its invoice portal depends on. */
  billingExternals?: Record<string, unknown>;
  invoiceDependsOn?: string[];
  /** What the root's operations console depends on (a reference into a member). */
  consoleDependsOn?: string[];
  /** Validate from dispatch's own root instead of the family root. */
  fromDispatch?: boolean;
  /** Give dispatch a pin of billing exporting "invoicing". */
  dispatchPin?: boolean;
}

/** The billing member: an invoice portal with one contract method. */
function billingFiles(o: FleetOptions): Record<string, string> {
  const base = 'packages/billing/.wai';
  return {
    [`${base}/project.yaml`]: projectYaml(o.billing ?? { id: 'billing', name: 'Billing Service' }, o.billingExternals),
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
      subsystem: 'billing', componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: o.invoiceDependsOn ?? [],
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
    ...(o.dispatchPin ? {
      [`${base}/externals.lock.yaml`]: yaml.dump({ externals: { billing: { project: 'billing', snapshot: '.wai/externals/billing.yaml', digest: 'sha256:pinned', used: {} } } }),
      [`${base}/externals/billing.yaml`]: yaml.dump({
        projectName: 'BillingService', projectId: 'billing', origin: 'generated', generatedAt: TS, types: [],
        interfaces: [{
          id: 'invoicing', name: 'Invoice Portal', component: 'invoice-portal', audience: 'project', type: 'REST', componentType: 'Portal', details: 'Issue invoices.',
          methods: [{ name: 'issueInvoice', description: 'Issue the invoice of one delivered route.', signature: 'issueInvoice(routeId: string): string', returns: 'string' }],
        }],
      }, { noRefs: true, lineWidth: 200 }),
    } : {}),
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
      ...(o.membersForm ? [] : [
        { id: 'billing', description: 'Chained billing member.', projectPath: 'packages/billing' },
        { id: 'dispatch', description: 'Chained dispatch member.', projectPath: 'packages/dispatch' },
      ]),
      { id: 'fleet-registry', description: 'The registry of vehicles and drivers.' },
    ],
    components: [
      {
        id: 'ops-console', subsystem: 'operations', componentType: 'Portal', portalType: 'HTTP_API', description: 'REST surface of the operations console.',
        ...(o.consoleDependsOn ? { dependsOn: o.consoleDependsOn } : {}),
      },
    ],
    ...(o.fromDispatch ? { validateFromSubdir: 'packages/dispatch' } : {}),
    files: {
      '.wai/project.yaml': projectYaml(
        o.root ?? { id: 'fleetworks', name: 'FleetWorks' },
        o.rootExternals,
        o.membersForm ? { billing: 'packages/billing', dispatch: 'packages/dispatch' } : undefined,
      ),
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
    severity: 'error',
    anchoredTo: 'route-planner',
    expectFire: true,
    scenario: 'Judged by its own gate, the dispatch member\'s route planner depends on `billing::invoicing`, but dispatch\'s project.yaml declares no alias `billing` — the dependency on another project was never declared.',
    tree: fleet({ billingExports: BILLING_EXPORTS, plannerDependsOn: 'billing::invoicing', fromDispatch: true }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_UNDECLARED',
    expectFire: false,
    reason: 'Dispatch declares billing under `externals`, so the sibling reference is a declared dependency (judged against its pin).',
    scenario: 'The dispatch member declares `externals: { billing: {} }`, pins it, and its route planner depends on billing\'s exported invoicing portal.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, plannerDependsOn: 'billing::invoicing', fromDispatch: true, dispatchPin: true }),
  }),

  // -------------------------------------------------------------------------
  // EXTERNAL_NOT_EXPORTED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'EXTERNAL_NOT_EXPORTED',
    severity: 'error',
    anchoredTo: 'ops-console',
    expectFire: true,
    scenario: 'The FleetWorks operations console depends on `billing::invoice-portal`, but its billing member\'s L0 exports nothing — the portal is only L1-published inside billing, which another project may not reach.',
    tree: fleet({ consoleDependsOn: ['billing::invoice-portal'] }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_NOT_EXPORTED',
    severity: 'error',
    anchoredTo: 'route-planner',
    expectFire: true,
    scenario: 'Judged by its own gate against its pin of billing, the dispatch route planner depends on `billing::invoice-portal`, a name the pinned billing contract does not export.',
    tree: fleet({ dispatchExternals: { billing: {} }, plannerDependsOn: 'billing::invoice-portal', fromDispatch: true, dispatchPin: true }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_NOT_EXPORTED',
    expectFire: false,
    reason: 'Billing\'s L0 exports the invoice portal as "invoicing" at audience project, which covers the whole family.',
    scenario: 'Billing re-exports its invoice portal from its L0 as "invoicing" at audience project, and the operations console depends on `billing::invoicing`.',
    tree: fleet({ billingExports: BILLING_EXPORTS, consoleDependsOn: ['billing::invoicing'] }),
  }),

  // -------------------------------------------------------------------------
  // TRUSTED_LINK_CROSSES_PROJECT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'TRUSTED_LINK_CROSSES_PROJECT',
    severity: 'error',
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
    anchoredTo: 'route-planner',
    expectFire: true,
    scenario: 'The dispatch member\'s route planner names billing\'s invoice portal as `::billing::invoice-portal` — a leading `::` that names the portal by its place in whichever checkout loads it.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, plannerDependsOn: '::billing::invoice-portal', fromDispatch: true }),
  }),
  defineRuleFixture({
    code: 'DEPRECATED_REFERENCE_FORM',
    severity: 'notice',
    anchoredTo: 'route-planner',
    expectFire: true,
    scenario: 'The dispatch member\'s route planner names billing\'s invoice portal as `super::billing::invoice-portal` — a climb to the parent and a member path from there, a place in one family rather than a name.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, fromDispatch: true }),
  }),
  defineRuleFixture({
    code: 'DEPRECATED_REFERENCE_FORM',
    expectFire: false,
    reason: '`alias::name` is the canonical cross-project form: billing is the alias dispatch declares, invoicing the public name billing exports.',
    scenario: 'The dispatch member\'s route planner names billing\'s invoice portal as `billing::invoicing`, through the external it declares.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, plannerDependsOn: 'billing::invoicing', fromDispatch: true, dispatchPin: true }),
  }),

  // -------------------------------------------------------------------------
  // DEPRECATED_MOUNT_FORM
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'DEPRECATED_MOUNT_FORM',
    severity: 'notice',
    anchoredTo: 'billing',
    expectFire: true,
    scenario: 'FleetWorks declares its billing member as the L1 subsystem `billing` carrying `projectPath: packages/billing` — a subsystem that is really a member declaration.',
    tree: fleet({ billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} } }),
  }),
  defineRuleFixture({
    code: 'DEPRECATED_MOUNT_FORM',
    expectFire: false,
    reason: 'Both members are declared in the root\'s project.yaml `members`; no L1 subsystem carries a projectPath.',
    scenario: 'FleetWorks declares `members: { billing: packages/billing, dispatch: packages/dispatch }` and has no mount subsystems.',
    tree: fleet({ membersForm: true, billingExports: BILLING_EXPORTS, dispatchExternals: { billing: {} }, plannerDependsOn: 'billing::invoicing' }),
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
    scenario: 'Judged by its own gate, the dispatch member declares `externals: { acme.ledger: {} }` — a dotted producer id used as its own alias, which is not a reference name.',
    tree: fleet({ dispatchExternals: { 'acme.ledger': {} }, fromDispatch: true }),
  }),
  defineRuleFixture({
    code: 'EXTERNAL_UNRESOLVED',
    expectFire: false,
    reason: 'Dispatch holds a pin for its declared external billing, which is what its own gate judges against: nothing is climbed to find the producer.',
    scenario: 'Judged by its own gate, the dispatch member declares `externals: { billing: {} }` and holds billing\'s pin.',
    tree: fleet({ dispatchExternals: { billing: {} }, fromDispatch: true, dispatchPin: true }),
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
  // PROJECT_ID_AMBIGUOUS / PROJECT_ID_DEFAULTED — the bound project's own id
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    severity: 'warning',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The FleetWorks root is named only in Japanese ("配送") and declares no id, so no id can be derived for it and none is invented.',
    tree: fleet({ root: { name: '配送' } }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_AMBIGUOUS',
    expectFire: false,
    reason: 'The root declares its own well-formed id.',
    scenario: 'FleetWorks declares `id: fleetworks`, billing `id: billing` and dispatch `id: dispatch`.',
    tree: fleet(),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    severity: 'notice',
    anchoredTo: null,
    expectFire: true,
    scenario: 'The FleetWorks root declares no id, so it answers to "fleetworks", its name slug — renaming the project would move it.',
    tree: fleet({ root: { name: 'FleetWorks' } }),
  }),
  defineRuleFixture({
    code: 'PROJECT_ID_DEFAULTED',
    expectFire: false,
    reason: 'The root declares its id, so nothing answers to a derived one.',
    scenario: 'FleetWorks, billing and dispatch each declare an explicit id in their project.yaml.',
    tree: fleet(),
  }),
];
