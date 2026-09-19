import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, listFilesRecursive } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  saveImplementationSpec,
  saveTypeSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  renameComponent,
  renameMethod,
  externalizeSubsystem,
  internalizeSubsystem,
} from '../../src/core/provision.js';
import { validateSddTree } from '../../src/core/validation.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// A migration must not mangle a union type reference.
//
// Four migrations rewrite reference fields across a whole tree, and one of the
// positions they rewrite is a method parameter's `type` and a type field's
// `type` — the very fields that hold `Invoice | null`. The rewrite is a
// WHOLE-STRING remap: it replaces a field that equals a renamed id and leaves
// everything else exactly as written. A union is never equal to a bare id, so
// it is left alone — which is the behaviour to pin, because the alternative (a
// substring rewrite) would quietly turn `Invoice | null` into something else
// the day someone renamed a type.
//
// The tree holds well over a hundred such refs. None of them has any business
// changing because a component was renamed.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

// The unions below name the entity by its stored ID (`invoice`), not by its
// display name, so that externalizing the subsystem puts a MEMBER of each union
// in the rename map. That is the case worth pinning: a rewrite that went
// word-by-word would find the member and rewrite the string around it; the
// whole-string rewrite finds nothing to match and leaves the union verbatim.
const RETURN_UNION = 'invoice | null';
const PARAM_UNION = 'Map<string, invoice> | undefined';
const FIELD_UNION = 'invoice[] | null';

const sub = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'billing-sys',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now, ...over,
});
const comp = (id: string, subsystem: string, componentType: string, over: Record<string, unknown> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem, componentType, owns: [], dependsOn: [], createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);

function projectRoot(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(dir, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: path.basename(dir),
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  return dir;
}

/**
 * Every type reference any spec file under the root stores, wherever it sits:
 * the `type` of a parameter or a field, and every `returns`. A narrative step's
 * own `type` rides along, and should be just as untouched.
 */
function everyTypeRef(root: string): string[] {
  const refs: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if ((key === 'type' || key === 'returns') && typeof nested === 'string') refs.push(nested);
      else walk(nested);
    }
  };
  // The whole root, not just its own .wai: externalizing moves the subsystem's
  // specs into a child project, and the refs have to be found wherever they land.
  for (const file of listFilesRecursive(root, '.yaml')) {
    if (!file.includes(`${path.sep}specs${path.sep}`)) continue;
    walk(readYamlFile(file));
  }
  return refs.sort();
}

/** Every finding as `severity CODE @specId`, sorted — what a migration must not change. */
function findings(root: string): string[] {
  invalidateSpecCache();
  setProjectRoot(root);
  return validateSddTree().issues.map((i) => `${i.severity} ${i.code} @${i.specId}`).sort();
}

/**
 * A `billing` subsystem whose contract names a union in a return, in a
 * structured parameter and in an entity field — every position a reference
 * rewrite touches a `type`.
 */
function billing(): string {
  const root = projectRoot('union-migration-');
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name: 'billing-sys', vision: 'v',
    boundaries: [], globalRequirements: [], databases: [], publicInterfaces: [],
    createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec(sub('billing'));
  saveComponentSpec(comp('invoice_store', 'billing', 'Store', { durability: 'durable' }));
  saveInterfaceSpec({
    id: 'iinvoice_store', name: 'iinvoice_store', description: 'd', component: 'invoice_store',
    createdAt: now, updatedAt: now,
    methods: [{
      name: 'getById',
      description: 'The invoice with that id, or nothing.',
      signature: `getById(id: string, index: ${PARAM_UNION}): ${RETURN_UNION}`,
      returns: RETURN_UNION,
      params: [
        { name: 'id', type: 'string' },
        { name: 'index', type: PARAM_UNION },
      ],
      effect: 'read',
    }],
  } as InterfaceSpec);
  saveImplementationSpec({
    id: 'invoice_store_impl', name: 'invoice_store_impl', description: 'd', contract: 'iinvoice_store',
    createdAt: now, updatedAt: now,
    methods: [{ name: 'getById', narrative: [{ stepNumber: 1, description: 'read it', type: 'local' }] }],
  } as any);
  saveTypeSpec({
    kind: 'entity', id: 'invoice', name: 'invoice', subsystem: 'billing',
    componentClass: 'invoice_store',
    fields: [{ name: 'related', type: FIELD_UNION, optional: true }],
    methods: [], createdAt: now, updatedAt: now,
  } as any);

  // A second subsystem that STAYS BEHIND when billing is externalized, and whose
  // contract names billing's entity three ways: bare, and inside two unions. The
  // bare one is what the reference rewrite can match whole — so it proves the
  // rewrite reached this file at all, which is what makes "the unions are
  // unchanged" mean something.
  saveSubsystemSpec(sub('reporting'));
  saveComponentSpec(comp('report_builder', 'reporting', 'Orchestrator'));
  saveInterfaceSpec({
    id: 'ireport_builder', name: 'ireport_builder', description: 'd', component: 'report_builder',
    createdAt: now, updatedAt: now,
    methods: [{
      name: 'summarize',
      description: 'The summary of those invoices.',
      signature: 'summarize(one: invoice, many: invoice[] | null): invoice | null',
      returns: RETURN_UNION,
      params: [
        { name: 'one', type: 'invoice' },
        { name: 'many', type: FIELD_UNION },
        { name: 'index', type: PARAM_UNION },
      ],
    }],
  } as InterfaceSpec);
  invalidateSpecCache();
  return root;
}

