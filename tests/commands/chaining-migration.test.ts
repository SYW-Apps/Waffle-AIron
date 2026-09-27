import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot, runWithProjectBinding } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { saveSnapshot } from '../../src/core/surfaces.js';
import { SurfaceSnapshotSchema } from '../../src/models/index.js';
import { validateSddTree, validateAsComplete, type ValidationResult } from '../../src/core/validation.js';
import { ChainingMigrationRefusedError, DoctorOptionsError } from '../../src/utils/errors.js';
import { plan, apply, isEmpty, blocked } from '../../src/commands/chaining-migration.js';
import { runDoctor } from '../../src/commands/doctor.js';
import { runLock } from '../../src/commands/lock.js';

// ---------------------------------------------------------------------------
// Stage 2c — the chaining migration, run against a REAL family on disk: a
// parent that mounts two chained members, nothing mocked on the path under
// test. The dispatch member reaches billing's invoice portal (a sibling
// reference) and a type of the parent's operations subsystem, and neither
// producer exports anything at L0 — so the plan must declare every defaulted
// id, add the producers' L0 entries, declare dispatch's externals and pin them.
// The `property:` cases are the stage-2.md §7 properties 2c makes provable.
//
// Stage 3 keys a member by its project id: before the migration declares an
// id, billing and dispatch answer to (and are keyed by) their name slugs,
// `billing-service` and `dispatch-service`.
//
// `doctor --fix` runs through the real CLI in a Node process of its own, as
// tests/commands/doctor.test.ts does: applyFixes reaches the MCP adapter
// through a lazy require() that vitest cannot resolve in-process — and a
// child process has no terminal on stdin, which is the case under test.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

/** `wairon doctor …` in a real process; resolves with its output whatever its exit code. */
const doctorCli = (cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'doctor', ...args], { cwd, timeout: 180_000 })
    .then((r) => ({ stdout: r.stdout, stderr: r.stderr, code: 0 }))
    .catch((e: Error & { stdout?: string; stderr?: string; code?: number }) => ({ stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 }));

const TS = '2026-01-01T00:00:00.000Z';
const dump = (spec: Record<string, unknown>): string =>
  yaml.dump({ schemaVersion: '1.0.0', createdAt: TS, updatedAt: TS, ...spec }, { noRefs: true, lineWidth: 200 });

function write(root: string, rel: string, text: string): void {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** A project.yaml with no id (a defaulted identity) unless one is given; no targets, so doctor --fix touches nothing else. */
function projectYaml(name: string, id?: string): string {
  return dump({ ...(id ? { id } : {}), name, targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false } });
}

interface Family { root: string; billing: string; dispatch: string }

