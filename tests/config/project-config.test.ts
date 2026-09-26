import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
  projectConfigRepository,
  projectConfigRepositoryAt,
  projectConfigRepositoryOver,
  projectConfigFsAdapterAt,
  type ProjectConfigFsAdapter,
  type ProjectConfigRepository,
} from '../../src/config/project-config.js';
import { GLOBAL_PACKS_DEFAULT } from '../../src/core/extensions.js';
import { ProjectNotInitializedError, WaironError } from '../../src/utils/errors.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { declaredPackNames, declaredProfileIds, type ProjectConfig } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// The project configuration Repository (stage 2a-0): the only way into
// .wai/project.yaml. Each test pins one behaviour of the store, the registry,
// the index, or the project_config type, in a temporary project root.
// ---------------------------------------------------------------------------

const NOW = '2026-09-13T10:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-pcfg-'));
  roots.push(dir);
  return dir;
}

function configFile(root: string, dir = '.wai'): string {
  return path.join(root, dir, 'project.yaml');
}

/** Leave a project.yaml on disk verbatim, the way a human would. */
function writeDoc(root: string, lines: string[], dir = '.wai'): void {
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(configFile(root, dir), lines.join('\n') + '\n');
}

function readDoc(root: string, dir = '.wai'): any {
  return yaml.load(fs.readFileSync(configFile(root, dir), 'utf8'));
}

/** A comment a rewrite drops — its survival proves nothing was written. */
const MARKER = '# untouched-marker';

/** A minimal valid document, plus any extra lines. */
function minimal(...extra: string[]): string[] {
  return [
    MARKER,
    'schemaVersion: 1.0.0',
    'name: demo',
    'targets: []',
    'rules: {}',
    `createdAt: '${NOW}'`,
    `updatedAt: '${NOW}'`,
    ...extra,
  ];
}

/** The Repository over the real fs adapter, with every document write counted. */
function counted(root: string): { repo: ProjectConfigRepository; writes: () => number } {
  const real = projectConfigFsAdapterAt(root);
  let n = 0;
  const adapter: ProjectConfigFsAdapter = {
    readDocument: () => real.readDocument(),
    writeDocument: (document) => { n++; real.writeDocument(document); },
    documentExists: () => real.documentExists(),
    readText: () => real.readText(),
    writeText: (text) => { n++; real.writeText(text); },
  };
  return { repo: projectConfigRepositoryOver(adapter, root), writes: () => n };
}

function untouched(root: string): boolean {
  return fs.readFileSync(configFile(root), 'utf8').includes(MARKER);
}

function freshConfig(name: string): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType: 'backend',
    targets: [],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: [],
      enforceReproducibility: true,
      generateComponentImplementers: false,
      materializeAgentFiles: false,
      sddRuleSeverity: {},
    },
    execution: { tier: 'off', overrides: {} },
    paths: { specsDir: '.wai/specs' },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

// ── store ────────────────────────────────────────────────────────────────────

describe('project config store', () => {
  it('keeps unknown keys, top-level and under extensions, through a pack write', () => {
    const root = tempRoot();
    writeDoc(root, minimal(
      'futureTopLevel:',
      '  keep: me',
      'extensions:',
      '  packs: []',
      '  futureExtensionsKey: 42',
    ));

    projectConfigRepositoryAt(root).upsertPackSelection({ name: 'alpha' });

    const doc = readDoc(root);
    expect(doc.futureTopLevel).toEqual({ keep: 'me' });
    expect(doc.extensions.futureExtensionsKey).toBe(42);
    expect(doc.extensions.packs).toEqual([{ name: 'alpha' }]);
  });

  it('keeps a dropped entry dropped', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - name: alpha', '    - name: beta'));

    projectConfigRepositoryAt(root).removePackSelection('alpha');

    expect(readDoc(root).extensions.packs).toEqual([{ name: 'beta' }]);
  });

  it('keeps the document key order and appends new keys', () => {
    const root = tempRoot();
    writeDoc(root, [
      'name: demo',
      'futureTopLevel: 1',
      'schemaVersion: 1.0.0',
      'targets: []',
      'rules: {}',
      `createdAt: '${NOW}'`,
      `updatedAt: '${NOW}'`,
    ]);

    projectConfigRepositoryAt(root).setProjectType('frontend-reactive');

    // `id` is new to this document too: the save backfilled the defaulted id.
    expect(Object.keys(readDoc(root))).toEqual([
      'name', 'futureTopLevel', 'schemaVersion', 'targets', 'rules', 'createdAt', 'updatedAt',
      'projectType', 'execution', 'paths', 'id',
    ]);
  });

  it("raises the loader's WaironError for a document that fails the schema", () => {
    const root = tempRoot();
    writeDoc(root, ['schemaVersion: 1.0.0', 'name: 5', 'targets: []', `createdAt: '${NOW}'`, `updatedAt: '${NOW}'`]);

    let error: unknown;
    try {
      projectConfigRepositoryAt(root).load();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(WaironError);
    expect((error as Error).message).toMatch(/^Invalid \.wai\/project\.yaml: /);
    expect((error as Error).message).toContain('"name"');
  });

  it('refuses to write a configuration that fails the schema, writing nothing', () => {
    const root = tempRoot();
    writeDoc(root, minimal());
    const { repo, writes } = counted(root);

    expect(() => repo.setExecutionTier('turbo')).toThrow(WaironError);
    expect(writes()).toBe(0);
    expect(untouched(root)).toBe(true);
  });
});

