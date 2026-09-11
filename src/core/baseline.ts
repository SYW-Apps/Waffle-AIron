import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { getProjectRoot, ensureDir, pathExists } from '../utils/fs.js';
import { computeGateStateId, snapshotSpecFiles, loadSystemSpec } from './specs.js';
import type { StateId } from './statehash.js';

// ---------------------------------------------------------------------------
// The approval baseline — what the human last said yes to
//
// A review needs two things: the current tree, and the tree as it stood when
// someone approved it. wairon had the first and only a HASH of the second, so
// the only question it could answer was "did anything move?" — surfaced as
// `Lock: STALE` on a tree that validates clean, which tells a human nothing
// about what to look at and gives them no way to approve a subset.
//
// The baseline stores the approved tree itself, so the question becomes "WHAT
// moved?" That one addition is what lets the per-file spec `status` ratchet,
// the lock record's bookkeeping fields, promote, and surface freshness all go:
// each of them existed to approximate an answer this can give exactly.
//
// Two properties are deliberate:
//
//  1. It lives OUTSIDE the working tree. Approving must not dirty the repo —
//     a lock that rewrote hundreds of spec files is the complaint this exists
//     to end. Nothing here is ever written under the project root.
//
//  2. It is per PROJECT ROOT, keyed by that root's path — so every `.wai`,
//     including each chained subproject, owns its own. A parent's approval
//     never freezes a child's in-flight work, and a child cloned on its own
//     still has somewhere to keep its approval. The parent instead PINS each
//     child's approved StateId (see `children`), the way a git submodule pins
//     a commit: a child edit does not dirty the parent, but the parent can
//     still see "this child moved from A to B" and review that.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = '1.0.0';

export interface BaselineRecord {
  schemaVersion: string;
  /** Absolute root this baseline belongs to — for debuggability, never for lookup. */
  projectRoot: string;
  systemName: string;
  approvedAt: string;
  approvedBy: string;
  /** The gate identity (spec content + governing doctrine) at approval. */
  stateId: StateId;
  /** Spec path RELATIVE to the project root → byte-exact content at approval. */
  specs: Record<string, string>;
  /** Chained child mount id → that child's approved StateId digest. */
  children: Record<string, string>;
}

export interface BaselineDiff {
  /** Specs that exist now and did not at approval. */
  added: string[];
  /** Specs whose content differs from the approved copy. */
  changed: string[];
  /** Specs that existed at approval and are gone now. */
  removed: string[];
  /** Specs that still match the approved copy exactly. */
  unchangedPaths: string[];
}

/** Total number of specs that differ from the approved tree. */
export function diffSize(d: BaselineDiff): number {
  return d.added.length + d.changed.length + d.removed.length;
}

/**
 * Where baselines are kept. Outside every project, so approving a project can
 * never write into it. A hosted instance points this at its own data dir.
 */
export function baselineDir(): string {
  return process.env['WAIRON_BASELINE_DIR'] || path.join(os.homedir(), '.wairon', 'baselines');
}

/**
 * The storage key for a project root. Derived from the path so that resolving
 * a baseline needs nothing but the root you are already standing in — no
 * registry, no id to keep in sync, and no file inside the project to lose.
 */
function keyFor(root: string): string {
  const normalized = path.resolve(root).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

function baselinePath(root: string): string {
  return path.join(baselineDir(), `${keyFor(root)}.json`);
}

/** The approved baseline for a project root, or null when it was never approved. */
export function readBaseline(root: string = getProjectRoot()): BaselineRecord | null {
  const p = baselinePath(root);
  if (!pathExists(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BaselineRecord;
  } catch {
    // A corrupt baseline must read as "never approved" rather than throw: the
    // tree is still valid, and the recovery is simply to approve again.
    return null;
  }
}

export function writeBaseline(record: BaselineRecord): string {
  const p = baselinePath(record.projectRoot);
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, `${JSON.stringify(record, null, 2)}\n`);
  return p;
}

/** Forget a project's approval. Used by tests and `wairon baseline reset`. */
export function clearBaseline(root: string = getProjectRoot()): boolean {
  const p = baselinePath(root);
  if (!pathExists(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/** The current spec tree as relative-path → content, the shape a baseline stores. */
function currentSpecs(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [abs, content] of snapshotSpecFiles()) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    out[rel] = content;
  }
  return out;
}

/**
 * Capture the CURRENT tree as approved. The caller is responsible for having
 * gated it — this records a decision, it does not make one.
 */
export function captureBaseline(
  approvedBy: string,
  children: Record<string, string> = {},
  root: string = getProjectRoot(),
  scope?: { paths: Set<string> },
): BaselineRecord {
  const system = loadSystemSpec();
  const current = currentSpecs(root);

  // A SCOPED approval (`lock --subsystem x`) approves only what it covers.
  // Everything outside keeps whatever approval it already had, so approving one
  // subsystem can never silently mark the rest of the tree reviewed — and a
  // spec deleted inside the scope leaves the baseline with it.
  let specs = current;
  if (scope) {
    const previous = readBaseline(root)?.specs ?? {};
    specs = { ...previous };
    for (const rel of Object.keys(previous)) {
      if (scope.paths.has(rel) && current[rel] === undefined) delete specs[rel];
    }
    for (const rel of scope.paths) {
      if (current[rel] !== undefined) specs[rel] = current[rel];
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    projectRoot: path.resolve(root),
    systemName: system?.name ?? path.basename(root),
    approvedAt: new Date().toISOString(),
    approvedBy,
    stateId: computeGateStateId(),
    specs,
    children,
  };
}

/**
 * What changed since approval. Returns null when there is no baseline — which
 * is "never approved", a different state from "approved and unchanged" and one
 * the caller must be able to tell apart.
 */
export function diffAgainstBaseline(root: string = getProjectRoot()): BaselineDiff | null {
  const baseline = readBaseline(root);
  if (!baseline) return null;

  const current = currentSpecs(root);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchangedPaths: string[] = [];

  for (const [rel, content] of Object.entries(current)) {
    const before = baseline.specs[rel];
    if (before === undefined) added.push(rel);
    else if (before !== content) changed.push(rel);
    else unchangedPaths.push(rel);
  }
  for (const rel of Object.keys(baseline.specs)) {
    if (current[rel] === undefined) removed.push(rel);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchangedPaths: unchangedPaths.sort(),
  };
}

/**
 * The spec paths a human has approved AND that have not moved since.
 *
 * This is what replaces the on-disk `status: draft → complete` ratchet. The
 * ratchet existed so that, after approval, ordinary `validate` would stop
 * relaxing completeness findings for specs the human had signed off — but it
 * bought that by rewriting every spec file in the tree, and it was ONE-WAY:
 * editing an approved spec left it marked complete, so the rules kept judging
 * in-flux work at full strictness with no way back short of a manual demotion.
 *
 * Derived settledness is strictly better on both counts. Nothing is written,
 * and a spec that drifts after approval returns to draft context by itself.
 *
 * null when the tree was never approved — then the authored status stands, which
 * is the behaviour a project has before anyone has gated it.
 */
export function settledSpecPaths(root: string = getProjectRoot()): Set<string> | null {
  const diff = diffAgainstBaseline(root);
  return diff ? new Set(diff.unchangedPaths) : null;
}
