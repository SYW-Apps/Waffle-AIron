import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { validateFamily } from '../../src/core/validation.js';
import { at, migrate, plan, waiState } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, specs, component, contract, implementation, type as typeSpec, subsystem, system, projectYaml, writeClinic } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// A contract's local `implements` entry is a component reference across a
// family migration: it crosses a new boundary as `alias::name` only where the
// abstraction it names is exported with role implement, and a family migration
// refuses it otherwise, naming the entry and the abstraction. Every scenario is
// a real temporary family; the verbs run their real planner and writers.
// ---------------------------------------------------------------------------

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

const SPEAK = [{ name: 'announce', description: 'Announce a slot', signature: 'announce(): void', returns: 'void' }];

/** Edit one stored spec file in place. */
function edit(file: string, change: (doc: any) => void): void {
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as any;
  change(doc);
  fs.writeFileSync(file, yaml.dump(doc));
}

/**
 * The clinic whose part `scheduling` holds the abstraction `slot-source`
 * (an abstract Adapter, published by the part subsystem with `role`), and
 * whose frontdesk `checkin-client` realizes it: its contract `implements` the
 * abstraction by its local id, across the line a promote draws.
 */
function clinic(role: 'implement' | undefined): { root: string; part: string } {
  const made = writeClinic(path.join(tempDir(cleanups, 'wairon-implements-'), 'clinic'));
  const { root, part } = made;
  subsystem(part, 'Clinic', 'scheduling', {
    publicInterfaces: [
      { details: 'Schedules', component: 'schedule-portal' },
      { details: 'Where slots come from', component: 'slot-source', ...(role ? { role } : {}) },
    ],
  });
  component(part, 'scheduling', 'slot-source', 'Adapter', [], { abstract: true });
  contract(part, 'scheduling', 'slot-source', SPEAK);
  contract(root, 'frontdesk', 'checkin-client', SPEAK);
  edit(specs(root, 'frontdesk', 'checkin-client', '.interface.yaml'), (doc) => { doc.implements = ['slot-source']; });
  return made;
}

const implementsOf = (root: string): unknown => (yaml.load(fs.readFileSync(specs(root, 'frontdesk', 'checkin-client', '.interface.yaml'), 'utf-8')) as any).implements;

describe('promote: an implements entry crosses the new boundary', () => {
  it('becomes alias::name where the abstraction is exported with role implement, and the family still resolves', () => {
    const { root } = clinic('implement');
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    expect(planned.refusals).toEqual([]);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(implementsOf(root)).toEqual(['scheduling::slot-source']);
    const family = at(root, () => validateFamily({ family: true }));
    expect(family.issues.filter((i) => ['EXTERNAL_NOT_EXPORTED', 'EXTERNAL_UNDECLARED', 'IMPLEMENTS_NOT_ABSTRACT'].includes(i.code))).toEqual([]);
  });

  it('refuses an abstraction published without role implement, naming the entry and the abstraction, and writes nothing', () => {
    const { root } = clinic(undefined);
    const before = waiState(root);
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    expect(planned.refusals.map((r) => r.detail).join(' ')).toMatch(/checkin-client.*implements.*slot-source.*role implement/s);
    expect(waiState(root)).toEqual(before);
  });
});

