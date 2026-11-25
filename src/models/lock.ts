// ---------------------------------------------------------------------------
// approver_identity — who approved a lock, and how much that name is worth.
//
// Shared vocabulary, so it lives with the models rather than inside the store
// that happens to persist it (src/core/lockfile.ts). That placement is
// load-bearing rather than tidy: `label` is a pure projection over the value's
// own fields, and a CLI command that renders an approver has to be able to
// reach it WITHOUT reaching into sdd_core's lock store — a Portal may not
// depend on a Store, so while the function sat beside the lock file's I/O
// there was no legal route to it at all.
// ---------------------------------------------------------------------------

import type { ValidationResult } from '../core/validation.js';
import type { MemberKind } from './project.js';

/** How an approver's identity was established. */
export type ApproverSource = 'git' | 'hosted' | 'os' | 'legacy';

/**
 * Who approved, and HOW that identity was established — because the two are
 * different claims. A `hosted` identity was authenticated by the instance that
 * issued the caller's credential; `git` and `os` are self-declared, read from
 * the machine's own config. Recording the source keeps the record honest about
 * how much it proves instead of leaving a bare name to imply more than it can.
 *
 * The actual proof is the commit that introduces the lock record — signed
 * commits or a protected branch establish it; no field inside the file ever
 * can.
 */
export interface ApproverIdentity {
  /** Git author line, hosted subject id, or OS username — per `source`. */
  id: string;
  /** Display name when the source carries one separately from the id. */
  name?: string;
  /** 'legacy' is a record written before this field existed: an opaque string. */
  source: ApproverSource;
}

/**
 * approver_identity.label — one line for a human: the approver plus how much
 * that name is worth. A self-declared identity read off a machine and one an
 * instance authenticated are different claims, and a reader has to be able to
 * tell them apart at a glance.
 */
export function describeApprover(who: ApproverIdentity): string {
  const label = who.name ? `${who.name} (${who.id})` : who.id;
  return who.source === 'hosted' ? `${label} [authenticated]` : label;
}

// ---------------------------------------------------------------------------
// What a lock records BESIDE its claim (the code analysis) and what a
// project's approval looks like from its own root. Shared vocabulary for the
// same reason the approver is: the validator produces them, core persists and
// renders them, and neither may reach into the other's modules for a type.
// ---------------------------------------------------------------------------

/** Weakest-first order of the analysis grades; `none` when no file was analyzed. */
export type AnalysisGradeLabel = 'exact' | 'pattern' | 'generic' | 'none';

/**
 * analyzer_identity — which code analyzer produced a set of code-conformance
 * results. Deliberately NOT an input of the approval identity: an analyzer
 * upgrade changes this and never stales a lock.
 */
export interface AnalyzerIdentity {
  /** The wairon version that ran the analysis. */
  validatorVersion: string;
  /** sha256 (hex) of the code-conformance doctrine (approval_identity.analyzer). */
  doctrineDigest: string;
  /** The weakest analysis grade applied to any analyzed file, or `none`. */
  grade: AnalysisGradeLabel;
}

/**
 * code_analysis — the code-conformance half of a validation run, summarized
 * apart from the design half. A lock records it as `code`, beside the claim
 * and never inside it; its `codes` list is left out there.
 */
export interface CodeAnalysis {
  analyzer: AnalyzerIdentity;
  /** Every code a code-judging rule declares, sorted. Absent on a lock record. */
  codes?: string[];
  errors: number;
  warnings: number;
  notices: number;
}

/** A project's approval state as seen from its own root. */
export type ProjectApprovalState = 'approved' | 'drifted' | 'never';

/**
 * input_debt_kind — what a project's build inputs owe beside an approval that
 * holds: an external or referenced member with no pin, a use beyond a pin, a
 * pack whose content no longer matches the inputs lock, a member whose own
 * lock does not hold (under composition.requireApprovedMembers).
 */
export type InputDebtKind = 'unpinned' | 'unrecorded' | 'pack' | 'member';

/**
 * input_debt — one thing a project's build inputs owe beside its approval:
 * what, about which producer, pack or member, and the sentence every surface
 * quotes. An approval with debts still holds; `wairon lock-check` refuses
 * until each is cleared by the command its sentence names.
 */
