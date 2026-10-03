import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { applyRestatement, updateSpecGated, writeSpec, type SpecRestatement } from '../../src/core/authoring.js';
import { invalidateSpecCache, loadInterfaceSpec, loadTypeSpec, saveSpec, saveSystemSpec } from '../../src/core/specs.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Stage 2 type grammar, wave 3: the authoring seam. A create respells every
// alias and reports it (SpecWriteReceipt.respellings), and refuses a position
// with no canonical spelling, naming the replacement — `number` asks "int or
// float?". A delta's hook refuses only the positions the delta itself wrote, so
// a spec holding one from before the grammar can still be edited and repaired.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-04T00:00:00.000Z';
const INTERFACE_FIELDS = ['id', 'name', 'description', 'component', 'methods', 'status'];
const METHOD_FIELDS = ['name', 'description', 'signature', 'returns', 'signatureFrom', 'params', 'guarantees', 'effect', 'invokedBy', 'findings', 'ext'];
const TYPE_FIELDS = ['kind', 'id', 'name', 'description', 'subsystem', 'group', 'fields', 'methods', 'componentClass', 'invariants', 'database', 'table', 'linkedEntity', 'sourcePath', 'symbol', 'params', 'returns', 'values'];
let roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

const contract = (methods: Record<string, unknown>[]): SpecRestatement => ({
  kind: 'interface',
  spec: { id: iBilling, name: 'IBilling', description: 'd', component: 'billing', methods } as unknown as InterfaceSpec,
  fields: INTERFACE_FIELDS,
  memberFields: METHOD_FIELDS,
});
const iBilling = 'ibilling';
const typeRestatement = (spec: Record<string, unknown>): SpecRestatement => ({
  kind: 'type',
  spec: { fields: [], methods: [], ...spec } as unknown as TypeSpec,
  fields: TYPE_FIELDS,
});
const billing = { id: 'billing' } as ComponentSpec;

function tree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-grammar-auth-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'Bill', vision: 'v', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP });
  saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'Bill', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as SubsystemSpec);
  saveSpec('component', { id: 'billing', name: 'billing', description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as ComponentSpec);
  return root;
}

function storedFile(root: string, suffix: string): any {
  const files = fs.readdirSync(path.join(root, '.wai', 'specs'), { recursive: true }) as string[];
  const hit = files.find((f) => f.replace(/\\/g, '/').endsWith(suffix))!;
  return yaml.load(fs.readFileSync(path.join(root, '.wai', 'specs', hit), 'utf8'));
}

describe('spec_restatement.applyTo — a create reads every type position under the grammar', () => {
  it('respells an alias, records it, and derives the text from the canonical types', () => {
    const application = applyRestatement(contract([{
      name: 'save', description: 'd', params: [{ name: 'lines', type: 'Line[]' }, { name: 'ok', type: 'boolean', optional: true }], returns: 'Promise<void>',
    }]), null, billing);
    expect(application.refusal).toBeUndefined();
    const method = (application.spec as InterfaceSpec).methods[0];
    expect(method.params).toEqual([{ name: 'lines', type: 'list<Line>' }, { name: 'ok', type: 'bool', optional: true }]);
    expect(method.returns).toBe('async void');
    expect(method.signature).toBe('save(lines: list<Line>, ok?: bool): async void');
    expect(application.respellings).toEqual([
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.params.lines', written: 'Line[]', stored: 'list<Line>' },
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.params.ok', written: 'boolean', stored: 'bool' },
      { specId: 'ibilling', kind: 'interface', path: 'methods.save.returns', written: 'Promise<void>', stored: 'async void' },
    ]);
  });

  it('answers no respelling for a canonical input', () => {
    const application = applyRestatement(contract([{ name: 'save', description: 'd', params: [{ name: 'lines', type: 'list<Line>' }], returns: 'async void' }]), null, billing);
    expect(application.respellings).toEqual([]);
  });

  it.each([
    ['number', 'TYPE_NOT_NEUTRAL', 'int or float?'],
    ['uuid', 'TYPE_NOT_NEUTRAL', 'named value-object'],
    ['PackSelection | string', 'TYPE_FORM_UNSUPPORTED', 'or two params'],
    ["'global' | 'local'", 'TYPE_FORM_UNSUPPORTED', 'an enum type'],
    ['(e: Event) => void', 'TYPE_FORM_UNSUPPORTED', 'a signature type'],
    ['{ a: string }', 'TYPE_FORM_UNSUPPORTED', 'a named value-object'],
    ['void', 'TYPE_POSITION_INVALID', 'void may stand only'],
    ['Promise<string>', 'TYPE_POSITION_INVALID', 'only at the top of a returns'],
    ['map<bool, string>', 'TYPE_POSITION_INVALID', 'string, int or an enum'],
    ['Line — trailing prose', 'TYPE_EXPRESSION_INVALID', 'does not parse'],
  ])('refuses a param typed %j (%s), naming the replacement', (type, code, words) => {
    const application = applyRestatement(contract([{ name: 'save', description: 'd', params: [{ name: 'x', type }], returns: 'void' }]), null, billing);
    expect(application.refusal).toContain(code);
    expect(application.refusal).toContain('methods.save.params.x');
    expect(application.refusal).toContain(words);
    expect(application.refusal).toContain('Nothing was written.');
  });
});

