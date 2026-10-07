import * as crypto from 'crypto';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { snapshotSpecFiles, graph, scanAllSpecs } from './specs.js';
import { readLockRecord, readLockRecordAt } from './lockfile.js';
import { describeApprover, type ProjectApproval, type SpecDigestReading } from '../models/lock.js';
import { parseYaml } from '../utils/yaml.js';
import { canonicalize } from '../utils/canonical-json.js';
import {
  componentDesignView, implementationDesignView, interfaceDesignView, subsystemDesignView, typeDesignView,
  type SpecStatus,
} from '../models/specs.js';
import { approvalKeyIn } from '../models/project-family.js';
import type { LockRecord } from './lockfile.js';
import type { StateId } from './statehash.js';

// ---------------------------------------------------------------------------
// The approval — what the human last said yes to
//
// A review needs two things: the current tree, and the tree as it stood when
// someone approved it. wairon had the first and only a whole-tree HASH of the
// second, so the only question it could answer was "did anything move?" —
// surfaced as `Lock: STALE` on a tree that validates clean, which tells a human
// nothing about what to look at.
//
// The answer is one digest PER SPEC FILE, carried in the committed lock record
// (`LockRecord.specs`). That is enough for every question anything actually
// asks — which specs moved, which are still settled, which are new — because no
// consumer ever needed the approved CONTENT, only whether it still matches. For
// the content itself there is already git: the lock is committed, so
// `git diff <lock commit> -- .wai/specs` is the real diff, and better.
//
// Three properties fall out, and all three are the point:
//
//  1. It is COMMITTED, so a teammate, a fresh clone and CI all see the same
//     approval the approver saw. A machine-local record could not.
//  2. It is ~90 KB for a 786-spec tree instead of ~2 MB of content, and it is
//     written with sorted keys — so a re-lock's diff is one line per spec that
//     was actually re-approved, which is a good signal in a PR rather than
//     noise. That is categorically different from the ratchet this replaced,
//     which rewrote hundreds of SPEC files for a decision that changed no
//     design.
//  3. It is per PROJECT ROOT, because each `.wai` has its own lock — including
//     every member. A parent approval never freezes a member's in-flight work;
//     the parent records each direct member's composition subject instead
//     (`members`, stage 5), the way a git submodule pins a commit — and a
//     member's state and pin are the validator's to compute, since they need
//     gate identities (validator_portal.familyApprovals).
// ---------------------------------------------------------------------------

export interface ApprovalDiff {
  /** Specs that exist now and did not at approval. */
  added: string[];
  /** Specs whose content differs from the approved copy. */
  changed: string[];
  /** Specs that existed at approval and are gone now. */
  removed: string[];
  /** Specs that still match the approved copy exactly. */
  unchangedPaths: string[];
  /**
   * Specs whose storage moved with their content unchanged — a part's folder
   * relocating them — each `<approved path> -> <path now>`. No design change:
   * in none of the three change lists, the new path among unchangedPaths, and
   * left out of diffSize, so `lock` and `lock-check` agree on a storage move.
   */
  moved: string[];
}

/**
 * Total number of specs that differ from the approved tree.
 *
 * Arithmetic over the diff's own fields, so it belongs to the VALUE rather than
 * to the component that builds one — a caller holding a diff should not have to
 * reach for a service to count it. It stays a free function taking the value
 * because `ApprovalDiff` is plain data: it is built as an object literal, read
 * back out of nothing, and compared field-by-field in tests. Making the count a
 * real method would mean a class, and a class would buy nothing but the dot.
 */
export function diffSize(d: ApprovalDiff): number {
  return d.added.length + d.changed.length + d.removed.length;
}

