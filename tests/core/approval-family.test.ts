import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, readLockState, lockUpgraded } from '../../src/core/specs.js';
import { computeGateStateId, validateAsComplete, familyApprovals, validateFamily } from '../../src/core/validation.js';
import { readLockRecord, readLockRecordAt, writeLockRecord, type LockRecord } from '../../src/core/lockfile.js';
import { getStatusReport } from '../../src/core/status.js';
import { composeAgentBrief, resolveAgentTopology } from '../../src/core/agent_resolver.js';
import { projectConfigRepositoryAt } from '../../src/config/project-config.js';
import { runLock, checkApproval, type LockOptions } from '../../src/commands/lock.js';
import { designOnly, type ProjectApproval } from '../../src/models/lock.js';
import { buildApprovalFamily, type ApprovalFamily } from '../helpers/reference-family.js';

// ---------------------------------------------------------------------------
// Stage 5 — approval across a family (wave A: local).
//
// Each project locks itself; a parent's lock records each DIRECT member's
// composition subject (the stateId the member's own lock carries) and writes
// nothing below itself. Every property here runs the real lock path on real
// temp directories: capture the gate identity, validate as complete, gate on
// the design half, lock through the adapter.
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const WAIRON_CLI = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

let fam: ApprovalFamily | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  setProjectRoot(null);
  invalidateSpecCache();
  try { fam?.cleanup(); } catch { /* windows file locks */ }
  fam = null;
});

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

/** Lock a project at its own root, exactly as `wairon lock` does: capture, validate, gate on the design half. */
async function lockAt(dir: string, options: LockOptions = { yes: true }): Promise<LockRecord | null> {
  bind(dir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const captured = computeGateStateId();
  const config = projectConfigRepositoryAt(dir).load();
  const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
  expect(designOnly(gate).issues.filter((i) => i.severity === 'error')).toEqual([]);
  return runLock(options, gate, captured);
}

/** The pin tree asked at one root. */
function approvalsAt(dir: string, depth?: number): ProjectApproval[] {
  bind(dir);
  return familyApprovals(depth);
}

const entry = (approvals: ProjectApproval[], key: string): ProjectApproval | undefined => approvals.find((a) => a.key === key);

/** sha256 over every file below a directory (relative path + bytes). */
function dirHash(dir: string): string {
  const h = crypto.createHash('sha256');
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else h.update(path.relative(dir, p)).update(fs.readFileSync(p));
    }
  };
  walk(dir);
  return h.digest('hex');
}

/** Every family member locked bottom-up. */
async function lockAll(f: ApprovalFamily): Promise<void> {
  await lockAt(f.leaf);
  await lockAt(f.mid);
  await lockAt(f.sib);
  await lockAt(f.top);
}

describe('stage 5 — the lock record, format 2', () => {
  it('records format 2: members (subject + state), code beside the claim, the design half, and never children', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    const record = (await lockAt(fam.top))!;

    expect(record.format).toBe(2);
    expect(record.children).toBeUndefined();
    const mid = readLockRecordAt(fam.mid)!;
    expect(record.members).toEqual({
      mid: { project: 'mid', subject: `${mid.stateId.algorithm}:${mid.stateId.digest}`, state: 'approved' },
      sib: { project: 'sib', state: 'never' },
    });
    // The code half is recorded beside the claim, with the analyzer that took it.
    expect(record.code).toBeDefined();
    expect(record.code!.analyzer.validatorVersion).toBeTruthy();
    expect(record.code!.analyzer.doctrineDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.code!.analyzer.grade).toBe('none');
    expect(record.code!.codes).toBeUndefined();
    expect(record.validationResult.valid).toBe(true);
    expect(record.stateId.algorithm).toBe('sha256+content+doctrine+inputs+members');
    expect(fs.readFileSync(path.join(fam.top, '.wai', 'lock.json'), 'utf8')).not.toContain('"children"');
  });

  it('code findings never refuse the lock: they are counted under `code`, and validationResult holds the design half', async () => {
    fam = buildApprovalFamily();
    bind(fam.sib);
    const captured = computeGateStateId();
    const config = projectConfigRepositoryAt(fam.sib).load();
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    // A code finding in the as-complete run: one issue under a code the analyzer declares.
    const codeCode = gate.analysis!.codes![0];
    const withCodeError = {
      ...gate,
      valid: false,
      issues: [...gate.issues, { severity: 'error' as const, code: codeCode, message: 'a code finding' }],
      analysis: { ...gate.analysis!, errors: gate.analysis!.errors + 1 },
    };
    expect(designOnly(withCodeError).valid).toBe(true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const record = (await runLock({ yes: true }, withCodeError, captured))!;
    expect(record.code!.errors).toBe(1);
    expect(record.validationResult).toMatchObject({ valid: true, errors: 0 });
  });
});

