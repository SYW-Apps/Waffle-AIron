import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot, runWithProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import { invalidateSpecCache, scanAllSpecs, graph, exportUsage, listProjectRoots, resolveProjectExports } from '../../src/core/specs.js';
import { resolveDeclared } from '../../src/core/external-producers.js';
import { externalsRepository, externalsFileAdapter } from '../../src/core/externals.js';
import {
  pinExternals, getExternalsStatus, listExternals, projectOwnSurface, UnknownExternalAliasError,
} from '../../src/core/surfaces.js';
import { validateSddTree, type ValidationResult } from '../../src/core/validation.js';
import { consumedContractInputs } from '../../src/core/specs.js';
import { contentDigest, ownerOf, producerOf, declares, familyNode } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Stage 2b — the project graph and declared externals, run against a REAL
// family on disk (the integration sim for project_family_index,
// external_producers, the externals repository and the surface orchestrator's
// pin/status/list): nothing here is mocked.
//
// FleetWorks mounts two chained members. Dispatch's route planner calls
// billing's invoice portal (issueInvoice) — a sibling reference, the edge the
// whole stage is about. The property tests of stage-2.md §7 that 2b makes
// provable are the `property:` cases.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

interface FleetOptions {
  dispatchExternals?: Record<string, unknown>;
  rootExternals?: Record<string, unknown>;
  billingExports?: Record<string, unknown>[];
  /** Billing's own L1: a facade subsystem that re-exports the portal (the re-export chain variant). */
  viaFacade?: boolean;
  billingId?: string;
  issueInvoiceReturns?: string;
  voidInvoiceReturns?: string;
}

const DIRECT_EXPORTS = [{ from: 'billing', component: 'invoice-portal', as: 'invoicing', audience: 'project', type: 'REST' }];

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function projectYaml(id: string | undefined, name: string, externals?: Record<string, unknown>): string {
  return dump({
    ...(id !== undefined ? { id } : {}),
    name,
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    extensions: { packs: [], useGlobalPacks: false },
    ...(externals ? { externals } : {}),
  });
}

