import { describe, it, expect, afterEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as adapter from '../../src/commands/adapters/core.js';
import * as portal from '../../src/core/index.js';
import { GUIDE_MARKER_START, GUIDE_MARKER_END, stripGuideSection } from '../../src/utils/ai-guide.js';
import { versionStamp } from '../../src/core/stamp.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';

// ---------------------------------------------------------------------------
// READ THIS BEFORE ADDING A TEST HERE.
//
// `injectGuide(filePath, 'global')` writes a real AI tool's machine-wide
// configuration file — on a maintainer's machine that is the CLAUDE.md Claude
// Code loads into every session. `globalGuideFilePath` resolves it from
// CLAUDE_CONFIG_DIR / GEMINI_CONFIG_DIR, falling back to os.homedir(), so an
// unfenced test here rewrites the maintainer's own agent instructions.
//
// So `inTempHome()` points HOME, USERPROFILE (which is what os.homedir() reads
// on Windows) and BOTH config-dir overrides at a throwaway directory, and then
// PROVES the redirect took — by asking the code under test where it would
// write — before anything is allowed to write. `afterAll` re-reads the real
// files and fails if a single byte moved.
//
// What this file is otherwise for: `wairon init`, `wairon generate` and
// `wairon doctor` imported ../utils/ai-guide.js and ../core/stamp.js directly —
// sdd_cli reaching into two sdd_core modules while core_portal publishes all
// six calls. Eighth instance of that reach; the first six are listed in
// tests/commands/domains-boundary.test.ts and the seventh in
// tests/commands/execution-boundary.test.ts. Nothing was broken by it, which is
// why it survived: both spellings compile, so only the import SITE says which
// side of a boundary a file is on. `wairon generate`'s spelling was worse than
// an import — a lazy `require` that would not have resolved once the CLI is
// bundled.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Every machine-wide guide this suite could conceivably reach, captured before
 *  any redirect: the two the environment currently names, and the two the
 *  homedir fallback would name if it did not. */
function realGlobalGuides(): string[] {
  const paths = [
    portal.globalGuideFilePath('claude'),
    portal.globalGuideFilePath('gemini'),
    path.join(os.homedir(), '.claude', 'CLAUDE.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
  ].filter((p): p is string => p !== null);
  return [...new Set(paths.map((p) => path.resolve(p)))].sort();
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const REAL_GUIDES = realGlobalGuides();
const REAL_GUIDES_BEFORE = REAL_GUIDES.map(readOrNull);

const savedEnv: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  GEMINI_CONFIG_DIR: process.env.GEMINI_CONFIG_DIR,
};
const scratch: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratch.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  }
});

afterAll(() => {
  // The fence, proven rather than assumed: every machine-wide guide this suite
  // could have reached is byte-for-byte what it was before the file ran.
  expect(REAL_GUIDES.map(readOrNull)).toEqual(REAL_GUIDES_BEFORE);
  expect(realGlobalGuides()).toEqual(REAL_GUIDES);
});

function tempDir(tag: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wairon-guide-${tag}-`));
  scratch.push(dir);
  return dir;
}

/**
 * Redirect this machine's home AND both config-dir overrides at a throwaway
 * directory. Throws — before any write is possible — if the redirect did not
 * take, because the alternative is silently rewriting a real agent's
 * instructions.
 */
function inTempHome(): string {
  const home = tempDir('home');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  process.env.GEMINI_CONFIG_DIR = path.join(home, '.gemini');

  if (path.resolve(os.homedir()) !== path.resolve(home)) {
    throw new Error(
      `home redirect did not take on ${process.platform}: os.homedir() is ${os.homedir()}, wanted ${home}`,
    );
  }
  // Asked of the code under test, not of the environment: what it would write
  // must already be inside the throwaway directory.
  for (const target of ['claude', 'gemini']) {
    const resolved = portal.globalGuideFilePath(target);
    if (!resolved || !path.resolve(resolved).startsWith(path.resolve(home) + path.sep)) {
      throw new Error(`${target}'s machine-wide guide resolved outside the temp home: ${resolved}`);
    }
  }
  return home;
}

function sectionCount(content: string): { starts: number; ends: number } {
  return {
    starts: content.split(GUIDE_MARKER_START).length - 1,
    ends: content.split(GUIDE_MARKER_END).length - 1,
  };
}