describe('property: parent-lock-writes-nothing-below', () => {
  it('a parent lock (the real CLI, generate included) leaves every byte below it as it was', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    setProjectRoot(null);
    const before = { mid: dirHash(fam.mid), sib: dirHash(fam.sib) };

    const { stdout } = await execFileP(process.execPath, [TSX_CLI, WAIRON_CLI, 'lock', '--yes'], { cwd: fam.top, timeout: 180_000 });

    expect(stdout).toContain('recorded beside the claim');
    expect(stdout).toMatch(/member mid: approved/);
    expect(fs.existsSync(path.join(fam.top, '.wai', 'lock.json'))).toBe(true);
    expect({ mid: dirHash(fam.mid), sib: dirHash(fam.sib) }).toEqual(before);
  }, 180_000);
});

describe('property: pin-chain (restated)', () => {
  it('a change two levels down reaches the top only after the middle re-locks; until then the middle shows as drifted', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    const topLock = readLockRecordAt(fam.top)!;
    let tree = approvalsAt(fam.top);
    expect(tree.map((a) => [a.key, a.state])).toEqual([['', 'approved'], ['mid', 'approved'], ['leaf', 'approved'], ['sib', 'approved']]);

    // A design edit at the leaf: the leaf drifts, and nothing above moves —
    // the middle's identity carries the leaf's RECORDED subject.
    fam.touch(fam.leaf, 'edited');
    tree = approvalsAt(fam.top);
    expect(entry(tree, 'leaf')!.state).toBe('drifted');
    expect(entry(tree, 'mid')!.state).toBe('approved');
    expect(entry(tree, '')!.state).toBe('approved');

    // The leaf re-locks: its subject moves, so the middle's identity moves —
    // the middle is drifted, with the leaf's pin moved; the top still approved.
    await lockAt(fam.leaf);
    tree = approvalsAt(fam.top);
    expect(entry(tree, 'leaf')).toMatchObject({ state: 'approved', pinned: 'moved' });
    expect(entry(tree, 'mid')).toMatchObject({ state: 'drifted', pinned: 'matches' });
    expect(entry(tree, '')!.state).toBe('approved');
    bind(fam.top);
    expect(computeGateStateId()).toEqual(topLock.stateId);

    // The middle re-locks: now the top's identity moves and the top is stale.
    await lockAt(fam.mid);
    tree = approvalsAt(fam.top);
    expect(entry(tree, 'mid')).toMatchObject({ state: 'approved', pinned: 'moved' });
    expect(entry(tree, '')!.state).toBe('drifted');
    bind(fam.top);
    expect(computeGateStateId()).not.toEqual(topLock.stateId);

    await lockAt(fam.top);
    expect(approvalsAt(fam.top).every((a) => a.state === 'approved' && (a.key === '' || a.pinned === 'matches'))).toBe(true);
  });
});