describe('promote: the abstraction stays in the parent under a public name', () => {
  /** clinic whose frontdesk holds the abstraction `slot-source`, exported by the L0 under `slot-source-impl` when `exported`; the part booking-client implements it. */
  function parentAbstraction(exported: boolean): { root: string; part: string } {
    const made = writeClinic(path.join(tempDir(cleanups, 'wairon-implements-parent-'), 'clinic'));
    const { root, part } = made;
    subsystem(root, 'Clinic', 'frontdesk', {
      publicInterfaces: [
        { details: 'Patients', component: 'patient-portal' },
        { details: 'Where slots come from', component: 'slot-source', role: 'implement' },
      ],
    });
    component(root, 'frontdesk', 'slot-source', 'Adapter', [], { abstract: true });
    contract(root, 'frontdesk', 'slot-source', SPEAK);
    system(root, 'Clinic', exported
      ? [{ from: 'frontdesk', component: 'slot-source', as: 'slot-source-impl', role: 'implement', audience: 'project' }]
      : []);
    contract(part, 'scheduling', 'booking-client', SPEAK);
    edit(specs(part, 'scheduling', 'booking-client', '.interface.yaml'), (doc) => { doc.implements = ['slot-source']; });
    return made;
  }
  const partImplements = (part: string): unknown => (yaml.load(fs.readFileSync(specs(part, 'scheduling', 'booking-client', '.interface.yaml'), 'utf-8')) as any).implements;
  const exportErrors = (root: string): string[] =>
    at(root, () => validateFamily({ family: true })).issues.filter((i) => ['EXTERNAL_NOT_EXPORTED', 'EXTERNAL_INCOMPATIBLE'].includes(i.code)).map((i) => i.code);

  it('names the public name the parent L0 exports it under, and the family validates', () => {
    const { root, part } = parentAbstraction(true);
    expect(plan(root, { verb: 'promote', alias: 'scheduling' }).refusals).toEqual([]);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(partImplements(part)).toEqual(['clinic::slot-source-impl']);
    expect(exportErrors(root)).toEqual([]);
  });

  it('exports the abstraction with role implement where the L0 does not, and names it by its item name', () => {
    const { root, part } = parentAbstraction(false);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const l0 = yaml.load(fs.readFileSync(specs(root, '.index.yaml'), 'utf-8')) as any;
    expect(l0.publicInterfaces).toEqual(expect.arrayContaining([expect.objectContaining({ component: 'slot-source', role: 'implement' })]));
    expect(partImplements(part)).toEqual(['clinic::slot-source']);
    expect(exportErrors(root)).toEqual([]);
  });

  it('the dry run predicts what the real run leaves', () => {
    const { root } = parentAbstraction(true);
    const planned = plan(root, { verb: 'promote', alias: 'scheduling' });
    expect(planned.notes.join(' ')).not.toMatch(/EXTERNAL_NOT_EXPORTED/);
  });
});

