import * as files from './files.js';
import type { V6LockRecord } from './files.js';
import * as core from '../../adapters/core.js';
import { getProjectRoot, runWithProjectRoot } from '../../../utils/fs.js';
import { declaredExternals, declaredMembers } from '../../../models/project.js';
import type { InputsLock } from '../../../models/specs.js';
import type { LockRecord } from '../../../core/index.js';
import { StepRefused } from '../../types.js';
import type { StepPlan, UpgradeChange, UpgradeStep } from '../../types.js';

// ---------------------------------------------------------------------------
// v6_to_v7_tree_step — the one kept step of the chain: moves a project from
// wairon 6's lock forms to wairon 7's, one project at a time, planned and
// written onto the rehearsal root the orchestrator binds. Spec forms are
// unchanged between the majors, so it rewrites the lock files only: the
// format-2/3 lock record becomes format 4, carrying the approval only when the
// per-spec design digests and the design, rules, composition and network parts
// prove it unchanged (otherwise it keeps its old identity and reads stale until
// one re-lock); .wai/externals.lock.yaml becomes .wai/inputs.lock.yaml,
// dropping the pins of path producers (read live in v7) and recording the packs
// as they resolve. A tree still holding wairon 5 forms is refused.
//
// The comparison that decides whether an approval is carried runs in plan and
// again in write, on the same rehearsal content, so both answer alike.
// ---------------------------------------------------------------------------

const STEP: UpgradeStep = { from: 6, to: 7 };

/** The approval parts a v6 record and a v7 identity share the projection of. */
const SHARED_PARTS = ['design', 'rules', 'composition', 'network'];

/** The lock record format this step writes. */
const FORMAT = 4;

const LOCK_CHANGE = 'lock.json';
const INPUTS_CHANGE = '.wai/externals.lock.yaml becomes .wai/inputs.lock.yaml';

/** iv6_to_v7_tree_step.familyRoots — the project roots of the family under a root, the top first (parts are left out: a part has no lock of its own). */
export function familyRoots(root: string): string[] {
  // Step 1: the project graph under the root, through the core.
  const family = runWithProjectRoot(root, () => core.projectFamily());
  // Step 2.
  return family.nodes.map((n) => n.directory);
}

/** What the comparison of a v6 record with the tree decided. */
interface Verdict {
  carried: boolean;
  /** The identity and its parts a carried record writes. */
  now?: { algorithm: string; digest: string; parts: Record<string, string> };
  /** What was compared (carried), or what could not be compared or did not match (not carried). */
  compared: string[];
  /** What moved, one line each, for a record not carried. */
  moved: string[];
}

/** The record rewrite is owed only for a record of an earlier format. */
function rewritable(record: V6LockRecord | null): record is V6LockRecord {
  return record !== null && (record.format ?? 1) < FORMAT;
}

/** The own specs added, changed or removed since the record, named. */
function specsMoved(recorded: Record<string, string>, captured: Record<string, string>): string[] {
  const names = [...new Set([...Object.keys(recorded), ...Object.keys(captured)])].sort();
  const lines: string[] = [];
  for (const spec of names) {
    if (recorded[spec] === undefined) lines.push(`spec added: ${spec}`);
    else if (captured[spec] === undefined) lines.push(`spec removed: ${spec}`);
    else if (recorded[spec] !== captured[spec]) lines.push(`spec changed: ${spec}`);
  }
  return lines;
}

/** Whether a record's approval can be compared at all: a design reading of the specs and the gate parts beside it. */
function comparable(record: V6LockRecord): boolean {
  return record.format !== undefined && record.specsReading === 'design' && record.specs !== undefined && record.gateParts !== undefined;
}

/** The comparison of a record with the tree as it stands at the bound root. */
function compare(record: V6LockRecord): Verdict {
  // Step 6 (plan) / the branch of write: nothing to compare without a design reading and gate parts.
  if (!comparable(record)) {
    return { carried: false, compared: ['specs', ...SHARED_PARTS], moved: ['its approval predates what wairon 6 recorded to prove it, so it cannot be compared'] };
  }
  // Step 7: one design digest per own spec of the tree now.
  const captured = core.captureApprovedSpecs();
  // Step 8: the approval identity now, with its parts.
  const identity = core.computeApprovalId();
  // Step 9: the digests and the four shared parts.
  const now = identity.parts ?? {};
  const moved = specsMoved(record.specs ?? {}, captured);
  const differing = SHARED_PARTS.filter((p) => (record.gateParts ?? {})[p] !== now[p]);
  const compared = [...(moved.length > 0 ? ['specs'] : []), ...differing];
  if (moved.length === 0 && differing.length === 0) {
    return { carried: true, now: { algorithm: identity.algorithm, digest: identity.digest, parts: now }, compared: ['specs', ...SHARED_PARTS], moved: [] };
  }
  return { carried: false, compared, moved: [...moved, ...differing.map((p) => `the ${p} part differs`)] };
}