/** The params of the reporting contract, wherever its file has ended up. */
function reportingParams(root: string): Record<string, string> {
  const file = listFilesRecursive(root, '.yaml')
    .find((f) => (readYamlFile(f) as any)?.id === 'ireport_builder') as string;
  const spec = readYamlFile(file) as any;
  return Object.fromEntries(spec.methods[0].params.map((p: any) => [p.name, p.type]));
}

const roots: string[] = [];
const freshBilling = (): string => { const r = billing(); roots.push(r); return r; };

afterEach(() => {
  while (roots.length) {
    const root = roots.pop() as string;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
  invalidateSpecCache();
});

describe('a migration leaves a union type reference exactly as written', () => {
  it('renaming the component that owns them changes no type reference at all', () => {
    const root = freshBilling();
    const before = everyTypeRef(root);

    renameComponent('invoice_store', 'invoice_vault');

    expect(everyTypeRef(root)).toEqual(before);
    expect(before).toContain(RETURN_UNION);
    expect(before).toContain(PARAM_UNION);
    expect(before).toContain(FIELD_UNION);
  });

  it('renaming a contract method rewrites its name, never its parameter or return types', () => {
    const root = freshBilling();
    const before = everyTypeRef(root);

    renameMethod('invoice_store', 'getById', 'byId');

    expect(everyTypeRef(root)).toEqual(before);
    // The signature's method name moved; the union it returns did not.
    const contract = readYamlFile(
      listFilesRecursive(path.join(root, '.wai', 'specs'), '.yaml')
        .find((f) => (readYamlFile(f) as any)?.id === 'iinvoice_store') as string,
    ) as any;
    expect(contract.methods[0].name).toBe('byId');
    expect(contract.methods[0].signature).toBe(`byId(id: string, index: ${PARAM_UNION}): ${RETURN_UNION}`);
    expect(contract.methods[0].returns).toBe(RETURN_UNION);
  });

  it('externalizing qualifies a bare type reference and leaves a union exactly as written', () => {
    const root = freshBilling();
    expect(reportingParams(root)).toEqual({ one: 'invoice', many: FIELD_UNION, index: PARAM_UNION });
    const typeFindingsBefore = findings(root).filter((f) => f.includes('TYPE'));

    // The rewrite qualifies the ids it can match WHOLE: bare `invoice` becomes
    // `billing::invoice`. A union is never equal to a bare id, so every union is
    // left exactly as written — INCLUDING the ones whose member is in the rename
    // map. That is not a dangling reference: a type ref matches by name as a
    // SUFFIX of the qualified id, whichever namespace the naming spec sits in,
    // so the unqualified `invoice` inside the union still resolves.
    externalizeSubsystem('billing', 'sub/billing');
    invalidateSpecCache();
    setProjectRoot(root);

    expect(reportingParams(root)).toEqual({
      one: 'billing::invoice',       // matched whole, and rewritten
      many: FIELD_UNION,             // a union: left verbatim
      index: PARAM_UNION,            // a generic inside a union: left verbatim
    });
    // And no type reference started failing to resolve because of it.
    expect(findings(root).filter((f) => f.includes('TYPE'))).toEqual(typeFindingsBefore);
  });

  it('internalizing it back leaves them alone too', () => {
    const root = freshBilling();
    const before = everyTypeRef(root);

    externalizeSubsystem('billing', 'sub/billing');
    invalidateSpecCache();
    setProjectRoot(root);
    internalizeSubsystem('billing');
    invalidateSpecCache();
    setProjectRoot(root);

    expect(everyTypeRef(root)).toEqual(before);
  });
});