describe('promote: every reference across the boundary names the public name', () => {
  const REGISTER = [{ name: 'register', description: 'Register', signature: 'register(): void', returns: 'void' }];
  const CALL = (target: string): Record<string, unknown>[] => [{
    name: 'run', narrative: [{ stepNumber: 1, type: 'call', description: 'Call across', targetComponent: target, targetMethod: 'register' }],
  }];
  const doc = (file: string): any => yaml.load(fs.readFileSync(file, 'utf-8'));
  const codes = (root: string): string[] =>
    at(root, () => validateFamily({ family: true })).issues.filter((i) => ['EXTERNAL_NOT_EXPORTED', 'EXTERNAL_INCOMPATIBLE', 'EXTERNAL_UNDECLARED'].includes(i.code)).map((i) => i.code);

  it('a parent component exported under an as name: the part dependsOn and call step name it', () => {
    const { root, part } = writeClinic(path.join(tempDir(cleanups, 'wairon-pubname-out-'), 'clinic'));
    contract(root, 'frontdesk', 'patient-portal', REGISTER);
    system(root, 'Clinic', [{ from: 'frontdesk', component: 'patient-portal', as: 'patients', audience: 'project' }]);
    contract(part, 'scheduling', 'booking-client', [{ name: 'run', description: 'Run', signature: 'run(): void', returns: 'void' }]);
    implementation(part, 'scheduling', 'booking-client', 'ibooking-client', CALL('patient-portal'));
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(doc(specs(part, 'scheduling', 'booking-client', '.index.yaml')).dependsOn).toEqual(['clinic::patients']);
    expect(doc(specs(part, 'scheduling', 'booking-client', '.implementation.yaml')).methods[0].narrative[0].targetComponent).toBe('clinic::patients');
    expect(codes(root)).toEqual([]);
  });

  it('a part component the parent re-exports under another name: its references name the part own public name, which the validated family resolves', () => {
    const { root, part } = writeClinic(path.join(tempDir(cleanups, 'wairon-pubname-in-'), 'clinic'));
    contract(part, 'scheduling', 'schedule-portal', REGISTER);
    subsystem(part, 'Clinic', 'scheduling', { publicInterfaces: [{ details: 'Schedules', component: 'schedule-portal' }] });
    system(root, 'Clinic', [{ from: 'scheduling', component: 'schedule-portal', as: 'schedules', audience: 'project' }]);
    contract(root, 'frontdesk', 'checkin-client', [{ name: 'run', description: 'Run', signature: 'run(): void', returns: 'void' }]);
    implementation(root, 'frontdesk', 'checkin-client', 'icheckin-client', CALL('schedule-portal'));
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(doc(specs(root, 'frontdesk', 'checkin-client', '.index.yaml')).dependsOn).toEqual(['scheduling::schedule-portal']);
    expect(doc(specs(root, 'frontdesk', 'checkin-client', '.implementation.yaml')).methods[0].narrative[0].targetComponent).toBe('scheduling::schedule-portal');
    expect(codes(root)).toEqual([]);
  });

  it('a parent type exported under an as name: the part param type names it', () => {
    const { root, part } = writeClinic(path.join(tempDir(cleanups, 'wairon-pubname-type-'), 'clinic'));
    subsystem(root, 'Clinic', 'frontdesk', { publicInterfaces: [{ details: 'Patients', component: 'patient-portal' }, { typeDef: 'patient' }] });
    system(root, 'Clinic', [{ from: 'frontdesk', typeDef: 'patient', as: 'person', audience: 'project' }]);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const method = doc(specs(part, 'scheduling', 'booking-client', '.interface.yaml')).methods[0];
    expect(method.params[0].type).toBe('person');
    expect(codes(root)).toEqual([]);
  });

  it('a part type the parent re-exports under another name: its param type names the part own public name', () => {
    const { root, part } = writeClinic(path.join(tempDir(cleanups, 'wairon-pubname-type-in-'), 'clinic'));
    typeSpec(specs(part, 'types', 'slot.yaml'), 'slot', [{ name: 'at', type: 'string' }], { subsystem: 'scheduling' });
    subsystem(part, 'Clinic', 'scheduling', { publicInterfaces: [{ details: 'Schedules', component: 'schedule-portal' }, { typeDef: 'slot' }] });
    system(root, 'Clinic', [{ from: 'scheduling', typeDef: 'slot', as: 'slot-time', audience: 'project' }]);
    contract(root, 'frontdesk', 'checkin-client', [{
      name: 'pick', description: 'Pick', signature: 'pick(s: slot): void', returns: 'void',
      params: [{ name: 's', type: 'slot', description: 'The slot' }],
    }]);
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    const method = doc(specs(root, 'frontdesk', 'checkin-client', '.interface.yaml')).methods[0];
    expect(method.params[0].type).toBe('scheduling::slot');
    expect(codes(root)).toEqual([]);
  });
});


describe('demote and internalize: the entry returns to a local id', () => {
  it('demote of a promoted project reads the alias entry back as the bare id', () => {
    const { root } = clinic('implement');
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    expect(implementsOf(root)).toEqual(['scheduling::slot-source']);
    migrate(root, { verb: 'demote', alias: 'scheduling' });
    expect(implementsOf(root)).toEqual(['slot-source']);
  });

  it('internalize of a promoted project does the same', () => {
    const { root } = clinic('implement');
    migrate(root, { verb: 'promote', alias: 'scheduling' });
    migrate(root, { verb: 'internalize', alias: 'scheduling' });
    expect(implementsOf(root)).toEqual(['slot-source']);
  });
});

