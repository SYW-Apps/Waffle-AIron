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
  declaredPackNames,
  declaredProfileIds,
  type ProjectConfigFsAdapter,
  type ProjectConfigRepository,
} from '../../src/config/project-config.js';
import { GLOBAL_PACKS_DEFAULT } from '../../src/core/extensions.js';
import { ProjectNotInitializedError, WaironError } from '../../src/utils/errors.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import type { ProjectConfig } from '../../src/models/project.js';

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

    expect(Object.keys(readDoc(root))).toEqual([
      'name', 'futureTopLevel', 'schemaVersion', 'targets', 'rules', 'createdAt', 'updatedAt',
      'projectType', 'execution', 'paths',
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
