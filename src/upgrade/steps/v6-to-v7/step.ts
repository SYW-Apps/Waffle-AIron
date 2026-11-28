import * as fs from 'fs';
import * as path from 'path';
import * as files from './files.js';
import type { V6LockRecord } from './files.js';
import * as core from '../../adapters/core.js';
import { getProjectRoot, runWithProjectRoot, userCacheDir } from '../../../utils/fs.js';
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

/**
 * The approval parts a v6 record and a v7 identity share the projection of. The whole-tree design part is not one:
 * wairon 7 reads the same files differently (a method taking its signature from a source drops the params, returns and
 * signature text the source supplies), so it never equals wairon 6's; the per-spec digests prove the design instead.
 */
const SHARED_PARTS = ['rules', 'composition', 'network'];

/** What each shared part covers, in words a reviewer can check. */
const PART_COVERS: Record<string, string> = {
  rules: "the project's rule configuration",
  composition: 'its composition settings',
  network: 'its declared network',
};

/** The lock record format this step writes. */
const FORMAT = 4;

const LOCK_CHANGE = 'lock.json';
const INPUTS_CHANGE = '.wai/externals.lock.yaml becomes .wai/inputs.lock.yaml';

/**
 * iv6_to_v7_tree_step.familyRoots — the roots of the family under a root, the top first: every project and every
 * part. A part is included: its own externals.lock.yaml and parent entry are converted with the rest, and its specs
 * are copied into the rehearsal with its declaring project. A part has no lock record of its own.
 */
export function familyRoots(root: string): string[] {
  // Step 1: the project graph under the root, through the core, parts included.
  const family = runWithProjectRoot(root, () => core.projectFamily());
  // Step 2: each project's root, then the root of each of its parts that is stored in reach (a git or hosted part is read from a cache).
  const roots = family.nodes.flatMap((n) => [
    n.directory,
    ...n.parts.filter((p) => p.directory !== undefined && p.storage !== 'git' && p.storage !== 'hosted').map((p) => p.directory!),
  ]);
  return [...new Set(roots)];
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
  return { carried: false, compared, moved: [...moved, ...differing.map((p) => `the ${p} part: ${PART_COVERS[p] ?? p} differs`)] };
}

/** The format-4 record exactly as the verdict decided: carried, or the old identity kept with empty parts. */
function rewritten(record: V6LockRecord, verdict: Verdict): LockRecord {
  const { now } = verdict;
  const carried = verdict.carried && now !== undefined;
  const stateId = carried ? { algorithm: now.algorithm, digest: now.digest } : { algorithm: record.stateId.algorithm, digest: record.stateId.digest };
  const next = {
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
  } as Record<string, unknown>;
  // The record keeps the order its keys had; the keys it gains follow them.
  const ordered: Record<string, unknown> = {};
  // The keys format 4 adds take the place of the first key it drops (parts and upgraded where gateParts stood).
  const added = Object.keys(next).filter((key) => !(record.keyOrder ?? []).includes(key));
  const placeAdded = (): void => { for (const key of added) ordered[key] = next[key]; };
  for (const key of record.keyOrder ?? []) {
    if (key in next) ordered[key] = next[key];
    else if (!(added[0] in ordered)) placeAdded();
  }
  placeAdded();
  return ordered as unknown as LockRecord;
}

/** What the pins of a v6 externals lock decide for the project at the bound root. */
interface PinDecisions {
  /** The pins dropped with their snapshots: a path producer's, a member's, and a bare external given its source. */
  dropped: { alias: string; snapshot: string }[];
  /** The bare externals restated with the relative path of their family project. */
  restated: { alias: string; source: string }[];
  /** The bare externals whose pin stays, each with why the family could not give it a source. */
  kept: { alias: string; why: string }[];
}

/** Whether a directory is a folder on disk and not a git cache checkout. */
function liveFolder(dir: string): boolean {
  // A git or hosted member is read from wairon's user cache: no path a declaration could keep.
  const cache = path.resolve(userCacheDir());
  const rel = path.relative(cache, path.resolve(dir));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return false;
  try { return fs.statSync(dir).isDirectory(); } catch { return false; }
}

