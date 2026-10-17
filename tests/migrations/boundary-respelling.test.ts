import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { validateFamily, type ValidationIssue } from '../../src/core/validation.js';
import type { MigrationPlan } from '../../src/migrations/types.js';
import { at, migrate, newFindings, plan } from '../helpers/family-verbs.js';
import { component, contract, implementation, isolateGlobals, projectYaml, specs, subsystem, system, tempDir, type } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// The boundary verbs on a family whose references cross in every way the
// platform trial's did: shared types named `contracts.money` (subsystem-dot)
// from every type position — a type field, a contract method's params and
// returns, a type method's structured returns and its prose signature, a
// signatureFrom naming a signature type, an asserted invariant — a part's own
// types self-prefixed (`billing.receipt`), and a published portal restricted
// by a consumers list to a subsystem across the would-be boundary.
//
// Each verb is planned, its plan read, applied, and the family run compared
// with the run before: no new error (family-consistent), every reference
// position respelled to the canonical form across the new boundary, and the
// plan listing exactly what the apply wrote.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
let restore: () => void;
beforeEach(() => {
  restore = isolateGlobals(cleanups);
});
afterEach(() => {
  restore();
  for (const c of cleanups.splice(0).reverse()) c();
  invalidateSpecCache();
});

/**
 * The shop: shared contracts, orders, and a PART billing at services/billing.
 * `upward` adds what no gate reads across a boundary into the parent: a
 * signatureFrom and an asserted invariant of billing naming the parent.
 */
