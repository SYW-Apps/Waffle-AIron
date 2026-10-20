import type { FileChange, Rehearsal } from '../migrations/types.js';

// ---------------------------------------------------------------------------
// The value objects of sdd_upgrade: where a project tree stands against the
// running wairon major, the steps between two majors, what each step plans for
// a project, the plan for a whole family and the report of applying it. Plain
// data; the behaviour lives in the chain and the orchestrator.
// ---------------------------------------------------------------------------

/** tree_standing_state — where a project tree stands against the running wairon major. */
export type TreeStandingState = 'current' | 'older' | 'newer' | 'out_of_window';

/** tree_standing — one project tree's standing, read from its stamp alone. */
export interface TreeStanding {
  /** The project root, absolute. */
  root: string;
  /** The major the tree's stamp names; for an unstamped tree, the oldest major the kept steps start from. */
  writtenMajor: number;
  /** Whether the tree carries a stamp. */
  stamped: boolean;
  /** The major of the running wairon. */
  runningMajor: number;
  state: TreeStandingState;
  /** For older: the command that upgrades it; for newer and out_of_window: the release to install. */
  advice?: string;
  /** True for a tree stamped current that still holds wairon 5 forms: an upgrade an earlier release left unfinished. */
  unfinished?: boolean;
}

/** upgrade_step — one kept step of the chain: it moves a tree from one major to the next. */
export interface UpgradeStep {
  from: number;
  /** from + 1. */
  to: number;
}

/** upgrade_chain_answer — the steps between two majors, or why there are none to take. */
export interface UpgradeChainAnswer {
  state: TreeStandingState;
  /** The steps to run, oldest first; empty unless the state is older. */
  steps: UpgradeStep[];
  /** For newer and out_of_window: the release to install. */
  advice?: string;
}

/** upgrade_change — one rewrite a step plans in one project. */
export interface UpgradeChange {
  /** The spec it touches, when it touches one. */
  spec?: string;
  /** The rewrite in one line: the old form and the form it becomes. */
  description: string;
  /** Whether it changes the approved design, so the project owes a re-lock. */
  design: boolean;
}

/** step_plan — one step's plan for one project of the family. */
export interface StepPlan {
  step: UpgradeStep;
  /** The project root, absolute. */
  project: string;
  changes: UpgradeChange[];
  /** What it will not rewrite because only an author can decide it, each with the decision to make. */
  reported: string[];
}

/** upgrade_plan — what upgrading a family to the running major would do. */
export interface UpgradePlan {
  /** The top root the plan was made from, absolute. */
  familyRoot: string;
  runningMajor: number;
  /** Each project of the family, the top first. */
  standings: TreeStanding[];
  /** Every step's plan for every older project, oldest step first. */
  steps: StepPlan[];
  whatChanged: string[];
  /** Why the family cannot be upgraded by this release; nothing is applied then. */
  refusal?: string;
  /** The private copy of the family the steps were written onto. */
  rehearsal?: Rehearsal;
  /** Every file the upgrade replaces, creates or deletes, per project. */
  changes: FileChange[];
}

/** tree_upgrade_report — what applying an upgrade plan came to. */
export interface TreeUpgradeReport {
  plan: UpgradePlan;
  committed: boolean;
  failure?: string;
  /** The project roots now stamped with the running major. */
  stamped: string[];
  /** The project roots whose approved design moved: each owes `wairon lock`. */
  relock: string[];
}

/** release_note — the curated notes of one release. */
export interface ReleaseNote {
  /** The release version, e.g. 6.1.0. */
  version: string;
  /** The most important changes, at most a handful, most important first. */
  highlights: string[];
}

/** StepRefused — a step cannot move a project on its own and names what the author must decide first. */
export class StepRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepRefused';
  }
}
