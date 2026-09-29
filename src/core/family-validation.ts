import * as path from 'path';
import { getProjectRoot, getRequestParentReach, runWithProjectBinding, runWithProjectRoot } from '../utils/fs.js';
// spec_validator: the owner's gate every selected project runs, and the gate
// identity a member's lock is compared with.
import {
  validateProject,
  computeGateStateId,
  type ProjectVerdict,
  type ValidationIssue,
  type ValidationOptions,
  type ValidationResult,
} from './validation.js';
// validator_core_adapter and validator_surfaces_adapter: every name this
// workflow takes from another subsystem lands on the adapter's own module.
import { projectFamily, loadProjectConfig, readLockRecord } from './adapters/validator-core.js';
import { getExternalsStatus } from './adapters/validator-surfaces.js';
import { dependencyCycles, familyNode, type ExternalStatus, type ProjectFamily, type ProjectNode } from '../models/index.js';
import type { ProjectConfig } from '../models/project.js';
import type { IssueSeverity } from './rules/types.js';

// ---------------------------------------------------------------------------
// family_validator — the family run (stage 4).
//
// `validate` at a project that declares members, `validate --family` anywhere,
// and the MCP validate tool with the same flags. It composes; it never
// re-judges. For the root and every selected member it binds that project's
// root and runs the project's OWN gate (spec_validator.validateProject) under
// the project's own configuration, carrying the findings verbatim under the
// project's key; then it compares each of that project's externals, as the
// lock records them, with the producer's live export table; and over the
// root's graph it runs the family checks. An unrelated member's failure
// changes nothing in another member's verdict, because each verdict is that
// member's own gate.
//
// Reach is granted before any read. The caller must gate on reach itself: a
// plain run narrows the ceiling to the family root, `--family` keeps the
// request's reach (an explicit walk up locally, the credential's hosted), and
// nothing here ever widens it. It holds no state.
// ---------------------------------------------------------------------------

/**
 * external_composition — what composing one project's externals produced: the
 * findings, and the aliases of the externals whose producer lay outside the
 * run's reach and were therefore not composed (counted in the run's hint).
 */
export interface ExternalComposition {
  findings: ValidationIssue[];
  notSelected: string[];
}

/** The default severity of each family code — before the owning project's sddRuleSeverity. */
const FAMILY_SEVERITY: Record<string, IssueSeverity> = {
  EXTERNAL_INCOMPATIBLE: 'error',
  EXTERNAL_DRIFTED: 'notice',
  EXTERNAL_CHECK_UNAVAILABLE: 'warning',
  MEMBER_NOT_FOUND: 'error',
  PROJECT_ID_COLLISION: 'error',
  PROJECT_DEPENDENCY_CYCLE: 'warning',
  MEMBER_UNAPPROVED: 'warning',
  MEMBER_DRIFTED: 'warning',
  PROJECT_ID_DEFAULTED: 'notice',
  PROJECT_ID_AMBIGUOUS: 'warning',
};

/** The ceiling a run may read up to: none (the explicit local walk), or a root and whether the caller narrowed it. */
type Ceiling = { topRoot: string; narrowed: boolean } | null;

/** The bound project's configuration; null when it has none or it fails its schema. */
function configOrNull(): ProjectConfig | null {
  try {
    return loadProjectConfig();
  } catch {
    return null;
  }
}

/** A family finding at the owning project's severity; null when that project turned the code off. */
function finding(
  config: ProjectConfig | null,
  code: string,
  message: string,
  project: string,
  specId?: string,
): ValidationIssue | null {
  const override = config?.rules?.sddRuleSeverity?.[code];
  if (override === 'off') return null;
  const severity = (override ?? FAMILY_SEVERITY[code]) as IssueSeverity;
  return { severity, code, message, project, ...(specId !== undefined ? { specId } : {}) };
}

/** How a project key reads in a finding. */
function named(key: string): string {
  return key === '' ? 'the bound project' : `"${key}"`;
}

// ---- reach -----------------------------------------------------------------

/**
 * Step 2: the ceiling the run reads within. A plain run narrows it to the
 * bound root; `--family` keeps the request's: none locally (the walk up is
 * explicit), the credential's hosted — and never above what it already had.
 */
function reachCeiling(root: string, family: boolean | undefined): Ceiling {
  if (!family) return { topRoot: root, narrowed: true };
  const reach = getRequestParentReach();
  if (!reach) return null;
  if (reach.parentReach) return { topRoot: reach.topRoot ?? root, narrowed: !!reach.narrowed };
  return { topRoot: root, narrowed: true };
}

/** Step 4: bind a project's root within the ceiling; the caller's binding is restored afterwards. */
function within<T>(dir: string, ceiling: Ceiling, fn: () => T): T {
  if (ceiling === null) return runWithProjectRoot(dir, fn);
  return runWithProjectBinding(dir, { topRoot: ceiling.topRoot, parentReach: true, narrowed: ceiling.narrowed }, fn);
}

