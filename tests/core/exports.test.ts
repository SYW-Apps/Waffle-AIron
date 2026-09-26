import { describe, it, expect } from 'vitest';
import { resolveProjectTable, resolveSubsystemTables } from '../../src/core/exports.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, SystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The export index's resolution, over hand-built specs: every table resolved
// the way a module resolver resolves `export … from`.
// ---------------------------------------------------------------------------

const sub = (id: string, publicInterfaces: unknown[]): SubsystemSpec =>
  ({ id, name: id, description: id, parentSystem: 'Shop', publicInterfaces, status: 'complete' }) as unknown as SubsystemSpec;
const comp = (id: string, subsystem: string, componentType = 'Portal'): ComponentSpec =>
  ({ id, name: id, description: id, subsystem, componentType, owns: [], dependsOn: [] }) as unknown as ComponentSpec;
const intf = (id: string, component: string): InterfaceSpec =>
  ({ id, name: id, description: id, component, methods: [] }) as unknown as InterfaceSpec;
const type = (id: string, subsystem?: string): TypeSpec =>
  ({ id, name: id, kind: 'value-object', fields: [], methods: [], ...(subsystem ? { subsystem } : {}) }) as unknown as TypeSpec;
const system = (publicInterfaces: unknown[]): SystemSpec =>
  ({ name: 'Shop', vision: 'v', boundaries: [], globalRequirements: [], databases: [], publicInterfaces }) as unknown as SystemSpec;

const COMPONENTS = [
  comp('payment_portal', 'payments'),
  comp('refund_portal', 'payments'),
  comp('payment_math', 'payments', 'Orchestrator'),
  comp('shipping_portal', 'shipping'),
];
const INTERFACES = [intf('ipayments', 'payment_portal'), intf('ipayment_admin', 'payment_portal'), intf('ishipping', 'shipping_portal')];
const TYPES = [type('money', 'payments'), type('money', 'shipping')];

function tables(subsystems: SubsystemSpec[]) {
  return resolveSubsystemTables(subsystems, COMPONENTS, INTERFACES, TYPES);
}

