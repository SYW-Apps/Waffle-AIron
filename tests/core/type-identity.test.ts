import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { validateProject } from '../../src/core/validation.js';
import { invalidateSpecCache, loadTypeSpec, loadTypeSpecs } from '../../src/core/specs.js';
import { renameType } from '../../src/core/provision.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { resolveTypeRef } from '../../src/models/index.js';
import type { RulesConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// Type identity: a bare type reference resolves in the referrer's own subsystem
// first; a reference that binds elsewhere while its own subsystem holds a type
// of that name is AMBIGUOUS_TYPE_REF; both halves of a duplicate type id stay
// reachable (`subsystem::id`) and renameable, each touching only the
// references that resolve to it.
// ---------------------------------------------------------------------------

const STAMP = { createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' };
const RULES: RulesConfig = { noOverlappingOwnership: true, requireOwnedPaths: true, metaAgentTags: ['meta'], enforceReproducibility: true };

type Spec = Record<string, unknown>;
let root = '';

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* win file locks */ }
  root = '';
});

function project() {
  invalidateSpecCache();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-type-identity-')));
  const specs = path.join(root, '.wai', 'specs');
  for (const d of ['subsystems', 'components', 'interfaces', 'implementations', 'types']) fs.mkdirSync(path.join(specs, d), { recursive: true });
  const dump = (file: string, data: unknown) => fs.writeFileSync(file, yaml.dump(data, { noRefs: true, lineWidth: 200 }));
  dump(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'type-identity', targets: [], rules: RULES, extensions: { packs: [], useGlobalPacks: false }, ...STAMP,
  });
  dump(path.join(specs, '.index.yaml'), { schemaVersion: '1.0.0', name: 'TestSystem', vision: 'Exercises type identity.', ...STAMP });
  const write = (dir: string, file: string, data: Spec) => dump(path.join(specs, dir, `${file}.yaml`), { schemaVersion: '1.0.0', ...data, ...STAMP });
  const api = {
    subsystem: (id: string) => write('subsystems', id, { id, name: id, description: `The ${id} subsystem.`, parentSystem: 'TestSystem' }),
    type: (file: string, id: string, name: string, subsystem?: string) =>
      write('types', file, { kind: 'value-object', id, name, ...(subsystem !== undefined ? { subsystem } : {}), description: `The ${name} type.`, fields: [{ name: 'code', type: 'string', description: 'A code', optional: false }], methods: [] }),
    /** A component of `subsystem` whose contract has one method taking `paramType`. */
    user: (id: string, subsystem: string, paramType: string, returns = 'void') => {
      write('components', id, { id, name: id, description: `The ${id} component.`, subsystem, componentType: 'Orchestrator', dependsOn: [], owns: [] });
      write('interfaces', `i${id}`, {
        id: `i${id}`, name: `I${id}`, description: `The contract of ${id}.`, component: id,
        methods: [{ name: 'emit', description: 'Emits one binding, observably.', returns, params: [{ name: 'binding', type: paramType, description: 'The binding' }] }],
      });
    },
    param: (id: string) => {
      const doc = yaml.load(fs.readFileSync(path.join(specs, 'interfaces', `i${id}.yaml`), 'utf8')) as any;
      return doc.methods[0].params[0].type as string;
    },
    validate: () => {
      invalidateSpecCache();
      setProjectRoot(root);
      return validateProject({ rules: RULES, projectType: 'backend' });
    },
    snapshot: (): Record<string, string> => {
      const out: Record<string, string> = {};
      const walk = (dir: string): void => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
        }
      };
      walk(path.join(root, '.wai'));
      return out;
    },
  };
  return api;
}

const t = (id: string, name: string, subsystem?: string) => ({ id, name, subsystem });

