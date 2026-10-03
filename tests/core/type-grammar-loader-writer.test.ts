import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  dryRunSerializeSpecs,
  invalidateSpecCache,
  loadInterfaceSpec,
  loadSpec,
  loadTypeSpec,
  saveSpec,
  saveSystemSpec,
  signatureFacts,
  specKind,
  typeSpellingFacts,
  updateSpec,
} from '../../src/core/specs.js';
import { resolveSignatures, typeSpellingFacts as portalTypeSpellingFacts } from '../../src/core/index.js';
import { typeSpellingFacts as adapterTypeSpellingFacts } from '../../src/core/adapters/validator-core.js';
import { buildRuleContext } from '../../src/core/rules/index.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Stage 2 type grammar, wave 2: the loader, the writer and the facts path.
//
// A tree written before the grammar holds TypeScript spellings. The scan reads
// every structured type position canonical IN MEMORY (spec_index step 18), so
// every consumer sees one spelling, and keeps what the files hold as facts
// (SpecIndex.typeSpellings). The writer stores canonical text; a position that
// cannot be made canonical is written exactly as it stands.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-04T00:00:00.000Z';
let roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
  roots = [];
});

const specsDir = (root: string, ...parts: string[]): string => path.join(root, '.wai', 'specs', ...parts);
const writeYaml = (file: string, doc: unknown): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, yaml.dump(doc, { lineWidth: -1 }));
};
const readYaml = (file: string): any => yaml.load(fs.readFileSync(file, 'utf8'));

/** An interface as a pre-grammar file holds it: TypeScript spellings everywhere, and one `number`. */
const LEGACY_INTERFACE = {
  id: 'ibilling', name: 'IBilling', description: 'Billing contract', component: 'billing', status: 'draft', createdAt: STAMP, updatedAt: STAMP,
  methods: [
    {
      name: 'save', description: 'Save the lines',
      signature: 'save(lines: Line[], note?: string | undefined): Promise<void>',
      params: [{ name: 'lines', type: 'Line[]' }, { name: 'note', type: 'string | undefined', optional: true }],
      returns: 'Promise<void>',
    },
    { name: 'find', description: 'Find one', signature: 'find(id: string): Line | null', returns: 'Line | null' },
    {
      name: 'count', description: 'Count them',
      signature: 'count(limit: number): number',
      params: [{ name: 'limit', type: 'number' }], returns: 'number',
    },
    {
      name: 'stale', description: 'A text its params contradict',
      signature: 'stale(other: string): boolean',
      params: [{ name: 'flag', type: 'boolean' }], returns: 'boolean',
    },
  ],
};

const LEGACY_TYPE = {
  kind: 'value-object', id: 'line', name: 'Line', description: 'One line', createdAt: STAMP, updatedAt: STAMP,
  fields: [
    { name: 'tags', type: 'Set<string>', optional: false },
    { name: 'meta', type: 'Record<string, unknown>', optional: false },
    { name: 'paidAt', type: 'Date | undefined', optional: true },
    { name: 'onChange', type: '(e: Line) => void', optional: false },
  ],
  methods: [{ name: 'isPaid', signature: 'isPaid(strict: boolean): boolean', params: [{ name: 'strict', type: 'boolean' }], returns: 'boolean' }],
};

/** A pre-grammar tree: the system, a subsystem, a component, and the two legacy documents written by hand. */
function legacyTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-grammar-'));
  roots.push(root);
  fs.mkdirSync(specsDir(root), { recursive: true });
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'Bill', vision: 'v', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP });
  saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'Bill', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as SubsystemSpec);
  saveSpec('component', { id: 'billing', name: 'billing', description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as ComponentSpec);
  writeYaml(specsDir(root, 'interfaces', 'ibilling.yaml'), LEGACY_INTERFACE);
  writeYaml(specsDir(root, 'types', 'line.yaml'), LEGACY_TYPE);
  invalidateSpecCache();
  return root;
}

/** The file a spec is stored in, found under the specs folder. */
function fileOf(root: string, suffix: string): string {
  const files = fs.readdirSync(specsDir(root), { recursive: true }) as string[];
  const hit = files.find((f) => f.replace(/\\/g, '/').endsWith(suffix));
  if (!hit) throw new Error(`no file ending ${suffix}`);
  return specsDir(root, hit);
}