// ---- selection -------------------------------------------------------------

/** How many member levels below the bound root a node lies. */
function depthOf(family: ProjectFamily, node: ProjectNode): number {
  let depth = 0;
  let at: ProjectNode | null = node;
  while (at && at.parent !== undefined) {
    depth++;
    at = familyNode(family, at.parent);
  }
  return depth;
}

/** One selected project, and the subsystem scope its own gate runs with. */
interface Selected {
  node: ProjectNode;
  scope?: string;
}

/**
 * The run's selection: the root and its members, depth-bounded by a numeric
 * `recursive` (false selects the root alone). A scope naming a member — or a
 * subsystem of one, `member::sub` — narrows the run to that member; any other
 * scope is the root's own.
 */
function selectProjects(family: ProjectFamily, options: ValidationOptions): Selected[] {
  const limit = typeof options.recursive === 'number' ? options.recursive : options.recursive === false ? 0 : Infinity;
  const nodes = family.nodes.filter((n) => depthOf(family, n) <= limit);
  const scope = options.scopeSubsystem;
  if (!scope) return nodes.map((node) => ({ node }));
  const member = nodes.find((n) => n.namespace !== '' && (scope === n.namespace || scope.startsWith(`${n.namespace}::`)));
  if (member) return [{ node: member, ...(scope === member.namespace ? {} : { scope: scope.slice(member.namespace.length + 2) }) }];
  const root = nodes.find((n) => n.namespace === '');
  return root ? [{ node: root, scope }] : [];
}

/** The graph narrowed to the selection: its nodes, the references between them, and their problems. */
function narrowed(family: ProjectFamily, selected: Selected[]): ProjectFamily {
  const keys = new Set(['', ...selected.map((s) => s.node.namespace)]);
  return {
    ...family,
    nodes: family.nodes.filter((n) => keys.has(n.namespace)),
    references: family.references.filter((r) => keys.has(r.consumer) && keys.has(r.producer)),
    problems: family.problems.filter((p) => p.projects.every((k) => keys.has(k))),
  };
}

// ---- the family run --------------------------------------------------------

/** One project's own verdict and the composition of its externals. */
interface Judged {
  own: ValidationResult;
  composed: ExternalComposition;
}

/** Steps 5-7: the project's own gate under its own configuration, then its externals composed. */
function judgeProject(project: string, scope: string | undefined, options: ValidationOptions): Judged {
  // Step 5: its own configuration judges it, never the root's.
  const config = configOrNull();
  // Step 6: the same call its own `validate` makes.
  const own = validateProject({
    rules: config?.rules,
    projectType: config?.projectType,
    scopeSubsystem: scope,
    treatAllAsComplete: options.treatAllAsComplete,
    extensions: options.extensions,
  });
  // Step 7: its externals against their live producers in reach.
  return { own, composed: compose(project) };
}

/** Step 8: the project's own totals. */
function verdictOf(node: ProjectNode, own: ValidationResult): ProjectVerdict {
  const count = (severity: IssueSeverity): number => own.issues.filter((i) => i.severity === severity).length;
  return {
    key: node.namespace,
    ...(node.id !== undefined ? { id: node.id } : {}),
    directory: node.directory,
    valid: own.valid,
    errors: count('error'),
    warnings: count('warning'),
    notices: count('notice'),
  };
}

/** Step 10: the one-line hint for the externals the reach left out; undefined when none were. */
function notSelectedHint(left: { project: string; alias: string }[]): string | undefined {
  if (left.length === 0) return undefined;
  const byProject = new Map<string, string[]>();
  for (const { project, alias } of left) byProject.set(project, [...(byProject.get(project) ?? []), alias]);
  const where = [...byProject].map(([project, aliases]) => `${named(project)} (${aliases.map((a) => `"${a}"`).join(', ')})`).join(', ');
  return `${left.length} external${left.length === 1 ? '' : 's'} of ${where} ${left.length === 1 ? 'has its producer' : 'have their producers'} outside this run's reach and ${left.length === 1 ? 'was' : 'were'} not composed; run \`wairon validate --family\` from the project that declares ${left.length === 1 ? 'it' : 'them'} to compose ${left.length === 1 ? 'it' : 'them'}.`;
}

/**
 * ifamily_validator.run — validate the bound project's family: every selected
 * project's own gate verbatim under its key, the composition of each
 * project's externals, then the family checks. Valid when no project's gate
 * and no family finding holds an error.
 */
