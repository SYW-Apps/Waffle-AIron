import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import { firstDuplicateKey, readLockRecord, readLockRecordAt, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { computeGateStateId, familyApprovals, validateAsComplete } from '../../src/core/validation.js';
import { approvalVerdict } from '../../src/core/approval.js';
import { getStatusReport } from '../../src/core/status.js';
import { checkApproval, runLock, treeVerdict, type LockOptions } from '../../src/commands/lock.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { designOnly, missingTreeSentence, releaseStampProblem } from '../../src/models/lock.js';
import { WAIRON_VERSION } from '../../src/config/defaults.js';
import { LockRecordUnreadableError } from '../../src/utils/errors.js';
import { logger } from '../../src/utils/logger.js';
import { buildApprovalFamily, type ApprovalFamily } from '../helpers/reference-family.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// Round 8 (approval and lock). Decided behaviour:
//  1. a release stamp that is missing, no version, or newer than this wairon
//     is reported at every surface even when the identity matches, and
//     `lock` replaces it; a record without gate parts whose identity matches
//     gets the same notice `{}` got; duplicate JSON keys make a record
//     unreadable;
//  2. a lock that records specs while the tree is gone fails closed; a
//     missing project.yaml is named;
//  3. a member whose record predates gate parts is named for that, never for
//     "spec changes nobody approved"; `lock` warns that members lock first;
//  4. `lock --subsystem <member>::<sub>` at a parent is refused;
//  5. a selected pack that cannot load leaves the approval owed;
//  7. the verdict lists every moved spec up to forty;
//  8. the inputs a lock records for the first time are printed.
// ---------------------------------------------------------------------------

const promptMock = vi.hoisted(() => vi.fn());
vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

const now = '2026-10-09T10:00:00.000Z';
let root = '';
let fam: ApprovalFamily | null = null;

function project(rules: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-release-r8-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'release-sys', projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'release-sys', vision: 'release fixture', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', {
    id: 'dom', name: 'dom', description: 'the domain', parentSystem: 'release-sys',
    publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker', subsystem: 'dom', componentType: 'Orchestrator',
    owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  saveInterfaceSpec({
    id: 'iworker', name: 'IWorker', description: 'the worker contract', component: 'worker',
    methods: [{
      name: 'run', description: 'Runs the work once.', signature: 'run(): void', returns: 'void', params: [],
      invokedBy: { kind: 'runtime', caller: 'The process scheduler of the host, once every minute after boot' },
    }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as InterfaceSpec);
  saveSpec('implementation', {
    id: 'worker_impl', name: 'Worker Implementation', description: 'realizes the worker', contract: 'iworker',
    methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'Do the work', type: 'local' }] }],
    status: 'complete', createdAt: now, updatedAt: now,
  } as unknown as ImplementationSpec);
  invalidateSpecCache();
  return dir;
}

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function quiet(): void {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
}

async function lockAt(dir: string, options: LockOptions = { yes: true }): Promise<LockRecord | null> {
  bind(dir);
  const captured = computeGateStateId();
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  expect(designOnly(gate).issues.filter((i) => i.severity === 'error')).toEqual([]);
  return runLock(options, gate, captured);
}

/** Rewrite the record on file through a raw JSON edit (what a hand edit or a bad merge leaves). */
function editRecord(dir: string, edit: (r: Record<string, unknown>) => void): void {
  const file = path.join(dir, '.wai', 'lock.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  edit(json);
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  invalidateSpecCache();
}

const infoLines = (): string[] => (logger.info as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);
const warnLines = (): string[] => (logger.warn as unknown as { mock: { calls: string[][] } }).mock.calls.map((c) => c[0]);

afterEach(() => {
  vi.restoreAllMocks();
  promptMock.mockReset();
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows locks */ }
  try { fam?.cleanup(); } catch { /* windows locks */ }
  root = '';
  fam = null;
});

