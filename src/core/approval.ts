import * as crypto from 'crypto';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { snapshotSpecFiles, graph, scanAllSpecs } from './specs.js';
import { readLockRecord, readLockRecordAt } from './lockfile.js';
import { approvalStamp, describeApprovalParts, upgradeLine, type ProjectApproval } from '../models/lock.js';
import { parseYaml } from '../utils/yaml.js';
import { canonicalize } from '../utils/canonical-json.js';
import {
  asSchemaReads, componentDesignView, implementationDesignView, interfaceDesignView, subsystemDesignView, typeDesignView,
} from '../models/specs.js';
import { approvalKeyIn } from '../models/project-family.js';
import type { LockRecord } from './lockfile.js';

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
//     the parent records nothing about a member, and a member's state is the
//     validator's to compute, since it needs an approval identity
//     (validator_portal.familyApprovals).
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
  const out = viewDigest(designViewOf(kind, schemaRead(kind, parsed)));
  if (designDigestMemo.size > 20000) designDigestMemo.clear();
  designDigestMemo.set(key, out);
  return out;
}

/**
 * A parsed spec file as the loader reads it — the keys its kind's schema reads,
 * none it drops — so a key that means nothing to the loaded tree (and so to the
 * gate identity) moves no approval digest either. A kind with no view as it is.
 */
function schemaRead(kind: LinkedKind | undefined, parsed: Record<string, unknown>): Record<string, unknown> {
  return kind ? asSchemaReads(kind, parsed) : parsed;
}

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

/** Each scanned spec file of a linked kind, by its resolved path. */
function linkedKindsByFile(): Map<string, LinkedKind> {
  const paths = scanAllSpecs().paths;
  const kinds = new Map<string, LinkedKind>();
  for (const kind of ['implementation', 'type', 'component', 'subsystem', 'interface'] as const) {
    for (const file of Object.values(paths[kind])) kinds.set(path.resolve(file), kind);
  }
  return kinds;
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
export function currentSpecDigests(root: string = getProjectRoot()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const file of ownSpecFiles(root)) out[file.key] = designDigest(file.kind, file.content);
  return out;
}

