import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findProjectRoot, setProjectRoot, getProjectRoot, fromProjectRoot } from '../../src/utils/fs.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('findProjectRoot', () => {
  it('finds the nearest ancestor containing .wai/', () => {
    const root = tmpDir('wairon-root-');
    fs.mkdirSync(path.join(root, '.wai'));
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findProjectRoot(nested)).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null when no project marker is found', () => {
    const root = tmpDir('wairon-noroot-');
    expect(findProjectRoot(root)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('project root override', () => {
  // Restore the default (cwd) after each test so other suites are unaffected.
  afterEach(() => setProjectRoot(process.cwd()));

  it('setProjectRoot redirects fromProjectRoot away from cwd', () => {
    const dir = tmpDir('wairon-override-');
    setProjectRoot(dir);
    expect(getProjectRoot()).toBe(path.resolve(dir));
    expect(fromProjectRoot('.wai', 'system.yaml')).toBe(path.join(path.resolve(dir), '.wai', 'system.yaml'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