export function run(options: ValidationOptions): ValidationResult {
  // Step 1: the bound root's graph — nothing above the bound root is in it.
  const family = projectFamily();
  const root = path.resolve(getProjectRoot());
  // Step 2: grant reach before any further read.
  const ceiling = reachCeiling(root, options.family);
  const selected = selectProjects(family, options);
  const issues: ValidationIssue[] = [];
  const projects: ProjectVerdict[] = [];
  const left: { project: string; alias: string }[] = [];
  // Step 3: each selected project, the root first.
  for (const { node, scope } of selected) {
    // Steps 4-7: bound to the project's root within the ceiling.
    const judged = within(node.directory, ceiling, () => judgeProject(node.namespace, scope, options));
    // Step 8: its findings verbatim under its key, the composition beside them, its totals.
    issues.push(...judged.own.issues.map((i) => ({ ...i, project: node.namespace })), ...judged.composed.findings);
    projects.push(verdictOf(node, judged.own));
    left.push(...judged.composed.notSelected.map((alias) => ({ project: node.namespace, alias })));
  }
  // Step 9: the family checks over the root's graph, narrowed to the selection.
  issues.push(...within(root, ceiling, () => checkMembers(narrowed(family, selected))));
  // Step 10: the externals the reach left out.
  const hint = notSelectedHint(left);
  // Step 11: the family verdict.
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
    projects,
    ...(hint ? { hint } : {}),
  };
}

// ---- composition -----------------------------------------------------------

/** What a used member of an external is called in a finding. */
function useName(use: ExternalStatus['uses'][number]): string {
  if (use.publicName === undefined) return use.member !== undefined ? `"${use.member}"` : 'the external';
  if (use.member === undefined || use.member === 'type') return `"${use.publicName}"`;
  return `"${use.publicName}.${use.member}"`;
}

/** Step 7 of compose: one external's status as findings on the consumer. */
function judgeExternal(status: ExternalStatus, project: string, config: ProjectConfig | null): ValidationIssue[] {
  const out: (ValidationIssue | null)[] = [];
  const who = `the external "${status.alias}" (project "${status.project}")`;
  const broken = status.uses.filter((u) => u.state === 'changed' || u.state === 'removed');
  for (const use of broken) {
    const what = use.state === 'changed'
      ? 'changed at signature level since it was pinned'
      : 'is gone from the producer\'s live export table';
    out.push(finding(config, 'EXTERNAL_INCOMPATIBLE',
      `${named(project)} uses ${useName(use)} of ${who}, which ${what}. Adapt the uses, then re-pin (\`wairon externals pin ${status.alias}\`).`,
      project));
  }
  if (broken.length === 0 && status.drifted) {
    out.push(finding(config, 'EXTERNAL_DRIFTED',
      `The producer of ${who} changed since ${named(project)} pinned it, but nothing ${named(project)} uses changed. Re-pin when convenient (\`wairon externals pin ${status.alias}\`).`,
      project));
  }
  for (const use of status.uses.filter((u) => u.state === 'unavailable' || u.state === 'unlocked')) {
    const why = use.detail ?? (use.state === 'unlocked' ? 'used now, but not in the lock' : 'nothing to compare');
    out.push(finding(config, 'EXTERNAL_CHECK_UNAVAILABLE',
      `${named(project)}'s use of ${useName(use)} of ${who} could not be compared with the producer: ${why}. This is never a pass.`,
      project));
  }
  return out.filter((f): f is ValidationIssue => f !== null);
}

/**
 * ifamily_validator.compose — with one project's root bound, compare each of
 * its externals as its lock records them with the producer's live export
 * table: EXTERNAL_INCOMPATIBLE (a used member changed or vanished),
 * EXTERNAL_DRIFTED (the producer changed, nothing used did),
 * EXTERNAL_CHECK_UNAVAILABLE (a use that cannot be compared — never a pass).
 * An external whose producer is out of reach is returned as not selected.
 */
export function compose(project: string): ExternalComposition {
  // Step 1: each external compared at signature level with its live producer.
  const statuses = getExternalsStatus();
  // Step 2: the bound project's own severity overrides.
  const config = configOrNull();
  const findings: ValidationIssue[] = [];
  const notSelected: string[] = [];
  // Step 3: each external, in declaration order.
  for (const status of statuses) {
    // Step 4: is the producer out of reach?
    if (status.outOfReach) {
      // Steps 5-6: not selected — no finding, the run did not reach it.
      notSelected.push(status.alias);
      continue;
    }
    // Steps 7-8: the status as findings.
    findings.push(...judgeExternal(status, project, config));
  }
  // Step 9.
  return { findings, notSelected };
}

// ---- the family checks -----------------------------------------------------

