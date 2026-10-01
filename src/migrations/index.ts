import * as orchestrator from './orchestrator.js';
import * as transaction from './transaction.js';
import * as positionReader from './position-reader.js';
import type { PositionalMatch } from './position-reader.js';
import type { AuthoredReference, ProjectFamily, ResolvedExportTable, TypeSpec } from '../models/index.js';
import type {
  FamilyMigrationReport,
  FileChange,
  MigrationPlan,
  MigrationRequest,
  RecoveredTransaction,
  Rehearsal,
  TransactionOutcome,
  TransactionScope,
} from './types.js';

// ---------------------------------------------------------------------------
// migration_portal — the published surface of the family migrations, shared by
// the CLI (`wairon doctor`'s chaining migration and transaction recovery, the
// status and validate banners), the MCP server and the hosted server: plan,
// apply a confirmed plan, discard one, recover (or only report) unfinished
// transactions, and — a pure read — the positional match the upgrade report
// explains, which lives here with the migration that writes from it. It also
// publishes the family transaction itself (rehearse, diff, commit, drop) for
// the hosted member upgrade, which scopes the host data directory's store
// files and commits them through the same all-or-nothing transaction. It
// terminates the in-process call and routes each write to a workflow, because
// a Portal never performs the write itself. The caller must gate on reach
// itself.
// ---------------------------------------------------------------------------

/** imigration_portal.plan — plan a family migration from the bound project. Writes nothing into the family. */
export function plan(request: MigrationRequest): MigrationPlan {
  return orchestrator.plan(request);
}

/** imigration_portal.apply — apply a confirmed plan all or nothing. */
export function apply(plan: MigrationPlan): FamilyMigrationReport {
  return orchestrator.apply(plan);
}

/** imigration_portal.discard — drop a plan without applying it. */
export function discard(plan: MigrationPlan): void {
  orchestrator.discard(plan);
}

/** imigration_portal.recover — report or resolve the unfinished transactions under a project root. */
export function recover(root: string, fix: boolean): RecoveredTransaction[] {
  return orchestrator.recover(root, fix);
}

/** imigration_portal.matchPositions — the positional match (position_reader.match). Pure; writes nothing. */
export function matchPositions(unresolved: AuthoredReference[], family: ProjectFamily, tables: ResolvedExportTable[], types: TypeSpec[]): PositionalMatch[] {
  return positionReader.match(unresolved, family, tables, types);
}

/** imigration_portal.rehearse — route to the family transaction: open a rehearsal over a scope. */
export function rehearse(scope: TransactionScope): Rehearsal {
  return transaction.rehearse(scope);
}

/** imigration_portal.diff — route to the family transaction: the rehearsal's difference from the live owners. */
export function diff(rehearsal: Rehearsal): FileChange[] {
  return transaction.diff(rehearsal);
}

/** imigration_portal.commit — route to the family transaction: the changes made live all or nothing. */
export function commit(rehearsal: Rehearsal, changes: FileChange[], verb: string): TransactionOutcome {
  return transaction.commit(rehearsal, changes, verb);
}

/** imigration_portal.drop — route to the family transaction: discard a rehearsal, writing nothing live. */
export function drop(rehearsal: Rehearsal): void {
  transaction.discard(rehearsal);
}
