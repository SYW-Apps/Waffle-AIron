import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// To avoid TDZ (Temporal Dead Zone) ReferenceError with hoisted vi.mock,
// we store the mocks and actuals on globalThis.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  (globalThis as any).__actualExistsSync = actual.existsSync;
  return {
    ...actual,
    existsSync: (p: string) => {
      const mock = (globalThis as any).__mockExistsSync;
      if (mock) {
        return mock(p);
      }
      return actual.existsSync(p);
    }
  };
});


import { findProjectRoot, findSystemRoot, setProjectRoot, getProjectRoot, fromProjectRoot } from '../../src/utils/fs.js';

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
    (globalThis as any).__mockExistsSync = (p: string) => {
      const pStr = String(p);
      if (pStr.endsWith('.wai') || pStr.endsWith('.wairon') || pStr.includes(path.sep + '.wai') || pStr.includes(path.sep + '.wairon')) {
        return false;
      }
      return (globalThis as any).__actualExistsSync(pStr);
    };

    try {
      expect(findProjectRoot(root)).toBeNull();
    } finally {
      (globalThis as any).__mockExistsSync = null;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findSystemRoot', () => {
  it('finds the nearest ancestor containing system.yaml', () => {
    const root = tmpDir('wairon-system-');
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'system.yaml'), 'content');
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findSystemRoot(nested)).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns null if no system.yaml is found', () => {
    const root = tmpDir('wairon-subsystem-');
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(root, '.wai', 'specs', 'subsystem.yaml'), 'content');
    const nested = path.join(root, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    expect(findSystemRoot(nested)).toBeNull();
    fs.rmSync(root, { recursive: true, force: true });
  });
});


describe('project root override', () => {
  // Clear the override after each test so other suites (which chdir into temp
  // projects and rely on cwd-based resolution) are unaffected.
  afterEach(() => setProjectRoot(null));

  it('setProjectRoot redirects fromProjectRoot away from cwd', () => {
    const dir = tmpDir('wairon-override-');
    setProjectRoot(dir);
    expect(getProjectRoot()).toBe(path.resolve(dir));
    expect(fromProjectRoot('.wai', 'system.yaml')).toBe(path.join(path.resolve(dir), '.wai', 'system.yaml'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
