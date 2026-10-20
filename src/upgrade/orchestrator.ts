import * as chain from './chain.js';
import * as migrations from './adapters/migrations.js';
import * as release from './adapters/release.js';
import * as stamp from './adapters/stamp.js';
import * as v5ToV6 from './steps/v5-to-v6/step.js';
import { runInV5Reading, runWithProjectRoot } from '../utils/fs.js';
import { rehearsalRoot, type FileChange } from '../migrations/types.js';
import { StepRefused } from './types.js';
import type { ReleaseNote, StepPlan, TreeStanding, TreeUpgradeReport, UpgradePlan, UpgradeStep } from './types.js';

// ---------------------------------------------------------------------------
// upgrade_orchestrator — the workflow that brings a family of projects to the
// running wairon major: where a tree stands, the plan (every kept step written
// onto ONE rehearsal copy of the family, the stamps with them), that plan
// applied all or nothing, and the release notes between two versions.
//
// Every step is written onto the rehearsal and the stamps with them, so the
// commit moves the family to the running major all or nothing. A tree already
// in the running major's forms but never stamped (made by 6.0.0) plans no
// rewrite: its upgrade only stamps it. The orchestrator never locks; the
// report names the projects whose approved design moved. It holds no state:
// the plan is a value its caller carries from plan to apply.
//
// The core reads only the running major's forms. The forms wairon 5 wrote are
// read under one binding, the v5 reading, which this orchestrator binds around
// each step's plan and write on the project's rehearsal root and nothing else
// ever binds: the core refuses such a form anywhere else.
// ---------------------------------------------------------------------------

/** The major the one kept step reads: today only 5 to 6 is kept, and its runner is the v5 to v6 tree step. */
const RUNNER_FROM = 5;

/** The major of a version: 6.0.1-dev.3 is major 6. */
function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0], 10);
}

/** A version's [major, minor, patch]; a prerelease suffix is ignored. */
function parts(version: string): number[] {
  const core = version.split(/[-+]/)[0].split('.');
  return [0, 1, 2].map((i) => Number.parseInt(core[i] ?? '0', 10) || 0);
}