describe('property: require-refuses', () => {
  it('with composition.requireApprovedMembers, the lock refuses, names each direct member and its state, and writes nothing', async () => {
    fam = buildApprovalFamily();
    fam.setComposition(['requireApprovedMembers: true']);
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    fam.touch(fam.mid, 'edited after its lock');

    await expect(lockAt(fam.top)).rejects.toThrow(/requireApprovedMembers.*mid \(drifted\).*sib \(never\)/);
    expect(fs.existsSync(path.join(fam.top, '.wai', 'lock.json'))).toBe(false);

    // A grandchild is covered through its parent's subject, never judged directly.
    await lockAt(fam.mid);
    await lockAt(fam.sib);
    fam.touch(fam.leaf, 'drifted grandchild');
    const record = (await lockAt(fam.top))!;
    expect(record.members).toMatchObject({ mid: { state: 'approved' }, sib: { state: 'approved' } });
  });

  it('without the flag the lock proceeds and records each member\'s state', async () => {
    fam = buildApprovalFamily();
    const record = (await lockAt(fam.top))!;
    expect(record.members).toEqual({ mid: { project: 'mid', state: 'never' }, sib: { project: 'sib', state: 'never' } });
    // …and the family run keeps them as warnings.
    bind(fam.top);
    const run = validateFamily({ family: true });
    expect(run.issues.filter((i) => i.code === 'MEMBER_UNAPPROVED').map((i) => [i.project, i.severity]))
      .toEqual(expect.arrayContaining([['mid', 'warning'], ['sib', 'warning']]));
  });

  it('a changed requirement stales the requiring project\'s own lock (composition is in the gate identity)', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.top);
    bind(fam.top);
    expect(readLockState(computeGateStateId()).state).toBe('locked');
    fam.setComposition(['requireApprovedMembers: true']);
    bind(fam.top);
    expect(readLockState(computeGateStateId()).state).toBe('stale');
  });
});

describe('property: inputs-captured-before-validation', () => {
  it('a spec written between the capture and the write refuses the lock and writes nothing', async () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const captured = computeGateStateId();
    const config = projectConfigRepositoryAt(fam.top).load();
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    fam.touch(fam.top, 'written while the lock ran');
    invalidateSpecCache();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runLock({ yes: true }, gate, captured)).rejects.toThrow(/inputs changed while it ran/);
    expect(fs.existsSync(path.join(fam.top, '.wai', 'lock.json'))).toBe(false);
  });

  it('a member re-approving between the capture and the write refuses too', async () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const captured = computeGateStateId();
    const config = projectConfigRepositoryAt(fam.top).load();
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    await lockAt(fam.sib);
    bind(fam.top);

    await expect(runLock({ yes: true }, gate, captured)).rejects.toThrow(/inputs changed while it ran/);
    expect(readLockRecordAt(fam.top)).toBeNull();
  });
});

describe('property: analyzer-upgrade-keeps-approval', () => {
  const appendRules = (dir: string, lines: string[]): void => {
    const file = path.join(dir, '.wai', 'project.yaml');
    fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8')}rules:\n${lines.map((l) => `  ${l}`).join('\n')}\n`);
  };

  it('code-severity overrides and rules.conformance never stale the lock; a design override does', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.sib);
    appendRules(fam.sib, ['sddRuleSeverity:', '    UNREALIZED_METHOD: \'off\'', 'conformance:', '    sourceRoots: [src]']);
    bind(fam.sib);
    expect(readLockState(computeGateStateId()).state).toBe('locked');

    appendRules(fam.top, ['sddRuleSeverity:', '    UNKNOWN_PROFILE: \'off\'']);
    await lockAt(fam.top);
    fs.writeFileSync(path.join(fam.top, '.wai', 'project.yaml'),
      fs.readFileSync(path.join(fam.top, '.wai', 'project.yaml'), 'utf8').replace("UNKNOWN_PROFILE: 'off'", "UNKNOWN_PROFILE: 'warning'"));
    bind(fam.top);
    expect(readLockState(computeGateStateId()).state).toBe('stale');
  });

  it('the analyzer identity recorded beside the claim moves with the code tuning', async () => {
    fam = buildApprovalFamily();
    const first = (await lockAt(fam.sib))!;
    appendRules(fam.sib, ['conformance:', '    sourceRoots: [src]']);
    const second = (await lockAt(fam.sib))!;
    expect(second.stateId).toEqual(first.stateId);
    expect(second.code!.analyzer.doctrineDigest).not.toBe(first.code!.analyzer.doctrineDigest);
  });
});

