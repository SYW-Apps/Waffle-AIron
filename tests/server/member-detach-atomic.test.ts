import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { upgradeMemberRecords } from '../../src/server/local-admin.js';
import * as memberRegistration from '../../src/server/members.js';
import { existingProjectRoot, resolveProjectBinding } from '../../src/server/projects.js';
import { placeProject } from '../../src/server/organization.js';
import { ensureInstanceIdentity } from '../../src/server/instance.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { runWithProjectBinding } from '../../src/utils/fs.js';
import { seedUnit, subjectOf } from './helpers.js';
import { buildHostedFamily } from './hosted-family.js';
import type { Principal } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Stage 7 wave B — a hosted detach relocates the member all or nothing.
//
// The detach is planned and applied once to count the file-system write
// positions of its apply (the family transaction's stage and swap — the
// member's files leaving as deletes and arriving at the new root as creates,
// the family edits, the host stores — and the audit append and commit after
// it). Then, on a fresh fixture each time, a failure is injected at EVERY
// position: the data directory must be byte-identical to before (no new root,
// no half-moved member, no journal) — or, when the failure struck after the
// commit point, fully moved. The fs module is wrapped, not replaced: the hook
// throws before the k-th wrapped operation and passes every other call on.
// ---------------------------------------------------------------------------

const hook = vi.hoisted(() => ({
  before: null as null | ((op: string) => Error | undefined),
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const wrap = <A extends unknown[], R>(op: string, fn: (...args: A) => R) => (...args: A): R => {
    const injected = hook.before?.(op);
    if (injected) throw injected;
    return fn(...args);
  };
  const mocked = {
    ...actual,
    renameSync: wrap('rename', actual.renameSync),
    writeSync: wrap('write', actual.writeSync as (...args: unknown[]) => number),
    writeFileSync: wrap('writeFile', actual.writeFileSync),
    appendFileSync: wrap('appendFile', actual.appendFileSync),
    unlinkSync: wrap('unlink', actual.unlinkSync),
    mkdirSync: wrap('mkdir', actual.mkdirSync),
    rmdirSync: wrap('rmdir', actual.rmdirSync),
  };
  return { ...mocked, default: mocked };
});

const ioError = (): Error => Object.assign(new Error('injected EIO'), { code: 'EIO' });
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA'] as const;
const PRINCIPAL: Principal = {
  tokenId: 'tok-op', role: 'admin', projects: ['*'], authenticated: true, subject: subjectOf('u-op'),
  permissionSubject: { subjectId: 'u-op', roleBindings: [], instanceAdmin: true },
};

describe('stage 7 — a hosted detach relocates the member atomic-or-nothing', () => {
  let base: string;
  let savedEnv: (readonly [string, string | undefined])[];

  beforeEach(() => {
    savedEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-stage7-detach-'));
    for (const k of ENV_KEYS) process.env[k] = path.join(base, 'home');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    hook.before = null;
    vi.restoreAllMocks();
    invalidateSpecCache();
    for (const [k, v] of savedEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* windows locks */ }
  });

  /** A fresh data dir: the fixture family, upgraded, its root placed in a unit. */
  function fresh(k: number): string {
    const dir = path.join(base, `data-${k}`);
    fs.mkdirSync(dir, { recursive: true });
    ensureInstanceIdentity(dir);
    buildHostedFamily(dir);
    const unit = seedUnit(dir, 'eng');
    placeProject(dir, { id: '', projectId: 'platform', unitId: unit.id, role: 'owner', createdAt: '', createdBy: subjectOf('u-seed') });
    expect(upgradeMemberRecords(dir, true).applied).toBe(true);
    invalidateSpecCache();
    return dir;
  }

  /** Detach billing from platform, bound as the data plane binds a request (its reach and the hosted record lookup). */
  function detach(dir: string) {
    const binding = resolveProjectBinding(dir, PRINCIPAL, 'platform')!;
    const reach = { topRoot: binding.rootPath, parentReach: true, unwritableRoots: [], hostedLookup: (id: string) => existingProjectRoot(dir, id) };
    invalidateSpecCache();
    return runWithProjectBinding(binding.rootPath, reach, () => memberRegistration.detach(dir, PRINCIPAL, binding, 'billing', true));
  }

  /** Every file and directory under the data dir's stores and projects, by digest — audit and sessions aside. */
  function state(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (at: string): void => {
      for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
        const full = path.join(at, entry.name);
        const rel = path.relative(dir, full).split(path.sep).join('/');
        if (rel.startsWith('audit') || rel.startsWith('web-sessions')) continue;
        if (entry.isDirectory()) {
          out[`${rel}/`] = 'dir';
          walk(full);
        } else out[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    };
    walk(dir);
    return out;
  }

  /** The member's own files, relative to wherever it lives. */
  const memberFiles = (root: string): Record<string, string> => {
    const all = state(root);
    return Object.fromEntries(Object.entries(all).filter(([k]) => !k.endsWith('/')));
  };

  it('a failure at every write position leaves the data directory as before, or fully moved', () => {
    // Count the wrapped operations of one clean apply.
    const clean = fresh(0);
    const memberBefore = memberFiles(path.join(clean, 'projects', 'platform', 'packages', 'billing'));
    let positions = 0;
    hook.before = () => { positions++; return undefined; };
    const report = detach(clean);
    hook.before = null;
    expect(report.applied, JSON.stringify(report.plan.refusals)).toBe(true);
    expect(memberFiles(path.join(clean, 'projects', 'billing'))).toEqual(memberBefore);
    expect(positions).toBeGreaterThan(20);

    let rolledBack = 0;
    for (let k = 1; k <= positions; k++) {
      const dir = fresh(k);
      const before = state(dir);
      const oldDir = path.join(dir, 'projects', 'platform', 'packages', 'billing');
      const newRoot = path.join(dir, 'projects', 'billing');
      const own = memberFiles(oldDir);
      let n = 0;
      hook.before = () => (++n === k ? ioError() : undefined);
      let applied: boolean;
      let restored: boolean | undefined;
      try {
        const r = detach(dir);
        applied = r.applied;
        // A failure on the rehearsal copy (the verb's own writes) is a refusal: nothing was committed.
        restored = r.outcome ? r.outcome.restored : r.plan.refusals.length > 0 ? true : undefined;
      } catch {
        // A failure before the transaction began (the plan or the rehearsal) writes nothing live.
        applied = false;
        restored = true;
      }
      hook.before = null;
      if (applied) {
        // Struck after the commit point: fully moved, byte-identical at the new root. Only the
        // directory cleanup can be cut short there, leaving at most an empty directory, never a file.
        expect(fs.existsSync(oldDir) ? memberFiles(oldDir) : {}, `position ${k}`).toEqual({});
        expect(memberFiles(newRoot), `position ${k}`).toEqual(own);
      } else {
        rolledBack++;
        expect({ k, restored }).toEqual({ k, restored: true });
        expect(state(dir), `position ${k}`).toEqual(before);
      }
      expect(fs.existsSync(path.join(dir, '.wai', 'transactions')), `position ${k}`).toBe(false);
    }
    expect(rolledBack).toBeGreaterThan(0);
  }, 600_000);
});