describe('1 — stamps and parts never pass silently (round 8)', () => {
  it('lock_record.stampProblem names a missing, invalid or newer stamp, and nothing else', () => {
    expect(releaseStampProblem({ validatorVersion: 'banana' }, '5.1.1-dev.112')).toContain('"banana" is no wairon version');
    expect(releaseStampProblem({ validatorVersion: '9.9.9' }, '5.1.1-dev.112')).toContain('newer release than this one');
    expect(releaseStampProblem({}, '5.1.1-dev.112')).toContain('carries no release stamp');
    expect(releaseStampProblem({ validatorVersion: '5.1.1-dev.111' }, '5.1.1-dev.112')).toBeNull();
    expect(releaseStampProblem({ validatorVersion: '5.1.1-dev.112' }, '5.1.1-dev.112')).toBeNull();
  });

  for (const stamp of ['banana', '9.9.9', undefined] as const) {
    it(`a matching record stamped ${String(stamp)} is reported at every surface, and \`lock\` replaces the stamp`, async () => {
      root = project();
      quiet();
      const first = (await lockAt(root))!;
      editRecord(root, (r) => { if (stamp === undefined) delete r.validatorVersion; else r.validatorVersion = stamp; });

      const approvals = familyApprovals();
      const own = approvals.find((a) => a.key === '')!;
      expect(own.state).toBe('approved');
      expect(own.stampProblem).toBeDefined();
      const check = checkApproval(true);
      expect(check.approved).toBe(true);
      expect(check.message).toContain(own.stampProblem!);
      expect(check.message).toContain('replaces the stamp');
      expect(approvalVerdict(approvals).text).toContain(own.stampProblem!);
      expect(getStatusReport({ approvals }).text).toContain(own.stampProblem!);

      const relocked = (await lockAt(root))!;
      expect(relocked.validatorVersion).toBe(WAIRON_VERSION);
      expect(relocked.lockedAt).toBe(first.lockedAt);
      expect(readLockRecord()!.validatorVersion).toBe(WAIRON_VERSION);
      expect(infoLines().some((l) => l.includes(`replaced with ${WAIRON_VERSION}`))).toBe(true);
      invalidateSpecCache();
      expect(familyApprovals().find((a) => a.key === '')!.stampProblem).toBeUndefined();
    });
  }

  it('a record whose gateParts were deleted is noticed like `{}`, and `lock` rewrites them', async () => {
    root = project();
    quiet();
    await lockAt(root);
    editRecord(root, (r) => { delete r.gateParts; });
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('approved');
    expect(own.partsIgnored).toContain('carries none');
    expect(checkApproval(false).message).toContain('gate parts are ignored');
    const relocked = (await lockAt(root))!;
    expect(relocked.gateParts).toEqual(computeGateStateId().parts);
  });

  it('a lock.json that names a key twice is unreadable, whichever copy is the good one', async () => {
    expect(firstDuplicateKey('{"a":1,"b":{"c":1,"c":2}}')).toBe('b.c');
    expect(firstDuplicateKey('{"a":{"x":1},"b":{"x":1},"s":"\\"a\\""}')).toBeNull();
    expect(firstDuplicateKey('{"a":[{"k":1},{"k":2}]}')).toBeNull();
    root = project();
    quiet();
    await lockAt(root);
    const file = path.join(root, '.wai', 'lock.json');
    const text = fs.readFileSync(file, 'utf8');
    for (const bad of ['first', 'last'] as const) {
      const dupe = '"stateId": { "algorithm": "x", "digest": "0" },';
      const doubled = bad === 'first' ? text.replace('{', `{\n  ${dupe}`) : text.replace(/\}\s*$/, `,\n  ${dupe.slice(0, -1)}\n}\n`);
      fs.writeFileSync(file, doubled);
      invalidateSpecCache();
      expect(() => readLockRecordAt(root)).toThrow(LockRecordUnreadableError);
      expect(() => readLockRecordAt(root)).toThrow(/"stateId" twice/);
    }
    fs.writeFileSync(file, text);
  });
});

describe('2 — a lock that records specs over a missing tree fails closed (round 8)', () => {
  it('the whole .wai/specs deleted under an approval on record fails plain lock-check', async () => {
    root = project();
    quiet();
    await lockAt(root);
    fs.rmSync(path.join(root, '.wai', 'specs'), { recursive: true, force: true });
    invalidateSpecCache();
    const tree = treeVerdict(false)!;
    expect(tree.approved).toBe(false);
    expect(tree.message).toContain(missingTreeSentence(readLockRecord()!)!);
    expect(tree.message).toContain('never "no tree"');
    expect(checkApproval(false).approved).toBe(false);
  });

  it('a project with no record and no tree is still "nothing is gated"', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-release-r8-'));
    fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
    bind(root);
    const tree = treeVerdict(false)!;
    expect(tree.state).toBe('no-tree');
    expect(tree.approved).toBe(true);
  });

  it('a deleted project.yaml is named, never blamed on the network or the tuning', async () => {
    root = project();
    quiet();
    await lockAt(root);
    fs.rmSync(path.join(root, '.wai', 'project.yaml'));
    invalidateSpecCache();
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('.wai/project.yaml) is missing');
    expect(check.message).not.toContain('what changed is the network declaration');
  });
});