describe('property: status-agrees', () => {
  it('a member\'s state and subject read the same from the parent and from the member\'s own root', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    fam.touch(fam.leaf, 'edited');

    const fromTop = approvalsAt(fam.top);
    const fromMid = approvalsAt(fam.mid);
    const fromLeaf = approvalsAt(fam.leaf);
    const strip = (a: ProjectApproval | undefined) => a && { state: a.state, subject: a.subject, upgraded: a.upgraded };
    expect(strip(entry(fromTop, 'mid'))).toEqual(strip(entry(fromMid, '')));
    expect(strip(entry(fromTop, 'leaf'))).toEqual(strip(entry(fromMid, 'leaf')));
    expect(strip(entry(fromTop, 'leaf'))).toEqual(strip(entry(fromLeaf, '')));
    expect(entry(fromTop, 'leaf')!.state).toBe('drifted');
  });

  it('status prints each member\'s state and pin, and ends with the root\'s own state', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.mid);
    const approvals = approvalsAt(fam.top);
    const report = getStatusReport({ approvals });
    expect(report.text).toMatch(/\[Project\] mid \(mid\) \[approved · pin unpinned\]/);
    expect(report.text).toMatch(/\[Project\] sib \(sib\) \[never · pin unpinned\]/);
    expect(report.text).toMatch(/\[Project\] leaf \(leaf\) \[never · pin matches\]/);
    expect(report.text.trimEnd().split('\n').pop()).toBe('Approval: this project is never');
  });
});

describe('property: brief-through-mount and context-proportional', () => {
  it('a member\'s delegating owner lists the member\'s agents by id, one level deep', () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const owner = resolveAgentTopology().find((a) => a.id === 'mid-owner')!;
    expect(owner.delegatesTo).toEqual(expect.arrayContaining(['mid::system-architect', 'mid::middle-owner', 'mid::leaf-owner']));
    expect(owner.delegatesTo!.some((id) => id.startsWith('mid::leaf::'))).toBe(false);
  });

  it('a member\'s brief composes at the member\'s root, with its fence re-expressed under the member\'s directory', () => {
    fam = buildApprovalFamily();
    bind(fam.mid);
    const own = composeAgentBrief('middle-owner');
    bind(fam.top);
    const through = composeAgentBrief('mid::middle-owner');
    expect(through.agentId).toBe('mid::middle-owner');
    expect(through.root).toBe('mid');
    expect(through.instructions).toBe(own.instructions);
    expect(through.ownedPaths).toEqual(own.ownedPaths.map((p) => `mid/${p}`));

    const deep = composeAgentBrief('mid::leaf::bottom-owner');
    expect(deep.root).toBe('mid/leaf');
    expect(deep.ownedPaths.every((p) => p.startsWith('mid/leaf/'))).toBe(true);

    expect(() => composeAgentBrief('nobody::system-architect')).toThrow(/Unknown agent id/);
  });

  it('a member\'s brief does not grow with the family', () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const before = composeAgentBrief('mid::middle-owner');
    // The family grows: another member beside mid, and a subsystem at the top.
    const extra = path.join(fam.top, 'extra');
    fs.mkdirSync(path.join(extra, '.wai'), { recursive: true });
    fs.copyFileSync(path.join(fam.sib, '.wai', 'project.yaml'), path.join(extra, '.wai', 'project.yaml'));
    const cfg = path.join(fam.top, '.wai', 'project.yaml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('  sib: sib', '  sib: sib\n  extra: extra'));
    fam.touch(fam.top, 'grown');
    bind(fam.top);
    const after = composeAgentBrief('mid::middle-owner');
    expect(after.instructions.length).toBe(before.instructions.length);
    expect(after).toEqual(before);
  });
});

