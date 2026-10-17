import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { declareExternal, listExternals } from '../../src/core/surface-portal.js';
import { externalsRepository } from '../../src/core/externals.js';
import { loadProjectConfig } from '../../src/core/index.js';
import { declaredExternals, readExternalSource } from '../../src/models/project.js';
import { runExternals } from '../../src/commands/externals.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { requiredDataPlaneCapability, toolScope, isExplicitlyClassifiedTool } from '../../src/server/request.js';
import { buildPathExternalPair, type PathExternalPair } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Declaring an external is a command (linkage-and-drift D9): `wairon
// externals add` and sdd_add_external, through the external_declarations
// workflow. Refusals are one sentence naming the accepted form; a declaration
// the producer contradicts is taken back out; it pins by default; and a
// project.yaml source is read leniently in either form, so a malformed one is
// that external's problem, never a configuration that fails to load.
// ---------------------------------------------------------------------------

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  process.exitCode = undefined;
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

/** The pair with billing declaring nothing yet, bound at billing. */
function undeclared(): PathExternalPair {
  const p = buildPathExternalPair();
  cleanups.push(() => p.cleanup());
  p.setBillingConfig(['id: billing', 'name: Billing']);
  setProjectRoot(p.billing);
  invalidateSpecCache();
  return p;
}

/** billing's project.yaml `externals`, as on disk. */
function externalsOnDisk(p: PathExternalPair): Record<string, unknown> | undefined {
  invalidateSpecCache();
  const raw = yaml.load(fs.readFileSync(path.join(p.billing, '.wai', 'project.yaml'), 'utf8')) as Record<string, unknown>;
  return raw.externals as Record<string, unknown> | undefined;
}

/** A refusal reads as one sentence: the alias, why, and nothing after the full stop. */
function oneSentence(refusal: string | undefined, alias: string): void {
  expect(refusal).toMatch(new RegExp(`^The external "${alias}" was not declared: [^\\n]+\\.$`));
  expect(refusal).not.toMatch(/ZodError|"code":|invalid_type/);
}

describe('external_declarations.declare — refusals, one sentence each, nothing written', () => {
  const cases: [string, { alias: string; source?: string; ref?: string; dir?: string; project?: string; use?: string[] }, RegExp][] = [
    ['a malformed alias', { alias: 'Ledger!', source: '../ledger' }, /an alias is \[a-z0-9-_\]\+/],
    ['an absolute path', { alias: 'ledger', source: '/srv/ledger' }, /absolute path/],
    ['an inner `..`', { alias: 'ledger', source: 'libs/../ledger' }, /inner `\.\.`/],
    ['an empty source', { alias: 'ledger', source: '   ' }, /empty/],
    ['a `ref` beside a path source', { alias: 'ledger', source: '../ledger', ref: 'main' }, /`ref` and `dir` apply to a git source only/],
    ['a short commit after `#`', { alias: 'ledger', source: 'https://example.invalid/ledger.git#abc123' }, /not a full commit/],
    ['a `ref` that contradicts the `#<commit>`', { alias: 'ledger', source: `https://example.invalid/ledger.git#${COMMIT}`, ref: 'main' }, /give one of them/],
    ['a malformed producer id', { alias: 'ledger', source: '../ledger', project: 'Ledger Co' }, /project-id grammar/],
    ['a malformed `use` entry', { alias: 'ledger', source: '../ledger', use: ['Ledger Portal'] }, /neither `\*` nor a public name/],
  ];
  for (const [name, request, why] of cases) {
    it(`refuses ${name}`, () => {
      const p = undeclared();
      const answer = declareExternal(request);
      expect(answer.written).toBe(false);
      expect(answer.declaration).toBeNull();
      oneSentence(answer.refusal, request.alias);
      expect(answer.refusal).toMatch(why);
      expect(externalsOnDisk(p)).toBeUndefined();
    });
  }

  it('refuses an alias `members` or `externals` already holds', () => {
    const p = undeclared();
    p.setBillingConfig(['id: billing', 'name: Billing', 'externals:', '  ledger: {}']);
    invalidateSpecCache();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger' });
    oneSentence(answer.refusal, 'ledger');
    expect(answer.refusal).toMatch(/already declared under `externals`/);
  });
});

