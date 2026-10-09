import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { execFileSync } from 'child_process';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as migrations from '../../src/migrations/index.js';
import { familyFindings, familyLines, migrate, plan } from '../helpers/family-verbs.js';
import { component, contract, isolateGlobals, projectYaml, specs, subsystem, system, tempDir, type, writeClinic } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// Round 8 trials — family migrations.
//
// 4a: every project `wairon init` creates holds files under .wai that a
//     demote or internalize refused as unrecognised (phased_design.md first).
// 4b: an internalize respelled `shared::x` in params but left the stored
//     signature text naming it; and it re-pointed a sibling consumer at the
//     parent, closing a dependency loop its plan never announced.
// 4c: externalizing a subsystem as a project that names sibling members
//     declares the new project's externals for them.
// 4d: a demote announced MISSING_SYSTEM_SPEC for the folder it turns into a
//     part — a finding the applied result never has.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups.push(isolateGlobals(cleanups));
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows locks */ }
  }
});

/** `wairon init -y` in a fresh folder, exactly as a person runs it; answers the folder. */
function initProject(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(process.execPath, [TSX_CLI, WAIRON_CLI, 'init', '-y'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  return dir;
}

/**
 * The clinic whose member `scheduling` at services/scheduling is a PROJECT
 * that `wairon init` scaffolded: its project.yaml, L0, phased_design.md,
 * context, docs and rules are init's own, then its scheduling subsystem.
 */
function clinicWithInitMember(): { root: string; member: string } {
  const base = tempDir(cleanups, 'wairon-r8-init-');
  const scaffold = initProject(base, 'scheduling');
  const { root, part } = writeClinic(path.join(base, 'clinic'));
  // The member's scaffold: everything `init` wrote under .wai, beside the part's specs.
  for (const entry of fs.readdirSync(path.join(scaffold, '.wai'))) {
    if (entry === 'specs') fs.copyFileSync(path.join(scaffold, '.wai', 'specs', '.index.yaml'), path.join(part, '.wai', 'specs', '.index.yaml'));
    else fs.cpSync(path.join(scaffold, '.wai', entry), path.join(part, '.wai', entry), { recursive: true });
  }
  expect(fs.existsSync(path.join(part, '.wai', 'phased_design.md'))).toBe(true);
  return { root, member: part };
}

describe('round 8 — 4a: a project wairon init created demotes and internalizes', () => {
  it('demote applies: every file init wrote is recognised, deleted and listed by group', () => {
    const { root, member } = clinicWithInitMember();
    const planned = plan(root, { verb: 'demote', alias: 'scheduling' });
    expect(planned.refusals).toEqual([]);
    const report = at(root, () => migrations.apply(planned));
    expect(report.applied).toBe(true);
    expect(fs.existsSync(path.join(member, '.wai', 'phased_design.md'))).toBe(false);
    expect(fs.existsSync(path.join(member, '.wai', 'project.yaml'))).toBe(false);
    expect(fs.existsSync(path.join(member, '.wai', 'specs', 'scheduling', '.index.yaml'))).toBe(true);
  }, 120_000);

  it('internalize applies: the member folded in whole, its .wai gone', () => {
    const { root, member } = clinicWithInitMember();
    const report = migrate(root, { verb: 'internalize', alias: 'scheduling' });
    expect(report.applied).toBe(true);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'scheduling', '.index.yaml'))).toBe(true);
    // No file is left (init's empty folders are no content of the member's).
    const left = fs.existsSync(path.join(member, '.wai')) ? (fs.readdirSync(path.join(member, '.wai'), { recursive: true }) as string[]) : [];
    expect(left.filter((f) => fs.statSync(path.join(member, '.wai', f)).isFile())).toEqual([]);
  }, 120_000);

  it('a variant the member defines is placed in the home project; one that differs from the home\'s refuses', () => {
    const { root, member } = clinicWithInitMember();
    const variant = 'id: relay\nappliesTo: Orchestrator\ndescription: A relay\n';
    fs.mkdirSync(path.join(member, '.wai', 'variants'), { recursive: true });
    fs.writeFileSync(path.join(member, '.wai', 'variants', 'relay.yaml'), variant);
    fs.mkdirSync(path.join(root, '.wai', 'variants'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'variants', 'relay.yaml'), `${variant}# ours\n`);
    const refused = plan(root, { verb: 'demote', alias: 'scheduling' });
    expect(refused.refusals.map((r) => r.detail).join('\n')).toMatch(/variants\/relay\.yaml.*differs/);
    migrations.discard(refused);
    fs.rmSync(path.join(root, '.wai', 'variants'), { recursive: true, force: true });
    migrate(root, { verb: 'demote', alias: 'scheduling' });
    expect(fs.readFileSync(path.join(root, '.wai', 'variants', 'relay.yaml'), 'utf8')).toBe(variant);
  }, 120_000);

  it('a file of the member\'s .wai wairon never writes is still refused, naming it', () => {
    const { root, member } = clinicWithInitMember();
    fs.writeFileSync(path.join(member, '.wai', 'notes.txt'), 'mine');
    const refused = plan(root, { verb: 'demote', alias: 'scheduling' });
    expect(refused.refusals.map((r) => r.detail).join('\n')).toMatch(/"notes\.txt", which this write does not recognise/);
    migrations.discard(refused);
  }, 120_000);
});

