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
import type { MemberPin } from '../core/lockfile.js';
import type { MemberKind } from './project.js';
import { isNewerVersion } from '../utils/version.js';

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
// Stage 5 — approval across a family. What a lock records BESIDE its claim
// (the code analysis) and what a family's pin tree says about each project.
// Shared vocabulary for the same reason the approver is: the validator
// produces them, core persists and renders them, and neither may reach into
// the other's modules for a type.
// ---------------------------------------------------------------------------

/** Weakest-first order of the analysis grades; `none` when no file was analyzed. */
export type AnalysisGradeLabel = 'exact' | 'pattern' | 'generic' | 'none';

/**
 * analyzer_identity — which code analyzer produced a set of code-conformance
 * results. Deliberately NOT an input of the gate identity: an analyzer upgrade
 * changes this and never stales a lock.
 */
export interface AnalyzerIdentity {
  /** The wairon version that ran the analysis. */
  validatorVersion: string;
  /** sha256 (hex) of the code-conformance doctrine (gate_identity.analyzer). */
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

/**
 * spec_digest_reading — which reading of a spec file a lock record's per-spec
 * digests were taken in. `content`: the raw text, line endings normalized —
 * what every record written before format 3 carries (the field absent).
 * `design`: the spec's design view (code linkage and timestamps out) in
 * canonical form, so a sourcePath, a whitespace edit or a no-op re-save never
 * moves it.
 */
export type SpecDigestReading = 'content' | 'design';

/**
 * lock_reexpression — provenance on a lock record a tool carried into a newer
 * reading after PROVING the design is the one approved (its own earlier
 * identity, recomputed over the tree as it stands, matched), rather than a
 * human re-approving it. Who approved and when stay the human's.
 */
export interface LockReexpression {
  /** ISO-8601 time of the re-expression. */
  at: string;
  /** The gate algorithm the record carried before. */
  fromAlgorithm: string;
  /** The per-spec digest reading the record carried before. */
  fromReading: SpecDigestReading;
  /** The command that re-expressed it (e.g. `wairon doctor --fix`), never a person. */
  by: string;
}

/** A project's approval state as seen from its own root. */
export type ProjectApprovalState = 'approved' | 'drifted' | 'never';

/** How a parent's lock pinned a member. */
export type PinState = 'matches' | 'moved' | 'unpinned';

/**
 * project_approval — one project's approval state, computed at that project's
 * OWN root, so the answer is the same whichever root asked (status-agrees).
 * The family's pin tree is a list of these, the root's own entry first.
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
  state: ProjectApprovalState;
  /** Its composition subject: its own record's stateId, `<algorithm>:<digest>`. Absent when never. */
  subject?: string;
  /** Drifted only because the lock predates the stage-5 gate identity. */
  upgraded?: boolean;
  /**
   * Why the approval on record does not cover the project although its gate
   * identity may match: its id moved since the approval, or a declared
   * external was never pinned or is used beyond its pin. Set only on a
   * drifted entry; status, lock-check and lock read the same entry.
   */
  owed?: string;
  /** How the parent's lock pinned it; absent on the root. */
  pinned?: PinState;
  /** part | project (stage 8). A part's state is its declaring project's, and it has no subject of its own. */
  as?: MemberKind;
  /** A part's content digest (ScannedPart.contentDigest), recorded by the lock as its MemberPin. */
  contentDigest?: string;
  /** The commit a part or a referenced project member was read at, when known — provenance the lock records. */
  commit?: string;
  /**
   * Set when the identity no longer matches ONLY because the wairon release
   * changed (family_validator.releaseVerdict): carried — approved, re-validated
   * under this release — or not, drifted for exactly its findings. Never set
   * together with upgraded.
   */
  release?: ReleaseVerdict;
  /** On a drifted entry whose record carries gate parts: the inputs that moved (lock_record.movedGateParts). */
  inputsMoved?: string[];
  /**
   * Set when the record's gateParts do not break down its stateId
   * (lock_record.partsProblem): why. They are ignored — they name no input
   * and carry no approval over — and every surface says so as a notice.
   */
  partsIgnored?: string;
}

