/**
 * The design export projector (design_exporter, src/core/design-export.ts):
 * keys, resolved references, canonical type refs, inlined signatures, the
 * approval stamp, entrypoint facts, rename traces, what is left out — and
 * determinism, including against the order the loader hands the specs back in.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// The loader's list order is the filesystem's (NTFS sorted, ext4 hashed). A
// switch that hands every list back REVERSED proves the document does not
// depend on it.
const order = vi.hoisted(() => ({ reversed: false }));
vi.mock('../../src/core/adapters/surfaces-core.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/adapters/surfaces-core.js')>();
  const maybeReversed = <T>(list: T[]): T[] => (order.reversed ? [...list].reverse() : list);
  return {
    ...real,
    loadSubsystemSpecs: () => maybeReversed(real.loadSubsystemSpecs()),
    loadComponentSpecs: () => maybeReversed(real.loadComponentSpecs()),
    loadInterfaceSpecs: () => maybeReversed(real.loadInterfaceSpecs()),
    loadImplementationSpecs: () => maybeReversed(real.loadImplementationSpecs()),
    loadTypeSpecs: () => maybeReversed(real.loadTypeSpecs()),
    resolveProjectExports: (project?: string) => {
      const t = real.resolveProjectExports(project);
      return { ...t, entries: maybeReversed(t.entries) };
    },
    resolveSubsystemExports: (id: string) => {
      const t = real.resolveSubsystemExports(id);
      return { ...t, entries: maybeReversed(t.entries) };
    },
  };
});

import { runWithProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { exportDesign, NoSystemSpecError } from '../../src/core/design-export.js';
import {
  DesignExportSchema,
  DESIGN_FORMAT_VERSION,
  type ComponentSpec,
  type DesignExport,
  type ImplementationSpec,
  type InterfaceSpec,
  type SubsystemSpec,
  type TypeExpression,
  type TypeSpec,
} from '../../src/models/index.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';

const now = '2026-10-04T12:00:00.000Z';
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'billing-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: `component ${id}`, subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: unknown[], over: Partial<InterfaceSpec> = {}): InterfaceSpec => ({
  id, name: id, description: `contract ${id}`, component: comp, methods, status: 'complete', createdAt: now, updatedAt: now, ...over,
} as InterfaceSpec);
const type = (spec: Partial<TypeSpec> & Pick<TypeSpec, 'id' | 'kind'>): TypeSpec => ({
  name: spec.id, fields: [], methods: [], createdAt: now, updatedAt: now, ...spec,
} as TypeSpec);

/** A two-subsystem billing tree touching every section of the format. */
function buildTree(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), [
    "schemaVersion: '1.0.0'", 'id: billing', 'name: Billing', 'targets:', '  - type: claude', '    outputDir: .claude/agents',
    '    enabled: true', `createdAt: '${now}'`, `updatedAt: '${now}'`, '',
  ].join('\n'));
  runWithProjectRoot(root, () => {
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'billing-system',
      vision: 'Bill customers.',
      boundaries: ['No payments', { name: 'tax', description: 'computed elsewhere' }],
      globalRequirements: ['Every invoice balances', { description: 'Audit every write' }],
      publicInterfaces: [
        { id: 'billing-api', name: 'Billing API', subsystem: 'billing', component: 'billing-portal', type: 'REST', details: 'the api', audience: 'external' },
      ],
      databases: [],
      targetLanguage: 'typescript',
      createdAt: now,
      updatedAt: now,
    });
    saveSpec('subsystem', subsystem('billing', {
      publicInterfaces: [{ type: 'REST', details: 'api', component: 'billing-portal' }],
      lifecycle: [{ phase: 'init', component: 'billing-orch', method: 'compute' }],
      trustedLinks: [{ subsystem: 'ledger', reason: 'shared books' }],
      ext: { acme: { tier: 'gold' } },
    }));
    saveSpec('subsystem', subsystem('ledger'));
    saveComponentSpec(component('billing-portal', 'billing', {
      componentType: 'Portal', transport: 'HTTP', dependsOn: ['billing-orch'], basePath: '/billing',
      previousIds: ['invoice-portal'],
      ext: { acme: { owner: 'team-a' } },
      lint: { allow: [{ code: 'SOME_CODE', reason: 'fixture' }] },
    } as Partial<ComponentSpec>));
    saveComponentSpec(component('billing-orch', 'billing', {
      emits: [{ topic: 'invoices', event: 'invoice.created' }],
    } as Partial<ComponentSpec>));
    saveComponentSpec(component('ledger-store', 'ledger', { componentType: 'Store', durability: 'durable' } as Partial<ComponentSpec>));
    saveInterfaceSpec(iface('ibilling-portal', 'billing-portal', [
      {
        name: 'getInvoice',
        description: 'Fetch one invoice.',
        returns: 'invoice?',
        params: [{ name: 'id', type: 'string' }, { name: 'withLines', type: 'bool', optional: true }],
        guarantees: ['idempotent'],
        effect: 'read',
        endpoint: { transport: 'HTTP', method: 'GET', path: '/invoices/{id}' },
        previousNames: ['ibilling-portal.fetchInvoice'],
        findings: [{ code: 'NOT_FOUND', severity: 'error', summary: 'no such invoice' }],
      },
      { name: 'onChange', description: 'Notified of a change.', signatureFrom: 'change-listener' },
      { name: 'relay', description: 'Relays a computation.', signatureFrom: 'billing-orch.compute' },
    ], { previousIds: ['iinvoice-portal'] }));
    saveInterfaceSpec(iface('ibilling-orch', 'billing-orch', [
      {
        name: 'compute',
        description: 'Compute the invoices for an amount.',
        returns: 'list<invoice>',
        params: [{ name: 'amount', type: 'money' }, { name: 'state', type: 'invoice-state' }],
      },
    ]));
    saveInterfaceSpec(iface('iledger-store', 'ledger-store', [
      { name: 'put', description: 'Store a raw entry.', returns: 'void', params: [{ name: 'entry', type: 'Promise<' }] },
    ]));
    saveImplementationSpec({
      id: 'billing-portal-impl', name: 'Billing Portal', description: 'portal', contract: 'ibilling-portal',
      sourcePath: 'src/billing/portal.ts', simPath: 'sim/billing.ts',
      methods: [
        {
          name: 'getInvoice',
          symbol: 'getInvoiceHandler',
          narrative: [
            { stepNumber: 1, description: 'Compute', type: 'call', targetComponent: 'billing-orch', targetMethod: 'compute' },
            { stepNumber: 2, description: 'Done', type: 'return', outcome: 'invoice' },
          ],
        },
        { name: 'onChange', narrative: [], detail: 'intent', intent: 'Forwards every change notification to the orchestrator for a recompute.', calls: ['billing-orch.compute'] },
        { name: 'relay', narrative: [] },
      ],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    saveImplementationSpec({
      id: 'billing-orch-impl', name: 'Billing Orchestrator', description: 'orch', contract: 'ibilling-orch',
      technologies: ['postgres', { name: 'yaml', matches: ['yaml package'] }],
      previousIds: ['invoice-orch-impl'],
      methods: [{ name: 'compute', narrative: [{ stepNumber: 1, description: 'Sum', type: 'local' }] }],
      status: 'complete', createdAt: now, updatedAt: now,
    } as ImplementationSpec);
    saveTypeSpec(type({
      id: 'invoice', kind: 'entity', subsystem: 'billing', componentClass: 'billing-orch', previousIds: ['bill'],
      fields: [
        { name: 'id', type: 'string', optional: false, key: 'primary' },
        { name: 'total', type: 'money', optional: false },
        { name: 'lines', type: 'map<string, list<invoice>>', optional: true },
      ],
      methods: [{ name: 'isEmpty', returns: 'bool', params: [], description: 'Whether it has no lines.' }],
      invariants: [{ id: 'balanced', description: 'lines sum to total' }],
    }));
    saveTypeSpec(type({ id: 'money', kind: 'value-object', holds: 'float' }));
    saveTypeSpec(type({ id: 'invoice-state', kind: 'enum', values: [{ name: 'open' }, { name: 'paid', description: 'settled' }] }));
    saveTypeSpec(type({
      id: 'change-listener', kind: 'signature',
      params: [{ name: 'changed', type: 'invoice' }], returns: 'void',
    }));
  });
  invalidateSpecCache();
}

