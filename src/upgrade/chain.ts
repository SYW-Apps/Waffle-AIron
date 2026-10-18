import type { UpgradeChainAnswer, UpgradeStep } from './types.js';

// ---------------------------------------------------------------------------
// upgrade_chain — the fixed table of steps this release keeps, and the pure
// arithmetic over it. Today one step, 5 to 6. The table is contiguous and ends
// at the running major; a test holds it to that. Nothing here reads a file.
// ---------------------------------------------------------------------------

/** The kept steps, oldest first: each reads one major and writes the next. */
const KEPT_STEPS: readonly UpgradeStep[] = [{ from: 5, to: 6 }];

/** iupgrade_chain.between — the steps from the major that wrote a tree to the running major, oldest first. */
export function between(writtenMajor: number, runningMajor: number): UpgradeChainAnswer {
  // Steps 1-2.
  if (writtenMajor === runningMajor) return { state: 'current', steps: [] };
  // Steps 3-4.
  if (writtenMajor > runningMajor) {
    return { state: 'newer', steps: [], advice: `Install a wairon of major ${writtenMajor} to work with this project: it was written by a newer wairon than ${runningMajor}.` };
  }
  // Steps 5-6.
  if (writtenMajor < KEPT_STEPS[0].from) {
    return {
      state: 'out_of_window', steps: [],
      advice: `Install the last release of major ${writtenMajor + 1}, run \`wairon upgrade\` there, then come back to this release.`,
    };
  }
  // Steps 7-8.
  return { state: 'older', steps: KEPT_STEPS.filter((s) => s.from >= writtenMajor && s.to <= runningMajor).map((s) => ({ ...s })) };
}

/** iupgrade_chain.oldestKept — the oldest major a kept step reads. */
export function oldestKept(): number {
  return KEPT_STEPS[0].from;
}

