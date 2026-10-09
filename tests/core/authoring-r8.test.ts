import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot, setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSpec,
  invalidateSpecCache,
  loadComponentSpec,
  loadImplementationSpec,
  loadInterfaceSpec,
  loadSpec,
  loadSubsystemSpec,
  loadSystemSpec,
  loadTypeSpecs,
  scanAllSpecs,
  updateSpec,
} from '../../src/core/specs.js';
import { deleteSpec, moveMethods, moveSpec, updateSpecGated, writeSpec } from '../../src/core/authoring.js';
import { createMember, provisionProject, renameComponent, renameSpecId, publishedUsesOf } from '../../src/core/provision.js';
import { specIndexMethodReferences } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Round-8 trial findings on the authoring tools (platform BLOCKER, tinkerer,
// solo-app): every test here failed on dev.112.
//
//  - A root session deleted a MEMBER project's spec (sdd_delete_spec
//    payments_svc::payment_store, no force), while sdd_update_spec on the same
//    id was refused; a member type answered "file may not exist".
//  - A cross-subsystem Portal -> Store edge was written ("1 change").
//  - A system-level type's subsystem was accepted through a delta.
//  - Deleting a contract method through a delta left its implementation entry.
//  - A producer-side delete and a published-verb removal named no consumer.
//  - sdd_rename_component left a non-derived implementation in the old folder.
//  - A reorder answered "reordered" and "NO EFFECT: already held"; a respelled
//    new field read "the write did not store it".
// ---------------------------------------------------------------------------

const now = '2026-10-09T00:00:00.000Z';
const roots: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const component = (id: string, subsystem: string, componentType: string, extra: Record<string, unknown> = {}): void => {
  saveSpec('component', {
    id, name: id, description: `${id} component`, subsystem, componentType, owns: [], dependsOn: [],
    status: 'complete', createdAt: now, updatedAt: now, ...extra,
  } as never);
};
const subsystem = (id: string, extra: Record<string, unknown> = {}): void => {
  saveSpec('subsystem', {
    id, name: id, description: `${id} subsystem`, parentSystem: 'Shop', publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: now, updatedAt: now, ...extra,
  } as never);
};

/** Every spec file under a project's specs folder, relative and sorted. */
function files(dir: string): string[] {
  const root = path.join(dir, '.wai', 'specs');
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

/** A root project "Shop" (orders, an Orchestrator) with a member project "payments" holding a Store, its contract, implementation and a type. */
function family(): { root: string; member: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r8-family-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  setProjectRoot(root);
  provisionProject('Shop');
  subsystem('orders');
  component('order_flow', 'orders', 'Orchestrator');
  createMember('payments', 'services/payments', 'Payments', 'project');
  const member = path.join(root, 'services', 'payments');
  runWithProjectRoot(member, () => {
    invalidateSpecCache();
    saveSpec('subsystem', {
      id: 'payments', name: 'payments', description: 'payments subsystem', parentSystem: 'payments', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('component', {
      id: 'payment_store', name: 'payment_store', description: 'store', subsystem: 'payments', componentType: 'Store', durability: 'ram-projection',
      owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('interface', {
      id: 'ipayment_store', name: 'Store', description: 'store', component: 'payment_store',
      methods: [{ name: 'put', description: 'puts', params: [{ name: 'id', type: 'string' }], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('implementation', {
      id: 'payment_store_mem', name: 'Mem', description: 'mem', contract: 'ipayment_store', methods: [{ name: 'put', narrative: [] }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('type', { kind: 'value-object', id: 'sku_id', name: 'SkuId', fields: [{ name: 'v', type: 'string' }], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
  });
  setProjectRoot(root);
  invalidateSpecCache();
  return { root, member };
}

/** The member's key in the bound tree, as the loader qualifies its specs. */
function memberKey(): string {
  const stored = scanAllSpecs().components.find((c) => c.id.endsWith('::payment_store'));
  expect(stored, 'the root reads the member').toBeDefined();
  return stored!.id.slice(0, stored!.id.lastIndexOf('::'));
}

describe('BLOCKER: every authored write refuses a spec of another project, the dry run included', () => {
  it('sdd_delete_spec on a member component is refused (dry run and real) and the member is untouched', () => {
    const { member } = family();
    const key = memberKey();
    const before = files(member);
    for (const dryRun of [true, false]) {
      expect(() => deleteSpec('component', `${key}::payment_store`, dryRun))
        .toThrow(/chained-spec: ".*payment_store" lives in another project; delete it from that project's own root.*services\/payments.*sdd_delete_spec component payment_store there\. Nothing was written/s);
    }
    expect(files(member)).toEqual(before);
  });

  it('a member TYPE by its key, and by an alias the root declares, gets the same refusal, never "file may not exist"', () => {
    const { member } = family();
    const key = memberKey();
    const before = files(member);
    expect(() => deleteSpec('type', `${key}::sku_id`)).toThrow(/chained-spec:.*another project/s);
    expect(() => deleteSpec('type', 'payments::sku_id', true)).toThrow(/chained-spec:.*another project/s);
    expect(files(member)).toEqual(before);
  });

  it('a create under a member parent, an update, a method move and a spec move are refused the same way', () => {
    const { member } = family();
    const key = memberKey();
    const before = files(member);
    expect(() => writeSpec({
      kind: 'interface',
      spec: { id: 'iextra', name: 'X', description: 'x', component: `${key}::payment_store`, methods: [] } as never,
      fields: ['id', 'name', 'description', 'component', 'methods'],
    })).toThrow(/chained-spec:.*sdd_define_interface/s);
    expect(() => writeSpec({
      kind: 'component',
      spec: { id: 'intruder', name: 'I', description: 'i', subsystem: `${key}::payments`, componentType: 'Orchestrator', owns: [], dependsOn: [] } as never,
      fields: ['id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn'],
    })).toThrow(/chained-spec:.*sdd_add_component/s);
    expect(() => updateSpecGated('component', `${key}::payment_store`, { description: 'x' }, true)).toThrow(/chained-spec:.*update it from/s);
    expect(() => moveMethods('order_flow', `${key}::payment_store`, ['run'])).toThrow(/chained-spec:.*sdd_move_methods/s);
    expect(() => moveSpec('component', `${key}::payment_store`, 'orders', true)).toThrow(/chained-spec/);
    expect(() => renameSpecId('interface', `${key}::ipayment_store`, 'ipay')).toThrow(/chained-spec/);
    expect(files(member)).toEqual(before);
  });
});

describe('a delete of an id nothing holds says what it might have meant', () => {
  it('names the kind that holds it, the subsystem::id form of a type, and the ids of the kind', () => {
    family();
    expect(() => deleteSpec('component', 'orders')).toThrow(/spec-missing: no component has the id "orders" — nothing was deleted\. "orders" is a subsystem — pass kind "subsystem".*Its components: order_flow/s);
    expect(() => deleteSpec('component', 'nope', true)).toThrow(/spec-missing: no component has the id "nope"/);
    saveSpec('type', { kind: 'value-object', id: 'principal', name: 'P', subsystem: 'orders', fields: [], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    expect(() => deleteSpec('type', 'orders.principal')).toThrow(/"principal" or "orders::principal"/);
  });
});

/** One project, two subsystems: a Portal in links, a Store and a Portal in analytics. */
function twoSubsystems(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r8-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  setProjectRoot(root);
  provisionProject('Shop');
  subsystem('links');
  subsystem('analytics');
  component('links_portal', 'links', 'Portal', { transport: 'HTTP' });
  component('links_flow', 'links', 'Orchestrator');
  component('stats_store', 'analytics', 'Store', { durability: 'ram-projection' });
  component('stats_portal', 'analytics', 'Portal', { transport: 'HTTP' });
  invalidateSpecCache();
  return root;
}

describe('the write gate refuses a cross-subsystem edge into a non-Portal (tinkerer top 1)', () => {
  it('a Portal -> Store edge across subsystems is refused on the dry run and the write, with validate\'s codes', () => {
    twoSubsystems();
    for (const dryRun of [true, false]) {
      expect(() => updateSpecGated('component', 'links_portal', { dependsOn: ['stats_store'] }, dryRun))
        .toThrow(/would introduce.*CROSS_SUBSYSTEM_NON_ADAPTER.*CROSS_SUBSYSTEM_PRIVATE_ACCESS.*Nothing was written/s);
    }
    invalidateSpecCache();
    expect(loadComponentSpec('links_portal')?.dependsOn).toEqual([]);
    expect(() => updateSpecGated('component', 'links_flow', { dependsOn: ['stats_store'] })).toThrow(/CROSS_SUBSYSTEM_NON_ADAPTER/);
  });

  it('an edge into another subsystem\'s Portal is curable — written, and named as a warning', () => {
    twoSubsystems();
    const report = updateSpecGated('component', 'links_flow', { dependsOn: ['stats_portal'] });
    expect(report.written).toBe(true);
    expect(report.notices.some((n) => n.startsWith('CROSS_SUBSYSTEM_NON_ADAPTER'))).toBe(true);
  });
});

describe('a delta never moves a type (solo-app)', () => {
  it('a system-level type adopting a subsystem is refused, naming sdd_move_spec', () => {
    twoSubsystems();
    saveSpec('type', { kind: 'value-object', id: 'streak', name: 'Streak', fields: [{ name: 'n', type: 'int' }], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    for (const dryRun of [true, false]) {
      expect(() => updateSpecGated('type', 'streak', { subsystem: 'links' }, dryRun)).toThrow(/"subsystem" is where the type lives.*sdd_move_spec/s);
    }
    expect(() => updateSpecGated('component', 'links_flow', { subsystem: 'analytics' })).toThrow(/sdd_move_spec \(kind component\)/);
  });
});

/** A Portal verb forwarding nothing, an Orchestrator method its narrative calls, both realized; the Portal exported. */
function contractTree(): string {
  const root = twoSubsystems();
  saveSpec('interface', {
    id: 'ilinks_portal', name: 'Links', description: 'links', component: 'links_portal',
    methods: [
      { name: 'shorten', description: 's', params: [{ name: 'url', type: 'string' }], returns: 'string' },
      { name: 'clearReminder', description: 'c', params: [], returns: 'void' },
    ],
    status: 'complete', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('implementation', {
    id: 'links_portal_http', name: 'Http', description: 'h', contract: 'ilinks_portal',
    methods: [
      { name: 'shorten', narrative: [{ stepNumber: 1, description: 'call', type: 'call', targetComponent: 'links_flow', targetMethod: 'run' }] },
      { name: 'clearReminder', narrative: [] },
    ],
    status: 'complete', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('interface', {
    id: 'ilinks_flow', name: 'Flow', description: 'f', component: 'links_flow',
    methods: [{ name: 'run', description: 'r', params: [], returns: 'void' }, { name: 'idle', description: 'i', params: [], returns: 'void' }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as never);
  saveSpec('implementation', {
    id: 'links_flow_impl', name: 'Impl', description: 'i', contract: 'ilinks_flow',
    methods: [{ name: 'run', narrative: [] }, { name: 'idle', narrative: [] }], status: 'complete', createdAt: now, updatedAt: now,
  } as never);
  updateSpec('subsystem', 'links', { publicInterfaces: [{ component: 'links_portal', interface: 'ilinks_portal', details: 'The link API' }] });
  invalidateSpecCache();
  return root;
}

describe('removing a contract method takes its implementation entry with it (solo-app)', () => {
  it('a delta deleting a method cascades the entry, on the dry run and the write, and reports what it published', () => {
    contractTree();
    const dry = updateSpecGated('interface', 'ilinks_portal', { methods: [{ name: 'clearReminder', action: 'delete' }] }, true);
    expect(dry.cascaded).toEqual(['links_portal_http.clearReminder']);
    expect(dry.published?.map((u) => u.publicName)).toEqual(['ilinks_portal']);
    invalidateSpecCache();
    expect((loadSpec('implementation', 'links_portal_http') as { methods: { name: string }[] }).methods.map((m) => m.name)).toEqual(['shorten', 'clearReminder']);
    const real = updateSpecGated('interface', 'ilinks_portal', { methods: [{ name: 'clearReminder', action: 'delete' }] });
    expect(real.cascaded).toEqual(['links_portal_http.clearReminder']);
    invalidateSpecCache();
    expect((loadSpec('implementation', 'links_portal_http') as { methods: { name: string }[] }).methods.map((m) => m.name)).toEqual(['shorten']);
  });

  it('is refused while another spec still calls the method, naming the step', () => {
    contractTree();
    expect(() => updateSpecGated('interface', 'ilinks_flow', { methods: [{ name: 'run', action: 'delete' }] }, true))
      .toThrow(/Refusing to remove method "run" from contract "ilinks_flow".*implementation "links_portal_http" \(methods\.shorten\.narrative\.step 1\).*Nothing was written/s);
    // An uncalled one goes, with its entry.
    expect(updateSpecGated('interface', 'ilinks_flow', { methods: [{ name: 'idle', action: 'delete' }] }).cascaded).toEqual(['links_flow_impl.idle']);
  });

  it('a contract re-authored without a method cascades the same way', () => {
    contractTree();
    const receipt = writeSpec({
      kind: 'interface',
      spec: { id: 'ilinks_flow', name: 'Flow', description: 'f', component: 'links_flow', methods: [{ name: 'run', description: 'r', params: [], returns: 'void' }] } as never,
      fields: ['id', 'name', 'description', 'component', 'methods'],
    });
    expect(receipt.cascaded).toEqual(['links_flow_impl.idle']);
    invalidateSpecCache();
    expect(loadImplementationSpec('links_flow_impl')?.methods.map((m) => m.name)).toEqual(['run']);
  });

  it('spec_index.methodReferencesTo names a step, a declared call and a signature source', () => {
    contractTree();
    const refs = specIndexMethodReferences(scanAllSpecs({ memberDepth: 0 }), 'links_flow', ['run']);
    expect(refs.map((r) => `${r.id} ${r.position} -> ${r.target.id}`)).toEqual(['links_portal_http methods.shorten.narrative.step 1 -> ilinks_flow']);
  });
});

describe('a deletion reports what it takes from consumers (platform)', () => {
  it('a component exported at L1 is published, read before it goes', () => {
    contractTree();
    updateSpec('subsystem', 'links', { publicInterfaces: [{ component: 'links_portal', interface: 'ilinks_portal', action: 'delete' }] });
    updateSpec('subsystem', 'analytics', { publicInterfaces: [{ component: 'stats_portal', details: 'The stats API' }] });
    saveSpec('interface', {
      id: 'istats_portal', name: 'S', description: 's', component: 'stats_portal',
      methods: [{ name: 'top', description: 't', params: [], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    const plan = deleteSpec('component', 'stats_portal', true);
    expect(plan.published.map((u) => `${u.publicName}: ${u.members.join(',')}`)).toEqual(['stats_portal: top']);
    expect(publishedUsesOf([{ kind: 'component', id: 'links_flow' }], [])).toEqual([]);
  });
});

describe('sdd_rename_component moves every file the component owns (platform, tinkerer)', () => {
  it('an implementation whose id is not derived from the component\'s follows it to the new folder', () => {
    const root = twoSubsystems();
    saveSpec('interface', {
      id: 'istats_store', name: 'S', description: 's', component: 'stats_store',
      methods: [{ name: 'get', description: 'g', params: [], returns: 'void' }], status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    saveSpec('implementation', {
      id: 'memory_stats_store', name: 'Mem', description: 'm', contract: 'istats_store', methods: [{ name: 'get', narrative: [] }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as never);
    invalidateSpecCache();
    expect(files(root).filter((f) => f.includes('stats_store/'))).toEqual(['analytics/stats_store/.implementation.yaml', 'analytics/stats_store/.index.yaml', 'analytics/stats_store/.interface.yaml']);
    renameComponent('stats_store', 'hit_counter_store');
    invalidateSpecCache();
    expect(files(root).filter((f) => f.includes('stats_store'))).toEqual([]);
    expect(files(root).filter((f) => f.includes('hit_counter_store/'))).toEqual([
      'analytics/hit_counter_store/.implementation.yaml', 'analytics/hit_counter_store/.index.yaml', 'analytics/hit_counter_store/.interface.yaml',
    ]);
    expect(loadImplementationSpec('memory_stats_store')?.contract).toBe('ihit_counter_store');
  });
});

describe('sdd_rename_spec renames a contract or an implementation on its own', () => {
  it('a contract: every implementation and export entry follows, the published name kept', () => {
    contractTree();
    const dry = renameSpecId('interface', 'ilinks_portal', 'ishort_portal', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.rewritten.sort()).toEqual(['links', 'links_portal_http']);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ilinks_portal')).not.toBeNull();
    const report = renameSpecId('interface', 'ilinks_portal', 'ishort_portal');
    expect(report.keptPublicNames).toEqual(['ilinks_portal']);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ilinks_portal')).toBeNull();
    expect(loadInterfaceSpec('ishort_portal')?.previousIds).toEqual(['ilinks_portal']);
    expect(loadImplementationSpec('links_portal_http')?.contract).toBe('ishort_portal');
    expect(loadSubsystemSpec('links')?.publicInterfaces[0]).toMatchObject({ interface: 'ishort_portal', as: 'ilinks_portal' });
  });

  it('an implementation: moved under its new id, its trace kept; refusals name the right tool', () => {
    contractTree();
    renameSpecId('implementation', 'links_flow_impl', 'links_flow_core');
    invalidateSpecCache();
    expect(loadImplementationSpec('links_flow_impl')).toBeNull();
    expect(loadImplementationSpec('links_flow_core')?.previousIds).toEqual(['links_flow_impl']);
    expect(() => renameSpecId('component', 'links_flow', 'x')).toThrow(/invalid-kind:.*sdd_rename_component/);
    expect(() => renameSpecId('interface', 'ilinks_flow', 'flow')).toThrow(/invalid-id:.*beginning with "i"/);
    expect(() => renameSpecId('interface', 'inope', 'iother')).toThrow(/spec-missing/);
  });
});

describe('sdd_move_spec moves a component or a type with what follows it', () => {
  it('a component takes its contract, implementation, export entry and lifecycle entrypoint; the dry run writes nothing', () => {
    const root = contractTree();
    updateSpec('subsystem', 'links', { lifecycle: [{ phase: 'init', component: 'links_flow', method: 'run' }] });
    invalidateSpecCache();
    const before = files(root);
    const dry = moveSpec('component', 'links_flow', 'analytics', true);
    expect(dry.moved.map((r) => `${r.kind}:${r.id}`)).toEqual(['component:links_flow', 'interface:ilinks_flow', 'implementation:links_flow_impl']);
    expect(files(root)).toEqual(before);
    // The Portal still depending on it becomes a cross-subsystem edge into an Orchestrator: refused.
    updateSpec('component', 'links_portal', { dependsOn: ['links_flow'] });
    invalidateSpecCache();
    expect(() => moveSpec('component', 'links_flow', 'analytics')).toThrow(/Refused: moving component "links_flow".*CROSS_SUBSYSTEM/s);
    updateSpec('component', 'links_portal', { dependsOn: [{ value: 'links_flow', action: 'delete' }] });
    invalidateSpecCache();
    moveSpec('component', 'links_flow', 'analytics');
    invalidateSpecCache();
    expect(loadComponentSpec('links_flow')?.subsystem).toBe('analytics');
    expect(files(root).filter((f) => f.includes('links_flow/'))).toEqual([
      'analytics/links_flow/.implementation.yaml', 'analytics/links_flow/.index.yaml', 'analytics/links_flow/.interface.yaml',
    ]);
    expect(loadSubsystemSpec('links')?.lifecycle ?? []).toEqual([]);
    expect(loadSubsystemSpec('analytics')?.lifecycle).toEqual([expect.objectContaining({ component: 'links_flow', method: 'run' })]);
  });

  it('a type takes its file and every reference qualified by its old subsystem; a pattern member and a type id clash are refused', () => {
    const root = twoSubsystems();
    saveSpec('type', { kind: 'value-object', id: 'hit', name: 'Hit', subsystem: 'links', fields: [{ name: 'n', type: 'int' }], methods: [], createdAt: now, updatedAt: now } as never);
    saveSpec('type', { kind: 'value-object', id: 'report', name: 'Report', subsystem: 'analytics', fields: [{ name: 'hits', type: 'list<links::hit>' }], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    const report = moveSpec('type', 'links::hit', 'analytics');
    expect(report.rewritten).toEqual(['report']);
    invalidateSpecCache();
    const types = loadTypeSpecs();
    expect(types.find((t) => t.id === 'hit')?.subsystem).toBe('analytics');
    expect(types.find((t) => t.id === 'report')?.fields[0].type).toBe('list<analytics::hit>');
    expect(files(root).some((f) => f.startsWith('links/') && f.includes('hit'))).toBe(false);
    component('owned_store', 'links', 'Store', { durability: 'ram-projection' });
    component('owning_repo', 'links', 'Repository', { owns: ['owned_store'] });
    invalidateSpecCache();
    expect(() => moveSpec('component', 'owned_store', 'analytics')).toThrow(/owned:.*move "owning_repo"/);
    expect(() => moveSpec('component', 'links_flow', 'nowhere')).toThrow(/subsystem-missing:.*Known subsystems: analytics, links/);
  });
});

describe('the change report says what the write did (tinkerer, solo-app)', () => {
  it('a reorder is "reordered" and never "NO EFFECT: already held"', () => {
    twoSubsystems();
    updateSpec('system', 'system', { globalRequirements: ['one', 'two', 'three'] });
    const report = updateSpec('system', 'system', { globalRequirements: ['three', 'two', 'one'] });
    expect(report.changes.map((c) => c.change)).toEqual(['reordered']);
    expect(report.ineffective).toEqual([]);
  });

  it('a new field whose type was respelled reads as stored, with its respelling, never as dropped', () => {
    twoSubsystems();
    saveSpec('type', { kind: 'value-object', id: 'probe_holder', name: 'P', fields: [{ name: 'a', type: 'int' }], methods: [], createdAt: now, updatedAt: now } as never);
    invalidateSpecCache();
    const report = updateSpecGated('type', 'probe_holder', { fields: [{ name: 'probe', type: 'string[]' }] });
    expect(report.respellings.map((r) => `${r.written} -> ${r.stored}`)).toEqual(['string[] -> list<string>']);
    expect(report.ineffective).toEqual([]);
  });
});

describe('sdd_add_type takes a dry run', () => {
  it('answers the receipt the write would give and writes nothing; refused exactly as the write', () => {
    const root = twoSubsystems();
    const before = files(root);
    const receipt = writeSpec({
      kind: 'type', dryRun: true,
      spec: { kind: 'value-object', id: 'money', name: 'Money', fields: [{ name: 'cents', type: 'int64', optional: false }], methods: [] } as never,
      fields: ['kind', 'id', 'name', 'fields', 'methods'],
    });
    expect(receipt.dryRun).toBe(true);
    expect(files(root)).toEqual(before);
    let dry = '';
    let real = '';
    const bad = { kind: 'value-object', id: 'bad', name: 'Bad', fields: [{ name: 'n', type: 'number', optional: false }], methods: [] };
    try { writeSpec({ kind: 'type', dryRun: true, spec: bad as never, fields: ['kind', 'id', 'name', 'fields', 'methods'] }); } catch (e) { dry = String(e); }
    try { writeSpec({ kind: 'type', spec: bad as never, fields: ['kind', 'id', 'name', 'fields', 'methods'] }); } catch (e) { real = String(e); }
    expect(dry).toMatch(/TYPE_NOT_NEUTRAL/);
    expect(dry).toBe(real);
  });
});

describe('`constructor` as a component id (accepted since round 5) keeps working', () => {
  it('renames to it, moves it, deletes it and the tree reads it', () => {
    contractTree();
    renameComponent('links_flow', 'constructor');
    invalidateSpecCache();
    expect(loadComponentSpec('constructor')?.subsystem).toBe('links');
    expect(scanAllSpecs().components.filter((c) => c.id === 'constructor')).toHaveLength(1);
    expect(deleteSpec('component', 'constructor', true).removed.map((r) => r.id)).toContain('constructor');
    expect(loadSystemSpec()?.name).toBe('Shop');
  });
});
