import { computeGateStateId } from '../../src/core/validation.js';
import { runInV5Reading } from '../../src/utils/fs.js';
import { reexpress, writeLockRecord, type LockRecord } from '../../src/core/index.js';

// ---------------------------------------------------------------------------
// What the v5 to v6 upgrade step does to an earlier-reading lock record: carry
// it into the design reading without a review when the record's own identity,
// recomputed, still matches, and write it. The command that used to do this
// (`wairon doctor --fix`) moved into `wairon upgrade`; the approval tests that
// exercise the carry itself call this instead.
// ---------------------------------------------------------------------------

/**
 * Carry the bound project's earlier-reading lock record into the design reading; null when there is nothing to carry.
 * The record is a wairon 5 form, so the carry runs in the v5 reading, as the upgrade step runs it.
 */
export function reexpressLock(): LockRecord | null {
  return runInV5Reading(() => {
    const carried = reexpress(computeGateStateId());
    if (!carried) return null;
    writeLockRecord(carried);
    return carried;
  });
}
