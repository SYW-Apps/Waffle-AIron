import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSpec, saveSystemSpec, signatureFacts } from '../../src/core/specs.js';
import { repairTypeSpellings } from '../../src/core/type-spelling-repair.js';
import { repairTypeSpellings as portalRepair } from '../../src/core/index.js';
import { repairTypeSpellings as adapterRepair } from '../../src/commands/adapters/core.js';
import { typeProblemEnumProposal, typeProblemIntProposal } from '../../src/models/index.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/specs.js';

// ---------------------------------------------------------------------------
// Stage 2 type grammar, wave 5: the doctor's type-spelling repair
// (core_orchestrator.repairTypeSpellings). It re-saves every own spec holding
// an alias, so the writer stores it canonical; it PROPOSES int for a `number`
// whose name says a whole number and never writes it; it lists what only an
// author can settle; and it never re-saves an interface holding a differing
// restatement. Idempotent.
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

const LEGACY_INTERFACE = {
  id: 'ibilling', name: 'IBilling', description: 'Billing contract', component: 'billing', status: 'draft', createdAt: STAMP, updatedAt: STAMP,
  methods: [
    {
      name: 'save', description: 'Save the lines',
      signature: 'save(lines: Line[]): Promise<void>',
      params: [{ name: 'lines', type: 'Line[]' }], returns: 'Promise<void>',
    },
    {
      name: 'count', description: 'Count them',
      signature: 'count(maxDepth: number, ratio: number): number',
      params: [{ name: 'maxDepth', type: 'number' }, { name: 'ratio', type: 'number' }], returns: 'number',
    },
  ],
};

const LEGACY_TYPE = {
  kind: 'value-object', id: 'line', name: 'Line', description: 'One line', createdAt: STAMP, updatedAt: STAMP,
  fields: [
    { name: 'tags', type: 'Set<string>', optional: false },
    { name: 'pageSize', type: 'number | null', optional: false },
    { name: 'onChange', type: '(e: Line) => void', optional: false },
    { name: 'scope', type: "'global' | 'local' | null", optional: false },
  ],
};

/** A Rust-flavoured contract: Result<T, E> and () respell mechanically. */
const RUST_INTERFACE = {
  id: 'iledger', name: 'ILedger', description: 'Ledger contract', component: 'billing', status: 'draft', createdAt: STAMP, updatedAt: STAMP,
  methods: [
    { name: 'post', description: 'Post an entry', signature: 'post(): Result<(), LedgerError>', params: [], returns: 'Result<(), LedgerError>' },
    { name: 'read', description: 'Read an entry', signature: 'read(): Promise<Result<Line, LedgerError>>', params: [], returns: 'Promise<Result<Line, LedgerError>>' },
  ],
};

/** A canonical type: nothing to repair. */
const CLEAN_TYPE = {
  kind: 'value-object', id: 'clean', name: 'Clean', description: 'Already canonical', createdAt: STAMP, updatedAt: STAMP,
  fields: [{ name: 'names', type: 'list<string>', optional: false }],
};

function legacyTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-respell-'));
  roots.push(root);
  fs.mkdirSync(specsDir(root), { recursive: true });
  setProjectRoot(root);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'Bill', vision: 'v', boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP });
  saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'Bill', publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as SubsystemSpec);
  saveSpec('component', { id: 'billing', name: 'billing', description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], status: 'draft', createdAt: STAMP, updatedAt: STAMP } as ComponentSpec);
  writeYaml(specsDir(root, 'interfaces', 'ibilling.yaml'), LEGACY_INTERFACE);
  writeYaml(specsDir(root, 'types', 'line.yaml'), LEGACY_TYPE);
  writeYaml(specsDir(root, 'types', 'clean.yaml'), CLEAN_TYPE);
  invalidateSpecCache();
  return root;
}

function fileOf(root: string, suffix: string): string {
  const files = fs.readdirSync(specsDir(root), { recursive: true }) as string[];
  const hit = files.find((f) => f.replace(/\\/g, '/').endsWith(suffix));
  if (!hit) throw new Error(`no file ending ${suffix}`);
  return specsDir(root, hit);
}

