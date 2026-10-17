import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot } from '../src/utils/fs.js';
import { ProjectNotInitializedError } from '../src/utils/errors.js';
import * as publicEntry from '../src/index.js';

// ---------------------------------------------------------------------------
// The public library entry (src/index.ts, the package's `main`). Stage 2a-0
// kept its `loadProjectConfig` contract throwing `ProjectNotInitializedError`
// on an absent configuration — unlike the core surface's null-returning
// version it wraps — and dropped `saveProjectConfig` entirely.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-public-entry-'));
  roots.push(dir);
  return dir;
}

function writeConfig(dir: string, name: string): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), [
    'schemaVersion: 1.0.0',
    `name: ${name}`,
    'targets: []',
    'rules: {}',
    "createdAt: '2026-09-13T10:00:00.000Z'",
    "updatedAt: '2026-09-13T10:00:00.000Z'",
  ].join('\n') + '\n');
}

describe('public library entry loadProjectConfig', () => {
  it('throws ProjectNotInitializedError in a folder without .wai/project.yaml', () => {
    const root = tempRoot();
    runWithProjectRoot(root, () => {
      expect(() => publicEntry.loadProjectConfig()).toThrow(ProjectNotInitializedError);
    });
  });

  it('returns the parsed configuration otherwise', () => {
    const root = tempRoot();
    writeConfig(root, 'demo');
    runWithProjectRoot(root, () => {
      expect(publicEntry.loadProjectConfig().name).toBe('demo');
    });
  });

  it('does not export saveProjectConfig', () => {
    expect((publicEntry as Record<string, unknown>).saveProjectConfig).toBeUndefined();
  });
});
