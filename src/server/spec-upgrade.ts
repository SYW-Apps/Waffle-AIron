import * as path from 'path';
import * as hostCore from './adapters/core.js';
import { isRetiredPart, listProjectRecords } from './projects.js';
import { appendAuditEvent, effectiveAuditPolicy } from './audit.js';
import { runWithProjectRoot } from '../utils/fs.js';
import type { ReachabilityMigrationPlan, ReachRewrite } from '../core/index.js';
import type { AuditEvent, HostConfig, PrincipalSubject } from './types.js';

// ---------------------------------------------------------------------------
// hosted_spec_upgrade — the spec-tree rollout migrations of a hosted
// instance's projects, behind `wairon host doctor`.
//
// Operator-invoked, never at bind. The reachability migration rewrites the
// design itself, so every project it touches moves past its approval and owes
// a re-lock — a decision for the people who approve it, not a side effect of
// whoever's request happened to bind the project first. A bind also happens
// under read-only credentials, whose write reach would refuse part of the
// rewrite and leave a tree half-migrated. The retired forms read compatibly
// until the operator runs it, so nothing breaks while a project waits.
// ---------------------------------------------------------------------------

/** One hosted project's reachability migration (hosted_reach_migration). */
export interface HostedReachMigration {
  /** The hosted project record the migration ran at. */
  projectId: string;
  /** The plan (applied with --fix); absent when it failed. */
  plan?: ReachabilityMigrationPlan;
  /** Why it could not be planned or written here; the next project continues. */
  failure?: string;
}

/** The operator behind `wairon host doctor --fix`: authority is access to the data directory. */
const OPERATOR: PrincipalSubject = { userId: 'operator:host-doctor', kind: 'service', issuer: 'local' };

/**
 * ihosted_spec_upgrade.migrateReachability — at every hosted project record
 * holding its own tree, plan the migration onto the reachability model; with
 * apply, write it and audit each project it rewrote.
 */
export function migrateReachability(cfg: Pick<HostConfig, 'dataDir' | 'auditPolicy'>, apply: boolean): HostedReachMigration[] {
  const out: HostedReachMigration[] = [];
  const seen = new Set<string>();
  // Steps 1-2.
  for (const record of listProjectRecords(cfg.dataDir)) {
    if (!record.rootPath) continue;
    // Steps 3-5: a part retired into its parent is its parent's tree.
    if (isRetiredPart(record)) continue;
    const root = path.resolve(record.rootPath);
    if (seen.has(root)) continue;
    seen.add(root);
    // Step 6.
    let plan: ReachabilityMigrationPlan;
    try {
      plan = runWithProjectRoot(root, () => hostCore.migrateReachability(apply));
    } catch (e) {
      out.push({ projectId: record.id, failure: e instanceof Error ? e.message : String(e) });
      continue;
    }
    out.push({ projectId: record.id, plan });
    // Steps 7-8.
    if (plan.applied && plan.rewrites.length > 0) audit(cfg, record.id, plan);
  }
  // Step 9.
  return out;
}

/** Step 8: one migration.reachability audit event per project the run rewrote. */
function audit(cfg: Pick<HostConfig, 'dataDir' | 'auditPolicy'>, projectId: string, plan: ReachabilityMigrationPlan): void {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level: 'info',
    category: 'project',
    action: 'migration.reachability',
    outcome: 'success',
    actor: OPERATOR,
    projectId,
    target: projectId,
    metadata: JSON.stringify({ rewrites: countByForm(plan.rewrites), reported: countByForm(plan.reported) }),
  };
  try {
    appendAuditEvent(cfg.dataDir, event, effectiveAuditPolicy(cfg));
  } catch (e) {
    console.error(`[sdd_host] audit append failed for migration.reachability (project=${projectId}): ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Rewrites counted by their retired form. */
function countByForm(entries: ReachRewrite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.form] = (counts[e.form] ?? 0) + 1;
  return counts;
}
