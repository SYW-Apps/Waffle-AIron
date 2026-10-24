/**
 * `wairon doctor --fix` moves a type group folder or a grouped type's file that
 * sits outside the folder its parent chain or group names (TYPE_GROUP_MISPLACED),
 * and nothing else: no spec is rewritten.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, saveSystemSpec, saveGroupSpec, saveTypeSpec } from '../../src/core/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { validateProject } from '../../src/core/validation.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import { runDoctor } from '../../src/commands/doctor.js';

const now = '2026-01-01T00:00:00.000Z';

describe('doctor --fix repairs type group placement', () => {
  const originalCwd = process.cwd();
  let rootDir = '';
  let packs = '';

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    packs = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-groups-packs-'));
    process.env.WAIRON_PACKS_DIR = packs;
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-doctor-groups-'));
    fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(rootDir, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', waironMajor: WAIRON_MAJOR, name: 'contracts', projectType: 'backend',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    setProjectRoot(rootDir);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'contracts', vision: 'Shared contracts', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as any);
    invalidateSpecCache();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    setProjectRoot(null);
    invalidateSpecCache();
    delete process.env.WAIRON_PACKS_DIR;
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
    try { fs.rmSync(packs, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  const misplaced = (): string[] => validateProject().issues.filter((i) => i.code === 'TYPE_GROUP_MISPLACED').map((i) => i.specId ?? '');

  it('moves a child group folder into its parent, and a type beside its group', async () => {
    saveGroupSpec({ kind: 'group', id: 'platform', name: 'platform', createdAt: now, updatedAt: now } as any);
    saveGroupSpec({ kind: 'group', id: 'runtime', name: 'runtime', parent: 'platform', createdAt: now, updatedAt: now } as any);
    saveTypeSpec({ kind: 'value-object', id: 'heap', name: 'heap', description: 'd', group: 'runtime', fields: [], methods: [], createdAt: now, updatedAt: now } as any);
    const types = path.join(rootDir, '.wai', 'specs', 'types');
    // A reorganization by hand: the child folder lifted to the top, the type left behind at the top.
    fs.renameSync(path.join(types, 'platform', 'runtime'), path.join(types, 'runtime'));
    fs.renameSync(path.join(types, 'runtime', 'heap.yaml'), path.join(types, 'heap.yaml'));
    invalidateSpecCache();
    expect(misplaced().sort()).toEqual(['heap', 'runtime']);
    const before = fs.readFileSync(path.join(types, 'heap.yaml'), 'utf8');

    process.chdir(rootDir);
    setProjectRoot(rootDir);
    invalidateSpecCache();
    await runDoctor({ fix: true, yes: true });

    expect(fs.existsSync(path.join(types, 'platform', 'runtime', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(types, 'platform', 'runtime', 'heap.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(types, 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(types, 'heap.yaml'))).toBe(false);
    // Only locations moved: the document is byte-identical.
    expect(fs.readFileSync(path.join(types, 'platform', 'runtime', 'heap.yaml'), 'utf8')).toBe(before);
    invalidateSpecCache();
    expect(misplaced()).toEqual([]);
    expect((console.log as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/Moved 2 type group file\(s\)/);
  });

  it('leaves a group with an unknown parent where it is', async () => {
    saveGroupSpec({ kind: 'group', id: 'orphan', name: 'orphan', createdAt: now, updatedAt: now } as any);
    const file = path.join(rootDir, '.wai', 'specs', 'types', 'orphan', '.index.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + 'parent: ghost\n');
    process.chdir(rootDir);
    setProjectRoot(rootDir);
    invalidateSpecCache();
    await runDoctor({ fix: true, yes: true });
    expect(fs.existsSync(file)).toBe(true);
  });
});