/**
 * The digest a spec's approved state is recorded as.
 *
 * Line endings are normalized first, and that is load-bearing rather than
 * tidiness: this record is COMMITTED, so the machine that approves and the
 * machine that reads it back are routinely different ones. Git rewrites line
 * endings on checkout (`core.autocrlf`), so an approval taken on Windows and
 * read on a Linux CI runner would otherwise differ in EVERY spec — the feature
 * would report a fully drifted tree on a tree nobody touched.
 *
 * Note what this digest is NOT: the gate StateId, which hashes the PARSED tree
 * and so ignores formatting entirely. They answer different questions — "has
 * this file changed since you approved it" versus "has the design changed" — so
 * a whitespace-only edit legitimately moves one and not the other.
 */
function digest(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** The spec kinds whose design view drops more than the timestamps: code linkage, readiness, or both. */
type LinkedKind = 'implementation' | 'type' | 'component' | 'subsystem' | 'interface';

/** Design digests already taken, by kind and content: a tree is digested on every status and validate. */
const designDigestMemo = new Map<string, string>();

/**
 * The DESIGN digest of one spec file (lock format 3): the parsed spec
 * projected to its design view — an implementation, type or component through
 * its type's designView, every other kind with its timestamps dropped (which
 * canonicalize does at every depth) — canonicalized and digested. Code linkage,
 * whitespace, key order and a no-op re-save never move it. A file that does not
 * parse is digested in the content reading instead, so it is still recorded
 * and any edit to it still shows.
 */
function designDigest(kind: LinkedKind | undefined, content: string): string {
  const key = `${kind ?? ''}\u0000${content}`;
  const memo = designDigestMemo.get(key);
  if (memo !== undefined) return memo;
  const parsed = parsedSpec(content);
  if (!parsed) return digest(content);
  const out = viewDigest(designViewOf(kind, parsed));
  if (designDigestMemo.size > 20000) designDigestMemo.clear();
  designDigestMemo.set(key, out);
  return out;
}

/** Every status a spec can be stored with: none, or one of the three. */
const STATUS_CANDIDATES: ReadonlyArray<SpecStatus | undefined> = [undefined, 'draft', 'design', 'complete'];

/** A parsed spec file projected to the design view of its kind; a kind with no view (the L0, a group) as it is. */
function designViewOf(kind: LinkedKind | undefined, parsed: object): object {
  switch (kind) {
    case 'implementation': return implementationDesignView(parsed);
    case 'type': return typeDesignView(parsed);
    case 'component': return componentDesignView(parsed);
    case 'subsystem': return subsystemDesignView(parsed);
    case 'interface': return interfaceDesignView(parsed);
    default: return parsed;
  }
}

/** A spec file's content parsed into an object, or null when it does not parse into one. */
function parsedSpec(content: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

/** sha256 of a projected spec's canonical form, in hex. */
function viewDigest(view: object): string {
  return crypto.createHash('sha256').update(canonicalize(view), 'utf8').digest('hex');
}

/**
 * The status a recorded design digest says a spec file was approved with: the
 * file's design view with each candidate status put back (none, draft, design,
 * complete) — the view the EARLIER design reading took, which still carried
 * status — digested and compared with the recorded digest. `null` for a spec
 * approved with no status stored; undefined when no candidate matches (the
 * spec moved in its design) or the file does not parse.
 */
function statusApprovedIn(kind: LinkedKind | undefined, content: string, recorded: string): SpecStatus | null | undefined {
  const parsed = parsedSpec(content);
  if (!parsed) return undefined;
  const view = designViewOf(kind, parsed) as Record<string, unknown>;
  for (const status of STATUS_CANDIDATES) {
    const candidate = status === undefined ? view : { ...view, status };
    if (viewDigest(candidate) === recorded) return status ?? null;
  }
  return undefined;
}

/**
 * Whether a spec file as it stands still matches the design digest an
 * approval recorded for it: the same digest, or — for a digest taken while the
 * view still carried status — the same design under some status. Status is
 * readiness, not design, so a spec whose status alone moved still matches.
 */
function designMatches(kind: LinkedKind | undefined, content: string, current: string, recorded: string): boolean {
  return current === recorded || statusApprovedIn(kind, content, recorded) !== undefined;
}

/** Each scanned spec file of a linked kind, by its resolved path. */
function linkedKindsByFile(): Map<string, LinkedKind> {
  const paths = scanAllSpecs().paths;
  const kinds = new Map<string, LinkedKind>();
  for (const kind of ['implementation', 'type', 'component', 'subsystem', 'interface'] as const) {
    for (const file of Object.values(paths[kind])) kinds.set(path.resolve(file), kind);
  }
  return kinds;
}

/** One spec file's digest in the named reading. */
function digestIn(reading: SpecDigestReading, kind: LinkedKind | undefined, content: string): string {
  return reading === 'design' ? designDigest(kind, content) : digest(content);
}

/** The reading a record's `specs` were digested in: `design` when it names it, else the raw content. */
function readingOf(record: LockRecord | null): SpecDigestReading {
  return record?.specsReading === 'design' ? 'design' : 'content';
}

/**
 * The current spec tree as relative-path → content digest: the shape an
 * approval records.
 *
 * `snapshotSpecFiles` federates recursively (`scanAll` defaults to
 * `recursive: true`), so it returns every chained child's specs too. A parent
 * approval must not contain them: the trees are approved separately, so
 * capturing a child's specs here would mean a parent approval silently freezes
 * work the parent does not own — and every child edit would dirty the parent's
 * diff, which is exactly what the child PIN exists to replace.
 */
export function currentSpecDigests(root: string = getProjectRoot(), reading: SpecDigestReading = 'design'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ownSpecFiles(root)) out[file.key] = digestIn(reading, file.kind, file.content);
  return out;
}

/** The bound project's own spec files (its parts' included, a member project's never): key, kind and content. */
function ownSpecFiles(root: string): Array<{ key: string; kind: LinkedKind | undefined; content: string }> {
  // Every member the scan read, in either declaration form (stage 3: a member is
  // a project of its own, never a subsystem of this one).
  const nodes = graph().nodes;
  const mountDirs = nodes
    .filter((n) => n.namespace !== '')
    .map((n) => `${path.resolve(n.directory).split(path.sep).join('/')}/`);
  // A part's files ARE this project's own (stage 8), keyed `members/<alias>/…`.
  const parts = nodes.find((n) => n.namespace === '')?.parts ?? [];

  const kinds = linkedKindsByFile();
  const out: Array<{ key: string; kind: LinkedKind | undefined; content: string }> = [];
  for (const [abs, content] of snapshotSpecFiles()) {
    const normalized = path.resolve(abs).split(path.sep).join('/');
    if (mountDirs.some((dir) => normalized.startsWith(dir))) continue;
    out.push({ key: approvalKeyIn(abs, root, parts), kind: kinds.get(path.resolve(abs)), content });
  }
  return out;
}

/**
 * The `specs` map to record as approved. The caller is responsible for having
 * gated the tree — this describes a decision, it does not make one.
 *
 * A SCOPED approval (`lock --subsystem x`) approves only what it covers.
 * Everything outside keeps whatever approval it already had, so approving one
 * subsystem can never silently mark the rest of the tree reviewed — and a spec
 * deleted inside the scope leaves the record with it.
 */
export function captureApprovedSpecs(
  root: string = getProjectRoot(),
  scope?: { paths: Set<string> },
): Record<string, string> {
  const current = currentSpecDigests(root, 'design');
  if (!scope) return current;

  // A scope names files by their path from the root; a part's file is approved
  // under its storage-independent key (stage 8).
  const parts = graph().nodes.find((n) => n.namespace === '')?.parts ?? [];
  const keys = new Set([...scope.paths].map((rel) => approvalKeyIn(path.resolve(root, rel), root, parts)));
  const previous = inDesignReading(readLockRecord(), root);
  const specs: Record<string, string> = { ...previous };
  for (const rel of Object.keys(previous)) {
    if (keys.has(rel) && current[rel] === undefined) delete specs[rel];
  }
  for (const rel of keys) {
    if (current[rel] !== undefined) specs[rel] = current[rel];
  }
  return specs;
}

/**
 * The previous approval's digests carried into the design reading for a
 * scoped re-lock: a design-reading record as it is; an earlier (content)
 * record's entry converted only where the file still matches it exactly —
 * then its design digest IS what was approved — and kept as written otherwise,
 * so a file that moved since keeps reading changed.
 */
function inDesignReading(record: LockRecord | null, root: string): Record<string, string> {
  const previous = record?.specs ?? {};
  if (readingOf(record) === 'design') return previous;
  const files = new Map(ownSpecFiles(root).map((f) => [f.key, f]));
  const out: Record<string, string> = {};
  for (const [key, approved] of Object.entries(previous)) {
    const file = files.get(key);
    out[key] = file && digest(file.content) === approved ? designDigest(file.kind, file.content) : approved;
  }
  return out;
}

/**
 * What changed since approval. Returns null when nothing was ever approved —
 * a different state from "approved and unchanged", and one the caller must be
 * able to tell apart.
 *
 * Also null for a lock written before the per-spec record existed: such a lock
 * proves the tree validated, but cannot say WHICH specs moved. Reporting
 * surfaces say so and point at re-locking rather than inventing an answer.
 */
export function diffAgainstApproval(root: string = getProjectRoot()): ApprovalDiff | null {
  const record = approvalRecord(root);
  const approved = record?.specs ?? null;
  if (!approved) return null;

  // Compared in the reading the record names — never one reading against the other.
  const reading = readingOf(record);
  const files = new Map(ownSpecFiles(root).map((f) => [f.key, f]));
  const current: Record<string, string> = {};
  for (const [key, file] of files) current[key] = digestIn(reading, file.kind, file.content);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchangedPaths: string[] = [];

  // In the design reading a status that moved alone is no change: status is
  // readiness, and a digest taken while the view still carried it is compared
  // with every status a spec can have.
  const same = (rel: string, before: string, now: string): boolean => {
    if (before === now) return true;
    if (reading !== 'design') return false;
    const file = files.get(rel)!;
    return designMatches(file.kind, file.content, now, before);
  };
  for (const [rel, d] of Object.entries(current)) {
    const before = approved[rel];
    if (before === undefined) added.push(rel);
    else if (!same(rel, before, d)) changed.push(rel);
    else unchangedPaths.push(rel);
  }
  for (const rel of Object.keys(approved)) {
    if (current[rel] === undefined) removed.push(rel);
  }

  // A spec whose storage moved and whose content did not is one spec, not an
  // addition and a removal: pair each added path with a removed one carrying
  // the same digest, in path order, each used once.
  const moved: string[] = [];
  const unpaired = [...removed].sort();
  for (const rel of [...added].sort()) {
    const at = unpaired.findIndex((old) => approved[old] === current[rel]);
    if (at < 0) continue;
    const [old] = unpaired.splice(at, 1);
    moved.push(`${old} -> ${rel}`);
    added.splice(added.indexOf(rel), 1);
    removed.splice(removed.indexOf(old), 1);
    unchangedPaths.push(rel);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchangedPaths: unchangedPaths.sort(),
    moved,
  };
}

/** The lock record governing a root. Always resolved from the root itself, so a
 *  parent reading a child's approval takes the same path as reading its own. */
export function approvalRecord(root: string = getProjectRoot()): LockRecord | null {
  return readLockRecordAt(root);
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
 * Derived settledness is strictly better on both counts. Nothing is written
 * into the tree, and a spec that drifts after approval returns to draft context
 * by itself.
 *
 * null when the tree was never approved — then the authored status stands,
 * which is the behaviour a project has before anyone has gated it.
 */
export function settledSpecPaths(root: string = getProjectRoot()): Set<string> | null {
  const diff = diffAgainstApproval(root);
  return diff ? new Set(diff.unchangedPaths) : null;
}

/** The command a re-expression names as its author: never a person. */
export const REEXPRESSED_BY = 'wairon doctor --fix';

/**
 * approval_comparison.reexpress — the record on file carried into the current
 * reading WITHOUT a new approval, when that is provably sound. (1) The
 * identity it certified still holds: a format-2 record, or one taken in the
 * earlier design reading (status still in the view), whose stateId equals
 * gate.asRecorded — that identity recomputed over the tree as it stands. Keeps
 * lockedAt, lockedBy, the validation and code results, the members' pins and
 * the provenance exactly; replaces stateId with the gate (asRecorded dropped),
 * specs with the current design-reading capture, and adds `reexpressed`. (2) A
 * format-2 record whose identity no longer holds but whose every own spec file
 * still matches its raw-content digest: only the gate it was judged under
 * moved, never the tree, so its reading is carried and its stateId stays the
 * identity it certified — the lock still reads stale, now for the stated
 * cause, until one `wairon lock`. Null when there is nothing to carry or it
 * cannot be proven. Writes nothing: the caller writes the answer.
 */
export function reexpress(gate: StateId): LockRecord | null {
  // Step 1: the record of the bound project.
  const record = readLockRecord();
  if (!record) return null;
  const fromReading = readingOf(record);
  // Step 2: an earlier-reading record whose certified identity still holds.
  const asRecorded = gate.asRecorded;
  const holds = !!asRecorded && record.stateId.algorithm === asRecorded.algorithm && record.stateId.digest === asRecorded.digest;
  const reexpressed = { at: new Date().toISOString(), fromAlgorithm: record.stateId.algorithm, fromReading, by: REEXPRESSED_BY };
  if (holds) {
    // Steps 3-5: the carried record — the approval stays the approver's.
    return {
      ...record,
      stateId: { algorithm: gate.algorithm, digest: gate.digest },
      specs: captureApprovedSpecs(),
      specsReading: 'design',
      format: 3,
      reexpressed,
    };
  }
  // Step 6: a format-2 record over a tree no file of which moved, not even in
  // code linkage — only the gate it was judged under did.
  if (fromReading !== 'content' || !record.specs) return null;
  const diff = diffAgainstApproval();
  if (!diff || diffSize(diff) > 0) return null;
  // Steps 7-9: the reading carried, the claim kept as certified.
  return { ...record, specs: captureApprovedSpecs(), specsReading: 'design', format: 3, reexpressed };
}

/**
 * approval_comparison.approvedStatuses — the status each own spec had when a
 * design-reading record was approved, keyed `<kind>:<id>`: a spec whose design
 * view WITH a candidate status digests to the recorded digest was approved
 * with that status (none reads as complete, as the loader parses it). A spec
 * matching no candidate moved in its design and is left out, as is every spec
 * of a record in another reading.
 */
export function approvedStatuses(record: LockRecord, root: string = getProjectRoot()): Map<string, SpecStatus> {
  const out = new Map<string, SpecStatus>();
  if (record.specsReading !== 'design' || !record.specs) return out;
  for (const file of ownSpecFiles(root)) {
    const recorded = record.specs[file.key];
    if (recorded === undefined || !file.kind) continue;
    const approved = statusApprovedIn(file.kind, file.content, recorded);
    if (approved === undefined) continue;
    const id = parsedSpec(file.content)?.id;
    if (typeof id === 'string') out.set(`${file.kind}:${id}`, approved ?? 'complete');
  }
  return out;
}

/** Render a StateId the way a member pin (a composition subject) stores it. */
export function pinOf(stateId: StateId): string {
  return `${stateId.algorithm}:${stateId.digest}`;
}

/**
 * What the lock says about the tree as it stands: the sentence to show, and
 * whether it is drift.
 *
 * The two are separate on purpose. A caller picks its severity from the FACT
 * rather than by matching this module's wording — the terminal warns in yellow,
 * an MCP client may do nothing at all, and neither should have to parse prose to
 * decide.
 */
export interface ApprovalVerdict {
  /** The verdict as a line to show; empty for a project that was never approved. */
  text: string;
  /** Whether the tree has actually moved since it was approved. */
  drifted: boolean;
  /** Every own spec that moved since the approval, prefixed `~` changed, `+` added, `-` removed; absent when none moved. */
  moved?: string[];
}

/**
 * What has changed since the human last approved this tree.
 *
 * This used to report the lock's StateId verdict, which could only ever say
 * `STALE` — a banner that fired on a tree validating 0 errors / 0 warnings,
 * named nothing to look at, and asked for work that produced no new
 * information. With a digest per spec in the lock record, the same line can
 * name the specs that actually moved, which is the only form a human can act
 * on.
 *
 * Silent for a project that was never approved: absence of an approval is the
 * normal state of a tree still being designed, not news.
 *
 * Answers whether it IS drift alongside the text — so the caller picks its
 * severity from the fact rather than by matching this function's own wording.
 */
export function approvalVerdict(approvals?: ProjectApproval[]): ApprovalVerdict {
  const quiet = { text: '', drifted: false };
  try {
    const approval = approvalRecord();
    if (!approval) return quiet;
    const by = describeApprover(approval.lockedBy);

    // What the pin tree says, when the caller passed one: an upgrade-only
    // staleness of this project's own lock, direct members whose pin MOVED
    // (this lock is stale until it re-locks) and direct members that are
    // drifted or never approved (the member's to lock, named so this project
    // knows before it locks).
    const diff = diffAgainstApproval();
    const notes = memberNotes(approvals ?? [], approval, diff);
    const pinDrift = notes.drift;
    const childNote = notes.text;

    if (!diff) {
      // Locked, but by a record written before per-spec approval existed: it
      // proves the tree validated, not which specs still match it. Say exactly
      // that rather than implying either answer.
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — this lock predates per-spec approval, so `
          + `drift is only visible at whole-tree level. Re-lock to record it.${childNote}\n`,
        drifted: pinDrift,
      };
    }
    // A format-2 lock that still holds: read in its original reading, and
    // carried into the design reading by `wairon doctor --fix` without a review.
    const own = (approvals ?? []).find((a) => a.key === '');
    const carry = isContentReadingRecord(approval) && own?.state === 'approved' ? `\n${REEXPRESS_HINT}` : '';
    if (diffSize(diff) === 0) {
      return {
        text: `\nApproved: ${approval.lockedAt} by ${by} — no spec has changed since.${childNote}${carry}\n`,
        drifted: pinDrift,
      };
    }

    const parts: string[] = [];
    if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
    if (diff.added.length) parts.push(`${diff.added.length} added`);
    if (diff.removed.length) parts.push(`${diff.removed.length} removed`);

    // Name a few, then say how many more — enough to orient without becoming
    // the wall of text the old banner was trying not to be.
    const named = [...diff.changed, ...diff.added, ...diff.removed].slice(0, 5);
    const rest = diffSize(diff) - named.length;

    // One category needs no breakdown: "1 spec changed since approval (1
    // changed)" says the same thing twice. The parenthetical earns its place
    // only when the diff actually mixes kinds.
    const n = diffSize(diff);
    const noun = `${n} spec${n === 1 ? '' : 's'}`;
    const headline = parts.length === 1
      ? `${noun} ${parts[0].slice(String(diffSize(diff)).length + 1)} since approval`
      : `${noun} changed since approval (${parts.join(', ')})`;

    return {
      text: `\n${headline} — approved ${approval.lockedAt} by ${by}:\n`
        + named.map((p) => `  ${p}`).join('\n')
        + (rest > 0 ? `\n  … and ${rest} more` : '')
        + childNote
        + carry
        + '\n',
      drifted: true,
      moved: [...diff.changed.map((p) => `~ ${p}`), ...diff.added.map((p) => `+ ${p}`), ...diff.removed.map((p) => `- ${p}`)],
    };
  } catch {
    return quiet; // never let a report line break the report
  }
}

/**
 * Whether a record predates lock format 3: its per-spec digests are the raw
 * content (no design reading named), and its identity was taken with code
 * linkage in. Read compatibly until it is re-locked or re-expressed.
 */
export function isContentReadingRecord(record: LockRecord): boolean {
  return record.specsReading !== 'design';
}

/** The hint beside a format-2 lock that still holds. */
export const REEXPRESS_HINT =
  'This approval predates lock format 3 and is read in its original reading; `wairon doctor --fix` carries it '
  + 'into the design reading without a review (the approval stays the approver\'s), after which adding or moving '
  + 'a sourcePath never drifts it.';

/**
 * The note for a format-2 lock that no longer matches under its own algorithm:
 * something it covered moved — the design, or only code linkage, which that
 * record can no longer tell apart — so it takes one re-lock.
 */
export const FORMAT2_STALE_NOTE =
  'it was taken before code linkage (sourcePath, symbol, simPath and the like) left the approval, and something '
  + 'it covered moved since — the design, or only code linkage, which this record can no longer tell apart. '
  + 'One `wairon lock` clears it for good: from then on linkage never drifts the approval';

/** The gate-identity upgrade note: the identity gained inputs, which says nothing about the design. */
export const GATE_UPGRADE_NOTE =
  'the gate identity gained inputs in this release (members\' composition subjects, `composition`; '
  + 'code conformance moved beside the claim)';

/**
 * The note for an approval no own spec file of which moved — not even in code
 * linkage — that still no longer matches: what moved is the gate the design
 * was judged under, never the tree, and the note says so instead of blaming
 * the design.
 */
export const GATE_MOVED_NOTE =
  'no own spec file changed since it was taken — not even its code linkage — so what moved is the gate it was '
  + 'judged under: the design rules this wairon release judges by, or the project\'s rule tuning, `composition`, '
  + 'network declaration, consumed contracts or a member\'s approval. One `wairon lock` re-approves the unchanged '
  + 'design under the current gate';

/**
 * The member and upgrade lines of the verdict, from the pin tree: whether this
 * project's own lock was taken under an earlier gate identity, which direct
 * members' pins moved, and which are drifted or never approved. `drift` is
 * this project's drift only: an upgrade or a moved pin — a member that is
 * merely unapproved is the member's to lock.
 */
function memberNotes(approvals: ProjectApproval[], record?: LockRecord | null, diff?: ApprovalDiff | null): { text: string; drift: boolean } {
  const own = approvals.find((a) => a.key === '');
  // A part has no approval of its own (stage 8): this project's is its approval.
  const direct = approvals.filter((a) => a.parent === '' && a.as !== 'part');
  const moved = direct.filter((a) => a.pinned === 'moved');
  const unapproved = direct.filter((a) => a.state !== 'approved');
  const lines: string[] = [];
  if (own?.upgraded) {
    // Nothing in the tree moved: the cause is the gate, and saying "the design
    // or only code linkage" would send the reader looking for an edit nobody made.
    const by = record?.validatorVersion ? ` (taken by wairon ${record.validatorVersion})` : '';
    lines.push(diff && diffSize(diff) === 0
      ? `This approval no longer matches${by}: ${GATE_MOVED_NOTE}.`
      : record && record.format === 2
        ? `This approval no longer matches: ${FORMAT2_STALE_NOTE}.`
        : `This approval was taken under an earlier gate identity — ${GATE_UPGRADE_NOTE}. Re-lock once.`);
  }
  if (moved.length) {
    lines.push(`${moved.length} member pin(s) moved since approval: ${moved.map((a) => a.alias ?? a.key).join(', ')} — re-lock to approve them.`);
  }
  if (unapproved.length) {
    lines.push(`Member(s) not approved at their own root: ${unapproved.map((a) => `${a.alias ?? a.key} (${a.state}${a.upgraded ? ', re-lock once' : ''})`).join(', ')}.`);
  }
  return {
    text: lines.map((l) => `\n${l}`).join(''),
    drift: !!own?.upgraded || moved.length > 0,
  };
}
