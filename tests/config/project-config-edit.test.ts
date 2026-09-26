import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { projectConfigFsAdapterAt, projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { WaironError } from '../../src/utils/errors.js';

// ---------------------------------------------------------------------------
// F82 — a project.yaml write is an EDIT of the file, not a re-serialization:
// comments, key order and quoting survive, a new key lands at its place in the
// schema's field order, and the edit is proved by reading it back. The
// regression runs against a copy of THIS repository's own .wai/project.yaml,
// whose debt register is maintained through its comments.
// ---------------------------------------------------------------------------

const REPO_CONFIG = path.resolve(__dirname, '..', '..', '.wai', 'project.yaml');
const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(text?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pedit-'));
  roots.push(dir);
  if (text !== undefined) {
    fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), text);
  }
  return dir;
}

const fileOf = (root: string): string => path.join(root, '.wai', 'project.yaml');
const textOf = (root: string): string => fs.readFileSync(fileOf(root), 'utf8');
const lines = (...l: string[]): string => `${l.join('\n')}\n`;
const bareLf = (text: string): number => (text.match(/(?<!\r)\n/g) ?? []).length;

/** Whether `inner`'s lines appear in `outer` in order — nothing of `inner` removed or changed. */
function isLineSubsequence(inner: string, outer: string): boolean {
  const a = inner.split('\n');
  const b = outer.split('\n');
  let j = 0;
  for (const line of a) {
    while (j < b.length && b[j] !== line) j += 1;
    if (j === b.length) return false;
    j += 1;
  }
  return true;
}

/**
 * This repository's real project.yaml, as CRLF. The checkout's line endings depend
 * on the platform (a Linux CI checkout is LF), so the file is normalized to the
 * ending the working tree uses here; `keeps a CRLF file CRLF and an LF file LF`
 * covers LF files.
 */