function writeShop(root: string, upward = false): { root: string; part: string } {
  projectYaml(root, { id: 'shop', name: 'Shop', members: { billing: 'services/billing' } });
  system(root, 'Shop');
  // contracts: the shared types.
  subsystem(root, 'Shop', 'contracts');
  type(specs(root, 'contracts', 'types', 'currency_code.yaml'), 'currency_code', [{ name: 'code', type: 'string' }], { subsystem: 'contracts' });
  type(specs(root, 'contracts', 'types', 'money.yaml'), 'money', [{ name: 'amount', type: 'int' }, { name: 'currency', type: 'contracts.currency_code' }], {
    subsystem: 'contracts',
    methods: [{ name: 'add', params: [{ name: 'other', type: 'contracts.money' }], returns: 'contracts.money', description: 'Sum' }],
  });
  type(specs(root, 'contracts', 'types', 'order_id.yaml'), 'order_id', [{ name: 'value', type: 'string' }], { subsystem: 'contracts' });
  type(specs(root, 'contracts', 'types', 'charge_listener.yaml'), 'charge_listener', [], {
    subsystem: 'contracts', kind: 'signature', fields: [], params: [{ name: 'amount', type: 'contracts.money' }], returns: 'void',
  });
  // orders: a portal published only to billing, and a client of billing that asserts billing's invariant and takes a signature from it.
  subsystem(root, 'Shop', 'orders', { publicInterfaces: [{ type: 'Custom', details: 'Orders', component: 'orders_portal', consumers: ['billing'] }] });
  component(root, 'orders', 'orders_portal', 'Portal');
  contract(root, 'orders', 'orders_portal', [{
    name: 'place', description: 'Place an order', params: [{ name: 'total', type: 'contracts.money' }], returns: 'contracts.order_id',
  }]);
  component(root, 'orders', 'orders_client', 'Adapter', ['billing_portal']);
  contract(root, 'orders', 'orders_client', [
    { name: 'settle', description: 'Settle an order', params: [{ name: 'total', type: 'contracts.money' }], returns: 'billing.receipt' },
    { name: 'onReceipt', description: 'Listen for receipts', signatureFrom: 'billing.receipt_listener' },
  ]);
  implementation(root, 'orders', 'orders_client', 'iorders_client', [{
    name: 'settle',
    narrative: [{ stepNumber: 1, description: 'Charge it', type: 'call', targetComponent: 'billing_portal', targetMethod: 'charge', assertsInvariants: ['billing.receipt.positive'] }],
  }]);
  type(specs(root, 'orders', 'types', 'order.yaml'), 'order', [{ name: 'id', type: 'contracts.order_id' }, { name: 'total', type: 'contracts.money' }], {
    subsystem: 'orders', kind: 'entity',
    invariants: [{ id: 'positive_total', description: 'The total is above zero' }],
    methods: [
      { name: 'grandTotal', params: [], returns: 'contracts.money', description: 'The total' },
      { name: 'convert', signature: 'convert(to: contracts.currency_code): contracts.money', returns: 'contracts.money', description: 'Converted' },
    ],
  });
  // billing: the part, its own types self-prefixed, and a client of orders.
  const part = path.join(root, 'services', 'billing');
  subsystem(part, 'Shop', 'billing', { publicInterfaces: [{ type: 'Custom', details: 'Billing', component: 'billing_portal', consumers: ['orders'] }] });
  component(part, 'billing', 'billing_portal', 'Portal');
  contract(part, 'billing', 'billing_portal', [
    { name: 'charge', description: 'Charge an order', params: [{ name: 'order', type: 'orders.order' }], returns: 'billing.receipt' },
    ...(upward ? [{ name: 'onCharge', description: 'Listen for charges', signatureFrom: 'contracts.charge_listener' }] : []),
  ]);
  component(part, 'billing', 'billing_client', 'Adapter', ['orders_portal']);
  contract(part, 'billing', 'billing_client', [{ name: 'reorder', description: 'Reorder', params: [{ name: 'total', type: 'contracts.money' }], returns: 'void' }]);
  implementation(part, 'billing', 'billing_client', 'ibilling_client', [{
    name: 'reorder',
    narrative: [{
      stepNumber: 1, description: 'Place it again', type: 'call', targetComponent: 'orders_portal', targetMethod: 'place',
      ...(upward ? { assertsInvariants: ['orders.order.positive_total'] } : {}),
    }],
  }]);
  type(specs(part, 'billing', 'types', 'receipt.yaml'), 'receipt', [{ name: 'amount', type: 'contracts.money' }, { name: 'order', type: 'contracts.order_id' }], {
    subsystem: 'billing', kind: 'entity',
    invariants: [{ id: 'positive', description: 'The amount is above zero' }],
    methods: [{ name: 'refund', signature: 'refund(): billing.receipt', returns: 'billing.receipt', description: 'Its refund' }],
  });
  type(specs(part, 'billing', 'types', 'receipt_listener.yaml'), 'receipt_listener', [], {
    subsystem: 'billing', kind: 'signature', fields: [], params: [{ name: 'receipt', type: 'billing.receipt' }], returns: 'void',
  });
  return { root, part };
}

/** The family run's errors, each as `code [project] @spec`. */
function errorsOf(root: string): string[] {
  const run = at(root, () => validateFamily({ family: true }));
  return run.issues.filter((i: ValidationIssue) => i.severity === 'error').map((i) => `${i.code} [${i.project ?? ''}] @${i.specId ?? '-'}`).sort();
}

/** Every spec file text under a project's .wai/specs. */
function specTexts(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const base = specs(dir);
  if (!fs.existsSync(base)) return out;
  for (const rel of fs.readdirSync(base, { recursive: true }).map(String).filter((f) => f.endsWith('.yaml'))) {
    out.set(rel.split(path.sep).join('/'), fs.readFileSync(path.join(base, rel), 'utf8'));
  }
  return out;
}

/** The type-position texts of every spec, read structurally (no prose): what a reference respelling may touch. */
function typeTexts(dir: string): string[] {
  const out: string[] = [];
  const walk = (node: unknown, key = ''): void => {
    if (typeof node === 'string') {
      if (['type', 'returns', 'signature', 'signatureFrom', 'assertsInvariants'].includes(key)) out.push(node);
      return;
    }
    if (Array.isArray(node)) for (const n of node) walk(n, key);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k === 'description' ? '' : k);
  };
  for (const text of specTexts(dir).values()) walk(yaml.load(text));
  return out;
}

