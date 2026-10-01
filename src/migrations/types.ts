import * as path from 'path';
import type { ChainingMigrationPlan } from './chaining-migration.js';
import type { InternalizeDestination } from '../models/project.js';
import type { ReferenceEdit } from '../models/project-family.js';

// ---------------------------------------------------------------------------
// The value objects of sdd_migrations (stage 6): a family migration as it is
// asked for, planned, rehearsed, committed and recovered. Plain data — the
// behaviour a spec gives them (MigrationPlan.blocked / isEmpty) is the pair of
// functions at the bottom.
// ---------------------------------------------------------------------------

/** migration_request — one family migration as a person or an agent asks for it. */
export interface MigrationRequest {
  /** attach | rename | rename-alias | detach | adopt | internalize | externalize | chaining */
  verb: string;
  alias?: string;
  path?: string;
  project?: string;
  newId?: string;
  newAlias?: string;
  subsystem?: string;
  destination?: InternalizeDestination;
  /** attach: what the member is to the bound project, written into its `members` entry. */
  description?: string;
  /** detach: widen exactly the used family-only exports to the instance audience instead of refusing. */
  widen?: boolean;
  /** false: plan without rehearsing (doctor's summary). Absent or true: a full plan. */
  rehearse?: boolean;
}

/** planned_edit — one semantic change a migration makes in one owner project. */
export interface PlannedEdit {
  /** The owner project's key in the family graph ('' is the family's top root). */
  project: string;
  /** id | member | external | reference | export | pin | move | delete */
  kind: string;
  /** One line naming the edit as the report prints it. */
  detail: string;
  reference?: ReferenceEdit;
  /** The write that realizes it (a membership, identity or boundary verb); absent for a chaining edit. */
  write?: PlannedWrite;
}

/**
 * planned_write — the one write that realizes a planned edit: the owner root
 * the writer binds (as its rehearsal image) and the client-adapter write it
 * makes there, with its arguments exactly as planned.
 */
export interface PlannedWrite {
  /** The owner's live root directory, absolute. */
  root: string;
  /** setId | declareMember | removeMember | declareExternal | repointExternal | removeExternal | renameAlias | renameId | importNames | rewriteReferences | internalizeMember | externalizeSubsystem | pinExternals | renamePin | unpin */
  call: string;
  /** Its arguments, in order. */
  args: unknown[];
}

/** migration_refusal — one reason a family migration will not apply. */
export interface MigrationRefusal {
  code: string;
  project: string;
  detail: string;
}

/** file_change — one file a migration replaces, creates or deletes in one owner project. */
export interface FileChange {
  /** The owner project's root directory, absolute. */
  project: string;
  /** The file, relative to the owner's root, forward slashes (always under .wai/). */
  path: string;
  /** write | create | delete */
  action: 'write' | 'create' | 'delete';
  /** sha256 of the live file when the rehearsal copied it; absent for create. */
  baseDigest?: string;
  /** sha256 of the bytes the swap puts in place; absent for delete. */
  stagedDigest?: string;
}

/** transaction_scope — what a rehearsal copies. */
export interface TransactionScope {
  familyRoot: string;
  projects: string[];
  /**
   * Paths relative to each owner root to copy, compare and swap, forward
   * slashes; absent means ['.wai'] (every family migration). A file named here
   * that does not exist is a create when the rehearsal writes it.
   */
  areas?: string[];
}

/** rehearsal — a private copy of a family's .wai trees. */
export interface Rehearsal {
  id: string;
  directory: string;
  familyRoot: string;
  /** Each copied project's live root → its rehearsal root. */
  roots: Map<string, string>;
  /** Each copied live file (absolute) → sha256 of its bytes when copied. */
  baseDigests: Map<string, string>;
  /** The scope's areas, when it named any: only these are compared. */
  areas?: string[];
}

/** The phases a journal passes through. */
export type TransactionPhase = 'staging' | 'staged' | 'swapping' | 'committed' | 'rolled-back';

/** transaction_journal — one owner project's record of a staged transaction. */
export interface TransactionJournal {
  id: string;
  verb: string;
  /** This owner's root, absolute when written; re-read relative to where the journal was found. */
  owner: string;
  /** The coordinator's root relative to this owner ('' when this owner is the coordinator). */
  coordinator: string;
  /** Coordinator only: every owner's root relative to the coordinator. */
  owners: string[];
  phase: TransactionPhase;
  entries: FileChange[];
  dirsCreated: string[];
  dirsRemoved: string[];
  startedAt: string;
  /** Files a restore could not put back (a journal left for `doctor --fix`). */
  unrestored?: string[];
}

/** transaction_outcome — what committing a staged transaction came to. */
export interface TransactionOutcome {
  committed: boolean;
  written: FileChange[];
  failure?: string;
  restored: boolean;
  unrestored: string[];
}

/** recovered_transaction — what doctor found and did about one unfinished transaction. */
export interface RecoveredTransaction {
  id: string;
  verb: string;
  owners: string[];
  phase: string;
  /** pending | rolled-back | cleaned | refused */
  action: string;
  detail: string;
}

/** migration_plan — a family migration planned and not yet applied. */
export interface MigrationPlan {
  request: MigrationRequest;
  familyRoot: string;
  whole: boolean;
  edits: PlannedEdit[];
  refusals: MigrationRefusal[];
  changes: FileChange[];
  relock: string[];
  notes: string[];
  rehearsal?: Rehearsal;
  chaining?: ChainingMigrationPlan;
}

/** family_migration_report — the answer of applying a family migration. */
export interface FamilyMigrationReport {
  plan: MigrationPlan;
  applied: boolean;
  outcome?: TransactionOutcome;
  relock: string[];
}

/** migration_plan.blocked — true when any refusal is present. */
export function blocked(plan: MigrationPlan): boolean {
  return plan.refusals.length > 0;
}

/** migration_plan.isEmpty — true when there is no file change (a completed migration re-plans empty). */
export function isEmpty(plan: MigrationPlan): boolean {
  return plan.changes.length === 0;
}

/** rehearsal behaviour — a project's rehearsal root: the rehearsal's image of its live directory. */
export function rehearsalRoot(rehearsal: Rehearsal, directory: string): string {
  return rehearsal.roots.get(path.resolve(directory)) ?? path.join(rehearsal.directory, path.relative(rehearsal.familyRoot, directory));
}

/** rehearsal behaviour — a path written in the rehearsal, named by its live project; any other path unchanged. */
export function liveName(rehearsal: Rehearsal, written: string): string {
  const rel = path.relative(rehearsal.directory, written);
  return rel.startsWith('..') || path.isAbsolute(rel) ? written : path.join(rehearsal.familyRoot, rel);
}