// ── registry ─────────────────────────────────────────────────────────────────

describe('project config registry', () => {
  it('registerPackRef appends an absent path reference and reports it', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - name: beta'));
    const { repo, writes } = counted(root);

    expect(repo.registerPackRef('.wai/packs/alpha.yaml')).toBe(true);
    expect(writes()).toBe(1);
    expect(readDoc(root).extensions.packs).toEqual([{ name: 'beta' }, '.wai/packs/alpha.yaml']);
  });

  it('registerPackRef writes nothing when the exact reference is already there', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - .wai/packs/alpha.yaml'));
    const { repo, writes } = counted(root);

    expect(repo.registerPackRef('.wai/packs/alpha.yaml')).toBe(false);
    expect(writes()).toBe(0);
    expect(untouched(root)).toBe(true);
  });

  it('deregisterPackRef drops the equal path reference and leaves selections alone', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - .wai/packs/alpha.yaml', '    - name: .wai/packs/alpha.yaml'));
    const { repo, writes } = counted(root);

    expect(repo.deregisterPackRef('.wai/packs/alpha.yaml')).toBe(true);
    expect(writes()).toBe(1);
    expect(readDoc(root).extensions.packs).toEqual([{ name: '.wai/packs/alpha.yaml' }]);
  });

  it('deregisterPackRef writes nothing when no path reference matches', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - name: alpha'));
    const { repo, writes } = counted(root);

    expect(repo.deregisterPackRef('alpha')).toBe(false);
    expect(writes()).toBe(0);
    expect(untouched(root)).toBe(true);
  });

  it('upsertPackSelection drops same-name selections and appends the new one last', () => {
    const root = tempRoot();
    writeDoc(root, minimal(
      'extensions:',
      '  packs:',
      '    - name: alpha',
      '      version: 1.0.0',
      '    - .wai/packs/alpha.yaml',
      '    - name: beta',
    ));
    const { repo, writes } = counted(root);

    expect(repo.upsertPackSelection({ name: 'alpha', version: '2.0.0' })).toBe(true);
    expect(writes()).toBe(1);
    expect(readDoc(root).extensions.packs).toEqual([
      '.wai/packs/alpha.yaml',
      { name: 'beta' },
      { name: 'alpha', version: '2.0.0' },
    ]);
  });

  it('upsertPackSelection reports false for a pack not selected before', () => {
    const root = tempRoot();
    writeDoc(root, minimal());

    expect(projectConfigRepositoryAt(root).upsertPackSelection({ name: 'alpha' })).toBe(false);
    expect(readDoc(root).extensions.packs).toEqual([{ name: 'alpha' }]);
  });

  it('removePackSelection drops every same-name selection and leaves path references', () => {
    const root = tempRoot();
    writeDoc(root, minimal(
      'extensions:',
      '  packs:',
      '    - name: alpha',
      '    - alpha',
      '    - name: alpha',
      '      version: 2.0.0',
    ));
    const { repo, writes } = counted(root);

    expect(repo.removePackSelection('alpha')).toBe(true);
    expect(writes()).toBe(1);
    expect(readDoc(root).extensions.packs).toEqual(['alpha']);
  });

  it('removePackSelection writes nothing when no selection matches', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  packs:', '    - alpha'));
    const { repo, writes } = counted(root);

    expect(repo.removePackSelection('alpha')).toBe(false);
    expect(writes()).toBe(0);
    expect(untouched(root)).toBe(true);
  });

  it('markSelectionsBundled marks selections in place, skips unselected packs, in one write', () => {
    const root = tempRoot();
    writeDoc(root, minimal(
      'extensions:',
      '  packs:',
      '    - name: alpha',
      '    - .wai/packs/legacy.yaml',
      '    - name: beta',
      '      source: https://example.test/beta.wpack',
      '    - name: gamma',
    ));
    const { repo, writes } = counted(root);

    repo.markSelectionsBundled([
      { name: 'beta', version: '2.0.0' },
      { name: 'alpha', version: '1.0.0' },
      { name: 'not-selected', version: '9.9.9' },
    ]);

    expect(writes()).toBe(1);
    expect(readDoc(root).extensions.packs).toEqual([
      { name: 'alpha', version: '1.0.0', bundle: true },
      '.wai/packs/legacy.yaml',
      { name: 'beta', source: 'https://example.test/beta.wpack', version: '2.0.0', bundle: true },
      { name: 'gamma' },
    ]);
  });

  it('pinGlobalPacksAsSelections appends after existing entries and turns global packs off, in one write', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  useGlobalPacks: true', '  packs:', '    - .wai/packs/legacy.yaml'));
    const { repo, writes } = counted(root);

    repo.pinGlobalPacksAsSelections([{ name: 'org', version: '1.0.0' }, { name: 'team', version: '0.1.0' }]);

    expect(writes()).toBe(1);
    const doc = readDoc(root);
    expect(doc.extensions.packs).toEqual(['.wai/packs/legacy.yaml', { name: 'org', version: '1.0.0' }, { name: 'team', version: '0.1.0' }]);
    expect(doc.extensions.useGlobalPacks).toBe(false);
  });

  it('a pack write keeps an explicit useGlobalPacks at its value', () => {
    const root = tempRoot();
    writeDoc(root, minimal('extensions:', '  useGlobalPacks: true', '  packs: []'));

    projectConfigRepositoryAt(root).registerPackRef('.wai/packs/alpha.yaml');

    expect(readDoc(root).extensions.useGlobalPacks).toBe(true);
  });

  it('a pack write records an absent useGlobalPacks at the shared default', () => {
    const root = tempRoot();
    writeDoc(root, minimal());
    const repo = projectConfigRepositoryAt(root);
    expect(repo.declaresGlobalPacks()).toBe(false);

    repo.registerPackRef('.wai/packs/alpha.yaml');

    expect(readDoc(root).extensions.useGlobalPacks).toBe(GLOBAL_PACKS_DEFAULT);
    expect(repo.declaresGlobalPacks()).toBe(true);
  });

  it('setProjectType, recordProfileSelection and setExecutionTier set their field', () => {
    const root = tempRoot();
    writeDoc(root, minimal('execution:', '  tier: off', '  overrides:', '    some-agent:', '      maxTurns: 5'));
    const repo = projectConfigRepositoryAt(root);

    repo.setProjectType('game-ecs');
    repo.recordProfileSelection({ profileIds: ['game-ecs'], requiredPackNames: ['ecs'], selectedAt: NOW });
    repo.setExecutionTier('default');

    const config = repo.load()!;
    expect(config.projectType).toBe('game-ecs');
    expect(config.profileSelection).toEqual({ profileIds: ['game-ecs'], requiredPackNames: ['ecs'], selectedAt: NOW });
    expect(config.execution).toEqual({ tier: 'default', overrides: { 'some-agent': { maxTurns: 5 } } });
  });

  it('create writes a fresh configuration', () => {
    const root = tempRoot();
    const repo = projectConfigRepositoryAt(root);

    repo.create(freshConfig('fresh'));

    expect(repo.load()?.name).toBe('fresh');
  });

  it('create refuses a project that already has a configuration, naming the root', () => {
    const root = tempRoot();
    writeDoc(root, minimal());
    const { repo, writes } = counted(root);

    expect(() => repo.create(freshConfig('other'))).toThrow(path.resolve(root));
    expect(writes()).toBe(0);
    expect(untouched(root)).toBe(true);
  });

  const everyOtherWrite: [string, (repo: ProjectConfigRepository) => unknown][] = [
    ['upsertPackSelection', (r) => r.upsertPackSelection({ name: 'alpha' })],
    ['removePackSelection', (r) => r.removePackSelection('alpha')],
    ['setProjectType', (r) => r.setProjectType('backend')],
    ['recordProfileSelection', (r) => r.recordProfileSelection({ profileIds: [], requiredPackNames: [], selectedAt: NOW })],
    ['setExecutionTier', (r) => r.setExecutionTier('off')],
    ['registerPackRef', (r) => r.registerPackRef('.wai/packs/alpha.yaml')],
    ['deregisterPackRef', (r) => r.deregisterPackRef('.wai/packs/alpha.yaml')],
    ['markSelectionsBundled', (r) => r.markSelectionsBundled([{ name: 'alpha', version: '1.0.0' }])],
    ['pinGlobalPacksAsSelections', (r) => r.pinGlobalPacksAsSelections([{ name: 'alpha', version: '1.0.0' }])],
  ];

  it.each(everyOtherWrite)('%s refuses a project with no configuration', (_name, write) => {
    const root = tempRoot();
    const { repo, writes } = counted(root);

    expect(() => write(repo)).toThrow(ProjectNotInitializedError);
    expect(writes()).toBe(0);
    expect(fs.existsSync(configFile(root))).toBe(false);
  });
});