const roots: string[] = [];
function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-design-'));
  roots.push(root);
  buildTree(root);
  return root;
}
const exportAt = (root: string, approval?: Parameters<typeof exportDesign>[0]): DesignExport =>
  runWithProjectRoot(root, () => {
    invalidateSpecCache();
    return exportDesign(approval);
  });
const json = (d: DesignExport): string => JSON.stringify(d, null, 2);

afterEach(() => {
  order.reversed = false;
  invalidateSpecCache();
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** Every named member's name in a parsed position. */
const namedIn = (e: TypeExpression | undefined): string[] =>
  !e ? [] : [...(e.form === 'named' ? [e.name!] : []), ...e.args.flatMap(namedIn)];

describe('the design export projector', () => {
  let root: string;
  let design: DesignExport;
  beforeAll(() => {
    root = tree();
    design = exportAt(root);
  });

  it('conforms to its own zod schema and stamps the format', () => {
    expect(DesignExportSchema.safeParse(design).success).toBe(true);
    expect(design.format).toBe('wairon-design');
    expect(design.formatVersion).toBe(DESIGN_FORMAT_VERSION);
    expect(design.generator).toBe(WAIRON_VERSION);
    expect(design.source.projectId).toBe('billing');
    expect(design.source.stateId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  describe('determinism', () => {
    it('two runs are byte-identical', () => {
      expect(json(exportAt(root))).toBe(json(design));
    });

    it('the order the loader hands specs back in changes nothing', () => {
      order.reversed = true;
      const reversed = exportAt(root);
      expect(reversed.source.stateId).toBe(design.source.stateId);
      expect(json(reversed)).toBe(json(design));
    });

    it('a second tree with the same specs gives the same document', () => {
      expect(json(exportAt(tree()))).toBe(json(design));
    });

    it('sorts element lists by key and object keys ordinally', () => {
      const keys = design.components.map((c) => c.key);
      expect(keys).toEqual([...keys].sort());
      expect(Object.keys(design)).toEqual([...Object.keys(design)].sort());
      expect(Object.keys(design.components[0])).toEqual([...Object.keys(design.components[0])].sort());
    });
  });

  describe('keys and references', () => {
    it('keys every element as the format says', () => {
      expect(design.subsystems.map((s) => s.key)).toEqual(['billing', 'ledger']);
      expect(design.components.map((c) => c.key)).toEqual(['billing-orch', 'billing-portal', 'ledger-store']);
      expect(design.types.map((t) => t.key)).toEqual(['billing::invoice', 'change-listener', 'invoice-state', 'money']);
      expect(design.interfaces.find((i) => i.key === 'ibilling-portal')!.methods.map((m) => m.key))
        .toEqual(['ibilling-portal.getInvoice', 'ibilling-portal.onChange', 'ibilling-portal.relay']);
      expect(design.types.find((t) => t.key === 'billing::invoice')!.methods[0].key).toBe('billing::invoice.isEmpty');
    });

    it('resolves every reference to a key in the document', () => {
      const components = new Set(design.components.map((c) => c.key));
      const interfaces = new Set(design.interfaces.map((i) => i.key));
      const types = new Set(design.types.map((t) => t.key));
      const methods = new Set(design.interfaces.flatMap((i) => i.methods.map((m) => m.key)));
      const subsystems = new Set(design.subsystems.map((s) => s.key));
      for (const c of design.components) {
        expect(subsystems.has(c.subsystem)).toBe(true);
        for (const d of [...c.dependsOn, ...c.owns]) expect(components.has(d)).toBe(true);
      }
      for (const i of design.interfaces) {
        expect(components.has(i.component)).toBe(true);
        for (const m of i.methods) {
          for (const n of [...namedIn(m.returns.expression), ...m.params.flatMap((p) => namedIn(p.type.expression))]) {
            expect(types.has(n), n).toBe(true);
          }
        }
      }
      for (const impl of design.implementations) {
        expect(interfaces.has(impl.contract)).toBe(true);
        expect(components.has(impl.component)).toBe(true);
        for (const body of impl.methods) {
          expect(methods.has(body.method)).toBe(true);
          for (const c of body.calls) expect(methods.has(c), c).toBe(true);
          for (const step of body.narrative) {
            if (step.targetComponent) expect(components.has(step.targetComponent)).toBe(true);
            if (step.targetMethod) expect(methods.has(step.targetMethod), step.targetMethod).toBe(true);
          }
        }
      }
      for (const s of design.subsystems) {
        for (const l of s.lifecycle) expect(components.has(l.component)).toBe(true);
        for (const t of s.trustedLinks) expect(subsystems.has(t)).toBe(true);
      }
      for (const e of [...design.project.exports, ...design.subsystems.flatMap((s) => s.exports)]) {
        const pool = e.targetKind === 'type' ? types : e.targetKind === 'interface' ? interfaces : components;
        expect(pool.has(e.target), e.target).toBe(true);
      }
      expect(design.types.find((t) => t.key === 'billing::invoice')!.componentClass).toBe('billing-orch');
    });

    it('resolves the export tables to their targets', () => {
      expect(design.project.exports).toEqual([{ publicName: 'billing-api', targetKind: 'component', target: 'billing-portal', audience: 'external' }]);
      expect(design.subsystems.find((s) => s.key === 'billing')!.exports.map((e) => e.target)).toEqual(['billing-portal']);
    });
  });

  describe('type refs', () => {
    const method = (intf: string, name: string) => design.interfaces.find((i) => i.key === intf)!.methods.find((m) => m.name === name)!;

    it('carry canonical text and the parse with named members resolved to keys', () => {
      const compute = method('ibilling-orch', 'compute');
      expect(compute.returns.text).toBe('list<billing::invoice>');
      expect(compute.returns.expression).toEqual({ form: 'list', args: [{ form: 'named', name: 'billing::invoice', args: [] }] });
      expect(compute.params.map((p) => p.type.text)).toEqual(['money', 'invoice-state']);
      const lines = design.types.find((t) => t.key === 'billing::invoice')!.fields.find((f) => f.name === 'lines')!;
      expect(lines.type.text).toBe('map<string, list<billing::invoice>>');
      expect(lines.optional).toBe(true);
      expect(method('ibilling-portal', 'getInvoice').returns.text).toBe('billing::invoice?');
    });

    it('keep the text alone, as opaque, where the grammar cannot read the position', () => {
      const put = method('iledger-store', 'put');
      expect(put.params[0].type.text).toBe('Promise<');
      expect(put.params[0].type.expression).toBeUndefined();
    });
  });

  describe('signatures', () => {
    const method = (name: string) => design.interfaces.find((i) => i.key === 'ibilling-portal')!.methods.find((m) => m.name === name)!;

    it('inline a method source and never name it', () => {
      const relay = method('relay');
      expect(relay.params.map((p) => p.name)).toEqual(['amount', 'state']);
      expect(relay.returns.text).toBe('list<billing::invoice>');
      expect(relay.signatureType).toBeUndefined();
      expect(json(design)).not.toContain('signatureFrom');
    });

    it('inline a signature type and name it as signatureType', () => {
      const onChange = method('onChange');
      expect(onChange.params.map((p) => p.type.text)).toEqual(['billing::invoice']);
      expect(onChange.returns.text).toBe('void');
      expect(onChange.signatureType).toBe('change-listener');
      const sig = design.types.find((t) => t.key === 'change-listener')!;
      expect(sig.params.map((p) => p.type.text)).toEqual(['billing::invoice']);
      expect(sig.returns!.text).toBe('void');
    });

    it('keeps params, guarantees and the derived signature text', () => {
      const get = method('getInvoice');
      expect(get.params.map((p) => [p.name, p.optional])).toEqual([['id', false], ['withLines', true]]);
      expect(get.signature).toBe('getInvoice(id: string, withLines?: bool): invoice?');
      expect(get.guarantees).toEqual(['idempotent']);
      expect(get.effect).toBe('read');
    });
  });

  describe('approval', () => {
    it('is unjudged and not approved when no verdict is handed in', () => {
      expect(design.source.approval).toBe('unjudged');
      expect(design.source.approved).toBe(false);
    });

    it('stamps the verdict handed in, and is approved exactly when it is locked', () => {
      expect(exportAt(root, 'locked').source).toMatchObject({ approval: 'locked', approved: true });
      expect(exportAt(root, 'stale').source).toMatchObject({ approval: 'stale', approved: false });
      expect(exportAt(root, 'unlocked').source).toMatchObject({ approval: 'unlocked', approved: false });
    });

    it('moves nothing but the stamp', () => {
      const locked = exportAt(root, 'locked');
      expect({ ...locked, source: design.source }).toEqual(design);
    });
  });

  describe('facts, traces and what is left out', () => {
    it('carries the facts a consumer decides bootable-or-library from, and no derived kind', () => {
      const billing = design.subsystems.find((s) => s.key === 'billing')!;
      expect(billing.lifecycle).toEqual([{ phase: 'init', component: 'billing-orch', method: 'compute' }]);
      expect(design.interfaces.find((i) => i.key === 'ibilling-portal')!.methods[0].endpoint)
        .toEqual({ transport: 'HTTP', method: 'GET', path: '/invoices/{id}' });
      expect(design.project).not.toHaveProperty('kind');
      expect(design.project.boundaries).toEqual(['No payments', 'tax: computed elsewhere']);
      expect(design.project.requirements).toEqual(['Every invoice balances', 'Audit every write']);
    });

    it('shows rename traces as formerly', () => {
      expect(design.components.find((c) => c.key === 'billing-portal')!.formerly).toEqual(['invoice-portal']);
      expect(design.components.find((c) => c.key === 'billing-orch')!.formerly).toEqual([]);
      const portal = design.interfaces.find((i) => i.key === 'ibilling-portal')!;
      expect(portal.formerly).toEqual(['iinvoice-portal']);
      expect(portal.methods[0].formerly).toEqual(['ibilling-portal.fetchInvoice']);
      expect(design.implementations.find((i) => i.key === 'billing-orch-impl')!.formerly).toEqual(['invoice-orch-impl']);
      expect(design.types.find((t) => t.key === 'billing::invoice')!.formerly).toEqual(['bill']);
    });

    it('passes ext through and leaves out gate data and timestamps', () => {
      expect(design.components.find((c) => c.key === 'billing-portal')!.ext).toEqual({ acme: { owner: 'team-a' } });
      expect(design.subsystems.find((s) => s.key === 'billing')!.ext).toEqual({ acme: { tier: 'gold' } });
      const text = json(design);
      for (const left of ['"lint"', '"symbol"', '"simPath"', '"findings"', '"createdAt"', '"updatedAt"', '"conformance"', '"exportedVia"']) {
        expect(text).not.toContain(left);
      }
    });

    it('projects bodies: detail after the stereotype default, calls and steps as keys, technologies by name', () => {
      const portal = design.implementations.find((i) => i.key === 'billing-portal-impl')!;
      expect(portal.component).toBe('billing-portal');
      const get = portal.methods.find((m) => m.method === 'ibilling-portal.getInvoice')!;
      expect(get.detail).toBe('calls-only');
      expect(get.narrative[0]).toMatchObject({ type: 'call', targetComponent: 'billing-orch', targetMethod: 'ibilling-orch.compute' });
      const onChange = portal.methods.find((m) => m.method === 'ibilling-portal.onChange')!;
      expect(onChange).toMatchObject({ detail: 'intent', calls: ['ibilling-orch.compute'], narrative: [] });
      expect(design.implementations.find((i) => i.key === 'billing-orch-impl')!.technologies).toEqual(['postgres', 'yaml']);
      expect(design.components.find((c) => c.key === 'billing-orch')!.emits).toEqual([{ topic: 'invoices', event: 'invoice.created' }]);
    });

    it('projects every type kind', () => {
      expect(design.types.find((t) => t.key === 'money')).toMatchObject({ kind: 'value-object', holds: 'float', fields: [] });
      expect(design.types.find((t) => t.key === 'invoice-state')!.values).toEqual([{ name: 'open' }, { name: 'paid', description: 'settled' }]);
      expect(design.types.find((t) => t.key === 'billing::invoice')!.invariants).toEqual([{ id: 'balanced', description: 'lines sum to total' }]);
    });
  });

  it('refuses a tree with no L0', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-design-empty-'));
    roots.push(empty);
    fs.mkdirSync(path.join(empty, '.wai', 'specs'), { recursive: true });
    expect(() => exportAt(empty)).toThrow(NoSystemSpecError);
    expect(() => exportAt(empty)).toThrow(/no-system/);
  });
});

// Exporting a real tree loads and resolves every spec in it; under a full
// parallel run that can outlast the suite's default timeout.
const REAL_TREE_TIMEOUT = 60_000;

describe('entrypoint facts on real trees', () => {
  it("wairon's own tree states its init roots, and the export conforms", () => {
    const own = exportAt(REPO_ROOT);
    expect(DesignExportSchema.safeParse(own).success).toBe(true);
    const roots = own.subsystems.flatMap((s) => s.lifecycle.map((l) => `${l.phase}:${l.component}.${l.method}`));
    expect(roots).toEqual(expect.arrayContaining(['init:host_server.init']));
  }, REAL_TREE_TIMEOUT);

  it("the demo tree's MessageBus endpoint is carried as declared", () => {
    const d = exportAt(path.join(REPO_ROOT, 'examples', 'wrapper', 'demo-project'));
    expect(d.source.projectId).toBe('flowops-demo');
    const intake = d.interfaces.find((i) => i.key === 'iintake-portal')!.methods.find((m) => m.name === 'onRecordReceived')!;
    expect(intake.endpoint).toEqual({ transport: 'MessageBus', topic: 'records', event: 'record.received', direction: 'subscribe' });
    expect(d.components.find((c) => c.key === 'intake-portal')!.transport).toBe('MessageBus');
  }, REAL_TREE_TIMEOUT);
});