describe('the fence every test in this file depends on', () => {
  it('resolves the machine-wide guide inside the temp home, and writes only there', () => {
    const home = inTempHome();
    const target = portal.globalGuideFilePath('claude')!;

    adapter.injectGuide(target, 'global');

    expect(fs.existsSync(target)).toBe(true);
    expect(path.resolve(target).startsWith(path.resolve(home) + path.sep)).toBe(true);
    expect(REAL_GUIDES).not.toContain(path.resolve(target));
    expect(REAL_GUIDES.map(readOrNull)).toEqual(REAL_GUIDES_BEFORE);
  });

  it('honours the config-dir override an account alias sets, rather than the home default', () => {
    const home = inTempHome();
    // Exactly the shape a second Claude Code account takes on this machine.
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude-alias');

    expect(adapter.globalGuideFilePath('claude')).toBe(path.join(home, '.claude-alias', 'CLAUDE.md'));
    expect(adapter.globalGuideFilePath('gemini')).toBe(path.join(home, '.gemini', 'GEMINI.md'));
  });

  it('answers nothing for a tool it does not inject a machine-wide guide into', () => {
    inTempHome();
    expect(adapter.globalGuideFilePath('cursor')).toBeNull();
    expect(adapter.globalGuideFilePath('agy')).toBeNull();
  });
});

describe('cli_core_adapter finds a tool\'s configuration file where the guide says it is', () => {
  it('answers the same path as the Portal, for the project and for the machine', () => {
    const home = inTempHome();
    const root = tempDir('project');

    expect(adapter.globalGuideFilePath('claude')).toBe(portal.globalGuideFilePath('claude'));
    expect(adapter.localGuideFilePath(root, 'claude')).toBe(portal.localGuideFilePath(root, 'claude'));
    expect(adapter.localGuideFilePath(root, 'claude')).toBe(path.join(root, '.claude', 'CLAUDE.md'));
    // Antigravity reads Gemini's file, which is the one thing the target list
    // does not say out loud.
    expect(adapter.localGuideFilePath(root, 'agy')).toBe(path.join(root, '.gemini', 'GEMINI.md'));
    expect(adapter.localGuideFilePath(root, 'cursor')).toBeNull();
    expect(path.resolve(home)).toBe(path.resolve(os.homedir()));
  });
});

describe('injecting the guide is idempotent, and the file stays the tool\'s', () => {
  it('leaves one section after two injections, not two', () => {
    inTempHome();
    const file = path.join(tempDir('inject'), 'CLAUDE.md');

    adapter.injectGuide(file, 'local');
    const once = fs.readFileSync(file, 'utf8');
    adapter.injectGuide(file, 'local');
    const twice = fs.readFileSync(file, 'utf8');

    expect(sectionCount(once)).toEqual({ starts: 1, ends: 1 });
    expect(sectionCount(twice)).toEqual({ starts: 1, ends: 1 });
    // Same build, same body: the second run is a no-op on the bytes as well as
    // on the count.
    expect(twice).toBe(once);
  });

  it('keeps what a person wrote around the markers when it replaces the section', () => {
    inTempHome();
    const file = path.join(tempDir('around'), 'CLAUDE.md');
    fs.writeFileSync(
      file,
      [
        '# My own notes',
        '',
        'Run the integration suite before pushing.',
        '',
        GUIDE_MARKER_START,
        '<!-- wairon-version: 0.0.1 -->',
        'a guide an older wairon wrote',
        GUIDE_MARKER_END,
        '',
        'And a line I wrote underneath it.',
        '',
      ].join('\n'),
      'utf8',
    );

    adapter.injectGuide(file, 'local');
    const content = fs.readFileSync(file, 'utf8');

    expect(content).toContain('# My own notes');
    expect(content).toContain('Run the integration suite before pushing.');
    expect(content).toContain('And a line I wrote underneath it.');
    expect(content).not.toContain('a guide an older wairon wrote');
    expect(sectionCount(content)).toEqual({ starts: 1, ends: 1 });
    expect(adapter.readStampVersion(content)).toBe(WAIRON_VERSION);
  });

  it('creates the file and its directory when the tool has never been configured here', () => {
    inTempHome();
    const file = path.join(tempDir('fresh'), '.claude', 'CLAUDE.md');
    expect(fs.existsSync(path.dirname(file))).toBe(false);

    adapter.injectGuide(file, 'local');

    expect(fs.readFileSync(file, 'utf8')).toContain(GUIDE_MARKER_START);
  });

  it('carries the scope across both hops: the machine-wide body and the in-project one differ', () => {
    inTempHome();
    const dir = tempDir('scope');
    const globalFile = path.join(dir, 'global.md');
    const localFile = path.join(dir, 'local.md');

    adapter.injectGuide(globalFile, 'global');
    adapter.injectGuide(localFile, 'local');

    const globalText = fs.readFileSync(globalFile, 'utf8');
    const localText = fs.readFileSync(localFile, 'utf8');
    // The global guide must stay INERT in a project with no spec tree; the
    // local one addresses an agent already operating inside one. A forward that
    // dropped the scope argument would write the same file twice.
    expect(globalText).toContain('## wairon — Spec-Driven Development (optional)');
    expect(globalText).toContain('If `.wai/specs/` exists, the wairon SDD workflow is active');
    expect(localText).toContain('## Wairon — Spec-Driven Development (you are operating inside it)');
    expect(localText).not.toContain('## wairon — Spec-Driven Development (optional)');
    expect(globalText).not.toContain('you are operating inside it');
  });

  it('stamps the section with the build that wrote it', () => {
    inTempHome();
    const file = path.join(tempDir('stamp'), 'GEMINI.md');

    adapter.injectGuide(file, 'local');

    expect(fs.readFileSync(file, 'utf8')).toContain(versionStamp());
  });
});

