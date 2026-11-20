import { describe, it, expect, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache, readLockState } from '../../src/core/specs.js';
import { computeApprovalId, validateAsComplete, familyApprovals, validateFamily } from '../../src/core/validation.js';
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
  const captured = computeApprovalId();
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

describe('the lock record, format 4', () => {
  it('records format 4: parts and code beside the claim, the design half, and no member', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    const record = (await lockAt(fam.top))!;

    expect(record.format).toBe(4);
    expect((record as unknown as { members?: unknown }).members).toBeUndefined();
    expect(Object.keys(record.parts).sort()).toEqual(['composition', 'design', 'rules', 'selections']);
    expect(record.code).toBeDefined();
    expect(record.code!.analyzer.validatorVersion).toBeTruthy();
    expect(record.code!.analyzer.doctrineDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.code!.analyzer.grade).toBe('none');
    expect(record.code!.codes).toBeUndefined();
    expect(record.validationResult.valid).toBe(true);
    expect(record.stateId.algorithm).toBe('sha256+design+policy');
    expect(fs.readFileSync(path.join(fam.top, '.wai', 'lock.json'), 'utf8')).not.toContain('"members"');
  });

  it('code findings never refuse the lock: they are counted under `code`, and validationResult holds the design half', async () => {
    fam = buildApprovalFamily();
    bind(fam.sib);
    const captured = computeApprovalId();
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
    // Printed once — in the summary before the write — never repeated after it.
    expect(stdout.split('recorded beside the claim').length - 1).toBe(1);
    expect(stdout).toMatch(/member mid: approved/);
    expect(fs.existsSync(path.join(fam.top, '.wai', 'lock.json'))).toBe(true);
    expect({ mid: dirHash(fam.mid), sib: dirHash(fam.sib) }).toEqual(before);
  }, 180_000);
});

describe('property: a member re-locking never moves its parent', () => {
  it('a change two levels down moves only that project; every lock above it stays as it was', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    const topLock = readLockRecordAt(fam.top)!;
    let tree = approvalsAt(fam.top);
    expect(tree.map((a) => [a.key, a.state])).toEqual([['', 'approved'], ['mid', 'approved'], ['leaf', 'approved'], ['sib', 'approved']]);

    // A design edit at the leaf: the leaf drifts, and nothing above moves.
    fam.touch(fam.leaf, 'edited');
    tree = approvalsAt(fam.top);
    expect(entry(tree, 'leaf')!.state).toBe('drifted');
    expect(entry(tree, 'leaf')!.partsMoved).toContain('design');
    expect(entry(tree, 'mid')!.state).toBe('approved');
    expect(entry(tree, '')!.state).toBe('approved');

    // The leaf re-locks, then the middle: no approval above ever moves.
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    tree = approvalsAt(fam.top);
    expect(tree.every((a) => a.state === 'approved')).toBe(true);
    bind(fam.top);
    const { algorithm, digest } = computeApprovalId();
    expect({ algorithm, digest }).toEqual(topLock.stateId);
  });
});

describe('property: require-refuses', () => {
  it('with composition.requireApprovedMembers, a member that is not approved is an input debt of the parent, never its drift', async () => {
    fam = buildApprovalFamily();
    fam.setComposition(['requireApprovedMembers: true']);
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    fam.touch(fam.mid, 'edited after its lock');
    const tree = approvalsAt(fam.top, 1);
    const own = entry(tree, '')!;
    expect(own.inputs.map((d) => [d.kind, d.subject])).toEqual([['member', 'mid'], ['member', 'sib']]);
    expect(own.inputs[0].sentence).toContain('member "mid" is drifted');
    expect(own.inputs[1].sentence).toContain('member "sib" is never approved');
  });

  it('without the flag a member is no debt, and the family run keeps its state as warnings', async () => {
    fam = buildApprovalFamily();
    const record = (await lockAt(fam.top))!;
    expect((record as unknown as { members?: unknown }).members).toBeUndefined();
    expect(entry(approvalsAt(fam.top, 1), '')!.inputs).toEqual([]);
    bind(fam.top);
    const run = validateFamily({ family: true });
    expect(run.issues.filter((i) => i.code === 'MEMBER_UNAPPROVED').map((i) => [i.project, i.severity]))
      .toEqual(expect.arrayContaining([['mid', 'warning'], ['sib', 'warning']]));
  });

  it('a changed requirement stales the requiring project\'s own lock (composition is in the gate identity)', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.top);
    bind(fam.top);
    expect(readLockState(computeApprovalId()).state).toBe('locked');
    fam.setComposition(['requireApprovedMembers: true']);
    bind(fam.top);
    expect(readLockState(computeApprovalId()).state).toBe('stale');
  });
});