/**
 * release_verdict — an approval whose gate identity moved only because the
 * wairon release's built-in design doctrine did, judged by re-validating the
 * approved design under the current rules instead of by digest.
 */
export interface ReleaseVerdict {
  /** The release the approval was taken under (the record's validatorVersion). */
  from: string;
  /** The release that re-validated it. */
  to: string;
  /** True when the re-validation is clean at the --ci standard: the approval carries over. */
  carried: boolean;
  /** How many findings fail the --ci standard; 0 when carried. */
  count?: number;
  /** The first few of them, `CODE [spec] message`. */
  findings?: string[];
  /**
   * Set on a verdict that is not carried because the change of the release
   * cannot be judged by re-validation at all — the record cannot prove the
   * project's own inputs unchanged — as one sentence naming why. count and
   * findings are absent then.
   */
  reason?: string;
}

/**
 * release_verdict.staleSentence — the one sentence every surface shows for a
 * verdict that is not carried: its reason when it has one, else the findings
 * the new release reports in the approved design. Pure.
 */
export function staleReleaseSentence(verdict: ReleaseVerdict): string {
  if (verdict.reason) return verdict.reason;
  const findings = verdict.findings ?? [];
  const more = (verdict.count ?? 0) > findings.length ? '; …' : '';
  return `It was approved under wairon ${verdict.from}, and the new release (${verdict.to}) finds ${verdict.count ?? 0} issue(s) in the approved design: ${findings.join('; ')}${more}.`;
}

/** lock_restamp — provenance of a release stamp refreshed by `wairon lock` without a re-approval. */
export interface LockRestamp {
  at: string;
  fromVersion: string;
  toVersion: string;
  by: string;
  /**
   * The composition subject of the human approval this restamp carried over
   * (kept through every later restamp): what a parent pins of this project,
   * so a restamp never reads as a re-approval one level up.
   */
  subject?: string;
}

/** The first wairon release that records gate parts on every lock it writes. */
export const GATE_PARTS_SINCE = '5.1.1-dev.111';

/** The gate parts every identity carries (`network` only when one is declared). */
const CORE_GATE_PARTS = ['composition', 'contracts', 'design', 'members', 'packs', 'release', 'rules'];

/**
 * lock_record.approvalSubject — the composition subject this record's
 * APPROVAL stands for: the subject its restamp kept, else its own stateId,
 * `<algorithm>:<digest>`. What a parent's identity and pin read of it. Pure.
 */
export function approvalSubject(record: { stateId: { algorithm: string; digest: string }; restamped?: { subject?: string } }): string {
  const kept = record.restamped?.subject;
  return typeof kept === 'string' && kept !== '' ? kept : `${record.stateId.algorithm}:${record.stateId.digest}`;
}

/** How a record's release stamp reads against the running release. */
export type ReleaseStampReading = 'older' | 'same' | 'newer' | 'invalid';

/** A wairon version: X.Y.Z with an optional pre-release suffix. */
const WAIRON_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * lock_record.releaseStampAgainst — how a record's validatorVersion compares
 * with the running release: older, same, newer, or invalid when it is absent
 * or no wairon version. Pure.
 */
export function releaseStampAgainst(record: { validatorVersion?: unknown }, running: string): ReleaseStampReading {
  const stamp = record.validatorVersion;
  if (typeof stamp !== 'string' || !WAIRON_VERSION_RE.test(stamp)) return 'invalid';
  if (stamp === running) return 'same';
  if (isNewerVersion(running, stamp)) return 'newer';
  return isNewerVersion(stamp, running) ? 'older' : 'same';
}

/** Whether a valid stamp is at or after the first release that records gate parts. */
export function stampRecordsGateParts(stamp: string): boolean {
  return stamp === GATE_PARTS_SINCE || isNewerVersion(GATE_PARTS_SINCE, stamp);
}

/**
 * lock_record.partsProblem — why a record's gateParts do not break down the
 * stateId they sit beside, or null when they do or it carries none: a part
 * every identity has is missing; the stateId IS the current identity while a
 * part differs from the current one; or, under the same algorithm, the
 * stateId differs while no part does. Pure.
 */