describe('round 8 — 4d: a demote announces only what its result reports', () => {
  it('the folder the demote turns into a part is not judged as a project root without an L0', () => {
    const { root } = writeClinic(path.join(tempDir(cleanups, 'wairon-r8-announce-'), 'clinic'));
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const planned = plan(root, { verb: 'demote', alias: 'scheduling', announce: true });
    expect(planned.refusals).toEqual([]);
    expect(planned.notes.join('\n')).not.toMatch(/MISSING_SYSTEM_SPEC/);
    at(root, () => migrations.apply(planned));
    expect(familyLines(root).join('\n')).not.toMatch(/MISSING_SYSTEM_SPEC/);
  }, 120_000);
});

/**
 * The platform of the round-8 trial, in miniature: project `platform` with
 * two contained project members — `shared` (project `contracts`, at
 * libs/contracts, exporting the type `sku_id`) and `payments_svc` (project
 * `payments`, at services/payments, exporting its payment-portal, consuming
 * contracts as its external by path). The platform's inventory client takes a
 * `shared::sku_id` and its pay client depends on the payments portal.
 */
function platform(): { root: string; contracts: string; payments: string } {
  const root = path.join(tempDir(cleanups, 'wairon-r8-platform-'), 'platform');
  projectYaml(root, { id: 'platform', name: 'Platform', members: { shared: 'libs/contracts', payments_svc: 'services/payments' } });
  system(root, 'Platform');
  subsystem(root, 'Platform', 'inventory');
  component(root, 'inventory', 'inventory-upstream', 'Adapter');
  contract(root, 'inventory', 'inventory-upstream', [{
    name: 'getStock', description: 'The stock of one sku', signature: 'getStock(skuId: shared::sku_id): number', returns: 'number',
    params: [{ name: 'skuId', type: 'shared::sku_id', description: 'The sku' }],
  }]);
  component(root, 'inventory', 'pay-client', 'Adapter', ['payments_svc::payment-portal']);
  const contracts = path.join(root, 'libs', 'contracts');
  projectYaml(contracts, { id: 'contracts', name: 'Contracts' });
  system(contracts, 'Contracts', [{ typeDef: 'sku_id', audience: 'project' }]);
  subsystem(contracts, 'Contracts', 'catalog');
  type(specs(contracts, 'types', 'sku_id.yaml'), 'sku_id', [{ name: 'value', type: 'string' }]);
  const payments = path.join(root, 'services', 'payments');
  projectYaml(payments, { id: 'payments', name: 'Payments', externals: { contracts: { source: { path: '../../libs/contracts' } } } });
  system(payments, 'Payments', [{ from: 'billing', component: 'payment-portal', audience: 'project' }]);
  subsystem(payments, 'Payments', 'billing', { publicInterfaces: [{ type: 'Custom', details: 'Payments', component: 'payment-portal' }] });
  component(payments, 'billing', 'payment-portal', 'Portal');
  contract(payments, 'billing', 'payment-portal', [{
    name: 'charge', description: 'Charge for one sku', signature: 'charge(skuId: contracts::sku_id): void', returns: 'void',
    params: [{ name: 'skuId', type: 'contracts::sku_id', description: 'The sku' }],
  }]);
  return { root, contracts, payments };
}