/** Compare two versions: negative when a is older. */
function compare(a: string, b: string): number {
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** iupgrade_orchestrator.standing — where the project at the root stands against the running major. */
export function standing(root: string): TreeStanding {
  // Steps 1-3.
  const stamped = stamp.read(root);
  const oldest = chain.oldestKept();
  const runningMajor = majorOf(release.version());
  // Step 4: an unstamped tree is read as the oldest major the kept steps start from.
  const writtenMajor = stamped ?? oldest;
  // Steps 5-6.
  const answer = chain.between(writtenMajor, runningMajor);
  const advice = answer.state === 'older' ? 'Run `wairon upgrade` to bring it to the running major.' : answer.advice;
  return { root, writtenMajor, stamped: stamped !== null, runningMajor, state: answer.state, ...(advice ? { advice } : {}) };
}

/** A plan that writes nothing: the family is current, or the release refuses it. */
function emptyPlan(root: string, runningMajor: number, standings: TreeStanding[], refusal?: string): UpgradePlan {
  return { familyRoot: root, runningMajor, standings, steps: [], whatChanged: [], changes: [], ...(refusal ? { refusal } : {}) };
}

/** iupgrade_orchestrator.plan — plan the upgrade of the family under the root onto one rehearsal. */
export function plan(root: string): UpgradePlan {
  // Step 1: the family as the oldest kept step reads it.
  const roots = v5ToV6.familyRoots(root);
  const runningMajor = majorOf(release.version());
  // Steps 2-3: a part holds no project.yaml, so it carries no stamp of its own.
  const projects = roots.filter((r) => stamp.holdsConfig(r));
  const parts = roots.filter((r) => !projects.includes(r));
  // Steps 4-5.
  const standings = projects.map((r) => standing(r));
  // Steps 6-7: a project this release cannot upgrade refuses the whole plan.
  const stuck = standings.find((s) => s.state === 'newer' || s.state === 'out_of_window');
  if (stuck) return emptyPlan(root, runningMajor, standings, `${stuck.root}: ${stuck.advice ?? stuck.state}`);
  // Steps 8-9: nothing older, nothing to do; the parts are current with the family.
  const olderProjects = standings.filter((s) => s.state === 'older');
  if (olderProjects.length === 0) return emptyPlan(root, runningMajor, standings);
  // Step 10: a part stands with the family, at the oldest major a project of it was
  // written by, so the steps run on it as on the projects. Then a private copy of
  // every root's .wai, and a legacy .wairon folder.
  const oldestWritten = Math.min(...olderProjects.map((s) => s.writtenMajor));
  const partStanding = (r: string): TreeStanding => ({ ...olderProjects[0], root: r, writtenMajor: oldestWritten, stamped: false });
  const older = roots.flatMap((r) => (parts.includes(r) ? [partStanding(r)] : olderProjects.filter((s) => s.root === r)));
  const rehearsal = migrations.rehearse({ familyRoot: root, projects: roots, areas: ['.wai', '.wairon'] });
  const steps: StepPlan[] = [];
  const ran = new Map<number, UpgradeStep>();
  try {
    // Steps 11-16: oldest step first, and within it each older root that runs it, the top first.
    const chains = new Map(older.map((s) => [s.root, chain.between(s.writtenMajor, runningMajor).steps]));
    const kept = [...new Map([...chains.values()].flat().map((s) => [s.from, s])).values()].sort((a, b) => a.from - b.from);
    for (const step of kept) {
      if (step.from !== RUNNER_FROM) throw new Error(`no runner is kept for the step from major ${step.from}`);
      for (const project of older) {
        if (!chains.get(project.root)?.some((s) => s.from === step.from)) continue;
        // Step 13: the project's rehearsal root is the bound root for the step,
        // in the v5 reading: the one binding under which the core reads the
        // forms the step's major wrote.
        const copy = rehearsalRoot(rehearsal, project.root);
        try {
          const planned = runWithProjectRoot(copy, () => runInV5Reading(() => {
            const p = v5ToV6.plan(copy);
            v5ToV6.write(p);
            return p;
          }));
          // Step 16: recorded under the project's live root.
          steps.push({ ...planned, project: project.root });
          ran.set(step.from, step);
        } catch (e) {
          if (e instanceof StepRefused) throw new StepRefusedAt(project.root, step, e.message);
          throw e;
        }
      }
    }
    // Steps 18-20: stamp each older root's rehearsal copy that holds a project.yaml (a step may
    // have written one), so the commit carries the stamps with the rewrites; a part stays unstamped.
    for (const project of older) {
      const copy = rehearsalRoot(rehearsal, project.root);
      if (stamp.holdsConfig(copy)) stamp.write(copy, runningMajor);
    }
    // Steps 21-23.
    const changes = migrations.diff(rehearsal);
    const whatChanged = ran.has(RUNNER_FROM) ? v5ToV6.whatChanged() : [];
    return { familyRoot: root, runningMajor, standings, steps, whatChanged, rehearsal, changes };
  } catch (e) {
    // Steps 24-25: dropped, nothing written live.
    migrations.drop(rehearsal);
    if (e instanceof StepRefusedAt) {
      return emptyPlan(root, runningMajor, standings, `${e.project}: the step from major ${e.step.from} to ${e.step.to} is refused — ${e.reason}`);
    }
    throw e;
  }
}

/** A step's refusal with the project and step it concerns. */
class StepRefusedAt extends Error {
  constructor(readonly project: string, readonly step: UpgradeStep, readonly reason: string) {
    super(reason);
  }
}

/** iupgrade_orchestrator.apply — commit a plan's changes all or nothing and name the projects that owe a re-lock. */
export function apply(plan: UpgradePlan): TreeUpgradeReport {
  // Steps 1-2.
  if (plan.refusal) return { plan, committed: false, failure: plan.refusal, stamped: [], relock: [] };
  // Steps 3-4: nothing to commit, the family is current.
  if (!plan.rehearsal) return { plan, committed: true, stamped: [], relock: [] };
  // Steps 5-7.
  const outcome = migrations.commit(plan.rehearsal, plan.changes as FileChange[], 'upgrade');
  if (!outcome.committed) {
    return { plan, committed: false, failure: outcome.failure ?? 'the transaction did not commit', stamped: [], relock: [] };
  }
  // Steps 8-9: every older project is stamped; each one a step moved the design of owes a re-lock.
  const stamped = plan.standings.filter((s) => s.state === 'older').map((s) => s.root);
  const relock = [...new Set(plan.steps.filter((s) => s.changes.some((c) => c.design)).map((s) => s.project))];
  return { plan, committed: true, stamped, relock };
}

/** iupgrade_orchestrator.discard — drop a plan that will not be applied, removing its rehearsal. */
export function discard(plan: UpgradePlan): void {
  // Steps 1-3.
  if (plan.rehearsal) migrations.drop(plan.rehearsal);
}

/** iupgrade_orchestrator.releaseNotes — the notes after one version up to and including another, newest first. */
export function releaseNotes(after: string | null | undefined, upTo: string): ReleaseNote[] {
  // Step 1.
  const all = release.notes();
  // Steps 2-3.
  const kept = after
    ? all.filter((n) => compare(n.version, after) > 0 && compare(n.version, upTo) <= 0)
    : all.filter((n) => compare(n.version, upTo) === 0);
  return kept.sort((a, b) => compare(b.version, a.version));
}