describe('stripping a guide out leaves everything that is not ours', () => {
  it('answers content carrying no markers unchanged', () => {
    const handWritten = '# A file we have never written to\n\nnothing of ours in here\n';
    expect(stripGuideSection(handWritten)).toBe(handWritten);
    expect(stripGuideSection('')).toBe('');
  });

  it('answers everything before the opening marker joined to everything after the closing one', () => {
    const content = `before\n${GUIDE_MARKER_START}\nours\n${GUIDE_MARKER_END}\nafter\n`;
    expect(stripGuideSection(content)).toBe('before\n\nafter\n');
  });

  it('answers unchanged when only one of the two markers is there', () => {
    // A half-marked file is one somebody edited, not one to cut in half.
    const openOnly = `keep\n${GUIDE_MARKER_START}\nand this\n`;
    expect(stripGuideSection(openOnly)).toBe(openOnly);
    const closeOnly = `keep\n${GUIDE_MARKER_END}\nand this\n`;
    expect(stripGuideSection(closeOnly)).toBe(closeOnly);
  });
});

describe('refreshing the in-project guides writes the guide and the pointer together', () => {
  it('writes the in-project guide and the repository-root pointer for a known target', () => {
    inTempHome();
    const root = tempDir('refresh');

    const written = adapter.reinjectLocalGuides(root, ['claude']);

    expect(written).toEqual([path.join(root, '.claude', 'CLAUDE.md')]);
    expect(fs.readFileSync(written[0], 'utf8')).toContain(GUIDE_MARKER_START);
    // The root file is a POINTER, not a second copy: one document to keep
    // current instead of two that can disagree.
    const rootPointer = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(rootPointer).toContain('@.claude/CLAUDE.md');
    expect(rootPointer).not.toContain(GUIDE_MARKER_START);
  });

  it('inlines the whole guide in the root file for Gemini, which does not follow the pointer', () => {
    inTempHome();
    const root = tempDir('refresh-gemini');

    const written = adapter.reinjectLocalGuides(root, ['agy']);

    expect(written).toEqual([path.join(root, '.gemini', 'GEMINI.md')]);
    const rootFile = fs.readFileSync(path.join(root, 'GEMINI.md'), 'utf8');
    expect(rootFile).toContain(GUIDE_MARKER_START);
    expect(rootFile).toContain('## Wairon — Spec-Driven Development (you are operating inside it)');
  });

  it('ignores a target name it does not recognize, rather than refusing the call', () => {
    inTempHome();
    const root = tempDir('refresh-unknown');

    // Callers pass whatever the project has configured, which is why an
    // unknown name is skipped rather than thrown on.
    expect(adapter.reinjectLocalGuides(root, ['nonsense'])).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('skips only the unknown name, and still writes for the known ones beside it', () => {
    inTempHome();
    const root = tempDir('refresh-mixed');

    const written = adapter.reinjectLocalGuides(root, ['nonsense', 'claude', 'cursor']);

    expect(written).toEqual([path.join(root, '.claude', 'CLAUDE.md')]);
    // cursor is a guide target with a root file but no in-project guide, so it
    // contributes a pointer and no path.
    expect(fs.existsSync(path.join(root, '.cursorrules'))).toBe(true);
  });

  it('answers each guide path once, however many times it was asked for', () => {
    inTempHome();
    const root = tempDir('refresh-dupes');

    expect(adapter.reinjectLocalGuides(root, ['claude', 'claude'])).toEqual([
      path.join(root, '.claude', 'CLAUDE.md'),
    ]);
    // gemini and agy are two names for one file, and the answer says so once.
    expect(adapter.reinjectLocalGuides(root, ['gemini', 'agy'])).toEqual([
      path.join(root, '.gemini', 'GEMINI.md'),
    ]);
  });

  it('installs where no guide existed and refreshes one that did, leaving a single section', () => {
    inTempHome();
    const root = tempDir('refresh-twice');

    adapter.reinjectLocalGuides(root, ['claude']);
    adapter.reinjectLocalGuides(root, ['claude']);

    const guide = fs.readFileSync(path.join(root, '.claude', 'CLAUDE.md'), 'utf8');
    expect(sectionCount(guide)).toEqual({ starts: 1, ends: 1 });
  });

  it('writes into the root it is handed, never the process working directory', () => {
    // `wairon generate` cascading into a chained subproject depends on this:
    // the subproject layer refreshes ITS guides in ITS directory.
    inTempHome();
    const root = tempDir('refresh-elsewhere');

    adapter.reinjectLocalGuides(root, ['claude']);

    expect(fs.existsSync(path.join(root, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(path.resolve(root)).not.toBe(path.resolve(process.cwd()));
  });
});

describe('the stamp a generated file carries, read through the Portal', () => {
  it('round-trips: what the stamp renders is what reading it answers', () => {
    expect(portal.readStampVersion(versionStamp())).toBe(WAIRON_VERSION);
    expect(adapter.readStampVersion(`# generated\n${versionStamp()}\nbody`)).toBe(WAIRON_VERSION);
  });

  it('answers nothing for content that carries no stamp', () => {
    // Not an error but a fact: the file predates stamping, or somebody replaced
    // it wholesale, and either way there is nothing to compare against.
    expect(adapter.readStampVersion('# a hand-written file\nno stamp here')).toBeNull();
    expect(portal.readStampVersion('')).toBeNull();
  });

  it('answers an older build\'s version, which is the whole point of reading one', () => {
    expect(adapter.readStampVersion('<!-- wairon-version: 0.0.1 -->')).toBe('0.0.1');
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

/**
 * The text of one named import or re-export block, found by literal string
 * search rather than a pattern: an escaped regex has quietly matched nothing in
 * these scans five times. Asking WHICH block a name sits in is the whole
 * assertion — every one of these names was already named by these files, off
 * the wrong module.
 */
function namedBlock(file: string, opener: 'import {' | 'export {', module: string): string {
  const text = source(file);
  const tail = "} from '" + module + "';";
  const end = text.indexOf(tail);
  expect(end, `${file} names nothing from ${module}`).toBeGreaterThan(-1);
  const start = text.lastIndexOf(opener, end);
  expect(start, `${file}'s ${module} block does not open with \`${opener}\``).toBeGreaterThan(-1);
  const block = text.slice(start, end + tail.length);
  // One block, not a run of them: a stray opener earlier in the file would
  // otherwise hand back half the file's imports and pass on any of them.
  const names = block.slice(opener.length, block.length - tail.length);
  expect(names, `${file}: the ${module} block is not one contiguous list`).not.toContain("from '");
  return block;
}

const importBlock = (file: string, module: string): string => namedBlock(file, 'import {', module);

describe('the three commands reach the guide and the stamp through cli_core_adapter', () => {
  // Literal lines, not patterns: an escaped regex has quietly matched nothing
  // here five times.
  for (const file of ['src/commands/doctor.ts', 'src/commands/generate.ts', 'src/commands/init.ts']) {
    it(`${file} names neither sdd_core module`, () => {
      const text = source(file);
      expect(text, file).not.toContain("from '../utils/ai-guide.js'");
      expect(text, file).not.toContain("from '../core/stamp.js'");
      expect(text, file).not.toContain("require('../utils/ai-guide.js')");
      expect(text, file).not.toContain("require('../core/stamp.js')");
      expect(text, file).toContain("} from './adapters/core.js';");
    });
  }

  it('doctor takes the stamp and both guide calls off the adapter', () => {
    const block = importBlock('src/commands/doctor.ts', './adapters/core.js');
    expect(block).toContain('  readStampVersion,');
    expect(block).toContain('  localGuideFilePath,');
    expect(block).toContain('  reinjectLocalGuides,');
  });

  it('init takes all four write-side guide calls off the adapter', () => {
    const block = importBlock('src/commands/init.ts', './adapters/core.js');
    expect(block).toContain('  globalGuideFilePath,');
    expect(block).toContain('  localGuideFilePath,');
    expect(block).toContain('  injectGuide,');
    expect(block).toContain('  writeRootGuideDelegator,');
  });

  it('generate imports the refresh statically, instead of requiring it at the call', () => {
    // The lazy form did two things at once: it hid the crossing from a reader,
    // and it does not resolve once the module is bundled — src/core/context.ts
    // carries that same note about that same form.
    expect(importBlock('src/commands/generate.ts', './adapters/core.js')).toContain('  reinjectLocalGuides,');
    const text = source('src/commands/generate.ts');
    expect(text).not.toContain('const { reinjectLocalGuides } = require(');
    expect(text).toContain('reinjectLocalGuides(getProjectRoot(), activeTargetTypes(projectConfig));');
  });
});

describe('the Portal publishes the six, and the adapter forwards them', () => {
  it('core_portal republishes the guide and the stamp by identity', () => {
    expect(source('src/core/index.ts')).toContain("export { readStampVersion } from './stamp.js';");
    // A re-export, not a wrapper: the Portal method and the tool guide's
    // function are one function, which is what makes the forward 1:1.
    const block = namedBlock('src/core/index.ts', 'export {', '../utils/ai-guide.js');
    for (const name of [
      'globalGuideFilePath',
      'localGuideFilePath',
      'injectGuide',
      'writeRootGuideDelegator',
      'reinjectLocalGuides',
    ]) {
      expect(block, name).toContain(`  ${name},`);
    }
  });

  it('cli_core_adapter forwards each one 1:1, in the shape the contract names', () => {
    // The adapter is a module of its own now, and a forward is an IDENTITY
    // re-export of the core portal: the contract method and the portal's
    // function are one function, so there is no wrapper body to read.
    const block = namedBlock('src/commands/adapters/core.ts', 'export {', '../../core/index.js');
    expect(block).toContain('  globalGuideFilePath,');
    expect(block).toContain('  localGuideFilePath,');
    expect(block).toContain('  injectGuide,');
    expect(block).toContain('  writeRootGuideDelegator,');
    expect(block).toContain('  reinjectLocalGuides,');
    expect(block).toContain('  readStampVersion,');
    expect(source('src/commands/adapters/core.ts')).not.toContain('export function');
  });

  it('offers nothing the contract does not name — hasWaironGuide is gone', () => {
    // It answered "does this file already carry a guide?", which no caller ever
    // asked: injection is idempotent, so nobody has to look first. A published
    // read with no reader is a claim somebody later trusts.
    expect(source('src/utils/ai-guide.ts')).not.toContain('hasWaironGuide');
    expect('hasWaironGuide' in portal).toBe(false);
    expect('hasWaironGuide' in adapter).toBe(false);
  });

  it('keeps stripGuideSection off the Portal — it is the guide\'s own seam', () => {
    // inject strips before it appends, which is what makes injection
    // idempotent. A Portal republishing it would be offering a half-write.
    expect('stripGuideSection' in portal).toBe(false);
    expect('stripGuideSection' in adapter).toBe(false);
  });
});