describe('property: inputs-captured-before-validation', () => {
  it('a spec written between the capture and the write refuses the lock and writes nothing', async () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const captured = computeApprovalId();
    const config = projectConfigRepositoryAt(fam.top).load();
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    fam.touch(fam.top, 'written while the lock ran');
    invalidateSpecCache();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(runLock({ yes: true }, gate, captured)).rejects.toThrow(/inputs changed while it ran/);
    expect(fs.existsSync(path.join(fam.top, '.wai', 'lock.json'))).toBe(false);
  });

  it('a member re-approving between the capture and the write moves nothing: the lock proceeds', async () => {
    fam = buildApprovalFamily();
    bind(fam.top);
    const captured = computeApprovalId();
    const config = projectConfigRepositoryAt(fam.top).load();
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    await lockAt(fam.sib);
    bind(fam.top);

    const record = (await runLock({ yes: true }, gate, captured))!;
    expect(record.stateId).toEqual({ algorithm: captured.algorithm, digest: captured.digest });
    expect(readLockRecordAt(fam.top)).not.toBeNull();
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
    expect(readLockState(computeApprovalId()).state).toBe('locked');

    appendRules(fam.top, ['sddRuleSeverity:', '    UNKNOWN_PROFILE: \'off\'']);
    await lockAt(fam.top);
    fs.writeFileSync(path.join(fam.top, '.wai', 'project.yaml'),
      fs.readFileSync(path.join(fam.top, '.wai', 'project.yaml'), 'utf8').replace("UNKNOWN_PROFILE: 'off'", "UNKNOWN_PROFILE: 'warning'"));
    bind(fam.top);
    expect(readLockState(computeApprovalId()).state).toBe('stale');
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
  it('a member\'s state and parts read the same from the parent and from the member\'s own root', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    fam.touch(fam.leaf, 'edited');

    const fromTop = approvalsAt(fam.top);
    const fromMid = approvalsAt(fam.mid);
    const fromLeaf = approvalsAt(fam.leaf);
    const strip = (a: ProjectApproval | undefined) => a && { state: a.state, partsMoved: a.partsMoved, inputs: a.inputs };
    expect(strip(entry(fromTop, 'mid'))).toEqual(strip(entry(fromMid, '')));
    expect(strip(entry(fromTop, 'leaf'))).toEqual(strip(entry(fromMid, 'leaf')));
    expect(strip(entry(fromTop, 'leaf'))).toEqual(strip(entry(fromLeaf, '')));
    expect(entry(fromTop, 'leaf')!.state).toBe('drifted');
  });

  it('status prints each member\'s own state, and ends with the root\'s own state', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.mid);
    const approvals = approvalsAt(fam.top);
    const report = getStatusReport({ approvals });
    expect(report.text).toMatch(/\[Project\] mid \(mid\) \[approved\]/);
    expect(report.text).toMatch(/\[Project\] sib \(sib\) \[never approved\]/);
    expect(report.text).toMatch(/\[Project\] leaf \(leaf\) \[never approved\]/);
    expect(report.text.trimEnd().split('\n').pop()).toBe('Approval: this project is never approved (`wairon lock` approves the design)');
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

describe('gate truth — the root lock-check judges every member project, and plain lock-check says what it guarantees', () => {
  it('refuses at every strictness while a member (at any depth) carries spec changes nobody approved', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    // The root's identity reads each member's RECORDED approval, so this edit
    // does not move it: only reading the member's own approval catches it.
    fam.touch(fam.leaf, 'edited');
    bind(fam.top);
    for (const strict of [false, true]) {
      const check = checkApproval(strict);
      expect(check.approved).toBe(false);
      expect(check.message).toContain('carry spec changes nobody approved');
      expect(check.message).toContain('leaf (changed since its own approval');
      expect(check.message).toContain("This project's own approval still covers its design.");
    }
  });

  it('never calls the family approved while a member was never approved: --strict refuses, plain passes naming it NOT gated', async () => {
    fam = buildApprovalFamily();
    await lockAt(fam.leaf);
    await lockAt(fam.mid);
    await lockAt(fam.top); // sib never locked
    bind(fam.top);
    const strict = checkApproval(true);
    expect(strict.approved).toBe(false);
    expect(strict.message).toContain('sib (never approved');
    const plain = checkApproval(false);
    expect(plain.approved).toBe(true);
    expect(plain.message).toContain('NOT gated: sib');
    expect(plain.message).not.toContain('The design in this tree is the approved design');
  });

  it('a deleted lock record: plain passes and says plainly it gates nothing and CI runs --strict; --strict refuses', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    fs.rmSync(path.join(fam.top, '.wai', 'lock.json'));
    bind(fam.top);
    const plain = checkApproval(false);
    expect(plain.approved).toBe(true);
    expect(plain.message).toContain('nothing is gated');
    expect(plain.message).toContain('the record deleted');
    expect(plain.message).toContain('`wairon lock-check --strict`');
    expect(checkApproval(true).approved).toBe(false);
  });

  it('a member re-approval never makes this approval stale; an own edit beside it is plain stale', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    fam.touch(fam.sib, 'edited');
    await lockAt(fam.sib);
    bind(fam.top);
    expect(checkApproval(false).approved).toBe(true);
    // An own edit: the verdict names it, and no member.
    fam.touch(fam.top, 'edited');
    bind(fam.top);
    const stale = checkApproval(false);
    expect(stale.approved).toBe(false);
    expect(stale.message).toContain('What moved: 1 own spec file(s) changed since the approval (`wairon status` names them)');
  });
});

describe('the approval verdict carries every moved spec for `wairon status --all`', () => {
  it('names each moved spec in full, prefixed by how it moved', async () => {
    fam = buildApprovalFamily();
    await lockAll(fam);
    fam.touch(fam.top, 'edited');
    bind(fam.top);
    const { approvalVerdict } = await import('../../src/core/approval.js');
    const verdict = approvalVerdict(familyApprovals());
    expect(verdict.drifted).toBe(true);
    expect(verdict.moved).toHaveLength(1);
    expect(verdict.moved![0]).toMatch(/^~ \.wai\/specs\//);
  });
});