describe('externalize as a project: both directions', () => {
  /** shop: `sales` holds checkout, `payments` holds ledger-port (abstract); the implementer sits on `side`. */
  function shop(role: 'implement' | undefined, side: 'sales' | 'payments'): string {
    const root = path.join(tempDir(cleanups, 'wairon-implements-shop-'), 'shop');
    projectYaml(root, { id: 'shop', name: 'Shop' });
    system(root, 'Shop');
    subsystem(root, 'Shop', 'sales');
    subsystem(root, 'Shop', 'payments');
    // The abstraction lives in `payments` when the implementer is in `sales`, and the other way round.
    const home = side === 'sales' ? 'payments' : 'sales';
    subsystem(root, 'Shop', home, { publicInterfaces: [{ details: 'The port', component: 'ledger-port', ...(role ? { role } : {}) }] });
    component(root, home, 'ledger-port', 'Adapter', [], { abstract: true });
    contract(root, home, 'ledger-port', SPEAK);
    component(root, side, 'ledger-client', 'Adapter');
    contract(root, side, 'ledger-client', SPEAK);
    edit(specs(root, side, 'ledger-client', '.interface.yaml'), (doc) => { doc.implements = ['ledger-port']; });
    return root;
  }
  const project = (root: string): unknown => (yaml.load(fs.readFileSync(specs(root, 'sales', 'ledger-client', '.interface.yaml'), 'utf-8')) as any).implements;

  it('the rest of the project realizing a moved abstraction: refused without role implement, an alias entry with it', () => {
    const refused = shop(undefined, 'sales');
    const before = waiState(refused);
    const planned = plan(refused, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' });
    expect(planned.refusals.map((r) => r.detail).join(' ')).toMatch(/ledger-client.*implements.*ledger-port.*role implement/s);
    expect(waiState(refused)).toEqual(before);
    const allowed = shop('implement', 'sales');
    migrate(allowed, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' });
    expect(project(allowed)).toEqual(['payments::ledger-port']);
  });

  it('the moved subtree realizing an abstraction that stays: refused without role implement, an alias entry with it', () => {
    const refused = shop(undefined, 'payments');
    const before = waiState(refused);
    const planned = plan(refused, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' });
    expect(planned.refusals.map((r) => r.detail).join(' ')).toMatch(/ledger-client implements ledger-port.*role implement/s);
    expect(waiState(refused)).toEqual(before);
    const allowed = shop('implement', 'payments');
    migrate(allowed, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' });
    const moved = yaml.load(fs.readFileSync(path.join(allowed, 'services', 'payments', '.wai', 'specs', 'payments', 'ledger-client', '.interface.yaml'), 'utf-8')) as any;
    expect(moved.implements).toEqual(['shop::ledger-port']);
  });
});

describe('externalize from a bound project that is itself a member', () => {
  /** hub (top) with the member `shop`, whose `payments` subsystem holds a client implementing the `sales` abstraction. */
  function hub(role: 'implement' | undefined): { top: string; shopDir: string } {
    const top = path.join(tempDir(cleanups, 'wairon-implements-hub-'), 'hub');
    projectYaml(top, { id: 'hub', name: 'Hub', members: { shop: 'shop' } });
    system(top, 'Hub');
    const shopDir = path.join(top, 'shop');
    projectYaml(shopDir, { id: 'shop', name: 'Shop' });
    system(shopDir, 'Shop');
    subsystem(shopDir, 'Shop', 'sales', { publicInterfaces: [{ details: 'The port', component: 'ledger-port', ...(role ? { role } : {}) }] });
    subsystem(shopDir, 'Shop', 'payments');
    component(shopDir, 'sales', 'ledger-port', 'Adapter', [], { abstract: true });
    contract(shopDir, 'sales', 'ledger-port', SPEAK);
    component(shopDir, 'payments', 'ledger-client', 'Adapter');
    contract(shopDir, 'payments', 'ledger-client', SPEAK);
    edit(specs(shopDir, 'payments', 'ledger-client', '.interface.yaml'), (doc) => { doc.implements = ['ledger-port']; });
    return { top, shopDir };
  }

  it('refuses a moved contract realizing an abstraction that stays unless it is exported with role implement', () => {
    const { shopDir } = hub(undefined);
    const before = waiState(shopDir);
    const planned = plan(shopDir, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' });
    expect(planned.refusals.map((r) => r.detail).join(' ')).toMatch(/ledger-client implements .*ledger-port.*role implement/s);
    expect(waiState(shopDir)).toEqual(before);
    const ok = hub('implement');
    expect(plan(ok.shopDir, { verb: 'externalize', subsystem: 'payments', path: 'services/payments', as: 'project' }).refusals).toEqual([]);
  });
});