describe('the scan reads every type position canonical (spec_index step 18)', () => {
  it('respells the loaded contract in memory and keeps a position that cannot be canonical as written', () => {
    legacyTree();
    const intf = loadInterfaceSpec('ibilling')!;
    const [save, find, count, stale] = intf.methods;
    expect(save.params).toEqual([{ name: 'lines', type: 'list<Line>' }, { name: 'note', type: 'string', optional: true }]);
    expect(save.returns).toBe('async void');
    expect(find.returns).toBe('Line?');
    // A prose method keeps its prose: the grammar governs structured positions only.
    expect(find.signature).toBe('find(id: string): Line | null');
    expect(count.params![0].type).toBe('number');
    expect(count.returns).toBe('number');
    expect(stale.params![0].type).toBe('bool');
  });

  it('derives every params-bearing text from the canonical types', () => {
    legacyTree();
    const intf = loadInterfaceSpec('ibilling')!;
    expect(intf.methods[0].signature).toBe('save(lines: list<Line>, note?: string): async void');
    expect(loadTypeSpec('line')!.methods[0].signature).toBe('isPaid(strict: bool): bool');
  });

  it('reads a type\'s fields and methods at their own positions', () => {
    legacyTree();
    const type = loadTypeSpec('line')!;
    expect(type.fields.map((f) => f.type)).toEqual(['set<string>', 'map<string, any>', 'datetime', '(e: Line) => void']);
    expect(type.methods[0].params![0].type).toBe('bool');
  });

  it('keeps what the files hold as facts: every alias as a respelling, every non-canonical position as a located problem', () => {
    legacyTree();
    const facts = typeSpellingFacts();
    expect(facts.respellings.map((r) => [r.specId, r.path, r.written, r.stored])).toEqual(expect.arrayContaining([
      ['ibilling', 'methods.save.params.lines', 'Line[]', 'list<Line>'],
      ['ibilling', 'methods.save.params.note', 'string | undefined', 'string'],
      ['ibilling', 'methods.save.returns', 'Promise<void>', 'async void'],
      ['ibilling', 'methods.find.returns', 'Line | null', 'Line?'],
      ['line', 'fields.tags', 'Set<string>', 'set<string>'],
      ['line', 'fields.paidAt', 'Date | undefined', 'datetime'],
      ['line', 'methods.isPaid.returns', 'boolean', 'bool'],
    ]));
    expect(facts.problems.map((p) => [p.code, p.specId, p.kind, p.path, p.written])).toEqual([
      ['TYPE_NOT_NEUTRAL', 'ibilling', 'interface', 'methods.count.params.limit', 'number'],
      ['TYPE_NOT_NEUTRAL', 'ibilling', 'interface', 'methods.count.returns', 'number'],
      ['TYPE_FORM_UNSUPPORTED', 'line', 'type', 'fields.onChange', '(e: Line) => void'],
    ]);
  });

  it('reports a stored text stale only when it contradicts its params as stored — never for an alias spelling alone', () => {
    legacyTree();
    const stale = signatureFacts().staleTexts;
    // save's and isPaid's stored texts differ from the canonical text only by
    // spelling: TYPE_SPELLING_STALE's to report, and one save repairs both.
    expect(stale.map((s) => s.method)).toEqual(['stale']);
    expect(stale[0]).toMatchObject({ specId: 'ibilling', stored: 'stale(other: string): boolean', derived: 'stale(flag: bool): bool' });
  });

  it('reaches the validator along the signature facts\' path: index → loader → tree portal → validator adapter → rule context', () => {
    legacyTree();
    const facts = typeSpellingFacts();
    expect(portalTypeSpellingFacts()).toBe(facts);
    expect(adapterTypeSpellingFacts()).toBe(facts);
    const ctx = buildRuleContext({
      system: null as never, subsystems: [], components: [], interfaces: [], implementations: [], types: [], typeSpellingFacts: facts,
    } as never);
    expect(ctx.typeSpellingFacts).toBe(facts);
  });

  it('recognizes an enum document without fields as a type', () => {
    const root = legacyTree();
    const enumDoc = { kind: 'enum', id: 'channel', name: 'Channel', values: [{ name: 'stable', description: 'Releases only' }, { name: 'beta' }], createdAt: STAMP, updatedAt: STAMP };
    expect(specKind(enumDoc)).toBe('type');
    writeYaml(specsDir(root, 'types', 'channel.yaml'), enumDoc);
    invalidateSpecCache();
    const loaded = loadTypeSpec('channel')!;
    expect(loaded.kind).toBe('enum');
    expect(loaded.values).toEqual([{ name: 'stable', description: 'Releases only' }, { name: 'beta' }]);
    expect(loaded.fields).toEqual([]);
  });
});

