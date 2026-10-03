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
  source: 'git' | 'hosted' | 'os' | 'legacy';
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
  /** How the parent's lock pinned it; absent on the root. */
  pinned?: PinState;
  /** part | project (stage 8). A part's state is its declaring project's, and it has no subject of its own. */
  as?: 'part' | 'project';
  /** A part's content digest (ScannedPart.contentDigest), recorded by the lock as its MemberPin. */
  contentDigest?: string;
  /** The commit a part or a referenced project member was read at, when known — provenance the lock records. */
  commit?: string;
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
export function designOnly(result: ValidationResult): ValidationResult {
  if (!result.analysis) return result;
  const codeCodes = new Set(result.analysis.codes ?? []);
  const issues = result.issues.filter((i) => !codeCodes.has(i.code));
  return { ...result, issues, valid: issues.every((i) => i.severity !== 'error') };
}