describe('external_declarations.declare — against the producer', () => {
  it('declares, checks and pins by default: the reproducible gate exists from the first validate', () => {
    const p = undeclared();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger', use: ['ledger-portal'] });
    expect(answer).toMatchObject({ alias: 'ledger', written: true, project: 'ledger', declaration: { source: { path: '../ledger' }, use: ['ledger-portal'] } });
    expect(answer.pin?.outcome).toBe('pinned');
    expect(externalsOnDisk(p)).toEqual({ ledger: { source: { path: '../ledger' }, use: ['ledger-portal'] } });
    expect(externalsRepository.readLock()?.externals.ledger).toBeDefined();
  });

  it('--no-pin declares only', () => {
    undeclared();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger', pin: false });
    expect(answer.written).toBe(true);
    expect(answer.pin).toBeUndefined();
    expect(externalsRepository.readLock()).toBeNull();
  });

  it('a producer answering to another id takes the declaration back out and names that id', () => {
    const p = undeclared();
    const answer = declareExternal({ alias: 'books', source: '../ledger' });
    oneSentence(answer.refusal, 'books');
    expect(answer.refusal).toContain('answers to "ledger", not "books"');
    expect(answer.refusal).toContain('project: ledger');
    expect(externalsOnDisk(p)).toBeUndefined();
  });

  it('a `use` name the producer does not export takes the declaration back out and names the closest exported names', () => {
    const p = undeclared();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger', use: ['ledger-portl'] });
    oneSentence(answer.refusal, 'ledger');
    expect(answer.refusal).toContain('does not export "ledger-portl"');
    expect(answer.refusal).toContain('closest: "ledger-portal"');
    expect(externalsOnDisk(p)).toBeUndefined();
  });

  it('an unreadable producer leaves it declared and unpinned, saying why (declaring works offline)', () => {
    const p = undeclared();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger-elsewhere' });
    expect(answer.written).toBe(true);
    expect(answer.pin).toBeUndefined();
    expect(answer.unreachable).toMatch(/could not be read/);
    expect(externalsOnDisk(p)).toEqual({ ledger: { source: { path: '../ledger-elsewhere' } } });
  });

  it('a dry run answers the declaration and writes nothing', () => {
    const p = undeclared();
    const answer = declareExternal({ alias: 'ledger', source: '../ledger', dryRun: true });
    expect(answer).toMatchObject({ written: false, declaration: { source: { path: '../ledger' } } });
    expect(externalsOnDisk(p)).toBeUndefined();
  });

  it('`<git url>#<commit>` is read as the ref the pin follows, fixed at that commit', () => {
    undeclared();
    const answer = declareExternal({ alias: 'ledger', source: `https://example.invalid/ledger.git#${COMMIT}`, dir: 'services/ledger', dryRun: true });
    expect(answer.declaration).toEqual({ source: { git: 'https://example.invalid/ledger.git', ref: COMMIT, dir: 'services/ledger' } });
  });

  it('`wairon externals add` prints the refusal and exits 1; a declaration exits 0', async () => {
    undeclared();
    const out: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
    await runExternals('add', ['ledger', '/srv/ledger']);
    expect(process.exitCode).toBe(1);
    expect(out.join('\n')).toContain('The external "ledger" was not declared');
    process.exitCode = undefined;
    await runExternals('add', ['ledger', '../ledger'], { use: ['ledger-portal'] });
    expect(process.exitCode).toBeUndefined();
    expect(out.join('\n')).toMatch(/Declared .*ledger/);
  });
});

describe('project.yaml external sources are read leniently', () => {
  it('reads both forms and the shapes the trial hit, never throwing', () => {
    expect(readExternalSource('../ledger')).toEqual({ source: { path: '../ledger' } });
    expect(readExternalSource('hosted:ledger-id')).toEqual({ source: { hosted: 'ledger-id' } });
    expect(readExternalSource(`git@example.com:acme/ledger.git#${COMMIT}`)).toEqual({ source: { git: 'git@example.com:acme/ledger.git', ref: COMMIT } });
    expect(readExternalSource({ git: 'https://example.invalid/ledger.git', ref: 'main' })).toEqual({ source: { git: 'https://example.invalid/ledger.git', ref: 'main' } });
    // `source: { git, commit }` — refused by name, with the forms that work.
    expect(readExternalSource({ git: 'https://example.invalid/ledger.git', commit: COMMIT }).problem).toMatch(/write `ref: <commit>` or `<url>#<commit>`/);
    expect(readExternalSource('https://example.invalid/ledger.git#main').problem).toMatch(/not a full commit/);
    expect(readExternalSource(42).problem).toMatch(/neither of the accepted forms/);
    expect(readExternalSource({ path: 7 }).problem).toMatch(/`source\.path` is not a string/);
  });

  it('a malformed source is that external\'s problem: the configuration loads and `externals list` shows every external', async () => {
    const p = undeclared();
    p.setBillingConfig([
      'id: billing', 'name: Billing', 'externals:',
      '  ledger:', '    source: ../ledger',
      '  vault:', '    source:', `      git: https://example.invalid/vault.git`, `      commit: ${COMMIT}`,
      '  archive:', `    source: https://example.invalid/archive.git#${COMMIT.slice(0, 8)}`,
      '  odd:', '    source: 42',
    ]);
    invalidateSpecCache();
    const config = loadProjectConfig()!;
    expect(config).not.toBeNull();
    const declared = declaredExternals(config);
    expect(declared.map((d) => [d.alias, d.problem === undefined])).toEqual([['ledger', true], ['vault', false], ['archive', false], ['odd', false]]);
    expect(declared.find((d) => d.alias === 'ledger')?.sourcePath).toBe('../ledger');
    const rows = listExternals();
    expect(rows.map((r) => r.alias)).toEqual(['ledger', 'vault', 'archive', 'odd']);
    expect(rows.find((r) => r.alias === 'vault')?.problem).toMatch(/write `ref: <commit>`/);
  });
});