describe('the writer stores canonical text (spec_registry.save)', () => {
  it('writes every alias canonical and every non-canonical position exactly as written, texts derived from the canonical types', () => {
    const root = legacyTree();
    saveSpec('interface', loadSpec('interface', 'ibilling')!);
    saveSpec('type', loadSpec('type', 'line')!);
    const intf = readYaml(fileOf(root, 'ibilling.yaml'));
    expect(intf.methods[0].params).toEqual([{ name: 'lines', type: 'list<Line>' }, { name: 'note', type: 'string', optional: true }]);
    expect(intf.methods[0].returns).toBe('async void');
    expect(intf.methods[0].signature).toBe('save(lines: list<Line>, note?: string): async void');
    expect(intf.methods[1].returns).toBe('Line?');
    expect(intf.methods[2].params[0].type).toBe('number');
    expect(intf.methods[2].signature).toBe('count(limit: number): number');
    const type = readYaml(fileOf(root, 'line.yaml'));
    expect(type.fields.map((f: { type: string }) => f.type)).toEqual(['set<string>', 'map<string, any>', 'datetime', '(e: Line) => void']);
  });

  it('is a fixed point: a re-scan after a save records no respelling, and a second save is byte-identical', () => {
    const root = legacyTree();
    saveSpec('interface', loadSpec('interface', 'ibilling')!);
    saveSpec('type', loadSpec('type', 'line')!);
    invalidateSpecCache();
    const facts = typeSpellingFacts();
    expect(facts.respellings).toEqual([]);
    // What only an author can settle is still there, still reported.
    expect(facts.problems).toHaveLength(3);
    expect(signatureFacts().staleTexts).toEqual([]);
    const first = [fs.readFileSync(fileOf(root, 'ibilling.yaml')), fs.readFileSync(fileOf(root, 'line.yaml'))];
    saveSpec('interface', loadSpec('interface', 'ibilling')!, );
    saveSpec('type', loadSpec('type', 'line')!);
    // updatedAt is stamped by every save; everything else must not move.
    const strip = (b: Buffer): string => b.toString('utf8').replace(/updatedAt: .*/g, '');
    expect(strip(fs.readFileSync(fileOf(root, 'ibilling.yaml')))).toBe(strip(first[0]));
    expect(strip(fs.readFileSync(fileOf(root, 'line.yaml')))).toBe(strip(first[1]));
  });

  it('round-trips the id space: every loaded spec re-serializes through the writer schema', () => {
    legacyTree();
    expect(dryRunSerializeSpecs()).toEqual([]);
  });

  it('fuzz: aliases in every position canonicalise to a fixed point the writer keeps', () => {
    const root = legacyTree();
    const aliases = ['string[]', 'Array<Line>', 'ReadonlyArray<Line>', 'Set<Line>', 'Map<string, Line>', 'Record<string, Line[]>',
      'Line | null', 'Line | undefined', 'Option<Line>', 'boolean', 'i32', 'u64', 'double', 'Buffer', 'Date', 'timestamp', 'object', 'unknown',
      'json', 'Json', 'str', 'vec<Line>', 'dict<string, Line>', 'HashMap<string, Set<Line>>', '(Line | null)[]', 'Line[] | null'];
    writeYaml(specsDir(root, 'types', 'fuzz.yaml'), {
      kind: 'value-object', id: 'fuzz', name: 'Fuzz', createdAt: STAMP, updatedAt: STAMP,
      fields: aliases.map((type, i) => ({ name: `f${i}`, type, optional: false })),
      methods: aliases.map((type, i) => ({ name: `m${i}`, params: [{ name: 'x', type }], returns: i % 2 ? `Promise<${type}>` : type })),
    });
    invalidateSpecCache();
    const loaded = loadTypeSpec('fuzz')!;
    saveSpec('type', loadSpec('type', 'fuzz')!);
    invalidateSpecCache();
    const reloaded = loadTypeSpec('fuzz')!;
    expect(reloaded.fields).toEqual(loaded.fields);
    expect(reloaded.methods.map((m) => [m.params, m.returns, m.signature])).toEqual(loaded.methods.map((m) => [m.params, m.returns, m.signature]));
    expect(typeSpellingFacts().respellings.filter((r) => r.specId === 'fuzz')).toEqual([]);
    expect(typeSpellingFacts().problems.filter((p) => p.specId === 'fuzz')).toEqual([]);
    expect(dryRunSerializeSpecs()).toEqual([]);
  });
});

