import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateProject, validateAsComplete, validateProjectAsync, validateAsCompleteAsync, stopBackground } from '../../src/core/validation.js';
import * as runner from '../../src/core/validation-runner.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec } from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';
import type { LoadedExtensions } from '../../src/core/extensions.js';

// The validation thread and runner against a real worker thread. Result files
// go to a throwaway cache folder, never the user's.
process.env.WAIRON_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-runner-cache-'));

const now = '2026-11-07T10:00:00Z';

function makeProject(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'runner-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  runWithProjectRoot(root, () => {
    saveSystemSpec({
      schemaVersion: '1.0.0', name: 'runner-sys', vision: 'a runner fixture',
      boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
    });
    saveSpec('subsystem', {
      id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'runner-sys',
      publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    saveComponentSpec({
      id: 'worker', name: 'Worker', description: 'a worker component', subsystem: 'dom',
      componentType: 'Orchestrator', dependsOn: ['ghostaaa'], owns: [], status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
  });
  invalidateSpecCache();
}

describe('validation runner', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-runner-'));
    makeProject(root);
  });
  afterEach(async () => {
    await stopBackground();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('answers the same result as the synchronous gates', async () => {
    await runWithProjectRoot(root, async () => {
      const owner = await validateProjectAsync();
      const complete = await validateAsCompleteAsync();
      expect(owner.issues).toEqual(validateProject().issues);
      expect(complete.issues).toEqual(validateAsComplete().issues);
      expect(owner.issues.some((i) => i.message.includes('ghostaaa'))).toBe(true);
    });
  }, 120000);

  it('shares one job among identical concurrent runs', async () => {
    await runWithProjectRoot(root, async () => {
      const a = runner.run('owner');
      const b = runner.run('owner');
      expect(b).toBe(a);
      const other = runner.run('as_complete');
      expect(other).not.toBe(a);
      await Promise.all([a, b, other]);
      // The key is released once the run settles.
      const next = runner.run('owner');
      expect(next).not.toBe(a);
      await next;
    });
  }, 120000);

  it('refuses options carrying loaded extensions', async () => {
    await runWithProjectRoot(root, async () => {
      await expect(runner.run('owner', { extensions: {} as LoadedExtensions })).rejects.toThrow(/loaded extensions/);
    });
  });

  it('replaces a thread that exited on the next run', async () => {
    await runWithProjectRoot(root, async () => {
      await runner.run('owner');
      const pending = expect(runner.run('as_complete')).rejects.toThrow();
      await runner.stop();
      await pending;
      const again = await runner.run('owner');
      expect(again.issues.length).toBeGreaterThan(0);
    });
  }, 120000);

  it('stops without a running thread', async () => {
    await expect(stopBackground()).resolves.toBeUndefined();
  });
});