describe('authoring_orchestrator.writeSpec', () => {
  it('stores the canonical spelling and answers with the respellings', () => {
    const root = tree();
    const receipt = writeSpec(contract([{ name: 'find', description: 'd', params: [{ name: 'id', type: 'string' }], returns: 'Line | null' }]));
    expect(receipt.respellings).toEqual([{ specId: 'ibilling', kind: 'interface', path: 'methods.find.returns', written: 'Line | null', stored: 'Line?' }]);
    const stored = storedFile(root, 'interface.yaml');
    expect(stored.methods[0].returns).toBe('Line?');
    expect(stored.methods[0].signature).toBe('find(id: string): Line?');
  });

  it('refuses `number` with "int or float?" and writes nothing', () => {
    tree();
    expect(() => writeSpec(contract([{ name: 'count', description: 'd', params: [], returns: 'number' }]))).toThrow(/int or float\?/);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ibilling')).toBeNull();
  });

  it('writes an enum with its values in declared order, and its type methods canonical', () => {
    tree();
    const receipt = writeSpec(typeRestatement({
      kind: 'enum', id: 'channel', name: 'Channel', description: 'Release track, narrowest first',
      values: [{ name: 'stable', description: 'Releases only' }, { name: 'beta' }, { name: 'dev' }],
      methods: [{ name: 'isValid', params: [{ name: 'value', type: 'string' }], returns: 'boolean' }],
    }));
    expect(receipt.respellings.map((r) => [r.path, r.stored])).toEqual([['methods.isValid.returns', 'bool']]);
    invalidateSpecCache();
    const loaded = loadTypeSpec('channel')!;
    expect(loaded.kind).toBe('enum');
    expect(loaded.values!.map((v) => v.name)).toEqual(['stable', 'beta', 'dev']);
    expect(loaded.methods[0].signature).toBe('isValid(value: string): bool');
  });
});

describe('the updateSpecGated hook refuses only the positions the delta wrote', () => {
  /** A tree whose contract holds a `number` written before the grammar, by hand. */
  function legacyContract(): string {
    const root = tree();
    writeSpec(contract([
      { name: 'count', description: 'Count the lines', params: [{ name: 'limit', type: 'int' }], returns: 'int' },
      { name: 'find', description: 'Find one', params: [{ name: 'id', type: 'string' }], returns: 'Line?' },
    ]));
    // The hand edit an author made before the grammar existed.
    const files = fs.readdirSync(path.join(root, '.wai', 'specs'), { recursive: true }) as string[];
    const file = path.join(root, '.wai', 'specs', files.find((f) => f.replace(/\\/g, '/').endsWith('interface.yaml'))!);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/type: int/, 'type: number').replace(/returns: int/, 'returns: number'));
    invalidateSpecCache();
    return root;
  }

  it('lets a delta edit a spec holding a stored non-canonical position, which stays as written', () => {
    const root = legacyContract();
    const report = updateSpecGated('interface', 'ibilling', { methods: [{ name: 'find', description: 'Find one line by id' }] });
    expect(report.written).toBe(true);
    expect(storedFile(root, 'interface.yaml').methods[0].params[0].type).toBe('number');
  });

  it('refuses a delta writing a non-canonical position, naming the replacement, and writes nothing', () => {
    const root = legacyContract();
    const before = JSON.stringify(storedFile(root, 'interface.yaml'));
    expect(() => updateSpecGated('interface', 'ibilling', { methods: [{ name: 'find', returns: 'number' }] }))
      .toThrow(/TYPE_NOT_NEUTRAL at methods\.find\.returns.*int or float\?.*Nothing was written/s);
    expect(() => updateSpecGated('interface', 'ibilling', { methods: [{ name: 'find', params: [{ name: 'id', type: 'Line | string' }] }] }))
      .toThrow(/TYPE_FORM_UNSUPPORTED at methods\.find\.params\.id/);
    expect(JSON.stringify(storedFile(root, 'interface.yaml'))).toBe(before);
  });

  it('accepts a delta repairing the stored position, and reports a delta\'s alias as a respelling', () => {
    const root = legacyContract();
    const report = updateSpecGated('interface', 'ibilling', { methods: [{ name: 'count', params: [{ name: 'limit', type: 'int' }], returns: 'i64' }] });
    expect(report.written).toBe(true);
    expect(report.respellings).toEqual([{ specId: 'ibilling', kind: 'interface', path: 'methods.count.returns', written: 'i64', stored: 'int' }]);
    const stored = storedFile(root, 'interface.yaml').methods[0];
    expect(stored.params[0].type).toBe('int');
    expect(stored.returns).toBe('int');
    expect(stored.signature).toBe('count(limit: int): int');
  });

  it('answers on a dry run the respellings it would apply', () => {
    tree();
    writeSpec(contract([{ name: 'find', description: 'd', params: [{ name: 'id', type: 'string' }], returns: 'Line?' }]));
    const report = updateSpecGated('interface', 'ibilling', { methods: [{ name: 'find', returns: 'Line[]' }] }, true);
    expect(report.dryRun).toBe(true);
    expect(report.respellings).toEqual([{ specId: 'ibilling', kind: 'interface', path: 'methods.find.returns', written: 'Line[]', stored: 'list<Line>' }]);
    invalidateSpecCache();
    expect(loadInterfaceSpec('ibilling')!.methods[0].returns).toBe('Line?');
  });
});
