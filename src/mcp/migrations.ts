import * as fs from 'fs';
import * as path from 'path';
import * as migrations from './adapters/migrations.js';
import { loadProjectConfig, reinjectLocalGuides, registerProjectServer } from './adapters/core.js';
import { exportSddSkills } from './adapters/skills.js';
import { getProjectRoot, runWithProjectRoot } from '../utils/fs.js';
import { activeTargetTypes } from '../models/project.js';
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
  // Step 1: the plan, announcing the findings its result will have.
  const planned = migrations.plan({ ...request, announce: true });
  // Steps 2-4: a dry run, a refused plan or an empty one is answered as the plan, not applied.
  if (dryRun === true || planned.refusals.length > 0 || planned.changes.length === 0) {
    migrations.discard(planned);
    return { plan: planned, applied: false, relock: [] };
  }
  // Step 5.
  const report = migrations.apply(planned);
  // Steps 6-10: a project the migration made is set up for its own sessions, as the CLI's verbs do.
  const made = report.applied ? madeProjectRoot(report) : null;
  if (made !== null) report.sessionScaffold = scaffoldSession(made);
  // Step 11.
  return report;
}

/** The root of the project an applied promote (or externalize as project) made: the one whose L0 it created. */
function madeProjectRoot(report: FamilyMigrationReport): string | null {
  const { request, changes } = report.plan;
  if (!(request.verb === 'promote' || (request.verb === 'externalize' && request.as === 'project'))) return null;
  const created = changes.find((c) => c.action === 'create' && c.path.replace(/\\/g, '/') ==='.wai/specs/.index.yaml');
  const root = created?.project ?? null;
  return root !== null && fs.existsSync(path.join(root, '.wai', 'project.yaml')) ? root : null;
}

/**
 * Steps 7-10 of run: under the new project's binding, its guides and root
 * pointer, its skills and — when claude is one of its targets — its portable
 * .mcp.json; every file written, relative to its root. A failure is answered
 * as a line naming what to run there, never thrown: the migration committed.
 */
function scaffoldSession(root: string): string[] {
  try {
    return runWithProjectRoot(root, () => {
      const config = loadProjectConfig();
      const targets = config ? activeTargetTypes(config) : ['claude'];
      const written = [...reinjectLocalGuides(root, targets)];
      written.push(...exportSddSkills(targets).destinations);
      if (targets.includes('claude')) {
        const server = registerProjectServer(root);
        if (server !== null) written.push(server);
      }
      return written.map((f) => path.relative(root, f).replace(/\\/g, '/') || '.');
    });
  } catch (e) {
    return [`not set up (${e instanceof Error ? e.message : String(e)}): run \`wairon generate\` and \`wairon mcp install --backend claude\` there`];
  }
}

/** imcp_migration_orchestrator.pending — one notice line per unfinished transaction under the bound root. Writes nothing. */
export function pending(): string[] {
  // Step 1: a report, nothing written.
  const found = migrations.recover(getProjectRoot(), false);
  // Step 2.
  return found.map((t) => `an unfinished family migration (${t.verb}, transaction ${t.id}, coordinator phase ${t.phase}) — a person must run \`wairon doctor --fix\` in the project to roll it back before the tree is trusted`);
}
