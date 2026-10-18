import { computeGateStateId } from '../../src/core/validation.js';
import { reexpress, writeLockRecord, type LockRecord } from '../../src/core/index.js';

// ---------------------------------------------------------------------------
// What the v5 to v6 upgrade step does to an earlier-reading lock record: carry
// it into the design reading without a review when the record's own identity,
// recomputed, still matches, and write it. The command that used to do this
// (`wairon doctor --fix`) moved into `wairon upgrade`; the approval tests that
// exercise the carry itself call this instead.
// ---------------------------------------------------------------------------

/** Carry the bound project's earlier-reading lock record into the design reading; null when there is nothing to carry. */
export function reexpressLock(): LockRecord | null {
  const carried = reexpress(computeGateStateId());
  if (!carried) return null;
  writeLockRecord(carried);
  return carried;
}
