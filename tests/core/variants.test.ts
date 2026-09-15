import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { loadProjectVariants, listProjectVariants, rebaseProjectVariants } from '../../src/core/variants.js';
import { setProjectRoot } from '../../src/utils/fs.js';

// ---------------------------------------------------------------------------
// The variant registry's layers — wairon's built-in variants, then the global
// directory (WAIRON_VARIANTS_DIR), then the project's .wai/variants/, a later
// layer overriding by id — and the project-only read and rebase a migration
// uses to move project variants off a retired base.
// ---------------------------------------------------------------------------

/** The built-in variants and the base each specializes. */
const BUILTIN_BASES = {
  arbiter: 'Orchestrator',
  projector: 'Orchestrator',
  composer: 'Orchestrator',
  codec: 'Orchestrator',
  gateway: 'Portal',
};

let projectDir: string;
let globalDir: string;

function writeProjectVariants(file: string, content: string): string {
  const full = path.join(projectDir, '.wai', 'variants', file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function writeGlobalVariants(file: string, content: string): string {
  const full = path.join(globalDir, file);
  fs.writeFileSync(full, content);
  return full;
}

/** The diagnostics logged so far, one string per console.error call. */
function diagnostics(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.map(String).join(' '));
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-variants-project-'));
  fs.mkdirSync(path.join(projectDir, '.wai', 'specs'), { recursive: true });
  globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-variants-global-'));
  // Isolated from the machine's own ~/.wairon/variants.
  process.env.WAIRON_VARIANTS_DIR = globalDir;
  setProjectRoot(projectDir);
});

afterEach(() => {
  setProjectRoot(null);
  delete process.env.WAIRON_VARIANTS_DIR;
  vi.restoreAllMocks();
  for (const dir of [projectDir, globalDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win file locks */ }
  }
});

describe('loadProjectVariants', () => {
  it('loads the built-in variants when there are no global or project variants', () => {
    const bases = Object.fromEntries(loadProjectVariants().map((v) => [v.id, v.base]));
    expect(bases).toEqual(BUILTIN_BASES);
  });

  it('gives each built-in logic variant its dependency class, and the gateway its auth, never Specialist wording', () => {
    const byId = new Map(loadProjectVariants().map((v) => [v.id, v.guidance]));
    for (const id of ['arbiter', 'codec']) expect(byId.get(id)).toMatch(/\bpure\b/);
    for (const id of ['projector', 'composer']) {
      expect(byId.get(id)).toMatch(/\bpure\b/);
      expect(byId.get(id)).toMatch(/\bread\b/);
    }
    expect(byId.get('gateway')).toMatch(/`auth`/);
    for (const guidance of byId.values()) expect(guidance).not.toMatch(/Specialist/);
  });

  it('lets a project variant override a built-in variant with the same id', () => {
    expect(loadProjectVariants().find((v) => v.id === 'arbiter')?.guidance).toMatch(/ruling authority/);
    writeProjectVariants('arbiter.yaml', 'id: arbiter\nbase: Orchestrator\nguidance: PROJECT arbiter\n');

    const arbiters = loadProjectVariants().filter((v) => v.id === 'arbiter');
    expect(arbiters).toHaveLength(1);
    expect(arbiters[0].guidance).toBe('PROJECT arbiter');
  });

  it('lets a global variant override a built-in one, and a project variant override the global one', () => {
    writeGlobalVariants('shapes.yaml', [
      '- id: codec',
      '  base: Orchestrator',
      '  guidance: GLOBAL codec',
      '- id: composer',
      '  base: Orchestrator',
      '  guidance: GLOBAL composer',
      '',
    ].join('\n'));
    writeProjectVariants('composer.yaml', 'id: composer\nbase: Orchestrator\nguidance: PROJECT composer\n');

    const byId = new Map(loadProjectVariants().map((v) => [v.id, v]));
    expect(byId.get('codec')?.guidance).toBe('GLOBAL codec');
    expect(byId.get('composer')?.guidance).toBe('PROJECT composer');
    expect(byId.get('arbiter')?.base).toBe('Orchestrator');
  });

  it('skips a malformed file with a diagnostic and keeps loading the rest', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unparsable = writeProjectVariants('a-unparsable.yaml', 'id: [unclosed\n');
    const invalid = writeProjectVariants('b-invalid.yaml', 'id: no-base\nguidance: a variant missing its base\n');
    writeProjectVariants('c-valid.yaml', 'id: publisher\nbase: Adapter\nguidance: Reuse the shared publisher.\n');

    const ids = loadProjectVariants().map((v) => v.id);
    expect(ids).toContain('publisher');
    expect(ids).toContain('arbiter');
    expect(ids).not.toContain('no-base');
    expect(diagnostics(error).some((d) => d.includes(unparsable))).toBe(true);
    expect(diagnostics(error).some((d) => d.includes(invalid))).toBe(true);
  });

  it('treats missing global and project directories as empty layers', () => {
    process.env.WAIRON_VARIANTS_DIR = path.join(globalDir, 'does-not-exist');

    expect(loadProjectVariants().map((v) => v.id).sort()).toEqual(Object.keys(BUILTIN_BASES).sort());
  });
});