describe('resolveTypeRef', () => {
  it('prefers the referrer\'s own subsystem, then the single candidate', () => {
    const types = [t('money', 'Money', 'billing'), t('money', 'Money', 'shipping'), t('rate', 'Rate', 'shipping')];
    expect(resolveTypeRef('Money', 'billing', types)).toMatchObject({ outcome: 'resolved', type: 'money', candidates: ['billing::money', 'shipping::money'] });
    expect(resolveTypeRef('Rate', 'billing', types)).toMatchObject({ outcome: 'resolved', type: 'rate' });
  });

  it('is ambiguous when several types match and none is in the referrer\'s subsystem; none when nothing matches', () => {
    const types = [t('money', 'Money', 'billing'), t('money', 'Money', 'shipping')];
    expect(resolveTypeRef('Money', 'crm', types)).toMatchObject({ outcome: 'ambiguous', candidates: ['billing::money', 'shipping::money'] });
    expect(resolveTypeRef('Money', undefined, types).outcome).toBe('ambiguous');
    expect(resolveTypeRef('Nothing', 'billing', types)).toEqual({ outcome: 'none', candidates: [] });
    expect(resolveTypeRef('Money', 'billing', [t('money', 'Money', 'billing'), t('shipping::money', 'Money', 'billing')])).toMatchObject({ outcome: 'ambiguous' });
  });

  it('reports a type of the referrer\'s subsystem with the same display name as shadowedBy', () => {
    const types = [t('cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu'), t('x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86')];
    const r = resolveTypeRef('CpuPrimitiveBinding', 'cpu-x86', types);
    expect(r).toMatchObject({ outcome: 'resolved', type: 'cpu-primitive-binding', shadowedBy: 'x86-primitive-binding' });
    expect(resolveTypeRef('CpuPrimitiveBinding', 'cpu', types).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('x86-primitive-binding', 'cpu-x86', types).shadowedBy).toBeUndefined();
  });
});

describe('AMBIGUOUS_TYPE_REF', () => {
  it('warns when a reference binds to another subsystem\'s type while its own subsystem holds one with that name', () => {
    const p = project();
    p.subsystem('cpu');
    p.subsystem('cpu-x86');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.type('x86-primitive-binding', 'x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
    p.user('x86-emitter', 'cpu-x86', 'CpuPrimitiveBinding');
    p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
    const found = p.validate().issues.filter((i) => i.code === 'AMBIGUOUS_TYPE_REF');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'warning', specId: 'ix86-emitter' });
    expect(found[0].message).toContain('binds to cpu::cpu-primitive-binding');
    expect(found[0].message).toContain('subsystem cpu-x86 holds x86-primitive-binding');
    expect(found[0].message).toContain('(at method emit param binding)');
  });

  it('is quiet when the reference names the type of its own subsystem', () => {
    const p = project();
    p.subsystem('cpu');
    p.subsystem('cpu-x86');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.type('x86-primitive-binding', 'x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
    p.user('x86-emitter', 'cpu-x86', 'x86-primitive-binding');
    p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
    expect(p.validate().issues.filter((i) => i.code === 'AMBIGUOUS_TYPE_REF')).toEqual([]);
  });
});