function fleet(o: { billingL1?: boolean } = {}): Family {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-chain-'));
  write(root, '.wai/project.yaml', projectYaml('FleetWorks'));
  write(root, '.wai/specs/.index.yaml', dump({ name: 'FleetWorks', vision: 'Delivery fleet platform.' }));
  write(root, '.wai/specs/subsystems/operations.yaml', dump({
    id: 'operations', name: 'Operations', description: 'The console.', parentSystem: 'FleetWorks',
    publicInterfaces: [{ typeDef: 'route-id' }],
  }));
  write(root, '.wai/specs/types/route-id.yaml', dump({
    id: 'route-id', name: 'RouteId', kind: 'value-object', description: 'A route.', subsystem: 'operations', fields: [{ name: 'value', type: 'string' }],
  }));
  write(root, '.wai/specs/subsystems/billing.yaml', dump({ id: 'billing', name: 'Billing', description: 'Chained billing member.', parentSystem: 'FleetWorks', projectPath: 'packages/billing' }));
  write(root, '.wai/specs/subsystems/dispatch.yaml', dump({ id: 'dispatch', name: 'Dispatch', description: 'Chained dispatch member.', parentSystem: 'FleetWorks', projectPath: 'packages/dispatch' }));

  const b = 'packages/billing/.wai';
  write(root, `${b}/project.yaml`, projectYaml('Billing Service'));
  write(root, `${b}/specs/.index.yaml`, dump({ name: 'BillingService', vision: 'Invoices.' }));
  write(root, `${b}/specs/subsystems/invoicing.yaml`, dump({
    id: 'invoicing', name: 'Invoicing', description: 'Invoicing.', parentSystem: 'BillingService',
    publicInterfaces: o.billingL1 === false ? [] : [{ component: 'invoice-portal', type: 'REST', details: 'Issue invoices.' }],
  }));
  write(root, `${b}/specs/components/invoice-portal.yaml`, dump({
    id: 'invoice-portal', name: 'Invoice Portal', description: 'Issues invoices.', subsystem: 'invoicing',
    componentType: 'Portal', portalType: 'HTTP_API', owns: [], dependsOn: [],
  }));
  write(root, `${b}/specs/interfaces/iinvoice-portal.yaml`, dump({
    id: 'iinvoice-portal', name: 'Invoice Portal Interface', description: 'Issue invoices.', component: 'invoice-portal',
    methods: [{ name: 'issueInvoice', description: 'Issue one invoice.', signature: 'issueInvoice(routeId: string): string', returns: 'string', params: [{ name: 'routeId', type: 'string' }] }],
  }));

  const d = 'packages/dispatch/.wai';
  write(root, `${d}/project.yaml`, projectYaml('Dispatch Service'));
  write(root, `${d}/specs/.index.yaml`, dump({ name: 'DispatchService', vision: 'Route planning.' }));
  write(root, `${d}/specs/subsystems/dispatch.yaml`, dump({ id: 'dispatch', name: 'Dispatch', description: 'Routes.', parentSystem: 'DispatchService' }));
  write(root, `${d}/specs/components/route-planner.yaml`, dump({
    id: 'route-planner', name: 'Route Planner', description: 'Plans routes and bills them.', subsystem: 'dispatch',
    componentType: 'Orchestrator', owns: [], dependsOn: ['super::billing::invoice-portal'],
  }));
  write(root, `${d}/specs/interfaces/iroute-planner.yaml`, dump({
    id: 'iroute-planner', name: 'Route Planner Interface', description: 'Plan.', component: 'route-planner',
    methods: [{ name: 'closeRoute', description: 'Close a delivered route.', signature: 'closeRoute(routeId: super::operations::route-id): void', returns: 'void', params: [{ name: 'routeId', type: 'super::operations::route-id' }] }],
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

/** Every file under the family whose content the chaining migration could change, hashed. */
function chainingState(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/project\.yaml$|[\\/]specs[\\/]|externals|surfaces|lock\.json$/.test(full)) {
        out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  };
  walk(root);
  return out;
}

const codesOf = (res: ValidationResult, ...codes: string[]): string[] =>
  res.issues.filter((i) => codes.includes(i.code)).map((i) => `${i.code} @${i.specId ?? '-'}`).sort();

const idOf = (dir: string): unknown => (yaml.load(fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8')) as { id?: unknown }).id;

describe('stage 2c — the chaining migration', () => {
  const made: string[] = [];
  const family = (o?: Parameters<typeof fleet>[0]): Family => {
    const f = fleet(o);
    made.push(f.root);
    return f;
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    for (const dir of made.splice(0)) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win locks */ }
    }
  });

  it('plans the family from the highest root in reach, whichever root is bound', () => {
    const f = family();
    const fromChild = at(f.dispatch, () => plan());
    const fromRoot = at(f.root, () => plan());
    expect(fromChild).toEqual(fromRoot);
    expect(fromRoot.familyRoot).toBe(path.resolve(f.root));
    expect(fromRoot.whole).toBe(true);
    expect(fromRoot.findings).toEqual([]);
    expect(fromRoot.projects.map((p) => [p.project, p.idToWrite])).toEqual([['', 'fleetworks'], ['billing-service', 'billing'], ['dispatch-service', 'dispatch']]);
    const [top, billing, dispatch] = fromRoot.projects;
    // The typeDef re-export: the operations L1 table resolves the type, so an L0 entry can follow it.
    expect(top.exports).toEqual([{ from: 'operations', typeDef: 'route-id', publicName: 'route-id', audience: 'project', consumers: ['dispatch-service'], members: ['type'], reason: 'reference' }]);
    expect(billing.exports).toEqual([{ from: 'invoicing', component: 'invoice-portal', publicName: 'invoice-portal', audience: 'project', consumers: ['dispatch-service'], members: ['issueInvoice'], reason: 'reference' }]);
    // Stage 3: both legacy mounts move into the top's `members`, and dispatch's
    // three `super::` references are rewritten to the aliases it now declares.
    expect(top.members.map((m) => [m.alias, m.path, m.description])).toEqual([['billing', 'packages/billing', 'Chained billing member.'], ['dispatch', 'packages/dispatch', 'Chained dispatch member.']]);
    expect(fromRoot.rewrites.map((r) => [r.specId, r.position, r.from, r.to])).toEqual([
      ['dispatch-service::iroute-planner', 'type', 'super::operations::route-id', 'fleetworks::route-id'],
      ['dispatch-service::route-planner', 'dependsOn', 'super::billing::invoice-portal', 'billing::invoice-portal'],
      ['dispatch-service::route-planner-impl', 'narrative', 'super::billing::invoice-portal', 'billing::invoice-portal'],
    ]);
    expect(dispatch.externals).toEqual([
      { alias: 'billing', project: 'billing', producer: 'billing-service', reason: 'reference' },
      { alias: 'fleetworks', project: 'fleetworks', producer: '', reason: 'reference' },
    ]);
    expect(dispatch.pins).toEqual(['billing', 'fleetworks']);
    expect(isEmpty(fromRoot)).toBe(false);
    expect(blocked(fromRoot)).toBe(false);
  });

  it('property: migration-is-plan-first — plan, --report and an unconfirmed --fix write nothing of it', async () => {
    const f = family();
    const before = chainingState(f.root);
    at(f.dispatch, () => plan());
    expect(chainingState(f.root)).toEqual(before);
    at(f.dispatch, () => undefined);
    await runDoctor({ report: 'chaining' });
    expect(vi.mocked(console.log).mock.calls.some((c) => String(c[0]).includes('Nothing was written.'))).toBe(true);
    expect(chainingState(f.root)).toEqual(before);
    // --report never combines with --fix, and chaining is its one section.
    await expect(runDoctor({ report: 'chaining', fix: true })).rejects.toThrow(DoctorOptionsError);
    await expect(runDoctor({ report: 'ids' })).rejects.toThrow(DoctorOptionsError);
    expect(chainingState(f.root)).toEqual(before);
    // No terminal to confirm and no --yes: every other fix runs, the migration does not.
    const unconfirmed = await doctorCli(f.root, '--fix');
    expect(unconfirmed.stdout).toContain('Chaining migration skipped: no terminal to confirm it');
    expect(chainingState(f.root)).toEqual(before);
    const refused = await doctorCli(f.root, '--report', 'chaining', '--fix');
    expect(refused.code).not.toBe(0);
    expect(refused.stdout + refused.stderr).toMatch(/never combines with --fix/);
    expect(chainingState(f.root)).toEqual(before);
  }, 240_000);

  it('property: defaulted-id-is-stable — after apply every id is declared, equal to the plan\'s, and PROJECT_ID_DEFAULTED is gone', () => {
    const f = family();
    const planned = at(f.root, () => plan());
    expect(codesOf(at(f.root, () => validateSddTree()), 'PROJECT_ID_DEFAULTED')).toHaveLength(3);
    const report = at(f.root, () => apply(planned));
    expect(report.applied).toBe(true);
    expect(codesOf(at(f.root, () => validateSddTree()), 'PROJECT_ID_DEFAULTED', 'PROJECT_ID_AMBIGUOUS', 'PROJECT_ID_CHANGED')).toEqual([]);
    for (const p of planned.projects) expect(idOf(p.directory)).toBe(p.id);
  });

  it('after apply the migrated references are declared and exported: EXTERNAL_UNDECLARED and EXTERNAL_NOT_EXPORTED are gone', () => {
    const f = family();
    const before = at(f.root, () => validateSddTree());
    expect(codesOf(before, 'EXTERNAL_UNDECLARED')).toEqual([
      'EXTERNAL_UNDECLARED @dispatch-service::iroute-planner', 'EXTERNAL_UNDECLARED @dispatch-service::route-planner', 'EXTERNAL_UNDECLARED @dispatch-service::route-planner-impl',
    ]);
    expect(codesOf(before, 'EXTERNAL_NOT_EXPORTED')).toHaveLength(3);
    const report = at(f.root, () => apply(plan()));
    const after = at(f.root, () => validateSddTree());
    expect(codesOf(after, 'EXTERNAL_UNDECLARED', 'EXTERNAL_NOT_EXPORTED', 'EXPORT_INVALID')).toEqual([]);
    // The same verdict from the child.
    expect(codesOf(at(f.dispatch, () => validateSddTree()), 'EXTERNAL_UNDECLARED', 'EXTERNAL_NOT_EXPORTED')).toEqual([]);
    // Written in order: ids, L0 specs, externals, pins; the producers' and the consumer's locks are stale.
    const rel = report.written.map((w) => path.relative(f.root, w).split(path.sep).join('/'));
    expect(rel).toEqual([
      '.wai/project.yaml', 'packages/billing/.wai/project.yaml', 'packages/dispatch/.wai/project.yaml',
      '.wai/specs/.index.yaml', 'packages/billing/.wai/specs/.index.yaml',
      'packages/dispatch/.wai/externals/billing.yaml', 'packages/dispatch/.wai/externals.lock.yaml', 'packages/dispatch/.wai/externals/fleetworks.yaml',
      // Then position: the mounts moved into the top's `members`, dispatch's references rewritten.
      '.wai/specs: subsystem billing', '.wai/specs: subsystem dispatch',
      'packages/dispatch/.wai/specs: interface iroute-planner', 'packages/dispatch/.wai/specs: component route-planner',
      'packages/dispatch/.wai/specs: implementation route-planner-impl',
    ]);
    // A raw position is rewritten too: the parameter type and the display signature beside it.
    const contract = fs.readFileSync(path.join(f.dispatch, '.wai', 'specs', 'interfaces', 'iroute-planner.yaml'), 'utf8');
    expect(contract).toContain('closeRoute(routeId: fleetworks::route-id): void');
    expect(contract).toContain('type: fleetworks::route-id');
    expect(contract).not.toContain('super::');
    expect(report.relock.map((d) => path.relative(f.root, d).split(path.sep).join('/'))).toEqual(['', 'packages/billing', 'packages/dispatch']);
    // The entry is written with no `as`: its public name is the item's default.
    const l0 = yaml.load(fs.readFileSync(path.join(f.billing, '.wai', 'specs', '.index.yaml'), 'utf8')) as { publicInterfaces: unknown[] };
    expect(l0.publicInterfaces).toEqual([{ from: 'invoicing', component: 'invoice-portal', audience: 'project' }]);
  });

  it('is idempotent: a second plan is empty, and applying either plan again writes nothing', () => {
    const f = family();
    const first = at(f.root, () => plan());
    at(f.root, () => apply(first));
    const settled = chainingState(f.root);
    const second = at(f.dispatch, () => plan());
    expect(isEmpty(second)).toBe(true);
    expect(second.projects).toEqual([]);
    expect(at(f.root, () => apply(second))).toEqual({ plan: second, applied: false, written: [], relock: [] });
    const again = at(f.root, () => apply(first));
    expect(again.written).toEqual([]);
    expect(again.relock).toEqual([]);
    expect(chainingState(f.root)).toEqual(settled);
  });

  it('a locked member keeps the id its lock approved (id-locked), and re-locking afterwards succeeds', async () => {
    const f = family();
    // Billing was locked while its id was defaulted to its name slug.
    const locked = await at(f.billing, () => runLock({ yes: true }));
    expect(locked?.projectId).toBe('billing-service');

    const planned = at(f.root, () => plan());
    expect(planned.findings).toEqual([expect.objectContaining({ kind: 'id-locked', project: 'billing-service', blocking: false })]);
    expect(planned.projects.find((p) => p.project === 'billing-service')?.idToWrite).toBe('billing-service');
    // Dispatch declares billing under the id it keeps.
    expect(planned.projects.find((p) => p.project === 'dispatch-service')?.externals.map((e) => e.alias)).toEqual(['billing-service', 'fleetworks']);
    const report = at(f.root, () => apply(planned));
    expect(report.relock).toContain(path.resolve(f.billing));
    expect(idOf(f.billing)).toBe('billing-service');

    // No deadlock: the id the lock approved is the id declared, so the gate lets the human re-lock.
    const gate = at(f.billing, () => validateAsComplete());
    expect(codesOf(gate, 'PROJECT_ID_CHANGED')).toEqual([]);
    const relocked = await at(f.billing, () => runLock({ yes: true }, gate));
    expect(relocked?.projectId).toBe('billing-service');
    expect(codesOf(at(f.root, () => validateSddTree()), 'PROJECT_ID_CHANGED', 'EXTERNAL_UNDECLARED', 'EXTERNAL_NOT_EXPORTED')).toEqual([]);
  });

  it('a family only partly in reach blocks apply before its first write', () => {
    const f = family();
    const before = chainingState(f.root);
    const partial = runWithProjectBinding(f.dispatch, { topRoot: f.dispatch, parentReach: false }, () => {
      invalidateSpecCache();
      return plan();
    });
    expect(partial.whole).toBe(false);
    expect(partial.familyRoot).toBe(path.resolve(f.dispatch));
    expect(partial.findings[0]).toMatchObject({ kind: 'family-partial', blocking: true });
    expect(blocked(partial)).toBe(true);
    expect(() => runWithProjectBinding(f.dispatch, { topRoot: f.dispatch, parentReach: false }, () => apply(partial)))
      .toThrow(ChainingMigrationRefusedError);
    expect(chainingState(f.root)).toEqual(before);
  });

  it('refuses before its first write when a project it must write lost its configuration', () => {
    const f = family();
    const planned = at(f.root, () => plan());
    fs.rmSync(path.join(f.dispatch, '.wai', 'project.yaml'));
    const before = chainingState(f.root);
    expect(() => at(f.root, () => apply(planned))).toThrow(ChainingMigrationRefusedError);
    expect(chainingState(f.root)).toEqual(before);
  });

  it('reports a reference its subsystem does not publish instead of exporting it', () => {
    const f = family({ billingL1: false });
    const planned = at(f.root, () => plan());
    expect(planned.projects.find((p) => p.project === 'billing-service')?.exports ?? []).toEqual([]);
    expect(planned.findings.map((x) => [x.kind, x.project, x.reference?.specId])).toEqual([
      ['target-unpublished', 'billing-service', 'dispatch-service::route-planner'],
      ['target-unpublished', 'billing-service', 'dispatch-service::route-planner-impl'],
    ]);
    // The external is still declared: the reference crosses into billing either way.
    expect(planned.projects.find((p) => p.project === 'dispatch-service')?.externals.map((e) => e.alias)).toEqual(['billing', 'fleetworks']);
  });

  it('converts a member\'s stage-1 family pin to an external and deletes every family pin once the external is pinned', () => {
    const f = family();
    // The pins `surface pin` once wrote (stage 3 retired the writer): the parent's family surface and two siblings'.
    const pin = (projectName: string): string => saveSnapshot(SurfaceSnapshotSchema.parse({
      projectName, origin: 'generated', stateId: 'sha256:pinned', generatedAt: TS, interfaces: [], types: [],
    }), f.billing);
    const pinned = ['FleetWorks', 'FleetWorks::dispatch', 'FleetWorks::operations'].map(pin);
    const planned = at(f.root, () => plan());
    const billing = planned.projects.find((p) => p.project === 'billing-service')!;
    expect(billing.externals).toEqual([{ alias: 'fleetworks', project: 'fleetworks', producer: '', reason: 'legacy-pin' }]);
    expect(billing.pins).toEqual(['fleetworks']);
    expect(billing.supersededPins).toEqual(['FleetWorks', 'FleetWorks::dispatch', 'FleetWorks::operations']);
    at(f.root, () => apply(planned));
    for (const file of pinned) expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(path.join(f.billing, '.wai', 'externals', 'fleetworks.yaml'))).toBe(true);
    expect(isEmpty(at(f.root, () => plan()))).toBe(true);
  });

  it('doctor: a plain run counts what is pending; --fix --yes applies it, and the run after is clean', async () => {
    const f = family();
    const plain = await doctorCli(f.dispatch);
    expect(plain.stdout).toMatch(/Chaining: 14 pending \(3 id\(s\), 0 L0\(s\) to create, 2 L0 entries, 2 external\(s\), 2 pin\(s\), 2 mount\(s\) to move, 3 rewrite\(s\), 0 family pin\(s\) to delete, 0 dropped key\(s\), 0 finding\(s\)\)/);
    const fixed = await doctorCli(f.dispatch, '--fix', '--yes');
    expect(fixed.stdout).toContain('Applied the chaining migration: 13 file(s) written.');
    expect(fixed.stdout).toContain('Re-lock each with `wairon lock`');
    // The report that follows the fixes plans again, and finds nothing left.
    expect(fixed.stdout).not.toMatch(/Chaining: \d+ pending/);
    expect(isEmpty(at(f.root, () => plan()))).toBe(true);
  }, 240_000);
});
