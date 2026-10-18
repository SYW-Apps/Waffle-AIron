import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { ProjectConfigSchema } from '../../src/models/project.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import { read } from '../../src/upgrade/adapters/stamp.js';

// project_config_registry.create sets waironMajor to the running major when the
// configuration names none, and keeps one it names.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function created(over: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-cfg-stamp-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  projectConfigRepositoryAt(root).create(ProjectConfigSchema.parse({ name: 'p', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over }));
  return root;
}

describe('project config waironMajor', () => {
  it('create stamps the running major', () => {
    expect(read(created({}))).toBe(WAIRON_MAJOR);
  });
  it('create keeps a major the configuration names', () => {
    expect(read(created({ waironMajor: 5 }))).toBe(5);
  });
});