/** Two types declaring one id in two subsystems, each used by a component of its own subsystem. */
function duplicates() {
  const p = project();
  p.subsystem('cpu');
  p.subsystem('cpu-x86');
  p.subsystem('crm');
  p.type('a-cpu', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
  p.type('b-x86', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
  p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
  p.user('x86-emitter', 'cpu-x86', 'CpuPrimitiveBinding');
  setProjectRoot(root);
  invalidateSpecCache();
  const keptSubsystem = loadTypeSpecs().find((x) => x.id === 'cpu-primitive-binding')!.subsystem!;
  const otherSubsystem = keptSubsystem === 'cpu' ? 'cpu-x86' : 'cpu';
  return { p, keptSubsystem, otherSubsystem };
}

const userOf = (subsystem: string): string => (subsystem === 'cpu' ? 'cpu-emitter' : 'x86-emitter');
const fileOf = (subsystem: string): string => (subsystem === 'cpu' ? 'a-cpu' : 'b-x86');
const typesFile = (name: string): string => path.join('.wai', 'specs', 'types', `${name}.yaml`);

describe('a duplicate type id across two subsystems', () => {
  it('names both halves\' rename calls in DUPLICATE_SPEC_ID', () => {
    const { p, keptSubsystem, otherSubsystem } = duplicates();
    const dup = p.validate().issues.find((i) => i.code === 'DUPLICATE_SPEC_ID' && i.specId?.endsWith('cpu-primitive-binding'));
    expect(dup).toBeDefined();
    expect(dup!.message).toContain(`sdd_rename_type ${keptSubsystem}::cpu-primitive-binding <new id>`);
    expect(dup!.message).toContain(`sdd_rename_type ${otherSubsystem}::cpu-primitive-binding <new id>`);
  });

  it('loadTypeSpec reaches the second half by its qualified id', () => {
    const { otherSubsystem, keptSubsystem } = duplicates();
    expect(loadTypeSpec(`${keptSubsystem}::cpu-primitive-binding`)?.subsystem).toBe(keptSubsystem);
    expect(loadTypeSpec(`${otherSubsystem}::cpu-primitive-binding`)?.subsystem).toBe(otherSubsystem);
    expect(loadTypeSpecs().filter((x) => x.id === 'cpu-primitive-binding')).toHaveLength(1);
  });

  it('renaming the second half moves only its file and respells only the references of its own subsystem', () => {
    const { p, keptSubsystem, otherSubsystem } = duplicates();
    const before = p.snapshot();
    const result = renameType(`${otherSubsystem}::cpu-primitive-binding`, 'cpu-binding');
    expect(result).toMatchObject({ from: `${otherSubsystem}::cpu-primitive-binding`, to: `${otherSubsystem}::cpu-binding` });
    const after = p.snapshot();
    // The kept half's file is untouched, and so is the contract of its subsystem.
    expect(after[typesFile(fileOf(keptSubsystem))]).toBe(before[typesFile(fileOf(keptSubsystem))]);
    expect(p.param(userOf(keptSubsystem))).toBe('CpuPrimitiveBinding');
    // The renamed half's own file left its place, and the contract of its subsystem follows.
    expect(after[typesFile(fileOf(otherSubsystem))]).toBeUndefined();
    expect(p.param(userOf(otherSubsystem))).toBe('CpuBinding');
    invalidateSpecCache();
    expect(loadTypeSpec(`${otherSubsystem}::cpu-binding`)).toMatchObject({ id: 'cpu-binding', previousIds: ['cpu-primitive-binding'] });
    expect(loadTypeSpec('cpu-primitive-binding')?.subsystem).toBe(keptSubsystem);
    expect(p.validate().issues.filter((i) => i.code === 'DUPLICATE_SPEC_ID')).toEqual([]);
  });

  it('renaming the kept half leaves the references of the other half\'s subsystem alone', () => {
    const { p, keptSubsystem, otherSubsystem } = duplicates();
    renameType(`${keptSubsystem}::cpu-primitive-binding`, 'cpu-binding');
    expect(p.param(userOf(keptSubsystem))).toBe('CpuBinding');
    expect(p.param(userOf(otherSubsystem))).toBe('CpuPrimitiveBinding');
    invalidateSpecCache();
    expect(loadTypeSpec(`${keptSubsystem}::cpu-binding`)?.subsystem).toBe(keptSubsystem);
    expect(loadTypeSpec('cpu-primitive-binding')?.subsystem).toBe(otherSubsystem);
  });

  it('refuses an ambiguous reference before writing anything', () => {
    const { p, keptSubsystem } = duplicates();
    p.user('crm-emitter', 'crm', 'CpuPrimitiveBinding');
    const before = p.snapshot();
    expect(() => renameType(`${keptSubsystem}::cpu-primitive-binding`, 'cpu-binding'))
      .toThrow(/ambiguous-ref: 1 references match several types including .+: \.wai\/specs\/interfaces\/icrm-emitter\.yaml method emit param binding: "CpuPrimitiveBinding" matches .+ — qualify each as subsystem::name first/);
    expect(p.snapshot()).toEqual(before);
  });
});

describe('renameType resolves references from where they are written', () => {
  it('leaves a reference alone that names the same-named type of another subsystem', () => {
    const p = project();
    p.subsystem('cpu');
    p.subsystem('cpu-x86');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.type('x86-primitive-binding', 'x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
    p.user('x86-emitter', 'cpu-x86', 'x86-primitive-binding');
    p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
    setProjectRoot(root);
    renameType('cpu::cpu-primitive-binding', 'cpu-binding');
    expect(p.param('x86-emitter')).toBe('x86-primitive-binding');
    expect(p.param('cpu-emitter')).toBe('CpuBinding');
  });
});

describe('shadowing by closeness', () => {
  const ty = (id: string, name: string, subsystem?: string) => ({ id, name, ...(subsystem !== undefined ? { subsystem } : {}) });

  it('shadows when another type of that name is at least as close; not when it is farther', () => {
    // bound far, same name near (the reported case); bound far, same name in the middle.
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate', 'quoting'), ty('duty-rate', 'FreightRate', 'customs')]).shadowedBy).toBe('duty-rate');
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate', 'quoting'), ty('duty-rate', 'FreightRate')]).shadowedBy).toBe('duty-rate');
    // bound near, the other in the middle or far: not shadowed.
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate', 'customs'), ty('duty-rate', 'FreightRate')]).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate', 'customs'), ty('duty-rate', 'FreightRate', 'quoting')]).shadowedBy).toBeUndefined();
    // bound in the middle: a far one does not shadow, a near one does, an equal one does.
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate'), ty('duty-rate', 'FreightRate', 'quoting')]).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate'), ty('duty-rate', 'FreightRate', 'customs')]).shadowedBy).toBe('duty-rate');
    expect(resolveTypeRef('FreightRate', 'customs', [ty('freight-rate', 'FreightRate'), ty('duty-rate', 'FreightRate')]).shadowedBy).toBe('duty-rate');
  });

  it('a referrer with no subsystem sees project-level types as middle and subsystem types as far', () => {
    expect(resolveTypeRef('FreightRate', undefined, [ty('freight-rate', 'FreightRate'), ty('duty-rate', 'FreightRate')]).shadowedBy).toBe('duty-rate');
    expect(resolveTypeRef('FreightRate', undefined, [ty('freight-rate', 'FreightRate'), ty('duty-rate', 'FreightRate', 'customs')]).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('FreightRate', undefined, [ty('freight-rate', 'FreightRate', 'quoting'), ty('duty-rate', 'FreightRate', 'customs')]).shadowedBy).toBe('duty-rate');
  });

  it('takes the closest shadow, the first in input order on a tie', () => {
    const types = [ty('freight-rate', 'FreightRate', 'quoting'), ty('a-rate', 'FreightRate'), ty('b-rate', 'FreightRate', 'customs'), ty('c-rate', 'FreightRate', 'customs')];
    expect(resolveTypeRef('FreightRate', 'customs', types).shadowedBy).toBe('b-rate');
    expect(resolveTypeRef('FreightRate', 'crm', [types[0], types[1], types[3], types[2]]).shadowedBy).toBe('a-rate');
  });

  it('is never shadowed when the reference is qualified or written exactly as the bound types id', () => {
    const types = [ty('cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu'), ty('x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86')];
    expect(resolveTypeRef('cpu::cpu-primitive-binding', 'cpu-x86', types)).toMatchObject({ outcome: 'resolved', type: 'cpu-primitive-binding' });
    expect(resolveTypeRef('cpu::cpu-primitive-binding', 'cpu-x86', types).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('cpu-primitive-binding', 'cpu-x86', types).shadowedBy).toBeUndefined();
    expect(resolveTypeRef('CpuPrimitiveBinding', 'cpu-x86', types).shadowedBy).toBe('x86-primitive-binding');
  });

  it('warns for two project-level types sharing a display name, naming the project level', () => {
    const p = project();
    p.subsystem('customs');
    p.type('freight-rate', 'freight-rate', 'FreightRate');
    p.type('duty-rate', 'duty-rate', 'FreightRate');
    p.user('customs-declarant', 'customs', 'FreightRate');
    const found = p.validate().issues.filter((i) => i.code === 'AMBIGUOUS_TYPE_REF');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('binds to freight-rate, while the project level holds duty-rate, also named FreightRate');
  });

  it('is quiet when the reference is written as the exact id', () => {
    const p = project();
    p.subsystem('customs');
    p.type('freight-rate', 'freight-rate', 'FreightRate');
    p.type('duty-rate', 'duty-rate', 'FreightRate');
    p.user('customs-declarant', 'customs', 'freight-rate');
    expect(p.validate().issues.filter((i) => i.code === 'AMBIGUOUS_TYPE_REF')).toEqual([]);
  });

  it('is one finding per written reference, naming every position it is written at', () => {
    const p = project();
    p.subsystem('cpu');
    p.subsystem('cpu-x86');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.type('x86-primitive-binding', 'x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
    p.user('x86-emitter', 'cpu-x86', 'CpuPrimitiveBinding', 'CpuPrimitiveBinding');
    const found = p.validate().issues.filter((i) => i.code === 'AMBIGUOUS_TYPE_REF');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('(at method emit param binding, method emit returns)');
  });
});

