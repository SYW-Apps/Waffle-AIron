import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSubsystemSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { ProjectNotInitializedError } from '../../src/utils/errors.js';
import { resolveAgentTopology } from '../../src/commands/adapters/core.js';
import { runList } from '../../src/commands/list.js';
import { runShow } from '../../src/commands/show.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// `wairon list` / `wairon show` — both read the live agent topology through
// cli_core_adapter.resolveAgentTopology (runList / runShow step 1). The adapter
// is wrapped in a spy that still forwards to the core portal, so each test sees
// the real resolved topology AND whether the command reached it through the
// adapter.
// ---------------------------------------------------------------------------

vi.mock('../../src/commands/adapters/core.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/commands/adapters/core.js')>();
  return { ...actual, resolveAgentTopology: vi.fn(actual.resolveAgentTopology) };
});

const now = new Date().toISOString();

const subsystem = (id: string): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'list-system',
  publicInterfaces: [], trustedLinks: [], status: 'draft', createdAt: now, updatedAt: now,
});

function writeConfig(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0',
    name: 'list-system',
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {},
    createdAt: now,
    updatedAt: now,
  }));
}

/** A configured project with an L0 and two subsystems, bound as the project root. */
function buildTwoDomainProject(rootDir: string): void {
  writeConfig(rootDir);
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'list-system',
    vision: 'a list fixture system',
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
  saveSubsystemSpec(subsystem('dom-a'));
  saveSubsystemSpec(subsystem('dom-b'));
  invalidateSpecCache();
}

describe('cli_runner.runList / runShow: the topology through cli_core_adapter.resolveAgentTopology', () => {
  let rootDir: string;
  let printed: string[];

  const capture = () => {
    printed = [];
    const sink = (...args: unknown[]) => { printed.push(args.map(String).join(' ')); };
    vi.spyOn(console, 'log').mockImplementation(sink);
    vi.spyOn(console, 'warn').mockImplementation(sink);
  };
  const output = () => printed.join('\n');

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(resolveAgentTopology).mockClear();
    setProjectRoot(null);
    invalidateSpecCache();
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win file locks */ }
  });

  it('runList lists every resolved agent', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-list-'));
    buildTwoDomainProject(rootDir);
    capture();

    await runList();

    expect(vi.mocked(resolveAgentTopology)).toHaveBeenCalled();
    expect(output()).toContain('Agents (3)');
    expect(output()).toContain('system-architect');
    expect(output()).toContain('dom-a-owner');
    expect(output()).toContain('dom-b-owner');
  });

  it('runList lists nothing for a project without a system spec', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-list-empty-'));
    writeConfig(rootDir);
    setProjectRoot(rootDir);
    capture();

    await runList();

    expect(output()).toContain('No agents resolved from the spec tree.');
    expect(output()).not.toContain('Agents (');
  });

  it('runShow shows a resolved agent', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-show-'));
    buildTwoDomainProject(rootDir);
    capture();

    await runShow('dom-a-owner');

    expect(vi.mocked(resolveAgentTopology)).toHaveBeenCalled();
    expect(output()).toMatch(/ID\S*\s+dom-a-owner/);
  });

  it('runShow finds no agent in a project without a system spec', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-show-empty-'));
    writeConfig(rootDir);
    setProjectRoot(rootDir);
    capture();

    await expect(runShow('system-architect')).rejects.toThrow(/not found in the resolved spec topology/);
  });

  it('both refuse an uninitialized project before resolving anything', async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-list-uninit-'));
    setProjectRoot(rootDir);
    capture();

    await expect(runList()).rejects.toBeInstanceOf(ProjectNotInitializedError);
    await expect(runShow('system-architect')).rejects.toBeInstanceOf(ProjectNotInitializedError);
    expect(vi.mocked(resolveAgentTopology)).not.toHaveBeenCalled();
  });
});
