import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectDomainCandidates } from '../../src/core/detection.js';

// Creates a temporary directory structure for testing detection logic

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'waffagent-test-'));
}

function rmTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe('detectDomainCandidates', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    rmTempDir(tmpDir);
  });

  it('returns empty array for a plain project with no submodules', () => {
    const candidates = detectDomainCandidates(tmpDir);
    expect(candidates).toHaveLength(0);
  });

  it('detects a nested git repo', () => {
    const subDir = path.join(tmpDir, 'services', 'core-service');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(path.join(subDir, '.git'));

    const candidates = detectDomainCandidates(tmpDir);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].path).toBe('services/core-service');
    expect(candidates[0].type).toBe('git-repo');
    expect(candidates[0].suggestedId).toBe('core-service');
  });

  it('detects a package root via package.json', () => {
    const pkgDir = path.join(tmpDir, 'packages', 'my-utils');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"my-utils"}');

    const candidates = detectDomainCandidates(tmpDir);
    expect(candidates.some((c) => c.suggestedId === 'my-utils')).toBe(true);
    expect(candidates.find((c) => c.suggestedId === 'my-utils')?.type).toBe('package-root');
  });

  it('parses .gitmodules for submodule entries', () => {
    const gitmodules = `[submodule "services/blueprints"]
\tpath = services/blueprints
\turl = https://github.com/org/blueprints.git
`;
    fs.writeFileSync(path.join(tmpDir, '.gitmodules'), gitmodules);
    fs.mkdirSync(path.join(tmpDir, 'services', 'blueprints'), { recursive: true });

    const candidates = detectDomainCandidates(tmpDir);
    expect(candidates.some((c) => c.path === 'services/blueprints')).toBe(true);
    expect(candidates.find((c) => c.path === 'services/blueprints')?.type).toBe('git-submodule');
  });

  it('marks already-tracked paths correctly', () => {
    const subDir = path.join(tmpDir, 'services', 'core');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(path.join(subDir, '.git'));

    const tracked = new Set(['services/core']);
    const candidates = detectDomainCandidates(tmpDir, tracked);
    expect(candidates[0].alreadyTracked).toBe(true);
  });

  it('skips node_modules and dist directories', () => {
    const excluded = ['node_modules', 'dist'];
    for (const dir of excluded) {
      const subDir = path.join(tmpDir, dir, 'some-package');
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, 'package.json'), '{}');
    }

    const candidates = detectDomainCandidates(tmpDir);
    expect(candidates).toHaveLength(0);
  });
});
