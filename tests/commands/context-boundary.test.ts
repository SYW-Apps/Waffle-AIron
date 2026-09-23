import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import * as adapter from '../../src/commands/subsystem.js';
import * as portal from '../../src/core/index.js';
import * as store from '../../src/core/context.js';
import { versionStamp } from '../../src/core/stamp.js';

// ---------------------------------------------------------------------------
// The documents under `.wai/context/`, and who is allowed to write them.
//
// Two kinds live there and must not be confused. `project.md` and
// `architecture.md` are written by a PERSON; `domains.md` and
// `wairon-guide.md` are DERIVED. The store had a write path for all four —
// `writeProjectContext` and `writeArchitectureContext` were exported, callable
// and called by nothing — which is a loaded gun pointed at the one
// unrecoverable thing this directory could do. They are gone, and there is no
// replacement: the derived pair is written, the human pair is only ever read.
//
// The other half of this file is the import SITE. `wairon init`, `wairon
// generate` and `wairon doctor` imported ../core/context.js directly — sdd_cli
// reaching into an sdd_core module while core_portal publishes exactly the
// three calls they wanted. Ninth instance of that reach; the earlier ones are
// listed in tests/commands/domains-boundary.test.ts,
// tests/commands/execution-boundary.test.ts and
// tests/commands/ai-guide-boundary.test.ts. Nothing was broken by it, which is
// why it survived: both spellings compile, so only the import site says which
// side of a boundary a file is on. `wairon doctor`'s was worse than an import —
// it reached into `CONTEXT_PATHS` for two entries by name, which is the
// module's internal layout of `.wai/context/` leaking into a command.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const scratch: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  setProjectRoot(null);
  invalidateSpecCache();
  for (const dir of scratch.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

/** A throwaway project root with a configuration the schema accepts. */
function tempProject(name = 'Context Project'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-context-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  writeConfig(dir, [
    'schemaVersion: 1.0.0',
    `name: ${name}`,
    'targets: []',
    'rules: {}',
    "createdAt: '2026-09-23T10:00:00.000Z'",
    "updatedAt: '2026-09-23T10:00:00.000Z'",
  ]);
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

function writeConfig(dir: string, lines: string[]): void {
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), lines.join('\n') + '\n', 'utf8');
}

const contextDirIn = (dir: string): string => path.join(dir, '.wai', 'context');
const docIn = (dir: string, file: string): string => path.join(contextDirIn(dir), file);

function writeNotes(dir: string, content: string): void {
  fs.mkdirSync(contextDirIn(dir), { recursive: true });
  fs.writeFileSync(docIn(dir, 'project.md'), content, 'utf8');
}

