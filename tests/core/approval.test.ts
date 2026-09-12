import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec, saveSubsystemSpec, saveComponentSpec, updateSpec, loadComponentSpecs,
  deleteComponentSpec, invalidateSpecCache,
} from '../../src/core/specs.js';
import {
  captureApprovedSpecs, approvalRecord, diffAgainstApproval, diffSize,
  currentChildPins, movedChildren, pinOf,
} from '../../src/core/approval.js';
import {
  readLockRecord, writeLockRecord, normalizeApprover, describeApprover,
  type ApproverIdentity, type LockRecord,
} from '../../src/core/lockfile.js';
import { computeGateStateId } from '../../src/core/specs.js';
import type { SubsystemSpec, ComponentSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The approval: a digest per spec, carried in the COMMITTED lock record.
//
// Two things it has to get right, and they pull against each other. Storing
// only a whole-tree hash could answer "did anything move?" and nothing else —
// the `Lock: STALE` banner on a clean tree, which no human can act on. Storing
// the approved CONTENT could answer "what moved?" but was ~2 MB kept outside
// the repository, invisible to a teammate, a fresh clone, and CI.
//
// One digest per spec answers every question anything actually asks, at a size
// that commits. So these tests assert both halves: that it names what moved,
// and that it lands in the project rather than beside it — while still never
// touching a spec file, which is the ratchet this replaced.
// ---------------------------------------------------------------------------

const now = '2026-09-11T10:00:00Z';

function project(name = 'approval-sys'): string {
  invalidateSpecCache();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-approval-'));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name, projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(root);
  saveSystemSpec({
    schemaVersion: '1.0.0', name, vision: 'an approval fixture',
    boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  saveSubsystemSpec({
    id: 'dom', name: 'dom', description: 'the approval domain',
    parentSystem: name, publicInterfaces: [], trustedLinks: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as SubsystemSpec);
  saveComponentSpec({
    id: 'worker', name: 'Worker', description: 'a worker component',
    subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
    status: 'draft', createdAt: now, updatedAt: now,
  } as ComponentSpec);
  invalidateSpecCache();
  return root;
}

const TESTER: ApproverIdentity = { id: 'tester <t@example.com>', source: 'git' };

/** What a lock writes: the record, carrying the approval. */
function approve(
  who: ApproverIdentity = TESTER,
  children: Record<string, string> = {},
  scope?: { paths: Set<string> },
): LockRecord {
  const record: LockRecord = {
    stateId: computeGateStateId(),
    lockedAt: now,
    lockedBy: who,
    validatorVersion: 'test',
    validationResult: { valid: true, errors: 0, warnings: 0 },
    status: 'ready',
    specs: captureApprovedSpecs(undefined, scope),
    children,
  };
  writeLockRecord(record);
  return record;
}

/** Write a lock record into ANOTHER root (a chained child approving itself). */
function approveAt(root: string, stateDigest = 'a'.repeat(64)): LockRecord {
  const record: LockRecord = {
    stateId: { algorithm: 'sha256+doctrine', digest: stateDigest },
    lockedAt: now,
    lockedBy: { id: 'child <c@example.com>', source: 'git' },
    validatorVersion: 'test',
    validationResult: { valid: true, errors: 0, warnings: 0 },
    status: 'ready',
    specs: {},
    children: {},
  };
  fs.mkdirSync(path.join(root, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'lock.json'), JSON.stringify(record, null, 2));
  return record;
}

function specTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const dir = path.join(root, '.wai', 'specs');
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(path.relative(dir, p), fs.readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

describe('the approval', () => {
  let root: string;

  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
  });

  it('touches NO spec file — it is one record, not a rewrite of the tree', () => {
    root = project();
    const before = specTree(root);

    approve();

    // The ratchet this replaced rewrote every spec file to mark it complete.
    const after = specTree(root);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, content] of before) expect(after.get(rel)).toBe(content);
  });

  it('lands INSIDE the project, so a teammate and CI see the same approval', () => {
    root = project();
    approve();

    // The whole point of the move: a machine-local record could not be seen by
    // anyone else, so a fresh clone judged an approved tree as unapproved.
    const lock = path.join(root, '.wai', 'lock.json');
    expect(fs.existsSync(lock)).toBe(true);
    expect(Object.keys(JSON.parse(fs.readFileSync(lock, 'utf8')).specs).length).toBeGreaterThan(0);
  });

  it('records a DIGEST per spec, never the content', () => {
    root = project();
    const specs = approve().specs!;

    for (const [rel, value] of Object.entries(specs)) {
      expect(rel).toMatch(/^\.wai\/specs\//);
      expect(value).toMatch(/^[0-9a-f]{64}$/); // sha256, not a spec body
    }
  });

  it('writes spec keys sorted, so a re-lock diffs one line per changed spec', () => {
    root = project();
    approve();

    const keys = Object.keys(JSON.parse(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).specs);
    expect(keys).toEqual([...keys].sort());
  });

  it('distinguishes "never approved" from "approved and unchanged"', () => {
    root = project();
    expect(diffAgainstApproval()).toBeNull();

    approve();
    const d = diffAgainstApproval()!;
    expect(d).not.toBeNull();
    expect(diffSize(d)).toBe(0);
    expect(d.unchangedPaths.length).toBeGreaterThan(0);
  });

  it('names WHAT changed, not merely that something did', () => {
    root = project();
    approve();

    updateSpec('component', 'worker', { description: 'a revised worker component' });
    invalidateSpecCache();

    const d = diffAgainstApproval()!;
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatch(/worker/);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reports an added spec', () => {
    root = project();
    approve();

    saveComponentSpec({
      id: 'second', name: 'Second', description: 'a second component',
      subsystem: 'dom', componentType: 'Specialist', dependsOn: [], owns: [],
      status: 'draft', createdAt: now, updatedAt: now,
    } as ComponentSpec);
    invalidateSpecCache();

    const d = diffAgainstApproval()!;
    expect(d.added.some((p) => p.includes('second'))).toBe(true);
    expect(d.changed).toEqual([]);
  });

  it('reports a removed spec', () => {
    root = project();
    approve();

    deleteComponentSpec('worker');
    invalidateSpecCache();

    expect(diffAgainstApproval()!.removed.some((p) => p.includes('worker'))).toBe(true);
  });

  it('ignores line endings — an approval must survive a checkout on another OS', () => {
    // The record is COMMITTED, so the machine that approves and the machine that
    // reads it back are routinely different. Git rewrites line endings on
    // checkout (`core.autocrlf`), so hashing raw bytes would make an approval
    // taken on Windows report EVERY spec as drifted on a Linux CI runner — a
    // fully drifted tree that nobody touched. This was invisible while the
    // approval was machine-local; sharing it is what made it reachable.
    root = project();
    const rel = Object.keys(approve().specs!).find((p) => p.includes('worker'))!;
    const target = path.join(root, rel);
    const lf = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    fs.writeFileSync(target, lf.replace(/\n/g, '\r\n'));
    invalidateSpecCache();

    expect(diffSize(diffAgainstApproval()!)).toBe(0);

    // …while a real content edit still registers, CRLF and all.
    fs.writeFileSync(target, lf.replace('a worker component', 'a revised worker').replace(/\n/g, '\r\n'));
    invalidateSpecCache();
    expect(diffAgainstApproval()!.changed).toHaveLength(1);
  });

  it('re-approving clears the diff', () => {
    root = project();
    approve();
    updateSpec('component', 'worker', { description: 'a revised worker component' });
    invalidateSpecCache();
    expect(diffSize(diffAgainstApproval()!)).toBe(1);

    approve();
    expect(diffSize(diffAgainstApproval()!)).toBe(0);
  });

  it('lives per project root, so two projects never share an approval', () => {
    root = project('alpha-sys');
    approve();

    const other = project('beta-sys');
    try {
      expect(diffAgainstApproval()).toBeNull();
    } finally {
      setProjectRoot(null);
      try { fs.rmSync(other, { recursive: true, force: true }); } catch { /* win */ }
    }
  });

  it('carries child pins as metadata, not as local changes', () => {
    root = project();
    approve(TESTER, { billing: 'sha256:abc123' });

    expect(approvalRecord()!.children).toEqual({ billing: 'sha256:abc123' });
    expect(diffSize(diffAgainstApproval()!)).toBe(0);
  });

  it('excludes a REAL chained child’s specs — a child edit must not dirty the parent', () => {
    // Regression. `snapshotSpecFiles` federates recursively, so the parent
    // approval captured every child spec file: approving the parent silently
    // froze work it does not own, and any child edit showed up in the parent's
    // diff — the exact thing the child PIN exists to replace. An earlier test
    // used a fake pin with no mounted child, so it could not see this.
    root = project();

    saveSubsystemSpec({
      id: 'billing', name: 'billing', description: 'a chained billing domain',
      parentSystem: 'approval-sys', publicInterfaces: [], trustedLinks: [],
      projectPath: 'packages/billing',
      status: 'draft', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    const childSpecs = path.join(root, 'packages', 'billing', '.wai', 'specs');
    fs.mkdirSync(path.join(childSpecs, 'subsystems'), { recursive: true });
    fs.mkdirSync(path.join(childSpecs, 'components'), { recursive: true });
    fs.writeFileSync(path.join(root, 'packages', 'billing', '.wai', 'project.yaml'), JSON.stringify({
      schemaVersion: '1.0.0', name: 'billing-sys', projectType: 'backend',
      targets: [], rules: {}, createdAt: now, updatedAt: now,
    }));
    const stamp = `createdAt: '${now}'\nupdatedAt: '${now}'`;
    fs.writeFileSync(path.join(childSpecs, '.index.yaml'),
      `schemaVersion: 1.0.0\nname: billing-sys\nvision: the child system\n${stamp}\n`);
    fs.writeFileSync(path.join(childSpecs, 'subsystems', 'ledger.yaml'),
      `schemaVersion: 1.0.0\nid: ledger\nname: ledger\ndescription: the child ledger domain\n`
      + `parentSystem: billing-sys\n${stamp}\n`);
    // A COMPONENT is what makes the child appear in the federated spec index —
    // snapshotSpecFiles pulls from index.paths, not from raw directories.
    const childComp = path.join(childSpecs, 'components', 'ledger_store.yaml');
    const childBody = (description: string): string =>
      `schemaVersion: 1.0.0\nid: ledger_store\nname: Ledger Store\ndescription: ${description}\n`
      + `subsystem: ledger\ncomponentType: Store\ndependsOn: []\nowns: []\n${stamp}\n`;
    fs.writeFileSync(childComp, childBody('the child store'));
    invalidateSpecCache();

    // Sanity: the child IS federated into the parent's index, so this fixture
    // genuinely exercises the recursion the bug rode on.
    expect(loadComponentSpecs().some((c) => c.id.includes('ledger_store'))).toBe(true);

    const approved = Object.keys(approve().specs!);
    expect(approved.some((p) => p.includes('packages/billing'))).toBe(false);

    fs.writeFileSync(childComp, childBody('the child store, revised'));
    invalidateSpecCache();
    expect(diffSize(diffAgainstApproval()!)).toBe(0);
  });

  it('reads a corrupt lock record as "never approved" rather than throwing', () => {
    root = project();
    approve();
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), '{ not json');

    expect(readLockRecord()).toBeNull();
    expect(diffAgainstApproval()).toBeNull();
  });

  it('treats a lock with no per-spec record as unapproved, without losing the lock', () => {
    // Every lock written before approval moved in here. It still proves the
    // tree validated, so the record must survive — but it cannot say which
    // specs match, and inventing an answer would be worse than admitting it.
    root = project();
    const record = approve();
    delete record.specs;
    writeLockRecord(record);

    expect(readLockRecord()).not.toBeNull();
    expect(readLockRecord()!.stateId.digest).toBeTruthy();
    expect(diffAgainstApproval()).toBeNull();
  });

  it('deleting the lock record forgets the approval', () => {
    root = project();
    approve();
    fs.rmSync(path.join(root, '.wai', 'lock.json'));
    expect(diffAgainstApproval()).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Who approved — and how much that name is worth.
  // -------------------------------------------------------------------------

  it('records the approver WITH the source that established them', () => {
    root = project();
    const rec = approve({ id: 'u-4f2a91', name: 'Robbe', source: 'hosted' });

    expect(rec.lockedBy).toEqual({ id: 'u-4f2a91', name: 'Robbe', source: 'hosted' });
    expect(rec.stateId.digest).toBeTruthy();
    // A hosted identity was authenticated by the instance; a git or os one was
    // read off the machine. The rendering says which, so a bare name cannot
    // imply more than it proves.
    expect(describeApprover(rec.lockedBy)).toContain('authenticated');
    expect(describeApprover({ id: 'a <a@b.c>', source: 'git' })).not.toContain('authenticated');
  });

  it('reads a legacy string approver as legacy rather than guessing its source', () => {
    expect(normalizeApprover('local:ShutYourWaffle')).toEqual({ id: 'local:ShutYourWaffle', source: 'legacy' });
    expect(normalizeApprover('admin:master')).toEqual({ id: 'admin:master', source: 'legacy' });
    expect(normalizeApprover(undefined)).toEqual({ id: 'unknown', source: 'legacy' });
    // An unrecognised source is a claim this version cannot vouch for.
    expect(normalizeApprover({ id: 'x', source: 'sso' })).toEqual({ id: 'x', source: 'legacy' });
  });

  it('normalizes a legacy record on read, so consumers never see a bare string', () => {
    root = project();
    const record = approve();
    fs.writeFileSync(
      path.join(root, '.wai', 'lock.json'),
      JSON.stringify({ ...record, lockedBy: 'local:someone' }, null, 2),
    );

    expect(readLockRecord()!.lockedBy).toEqual({ id: 'local:someone', source: 'legacy' });
  });

  // -------------------------------------------------------------------------
  // Child pins — the one thing that crosses between separately-approved trees.
  // -------------------------------------------------------------------------

  it('pins only children that have an approval of their own', () => {
    root = project();
    const childRoot = path.join(root, 'packages', 'billing');
    fs.mkdirSync(path.join(childRoot, '.wai'), { recursive: true });

    const mounts = [{ id: 'billing', projectPath: 'packages/billing' }];
    // The child has never been approved — a parent cannot record a decision
    // its owner never made.
    expect(currentChildPins(mounts, root)).toEqual({});

    const childLock = approveAt(childRoot);
    expect(currentChildPins(mounts, root).billing).toBe(pinOf(childLock.stateId));
  });

  it('a child moving is visible to the parent WITHOUT dirtying the parent diff', () => {
    root = project();
    const childRoot = path.join(root, 'packages', 'billing');
    const mounts = [{ id: 'billing', projectPath: 'packages/billing' }];

    approveAt(childRoot);
    approve(TESTER, currentChildPins(mounts, root));
    expect(movedChildren(mounts, root)).toEqual([]);

    // The child re-approves at a different state.
    const second = approveAt(childRoot, 'f'.repeat(64));

    const moved = movedChildren(mounts, root);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe('billing');
    expect(moved[0].now).toBe(pinOf(second.stateId));

    // …and the parent's OWN spec diff is untouched by it.
    expect(diffSize(diffAgainstApproval()!)).toBe(0);
  });
});