export interface InputDebt {
  kind: InputDebtKind;
  /** The alias of the external or referenced member, the pack name, or the member key it concerns. */
  subject: string;
  /** For `unrecorded`: each use the pin does not hold, `<name>` or `<name>.<method>`. */
  detail?: string[];
  /** One sentence a verdict quotes: the cause and the command that clears it. */
  sentence: string;
}

/**
 * project_approval — one project's approval and build-input state, computed at
 * that project's OWN root, so the answer is the same whichever root asked
 * (status-agrees). The family's approvals are a list of these, the root's own
 * entry first. Two separate questions: `state` says whether the approved
 * design and policy still hold; `inputs` says what the build inputs owe.
 */
export interface ProjectApproval {
  /** '' for the root the question was asked at, else the member's key. */
  key: string;
  /** The alias the parent declares this member under; absent on the root. */
  alias?: string;
  /** The key of the declaring project; absent on the root. */
  parent?: string;
  /** The project's effective id, when it has a usable one. */
  projectId?: string;
  /** Whether its own design and policy moved since its lock. Never moved by a release, a re-pin, a pack's content or a member's lock. */
  state: ProjectApprovalState;
  /** part | project. A part's state is its declaring project's, and it carries no inputs of its own. */
  as?: MemberKind;
  /**
   * Why the approval on record does not cover the project although its
   * approval identity matches: its project id moved since the approval. Set
   * only on a drifted entry.
   */
  owed?: string;
  /** On a drifted entry: the parts of its approval identity that moved (lock_record.movedParts). */
  partsMoved?: string[];
  /**
   * Set when the record's `parts` do not break down its stateId
   * (lock_record.partsProblem): why. They are ignored — they name no part —
   * and every surface says so as a notice.
   */
  partsIgnored?: string;
  /**
   * Whether the project's own tree holds anything to approve, judged at its
   * own root by the shared predicate (holdsDesign): false only for an L0 with
   * nothing below it. Absent when the tree could not be read.
   */
  approvable?: boolean;
  /** What the build inputs owe beside the approval. Empty when they hold. Never makes the state drifted. */
  inputs: InputDebt[];
}

/** The parts every approval identity has (`network` only when one is declared). */
const CORE_APPROVAL_PARTS = ['composition', 'design', 'rules', 'selections'];

/**
 * lock_record.missingTreeSentence — the sentence for a record that approved
 * spec files while the tree it approved is gone (no L0, no spec file below
 * it), or null when it records none. A project with an approval on record has
 * opted in: its absent tree is a deleted design, never "no tree". Pure.
 */
export function missingTreeSentence(record: { specs?: Record<string, string>; lockedAt?: unknown; lockedBy?: ApproverIdentity }): string | null {
  const count = Object.keys(record.specs ?? {}).length;
  if (count === 0) return null;
  return `The approval on record (${approvalStamp(record)}) approved ${count} spec file(s), but this project has no spec tree (.wai/specs holds no L0 and no spec file): `
    + 'the design it approved is gone, not absent — a project with an approval on record has opted in, so this is never "no tree", and nothing can be judged. '
    + 'Fix: restore it from version control (`git checkout -- .wai/specs`); to retire the design on purpose, delete .wai/lock.json in the same change.';
}

/**
 * lock_record.partsProblem — why a record's parts do not break down the
 * stateId they sit beside, or null when they do: a part every identity has is
 * missing; the stateId IS the current identity while a part differs from the
 * current one; or, under the same algorithm, the stateId differs while no part
 * does. A record `wairon upgrade` could not carry holds no parts and claims
 * none. Pure.
 */
export function gatePartsProblem(
  record: { stateId: { algorithm: string; digest: string }; parts?: Record<string, string> },
  current: { algorithm: string; digest: string; parts?: Record<string, string> },
): string | null {
  const parts = record.parts;
  // A record that carries no parts names no moved part and claims none (an upgrade that could not carry it).
  if (!parts || Object.keys(parts).length === 0) return null;
  const missing = CORE_APPROVAL_PARTS.filter((k) => typeof parts[k] !== 'string');
  if (missing.length > 0) return `they lack the part(s) every identity has: ${missing.join(', ')}`;
  if (!current.parts) return null;
  const differ = movedParts(record, current.parts);
  const sameAlgorithm = record.stateId.algorithm === current.algorithm;
  const same = sameAlgorithm && record.stateId.digest === current.digest;
  if (same && differ.length > 0) return `its stateId is the identity as it stands, yet its part(s) ${differ.join(', ')} differ from that identity's`;
  if (!same && sameAlgorithm && differ.length === 0) return 'they say no part moved, yet its stateId is not the identity as it stands';
  return null;
}

