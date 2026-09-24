/**
 * The whole-spec write and the delete through the authoring seam
 * (iauthoring_portal / iauthoring_orchestrator writeSpec and deleteSpec).
 *
 * The create tools used to save raw through core, with the re-authoring rules —
 * status, carry, clear, removal notices, the parent check, label resolution —
 * living in the MCP transport handlers. So redefining a contract with
 * sdd_define_interface reported no tests to revisit, while the same change
 * through sdd_update_spec did. These pin the rules at the layer every door now
 * reaches: the notices as the handlers gave them, each refusal before anything
 * reaches disk, and the tests a restatement or a delete invalidated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import {
  applyRestatement,
  deleteSpec,
  restatementParent,
  writeSpec,
  type SpecRestatement,
} from '../../src/core/authoring.js';
import {
  invalidateSpecCache,
  loadComponentSpec,
  loadImplementationSpec,
  loadInterfaceSpec,
  loadSubsystemSpec,
  loadSystemSpec,
  loadTypeSpec,
  saveComponentSpec,
  saveImplementationSpec,
  saveInterfaceSpec,
  saveSubsystemSpec,
  saveSystemSpec,
} from '../../src/core/specs.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, SystemSpec, TypeSpec } from '../../src/models/specs.js';

const now = '2026-09-01T00:00:00.000Z';
let roots: string[] = [];

// The field lists the MCP create tools state: what each tool's input can express.
const SYSTEM_FIELDS = ['name', 'vision', 'boundaries', 'globalRequirements', 'targetLanguage'];
const SUBSYSTEM_FIELDS = [
  'id', 'name', 'description', 'publicInterfaces', 'projectPath', 'targetLanguage', 'profile', 'designDepth',
  'trustedLinks', 'lifecycle', 'status', 'parentSystem',
];
const COMPONENT_FIELDS = [
  'id', 'name', 'description', 'subsystem', 'componentType', 'owns', 'dependsOn', 'portalType', 'basePath',
  'dispatch', 'mounts', 'durability', 'dependencyClass', 'emits', 'subscribesTo', 'ext', 'status',
];
const INTERFACE_FIELDS = ['id', 'name', 'description', 'component', 'methods', 'status'];
const INTERFACE_METHOD_FIELDS = ['name', 'description', 'signature', 'returns', 'params', 'guarantees', 'effect', 'invokedBy', 'findings', 'ext'];
const IMPL_FIELDS = [
  'id', 'name', 'description', 'contract', 'sourcePath', 'simPath', 'technologies', 'injectedParams', 'detail',
  'conformance', 'methods', 'status',
];
const IMPL_METHOD_FIELDS = ['name', 'sourcePath', 'detail', 'intent', 'conformance', 'symbol', 'exportedVia', 'ext', 'narrative', 'calls'];
const TYPE_FIELDS = [
  'kind', 'id', 'name', 'description', 'subsystem', 'group', 'fields', 'methods', 'componentClass', 'invariants',
  'database', 'table', 'linkedEntity', 'sourcePath', 'symbol',
];

/** A project with an L0, one subsystem, and (optionally) declared test roots. */
function project(opts: { testRoots?: string[]; system?: boolean } = {}): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-write-spec-')));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'write-spec', targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: opts.testRoots ? { conformance: { testRoots: opts.testRoots } } : {}, createdAt: now, updatedAt: now,
  });
  setProjectRoot(root);
  invalidateSpecCache();
  if (opts.system === false) return root;
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'Shop System', vision: 'v', boundaries: [], globalRequirements: [], databases: [], createdAt: now, updatedAt: now });
  saveSubsystemSpec({
    id: 'shop', name: 'Shop', description: 'd', parentSystem: 'Shop System', publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'checkout', name: 'Checkout', description: 'd', subsystem: 'shop', componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

const component = (over: Record<string, unknown> = {}): SpecRestatement => ({
  kind: 'component',
  spec: { id: 'ledger', name: 'Ledger', description: 'd', subsystem: 'shop', componentType: 'Orchestrator', owns: [], dependsOn: [], ...over } as unknown as ComponentSpec,
  fields: COMPONENT_FIELDS,
});

const checkoutContract = (methods: Record<string, unknown>[], status?: 'draft' | 'design' | 'complete'): SpecRestatement => ({
  kind: 'interface',
  spec: { id: 'icheckout', name: 'ICheckout', description: 'The checkout contract', component: 'checkout', methods } as unknown as InterfaceSpec,
  fields: INTERFACE_FIELDS,
  memberFields: INTERFACE_METHOD_FIELDS,
  ...(status ? { status } : {}),
});

const method = (name: string, description = `does ${name}`) => ({
  name, description, signature: `${name}(): void`, returns: 'void',
});

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
  invalidateSpecCache();
});