/** The format-4 record exactly as the verdict decided: carried, or the old identity kept with empty parts. */
function rewritten(record: V6LockRecord, verdict: Verdict): LockRecord {
  const { now } = verdict;
  const carried = verdict.carried && now !== undefined;
  const stateId = carried ? { algorithm: now.algorithm, digest: now.digest } : { algorithm: record.stateId.algorithm, digest: record.stateId.digest };
  return {
    stateId,
    lockedAt: record.lockedAt,
    lockedBy: record.lockedBy ?? { id: 'unknown', source: 'legacy' },
    validatorVersion: record.validatorVersion ?? 'unknown',
    validationResult: record.validationResult ?? { valid: true, errors: 0, warnings: 0 },
    status: 'ready',
    specs: record.specs ?? {},
    format: FORMAT,
    parts: carried ? { ...now.parts } : {},
    upgraded: { at: new Date().toISOString(), fromFormat: record.format ?? 1, compared: verdict.compared, carried },
    ...(record.code ? { code: record.code } : {}),
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.commitSha ? { commitSha: record.commitSha } : {}),
    ...(record.compareUrl ? { compareUrl: record.compareUrl } : {}),
  } as LockRecord;
}

/** Each path producer's pin of a v6 externals lock: the alias, and the snapshot file it names. */
function pathPins(pins: InputsLock): { alias: string; snapshot: string }[] {
  const config = core.loadProjectConfig();
  if (!config) return [];
  const externals = declaredExternals(config);
  const members = declaredMembers(config);
  return Object.entries(pins.externals).flatMap(([alias, entry]) => {
    const live = entry.role === 'member'
      ? members.some((m) => m.alias === alias && (m.storage === 'contained' || m.storage === 'path'))
      : externals.some((e) => e.alias === alias && e.sourceGit === undefined && e.sourceHosted === undefined);
    return live ? [{ alias, snapshot: entry.snapshot }] : [];
  });
}

/** The inputs lock the v6 pins and the packs make: the hosted and git entries and a part's parent kept, the path producers dropped. */
function inputsOf(pins: InputsLock | null, dropped: { alias: string }[]): InputsLock {
  const gone = new Set(dropped.map((d) => d.alias));
  const externals = Object.fromEntries(Object.entries(pins?.externals ?? {}).filter(([alias]) => !gone.has(alias)));
  return { externals, ...(pins?.parent ? { parent: pins.parent } : {}), packs: core.resolvedPacks() };
}

/** Whether the inputs lock this plan makes holds anything to write. */
function holdsEntries(lock: InputsLock): boolean {
  return Object.keys(lock.externals).length > 0 || lock.parent !== undefined || Object.keys(lock.packs).length > 0;
}

/** The planned changes for the record and what is reported for an author. */
function recordChanges(record: V6LockRecord | null, changes: UpgradeChange[], reported: string[]): void {
  if (!rewritable(record)) return;
  const verdict = compare(record);
  const from = record.format ?? 1;
  if (verdict.carried) {
    changes.push({ description: `${LOCK_CHANGE}: format ${from} becomes 4, the approval carried (the design, rules, composition and network proven unchanged; who approved it, and when, are kept)`, design: false });
    return;
  }
  changes.push({ description: `${LOCK_CHANGE}: format ${from} becomes 4, the old identity kept with no parts, so the approval reads stale until \`wairon lock\` approves the design again (who approved it, and when, are kept)`, design: true });
  reported.push(`${LOCK_CHANGE}: the approval was not carried — ${verdict.moved.join('; ')}. One \`wairon lock\` approves the design again.`);
}