describe('round 8 — 4b: internalize writes derived signature texts and names the loop it closes', () => {
  it('a param respelled from `shared::sku_id` to the local id carries its signature text with it', () => {
    const { root } = platform();
    migrate(root, { verb: 'internalize', alias: 'shared' });
    const stored = yaml.load(fs.readFileSync(specs(root, 'inventory', 'inventory-upstream', '.interface.yaml'), 'utf8')) as { methods: { signature: string; params: { type: string }[] }[] };
    expect(stored.methods[0].params[0].type).toBe('sku_id');
    expect(stored.methods[0].signature).toBe('getStock(skuId: sku_id): number');
    const found = familyFindings(root);
    expect(found).not.toContain('warning SIGNATURE_TEXT_STALE');
    expect(found).not.toContain('error EXTERNAL_UNDECLARED');
  }, 120_000);

  it('the plan names the dependency loop re-pointing a sibling consumer at the parent closes, in a note and in its announcement', () => {
    const { root } = platform();
    const planned = plan(root, { verb: 'internalize', alias: 'shared', announce: true });
    expect(planned.refusals).toEqual([]);
    const notes = planned.notes.join('\n');
    expect(notes).toMatch(/payments_svc.*loop/);
    expect(notes).toMatch(/after internalize: .*PROJECT_DEPENDENCY_CYCLE/);
    migrations.discard(planned);
  }, 120_000);
});

describe('round 8 — 4c: externalize as a project declares the sibling projects its specs name', () => {
  it('the new project declares, imports and pins its relations to the parent\'s members, and the family stays free of EXTERNAL_UNDECLARED', () => {
    const { root } = platform();
    subsystem(root, 'Platform', 'orders');
    component(root, 'orders', 'order-client', 'Adapter', ['payments_svc::payment-portal']);
    contract(root, 'orders', 'order-client', [{
      name: 'order', description: 'Order one sku', signature: 'order(skuId: shared::sku_id): void', returns: 'void',
      params: [{ name: 'skuId', type: 'shared::sku_id', description: 'The sku' }],
    }]);
    const before = familyFindings(root).filter((f) => f.includes('EXTERNAL_UNDECLARED'));
    const planned = plan(root, { verb: 'externalize', subsystem: 'orders', path: 'services/orders', as: 'project', announce: true });
    expect(planned.refusals).toEqual([]);
    const details = planned.edits.map((e) => e.detail).join('\n');
    expect(details).toMatch(/externals: shared \(project contracts\) at \.\.\/\.\.\/libs\/contracts/);
    expect(details).toMatch(/externals: payments_svc \(project payments\) at \.\.\/payments/);
    expect(planned.notes.join('\n')).not.toMatch(/EXTERNAL_UNDECLARED/);
    at(root, () => migrations.apply(planned));
    const config = yaml.load(fs.readFileSync(path.join(root, 'services', 'orders', '.wai', 'project.yaml'), 'utf8')) as { externals: Record<string, unknown> };
    expect(config.externals).toMatchObject({
      shared: { project: 'contracts', source: { path: '../../libs/contracts' } },
      payments_svc: { project: 'payments', source: { path: '../payments' } },
    });
    expect(fs.existsSync(path.join(root, 'services', 'orders', '.wai', 'externals.lock.yaml'))).toBe(true);
    expect(familyFindings(root).filter((f) => f.includes('EXTERNAL_UNDECLARED'))).toEqual(before);
  }, 120_000);
});

/** Bind a root and run one call there. */
function at<T>(dir: string, fn: () => T): T {
  invalidateSpecCache();
  setProjectRoot(dir);
  return fn();
}