/** The plan's reference respellings as `from → to`. */
const respellings = (planned: MigrationPlan): string[] => planned.edits.filter((e) => e.reference).map((e) => `${e.reference!.from} → ${e.reference!.to}`);

/**
 * Every `from → to` the plan lists is what the apply wrote: in the spec's own
 * file (found by its kind and id in the project the edit names), `to` stands
 * and no type position still spells `from`.
 */
function planWritten(planned: MigrationPlan, dirOf: (project: string) => string): string[] {
  return planned.edits.filter((e) => e.reference && e.reference.position === 'type').filter((e) => {
    const r = e.reference!;
    const docs = [...specTexts(dirOf(e.project)).values()].map((t) => yaml.load(t) as Record<string, unknown>);
    const doc = docs.find((d) => d?.id === r.specId);
    if (!doc) return true;
    const texts: string[] = [];
    const walk = (node: unknown, key = ''): void => {
      if (typeof node === 'string') {
        if (['type', 'returns', 'signature', 'signatureFrom', 'assertsInvariants'].includes(key)) texts.push(node);
      } else if (Array.isArray(node)) for (const n of node) walk(n, key);
      else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, k);
    };
    walk(doc);
    const tokens = texts.flatMap((t) => t.split(/[^A-Za-z0-9_:.-]+/));
    return !texts.some((t) => t.includes(r.to)) || tokens.includes(r.from);
  }).map((e) => `${e.project}: ${e.detail}`);
}