/** The bound project's own spec files (its parts' included, a member project's never): key, kind and content. */
function ownSpecFiles(root: string): Array<{ key: string; kind: LinkedKind | undefined; content: string }> {
  // Every member the scan read, in either declaration form (stage 3: a member is
  // a project of its own, never a subsystem of this one).
  const nodes = graph().nodes;
  // A file is the project's whose folder holds it most closely: a project read
  // above the bound root (a parent reached through a path external, which a
  // member using its parent declares) holds the bound root's files too, and
  // they stay the bound root's own.
  const dirOf = (n: { directory: string }): string => `${path.resolve(n.directory).split(path.sep).join('/')}/`;
  const nodeDirs = nodes.map((n) => ({ dir: dirOf(n), own: n.namespace === '' }));
  /** Whether the node folder holding a file most closely is another project's. */
  const othersFile = (file: string): boolean => {
    let closest: { dir: string; own: boolean } | undefined;
    for (const node of nodeDirs) {
      if (file.startsWith(node.dir) && (!closest || node.dir.length > closest.dir.length)) closest = node;
    }
    return closest !== undefined && !closest.own;
  };
  // A part's files ARE this project's own (stage 8), keyed `members/<alias>/…`.
  const parts = nodes.find((n) => n.namespace === '')?.parts ?? [];

  const kinds = linkedKindsByFile();
  const out: Array<{ key: string; kind: LinkedKind | undefined; content: string }> = [];
  for (const [abs, content] of snapshotSpecFiles()) {
    const normalized = path.resolve(abs).split(path.sep).join('/');
    if (othersFile(normalized)) continue;
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
  const current = currentSpecDigests(root);
  if (!scope) return current;

  // A scope names files by their path from the root; a part's file is approved
  // under its storage-independent key (stage 8).
  const parts = graph().nodes.find((n) => n.namespace === '')?.parts ?? [];
  const keys = new Set([...scope.paths].map((rel) => approvalKeyIn(path.resolve(root, rel), root, parts)));
  const previous = readLockRecord()?.specs ?? {};
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

  // Compared as design digests: the one reading a format-4 record carries.
  const current = currentSpecDigests(root);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchangedPaths: string[] = [];

  for (const [rel, d] of Object.entries(current)) {
    const before = approved[rel];
    if (before === undefined) added.push(rel);
    else if (before !== d) changed.push(rel);
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
    // Steps 1-3: the approval on record; a project never approved is silence, not drift.
    const approval = approvalRecord();
    if (!approval) return quiet;
    // Step 4: who approved it and when.
    const stamp = approvalStamp(approval);
    // Step 5: the root's own entry, and the members that owe their own lock.
    const own = (approvals ?? []).find((a) => a.key === '');
    const notes = memberNotes(approvals ?? [], approval);
    // Step 6: the tree against what was approved.
    const diff = diffAgainstApproval();
    // Steps 7-8: a record that holds no per-spec digests cannot say which specs moved.
    if (!diff) {
      return {
        text: `\nApproved: ${stamp} — this lock holds no per-spec approval, so `
          + `drift is only visible at whole-tree level. Re-lock to record it.${notes}\n`,
        drifted: own?.state === 'drifted',
      };
    }
    // Step 9: the verdict.
    const inputs = inputsLine(own);
    if (diffSize(diff) === 0) {
      // No own spec moved — but when the root's own entry is drifted, the
      // approval still owes something, and "no spec has changed" never stands
      // alone: say what moved, else the entry's own sentence.
      const owes = own?.state === 'drifted'
        ? (own.partsMoved && own.partsMoved.length > 0
          ? ` But what it was approved under did change: ${describeApprovalParts(own.partsMoved)}. \`wairon lock\` re-approves the unchanged design under it.`
          : own.owed !== undefined
            ? ` But the approval does not cover this project: ${own.owed}. \`wairon lock\` re-approves the unchanged design.`
            : ' But the approval does not cover this project any more. `wairon lock` re-approves the unchanged design.')
        : '';
      return {
        text: `\nApproved: ${stamp} — no spec has changed since.${owes}${ignoredNotice(own)}${inputs}${notes}\n`,
        drifted: own?.state === 'drifted',
      };
    }

    const parts: string[] = [];
    if (diff.changed.length) parts.push(`${diff.changed.length} changed`);
    if (diff.added.length) parts.push(`${diff.added.length} added`);
    if (diff.removed.length) parts.push(`${diff.removed.length} removed`);

    // Name every one up to VERDICT_LIST_LIMIT; past it the first ones, the
    // count of the rest and the command that lists them — never a cut list
    // that reads as the whole account.
    const marked = [...diff.changed.map((p) => `~ ${p}`), ...diff.added.map((p) => `+ ${p}`), ...diff.removed.map((p) => `- ${p}`)];
    const named = marked.slice(0, VERDICT_LIST_LIMIT);
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
      text: `\n${headline} — approved ${stamp}:\n`
        + named.map((p) => `  ${p}`).join('\n')
        + (rest > 0 ? `\n  … and ${rest} more — \`wairon status --all\` lists every one` : '')
        + (own?.partsMoved && own.partsMoved.length > 0 ? `\nThe approval policy also moved: ${describeApprovalParts(own.partsMoved)}.` : '')
        + (own?.owed !== undefined ? `\nThe approval also owes: ${own.owed}.` : '')
        + ignoredNotice(own)
        + inputs
        + notes
        + '\n',
      drifted: true,
      moved: [...diff.changed.map((p) => `~ ${p}`), ...diff.added.map((p) => `+ ${p}`), ...diff.removed.map((p) => `- ${p}`)],
    };
  } catch {
    return quiet; // never let a report line break the report
  }
}

/** How many moved specs the verdict names before it counts the rest. */
const VERDICT_LIST_LIMIT = 40;

/** The notice for parts that do not break down the record's identity; empty when there is none. */
function ignoredNotice(own: ProjectApproval | undefined): string {
  return own?.partsIgnored !== undefined
    ? ` Notice: the record's parts are ignored — ${own.partsIgnored}; \`wairon lock\` rewrites them.`
    : '';
}

/**
 * The line beside an approval that names what the build inputs owe: each
 * debt's sentence with the command that clears it. Never drift, and never
 * phrased as a change of the design.
 */
function inputsLine(own: ProjectApproval | undefined): string {
  const debts = own?.inputs ?? [];
  if (debts.length === 0) return '';
  return `\nThe approval holds; the build inputs owe: ${debts.map((d) => d.sentence).join(' ')}`;
}

/**
 * The upgrade and member lines of the verdict, from the approvals: whether
 * `wairon upgrade` carried the record over, and which direct members are
 * drifted or never approved — each the member's to lock, named so this
 * project knows, never this project's drift.
 */
function memberNotes(approvals: ProjectApproval[], record: LockRecord): string {
  // A part has no approval of its own: this project's is its approval.
  const direct = approvals.filter((a) => a.parent === '' && a.as !== 'part');
  const unapproved = direct.filter((a) => a.state !== 'approved');
  const lines: string[] = [];
  if (record.upgraded) {
    lines.push(upgradeLine(record.upgraded.fromFormat, record.upgraded.carried));
  }
  if (unapproved.length) {
    lines.push(`Member(s) not approved at their own root: ${unapproved.map((a) => `${a.alias ?? a.key} (${a.state}${a.partsMoved && a.partsMoved.length > 0 ? `: ${describeApprovalParts(a.partsMoved)} moved` : ''})`).join(', ')}.`);
  }
  return lines.map((l) => `\n${l}`).join('');
}