export function gatePartsProblem(
  record: { stateId: { algorithm: string; digest: string }; gateParts?: Record<string, string> },
  current: { algorithm: string; digest: string; parts?: Record<string, string> },
): string | null {
  const parts = record.gateParts;
  if (!parts) return null;
  const missing = CORE_GATE_PARTS.filter((k) => typeof parts[k] !== 'string');
  if (missing.length > 0) return `they lack the part(s) every identity has: ${missing.join(', ')}`;
  if (!current.parts) return null;
  const differ = movedGateParts(record, current.parts) ?? [];
  const sameAlgorithm = record.stateId.algorithm === current.algorithm;
  const same = sameAlgorithm && record.stateId.digest === current.digest;
  if (same && differ.length > 0) return `its stateId is the identity as it stands, yet its part(s) ${differ.join(', ')} differ from that identity's`;
  if (!same && sameAlgorithm && differ.length === 0) return 'they say no input moved, yet its stateId is not the identity as it stands';
  return null;
}

/** A record's gateParts when they break down its identity, else undefined (none, or ignored). */
export function usableGateParts(
  record: { stateId: { algorithm: string; digest: string }; gateParts?: Record<string, string> },
  current: { algorithm: string; digest: string; parts?: Record<string, string> },
): Record<string, string> | undefined {
  return record.gateParts && gatePartsProblem(record, current) === null ? record.gateParts : undefined;
}

/** The words every verdict names a gate part by: what moved, said once. */
export const GATE_PART_WORDS: Record<string, string> = {
  design: 'the design itself (its own specs)',
  release: "this wairon release's built-in design rules",
  rules: "the project's rule tuning or projectType",
  packs: 'its extension packs (packs, profiles, languages, patterns)',
  network: 'the network declaration',
  composition: '`composition`',
  contracts: "a consumed contract's pin",
  members: "a member's approval",
};

/** The moved gate parts in words, joined: "the network declaration and `composition`". */
export function describeGateParts(parts: readonly string[]): string {
  const words = parts.map((p) => GATE_PART_WORDS[p] ?? p);
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * lock_record.movedGateParts — the gate parts that differ between a record's
 * gateParts and `current` (an input present on one side only counts as
 * moved), sorted; null when the record carries no gate parts. Pure.
 */
export function movedGateParts(record: { gateParts?: Record<string, string> }, current: Record<string, string> | undefined): string[] | null {
  if (!record.gateParts || !current) return null;
  const keys = new Set([...Object.keys(record.gateParts), ...Object.keys(current)]);
  return [...keys].filter((k) => record.gateParts![k] !== current[k]).sort();
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
 * member_pin as a lock records one direct member (stage 8): a PROJECT
 * member's {as: project, project, subject, state, commit when known}, or a
 * PART's {as: part, contentDigest, commit when known, state approved} — a part
 * has no lock of its own, the parent's approval is its approval.
 */
export function memberPinOf(member: ProjectApproval): MemberPin {
  if (member.as === 'part') {
    return {
      as: 'part',
      ...(member.contentDigest !== undefined ? { contentDigest: member.contentDigest } : {}),
      ...(member.commit !== undefined ? { commit: member.commit } : {}),
      state: 'approved',
    };
  }
  return {
    as: 'project',
    ...(member.projectId !== undefined ? { project: member.projectId } : {}),
    ...(member.subject !== undefined ? { subject: member.subject } : {}),
    state: member.state,
    ...(member.commit !== undefined ? { commit: member.commit } : {}),
  };
}

/**
 * validation_result.designOnly — this result with every issue whose code is
 * one of analysis.codes removed, `valid` recomputed over what remains, and
 * `analysis` kept: the DESIGN half, which is what a lock gates on and
 * certifies. Pure; a result with no analysis answers itself unchanged. It
 * lives beside CodeAnalysis because the partition is that value's to draw.
 */
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

export function designOnly(result: ValidationResult): ValidationResult {
  if (!result.analysis) return result;
  const codeCodes = new Set(result.analysis.codes ?? []);
  const issues = result.issues.filter((i) => !codeCodes.has(i.code));
  return { ...result, issues, valid: issues.every((i) => i.severity !== 'error') };
}