describe('renameType and shadowed references', () => {
  /** cpu's type is renamed while cpu-x86's contract writes the shared display name (it binds to cpu's, shadowing x86's own). */
  function shadowedTree() {
    const p = project();
    p.subsystem('cpu');
    p.subsystem('cpu-x86');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.type('x86-primitive-binding', 'x86-primitive-binding', 'CpuPrimitiveBinding', 'cpu-x86');
    p.user('x86-emitter', 'cpu-x86', 'CpuPrimitiveBinding');
    p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
    setProjectRoot(root);
    invalidateSpecCache();
    return p;
  }
  const site = {
    spec: 'ix86-emitter', file: '.wai/specs/interfaces/ix86-emitter.yaml', position: 'method emit param binding',
    token: 'CpuPrimitiveBinding', boundTo: 'cpu::cpu-primitive-binding', shadowedBy: 'x86-primitive-binding',
  };

  it('refuses, naming every shadowed site, and writes nothing', () => {
    const p = shadowedTree();
    const before = p.snapshot();
    let message = '';
    try { renameType('cpu::cpu-primitive-binding', 'cpu-binding'); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('shadowed-ref: 1 references bind to cpu::cpu-primitive-binding while another type carries that name');
    expect(message).toContain('.wai/specs/interfaces/ix86-emitter.yaml method emit param binding: "CpuPrimitiveBinding" binds to cpu::cpu-primitive-binding while x86-primitive-binding carries that name');
    expect(message).toContain('allowShadowed: true');
    expect(p.snapshot()).toEqual(before);
  });

  it('allowShadowed renames, respells the shadowed site and lists it', () => {
    const p = shadowedTree();
    const result = renameType('cpu::cpu-primitive-binding', 'cpu-binding', false, true);
    expect(result.shadowed).toEqual([site]);
    expect(p.param('x86-emitter')).toBe('CpuBinding');
    expect(p.param('cpu-emitter')).toBe('CpuBinding');
  });

  it('a dry run lists the shadowed sites separately and writes nothing', () => {
    const p = shadowedTree();
    const before = p.snapshot();
    const result = renameType('cpu::cpu-primitive-binding', 'cpu-binding', true);
    expect(result.dryRun).toBe(true);
    expect(result.shadowed).toEqual([site]);
    expect(p.snapshot()).toEqual(before);
  });

  it('reports no shadowed field when nothing is shadowed', () => {
    const p = project();
    p.subsystem('cpu');
    p.type('cpu-primitive-binding', 'cpu-primitive-binding', 'CpuPrimitiveBinding', 'cpu');
    p.user('cpu-emitter', 'cpu', 'CpuPrimitiveBinding');
    setProjectRoot(root);
    expect(renameType('cpu::cpu-primitive-binding', 'cpu-binding', true).shadowed).toBeUndefined();
  });

  it('an ambiguous site still refuses a dry run, even with allowShadowed', () => {
    const { p, keptSubsystem } = duplicates();
    p.user('crm-emitter', 'crm', 'CpuPrimitiveBinding');
    const before = p.snapshot();
    expect(() => renameType(`${keptSubsystem}::cpu-primitive-binding`, 'cpu-binding', true, true))
      .toThrow(/ambiguous-ref: 1 references match several types including .+: \.wai\/specs\/interfaces\/icrm-emitter\.yaml method emit param binding: "CpuPrimitiveBinding" matches .+ — qualify each as subsystem::name first/);
    expect(p.snapshot()).toEqual(before);
  });
});