describe('format 1: read as legacy, reported as upgraded', () => {
  /** Write a pre-stage-5 record at a root: the old marker, the legacy children. */
  function writeFormat1(dir: string, digest: string, children?: Record<string, string>): void {
    bind(dir);
    const record = readLockRecord()!;
    const legacy = { ...record, stateId: { algorithm: 'sha256+content+doctrine+inputs', digest } } as LockRecord;
    delete (legacy as Partial<LockRecord>).format;
    delete (legacy as Partial<LockRecord>).members;
    delete (legacy as Partial<LockRecord>).code;
    fs.writeFileSync(path.join(dir, '.wai', 'lock.json'), JSON.stringify({ ...legacy, ...(children ? { children } : {}) }, null, 2));
  }

  it('a format-1 lock reads stale and upgraded, and lock-check says why without calling the design moved', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.sib);
    writeFormat1(fam.sib, 'a'.repeat(64));
    bind(fam.sib);
    const lock = readLockState(computeGateStateId());
    expect(lock.state).toBe('stale');
    expect(lockUpgraded(lock)).toBe(true);

    const check = checkApproval(false);
    expect(check.state).toBe('stale');
    expect(check.approved).toBe(false);
    expect(check.message).toContain("the gate identity gained inputs in stage 5: members' composition subjects, `composition`; code conformance moved beside the claim");
    expect(check.message).toContain('No own spec file has changed since the approval.');
    expect(check.message).toContain('re-lock once');

    fam.touch(fam.sib, 'edited');
    bind(fam.sib);
    expect(checkApproval(false).message).toContain('1 own spec file(s) changed since the approval.');
  });

  it('a content change is plain stale, not upgraded', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.sib);
    fam.touch(fam.sib, 'edited');
    bind(fam.sib);
    const lock = readLockState(computeGateStateId());
    expect(lock.state).toBe('stale');
    expect(lockUpgraded(lock)).toBe(false);
  });

  it('the pin tree marks a format-1 member upgraded and reads its parent\'s legacy `children` as the pin', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.sib);
    await lockAt(fam.mid);
    await lockAt(fam.top);
    writeFormat1(fam.sib, 'b'.repeat(64));
    // The parent's format-1 record pinned sib at exactly that subject.
    writeFormat1(fam.top, 'c'.repeat(64), { sib: `sha256+content+doctrine+inputs:${'b'.repeat(64)}` });

    const tree = approvalsAt(fam.top);
    expect(entry(tree, 'sib')).toMatchObject({ state: 'drifted', upgraded: true, pinned: 'matches' });
    expect(entry(tree, 'mid')).toMatchObject({ pinned: 'unpinned' });
    expect(entry(tree, '')).toMatchObject({ state: 'drifted', upgraded: true });

    bind(fam.top);
    const run = validateFamily({ family: true });
    const drifted = run.issues.find((i) => i.code === 'MEMBER_DRIFTED' && i.project === 'sib')!;
    expect(drifted.message).toContain('earlier gate identity');
    expect(drifted.message).toContain('Re-lock it once');
  });

  it('a lock written now is format 2 and never re-writes a legacy record\'s children', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.top);
    writeFormat1(fam.top, 'c'.repeat(64), { mid: 'sha256+content+doctrine+inputs:x' });
    const record = (await lockAt(fam.top))!;
    expect(record.format).toBe(2);
    expect(readLockRecordAt(fam.top)!.children).toBeUndefined();
    writeLockRecord({ ...record, children: { mid: 'x' } });
    expect(readLockRecordAt(fam.top)!.children).toBeUndefined();
  });
});