describe('promote, externalize --as project and rename-alias respell every reference across the boundary', () => {
  it('promote: references respelled both ways at every type position, consumers dropped, exports with from, a pin that is not empty; plan = apply; no new error', () => {
    const { root, part } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'));
    const before = errorsOf(root);

    const planned = plan(root, { verb: 'promote', alias: 'billing' });
    expect(planned.refusals).toEqual([]);
    const listed = respellings(planned);
    // Into the new project, and back out — every type position, including a type method's prose signature.
    expect(listed).toEqual(expect.arrayContaining([
      'billing_portal → billing::billing_portal',
      'orders_portal → shop::orders_portal',
      'contracts.money → shop::money',
      'contracts.order_id → shop::order_id',
      'orders.order → shop::order',
      'billing.receipt → receipt',
      // Into the new project: a type expression, a signatureFrom and an asserted invariant.
      'billing.receipt → billing::receipt',
      'billing.receipt_listener → billing::receipt_listener',
      'billing.receipt.positive → billing::receipt.positive',
    ]));
    expect(planned.edits.map((e) => e.detail).join('\n')).toMatch(/consumers .*billing_portal: orders/);
    expect(planned.edits.map((e) => e.detail).join('\n')).toMatch(/consumers .*orders_portal: billing/);
    migrations_apply(root, planned);

    // Plan = apply: every listed respelling is in the files, and nothing it named is left.
    expect(planWritten(planned, (project) => (project === 'billing' ? part : root))).toEqual([]);
    // No dotted reference crosses the new boundary any more, and the part's own self-prefix is gone.
    expect(typeTexts(part).filter((t) => /\b(contracts|orders|billing)\./.test(t))).toEqual([]);
    // The parent's L0 re-exports each crossing type from its own subsystem (canonical `from:`).
    const l0 = readYamlFile(specs(root, '.index.yaml')) as { publicInterfaces: { from?: string; typeDef?: string }[] };
    expect(l0.publicInterfaces.filter((e) => e.typeDef !== undefined).every((e) => e.from === 'contracts' || e.from === 'orders')).toBe(true);
    // The consumers lists that named across the boundary are gone.
    expect(JSON.stringify(readYamlFile(specs(part, 'billing', '.index.yaml')))).not.toContain('consumers');
    expect(JSON.stringify(readYamlFile(specs(root, 'orders', '.index.yaml')))).not.toContain('consumers');
    // The pin the promote took records what the new project uses.
    const lock = readYamlFile(path.join(part, '.wai', 'externals.lock.yaml')) as { externals: Record<string, { used: Record<string, unknown> }> };
    expect(Object.keys(lock.externals.shop.used).sort()).toEqual(['money', 'order', 'order_id', 'orders_portal']);
    // Family-consistent: no new error.
    expect(newFindings(before, errorsOf(root))).toEqual([]);
  });

  it('externalize --as project: the moved types\' consumers respelled `alias::name`, re-exports complete, a sibling pin re-taken; plan = apply; no new error', () => {
    const { root, part } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'));
    migrate(root, { verb: 'promote', alias: 'billing' });
    const before = errorsOf(root);

    const planned = plan(root, { verb: 'externalize', subsystem: 'contracts', path: 'libs/contracts', as: 'project' });
    expect(planned.refusals).toEqual([]);
    expect(respellings(planned)).toEqual(expect.arrayContaining([
      'contracts.money → contracts::money',
      'contracts.order_id → contracts::order_id',
      'contracts.currency_code → currency_code',
    ]));
    // billing pinned shop: its names only move, so it is re-pinned.
    expect(planned.edits.some((e) => e.kind === 'pin' && /pin shop taken again/.test(e.detail))).toBe(true);
    migrations_apply(root, planned);

    const member = path.join(root, 'libs', 'contracts');
    expect(planWritten(planned, (project) => (project === 'contracts' ? member : root))).toEqual([]);
    expect(typeTexts(root).filter((t) => /\bcontracts\./.test(t))).toEqual([]);
    // Every name the parent's L0 re-exports from the moved subsystem, the member exports.
    const parentL0 = readYamlFile(specs(root, '.index.yaml')) as { publicInterfaces: { from?: string; typeDef?: string }[] };
    const memberL0 = readYamlFile(specs(member, '.index.yaml')) as { publicInterfaces: { typeDef?: string }[] };
    const reExported = parentL0.publicInterfaces.filter((e) => e.from === 'contracts' && e.typeDef).map((e) => e.typeDef!);
    expect(reExported.length).toBeGreaterThan(0);
    expect(reExported.filter((n) => !memberL0.publicInterfaces.some((e) => e.typeDef === n))).toEqual([]);
    expect(newFindings(before, errorsOf(root))).toEqual([]);
    expect(errorsOf(root).filter((e) => /EXTERNAL_INCOMPATIBLE|EXPORT_INVALID/.test(e))).toEqual([]);
    void part;
  });

  it('rename-alias: every `alias::` reference respelled, a type method\'s signature and returns included; no new error', () => {
    const { root } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'));
    migrate(root, { verb: 'promote', alias: 'billing' });
    migrate(root, { verb: 'externalize', subsystem: 'contracts', path: 'libs/contracts', as: 'project' });
    const before = errorsOf(root);

    const planned = plan(root, { verb: 'rename-alias', alias: 'contracts', newAlias: 'shared' });
    expect(planned.refusals).toEqual([]);
    // The order type's methods: a structured returns and a prose signature.
    expect(planned.edits.filter((e) => e.reference?.specId === 'order').map((e) => `${e.reference!.from} → ${e.reference!.to}`))
      .toEqual(expect.arrayContaining(['contracts::money → shared::money', 'contracts::currency_code → shared::currency_code']));
    migrations_apply(root, planned);

    expect(typeTexts(root).filter((t) => t.includes('contracts::'))).toEqual([]);
    expect(newFindings(before, errorsOf(root))).toEqual([]);
  });

  it('promote refuses, writing nothing, a signatureFrom or an asserted invariant that would name the parent — no gate reads either across a boundary', () => {
    const { root } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'), true);
    const planned = plan(root, { verb: 'promote', alias: 'billing' });
    const why = planned.refusals.map((r) => r.detail).join('\n');
    expect(why).toMatch(/takes its signature from "contracts\.charge_listener".*not read across a project boundary/);
    expect(why).toMatch(/asserts the invariant "orders\.order\.positive_total"/);
    expect(planned.changes).toEqual([]);
  });

  it('demote restores, onto a consumers list that still restricts a surface, the subsystems across the old boundary that use it; plan = apply; no new error', () => {
    const { root, part } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'));
    // orders publishes its portal to billing (across the would-be boundary) AND to contracts (inside it).
    const ordersFile = specs(root, 'orders', '.index.yaml');
    const orders = readYamlFile(ordersFile) as { publicInterfaces: { consumers?: string[] }[] };
    orders.publicInterfaces[0].consumers = ['billing', 'contracts'];
    writeYamlFile(ordersFile, orders);
    invalidateSpecCache();
    const consumersOf = (dir: string, sub: string): string[] | undefined =>
      (readYamlFile(specs(dir, sub, '.index.yaml')) as { publicInterfaces: { consumers?: string[] }[] }).publicInterfaces[0].consumers;
    const before = errorsOf(root);

    migrate(root, { verb: 'promote', alias: 'billing' });
    invalidateSpecCache();
    // Promote: only the entry across the new boundary is dropped; billing's own list went whole.
    expect(consumersOf(root, 'orders')).toEqual(['contracts']);
    expect(consumersOf(part, 'billing')).toBeUndefined();

    const planned = plan(root, { verb: 'demote', alias: 'billing' });
    expect(planned.refusals).toEqual([]);
    expect(planned.edits.map((e) => e.detail).join('\n')).toMatch(/consumers across the old boundary restored: orders orders_portal: billing/);
    migrations_apply(root, planned);

    // The restriction still holds, and billing — which uses the portal — is admitted again.
    expect(consumersOf(root, 'orders')).toEqual(['contracts', 'billing']);
    // A list promote removed whole is not recreated: absent (any subsystem may depend) is what it reads as.
    expect(consumersOf(part, 'billing')).toBeUndefined();
    // Every `alias::` token of a type expression or an asserted invariant is a local reference again.
    expect([...typeTexts(root), ...typeTexts(part)].filter((t) => /\b(billing|shop)::/.test(t))).toEqual([]);
    expect(typeTexts(root)).toEqual(expect.arrayContaining(['billing.receipt', 'billing.receipt.positive']));
    expect(newFindings(before, errorsOf(root))).toEqual([]);
  });

  it('a dotted reference through an alias is never accepted silently: UNDEFINED_TYPE_REFERENCE naming the `alias::name` to write', () => {
    const { root } = writeShop(path.join(tempDir(cleanups, 'wairon-respell-'), 'shop'));
    migrate(root, { verb: 'promote', alias: 'billing' });
    migrate(root, { verb: 'externalize', subsystem: 'contracts', path: 'libs/contracts', as: 'project' });
    const file = specs(root, 'orders', 'types', 'order.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('type: contracts::order_id', 'type: contracts.order_id'));
    invalidateSpecCache();
    const run = at(root, () => validateFamily({ family: true }));
    const finding = run.issues.find((i) => i.code === 'UNDEFINED_TYPE_REFERENCE' && i.message.includes('contracts.order_id'));
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('write `contracts::order_id`');
  });
});

/** Apply a confirmed plan from the root it was planned at, failing loudly when it does not commit. */
function migrations_apply(root: string, planned: MigrationPlan): void {
  const report = at(root, () => migrationsPortal().apply(planned));
  if (!report.applied) throw new Error(`not applied: ${report.outcome?.failure ?? planned.refusals.map((r) => r.detail).join('; ')}`);
  invalidateSpecCache();
}

/** The migration portal, imported lazily so the test file reads top-down. */
function migrationsPortal(): typeof import('../../src/migrations/index.js') {
  return migrationsModule;
}
import * as migrationsModule from '../../src/migrations/index.js';