describe('the store\'s delta update reads the merged spec canonical', () => {
  it('stores a delta\'s alias canonical and reports both what the delta wrote and what the stored file held', () => {
    const root = legacyTree();
    const report = updateSpec('interface', 'ibilling', { methods: [{ name: 'find', description: 'Find one line', returns: 'Line[] | null' }] });
    expect(report.written).toBe(true);
    const paths = report.respellings.map((r) => [r.path, r.written, r.stored]);
    // The delta's own alias…
    expect(paths).toContainEqual(['methods.find.returns', 'Line[] | null', 'list<Line>?']);
    // …and the aliases the stored file held at positions the write kept, which the save rewrote with it.
    expect(paths).toContainEqual(['methods.save.params.lines', 'Line[]', 'list<Line>']);
    expect(paths).toContainEqual(['methods.save.returns', 'Promise<void>', 'async void']);
    const stored = readYaml(fileOf(root, 'ibilling.yaml'));
    expect(stored.methods[1].returns).toBe('list<Line>?');
    expect(stored.methods[0].returns).toBe('async void');
  });

  it('changes nothing when a delta writes an alias of what is stored', () => {
    legacyTree();
    const report = updateSpec('interface', 'ibilling', { methods: [{ name: 'save', returns: 'Promise<void>' }] });
    expect(report.written).toBe(false);
    expect(report.changes).toEqual([]);
    expect(report.respellings).toEqual([]);
  });

  it('answers on a dry run the respellings the write would apply, writing nothing', () => {
    const root = legacyTree();
    const before = fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8');
    const report = updateSpec('interface', 'ibilling', { description: 'Billing, renamed' }, undefined, true);
    expect(report.dryRun).toBe(true);
    expect(report.respellings.map((r) => r.path)).toEqual(expect.arrayContaining(['methods.save.params.lines', 'methods.find.returns']));
    expect(fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8')).toBe(before);
  });
});

describe('spec_tree_portal.resolveSignatures reads an excerpt\'s stored forms canonical first', () => {
  it('a sourced method resolved from a stored document carries canonical types', () => {
    const stored = {
      id: 'iengine', name: 'IEngine', description: 'd', component: 'engine', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'run', description: 'd', params: [{ name: 'values', type: 'string[]' }], returns: 'Promise<boolean>' }],
    } as unknown as InterfaceSpec;
    const consumer = {
      id: 'iportal', name: 'IPortal', description: 'd', component: 'portal', status: 'complete', createdAt: STAMP, updatedAt: STAMP,
      methods: [{ name: 'relay', description: 'd', signatureFrom: 'engine.run' }],
    } as unknown as InterfaceSpec;
    const components = ['engine', 'portal'].map((id) => ({ id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: id === 'portal' ? ['engine'] : [] })) as ComponentSpec[];
    const resolved = resolveSignatures([stored, consumer], components, [] as TypeSpec[]);
    const relay = resolved.interfaces[1].methods[0];
    expect(relay.params).toEqual([{ name: 'values', type: 'list<string>' }]);
    expect(relay.returns).toBe('async bool');
    expect(relay.signature).toBe('relay(values: list<string>): async bool');
  });
});