function listContextDir(dir: string): string[] {
  try {
    return fs.readdirSync(contextDirIn(dir)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The behaviour.
// ---------------------------------------------------------------------------

describe('a refresh writes each derived document only when it changed', () => {
  it('writes both the first time and moves neither the second', () => {
    const dir = tempProject();

    expect(adapter.syncContextFiles()).toEqual({ domainsUpdated: true, guideUpdated: true });
    expect(listContextDir(dir)).toEqual(['domains.md', 'wairon-guide.md']);

    // The whole point of writing on difference: a regenerate with no design
    // change behind it leaves no diff. Both false is the normal, good answer.
    expect(adapter.syncContextFiles()).toEqual({ domainsUpdated: false, guideUpdated: false });
  });

  it('leaves the bytes untouched on the second refresh, not merely the answer', () => {
    const dir = tempProject();
    adapter.syncContextFiles();
    const before = listContextDir(dir).map((f) => fs.readFileSync(docIn(dir, f), 'utf8'));

    adapter.syncContextFiles();

    expect(listContextDir(dir).map((f) => fs.readFileSync(docIn(dir, f), 'utf8'))).toEqual(before);
  });

  it('moves the guide alone when a person writes the project document', () => {
    const dir = tempProject();
    adapter.syncContextFiles();

    // The guide folds the human notes in; the domain document never mentions
    // them, so exactly one of the two has anything to say about this change.
    writeNotes(dir, '# Notes\n\nWhat a person wrote about this project.\n');

    expect(adapter.syncContextFiles()).toEqual({ domainsUpdated: false, guideUpdated: true });
    expect(fs.readFileSync(docIn(dir, 'wairon-guide.md'), 'utf8'))
      .toContain('What a person wrote about this project.');
  });

  it('moves the domain document alone when only a column it alone carries changes', () => {
    const dir = tempProject();
    adapter.addDomain({ id: 'docs', name: 'Docs', ownedPaths: ['docs/**'] });
    invalidateSpecCache();
    adapter.syncContextFiles();

    // The domain document tabulates owned paths; the guide's domain map lists
    // id, source and name only. Changing the paths is therefore visible to one
    // renderer and invisible to the other.
    adapter.removeDomain('docs');
    adapter.addDomain({ id: 'docs', name: 'Docs', ownedPaths: ['docs/**', 'examples/**'] });
    invalidateSpecCache();

    expect(adapter.syncContextFiles()).toEqual({ domainsUpdated: true, guideUpdated: false });
    expect(fs.readFileSync(docIn(dir, 'domains.md'), 'utf8')).toContain('examples/**');
    expect(fs.readFileSync(docIn(dir, 'wairon-guide.md'), 'utf8')).not.toContain('examples/**');
  });

  it('answers the same through the adapter, the portal and the composer', () => {
    tempProject();
    expect(adapter.syncContextFiles()).toEqual({ domainsUpdated: true, guideUpdated: true });
    expect(portal.syncContextFiles()).toEqual({ domainsUpdated: false, guideUpdated: false });
    expect(store.syncContextFiles()).toEqual({ domainsUpdated: false, guideUpdated: false });
  });
});

describe('derivedDocPaths names the generated pair and nothing a person wrote', () => {
  it('answers the two generated documents, in the order doctor reports them', () => {
    const dir = tempProject();

    expect(adapter.derivedDocPaths()).toEqual([
      docIn(dir, 'wairon-guide.md'),
      docIn(dir, 'domains.md'),
    ]);
  });

  it('names neither human-authored document', () => {
    const dir = tempProject();
    // Handing `wairon doctor` the human pair would report both stale forever:
    // nothing stamps them, because nothing writes them.
    writeNotes(dir, '# Notes\n');
    fs.writeFileSync(docIn(dir, 'architecture.md'), '# Design\n', 'utf8');

    const named = adapter.derivedDocPaths().map((p) => path.basename(p));
    expect(named).not.toContain('project.md');
    expect(named).not.toContain('architecture.md');
    expect(named).toHaveLength(2);
  });

  it('names exactly the files a refresh writes — the set doctor reports on is the set that exists', () => {
    const dir = tempProject();
    expect(listContextDir(dir)).toEqual([]);

    adapter.syncContextFiles();

    expect(listContextDir(dir)).toEqual(adapter.derivedDocPaths().map((p) => path.basename(p)).sort());
    for (const p of adapter.derivedDocPaths()) {
      expect(fs.existsSync(p), p).toBe(true);
      // Every path handed to the staleness check carries a stamp to compare.
      expect(adapter.readStampVersion(fs.readFileSync(p, 'utf8'))).not.toBeNull();
    }
  });

  it('answers the same path list through the adapter and the portal', () => {
    tempProject();
    expect(adapter.derivedDocPaths()).toEqual(portal.derivedDocPaths());
  });
});

describe('whether the project has been described is a question, never a fault', () => {
  it('answers false for a project nobody has written notes for, and true once they have', () => {
    const dir = tempProject();

    expect(adapter.hasContext()).toBe(false);
    expect(portal.hasContext()).toBe(false);

    writeNotes(dir, '# Notes\n');

    expect(adapter.hasContext()).toBe(true);
    expect(portal.hasContext()).toBe(true);
  });

  it('does not confuse the architecture document with the project one', () => {
    const dir = tempProject();
    fs.mkdirSync(contextDirIn(dir), { recursive: true });
    fs.writeFileSync(docIn(dir, 'architecture.md'), '# Design\n', 'utf8');

    expect(adapter.hasContext()).toBe(false);
  });
});

describe('rendering a derived document is a pure function of the tree', () => {
  it('renders the same bytes on a later day, which is what generate\'s idempotence rests on', () => {
    const dir = tempProject();
    writeNotes(dir, '# Notes\n\nStable words.\n');
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const domainsFirst = store.renderDomainsDoc();
    const guideFirst = store.renderWaironGuide();

    // A year later, same tree. A renderer that read the clock would answer
    // differently here, and `wairon generate` would commit churn carrying
    // nothing git does not already know from the commit.
    vi.setSystemTime(new Date('2027-06-15T23:59:59.000Z'));

    expect(store.renderDomainsDoc()).toBe(domainsFirst);
    expect(store.renderWaironGuide()).toBe(guideFirst);
  });

  it('carries the build stamp and no date anywhere in the domain document', () => {
    tempProject();
    const domains = store.renderDomainsDoc();

    expect(domains).toContain(versionStamp());
    expect(domains).not.toMatch(/Last updated/);
    expect(domains).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('a configuration that fails its own schema costs the reader a name, not the guide', () => {
  it('falls back to a neutral project name and still renders the whole guide', () => {
    const dir = tempProject();
    writeNotes(dir, '# Notes\n\nWhat a person wrote about this project.\n');
    // Valid YAML, invalid configuration: `targets` is a list and `name` a string.
    writeConfig(dir, ['schemaVersion: 1.0.0', 'name: 42', 'targets: not-a-list']);

    // The premise, proven rather than assumed: this configuration really is
    // rejected, so the fallback below is the path actually being taken.
    expect(() => portal.loadProjectConfig()).toThrow();

    const guide = store.renderWaironGuide();

    expect(guide).toContain('# Project Context — this project');
    expect(guide).toContain('What a person wrote about this project.');
    expect(guide).toContain('# Domain Map');
    expect(guide).toContain(versionStamp());
  });

  it('names the project when the configuration is valid, so the fallback is not the only path', () => {
    const dir = tempProject('Named Project');
    writeNotes(dir, '# Notes\n\nWhat a person wrote about this project.\n');

    expect(store.renderWaironGuide()).toContain('# Project Context — Named Project');
  });
});

// ---------------------------------------------------------------------------
// The import site, which no type-check can assert.
// ---------------------------------------------------------------------------

// Newlines normalised so a multi-line literal means the same thing here (CRLF
// working tree) and on a CI runner (LF checkout) — see CONTRIBUTING.md.
const CR = String.fromCharCode(13);
const source = (file: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').split(CR).join('');

const COMMANDS = ['src/commands/doctor.ts', 'src/commands/generate.ts', 'src/commands/init.ts'];

describe('the three commands reach the context documents through cli_core_adapter', () => {
  // Literal lines, not patterns: an escaped regex has quietly matched nothing
  // in these scans before.
  for (const file of COMMANDS) {
    it(`${file} names the sdd_core module in neither spelling`, () => {
      const text = source(file);
      expect(text, file).not.toContain("from '../core/context.js'");
      expect(text, file).not.toContain("require('../core/context.js')");
      expect(text, file).toContain("} from './subsystem.js';");
    });
  }

  it('generate takes both of its context calls off the adapter', () => {
    const block = importBlock('src/commands/generate.ts', './subsystem.js');
    expect(block).toContain('  hasContext,');
    expect(block).toContain('  syncContextFiles,');
  });

  it('init takes the seeding refresh off the adapter', () => {
    expect(importBlock('src/commands/init.ts', './subsystem.js')).toContain('  syncContextFiles,');
  });

  it('doctor takes the refresh and the path list off the adapter, and spells out no paths of its own', () => {
    const block = importBlock('src/commands/doctor.ts', './subsystem.js');
    expect(block).toContain('  syncContextFiles,');
    expect(block).toContain('  derivedDocPaths,');

    const text = source('src/commands/doctor.ts');
    // The layout of `.wai/context/` is the store's to state once. doctor asked
    // for two of its entries by name, which is the same reach in a subtler
    // spelling — and would have reported on the wrong pair the day the layout
    // moved.
    // The dot is the assertion: a USE of the path table, not the mention of it
    // in the comment that says why it is gone.
    expect(text).not.toContain('CONTEXT_PATHS.');
    expect(text).toContain('for (const p of derivedDocPaths()) {');
  });
});

describe('the Portal publishes three context operations, not a module', () => {
  it('no longer star-exports the context module', () => {
    const text = source('src/core/index.ts');
    expect(text).not.toContain("export * from './context.js';");
    expect(text).toContain("export { syncContextFiles, hasContext, derivedDocPaths } from './context.js';");
  });

  it('republishes each one by identity, so the Portal method and the function are one function', () => {
    for (const name of ['syncContextFiles', 'hasContext', 'derivedDocPaths'] as const) {
      // Present FIRST: two undefineds are identical too, and an identity check
      // that cannot tell them from two functions proves nothing.
      expect(typeof portal[name], name).toBe('function');
      expect(portal[name], name).toBe(store[name]);
    }
  });

  it('offers nothing else the module happened to export', () => {
    // The star export republished a whole module from a Portal whose contract
    // names three operations: the renderers, the path table, the directory
    // helper and both human-file readers came with it, and every consumer could
    // keep depending on the member rather than the facade.
    for (const name of [
      'CONTEXT_PATHS',
      'contextDir',
      'renderDomainsDoc',
      'renderWaironGuide',
      'readProjectContext',
      'readArchitectureContext',
    ]) {
      expect(name in portal, name).toBe(false);
      expect(name in adapter, name).toBe(false);
    }
  });

  it('cli_core_adapter forwards each one 1:1, in the shape the contract names', () => {
    const text = source('src/commands/subsystem.ts');
    expect(text).toContain('export function syncContextFiles(): SyncResult {');
    expect(text).toContain('  return coreSyncContextFiles();');
    expect(text).toContain('export function hasContext(): boolean {');
    expect(text).toContain('  return coreHasContext();');
    expect(text).toContain('export function derivedDocPaths(): string[] {');
    expect(text).toContain('  return coreDerivedDocPaths();');
  });
});

describe('nothing in wairon can overwrite what a person wrote about their own system', () => {
  it('the store exports no write for either human-authored document', () => {
    const text = source('src/core/context.ts');
    expect(text).not.toContain('export function writeProjectContext');
    expect(text).not.toContain('export function writeArchitectureContext');
    // Nor the presence check nobody ever asked: a published read with no reader
    // is a claim somebody later trusts.
    expect(text).not.toContain('export function hasArchitectureContext');
  });

  it('and neither does the Portal or the adapter', () => {
    for (const name of ['writeProjectContext', 'writeArchitectureContext', 'hasArchitectureContext']) {
      expect(name in store, name).toBe(false);
      expect(name in portal, name).toBe(false);
      expect(name in adapter, name).toBe(false);
    }
  });

  it('refreshing twice over a human-authored document leaves it byte-for-byte', () => {
    const dir = tempProject();
    const notes = '# Notes\n\nMine, and nothing regenerates it.\n';
    writeNotes(dir, notes);
    fs.writeFileSync(docIn(dir, 'architecture.md'), '# Design\n\nAlso mine.\n', 'utf8');

    adapter.syncContextFiles();
    adapter.syncContextFiles();

    expect(fs.readFileSync(docIn(dir, 'project.md'), 'utf8')).toBe(notes);
    expect(fs.readFileSync(docIn(dir, 'architecture.md'), 'utf8')).toBe('# Design\n\nAlso mine.\n');
  });

  it('the refresh writes through the store rather than the file primitive', () => {
    const text = source('src/core/context.ts');
    // Where each derived document lives, and the write-only-if-changed rule,
    // are the store's to state once. A renderer reaching writeFileIfChanged
    // directly is a second place they can drift apart.
    expect(text).toContain('  const domainsUpdated  = writeDomainsDoc(domainsContent);');
    expect(text).toContain('  const guideUpdated    = writeGuideDoc(guideContent);');
    // Twice in the whole module: once inside each of the store's two writes,
    // and nowhere else. A third call site would be the drift this guards.
    expect(text.split('writeFileIfChanged(').length - 1).toBe(2);
  });
});

/**
 * The text of one named import block, found by literal string search rather
 * than a pattern: an escaped regex has quietly matched nothing in these scans
 * before. Asking WHICH block a name sits in is the whole assertion — every one
 * of these names was already named by these files, off the wrong module.
 */
function importBlock(file: string, module: string): string {
  const text = source(file);
  const tail = "} from '" + module + "';";
  const end = text.indexOf(tail);
  expect(end, `${file} names nothing from ${module}`).toBeGreaterThan(-1);
  const start = text.lastIndexOf('import {', end);
  expect(start, `${file}'s ${module} block does not open with an import`).toBeGreaterThan(-1);
  const block = text.slice(start, end + tail.length);
  // One block, not a run of them: a stray opener earlier in the file would
  // otherwise hand back half the file's imports and pass on any of them.
  const names = block.slice('import {'.length, block.length - tail.length);
  expect(names, `${file}: the ${module} block is not one contiguous list`).not.toContain("from '");
  return block;
}