/** The planned changes for the inputs: the pins converted, each path pin dropped with its snapshot, the packs recorded. */
function inputChanges(pins: InputsLock | null, changes: UpgradeChange[]): void {
  const dropped = pathPins(pins ?? { externals: {}, packs: {} });
  const lock = inputsOf(pins, dropped);
  if (pins !== null) changes.push({ description: INPUTS_CHANGE, design: false });
  else if (holdsEntries(lock)) changes.push({ description: 'record the packs in .wai/inputs.lock.yaml', design: false });
  for (const d of dropped) changes.push({ description: `${d.alias}: a path producer is read live and never pinned, so its pin and snapshot ${d.snapshot} are dropped`, design: false });
}

/** iv6_to_v7_tree_step.plan — what moving the project at the bound root from v6 to v7 rewrites, without writing anything. */
export function plan(root: string): StepPlan {
  return runWithProjectRoot(root, () => {
    const changes: UpgradeChange[] = [];
    const reported: string[] = [];
    // Steps 1-4: a tree still holding a wairon 5 form is refused.
    const legacy = core.findLegacySpecFiles();
    const issues = core.getLoaderIssues();
    if (legacy.length > 0 || issues.some((i) => /wairon 5 form/.test(i.message))) {
      throw new StepRefused('this tree was written by wairon 5, which this release no longer reads: upgrade it with wairon 6 first (`npx wairon@6 upgrade`), then run `wairon upgrade` again');
    }
    // Steps 5-14: the lock record.
    recordChanges(files.readRecord(root), changes, reported);
    // Steps 15-18: the inputs.
    inputChanges(files.readExternalsLock(root), changes);
    // Step 19.
    return { step: { ...STEP }, project: root, changes, reported };
  });
}

/** Write the format-4 record onto the bound root (steps 1-6 of write). */
function writeRecord(root: string): void {
  // Step 1: the record as wairon 6 wrote it.
  const record = files.readRecord(root);
  // Step 2: none to rewrite when there is no record (or it is format 4 already).
  if (!rewritable(record)) return;
  // Steps 3-5: the comparison, and the record assembled as plan decided.
  const next = rewritten(record, compare(record));
  // Step 6.
  core.writeLockRecord(next);
}

/** Write the inputs lock and remove the v6 pins file and the dropped snapshots (steps 7-14 of write). */
function writeInputs(root: string): void {
  // Steps 7-9.
  const pins = files.readExternalsLock(root);
  const dropped = pathPins(pins ?? { externals: {}, packs: {} });
  // Steps 10-11.
  files.writeInputsLock(root, inputsOf(pins, dropped));
  // Steps 12-13: the v6 pins file and each dropped snapshot go.
  const gone = pins === null ? [] : ['.wai/externals.lock.yaml', ...dropped.map((d) => d.snapshot)];
  for (const file of gone) files.removeFile(root, file);
}

/** iv6_to_v7_tree_step.write — write a step plan onto the bound root (a rehearsal copy, never a live tree). */
export function write(_plan: StepPlan): void {
  const root = getProjectRoot();
  writeRecord(root);
  writeInputs(root);
  // Step 14.
}

/** iv6_to_v7_tree_step.whatChanged — the short, user-facing account of what moving to v7 changes for a project. */
export function whatChanged(): string[] {
  // Steps 1-2.
  return [
    'The approval covers the project\'s own design and policy only, so a release, a re-pin or a member\'s re-lock never re-opens it.',
    '.wai/inputs.lock.yaml replaces .wai/externals.lock.yaml and also records the packs.',
    'Path externals are read live and are no longer pinned.',
    'A member\'s approval is its own lock: its parent never records it.',
    'A lock record whose approval could not be proven unchanged needs one `wairon lock`.',
  ];
}

/**
 * iv6_to_v7_tree_step.unfinished — the roots whose tree still holds a wairon 6
 * lock form (a lock record before format 4, or a .wai/externals.lock.yaml): an
 * upgrade an earlier run committed without finishing, which the step runs again.
 */
export function unfinished(roots: string[]): string[] {
  const kept: string[] = [];
  // Step 1.
  for (const root of roots) {
    // Steps 2-4.
    const record = files.readRecord(root);
    const pins = files.readExternalsLock(root);
    if (rewritable(record) || pins !== null) kept.push(root);
  }
  // Step 5.
  return kept;
}

// Test seam: the descriptions of the lock and inputs changes.
export { INPUTS_CHANGE, LOCK_CHANGE };