/** The words every verdict names an approval part by: what moved, said once. */
export const APPROVAL_PART_WORDS: Record<string, string> = {
  design: 'the design itself (its own specs)',
  rules: "the project's rule tuning or projectType",
  composition: '`composition`',
  network: 'the network declaration',
  selections: 'its pack selections',
};

/** The moved parts in words, joined: "the network declaration and `composition`". */
export function describeApprovalParts(parts: readonly string[]): string {
  const words = parts.map((p) => APPROVAL_PART_WORDS[p] ?? p);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * lock_record.movedParts — the names of the parts that differ between a
 * record's `parts` and `current` (a part present on one side only counts as
 * moved), sorted. Pure.
 */
export function movedParts(record: { parts?: Record<string, string> }, current: Record<string, string>): string[] {
  const recorded = record.parts ?? {};
  const keys = new Set([...Object.keys(recorded), ...Object.keys(current)]);
  return [...keys].filter((k) => recorded[k] !== current[k]).sort();
}

/**
 * What `wairon upgrade` did with an approval from an earlier major: carried it without a review, or could not.
 * `cmd` is the command the hint names (`npx wairon` for a local install, which only the CLI knows).
 */
export function upgradeLine(fromFormat: number | string, carried: boolean, cmd = 'wairon'): string {
  return carried
    ? `\`${cmd} upgrade\` carried this approval over from an earlier wairon major (lock format ${fromFormat}) without a review.`
    : `\`${cmd} upgrade\` could not carry this approval over from an earlier wairon major (lock format ${fromFormat}): it reads stale until the next \`${cmd} lock\`.`;
}

/**
 * lock_record.approvalStamp — `<lockedAt> by <approver>` as every verdict
 * names an approval; a record that carries no lockedAt or no usable lockedBy
 * says so instead of `undefined by unknown`. Pure.
 */
export function approvalStamp(record: { lockedAt?: unknown; lockedBy?: ApproverIdentity }): string {
  const at = typeof record.lockedAt === 'string' && record.lockedAt.trim() !== '' ? record.lockedAt : 'at an unrecorded time';
  const who = record.lockedBy && record.lockedBy.id && record.lockedBy.id !== 'unknown' ? describeApprover(record.lockedBy) : 'an unrecorded approver';
  return `${at} by ${who}`;
}

/**
 * Whether a warning is waived from the --ci failure decision because it only
 * reflects a draft: the DRAFT_*_WARNING family always, UNUSED_COMPONENT in
 * draft context. Pure.
 */
export function isCiDraftWaivable(issue: { severity: string; code: string; draftContext?: boolean }): boolean {
  if (issue.severity !== 'warning') return false;
  if (issue.code === 'DRAFT_SUBSYSTEM_WARNING') return true;
  if (issue.code === 'DRAFT_COMPONENT_WARNING') return true;
  if (issue.code === 'UNUSED_COMPONENT') return issue.draftContext === true;
  return false;
}

/**
 * validation_result.ciBlocking — the findings that fail `wairon validate
 * --ci`: every error, and every warning but the draft-related ones --ci
 * waives; notices never count. Pure.
 */
export function ciBlockingIssues(result: ValidationResult): ValidationResult['issues'] {
  return result.issues.filter((i) => i.severity === 'error' || (i.severity === 'warning' && !isCiDraftWaivable(i)));
}

/**
 * validation_result.designOnly — this result with every issue whose code is
 * one of analysis.codes removed, `valid` recomputed over what remains, and
 * `analysis` kept: the DESIGN half, which is what a lock gates on and
 * certifies. Pure; a result with no analysis answers itself unchanged. It
 * lives beside CodeAnalysis because the partition is that value's to draw.
 */
export function designOnly(result: ValidationResult): ValidationResult {
  if (!result.analysis) return result;
  const codeCodes = new Set(result.analysis.codes ?? []);
  const issues = result.issues.filter((i) => !codeCodes.has(i.code));
  return { ...result, issues, valid: issues.every((i) => i.severity !== 'error') };
}