/** Step 1: the graph's member and identity problems. */
function problemFindings(family: ProjectFamily, config: ProjectConfig | null): (ValidationIssue | null)[] {
  const out: (ValidationIssue | null)[] = [];
  for (const problem of family.problems) {
    const project = problem.projects[0] ?? '';
    if (problem.kind === 'member-absent') {
      out.push(finding(config, 'MEMBER_NOT_FOUND',
        `${named(project)} declares the member "${problem.id}", but no project is on disk there: ${problem.detail}. The family cannot be composed without it — restore its directory, or remove the declaration.`,
        project));
    } else if (problem.kind === 'id-collision') {
      out.push(finding(config, 'PROJECT_ID_COLLISION',
        `Two members of one family resolve to the id "${problem.id}": ${problem.detail} — one project declared twice. A project is contained once: to use one project in two roles, keep one member and let the other consumers declare it under \`externals\`; if they are different projects, give each its own id in its .wai/project.yaml.`,
        project));
    } else if (problem.kind === 'defaulted') {
      out.push(finding(config, 'PROJECT_ID_DEFAULTED',
        `The member project keyed "${project}" declares no id in its .wai/project.yaml: ${problem.detail}. Declare \`id: ${problem.id}\` there — its alias, the name the family already knows it by (\`doctor --fix\` writes it).`,
        project));
    } else if (problem.kind === 'no-id') {
      out.push(finding(config, 'PROJECT_ID_AMBIGUOUS',
        `${problem.detail[0].toUpperCase()}${problem.detail.slice(1)}. A project id is lower-case letters, digits, "-", "_" and ".", starting and ending with a letter or a digit — declare one in its .wai/project.yaml.`,
        project));
    }
  }
  return out;
}

/** Step 2: each loop of the selection, on each project in it, with the references that close each edge. */
function cycleFindings(family: ProjectFamily, config: ProjectConfig | null): (ValidationIssue | null)[] {
  const out: (ValidationIssue | null)[] = [];
  for (const loop of dependencyCycles(family)) {
    const edges: { from: string; to: string; refs: ProjectFamily['references'] }[] = [];
    for (let i = 0; i + 1 < loop.length; i++) {
      const [from, to] = [loop[i], loop[i + 1]];
      if (edges.some((e) => e.from === from && e.to === to)) continue;
      edges.push({ from, to, refs: family.references.filter((r) => r.consumer === from && r.producer === to) });
    }
    edges.sort((a, b) => a.refs.length - b.refs.length);
    const walk = loop.map(named).join(' -> ');
    const detail = edges
      .map((e) => `${named(e.from)} -> ${named(e.to)}: ${e.refs.map((r) => `"${r.specId}" ${r.position} "${r.authored}"`).join(', ')}`)
      .join('; ');
    for (const key of new Set(loop)) {
      out.push(finding(config, 'PROJECT_DEPENDENCY_CYCLE',
        `Projects ${walk} depend on each other in a loop, so neither can be approved or released before the other. The edges, cheapest to move first — ${detail}.`,
        key));
    }
  }
  return out;
}

/** Steps 4-7: a present member's lock against its own gate identity. */
function approvalFinding(node: ProjectNode, config: ProjectConfig | null): ValidationIssue | null {
  return runWithProjectRoot(node.directory, () => {
    // Step 5: its own gate identity — never an ancestor's.
    const current = computeGateStateId();
    // Step 6: its lock record.
    const record = readLockRecord();
    // Step 7: none is unapproved; one whose identity differs has drifted.
    if (!record) {
      return finding(config, 'MEMBER_UNAPPROVED',
        `The member ${named(node.namespace)} has never been locked: nobody has approved its design. Lock it at its own root (\`wairon lock\`).`,
        node.namespace);
    }
    if (record.stateId.algorithm !== current.algorithm || record.stateId.digest !== current.digest) {
      return finding(config, 'MEMBER_DRIFTED',
        `The member ${named(node.namespace)} changed since it was approved on ${record.lockedAt}: its lock no longer matches its own gate identity. Re-lock it at its own root (\`wairon lock\`).`,
        node.namespace);
    }
    return null;
  });
}

/**
 * ifamily_validator.checkMembers — the family checks over the root's graph:
 * MEMBER_NOT_FOUND, PROJECT_ID_COLLISION, a member's defaulted or missing id,
 * PROJECT_DEPENDENCY_CYCLE, MEMBER_UNAPPROVED and MEMBER_DRIFTED. Each at the
 * root's sddRuleSeverity override, else the code's default.
 */
export function checkMembers(family: ProjectFamily): ValidationIssue[] {
  const config = configOrNull();
  // Steps 1-2: the graph's problems and its loops.
  const out = [...problemFindings(family, config), ...cycleFindings(family, config)];
  // Step 3: each present member. The root's own lock is not a family finding.
  for (const node of family.nodes) {
    if (node.namespace === '') continue;
    out.push(approvalFinding(node, config));
  }
  // Step 8: resolved and returned.
  return out.filter((f): f is ValidationIssue => f !== null);
}