// ── index ────────────────────────────────────────────────────────────────────

describe('project config index', () => {
  it('load and exists report a project without a configuration', () => {
    const repo = projectConfigRepositoryAt(tempRoot());
    expect(repo.load()).toBeNull();
    expect(repo.exists()).toBe(false);
  });

  it('specsDir resolves paths.specsDir against the root', () => {
    const root = tempRoot();
    writeDoc(root, minimal('paths:', '  specsDir: design/specs'));
    expect(projectConfigRepositoryAt(root).specsDir()).toBe(path.resolve(root, 'design/specs'));
  });

  it('specsDir falls back to .wai/specs without paths.specsDir or without a configuration', () => {
    const root = tempRoot();
    expect(projectConfigRepositoryAt(root).specsDir()).toBe(path.join(path.resolve(root), '.wai', 'specs'));
    writeDoc(root, minimal());
    expect(projectConfigRepositoryAt(root).specsDir()).toBe(path.join(path.resolve(root), '.wai', 'specs'));
  });

  it('specsDir still locates the specs of a configuration that fails the schema', () => {
    const root = tempRoot();
    writeDoc(root, ['name: 5', 'paths:', '  specsDir: design/specs']);
    const repo = projectConfigRepositoryAt(root);

    expect(() => repo.load()).toThrow(WaironError);
    expect(repo.specsDir()).toBe(path.resolve(root, 'design/specs'));
  });

  it('specsDir never throws on a malformed document', () => {
    const root = tempRoot();
    writeDoc(root, ['name: [unclosed']);
    expect(projectConfigRepositoryAt(root).specsDir()).toBe(path.join(path.resolve(root), '.wai', 'specs'));
  });

  it('reads and writes a legacy .wairon configuration', () => {
    const root = tempRoot();
    writeDoc(root, minimal(), '.wairon');
    const repo = projectConfigRepositoryAt(root);

    expect(repo.exists()).toBe(true);
    expect(repo.load()?.name).toBe('demo');
    expect(repo.specsDir()).toBe(path.join(path.resolve(root), '.wairon', 'specs'));

    repo.setProjectType('monorepo');
    expect(readDoc(root, '.wairon').projectType).toBe('monorepo');
    expect(fs.existsSync(path.join(root, '.wai'))).toBe(false);
  });

  it('declaresGlobalPacks reports whether the document sets extensions.useGlobalPacks', () => {
    const root = tempRoot();
    const repo = projectConfigRepositoryAt(root);
    expect(repo.declaresGlobalPacks()).toBe(false);

    writeDoc(root, minimal('extensions:', '  packs: []'));
    expect(repo.declaresGlobalPacks()).toBe(false);

    writeDoc(root, minimal('extensions:', '  useGlobalPacks: false'));
    expect(repo.declaresGlobalPacks()).toBe(true);
  });

  it('the ambient repository follows the bound project root', () => {
    const withConfig = tempRoot();
    writeDoc(withConfig, minimal());
    const without = tempRoot();

    expect(runWithProjectRoot(withConfig, () => projectConfigRepository.load()?.name)).toBe('demo');
    expect(runWithProjectRoot(without, () => projectConfigRepository.exists())).toBe(false);
  });
});