const realConfig = (): string => fs.readFileSync(REPO_CONFIG, 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');

/** The carried-group comments of the debt register: `# N finding(s), M unit(s).` */
const groupComments = (text: string): string[] => text.split('\n').filter((l) => /^\s*# \d+ finding\(s\), \d+ unit\(s\)\.\r?$/.test(l));

describe('F82 — a registry save keeps this repository\'s project.yaml comments byte for byte', () => {
  it('declareExternal on a copy of the real file: only insertions, every carried-group comment intact, CRLF kept', () => {
    const original = realConfig();
    expect(groupComments(original).length).toBeGreaterThan(0);
    const root = tempRoot(original);

    expect(projectConfigRepositoryAt(root).declareExternal('billing', {})).toBe(true);

    const after = textOf(root);
    expect(isLineSubsequence(original, after)).toBe(true);
    expect(groupComments(after)).toEqual(groupComments(original));
    expect(bareLf(original)).toBe(0);
    expect(bareLf(after)).toBe(0);
    expect((yaml.load(after) as { externals?: unknown }).externals).toEqual({ billing: {} });
    // The same declaration again writes nothing.
    expect(projectConfigRepositoryAt(root).declareExternal('billing', {})).toBe(false);
    expect(textOf(root)).toBe(after);
  });

  it('setId on the real file without its id: the id lands between schemaVersion and name, nothing else moves', () => {
    const original = realConfig();
    const withoutId = original.replace(/^id: .*\r\n/m, '');
    expect(withoutId).not.toBe(original);
    const root = tempRoot(withoutId);

    expect(projectConfigRepositoryAt(root).setId('waffle-airon')).toBe(true);

    const after = textOf(root);
    expect(after.split('\r\n').slice(0, 3)).toEqual(['schemaVersion: 1.0.0', 'id: waffle-airon', 'name: Waffle-AIron']);
    expect(isLineSubsequence(withoutId, after)).toBe(true);
    expect(groupComments(after)).toEqual(groupComments(original));
    expect(bareLf(after)).toBe(0);
  });
});

describe('F82 — the fs adapter edits the document in place', () => {
  it('replaces a changed scalar in its own quoting, keeping its comment', () => {
    const root = tempRoot(lines('# head', "name: 'demo' # the display name", 'projectType: backend'));
    projectConfigFsAdapterAt(root).writeDocument({ name: 'other', projectType: 'backend' });
    expect(textOf(root)).toBe(lines('# head', "name: 'other' # the display name", 'projectType: backend'));
  });

  it('deletes a dropped key and leaves the comment above the next key', () => {
    const root = tempRoot(lines('name: demo', 'projectType: backend', '# about rules', 'rules: {}'));
    projectConfigFsAdapterAt(root).writeDocument({ name: 'demo', rules: {} });
    expect(textOf(root)).toBe(lines('name: demo', '# about rules', 'rules: {}'));
  });

  it('inserts a new key after the nearest preceding schema field the mapping holds', () => {
    const root = tempRoot(lines('schemaVersion: 1.0.0', '# the display name', 'name: demo', 'rules: {}'));
    projectConfigFsAdapterAt(root).writeDocument({ schemaVersion: '1.0.0', id: 'demo', name: 'demo', rules: {} });
    expect(textOf(root)).toBe(lines('schemaVersion: 1.0.0', 'id: demo', '# the display name', 'name: demo', 'rules: {}'));
  });

  it('with no preceding neighbour, inserts before the nearest following one, above its comments', () => {
    const root = tempRoot(lines('# the display name', 'name: demo', 'rules: {}'));
    projectConfigFsAdapterAt(root).writeDocument({ id: 'demo', name: 'demo', rules: {} });
    expect(textOf(root)).toBe(lines('id: demo', '# the display name', 'name: demo', 'rules: {}'));
  });

  it('appends a key with no schema neighbour — a record entry, or a key the schema does not know', () => {
    const root = tempRoot(lines('name: demo', 'externals:', '  # the ledger', '  ledger: {}', 'rules: {}'));
    projectConfigFsAdapterAt(root).writeDocument({ name: 'demo', externals: { ledger: {}, billing: {} }, rules: {}, futureKey: 1 });
    expect(textOf(root)).toBe(lines('name: demo', 'externals:', '  # the ledger', '  ledger: {}', '  billing: {}', 'rules: {}', 'futureKey: 1'));
  });

  it('reconciles a sequence by position: equal items kept, changed ones edited, surplus deleted, new appended', () => {
    const root = tempRoot(lines(
      'name: demo',
      'targets:',
      '  # the first',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '  - type: gemini',
      '    outputDir: .gemini/agents # keep me',
      '  - type: cursor',
    ));
    const adapter = projectConfigFsAdapterAt(root);
    adapter.writeDocument({ name: 'demo', targets: [{ type: 'claude', outputDir: '.claude/agents' }, { type: 'gemini', outputDir: 'g' }] });
    expect(textOf(root)).toBe(lines(
      'name: demo',
      'targets:',
      '  # the first',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '  - type: gemini',
      '    outputDir: g # keep me',
    ));
    adapter.writeDocument({ name: 'demo', targets: [{ type: 'claude', outputDir: '.claude/agents' }, { type: 'gemini', outputDir: 'g' }, { type: 'codex' }] });
    expect(textOf(root)).toBe(lines(
      'name: demo',
      'targets:',
      '  # the first',
      '  - type: claude',
      '    outputDir: .claude/agents',
      '  - type: gemini',
      '    outputDir: g # keep me',
      '  - type: codex',
    ));
  });

  it('a key inserted into a nested mapping stays inside its block when the outer mapping gains one at the same place', () => {
    const root = tempRoot(lines('extensions:', '  packs:', '    - name: alpha', 'rules: {}'));
    projectConfigFsAdapterAt(root).writeDocument({ extensions: { packs: [{ name: 'alpha', version: '2.0.0' }], useGlobalPacks: false }, rules: {} });
    expect(textOf(root)).toBe(lines('extensions:', '  packs:', '    - name: alpha', '      version: 2.0.0', '  useGlobalPacks: false', 'rules: {}'));
  });

  it('keeps a CRLF file CRLF and an LF file LF', () => {
    const crlf = tempRoot('# c\r\nname: demo\r\n');
    projectConfigFsAdapterAt(crlf).writeDocument({ name: 'demo', projectType: 'backend' });
    expect(textOf(crlf)).toBe('# c\r\nname: demo\r\nprojectType: backend\r\n');
    const lf = tempRoot('# c\nname: demo\n');
    projectConfigFsAdapterAt(lf).writeDocument({ name: 'demo', projectType: 'backend' });
    expect(textOf(lf)).toBe('# c\nname: demo\nprojectType: backend\n');
  });

  it('writes a fresh document when there is no file yet', () => {
    const root = tempRoot();
    projectConfigFsAdapterAt(root).writeDocument({ name: 'demo' });
    expect(yaml.load(textOf(root))).toEqual({ name: 'demo' });
  });

  it('refuses, writing nothing, when the edited text does not read back as the document', () => {
    // An alias shares its anchor's node: editing the anchor in place would move
    // the alias too, so the edit cannot express this document, and says so.
    const text = lines('# keep', 'name: &n demo', 'projectType: *n');
    const root = tempRoot(text);
    expect(() => projectConfigFsAdapterAt(root).writeDocument({ name: 'other', projectType: 'demo' })).toThrow(WaironError);
    expect(() => projectConfigFsAdapterAt(root).writeDocument({ name: 'other', projectType: 'demo' })).toThrow(/does not read back as the document/);
    expect(textOf(root)).toBe(text);
  });
});

describe('stage 2c — the registry\'s deliberate identity and dependency declarations', () => {
  const base = lines('schemaVersion: 1.0.0', 'name: Demo App', 'targets: []', 'rules: {}', "createdAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'");

  it('setId declares an id once: the same id is a no-op, a different one or a malformed one is refused', () => {
    const root = tempRoot(base);
    const repo = projectConfigRepositoryAt(root);
    expect(() => repo.setId('Not An Id')).toThrow(/project-id grammar/);
    expect(repo.setId('demo-app')).toBe(true);
    const written = textOf(root);
    expect(repo.setId('demo-app')).toBe(false);
    expect(textOf(root)).toBe(written);
    expect(() => repo.setId('other')).toThrow(/already declares "demo-app"/);
    expect(textOf(root)).toBe(written);
    expect(repo.load()?.id).toBe('demo-app');
  });

  it('declareExternal adds an alias and never overwrites one', () => {
    const root = tempRoot(base);
    const repo = projectConfigRepositoryAt(root);
    expect(() => repo.declareExternal('acme.ledger', {})).toThrow(/\[a-z0-9-_\]\+/);
    expect(() => repo.declareExternal('ledger', { project: 'Bad Id' })).toThrow(/project-id grammar/);
    expect(repo.declareExternal('billing', {})).toBe(true);
    expect(repo.declareExternal('billing', {})).toBe(false);
    expect(() => repo.declareExternal('billing', { project: 'billing-v2' })).toThrow(/never overwritten/);
    expect(repo.declareExternal('crm', { project: 'crm' })).toBe(true);
    expect(repo.load()?.externals).toEqual({ billing: {}, crm: { project: 'crm' } });
  });

  it('refuses a project with no configuration', () => {
    const root = tempRoot();
    expect(() => projectConfigRepositoryAt(root).setId('demo')).toThrow();
    expect(fs.existsSync(fileOf(root))).toBe(false);
  });
});
