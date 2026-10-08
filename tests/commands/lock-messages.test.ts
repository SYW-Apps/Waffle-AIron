import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { diffAgainstApproval, diffSize } from '../../src/core/approval.js';
import { runLock } from '../../src/commands/lock.js';
import { computeGateStateId } from '../../src/core/validation.js';
import { logger } from '../../src/utils/logger.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round-3 trial findings: approval messaging must never contradict itself.
//   - `lock` said "Nothing has changed" while it cleared PROJECT_ID_RENAMED or
//     after an input (a declared external, a network) moved — say what did.
//   - `lock` approved an all-draft tree without a word — it may, but plainly.
//   - after a storage move `lock-check` read the approval as holding while
//     `lock` listed every moved spec as added — a move is no change.
//   - a long re-lock list is summarized, `--all` lists every one.
// ---------------------------------------------------------------------------

vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

const now = '2026-10-07T10:00:00.000Z';
let rootDir: string;

function project(status: 'draft' | 'complete'): void {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lock-msg-'));
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', id: 'lockable', name: 'lockable-system', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(rootDir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'lockable-system', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'core-sub', name: 'core-sub', description: 'd', parentSystem: 'lockable-system', publicInterfaces: [], trustedLinks: [],
    status, createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  addComponent('worker', status);
  invalidateSpecCache();
  setProjectRoot(rootDir);
}

function addComponent(id: string, status: 'draft' | 'complete' = 'complete'): void {
  saveComponentSpec({
    id, name: id, description: 'component under test', subsystem: 'core-sub', componentType: 'Orchestrator',
    owns: [], dependsOn: [], status, createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: `i${id}`, name: `i${id}`, description: 'contract', component: id, status, createdAt: now, updatedAt: now,
    methods: [{ name: 'work', description: 'Does the work.', signature: 'work(): void', returns: 'void', params: [] }],
  });
}

function capture(): { lines: string[] } {
  const lines: string[] = [];
  for (const level of ['info', 'warn', 'success'] as const) {
    vi.spyOn(logger, level).mockImplementation((m: string) => { lines.push(m); });
  }
  return { lines };
}

async function lock(options: { all?: boolean } = {}): Promise<void> {
  invalidateSpecCache();
  await runLock({ yes: true, ...options }, { valid: true, issues: [] }, computeGateStateId());
  invalidateSpecCache();
}

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('lock says what changed when no spec did', () => {
  it('a project id rename is named, never "Nothing has changed"', async () => {
    project('complete');
    await lock();
    const config = JSON.parse(fs.readFileSync(path.join(rootDir, '.wai', 'project.yaml'), 'utf8'));
    fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({ ...config, id: 'lockable-renamed' }));
    const out = capture();
    await lock();
    const text = out.lines.join('\n');
    expect(text).not.toMatch(/Nothing has changed/);
    expect(text).toMatch(/No spec changed since the last approval, but what the design is approved under did: the project id \(lockable → lockable-renamed\)/);
  });

  it('a moved input (a network declaration) is named', async () => {
    project('complete');
    await lock();
    const config = JSON.parse(fs.readFileSync(path.join(rootDir, '.wai', 'project.yaml'), 'utf8'));
    fs.writeFileSync(path.join(rootDir, '.wai', 'project.yaml'), JSON.stringify({ ...config, network: true }));
    const out = capture();
    await lock();
    const text = out.lines.join('\n');
    expect(text).not.toMatch(/Nothing has changed/);
    // Round 6: the record names each input, so the one that moved is named.
    expect(text).toMatch(/the network declaration/);
    expect(text).not.toMatch(/an input the gate identity covers/);
  });

  it('a true no-op still says nothing has changed', async () => {
    project('complete');
    await lock();
    const out = capture();
    await lock();
    expect(out.lines.join('\n')).toMatch(/Nothing has changed since the last approval/);
  });
});

describe('lock on an all-draft tree says so', () => {
  it('warns that it approves a draft design, and approves it', async () => {
    project('draft');
    const out = capture();
    await lock();
    expect(out.lines.join('\n')).toMatch(/3 of 3 spec\(s\) are still draft or design \(1 subsystem, 1 component, 1 contract\): this approves the design as it stands/);
    expect(fs.existsSync(path.join(rootDir, '.wai', 'lock.json'))).toBe(true);
  });

  it('is silent about drafts once every spec is complete', async () => {
    project('complete');
    const out = capture();
    await lock();
    expect(out.lines.join('\n')).not.toMatch(/still draft or design/);
  });

  it('counts every draft spec kind, not just components (tinkerer-r5: every L3/L4 draft was approved silently)', async () => {
    project('complete');
    // The contract is hand-set back to draft; the component stays complete.
    const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    const file = walk(path.join(rootDir, '.wai', 'specs')).find((f) => /id: iworker/.test(fs.readFileSync(f, 'utf8')))!;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/status: complete/, 'status: draft'));
    const out = capture();
    await lock();
    expect(out.lines.join('\n')).toMatch(/1 of 3 spec\(s\) are still draft or design \(1 contract\)/);
  });
});

describe('a re-run with nothing changed keeps the approval on record (tinkerer-r5: lockedAt rewritten)', () => {
  it('leaves .wai/lock.json byte for byte, its lockedAt included', async () => {
    project('complete');
    await lock();
    const lockPath = path.join(rootDir, '.wai', 'lock.json');
    const first = fs.readFileSync(lockPath, 'utf8');
    await new Promise((r) => setTimeout(r, 15));
    await lock();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(first);
  });

  it('writes a new record when something it records moved', async () => {
    project('complete');
    await lock();
    const lockPath = path.join(rootDir, '.wai', 'lock.json');
    const first = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { lockedAt: string };
    addComponent('second');
    await new Promise((r) => setTimeout(r, 15));
    await lock();
    const second = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { lockedAt: string };
    expect(second.lockedAt).not.toBe(first.lockedAt);
  });
});

describe('a storage move is no change', () => {
  it('an approved path whose content now lives elsewhere is a move, not an addition and a removal', async () => {
    project('complete');
    await lock();
    // The approval names the spec under the path it had before its storage moved.
    const lockPath = path.join(rootDir, '.wai', 'lock.json');
    const record = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const key = Object.keys(record.specs).find((k: string) => k.includes('worker') && !k.includes('iworker'))!;
    record.specs[`members/old-home/${key}`] = record.specs[key];
    delete record.specs[key];
    fs.writeFileSync(lockPath, JSON.stringify(record));
    invalidateSpecCache();
    const diff = diffAgainstApproval()!;
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.moved).toEqual([`members/old-home/${key} -> ${key}`]);
    expect(diff.unchangedPaths).toContain(key);
    expect(diffSize(diff)).toBe(0);
  });
});

describe('a long re-lock list is summarized', () => {
  for (const all of [false, true]) {
    it(all ? '--all lists every one' : 'lists the first few and counts the rest', async () => {
      project('complete');
      await lock();
      // Ten components, each with its contract: twenty added specs.
      for (let i = 0; i < 10; i++) addComponent(`extra${i}`);
      const out = capture();
      await lock({ all });
      const text = out.lines.join('\n');
      expect(text).toMatch(/20 spec\(s\) changed since the last approval/);
      if (all) {
        expect(text).not.toMatch(/… and \d+ more/);
        expect(text.match(/^ {2}\+ /gm)).toHaveLength(20);
      } else {
        expect(text).toMatch(/\+ … and 12 more/);
        expect(text).toMatch(/wairon lock --all/);
      }
    });
  }
});