describe('3 — member wording and order (round 8)', () => {
  /** Rewrite a member's record as one taken before gate parts: no parts, an older stamp, an identity this release does not compute. */
  function predatesParts(dir: string): void {
    editRecord(dir, (r) => {
      delete r.gateParts;
      r.validatorVersion = '5.1.1-dev.110';
      (r.stateId as { digest: string }).digest = 'd'.repeat(64);
    });
  }

  it('the root names a member whose record predates gate parts for that, never for unapproved spec changes', async () => {
    fam = buildApprovalFamily();
    quiet();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    await lockAt(fam.top);
    predatesParts(fam.sib);
    bind(fam.top);
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain("sib (its approval predates recorded inputs (approved under wairon 5.1.1-dev.110) — re-lock it once at its own root");
    expect(check.message).not.toContain('spec changes nobody approved');
  });

  it('a member with a real spec change is still called that', async () => {
    fam = buildApprovalFamily();
    quiet();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    await lockAt(fam.top);
    fam.touch(fam.sib, 'edited');
    bind(fam.top);
    expect(checkApproval(false).message).toContain('spec changes nobody approved');
  });

  it('`lock` at the root warns, before it writes, that drifted members lock first', async () => {
    fam = buildApprovalFamily();
    quiet();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    await lockAt(fam.top);
    predatesParts(fam.sib);
    (logger.warn as unknown as { mockClear(): void }).mockClear();
    await lockAt(fam.top);
    expect(warnLines().some((l) => l.includes('The order is bottom-up') && l.includes('sib'))).toBe(true);
  });
});

describe('4 — `lock --subsystem <member>::<subsystem>` at a parent (round 8)', () => {
  it('is refused, naming the member\'s root, and writes nothing', async () => {
    fam = buildApprovalFamily();
    quiet();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    await lockAt(fam.top);
    fam.touch(fam.sib, 'edited in the member');
    const before = fs.readFileSync(path.join(fam.top, '.wai', 'lock.json'), 'utf8');
    bind(fam.top);
    await expect(runLock({ yes: true, subsystem: 'sib::aside' }, { valid: true, issues: [] }, computeGateStateId()))
      .rejects.toThrow(/member project sib: a member's subsystem is approved at the member's own root/);
    expect(fs.readFileSync(path.join(fam.top, '.wai', 'lock.json'), 'utf8')).toBe(before);
  });
});

describe('5 — a selected pack that cannot load is owed (round 8)', () => {
  it('stales the approval at every surface instead of passing', async () => {
    root = project();
    quiet();
    await lockAt(root);
    expect(checkApproval(false).approved).toBe(true);
    const file = path.join(root, '.wai', 'project.yaml');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...config, extensions: { packs: ['./no-such-pack'], useGlobalPacks: false } }));
    invalidateSpecCache();
    const own = familyApprovals().find((a) => a.key === '')!;
    expect(own.state).toBe('drifted');
    expect(own.owed).toContain('cannot load');
    const check = checkApproval(false);
    expect(check.approved).toBe(false);
    expect(check.message).toContain('make the pack load');
  });
});

describe('7 — the verdict names every moved spec up to forty (round 8)', () => {
  it('27 removed specs are all named, with no cut', async () => {
    root = project();
    quiet();
    await lockAt(root);
    const extra: Record<string, string> = {};
    for (let i = 0; i < 27; i++) extra[`.wai/specs/gone/s${String(i).padStart(2, '0')}/.index.yaml`] = 'f'.repeat(64);
    editRecord(root, (r) => { r.specs = { ...(r.specs as Record<string, string>), ...extra }; });
    const verdict = approvalVerdict(familyApprovals());
    for (const key of Object.keys(extra)) expect(verdict.text).toContain(key);
    expect(verdict.text).not.toContain('more');
  });

  it('past forty it counts the rest and names the command that lists them', async () => {
    root = project();
    quiet();
    await lockAt(root);
    const extra: Record<string, string> = {};
    for (let i = 0; i < 45; i++) extra[`.wai/specs/gone/s${String(i).padStart(2, '0')}/.index.yaml`] = 'f'.repeat(64);
    editRecord(root, (r) => { r.specs = { ...(r.specs as Record<string, string>), ...extra }; });
    expect(approvalVerdict(familyApprovals()).text).toContain('… and 5 more — `wairon status --all` lists every one');
  });
});

describe('8 — the inputs a lock records are shown (round 8)', () => {
  it('a first approval prints the project\'s rule tuning', async () => {
    root = project({ sddRuleSeverity: { UNOWNED_STORE: 'error' } });
    quiet();
    await lockAt(root);
    expect(infoLines().some((l) => l.includes("The project's own inputs this approval records") && l.includes('UNOWNED_STORE → error'))).toBe(true);
  });

  it('a no-op lock says this run left the record untouched, never that it is untouched while it rewrites it', async () => {
    root = project();
    quiet();
    await lockAt(root);
    (logger.info as unknown as { mockClear(): void }).mockClear();
    await lockAt(root);
    expect(infoLines().some((l) => l.includes('.wai/lock.json is left untouched by this run'))).toBe(true);
  });
});