describe('repairTypeSpellings — the plan', () => {
  it('plans one repair per own spec: the aliases rewritten, int proposed by name, the rest for an author', () => {
    legacyTree();
    const repairs = repairTypeSpellings(false);
    const byId = new Map(repairs.map((r) => [r.specId, r]));
    expect([...byId.keys()].sort()).toEqual(['ibilling', 'line']);

    const intf = byId.get('ibilling')!;
    expect(intf.kind).toBe('interface');
    expect(intf.rewritten.map((r) => [r.path, r.written, r.stored])).toEqual([
      ['methods.save.params.lines', 'Line[]', 'list<Line>'],
      ['methods.save.returns', 'Promise<void>', 'async void'],
    ]);
    // maxDepth and count say a whole number; ratio does not.
    expect(intf.proposals.map((p) => [p.path, p.written, p.stored])).toEqual([
      ['methods.count.params.maxDepth', 'number', 'int'],
      ['methods.count.returns', 'number', 'int'],
    ]);
    expect(intf.authorNeeded.map((p) => [p.code, p.path])).toEqual([['TYPE_NOT_NEUTRAL', 'methods.count.params.ratio']]);

    const type = byId.get('line')!;
    expect(type.rewritten.map((r) => [r.path, r.stored])).toEqual([['fields.tags', 'set<string>']]);
    // The proposal keeps the rest of the written text, canonical.
    expect(type.proposals.map((p) => [p.path, p.written, p.stored])).toEqual([['fields.pageSize', 'number | null', 'int?']]);
    expect(type.authorNeeded.map((p) => [p.code, p.path, p.replacement])).toEqual([
      ['TYPE_FORM_UNSUPPORTED', 'fields.onChange', expect.stringMatching(/signature type/)],
    ]);
    // The string-literal union is an enum PROPOSED, not left for an author.
    expect(type.enumProposals.map((p) => [p.path, p.enumId, p.values, p.optional])).toEqual([['fields.scope', 'scope', ['global', 'local'], true]]);
  });

  it('respells Result<T, E> and () mechanically, as result<T, E> and void', () => {
    const root = legacyTree();
    writeYaml(specsDir(root, 'interfaces', 'iledger.yaml'), RUST_INTERFACE);
    invalidateSpecCache();
    const ledger = repairTypeSpellings(false).find((r) => r.specId === 'iledger')!;
    expect(ledger.rewritten.map((r) => [r.path, r.stored])).toEqual([
      ['methods.post.returns', 'result<void, LedgerError>'],
      ['methods.read.returns', 'async result<Line, LedgerError>'],
    ]);
    expect(ledger.authorNeeded).toEqual([]);
    repairTypeSpellings(true);
    const stored = readYaml(fileOf(root, 'iledger.yaml'));
    expect(stored.methods.map((m: { returns: string }) => m.returns)).toEqual(['result<void, LedgerError>', 'async result<Line, LedgerError>']);
    expect(repairTypeSpellings(false).find((r) => r.specId === 'iledger')).toBeUndefined();
  });

  it('writes nothing without apply', () => {
    const root = legacyTree();
    const before = fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8');
    repairTypeSpellings(false);
    expect(fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8')).toBe(before);
  });

  it('is reached 1:1 through the maintenance portal and the CLI core adapter', () => {
    legacyTree();
    const direct = repairTypeSpellings(false);
    expect(portalRepair(false)).toEqual(direct);
    expect(adapterRepair(false)).toEqual(direct);
  });
});

describe('repairTypeSpellings — apply', () => {
  it('stores every alias canonical, leaves number and unsupported forms as written, and derives the text from the canonical types', () => {
    const root = legacyTree();
    repairTypeSpellings(true);
    const intf = readYaml(fileOf(root, 'ibilling.yaml'));
    const save = intf.methods.find((m: any) => m.name === 'save');
    expect(save.params[0].type).toBe('list<Line>');
    expect(save.returns).toBe('async void');
    expect(save.signature).toBe('save(lines: list<Line>): async void');
    const count = intf.methods.find((m: any) => m.name === 'count');
    // A proposal is never applied.
    expect(count.params.map((p: any) => p.type)).toEqual(['number', 'number']);
    expect(count.returns).toBe('number');
    const type = readYaml(fileOf(root, 'line.yaml'));
    expect(type.fields.map((f: any) => f.type)).toEqual(['set<string>', 'number | null', '(e: Line) => void', "'global' | 'local' | null"]);
  });

  it('is idempotent: a second run rewrites nothing and plans the same proposals and author positions', () => {
    const root = legacyTree();
    const first = repairTypeSpellings(true);
    const written = fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8');
    const second = repairTypeSpellings(true);
    expect(second.every((r) => r.rewritten.length === 0)).toBe(true);
    expect(second.map((r) => [r.specId, r.proposals, r.enumProposals, r.authorNeeded])).toEqual(first.map((r) => [r.specId, r.proposals, r.enumProposals, r.authorNeeded]));
    expect(fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8')).toBe(written);
    expect(fs.readFileSync(fileOf(root, 'clean.yaml'), 'utf8')).toBe(yaml.dump(CLEAN_TYPE, { lineWidth: -1 }));
  });

  it('never re-saves an interface holding a sourced method whose restatement differs from its source', () => {
    const root = legacyTree();
    writeYaml(specsDir(root, 'types', 'listener.yaml'), {
      kind: 'signature', id: 'listener', name: 'Listener', description: 'A callback', createdAt: STAMP, updatedAt: STAMP,
      params: [{ name: 'line', type: 'Line' }], returns: 'void',
    });
    writeYaml(specsDir(root, 'interfaces', 'ibilling.yaml'), {
      ...LEGACY_INTERFACE,
      methods: [
        ...LEGACY_INTERFACE.methods,
        { name: 'on', description: 'Restates a different contract', signatureFrom: 'listener', params: [{ name: 'flag', type: 'boolean' }], returns: 'void' },
      ],
    });
    invalidateSpecCache();
    expect(signatureFacts().sources.some((f) => f.outcome === 'restated' && f.differs)).toBe(true);
    const before = fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8');
    const repairs = repairTypeSpellings(true);
    expect(repairs.find((r) => r.specId === 'ibilling')?.rewritten ?? []).toEqual([]);
    expect(fs.readFileSync(fileOf(root, 'ibilling.yaml'), 'utf8')).toBe(before);
  });
});

describe('type_expression_problem.enumProposal', () => {
  const problem = (written: string, path = 'methods.save.params.scopeKind') => ({
    code: 'TYPE_FORM_UNSUPPORTED' as const, written, detail: 'literal union', specId: 's', kind: 'interface' as const, path,
  });

  it('proposes an enum named for the position, its values in written order, each once', () => {
    expect(typeProblemEnumProposal(problem("'global' | 'local' | 'global'"))).toMatchObject({ enumId: 'scope-kind', values: ['global', 'local'], optional: false });
    expect(typeProblemEnumProposal(problem('"a" | "b" | undefined', 'methods.get.returns'))).toMatchObject({ enumId: 'get', values: ['a', 'b'], optional: true });
  });

  it('proposes nothing for a union mixing in anything but string literals, or another problem', () => {
    expect(typeProblemEnumProposal(problem("'a' | 1"))).toBeNull();
    expect(typeProblemEnumProposal(problem("'a' | Invoice"))).toBeNull();
    expect(typeProblemEnumProposal(problem('(e: Line) => void'))).toBeNull();
    expect(typeProblemEnumProposal({ ...problem("'a' | 'b'"), code: 'TYPE_NOT_NEUTRAL' })).toBeNull();
    expect(typeProblemEnumProposal({ ...problem("'a' | 'b'"), path: undefined })).toBeNull();
  });
});

describe('type_expression_problem.intProposal', () => {
  const problem = (path: string, written = 'number') => ({
    code: 'TYPE_NOT_NEUTRAL' as const, written, detail: 'number', replacement: 'int or float', specId: 's', kind: 'type' as const, path,
  });

  it('proposes int where the position name says a whole number, read over camelCase, snake_case and kebab-case', () => {
    expect(typeProblemIntProposal(problem('fields.retryCount'))?.stored).toBe('int');
    expect(typeProblemIntProposal(problem('fields.ttl_days'))?.stored).toBe('int');
    expect(typeProblemIntProposal(problem('methods.port.returns'))?.stored).toBe('int');
    expect(typeProblemIntProposal(problem('methods.save.params.stepNumber', 'number[]'))?.stored).toBe('list<int>');
  });

  it('proposes nothing for a fractional or unspoken name, another problem, or a text still not canonical', () => {
    expect(typeProblemIntProposal(problem('fields.ratio'))).toBeNull();
    expect(typeProblemIntProposal(problem('fields.x'))).toBeNull();
    expect(typeProblemIntProposal({ ...problem('fields.count'), replacement: 'string' })).toBeNull();
    expect(typeProblemIntProposal({ ...problem('fields.count'), code: 'TYPE_FORM_UNSUPPORTED' })).toBeNull();
    expect(typeProblemIntProposal(problem('fields.count', 'number | string'))).toBeNull();
    expect(typeProblemIntProposal({ ...problem('fields.count'), path: undefined })).toBeNull();
  });
});
