import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot, runWithProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, loadSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import {
  provisionProject,
  ensureProjectInitialized,
  backfillChainedSubprojectConfigs,
  createChainedSubsystem,
  externalizeSubsystem,
} from '../../src/core/provision.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { isProjectInitialized, aiPathsAt } from '../../src/config/loader.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Provisioning and the loader wrappers, now writing project.yaml only through
// the project config Repository (stage 2a-0). Creation completes what is
// missing and never overwrites a configuration a project already has.
// ---------------------------------------------------------------------------

const NOW = '2026-09-13T10:00:00.000Z';
const MARKER = '# untouched-marker';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-prov-'));
  roots.push(dir);
  return dir;
}

/** Leave a valid project.yaml carrying a comment any rewrite would drop. */
function writeConfig(dir: string, name: string, ...extra: string[]): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), [
    MARKER,
    'schemaVersion: 1.0.0',
    `name: ${name}`,
    'targets: []',
    'rules: {}',
    `createdAt: '${NOW}'`,
    `updatedAt: '${NOW}'`,
    ...extra,
  ].join('\n') + '\n');
}

function untouched(dir: string): boolean {
  return fs.readFileSync(path.join(dir, '.wai', 'project.yaml'), 'utf8').includes(MARKER);
}

function saveL0(name: string): void {
  saveSystemSpec({ schemaVersion: '1.0.0', name, vision: 'v', boundaries: [], globalRequirements: [], createdAt: NOW, updatedAt: NOW });
}

function subsystem(id: string, name: string, projectPath?: string): SubsystemSpec {
  return {
    id,
    name,
    description: `subsystem ${id}`,
    parentSystem: 'root-system',
    publicInterfaces: [],
    projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('provisioning through the project config Repository', () => {
  it('provisionProject writes the L0 and a default configuration', () => {
    const root = tempRoot();
    setProjectRoot(root);

    provisionProject('demo');

    expect(projectConfigRepositoryAt(root).load()?.name).toBe('demo');
    expect(fs.existsSync(path.join(root, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('provisionProject refuses a root that already has a configuration', () => {
    const root = tempRoot();
    writeConfig(root, 'existing');
    setProjectRoot(root);

    expect(() => provisionProject('other')).toThrow(/already exists/);
    expect(untouched(root)).toBe(true);
  });

  it('provisionProject refusing a configured root leaves its project.yaml and L0 byte-identical', () => {
    const root = tempRoot();
    writeConfig(root, 'existing');
    setProjectRoot(root);
    saveL0('existing-tree');
    const configFile = path.join(root, '.wai', 'project.yaml');
    const l0File = path.join(root, '.wai', 'specs', '.index.yaml');
    const configBefore = fs.readFileSync(configFile);
    const l0Before = fs.readFileSync(l0File);

    expect(() => provisionProject('other')).toThrow(/already exists/);

    expect(fs.readFileSync(configFile).equals(configBefore)).toBe(true);
    expect(fs.readFileSync(l0File).equals(l0Before)).toBe(true);
  });

  it('ensureProjectInitialized keeps an existing configuration and completes the L0', () => {
    const root = tempRoot();
    writeConfig(root, 'existing');
    setProjectRoot(root);

    expect(ensureProjectInitialized('fallback')).toEqual({ wroteConfig: false, wroteSystem: true });
    expect(untouched(root)).toBe(true);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('ensureProjectInitialized names a created configuration after the existing L0', () => {
    const root = tempRoot();
    setProjectRoot(root);
    saveL0('tree-name');

    expect(ensureProjectInitialized('fallback')).toEqual({ wroteConfig: true, wroteSystem: false });
    expect(projectConfigRepositoryAt(root).load()?.name).toBe('tree-name');
  });

  it('backfill creates a missing child configuration and leaves an existing one alone', () => {
    const root = tempRoot();
    setProjectRoot(root);
    saveL0('root-system');
    saveSubsystemSpec(subsystem('alpha', 'alpha', 'packages/alpha'));
    saveSubsystemSpec(subsystem('beta', 'beta', 'packages/beta'));
    const alpha = path.join(root, 'packages', 'alpha');
    const beta = path.join(root, 'packages', 'beta');
    fs.mkdirSync(path.join(alpha, '.wai', 'specs'), { recursive: true });
    fs.mkdirSync(path.join(beta, '.wai', 'specs'), { recursive: true });
    writeConfig(beta, 'beta-own');

    const backfilled = backfillChainedSubprojectConfigs(root);

    expect(backfilled.map((dir) => path.basename(dir))).toEqual(['alpha']);
    expect(projectConfigRepositoryAt(alpha).load()?.name).toBe('alpha');
    expect(untouched(beta)).toBe(true);
  });

  it('createChainedSubsystem keeps an existing child configuration', () => {
    const root = tempRoot();
    setProjectRoot(root);
    saveL0('root-system');
    const child = path.join(root, 'packages', 'billing');
    writeConfig(child, 'billing-own');

    createChainedSubsystem(subsystem('billing', 'billing', 'packages/billing'), 'billing');

    expect(untouched(child)).toBe(true);
    expect(fs.existsSync(path.join(child, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('externalizeSubsystem creates the child configuration named after the subsystem', () => {
    const root = tempRoot();
    setProjectRoot(root);
    saveL0('root-system');
    saveSubsystemSpec(subsystem('core', 'Core Service'));

    externalizeSubsystem('core', 'packages/core');

    const child = path.join(root, 'packages', 'core');
    expect(projectConfigRepositoryAt(child).load()?.name).toBe('Core Service');
    expect(fs.existsSync(path.join(child, '.wai', 'specs', '.index.yaml'))).toBe(true);
  });

  it('externalizeSubsystem refuses a child that already has a configuration, before moving anything', () => {
    const root = tempRoot();
    setProjectRoot(root);
    saveL0('root-system');
    saveSubsystemSpec(subsystem('core', 'Core Service'));
    const child = path.join(root, 'packages', 'core');
    writeConfig(child, 'core-own');

    expect(() => externalizeSubsystem('core', 'packages/core')).toThrow(/already exists/);

    invalidateSpecCache();
    expect(loadSubsystemSpec('core')?.projectPath).toBeUndefined();
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'core'))).toBe(true);
    expect(untouched(child)).toBe(true);
    expect(fs.existsSync(path.join(child, '.wai', 'specs'))).toBe(false);
  });
});

describe('loader wrappers over the project config Repository', () => {
  it('loader isProjectInitialized reflects whether the project has a configuration', () => {
    const root = tempRoot();
    runWithProjectRoot(root, () => {
      expect(isProjectInitialized()).toBe(false);
    });
    writeConfig(root, 'demo');
    runWithProjectRoot(root, () => {
      expect(isProjectInitialized()).toBe(true);
    });
  });

  it('loader aiPathsAt resolves specsDir through the configuration of that root', () => {
    const root = tempRoot();
    writeConfig(root, 'demo', 'paths:', '  specsDir: design/specs');

    expect(aiPathsAt(root).specsDir()).toBe(path.resolve(root, 'design/specs'));
    expect(aiPathsAt(root).specsSystem()).toBe(path.join(path.resolve(root, 'design/specs'), '.index.yaml'));
  });
});