describe('listProjectVariants', () => {
  it('returns only the project variants, never the built-in or global ones', () => {
    writeGlobalVariants('shared.yaml', 'id: shared\nbase: Adapter\nguidance: the global one\n');
    writeProjectVariants('publisher.yaml', 'id: publisher\nbase: Adapter\nguidance: the project one\n');

    expect(listProjectVariants().map((v) => v.id)).toEqual(['publisher']);
  });

  it('returns a project variant that overrides a built-in one as the project defines it', () => {
    writeProjectVariants('shapes.yaml', 'id: arbiter\nbase: Specialist\nguidance: the project arbiter\n');

    expect(listProjectVariants()).toEqual([{ id: 'arbiter', base: 'Specialist', guidance: 'the project arbiter' }]);
  });

  it('is empty when the project has no variants directory', () => {
    expect(listProjectVariants()).toEqual([]);
  });
});

describe('rebaseProjectVariants', () => {
  it("rebases only the matching variants, keeping the file's other variants, fields and comments", () => {
    const file = writeProjectVariants('shapes.yaml', [
      "# The project's logic shapes.",
      '- id: arbiter',
      '  base: Specialist  # retired',
      '  guidance: >-',
      '    Rules on supplied facts.',
      '  target: typescript',
      '- id: publisher',
      '  base: Adapter',
      '  guidance: Fans out events.',
      '  profile: backend',
      '',
    ].join('\n'));

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual(['arbiter']);

    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain("# The project's logic shapes.");
    expect(text).toContain('# retired');
    expect(yaml.load(text)).toEqual([
      { id: 'arbiter', base: 'Orchestrator', guidance: 'Rules on supplied facts.', target: 'typescript' },
      { id: 'publisher', base: 'Adapter', guidance: 'Fans out events.', profile: 'backend' },
    ]);
  });

  it('rebases a variant written in flow style', () => {
    const file = writeProjectVariants('flow.yaml', '- {id: codec, base: Specialist, guidance: Translates formats.}\n');

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual(['codec']);
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).toEqual([
      { id: 'codec', base: 'Orchestrator', guidance: 'Translates formats.' },
    ]);
  });

  it('rewrites only the base, even when the guidance text contains a base line', () => {
    const file = writeProjectVariants('arbiter.yaml', [
      'id: arbiter',
      'base: Specialist',
      'guidance: |-',
      '  Formerly declared as',
      '  base: Specialist',
      '',
    ].join('\n'));

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual(['arbiter']);
    expect(yaml.load(fs.readFileSync(file, 'utf8'))).toEqual({
      id: 'arbiter', base: 'Orchestrator', guidance: 'Formerly declared as\nbase: Specialist',
    });
  });

  it('leaves a file with no such variant byte-identical', () => {
    const content = '# untouched\nid: publisher\nbase: Adapter\nguidance:   Fans out events.\n';
    const file = writeProjectVariants('publisher.yaml', content);

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
  });

  it('skips a malformed file with a diagnostic and leaves it unchanged', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const content = '- id: arbiter\n  base: Specialist\n';
    const file = writeProjectVariants('missing-guidance.yaml', content);

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(diagnostics(error).some((d) => d.includes(file))).toBe(true);
  });

  it('returns exactly the ids rebased across the project files, and never touches the global layer', () => {
    const globalContent = 'id: shared-arbiter\nbase: Specialist\nguidance: the global one\n';
    const globalFile = writeGlobalVariants('shared.yaml', globalContent);
    writeProjectVariants('a.yaml', 'id: arbiter\nbase: Specialist\nguidance: rules\n');
    writeProjectVariants('b.yaml', [
      '- id: codec',
      '  base: Specialist',
      '  guidance: translates',
      '- id: publisher',
      '  base: Adapter',
      '  guidance: fans out',
      '',
    ].join('\n'));

    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual(['arbiter', 'codec']);
    expect(fs.readFileSync(globalFile, 'utf8')).toBe(globalContent);
    expect(listProjectVariants().map((v) => [v.id, v.base])).toEqual([
      ['arbiter', 'Orchestrator'],
      ['codec', 'Orchestrator'],
      ['publisher', 'Adapter'],
    ]);
  });

  it('rebases nothing when the project has no variants directory', () => {
    expect(rebaseProjectVariants('Specialist', 'Orchestrator')).toEqual([]);
  });
});