describe('sdd_add_external', () => {
  it('declares through the MCP tool with structured content; a refusal is one sentence, never a schema dump', async () => {
    undeclared();
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'add-external-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const refused: any = await client.callTool({ name: 'sdd_add_external', arguments: { alias: 'ledger', source: 'C:/ledger' } });
      expect(refused.isError).toBe(true);
      oneSentence(refused.content[0].text, 'ledger');
      const dry: any = await client.callTool({ name: 'sdd_add_external', arguments: { alias: 'ledger', source: '../ledger', dryRun: true } });
      expect(dry.isError ?? false).toBe(false);
      expect(dry.structuredContent).toMatchObject({ alias: 'ledger', written: false, declaration: { source: { path: '../ledger' } } });
      const added: any = await client.callTool({ name: 'sdd_add_external', arguments: { alias: 'ledger', source: '../ledger' } });
      expect(added.structuredContent).toMatchObject({ alias: 'ledger', written: true, project: 'ledger' });
      expect(added.structuredContent.pin).toMatchObject({ outcome: 'pinned' });
    } finally {
      await client.close();
    }
  });

  it('is a tree-scoped write on the hosted data plane, needing the project rung', () => {
    expect(requiredDataPlaneCapability('sdd_add_external')).toBe('project:write');
    expect(toolScope('sdd_add_external')).toBe('tree');
    expect(isExplicitlyClassifiedTool('sdd_add_external')).toBe(true);
  });
});

describe('round 2: exit codes, remove and use through the CLI and MCP', () => {
  it('a declaration that pinned nothing exits 2; `remove` and `use` exit 1 on a refusal', async () => {
    undeclared();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await runExternals('add', ['ledger', '../ledger-elsewhere']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await runExternals('add', ['other', '../nowhere'], { pin: false });
    expect(process.exitCode).toBeUndefined();
    await runExternals('remove', ['nope']);
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await runExternals('use', ['nope'], { add: ['x'] });
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    await runExternals('remove', ['ledger']);
    expect(process.exitCode).toBeUndefined();
  });

  it('sdd_update_external and sdd_remove_external answer with structured content and are tree-scoped writes', async () => {
    const p = undeclared();
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'round2-external-test', version: '0.0.1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.callTool({ name: 'sdd_add_external', arguments: { alias: 'ledger', source: '../ledger' } });
      const used: any = await client.callTool({ name: 'sdd_update_external', arguments: { alias: 'ledger', addUse: ['ledger-portal'] } });
      expect(used.structuredContent).toMatchObject({ alias: 'ledger', written: true, use: ['ledger-portal'] });
      const refused: any = await client.callTool({ name: 'sdd_update_external', arguments: { alias: 'ledger', addUse: ['ledger-portl'] } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/closest: "ledger-portal"/);
      const removed: any = await client.callTool({ name: 'sdd_remove_external', arguments: { alias: 'ledger' } });
      expect(removed.structuredContent).toMatchObject({ alias: 'ledger', removed: true, unpinned: true });
      expect(externalsOnDisk(p)).toBeUndefined();
      expect(externalsRepository.readSnapshot('ledger')).toBeNull();
    } finally {
      await client.close();
    }
    for (const tool of ['sdd_update_external', 'sdd_remove_external']) {
      expect(requiredDataPlaneCapability(tool)).toBe('project:write');
      expect(toolScope(tool)).toBe('tree');
    }
  });
});
