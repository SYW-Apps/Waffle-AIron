import { projectFamily } from '../../src/core/index.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { write, type ChainingMigrationPlan, type ChainingMigrationReport } from '../../src/migrations/chaining-migration.js';
import * as transaction from '../../src/migrations/transaction.js';

// ---------------------------------------------------------------------------
// The chaining migration applied the way stage 6 applies it: its writes
// rehearsed on a copy of the family's .wai trees, the copy's difference
// committed through the family transaction (staged, backed up, swapped) —
// answering the chaining migration's own report, so the stage 2c–4 tests keep
// asserting what it wrote, in write order, named by live project.
//
// It is the family migration orchestrator's apply with the chaining report
// kept: nothing here is mocked, and a refusal still throws before anything
// live moves (the rehearsal is dropped).
// ---------------------------------------------------------------------------

export function apply(plan: ChainingMigrationPlan): ChainingMigrationReport {
  const family = runWithProjectRoot(plan.familyRoot, () => projectFamily());
  const rehearsal = transaction.rehearse({ familyRoot: plan.familyRoot, projects: family.nodes.map((n) => n.directory) });
  let report: ChainingMigrationReport;
  try {
    report = write(plan, rehearsal);
  } catch (e) {
    transaction.discard(rehearsal);
    throw e;
  }
  const changes = transaction.diff(rehearsal);
  if (changes.length === 0) {
    transaction.discard(rehearsal);
    return report;
  }
  const outcome = transaction.commit(rehearsal, changes, 'chaining');
  if (!outcome.committed) throw new Error(`the chaining migration's transaction did not commit: ${outcome.failure}`);
  return report;
}