/** The pins of a v6 externals lock decided: path producers dropped, bare externals bound through the family (steps 15-20 of plan). */
function decide(pins: InputsLock): PinDecisions {
  const out: PinDecisions = { dropped: [], restated: [], kept: [] };
  const config = core.loadProjectConfig();
  if (!config) return out;
  const externals = declaredExternals(config);
  const members = declaredMembers(config);
  const bare = (e: { sourcePath?: string; sourceGit?: string; sourceHosted?: string }): boolean => e.sourcePath === undefined && e.sourceGit === undefined && e.sourceHosted === undefined;
  const bound = externals.some(bare) ? core.resolveExternals(true) : [];
  const root = getProjectRoot();
  for (const [alias, entry] of Object.entries(pins.externals)) {
    if (entry.role === 'member') {
      if (members.some((m) => m.alias === alias && (m.storage === 'contained' || m.storage === 'path'))) out.dropped.push({ alias, snapshot: entry.snapshot });
      continue;
    }
    const declared = externals.find((e) => e.alias === alias);
    if (!declared || declared.sourceGit !== undefined || declared.sourceHosted !== undefined) continue;
    if (declared.sourcePath !== undefined) { out.dropped.push({ alias, snapshot: entry.snapshot }); continue; }
    const binding = bound.find((x) => x.external.alias === alias)?.external;
    if (binding?.sourceKind === 'family' && binding.directory !== undefined && liveFolder(binding.directory)) {
      const rel = path.relative(root, binding.directory).split(path.sep).join('/');
      out.restated.push({ alias, source: rel.startsWith('.') ? rel : './' + rel });
      out.dropped.push({ alias, snapshot: entry.snapshot });
    } else {
      out.kept.push({ alias, why: binding?.problem ?? 'the family answers with no project folder on disk for it' });
    }
  }
  return out;
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
    changes.push({ description: `${LOCK_CHANGE}: format ${from} becomes 4, the approval carried (every spec's design digest and the rules, composition and network proven unchanged; who approved it, and when, are kept)`, design: false });
    return;
  }
  changes.push({ description: `${LOCK_CHANGE}: format ${from} becomes 4, the old identity kept with no parts, so the approval reads stale until \`wairon lock\` approves the design again (who approved it, and when, are kept)`, design: true });
  reported.push(`${LOCK_CHANGE}: the approval was not carried — ${verdict.moved.join('; ')}. One \`wairon lock\` approves the design again.`);
}

/** The planned changes for the inputs: the pins converted, each dropped pin with its snapshot, the packs recorded. */
function inputChanges(pins: InputsLock | null, changes: UpgradeChange[], reported: string[]): void {
  const decided = decide(pins ?? { externals: {}, packs: {} });
  const lock = inputsOf(pins, decided.dropped);
  if (pins !== null) changes.push({ description: INPUTS_CHANGE, design: false });
  else if (holdsEntries(lock)) changes.push({ description: 'record the packs in .wai/inputs.lock.yaml', design: false });
  const given = new Map(decided.restated.map((r) => [r.alias, r.source]));
  for (const d of decided.dropped) {
    const source = given.get(d.alias);
    changes.push({
      description: source === undefined
        ? `${d.alias}: a path producer is read live and never pinned, so its pin and snapshot ${d.snapshot} are dropped`
        : `${d.alias}: given its source \`${source}\` (the relative path to its family project), read live like a path dependency; its pin and snapshot ${d.snapshot} are dropped`,
      design: false,
    });
  }
  for (const k of decided.kept) {
    reported.push(`${k.alias}: an external with no source that the family could not resolve to a project folder (${k.why}), so its pin and declaration are kept. Give it a source with \`sdd_update_external\` (\`source\`) or \`wairon externals use --source\`.`);
  }
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
    inputChanges(files.readExternalsLock(root), changes, reported);
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
  const decided = decide(pins ?? { externals: {}, packs: {} });
  const { dropped } = decided;
  // Steps 10-13: each restated external is taken out and declared again with its source, every other field kept.
  const declarations = core.loadProjectConfig()?.externals ?? {};
  for (const r of decided.restated) {
    const declaration = declarations[r.alias] ?? {};
    core.removeExternal(r.alias);
    core.declareExternal(r.alias, { ...declaration, source: r.source });
  }
  // Steps 14-15.
  files.writeInputsLock(root, inputsOf(pins, dropped));
  // Steps 16-18: the v6 pins file and each dropped snapshot go.
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
    'Path externals are read live and are no longer pinned, and an external with no source is given the relative path of its family project, so the project\'s own gate reads it live too.',
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