// ---------------------------------------------------------------------------
// The restatement's own behaviour (spec_restatement.parent / applyTo)
// ---------------------------------------------------------------------------

describe('restatementParent — the spec a restatement cannot be written without', () => {
  it('names the container of each level, and none for the L0 or a type', () => {
    const r = (kind: SpecRestatement['kind'], spec: Record<string, unknown>): SpecRestatement =>
      ({ kind, spec: spec as never, fields: [] });
    expect(restatementParent(r('system', { name: 'S' }))).toBeNull();
    expect(restatementParent(r('subsystem', { id: 'shop' }))).toEqual({ kind: 'system', id: 'system' });
    expect(restatementParent(r('component', { id: 'c', subsystem: 'shop' }))).toEqual({ kind: 'subsystem', id: 'shop' });
    expect(restatementParent(r('interface', { id: 'i', component: 'c' }))).toEqual({ kind: 'component', id: 'c' });
    expect(restatementParent(r('implementation', { id: 'x', contract: 'i' }))).toEqual({ kind: 'interface', id: 'i' });
    // A type's subsystem is an ownership label, not a container.
    expect(restatementParent(r('type', { id: 't', subsystem: 'shop' }))).toBeNull();
  });
});

describe('applyRestatement — computed without touching disk', () => {
  it('a new spec carries nothing, raises no notices, and changes no method', () => {
    const application = applyRestatement(component(), null, { id: 'shop' } as SubsystemSpec);
    expect(application.refusal).toBeUndefined();
    expect(application.replacedExisting).toBe(false);
    expect(application.notices).toEqual([]);
    expect(application.changedMethods).toEqual([]);
    expect(application.status).toBe('draft');
  });

  it('does not mutate the restatement it was handed', () => {
    const restatement = component();
    const before = JSON.stringify(restatement);
    applyRestatement(restatement, null, { id: 'shop' } as SubsystemSpec);
    expect(JSON.stringify(restatement)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// writeSpec, level by level
// ---------------------------------------------------------------------------

describe('writeSpec — the L0', () => {
  it('initializes a system and answers with a receipt carrying no status', () => {
    project({ system: false });
    const receipt = writeSpec({ kind: 'system', spec: { name: 'New', vision: 'v', boundaries: [], globalRequirements: [] } as unknown as SystemSpec, fields: SYSTEM_FIELDS });
    expect(receipt).toEqual({ kind: 'system', id: 'system', name: 'New', replacedExisting: false, notices: [], testsToRevisit: [] });
    invalidateSpecCache();
    expect(loadSystemSpec()?.databases).toEqual([]);
  });

  it('re-authors in place and carries what the tool cannot express', () => {
    project();
    const stored = loadSystemSpec()!;
    saveSystemSpec({ ...stored, databases: [{ id: 'main', name: 'Main', engine: 'postgres' } as never] });
    invalidateSpecCache();
    const receipt = writeSpec({ kind: 'system', spec: { name: 'Shop System', vision: 'v2', boundaries: [], globalRequirements: [] } as unknown as SystemSpec, fields: SYSTEM_FIELDS });
    expect(receipt.replacedExisting).toBe(true);
    expect(receipt.notices[0]).toBe('System spec "Shop System" already existed — re-authored in place; this input REPLACES what it expresses.');
    expect(receipt.notices[1]).toMatch(/^Carried forward \(not expressible through this tool\): createdAt, .*databases/);
    invalidateSpecCache();
    expect(loadSystemSpec()?.databases).toHaveLength(1);
    expect(loadSystemSpec()?.createdAt).toBe(now);
  });
});

describe('writeSpec — a subsystem', () => {
  const subsystem = (over: Record<string, unknown> = {}): SpecRestatement => ({
    kind: 'subsystem',
    spec: { id: 'billing', name: 'Billing', description: 'd', publicInterfaces: [], trustedLinks: [], ...over } as unknown as SubsystemSpec,
    fields: SUBSYSTEM_FIELDS,
  });

  it('refuses without an L0, before anything reaches disk', () => {
    project({ system: false });
    expect(() => writeSpec(subsystem())).toThrow('System spec must be initialized (sdd_initialize_system) first.');
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')).toBeNull();
  });

  it('derives parentSystem from the L0 name', () => {
    project();
    writeSpec(subsystem({ parentSystem: 'Somebody Else' }));
    invalidateSpecCache();
    expect(loadSubsystemSpec('billing')?.parentSystem).toBe('Shop System');
  });

  it('scaffolds the child project of a chained subsystem and names it on the receipt', () => {
    const root = project();
    const receipt = writeSpec(subsystem({ projectPath: 'packages/billing' }));
    expect(receipt.scaffoldedProjectPath).toBe('packages/billing');
    expect(fs.existsSync(path.join(root, 'packages', 'billing', '.wai', 'project.yaml'))).toBe(true);
  });

  it('carries lint and names createdAt first, as the create tool always did', () => {
    project();
    const stored = loadSubsystemSpec('shop')!;
    saveSubsystemSpec({ ...stored, lint: { allow: [{ code: 'X', reason: 'r' }] } } as SubsystemSpec);
    invalidateSpecCache();
    const receipt = writeSpec({ ...subsystem({ id: 'shop', name: 'Shop' }) });
    expect(receipt.notices).toContain('Carried forward (not expressible through this tool): createdAt, lint.');
  });
});

describe('writeSpec — a component', () => {
  it('refuses a missing subsystem with the sentence the tool gave', () => {
    project();
    expect(() => writeSpec(component({ subsystem: 'nowhere' }))).toThrow('Parent subsystem "nowhere" does not exist.');
  });

  it('refuses an intrinsic error and writes nothing', () => {
    project();
    expect(() => writeSpec(component({ basePath: '/api' }))).toThrow(/UNEXPECTED_PORTAL_FIELD/);
    invalidateSpecCache();
    expect(loadComponentSpec('ledger')).toBeNull();
  });

  it('answers the gate warnings as notices', () => {
    project();
    const receipt = writeSpec(component({ componentType: 'Store' }));
    expect(receipt.notices.some(n => n.startsWith('MISSING_DURABILITY'))).toBe(true);
  });

  it('keeps the stored status when none is stated, and says so on the receipt', () => {
    project();
    writeSpec({ ...component(), status: 'complete' });
    invalidateSpecCache();
    const receipt = writeSpec(component({ description: 'reworded' }));
    expect(receipt.status).toBe('complete');
    invalidateSpecCache();
    expect(loadComponentSpec('ledger')?.status).toBe('complete');
  });

  it('refuses a stated status that would LOWER the stored one', () => {
    project();
    writeSpec({ ...component(), status: 'complete' });
    invalidateSpecCache();
    expect(() => writeSpec({ ...component({ description: 'reopened' }), status: 'draft' }))
      .toThrow(/^Refusing to re-author component "ledger" at status "draft": it is stored at "complete"/);
    invalidateSpecCache();
    expect(loadComponentSpec('ledger')?.description).toBe('d');
  });

  it('names what an omission cleared', () => {
    project();
    writeSpec(component({ dependsOn: ['checkout'] }));
    invalidateSpecCache();
    const receipt = writeSpec(component());
    expect(receipt.notices.some(n => n.startsWith('CLEARED by omission: dependsOn (had 1)'))).toBe(true);
  });
});

describe('writeSpec — an interface', () => {
  it('refuses a missing component with the sentence the tool gave', () => {
    project();
    expect(() => writeSpec({ ...checkoutContract([]), spec: { id: 'ix', name: 'IX', description: 'd', component: 'nowhere', methods: [] } as unknown as InterfaceSpec }))
      .toThrow('Component "nowhere" does not exist.');
  });

  it('carries a method\'s endpoint binding and names the method a restatement removed', () => {
    project();
    writeSpec(checkoutContract([method('pay'), method('refund')]));
    invalidateSpecCache();
    const stored = loadInterfaceSpec('icheckout')!;
    stored.methods[0].endpoint = { transport: 'HTTP', method: 'POST', path: '/pay' } as never;
    saveInterfaceSpec(stored);
    invalidateSpecCache();

    const receipt = writeSpec(checkoutContract([method('pay')]));
    expect(receipt.notices).toContain('Carried forward (not expressible through this tool): createdAt, endpoint (pay).');
    expect(receipt.notices.some(n => n.startsWith('REMOVED by this restatement: method "refund" (endpoint bindings included)'))).toBe(true);
    invalidateSpecCache();
    expect(loadInterfaceSpec('icheckout')?.methods[0].endpoint).toEqual({ transport: 'HTTP', method: 'POST', path: '/pay' });
  });

  it('names the tests a restatement invalidated by DROPPING a method — the bug this seam closes', () => {
    const root = project({ testRoots: ['tests'] });
    writeSpec(checkoutContract([method('pay'), method('refund')]));
    invalidateSpecCache();
    write(root, 'tests/refund.test.ts', "import { refund } from '../src/checkout.js';\nit('refunds', () => refund());");

    const receipt = writeSpec(checkoutContract([method('pay')]));
    expect(receipt.testsToRevisit.map(t => t.method)).toEqual(['refund']);
    expect(receipt.testsToRevisit[0].imported).toEqual(['tests/refund.test.ts']);
  });

  it('names the tests a restatement invalidated by REWRITING a method', () => {
    const root = project({ testRoots: ['tests'] });
    writeSpec(checkoutContract([method('pay')]));
    invalidateSpecCache();
    write(root, 'tests/pay.test.ts', "import { pay } from '../src/checkout.js';\nit('pays', () => pay());");

    const receipt = writeSpec(checkoutContract([{ ...method('pay'), signature: 'pay(amount: number): void' }]));
    expect(receipt.testsToRevisit.map(t => t.method)).toEqual(['pay']);
  });

  it('names none when the restatement says the same thing again', () => {
    const root = project({ testRoots: ['tests'] });
    writeSpec(checkoutContract([method('pay')]));
    invalidateSpecCache();
    write(root, 'tests/pay.test.ts', "import { pay } from '../src/checkout.js';\nit('pays', () => pay());");

    expect(writeSpec(checkoutContract([method('pay')])).testsToRevisit).toEqual([]);
  });

  it('names none when the project declares no test roots — opt-in, never the thing that fails a write', () => {
    const root = project();
    writeSpec(checkoutContract([method('pay'), method('refund')]));
    invalidateSpecCache();
    write(root, 'tests/refund.test.ts', "import { refund } from '../src/checkout.js';\nit('refunds', () => refund());");
    expect(writeSpec(checkoutContract([method('pay')])).testsToRevisit).toEqual([]);
  });
});

describe('writeSpec — an implementation', () => {
  const impl = (methods: Record<string, unknown>[]): SpecRestatement => ({
    kind: 'implementation',
    spec: { id: 'checkout_impl', name: 'CheckoutImpl', description: 'd', contract: 'icheckout', methods } as unknown as ImplementationSpec,
    fields: IMPL_FIELDS,
    memberFields: IMPL_METHOD_FIELDS,
  });
  const seedContract = (): void => {
    writeSpec(checkoutContract([method('pay'), method('refund')]));
    invalidateSpecCache();
  };

  it('refuses a missing contract with the sentence the tool gave', () => {
    project();
    expect(() => writeSpec(impl([]))).toThrow('Interface contract "icheckout" does not exist.');
  });

  it('resolves narrative labels to step numbers before the write', () => {
    project();
    seedContract();
    writeSpec(impl([{
      name: 'pay',
      narrative: [
        { stepNumber: 1, description: 'Go on', type: 'jump', toLabel: 'end' },
        { stepNumber: 2, label: 'end', description: 'Done', type: 'return', outcome: 'paid' },
      ],
    }]));
    invalidateSpecCache();
    const step = loadImplementationSpec('checkout_impl')!.methods[0].narrative[0] as Record<string, unknown>;
    expect(step.toStep).toBe(2);
    expect(step.toLabel).toBeUndefined();
  });

  it('refuses an unresolved label and writes nothing', () => {
    project();
    seedContract();
    expect(() => writeSpec(impl([{
      name: 'pay',
      narrative: [{ stepNumber: 1, description: 'Go', type: 'jump', toLabel: 'nowhere' }],
    }]))).toThrow(/^Unresolved narrative label references — nothing was saved:\n- narrative of "pay": step 1 toLabel references unknown label "nowhere"/);
    invalidateSpecCache();
    expect(loadImplementationSpec('checkout_impl')).toBeNull();
  });

  it('names the method a restatement removed, and searches its tests by the STORED symbol', () => {
    const root = project({ testRoots: ['tests'] });
    seedContract();
    writeSpec(impl([
      { name: 'pay', narrative: [{ stepNumber: 1, description: 'Pay', type: 'local' }] },
      { name: 'refund', symbol: 'issueRefund', narrative: [{ stepNumber: 1, description: 'Refund', type: 'local' }] },
    ]));
    invalidateSpecCache();
    write(root, 'tests/refund.test.ts', "import { issueRefund } from '../src/checkout.js';\nit('refunds', () => issueRefund());");

    const receipt = writeSpec(impl([{ name: 'pay', narrative: [{ stepNumber: 1, description: 'Pay', type: 'local' }] }]));
    expect(receipt.notices.some(n => n.startsWith('REMOVED by this restatement: method "refund" (L5 narratives included)'))).toBe(true);
    expect(receipt.testsToRevisit).toEqual([expect.objectContaining({ method: 'refund', symbol: 'issueRefund', imported: ['tests/refund.test.ts'] })]);
  });

  it('keeps a stored status and carries a method\'s ext', () => {
    project();
    seedContract();
    saveImplementationSpec({
      id: 'checkout_impl', name: 'CheckoutImpl', description: 'd', contract: 'icheckout', status: 'design',
      methods: [{ name: 'pay', narrative: [], ext: { 'pack:x': 1 } } as never], createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    invalidateSpecCache();
    const receipt = writeSpec(impl([{ name: 'pay', narrative: [] }]));
    expect(receipt.status).toBe('design');
    expect(receipt.notices).toContain('Carried forward (not expressible through this tool): createdAt, ext (pay).');
  });
});

describe('writeSpec — a type', () => {
  const type = (over: Record<string, unknown> = {}): SpecRestatement => ({
    kind: 'type',
    spec: { kind: 'value-object', id: 'money', name: 'Money', fields: [], methods: [], ...over } as unknown as TypeSpec,
    fields: TYPE_FIELDS,
  });

  it('needs no parent, carries no status, and names a removed member', () => {
    project();
    const created = writeSpec(type({ fields: [{ name: 'amount', type: 'number', optional: false }, { name: 'legacy', type: 'string', optional: false }] }));
    expect(created.status).toBeUndefined();
    invalidateSpecCache();
    const receipt = writeSpec(type({ fields: [{ name: 'amount', type: 'number', optional: false }] }));
    expect(receipt.notices.some(n => n.startsWith('REMOVED by this restatement: member "field legacy"'))).toBe(true);
    invalidateSpecCache();
    expect(loadTypeSpec('money')?.fields.map(f => f.name)).toEqual(['amount']);
  });
});

// ---------------------------------------------------------------------------
// deleteSpec
// ---------------------------------------------------------------------------

describe('deleteSpec — the delete names the tests of the methods it took away', () => {
  it('reports every method of a deleted contract that a test encodes', () => {
    const root = project({ testRoots: ['tests'] });
    writeSpec(checkoutContract([method('pay'), method('refund')]));
    invalidateSpecCache();
    write(root, 'tests/pay.test.ts', "import { pay } from '../src/checkout.js';\nit('pays', () => pay());");

    const deletion = deleteSpec('interface', 'icheckout');
    expect(deletion).toMatchObject({ kind: 'interface', id: 'icheckout', deleted: true });
    expect(deletion.testsToRevisit.map(t => t.method)).toEqual(['pay']);
    invalidateSpecCache();
    expect(loadInterfaceSpec('icheckout')).toBeNull();
  });

  it('answers deleted false, with nothing to revisit, when no spec held the id', () => {
    project({ testRoots: ['tests'] });
    expect(deleteSpec('interface', 'inowhere')).toEqual({ kind: 'interface', id: 'inowhere', deleted: false, testsToRevisit: [] });
  });

  it('reports nothing for a spec without methods', () => {
    project({ testRoots: ['tests'] });
    expect(deleteSpec('component', 'checkout')).toEqual({ kind: 'component', id: 'checkout', deleted: true, testsToRevisit: [] });
  });
});