// ── project_config type ──────────────────────────────────────────────────────

describe('project_config type behaviour', () => {
  it('declaredPackNames takes selection names and path stems, then profile pack names, deduplicated', () => {
    expect(declaredPackNames({
      extensions: {
        packs: [
          '.wai/packs/alpha.yaml',
          { name: 'beta', version: '1.0.0' },
          '.wai/packs/gamma',
          'node-module-pack.cjs',
          '.wai/packs/alpha.yml',
        ],
        useGlobalPacks: false,
      },
      profileSelection: {
        profileIds: [],
        requiredPackNames: ['beta', 'delta'],
        defaultPackNames: ['epsilon', 'alpha'],
        selectedAt: NOW,
      },
    })).toEqual(['alpha', 'beta', 'gamma', 'node-module-pack', 'delta', 'epsilon']);
  });

  it('declaredPackNames is empty when nothing is declared', () => {
    expect(declaredPackNames({})).toEqual([]);
  });

  it('declaredProfileIds deduplicates the recorded profile ids and never includes projectType', () => {
    expect(declaredProfileIds({
      profileSelection: { profileIds: ['game-ecs', 'backend', 'game-ecs'], requiredPackNames: [], selectedAt: NOW },
    })).toEqual(['game-ecs', 'backend']);
    expect(declaredProfileIds({})).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F78 — the debt register follows a renamed identity, and nothing else moves
//
// The register is keyed by exactly the ids a rename exists to rewrite. It is
// also written by people: every carried group has a count comment and prose.
// So the rekey edits the scalars in the TEXT, and the proof is a diff.
// ---------------------------------------------------------------------------

describe('project config registry — rekeyCarried (F78)', () => {
  /** The lines of two texts that differ, pairwise; the texts must have the same line count. */
  const changedLines = (before: string, after: string): [string, string][] => {
    const a = before.split('\n');
    const b = after.split('\n');
    expect(b).toHaveLength(a.length);
    return a.map((line, i) => [line, b[i]] as [string, string]).filter(([x, y]) => x !== y);
  };

  const REGISTER = [
    MARKER,
    'schemaVersion: 1.0.0',
    'name: demo',
    'targets: []',
    'rules:',
    '  conformance:',
    '    # The debt register, frozen.',
    '    carried:',
    '      # 2 finding(s), 3 unit(s).',
    '      - kind: drift',
    '        why: >-',
    '          A narrative names a call target: core_portal.loadX is where it',
    '          lands, and prose never moves.',
    '        findings:',
    '          - code: CALL_STEP_UNREALIZED',
    '            spec: core_portal_impl  # the portal',
    "            at: 'loadX'",
    '            covers:',
    "              - '3:core_portal.loadX'",
    "              - '4:other.loadX'",
    '          - code: UNDECLARED_COLOCATED_CALL',
    '            spec: runner_impl',
    '            at: "run"',
    '            covers:',
    '              - core_portal.loadX',
    `createdAt: '${NOW}'`,
    `updatedAt: '${NOW}'`,
  ];

  it('rewrites spec, at and covers for a component rename, keeping every comment, quote and untouched line', () => {
    const root = tempRoot();
    writeDoc(root, REGISTER);
    const before = fs.readFileSync(configFile(root), 'utf8');
    const rekeys = projectConfigRepositoryAt(root).rekeyCarried({
      specs: [{ from: 'core_portal', to: 'spec_tree_portal' }, { from: 'core_portal_impl', to: 'spec_tree_portal_impl' }],
      components: [{ from: 'core_portal', to: 'spec_tree_portal' }],
    });
    expect(rekeys).toEqual([
      { code: 'CALL_STEP_UNREALIZED', spec: 'core_portal_impl', at: 'loadX', field: 'spec', from: 'core_portal_impl', to: 'spec_tree_portal_impl' },
      { code: 'CALL_STEP_UNREALIZED', spec: 'core_portal_impl', at: 'loadX', field: 'covers', from: '3:core_portal.loadX', to: '3:spec_tree_portal.loadX' },
      { code: 'UNDECLARED_COLOCATED_CALL', spec: 'runner_impl', at: 'run', field: 'covers', from: 'core_portal.loadX', to: 'spec_tree_portal.loadX' },
    ]);
    const after = fs.readFileSync(configFile(root), 'utf8');
    // Only the three renamed ids moved — the prose naming core_portal did not.
    expect(changedLines(before, after)).toEqual([
      ['            spec: core_portal_impl  # the portal', '            spec: spec_tree_portal_impl  # the portal'],
      ["              - '3:core_portal.loadX'", "              - '3:spec_tree_portal.loadX'"],
      ['              - core_portal.loadX', '              - spec_tree_portal.loadX'],
    ]);
  });

  it('rewrites the site on the specs a renamed method moved on, and a unit naming it anywhere', () => {
    const root = tempRoot();
    writeDoc(root, REGISTER);
    const before = fs.readFileSync(configFile(root), 'utf8');
    projectConfigRepositoryAt(root).rekeyCarried({
      methods: [{ component: 'core_portal', method: 'loadX', toComponent: 'core_portal', toMethod: 'loadY', specs: ['core_portal_impl', 'icore_portal'] }],
    });
    expect(changedLines(before, fs.readFileSync(configFile(root), 'utf8'))).toEqual([
      ["            at: 'loadX'", "            at: 'loadY'"],
      ["              - '3:core_portal.loadX'", "              - '3:core_portal.loadY'"],
      ['              - core_portal.loadX', '              - core_portal.loadY'],
    ]);
  });

  it('re-homes only the moved methods\' entries on a method move', () => {
    const root = tempRoot();
    writeDoc(root, REGISTER);
    const rekeys = projectConfigRepositoryAt(root).rekeyCarried({
      specs: [{ from: 'core_portal_impl', to: 'loader_impl', sites: ['loadX'] }, { from: 'runner_impl', to: 'loader_impl', sites: ['elsewhere'] }],
      methods: [{ component: 'core_portal', method: 'loadX', toComponent: 'loader', toMethod: 'loadX' }],
    });
    expect(rekeys.map((r) => `${r.field}:${r.from}->${r.to}`)).toEqual([
      'spec:core_portal_impl->loader_impl',
      'covers:3:core_portal.loadX->3:loader.loadX',
      'covers:core_portal.loadX->loader.loadX',
    ]);
  });

  it('keeps CRLF line endings exactly', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    fs.writeFileSync(configFile(root), REGISTER.join('\r\n') + '\r\n');
    projectConfigRepositoryAt(root).rekeyCarried({ components: [{ from: 'core_portal', to: 'spec_tree_portal' }] });
    const bytes = fs.readFileSync(configFile(root));
    const crlf = bytes.toString('latin1').split('\r\n').length - 1;
    const lf = bytes.toString('latin1').split('\n').length - 1;
    expect(crlf).toBe(REGISTER.length);
    expect(lf).toBe(crlf);
    expect(bytes.toString('utf8')).toContain("- '3:spec_tree_portal.loadX'\r\n");
  });

  it('writes nothing on a dry run, yet answers the edits it would make', () => {
    const root = tempRoot();
    writeDoc(root, REGISTER);
    const { repo, writes } = counted(root);
    const rekeys = repo.rekeyCarried({ components: [{ from: 'core_portal', to: 'spec_tree_portal' }] }, true);
    expect(rekeys).toHaveLength(2);
    expect(writes()).toBe(0);
    expect(fs.readFileSync(configFile(root), 'utf8')).toContain("'3:core_portal.loadX'");
  });

  it('writes nothing, and answers nothing, when no entry names the moved identity', () => {
    const root = tempRoot();
    writeDoc(root, REGISTER);
    const { repo, writes } = counted(root);
    expect(repo.rekeyCarried({ components: [{ from: 'nobody', to: 'somebody' }] })).toEqual([]);
    expect(writes()).toBe(0);
  });

  it('refuses a layout it cannot edit precisely, naming the path, and writes nothing', () => {
    const root = tempRoot();
    writeDoc(root, [
      ...minimal().filter((l) => l !== 'rules: {}'),
      'rules:',
      '  conformance:',
      '    carried:',
      '      - kind: drift',
      '        why: w',
      "        findings: [{ code: CALL_STEP_UNREALIZED, spec: core_portal_impl, at: loadX, covers: ['1:core_portal.loadX'] }]",
    ]);
    const before = fs.readFileSync(configFile(root), 'utf8');
    expect(() => projectConfigRepositoryAt(root).rekeyCarried({ components: [{ from: 'core_portal', to: 'x' }] }))
      .toThrow(/Cannot rewrite \.wai\/project\.yaml .*rules\.conformance\.carried\.0\.findings\.0\.covers\.0: .*Nothing was written\./);
    expect(fs.readFileSync(configFile(root), 'utf8')).toBe(before);
  });

  it('rewrites this repository\'s own register and changes nothing but the renamed ids', () => {
    // The real register: dozens of groups, count comments, folded prose.
    const root = tempRoot();
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    const real = fs.readFileSync(path.resolve(process.cwd(), '.wai', 'project.yaml'));
    fs.writeFileSync(configFile(root), real);
    const text = real.toString('utf8');
    const target = /spec: (\w+_impl)\n\s+at: '(\w+)'\n\s+covers:\n\s+- '(\w+)\.\w+'/.exec(text.replace(/\r\n/g, '\n'));
    expect(target).not.toBeNull();
    const [, spec, , component] = target!;
    const rekeys = projectConfigRepositoryAt(root).rekeyCarried({
      specs: [{ from: spec, to: `${spec}_renamed` }],
      components: [{ from: component, to: `${component}_renamed` }],
    });
    expect(rekeys.length).toBeGreaterThan(0);
    const after = fs.readFileSync(configFile(root));
    // Same bytes everywhere but the rekeyed lines, CRLF kept where it was.
    const pairs = changedLines(text, after.toString('utf8'));
    for (const [was, now] of pairs) {
      expect(now.replace(`${spec}_renamed`, spec).replace(`${component}_renamed`, component)).toBe(was);
    }
    expect(pairs.length).toBe(rekeys.length);
    expect(after.toString('latin1').split('\r\n').length).toBe(real.toString('latin1').split('\r\n').length);
  });
});

// ---------------------------------------------------------------------------
// Stage 2a: every save through the registry backfills a defaulted project id,
// so the id a project was answering to stops moving with its display name.
// ---------------------------------------------------------------------------

describe('project config registry — id backfill', () => {
  it('writes the defaulted id on the next save', () => {
    const root = tempRoot();
    writeDoc(root, minimal().map((l) => (l === 'name: demo' ? 'name: Billing Platform' : l)));

    projectConfigRepositoryAt(root).setProjectType('frontend-reactive');

    expect(readDoc(root).id).toBe('billing-platform');
    expect(readDoc(root).name).toBe('Billing Platform');
  });

  it('never touches a declared id, even one that breaks the grammar', () => {
    const root = tempRoot();
    writeDoc(root, minimal('id: Billing_Platform'));

    projectConfigRepositoryAt(root).setProjectType('frontend-reactive');

    expect(readDoc(root).id).toBe('Billing_Platform');
  });

  it('writes no id for a name that yields none, rather than inventing one', () => {
    const root = tempRoot();
    writeDoc(root, minimal().map((l) => (l === 'name: demo' ? "name: '請求'" : l)));

    projectConfigRepositoryAt(root).setProjectType('frontend-reactive');

    expect(readDoc(root)).not.toHaveProperty('id');
  });

  it('create writes the effective id of a configuration given without one', () => {
    const root = tempRoot();
    const config = {
      schemaVersion: '1.0.0', name: 'Ledger Service', targets: [], rules: {}, createdAt: NOW, updatedAt: NOW,
    } as unknown as ProjectConfig;

    projectConfigRepositoryAt(root).create(config);

    expect(readDoc(root).id).toBe('ledger-service');
  });

  it('the comment-preserving rekey is not a save, and writes no id', () => {
    const root = tempRoot();
    writeDoc(root, minimal());

    projectConfigRepositoryAt(root).rekeyCarried({});

    expect(fs.readFileSync(configFile(root), 'utf8')).toContain(MARKER);
    expect(readDoc(root)).not.toHaveProperty('id');
  });
});