/** The FleetWorks family on disk; answers the root and the two member directories. */
function fleet(o: FleetOptions = {}): { root: string; billing: string; dispatch: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-'));
  write(root, '.wai/project.yaml', projectYaml('fleetworks', 'FleetWorks', o.rootExternals));
  write(root, '.wai/specs/.index.yaml', dump({ name: 'FleetWorks', vision: 'Delivery fleet platform.' }));
  write(root, '.wai/specs/subsystems/operations.yaml', dump({ id: 'operations', name: 'Operations', description: 'The console.', parentSystem: 'FleetWorks' }));
  write(root, '.wai/specs/subsystems/billing.yaml', dump({ id: 'billing', name: 'Billing', description: 'Chained billing member.', parentSystem: 'FleetWorks', projectPath: 'packages/billing' }));
  write(root, '.wai/specs/subsystems/dispatch.yaml', dump({ id: 'dispatch', name: 'Dispatch', description: 'Chained dispatch member.', parentSystem: 'FleetWorks', projectPath: 'packages/dispatch' }));

  const b = 'packages/billing/.wai';
  write(root, `${b}/project.yaml`, projectYaml(o.billingId ?? 'billing', 'Billing Service'));
  const billingExports = o.billingExports ?? (o.viaFacade
    ? [{ from: 'billing-api', component: 'invoice-portal', as: 'invoicing', audience: 'project', type: 'REST' }]
    : DIRECT_EXPORTS);
  write(root, `${b}/specs/.index.yaml`, dump({ name: 'BillingService', vision: 'Invoices.', publicInterfaces: billingExports }));
  write(root, `${b}/specs/subsystems/billing.yaml`, dump({
    id: 'billing', name: 'Billing', description: 'Invoicing.', parentSystem: 'BillingService',
    publicInterfaces: [{ component: 'invoice-portal', type: 'REST', details: 'Issue invoices.' }],
  }));
  if (o.viaFacade) {
    write(root, `${b}/specs/subsystems/billing-api.yaml`, dump({
      id: 'billing-api', name: 'Billing API', description: 'The facade the family integrates against.', parentSystem: 'BillingService',
      publicInterfaces: [{ from: 'billing' }],
    }));
  }
  write(root, `${b}/specs/components/invoice-portal.yaml`, dump({
    id: 'invoice-portal', name: 'Invoice Portal', description: 'Issues invoices.', subsystem: 'billing',
    componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [],
  }));
  write(root, `${b}/specs/interfaces/iinvoice-portal.yaml`, dump({
    id: 'iinvoice-portal', name: 'Invoice Portal Interface', description: 'Issue invoices.', component: 'invoice-portal',
    methods: [
      { name: 'issueInvoice', description: 'Issue one invoice.', signature: 'issueInvoice(routeId: string): string', returns: o.issueInvoiceReturns ?? 'string', params: [{ name: 'routeId', type: 'string' }] },
      { name: 'voidInvoice', description: 'Void one invoice.', signature: 'voidInvoice(invoiceId: string): void', returns: o.voidInvoiceReturns ?? 'void', params: [{ name: 'invoiceId', type: 'string' }] },
    ],
  }));

  const d = 'packages/dispatch/.wai';
  write(root, `${d}/project.yaml`, projectYaml('dispatch', 'Dispatch Service', o.dispatchExternals));
  write(root, `${d}/specs/.index.yaml`, dump({ name: 'DispatchService', vision: 'Route planning.' }));
  write(root, `${d}/specs/subsystems/dispatch.yaml`, dump({ id: 'dispatch', name: 'Dispatch', description: 'Routes.', parentSystem: 'DispatchService' }));
  write(root, `${d}/specs/components/route-planner.yaml`, dump({
    id: 'route-planner', name: 'Route Planner', description: 'Plans routes and bills them.', subsystem: 'dispatch',
    componentType: 'Orchestrator', owns: [], dependsOn: ['super::billing::invoice-portal'],
  }));
  write(root, `${d}/specs/interfaces/iroute-planner.yaml`, dump({
    id: 'iroute-planner', name: 'Route Planner Interface', description: 'Plan.', component: 'route-planner',
    methods: [{ name: 'closeRoute', description: 'Close a delivered route.', signature: 'closeRoute(routeId: string): void', returns: 'void', params: [{ name: 'routeId', type: 'string' }] }],
  }));
  write(root, `${d}/specs/implementations/route-planner-impl.yaml`, dump({
    id: 'route-planner-impl', name: 'Route Planner Impl', description: 'Closes routes.', contract: 'iroute-planner',
    methods: [{ name: 'closeRoute', narrative: [{ stepNumber: 1, type: 'call', description: 'Bill the route.', targetComponent: 'super::billing::invoice-portal', targetMethod: 'issueInvoice' }] }],
  }));
  invalidateSpecCache();
  return { root, billing: path.join(root, 'packages', 'billing'), dispatch: path.join(root, 'packages', 'dispatch') };
}

/** Bind a root and read it as it is now. */
function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}

const codes = (res: ValidationResult, code: string): string[] =>
  res.issues.filter((i) => i.code === code).map((i) => `${i.severity} @${i.specId ?? '-'}`).sort();