describe('export index: subsystem tables', () => {
  it('binds own items under `as ?? interface ?? component`, with the target stereotype', () => {
    const t = tables([sub('payments', [
      { type: 'REST', details: 'pay', component: 'payment_portal' },
      { type: 'REST', details: 'admin', component: 'payment_portal', interface: 'ipayment_admin' },
      { type: 'REST', details: 'refunds', component: 'refund_portal', as: 'refunds' },
    ])]).get('payments')!;
    expect(t.entries.map((e) => e.publicName).sort()).toEqual(['ipayment_admin', 'payment_portal', 'refunds']);
    expect(t.entries.find((e) => e.publicName === 'ipayment_admin')?.interface).toBe('ipayment_admin');
    expect(t.entries.every((e) => e.componentType === 'Portal' && e.via.length === 0)).toBe(true);
    expect(t.problems).toEqual([]);
  });

  it('follows a named re-export to its canonical target, renamed and inheriting type and details', () => {
    const all = tables([
      sub('payments', [{ type: 'REST', details: 'Payments API', component: 'payment_portal' }]),
      sub('facade', [{ from: 'payments', component: 'payment_portal', as: 'pay' }]),
    ]);
    const [entry] = all.get('facade')!.entries;
    expect(entry).toMatchObject({ publicName: 'pay', component: 'payment_portal', source: 'payments', type: 'REST', details: 'Payments API', via: ['payments'] });
  });

  it('brings a wildcard source in under its public names, and an explicit entry shadows a wildcard name', () => {
    const all = tables([
      sub('payments', [{ type: 'REST', details: 'pay', component: 'payment_portal', as: 'api' }]),
      sub('shipping', [{ type: 'REST', details: 'ship', component: 'shipping_portal', as: 'api' }]),
      sub('facade', [{ from: 'payments' }, { from: 'shipping' }, { from: 'shipping', component: 'shipping_portal', as: 'api' }]),
    ]);
    const facade = all.get('facade')!;
    expect(facade.entries).toHaveLength(1);
    expect(facade.entries[0].component).toBe('shipping_portal');
    expect(facade.problems).toEqual([]);
  });

  it('leaves a name two wildcards bind to different targets out, as a duplicate; the same target twice is no clash', () => {
    const clash = tables([
      sub('payments', [{ type: 'REST', details: 'pay', component: 'payment_portal', as: 'api' }]),
      sub('shipping', [{ type: 'REST', details: 'ship', component: 'shipping_portal', as: 'api' }]),
      sub('facade', [{ from: 'payments' }, { from: 'shipping' }]),
    ]).get('facade')!;
    expect(clash.entries).toEqual([]);
    expect(clash.problems.map((p) => p.kind)).toEqual(['duplicate']);

    const same = tables([
      sub('payments', [{ type: 'REST', details: 'pay', component: 'payment_portal' }]),
      sub('middle', [{ from: 'payments' }]),
      sub('facade', [{ from: 'payments' }, { from: 'middle' }]),
    ]).get('facade')!;
    expect(same.entries).toHaveLength(1);
    expect(same.problems).toEqual([]);
  });

  it('resolves a wildcard cycle to the union and records it once', () => {
    const all = tables([
      sub('payments', [{ type: 'REST', details: 'pay', component: 'payment_portal' }, { from: 'shipping' }]),
      sub('shipping', [{ type: 'REST', details: 'ship', component: 'shipping_portal' }, { from: 'payments' }]),
    ]);
    for (const id of ['payments', 'shipping']) {
      expect(all.get(id)!.entries.map((e) => e.component).sort()).toEqual(['payment_portal', 'shipping_portal']);
    }
    const cycles = [...all.values()].flatMap((t) => t.problems).filter((p) => p.kind === 'wildcard-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0].targets).toEqual(['payments', 'shipping']);
  });

  it('reports a named chain that never grounds as a named cycle', () => {
    const all = tables([
      sub('payments', [{ from: 'shipping', component: 'refund_portal' }]),
      sub('shipping', [{ from: 'payments', component: 'refund_portal' }]),
    ]);
    const kinds = [...all.values()].flatMap((t) => t.problems).map((p) => p.kind);
    expect(kinds).toEqual(['named-cycle', 'named-cycle']);
  });

  it('binds an item its source owns but does not export leniently, and reports it', () => {
    const facade = tables([
      sub('payments', []),
      sub('facade', [{ from: 'payments', component: 'payment_portal' }]),
    ]).get('facade')!;
    expect(facade.entries.map((e) => e.publicName)).toEqual(['payment_portal']);
    expect(facade.problems.map((p) => p.kind)).toEqual(['invalid']);
  });

  it('reports a missing source, a foreign own type, a bad public name and an unconsumable re-export', () => {
    const all = tables([
      sub('payments', [
        { type: 'Custom', details: 'math', component: 'payment_math' },
        { typeDef: 'money', as: 'Money' },
      ]),
      sub('facade', [
        { from: 'nowhere' },
        { typeDef: 'money' },
        { from: 'payments', component: 'payment_math' },
      ]),
    ]);
    expect(all.get('payments')!.problems.map((p) => p.kind)).toEqual(['invalid']); // "Money" breaks the grammar
    expect(all.get('payments')!.entries.map((e) => e.publicName)).toContain('Money'); // …but stays bound
    expect(all.get('facade')!.problems.map((p) => p.kind).sort()).toEqual(['invalid', 'invalid', 'unconsumable']);
  });

  it('exports a type by name, and re-exports it from its owner', () => {
    const all = tables([
      sub('payments', [{ typeDef: 'money' }]),
      sub('facade', [{ from: 'payments', typeDef: 'money', as: 'currency-amount' }]),
    ]);
    expect(all.get('facade')!.entries).toEqual([
      expect.objectContaining({ publicName: 'currency-amount', kind: 'type', typeDef: 'money', source: 'payments' }),
    ]);
  });
});

describe('export index: the project table', () => {
  const SUBSYSTEMS = [
    sub('payments', [
      { type: 'REST', details: 'Payments API', component: 'payment_portal' },
      { type: 'Custom', details: 'math', component: 'payment_math' },
    ]),
    sub('shipping', [{ type: 'REST', details: 'Shipping API', component: 'shipping_portal', interface: 'ishipping' }]),
  ];
  const project = (entries: unknown[]) =>
    resolveProjectTable(system(entries), SUBSYSTEMS, COMPONENTS, INTERFACES, TYPES, tables(SUBSYSTEMS));

  it('reads a legacy entry as a re-export and keeps its published name: id, then interface, then component', () => {
    const t = project([
      { id: 'payments-api', subsystem: 'payments', component: 'payment_portal', audience: 'external' },
      { subsystem: 'shipping', component: 'shipping_portal', interface: 'ishipping' },
      { component: 'payment_portal' },
    ]);
    const names = t.entries.map((e) => e.publicName).sort();
    expect(names).toEqual(['ishipping', 'payment_portal', 'payments-api']);
    expect(t.entries.find((e) => e.publicName === 'payments-api')).toMatchObject({ audience: 'external', type: 'REST', details: 'Payments API' });
    expect(t.entries.find((e) => e.publicName === 'payment_portal')?.audience).toBe('instance'); // the default
  });

  it('narrows to an interface the source exports its component under, and infers the source from an interface alone', () => {
    const t = project([{ id: 'ship', interface: 'ishipping' }]);
    expect(t.entries).toEqual([expect.objectContaining({ publicName: 'ship', component: 'shipping_portal', interface: 'ishipping', source: 'shipping' })]);
  });

  it('carries a wildcard entry\'s audience onto every name it brings in, and flags an unconsumable target', () => {
    const t = project([{ from: 'payments', audience: 'partner' }]);
    expect(t.entries.every((e) => e.audience === 'partner')).toBe(true);
    expect(t.problems.map((p) => p.kind)).toEqual(['unconsumable']);
  });

  it('reports an entry that names no source', () => {
    const t = project([{ id: 'partner-api', type: 'REST', details: 'd' }]);
    expect(t.entries).toEqual([]);
    expect(t.problems).toEqual([expect.objectContaining({ kind: 'invalid', publicName: 'partner-api' })]);
  });
});
