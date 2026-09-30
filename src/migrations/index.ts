import * as orchestrator from './orchestrator.js';
import * as positionReader from './position-reader.js';
import type { PositionalMatch } from './position-reader.js';
import type { AuthoredReference, ProjectFamily, ResolvedExportTable, TypeSpec } from '../models/index.js';
import type { FamilyMigrationReport, MigrationPlan, MigrationRequest, RecoveredTransaction } from './types.js';

// ---------------------------------------------------------------------------
// migration_portal — the published surface of the family migrations, shared by
// the CLI (`wairon doctor`'s chaining migration and transaction recovery, the
// status and validate banners), the MCP server and the hosted server: plan,
// apply a confirmed plan, discard one, recover (or only report) unfinished
// transactions, and — a pure read — the positional match the upgrade report
// explains, which lives here with the migration that writes from it. It
// terminates the in-process call and routes each write to the family migration
// workflow, because a Portal never performs the write itself. The caller must
// gate on reach itself.
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