describe('stage 2b — the project graph and declared externals', () => {
  const made: string[] = [];
  const family = (o?: FleetOptions): ReturnType<typeof fleet> => {
    const f = fleet(o);
    made.push(f.root);
    return f;
  };

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of made.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ }
    }
  });

  // ---- the scan and the graph -------------------------------------------------

  it('the scan records one root per project, bound root first, each with its own L0 qualified into its namespace', () => {
    const f = family();
    const roots = at(f.root, () => listProjectRoots());
    expect(roots.map((r) => r.namespace)).toEqual(['', 'billing', 'dispatch']);
    expect(roots[1]).toMatchObject({ parent: '', mountAlias: 'billing', directory: path.resolve(f.billing) });
    expect(roots[1].system?.publicInterfaces?.[0]).toMatchObject({ from: 'billing', component: 'billing::invoice-portal' });
    expect(roots[1].config?.id).toBe('billing');
  });

  it('property: graph-projection-equals-index — every scanned spec has exactly the owner whose root holds its file', () => {
    const f = family({ viaFacade: true });
    at(f.root, () => {
      const index = scanAllSpecs();
      const fam = graph();
      const deepest = (file: string): string => fam.nodes
        .filter((n) => path.resolve(file).startsWith(path.resolve(n.directory) + path.sep))
        .sort((a, b) => b.directory.length - a.directory.length)[0].namespace;
      for (const kind of ['subsystem', 'component', 'interface', 'implementation', 'type'] as const) {
        for (const [id, file] of Object.entries(index.paths[kind])) {
          expect(fam.owners.get(id), `${kind} ${id}`).toBe(deepest(file));
        }
      }
      // Nothing the index does not hold is owned.
      const indexed = new Set(Object.values(index.paths).flatMap((m) => Object.keys(m)));
      for (const id of fam.owners.keys()) expect(indexed.has(id), id).toBe(true);
    });
  });

  it('producerOf, ownerOf and declares read the graph', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    at(f.root, () => {
      const fam = graph();
      expect(ownerOf(fam, 'dispatch::route-planner')?.namespace).toBe('dispatch');
      expect(producerOf(fam, 'billing::invoice-portal')?.namespace).toBe('billing');
      // A missing item still lands in the project whose namespace prefixes it.
      expect(producerOf(fam, 'billing::no-such-thing')?.namespace).toBe('billing');
      expect(producerOf(fam, 'super::billing::invoice-portal', 'dispatch')?.namespace).toBe('billing');
      expect(producerOf(fam, 'super::super::x', 'dispatch')).toBeNull();
      expect(declares(fam, 'dispatch', 'billing')).toBe(true);
      expect(declares(fam, '', 'billing')).toBe(true); // a member needs no declaration
      expect(declares(fam, 'billing', 'dispatch')).toBe(false);
      expect(familyNode(fam, 'dispatch')?.externals[0]).toMatchObject({ alias: 'billing', sourceKind: 'family', relation: 'sibling', producer: 'billing', audience: 'project' });
      expect(fam.references).toEqual(expect.arrayContaining([
        expect.objectContaining({ specId: 'dispatch::route-planner', position: 'dependsOn', target: 'billing::invoice-portal', consumer: 'dispatch', producer: 'billing' }),
        expect.objectContaining({ specId: 'dispatch::route-planner-impl', position: 'call', member: 'issueInvoice' }),
      ]));
    });
  });

  it('an edit to a root\'s project.yaml re-scans: the externals join the graph without an invalidate', () => {
    const f = family();
    at(f.root, () => expect(familyNode(graph(), 'dispatch')?.externals).toEqual([]));
    write(f.root, 'packages/dispatch/.wai/project.yaml', projectYaml('dispatch', 'Dispatch Service', { billing: {} }));
    // Bind again without invalidating: the new binding re-verifies the signature, which covers project.yaml.
    setProjectRoot(null);
    setProjectRoot(f.root);
    runWithProjectRoot(f.root, () => expect(familyNode(graph(), 'dispatch')?.externals.map((e) => e.alias)).toEqual(['billing']));
  });

  it('a member project table follows the member\'s own L0; a widening re-export is a problem', () => {
    const f = family();
    write(f.root, '.wai/specs/.index.yaml', dump({
      name: 'FleetWorks', vision: 'Delivery fleet platform.',
      publicInterfaces: [{ from: 'billing', component: 'invoicing', audience: 'external', type: 'REST' }],
    }));
    at(f.root, () => {
      expect(resolveProjectExports('billing').entries.map((e) => [e.publicName, e.audience])).toEqual([['invoicing', 'project']]);
      const own = resolveProjectExports();
      expect(own.problems.map((p) => p.kind)).toContain('widens');
      // Bound at the source's reach: a re-export can narrow, never widen.
      expect(own.entries[0]).toMatchObject({ publicName: 'invoicing', audience: 'project', component: 'billing::invoice-portal' });
    });
  });

  // ---- the findings --------------------------------------------------------------

  it('property: undeclared-is-reported-from-every-root — from the family root and from the child', () => {
    const f = family();
    const fromRoot = at(f.root, () => validateSddTree());
    expect(codes(fromRoot, 'EXTERNAL_UNDECLARED')).toEqual(['notice @dispatch::route-planner', 'notice @dispatch::route-planner-impl']);
    const fromChild = at(f.dispatch, () => validateSddTree());
    expect(fromChild.resolvedThrough?.scope).toBe('dispatch');
    expect(codes(fromChild, 'EXTERNAL_UNDECLARED')).toEqual(['notice @route-planner', 'notice @route-planner-impl']);
    // A notice never fails the gate.
    expect(fromRoot.issues.filter((i) => i.code === 'EXTERNAL_UNDECLARED').every((i) => i.severity === 'notice')).toBe(true);
  });

  it('property: not-exported-is-reported — a declared producer that exports nothing public', () => {
    const f = family({ dispatchExternals: { billing: {} }, billingExports: [] });
    const res = at(f.root, () => validateSddTree());
    expect(codes(res, 'EXTERNAL_UNDECLARED')).toEqual([]);
    expect(codes(res, 'EXTERNAL_NOT_EXPORTED')).toEqual(['notice @dispatch::route-planner', 'notice @dispatch::route-planner-impl']);
    const pins = at(f.dispatch, () => pinExternals());
    expect(pins[0].outcome).toBe('pinned');
    expect(pins[0].usedNames).toBe(0);
    expect(pins[0].unexported.map((r) => r.specId).sort()).toEqual(['dispatch::route-planner', 'dispatch::route-planner-impl']);
  });

  // ---- pin, status, list -----------------------------------------------------------

  it('property: pin-is-a-projection — the pinned snapshot is the producer\'s table projected at the audience ceiling', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    const pins = at(f.dispatch, () => pinExternals());
    expect(pins).toEqual([expect.objectContaining({ alias: 'billing', outcome: 'pinned', project: 'billing', usedNames: 1, unexported: [] })]);
    const pinned = at(f.dispatch, () => externalsRepository.readSnapshot('billing'))!;
    const projected = at(f.billing, () => ({ ...projectOwnSurface('project'), audience: 'project' }));
    expect(contentDigest(pinned)).toBe(contentDigest(projected));
    const lock = at(f.dispatch, () => externalsRepository.readLock())!;
    expect(lock.externals.billing).toMatchObject({ project: 'billing', snapshot: '.wai/externals/billing.yaml', digest: contentDigest(projected) });
    expect(Object.keys(lock.externals.billing.used)).toEqual(['invoicing']);
    expect(Object.keys(lock.externals.billing.used.invoicing)).toEqual(['issueInvoice']);
    // A re-pin of an unchanged producer rewrites nothing.
    const before = fs.statSync(path.join(f.dispatch, '.wai', 'externals.lock.yaml')).mtimeMs;
    expect(at(f.dispatch, () => pinExternals())[0].outcome).toBe('unchanged');
    expect(fs.statSync(path.join(f.dispatch, '.wai', 'externals.lock.yaml')).mtimeMs).toBe(before);
  });

  it('property: stale-only-when-used-changes — an unused member drifts, a used one goes stale', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    at(f.dispatch, () => pinExternals());
    expect(at(f.dispatch, () => getExternalsStatus())[0]).toMatchObject({ pinned: true, reachable: true, stale: false, drifted: false });

    // voidInvoice is not used: the producer drifted, nothing used moved.
    write(f.root, 'packages/billing/.wai/specs/interfaces/iinvoice-portal.yaml', fs.readFileSync(path.join(f.billing, '.wai', 'specs', 'interfaces', 'iinvoice-portal.yaml'), 'utf8').replace("returns: void", 'returns: boolean'));
    const drifted = at(f.dispatch, () => getExternalsStatus())[0];
    expect(drifted).toMatchObject({ stale: false, drifted: true });
    expect(drifted.uses).toEqual([{ publicName: 'invoicing', member: 'issueInvoice', state: 'unchanged' }]);

    // issueInvoice IS used: its return type changed, so the pin is stale.
    write(f.root, 'packages/billing/.wai/specs/interfaces/iinvoice-portal.yaml', fs.readFileSync(path.join(f.billing, '.wai', 'specs', 'interfaces', 'iinvoice-portal.yaml'), 'utf8').replace("returns: string", 'returns: number'));
    const stale = at(f.dispatch, () => getExternalsStatus())[0];
    expect(stale).toMatchObject({ stale: true, drifted: true });
    expect(stale.uses).toEqual([{ publicName: 'invoicing', member: 'issueInvoice', state: 'changed' }]);
  });

  it('property: reexport-is-transparent — the lock and the verdict are the same through a re-export chain', () => {
    const direct = family({ dispatchExternals: { billing: {} } });
    const chained = family({ dispatchExternals: { billing: {} }, viaFacade: true });
    const lockOf = (f: ReturnType<typeof fleet>) => {
      at(f.dispatch, () => pinExternals());
      return at(f.dispatch, () => externalsRepository.readLock())!.externals.billing.used;
    };
    expect(lockOf(chained)).toEqual(lockOf(direct));
    const verdict = (f: ReturnType<typeof fleet>) => at(f.root, () => validateSddTree()).issues
      .filter((i) => i.code.startsWith('EXTERNAL_')).map((i) => `${i.code} @${i.specId}`).sort();
    expect(verdict(chained)).toEqual(verdict(direct));
  });

  it('an undeclared alias is refused before anything is written; pruning drops what is no longer declared', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    expect(() => at(f.dispatch, () => pinExternals(['ledger']))).toThrow(UnknownExternalAliasError);
    expect(fs.existsSync(path.join(f.dispatch, '.wai', 'externals.lock.yaml'))).toBe(false);
    at(f.dispatch, () => pinExternals());
    write(f.root, 'packages/dispatch/.wai/project.yaml', projectYaml('dispatch', 'Dispatch Service'));
    expect(at(f.dispatch, () => pinExternals())).toEqual([]);
    expect(at(f.dispatch, () => externalsRepository.readLock())).toEqual({ externals: {} });
    expect(fs.existsSync(path.join(f.dispatch, '.wai', 'externals'))).toBe(false);
  });

  it('an unresolved or out-of-reach producer is reported, never read, and keeps its previous pin', () => {
    const f = family({ dispatchExternals: { billing: {}, ledger: {} } });
    const pins = at(f.dispatch, () => pinExternals());
    expect(pins.map((p) => [p.alias, p.outcome])).toEqual([['billing', 'pinned'], ['ledger', 'unresolved']]);
    // A request narrowed to the child reads nothing above its root: the sibling is not even found.
    const narrowed = runWithProjectBinding(f.dispatch, { topRoot: f.dispatch, parentReach: false }, () => {
      invalidateSpecCache();
      return resolveDeclared();
    });
    expect(narrowed.map((b) => [b.external.alias, b.external.sourceKind, b.reachable])).toEqual([['billing', 'unresolved', false], ['ledger', 'unresolved', false]]);
    const status = runWithProjectBinding(f.dispatch, { topRoot: f.dispatch, parentReach: false }, () => getExternalsStatus());
    expect(status[0]).toMatchObject({ alias: 'billing', pinned: true, reachable: false, stale: false });
    expect(status[0].uses.every((u) => u.state === 'unavailable' && u.code === 'EXTERNAL_CHECK_UNAVAILABLE')).toBe(true);
  });

  it('a source.path external outside the family is pinned at instance, with nothing used and status unavailable', () => {
    const f = family();
    // A standalone project next to the family, reached only through source.path.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-ext-out-'));
    made.push(outside);
    write(outside, '.wai/project.yaml', projectYaml('ledger', 'Ledger'));
    write(outside, '.wai/specs/.index.yaml', dump({ name: 'Ledger', vision: 'v', publicInterfaces: [
      { from: 'ledger', component: 'ledger-portal', audience: 'instance', type: 'REST' },
      { from: 'ledger', component: 'audit-portal', as: 'audit', audience: 'project', type: 'REST' },
    ] }));
    write(outside, '.wai/specs/subsystems/ledger.yaml', dump({ id: 'ledger', name: 'Ledger', description: 'd', parentSystem: 'Ledger', publicInterfaces: [{ component: 'ledger-portal', type: 'REST', details: 'd' }, { component: 'audit-portal', type: 'REST', details: 'd' }] }));
    write(outside, '.wai/specs/components/ledger-portal.yaml', dump({ id: 'ledger-portal', name: 'Ledger Portal', description: 'd', subsystem: 'ledger', componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [] }));
    write(outside, '.wai/specs/components/audit-portal.yaml', dump({ id: 'audit-portal', name: 'Audit Portal', description: 'd', subsystem: 'ledger', componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [] }));
    write(f.root, '.wai/project.yaml', projectYaml('fleetworks', 'FleetWorks', { ledger: { source: { path: path.relative(f.root, outside) } } }));
    const pins = at(f.root, () => pinExternals());
    expect(pins[0]).toMatchObject({ alias: 'ledger', outcome: 'pinned', usedNames: 0 });
    const snapshot = at(f.root, () => externalsRepository.readSnapshot('ledger'))!;
    // The instance ceiling: the project-audience entry stays inside its family.
    expect(snapshot.interfaces.map((e) => e.id)).toEqual(['ledger-portal']);
    expect(snapshot.audience).toBe('instance');
    const status = at(f.root, () => getExternalsStatus())[0];
    expect(status).toMatchObject({ sourceKind: 'path', reachable: true, stale: false });
    expect(status.uses).toEqual([expect.objectContaining({ state: 'unavailable', code: 'EXTERNAL_CHECK_UNAVAILABLE' })]);
    expect(at(f.root, () => listExternals())[0]).toMatchObject({ alias: 'ledger', sourceKind: 'path', audience: 'instance', lock: expect.objectContaining({ project: 'ledger' }) });
  });

  it('the gate inputs cover the pinned externals and the lock, each key naming its kind', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    const before = at(f.dispatch, () => consumedContractInputs());
    at(f.dispatch, () => pinExternals());
    const after = at(f.dispatch, () => consumedContractInputs());
    expect(before).toEqual([]);
    expect(after.map((k) => k.split(':')[0]).sort()).toEqual(['external', 'lock']);
  });

  it('a malformed lock is refused naming the file, never read as empty', () => {
    const f = family();
    write(f.dispatch, '.wai/externals.lock.yaml', 'externals: [not, a, map]\n');
    expect(() => at(f.dispatch, () => externalsFileAdapter.readLock())).toThrow(/externals\.lock\.yaml/);
  });

  it('exportUsage maps the consumer\'s references onto the producer\'s public names', () => {
    const f = family({ dispatchExternals: { billing: {} } });
    at(f.root, () => {
      expect(exportUsage('dispatch', 'billing')).toEqual({
        consumer: 'dispatch',
        producer: 'billing',
        used: [{ publicName: 'invoicing', kind: 'component', members: ['issueInvoice'] }],
        unexported: [],
      });
      expect(exportUsage('billing', 'dispatch')).toEqual({ consumer: 'billing', producer: 'dispatch', used: [], unexported: [] });
    });
  });
});
