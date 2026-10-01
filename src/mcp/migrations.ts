import * as migrations from './adapters/migrations.js';
import { getProjectRoot } from '../utils/fs.js';
import type { FamilyMigrationReport, MigrationRequest } from '../migrations/types.js';

// ---------------------------------------------------------------------------
// mcp_migration_orchestrator — the one workflow behind every member tool that
// changes a family's shape: plan the request, and with dryRun answer the plan
// and drop it; otherwise apply it when nothing refuses. An agent has no
// confirmation prompt, so dryRun is the confirmation. It also answers the
// pending-transaction banner sdd_get_status and sdd_validate_tree lead with.
// ---------------------------------------------------------------------------

/** imcp_migration_orchestrator.run — plan, then apply or drop. Never locks. */
export function run(request: MigrationRequest, dryRun?: boolean): FamilyMigrationReport {
  // Step 1.
  const planned = migrations.plan(request);
  // Steps 2-4: a dry run, a refused plan or an empty one is answered as the plan, not applied.
  if (dryRun === true || planned.refusals.length > 0 || planned.changes.length === 0) {
    migrations.discard(planned);
    return { plan: planned, applied: false, relock: [] };
  }
  // Steps 5-6.
  return migrations.apply(planned);
}

/** imcp_migration_orchestrator.pending — one notice line per unfinished transaction under the bound root. Writes nothing. */
export function pending(): string[] {
  // Step 1: a report, nothing written.
  const found = migrations.recover(getProjectRoot(), false);
  // Step 2.
  return found.map((t) => `an unfinished family migration (${t.verb}, transaction ${t.id}, coordinator phase ${t.phase}) — a person must run \`wairon doctor --fix\` in the project to roll it back before the tree is trusted`);
}
