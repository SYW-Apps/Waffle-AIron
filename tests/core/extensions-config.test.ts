import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { diagnoseProjectPacks } from '../../src/core/extensions.js';

// ---------------------------------------------------------------------------
// `wairon doctor` asks whether a project ever decided about machine-wide packs.
// The schema defaults `extensions.useGlobalPacks` to false, so the parsed
// configuration cannot tell "left unset" from "chose false". The diagnosis asks
// the project config Repository whether the document itself sets the field.
// ---------------------------------------------------------------------------

const NOW = '2026-09-13T10:00:00.000Z';
const dirs: string[] = [];

afterEach(() => {
  delete process.env.WAIRON_PACKS_DIR;
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A project whose document carries these extension lines, with an empty pack store. */
function project(...extensions: string[]): string {
  process.env.WAIRON_PACKS_DIR = tempDir('wairon-extcfg-store-');
  const root = tempDir('wairon-extcfg-');
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), [
    'schemaVersion: 1.0.0',
    'name: demo',
    'targets: []',
    'rules: {}',
    `createdAt: '${NOW}'`,
    `updatedAt: '${NOW}'`,
    ...extensions,
  ].join('\n') + '\n');
  return root;
}

describe('doctor diagnosis of global packs', () => {
  it('counts an extensions block without useGlobalPacks as undeclared', () => {
    const root = project('extensions:', '  packs: []');
    expect(runWithProjectRoot(root, () => diagnoseProjectPacks().globalsUndeclared)).toBe(true);
  });

  it('counts an explicit useGlobalPacks: false as declared', () => {
    const root = project('extensions:', '  useGlobalPacks: false', '  packs: []');
    expect(runWithProjectRoot(root, () => diagnoseProjectPacks().globalsUndeclared)).toBe(false);
  });
});
