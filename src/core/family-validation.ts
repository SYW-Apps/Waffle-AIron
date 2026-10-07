import * as fs from 'fs';
import * as path from 'path';
import { getHostedLookup, getProjectRoot, getRequestParentReach, runWithProjectBinding, runWithProjectRoot, type HostedRecordLookup } from '../utils/fs.js';
// spec_validator: the owner's gate every selected project runs, and the gate
// identity a member's lock is compared with.
import {
  validateProject,
  ownReachModel,
  computeGateStateId,
  type ProjectVerdict,
  type ValidationIssue,
  type ValidationOptions,
  type ValidationResult,
} from './validation.js';
// validator_core_adapter and validator_surfaces_adapter: every name this
// workflow takes from another subsystem lands on the adapter's own module.
import {
  projectFamily,
  loadProjectConfig,
  readLockRecord,
  approvalRecord,
  loadProjectExtensions,
  packManifest,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './adapters/validator-core.js';
import { getExternalsStatus } from './adapters/validator-surfaces.js';
import { dependencyCycles, declaredExternals, declaredMembers, familyNode, keyIn, relationHealth, type AuthoredReference, type ExternalStatus, type ProjectFamily, type ProjectNode, type ProjectRelations } from '../models/index.js';
import { admits, rangeProblem, requiredPolicies, type PackRequirement, type PackSelection, type ProjectConfig } from '../models/project.js';
import { packSettings, type PackSettings } from '../models/pack-impact.js';
import type { LoadedExtensions } from './extensions.js';
import type { IssueSeverity } from './rules/types.js';
import type { StateId } from './statehash.js';
import type { PinState, ProjectApproval } from '../models/lock.js';
import type { NetworkDeclaration } from '../models/project.js';
import type { ReachFinding, ReachModel } from '../models/reach.js';
// reach_model_projector and network_arbiter: the family's reach model and its
// network verdicts — pure, over the models each project's own gate projected.
import { compose as composeReach } from './rules/reach-model-projector.js';
import { judge as judgeNetwork, familyCodes } from './rules/network-arbiter.js';

/** A project's lock record, as the core adapter reads one. */
type LockRecord = NonNullable<ReturnType<typeof approvalRecord>>;

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
  // The advisory live comparison (advise): printed and counted, never part of a failure decision.
  EXTERNAL_LIVE_INCOMPATIBLE: 'warning',
  EXTERNAL_LIVE_UNCOMPARED: 'notice',
  MEMBER_NOT_FOUND: 'error',
  PROJECT_ID_COLLISION: 'error',
  PROJECT_DEPENDENCY_CYCLE: 'warning',
  MEMBER_UNAPPROVED: 'warning',
  MEMBER_DRIFTED: 'warning',
  PROJECT_ID_DEFAULTED: 'notice',
  PROJECT_ID_AMBIGUOUS: 'warning',
  // Governance: a required pack not adopted blocks; a member's deviation from
  // an adopted pack's settings is visible and never fails --ci.
  POLICY_NOT_ADOPTED: 'error',
  POLICY_DEVIATION: 'notice',
  // Reachability and networks (checkReach): the network arbiter's codes over
  // the family's reach model. The first three a declaring project's own gate
  // also judges over its own tree; the family run judges the networks around
  // its members, and alone proves network-scoped entries.
  GATEWAY_BYPASSED: 'error',
  MULTIPLE_GATEWAYS: 'notice',
  EXPORT_BEYOND_NETWORK: 'warning',
  ENTRY_SCOPE_UNBOUNDED: 'notice',
  ENTRY_UNPROVEN: 'warning',
  // An allow of one of those codes the family's model gives no finding at its
  // site: the project's own gate leaves that judgement to the family run.
  UNUSED_LINT_ALLOW: 'warning',
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

/**
 * Step 4: bind a project's root within the ceiling; the caller's binding is
 * restored afterwards. A hosted request's record lookup rides into the new
 * scope, so a `source.hosted` producer resolves within the caller's reach (and
 * one out of it stays unavailable) instead of being lost with the binding.
 */
function within<T>(dir: string, ceiling: Ceiling, fn: () => T): T {
  if (ceiling === null) return runWithProjectRoot(dir, fn);
  const lookup = getHostedLookup();
  return runWithProjectBinding(dir, { topRoot: ceiling.topRoot, parentReach: true, narrowed: ceiling.narrowed, ...(lookup ? { hostedLookup: lookup } : {}) }, fn);
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
 * The run's selection: the root and its members, depth-bounded by
 * `memberDepth` (absent, every level; 0 selects the root alone). A scope naming a member — or a
 * subsystem of one, `member::sub` — narrows the run to that member; any other
 * scope is the root's own.
 */
function selectProjects(family: ProjectFamily, options: ValidationOptions): Selected[] {
  const limit = options.memberDepth ?? Infinity;
  const nodes = family.nodes.filter((n) => depthOf(family, n) <= limit);
  const scope = options.scopeSubsystem;
  if (!scope) return nodes.map((node) => ({ node }));
  const member = nodes.find((n) => n.namespace !== '' && (scope === n.namespace || scope.startsWith(`${n.namespace}::`)));
  if (member) return [{ node: member, ...(scope === member.namespace ? {} : { scope: scope.slice(member.namespace.length + 2) }) }];
  const root = nodes.find((n) => n.namespace === '');
  return root ? [{ node: root, scope }] : [];
}

/**
 * One referenced project member of a selected project (stage 8): a `../`, git
 * or hosted source whose content is a project's, with the root it is opened at
 * — its sibling checkout, the fetch cache at its pinned commit, or the root the
 * hosting server's record lookup answers within reach — or why it cannot be.
 */
interface Referenced {
  key: string;
  alias: string;
  parent: string;
  directory?: string;
  commit?: string;
  problem?: string;
}

/** Each selected project's referenced project members, in declaration order, each located where it is stored. */
function referencedOf(nodes: ProjectNode[]): Referenced[] {
  const out: Referenced[] = [];
  for (const node of nodes) {
    for (const e of node.externals) {
      if (e.role !== 'member') continue;
      let directory = e.directory;
      let problem = e.problem;
      if (e.sourceKind === 'hosted') {
        const lookup = getHostedLookup();
        const root = lookup && e.hosted !== undefined ? lookup(e.hosted) : null;
        if (root) directory = path.resolve(root);
        else problem = lookup ? `the hosted member \`${e.hosted}\` is unknown or outside this request's reach` : `hosted-only member \`${e.hosted}\`: available only through the hosted server`;
      }
      if (directory !== undefined && !fs.existsSync(directory)) {
        problem = `its root ${directory} does not exist`;
        directory = undefined;
      }
      out.push({
        key: keyIn(node.namespace, e.alias), alias: e.alias, parent: node.namespace,
        ...(directory !== undefined ? { directory } : {}), ...(e.commit !== undefined ? { commit: e.commit } : {}),
        ...(directory === undefined ? { problem: problem ?? 'its root could not be located' } : {}),
      });
    }
  }
  return out;
}

/** A referenced member's root bound read-only, its own root its ceiling: nothing above it is read. */
function atReferenced<T>(ref: Referenced, fn: () => T): T {
  const lookup = getHostedLookup();
  return runWithProjectBinding(ref.directory!, { topRoot: ref.directory!, parentReach: true, narrowed: true, ...(lookup ? { hostedLookup: lookup } : {}) }, fn);
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

/** A project's own reach model, under its own configuration (the binding the caller holds). */
function ownReachOf(options: ValidationOptions): ReachModel {
  const config = configOrNull();
  return ownReachModel({
    rules: config?.rules,
    projectType: config?.projectType,
    treatAllAsComplete: options.treatAllAsComplete,
    extensions: options.extensions,
  });
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
  const models = new Map<string, ReachModel>();
  // Step 3: each selected project, the root first.
  for (const { node, scope } of selected) {
    // Steps 4-7: bound to the project's root within the ceiling.
    const judged = within(node.directory, ceiling, () => judgeProject(node.namespace, scope, options));
    // Step 8: the project's own reach model under the same binding, for the family's reach checks.
    models.set(node.namespace, within(node.directory, ceiling, () => ownReachOf(options)));
    // Step 9: its findings verbatim under its key, the composition beside them, its totals.
    issues.push(...judged.own.issues.map((i) => ({ ...i, project: node.namespace })), ...judged.composed.findings);
    projects.push(verdictOf(node, judged.own));
    left.push(...judged.composed.notSelected.map((alias) => ({ project: node.namespace, alias })));
  }
  // Step 3 (stage 8): then each referenced project member, opened where it is
  // stored — one whose root cannot be opened is left out (checkMembers counts it).
  for (const ref of referencedOf(selected.map((s) => s.node)).filter((r) => r.directory !== undefined)) {
    const judged = atReferenced(ref, () => judgeProject(ref.key, undefined, options));
    issues.push(...judged.own.issues.map((i) => ({ ...i, project: ref.key })), ...judged.composed.findings);
    projects.push(verdictOf({ namespace: ref.key, directory: ref.directory! } as ProjectNode, judged.own));
  }
  // Step 10: topics paired across the family — a topic a sibling consumes goes somewhere.
  const paired = pairTopicsAcrossFamily(issues, models);
  issues.splice(0, issues.length, ...paired);
  // Step 11: the family checks over the root's graph, narrowed to the selection.
  issues.push(...within(root, ceiling, () => checkMembers(narrowed(family, selected))));
  // Step 10: the governance checks — each requiring project's requirements against the members below it.
  issues.push(...within(root, ceiling, () => checkPolicies(narrowed(family, selected))));
  // Step 12: the reachability and network checks only the family can make.
  issues.push(...within(root, ceiling, () => checkReach(narrowed(family, selected), models)));
  // Step 11: the externals the reach left out.
  const hint = notSelectedHint(left);
  // Step 12: the family verdict, with the bound project's externals the run
  // composed as its gate — the advisory pass gives them no second word.
  const rootSelected = selected.find((s) => s.node.namespace === '');
  const composed = rootSelected
    ? rootSelected.node.externals.map((e) => e.alias).filter((alias) => !left.some((l) => l.project === '' && l.alias === alias))
    : [];
  return {
    valid: issues.every((i) => i.severity !== 'error'),
    issues,
    projects,
    ...(hint ? { hint } : {}),
    ...(composed.length ? { composed } : {}),
  };
}

// ---- composition -----------------------------------------------------------

/** What a used member of an external is called in a finding. */
function useName(use: ExternalStatus['uses'][number]): string {
  if (use.publicName === undefined) return use.member !== undefined ? `"${use.member}"` : 'the external';
  if (use.member === undefined || use.member === 'type') return `"${use.publicName}"`;
  return `"${use.publicName}.${use.member}"`;
}

/** A used member that broke since the pin: changed, renamed or gone. */
function isBroken(use: ExternalStatus['uses'][number]): boolean {
  return use.state === 'changed' || use.state === 'removed' || use.state === 'renamed';
}

/** How a broken use moved, as a finding says it: changed at signature level, renamed to its new name, or gone. */
function howMoved(use: ExternalStatus['uses'][number]): string {
  if (use.state === 'changed') return 'changed at signature level since it was pinned';
  if (use.state === 'renamed') {
    const changed = use.detail?.includes('signature changed') ? ' (and its signature changed)' : '';
    return `was renamed to "${use.renamedTo}"${changed}, per the producer's rename trace`;
  }
  return `is gone from the producer's live export table${use.detail ? ` (${use.detail})` : ''}`;
}

/** What a stale pinned snapshot no longer matches, as a sentence tail; '' when nothing. */
function staleTail(status: ExternalStatus): string {
  const facts = status.staleFacts ?? [];
  return facts.length
    ? ` Its pinned snapshot is stale: ${facts.join(', ')} changed in the producer, and the rules judge the pin (a library's abi, an entry's transport or role) — re-pinning refreshes it.`
    : '';
}

/** Step 7 of compose: one external's status as findings on the consumer. */
function judgeExternal(status: ExternalStatus, project: string, config: ProjectConfig | null): ValidationIssue[] {
  const out: (ValidationIssue | null)[] = [];
  const who = `the external "${status.alias}" (project "${status.project}")`;
  const broken = status.uses.filter(isBroken);
  for (const use of broken) {
    const fix = use.state === 'renamed' ? 'Follow the rename in the uses' : 'Adapt the uses';
    out.push(finding(config, 'EXTERNAL_INCOMPATIBLE',
      `${named(project)} uses ${useName(use)} of ${who}, which ${howMoved(use)}. ${fix}, then re-pin (\`wairon externals pin ${status.alias}\`).`,
      project));
  }
  if (broken.length === 0 && (status.drifted || (status.staleFacts?.length ?? 0) > 0)) {
    out.push(finding(config, 'EXTERNAL_DRIFTED',
      `The producer of ${who} changed since ${named(project)} pinned it, but nothing ${named(project)} uses changed.${staleTail(status)} Re-pin when convenient (\`wairon externals pin ${status.alias}\`).`,
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

// ---- the advisory live comparison ------------------------------------------
//
// THE PIN GATES, LIVE DRIFT IS VISIBLE. The owner's gate judges each external
// against its pin, reproducibly; this pass compares the externals the run did
// not compose with their LIVE producers — offline, within the request's reach
// — so a consumer whose producer broke hears it from plain `validate` and
// `status`. Every finding is marked advisory: printed and counted, never part
// of `valid` or `--ci`.

/** The command a moved external is fixed with once its uses are adapted. */
function repin(alias: string): string {
  return `\`wairon externals pin ${alias}\``;
}

/** Every spec of the bound project whose references use one public name of an external, sorted. */
function specsUsing(family: ProjectFamily, alias: string, publicName: string | undefined): string[] {
  const specs = family.authoredReferences
    .filter((r) => (family.owners.get(r.specId) ?? '') === ''
      && (r.authored.startsWith(`${alias}::`) || (r.importedVia ?? '').split(', ').includes(alias))
      && (publicName === undefined || (r.publicName ?? r.authored.split('::')[r.form === 'import' ? 0 : 1]) === publicName))
    .map((r) => r.specId);
  return [...new Set(specs)].sort();
}

/** One moved use, as the advisory finding names it. */
function movedUse(use: ExternalStatus['uses'][number]): string {
  return `${useName(use)} ${howMoved(use).replace(/^was renamed/, 'renamed').replace(/^is gone/, 'gone')}`;
}

/** Why an external could not be compared live: the status's own reason, else its uses'. */
function uncomparedReason(status: ExternalStatus): string {
  const reasons = [status.detail, ...status.uses.filter((u) => u.state === 'unavailable' || u.state === 'unlocked').map((u) => u.detail)]
    .filter((r): r is string => !!r);
  return [...new Set(reasons)].join('; ') || 'the live producer could not be read';
}

/** An advisory finding at the bound project's severity; null when it turned the code off. */
function advisory(config: ProjectConfig | null, code: string, message: string): ValidationIssue | null {
  const issue = finding(config, code, message, '');
  if (!issue) return null;
  const { project: _own, ...rest } = issue;
  return { ...rest, advisory: true };
}

/** Steps 5-11 for one external: its health as at most one advisory finding. */
function adviseOn(status: ExternalStatus, family: ProjectFamily, config: ProjectConfig | null): ValidationIssue | null {
  const who = `the external "${status.alias}" (project "${status.project}")`;
  switch (relationHealth(status)) {
    case 'incompatible': {
      // Step 6: what moved, who uses it, the fix.
      const broken = status.uses.filter(isBroken);
      const users = [...new Set(broken.flatMap((u) => specsUsing(family, status.alias, u.publicName)))].sort();
      const renamed = broken.some((u) => u.state === 'renamed');
      return advisory(config, 'EXTERNAL_LIVE_INCOMPATIBLE',
        `${who} moved in its live producer since it was pinned: ${broken.map(movedUse).join('; ')}. `
        + `Used by ${users.length ? users.map((s) => `"${s}"`).join(', ') : 'this project\'s references'}. `
        + `Adapt the uses${renamed ? ' (follow the rename)' : ''}, then re-pin with ${repin(status.alias)}. Advisory: the pin still gates.`);
    }
    case 'drifted':
      // Step 8.
      return advisory(config, 'EXTERNAL_DRIFTED',
        `The live producer of ${who} moved since it was pinned, but nothing this project uses changed.${staleTail(status)} Re-pin when convenient (${repin(status.alias)}).`);
    case 'unavailable': {
      // Step 10: never a pass, never a failure of the owner's gate.
      const reason = uncomparedReason(status);
      const how = reason.includes('wairon externals status') ? '' : ' `wairon externals status` compares it live.';
      return advisory(config, 'EXTERNAL_LIVE_UNCOMPARED',
        `${who} was not compared with its live producer: ${reason}. Only its pin judged it — not a pass of the live producer.${how}`);
    }
    default:
      return null;
  }
}

/**
 * ifamily_validator.advise — compare each of the bound project's externals the
 * run did not compose with its LIVE producer, offline, within the request's
 * reach, and report what moved: EXTERNAL_LIVE_INCOMPATIBLE (warning),
 * EXTERNAL_DRIFTED (notice), EXTERNAL_LIVE_UNCOMPARED (notice) — every one
 * marked advisory, so neither `valid` nor `validate --ci` decides on it.
 * Writes nothing.
 */
export function advise(composed?: string[]): ValidationIssue[] {
  // Nothing declared, nothing to compare — and no graph to read for it.
  const declared = configOrNull();
  if (!declared || (declaredExternals(declared).length === 0 && declaredMembers(declared).length === 0)) return [];
  try {
    // Step 1: each external compared with its live producer, offline.
    const statuses = getExternalsStatus(true);
    // Step 2: the bound project's own severity overrides.
    const config = declared;
    // Step 3: the bound project's references, to name who uses each moved member.
    const family = projectFamily();
    const skip = new Set(composed ?? []);
    const out: ValidationIssue[] = [];
    // Steps 4-12: each external the run did not compose, in declaration order.
    for (const status of statuses) {
      if (skip.has(status.alias)) continue;
      const issue = adviseOn(status, family, config);
      if (issue) out.push(issue);
    }
    // Step 13.
    return out;
  } catch {
    // An unreadable tree or configuration is the owner's gate's to report;
    // the advisory pass never fails a run.
    return [];
  }
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

/** Step 4: a present member's approval state as a family finding; null when it is approved. */
function approvalFinding(entry: ProjectApproval, config: ProjectConfig | null): ValidationIssue | null {
  if (entry.state === 'never') {
    return finding(config, 'MEMBER_UNAPPROVED',
      `The member ${named(entry.key)} has never been locked: nobody has approved its design. Lock it at its own root (\`wairon lock\`).`,
      entry.key);
  }
  if (entry.state === 'drifted' && entry.upgraded) {
    return finding(config, 'MEMBER_DRIFTED',
      `The member ${named(entry.key)} was approved under an earlier gate identity — the gate identity gained inputs in this release (members' composition subjects, \`composition\`; code conformance moved beside the claim), which says nothing about its design. Re-lock it once at its own root (\`wairon lock\`).`,
      entry.key);
  }
  if (entry.state === 'drifted') {
    return finding(config, 'MEMBER_DRIFTED',
      `The member ${named(entry.key)} changed since it was approved: its lock no longer matches its own gate identity. Re-lock it at its own root (\`wairon lock\`).`,
      entry.key);
  }
  return null;
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
  // Step 3: every member's approval state, each at its own root — the same
  // answer the lock records and status prints.
  const present = new Set(family.nodes.filter((n) => n.namespace !== '').map((n) => n.namespace));
  // Stage 8: each referenced project member — present when its root opens; one
  // that cannot be opened is unavailable once, never a pass.
  for (const ref of referencedOf(family.nodes)) {
    if (ref.directory !== undefined) {
      present.add(ref.key);
      continue;
    }
    out.push(finding(config, 'EXTERNAL_CHECK_UNAVAILABLE',
      `The referenced member ${named(ref.key)} could not be opened: ${ref.problem}. Its own gate and its composition did not run — this is never a pass.`,
      ref.parent));
  }
  // Step 4: each present project member. The root's own lock is not a family finding.
  for (const entry of projectApprovals()) {
    if (present.has(entry.key) && entry.as !== 'part') out.push(approvalFinding(entry, config));
  }
  // Step 8: resolved and returned.
  return out.filter((f): f is ValidationIssue => f !== null);
}

// ---- the pin tree ----------------------------------------------------------
//
// Each project's approval state, computed at that project's OWN root — its
// lock record against its own gate identity recomputed there — so the answer
// about a project is the same whichever root asked (status-agrees). Reads each
// project's own tree once and writes nothing.

/** A StateId rendered as a composition subject. */
function subjectOf(record: LockRecord): string {
  return `${record.stateId.algorithm}:${record.stateId.digest}`;
}

/** Steps 4-7: one loaded project's own state, bound to its own root. */
function ownApproval(node: ProjectNode, root: string): ProjectApproval {
  return approvalAt(node, { topRoot: root, narrowed: true });
}

/** Steps 4-7 at one project root, bound within a ceiling. */
function approvalAt(node: Pick<ProjectNode, 'namespace' | 'mountAlias' | 'parent' | 'id' | 'directory'>, ceiling: Ceiling): ProjectApproval {
  return within(node.directory, ceiling, () => {
    // Step 5: its own gate identity — its tree, its members' recorded subjects.
    const current = computeGateStateId();
    // Step 6: its own lock record.
    const record = readLockRecord();
    const base: ProjectApproval = {
      key: node.namespace,
      ...(node.mountAlias !== undefined ? { alias: node.mountAlias } : {}),
      ...(node.parent !== undefined ? { parent: node.parent } : {}),
      ...(node.id !== undefined ? { projectId: node.id } : {}),
      state: 'never',
    };
    // Step 7: none is never; a matching identity is approved — for a format-2
    // record, matching the identity recomputed under its own algorithm
    // (asRecorded) — else drifted, upgraded when only the algorithm marker moved.
    if (!record) return base;
    const same = (id: StateId | undefined): boolean => !!id && record.stateId.algorithm === id.algorithm && record.stateId.digest === id.digest;
    const matches = same(current) || same(current.asRecorded);
    return {
      ...base,
      state: matches ? 'approved' : 'drifted',
      subject: subjectOf(record),
      ...(!matches && record.stateId.algorithm !== current.algorithm ? { upgraded: true } : {}),
    };
  });
}

/**
 * Steps 8-9: how the parent's lock pinned a member — its `members` entry, else
 * (format 1, for one release) its `children` entry.
 */
function pinOf(parent: LockRecord | null, alias: string, subject: string | undefined): PinState {
  if (!parent) return 'unpinned';
  const recorded = parent.members
    ? (alias in parent.members ? parent.members[alias].subject ?? 'never' : undefined)
    : parent.children?.[alias];
  if (recorded === undefined) return 'unpinned';
  return recorded === (subject ?? 'never') ? 'matches' : 'moved';
}

/**
 * ifamily_validator.approvals — the bound project's pin tree: the root's own
 * entry first, then each member within `depth` levels (all when omitted), in
 * walk order. A declared member with no project on disk is `never`, with no
 * subject, and nothing is bound for it. The caller must gate on reach itself
 * before it asks about a family.
 */
export function projectApprovals(depth?: number): ProjectApproval[] {
  // Step 1: the bound root's project graph.
  const family = projectFamily();
  const root = path.resolve(getProjectRoot());
  // Step 2: the projects to answer for.
  const limit = depth ?? Infinity;
  const selected = family.nodes.filter((n) => depthOf(family, n) <= limit);
  const directoryOf = new Map(family.nodes.map((n) => [n.namespace, n.directory]));
  const parentRecord = (key: string): LockRecord | null => {
    const dir = directoryOf.get(key);
    return dir === undefined ? null : approvalRecord(dir);
  };
  // Steps 3-9: each loaded project at its own root, and its parent's pin.
  const entries: ProjectApproval[] = selected.map((node) => {
    const own = ownApproval(node, root);
    if (node.parent === undefined || node.mountAlias === undefined) return own;
    return { ...own, pinned: pinOf(parentRecord(node.parent), node.mountAlias, own.subject) };
  });
  // A declared member with no project on disk: never, bound to nothing.
  for (const problem of family.problems) {
    if (problem.kind !== 'member-absent' || !problem.id) continue;
    const parentKey = problem.projects[0] ?? '';
    const parentNode = family.nodes.find((n) => n.namespace === parentKey);
    if (!parentNode || depthOf(family, parentNode) + 1 > limit) continue;
    entries.push({
      key: parentKey === '' ? problem.id : `${parentKey}::${problem.id}`,
      alias: problem.id,
      parent: parentKey,
      state: 'never',
      pinned: pinOf(parentRecord(parentKey), problem.id, undefined),
    });
  }
  // Stage 8: each referenced project member of a selected project, at the root
  // it is opened at (its sibling checkout, or the fetch cache at its pinned
  // commit), and how its declaring project's lock pinned it.
  for (const ref of referencedOf(selected)) {
    if (ref.directory === undefined) {
      entries.push({ key: ref.key, alias: ref.alias, parent: ref.parent, as: 'project', state: 'never', pinned: pinOf(parentRecord(ref.parent), ref.alias, undefined) });
      continue;
    }
    const own = approvalAt({ namespace: ref.key, mountAlias: ref.alias, parent: ref.parent, directory: ref.directory }, { topRoot: ref.directory, narrowed: true });
    entries.push({ ...own, as: 'project', ...(ref.commit !== undefined ? { commit: ref.commit } : {}), pinned: pinOf(parentRecord(ref.parent), ref.alias, own.subject) });
  }
  // Stage 8: each part of a selected project, answered as a part — approved
  // exactly when its declaring project is (its approval is that project's),
  // with its content digest and the commit it was read at.
  for (const node of selected) {
    const declaring = entries.find((e) => e.key === node.namespace);
    for (const part of node.parts) {
      entries.push({
        key: node.namespace === '' ? part.alias : `${node.namespace}::${part.alias}`,
        alias: part.alias,
        parent: node.namespace,
        as: 'part',
        state: declaring?.state ?? 'never',
        ...(part.contentDigest !== undefined ? { contentDigest: part.contentDigest } : {}),
        ...(part.commit !== undefined ? { commit: part.commit } : {}),
      });
    }
  }
  // Step 10: root first.
  return entries;
}

// ---- relation health -------------------------------------------------------
//
// What the canvas colours its consumption edges from: each project's externals
// status read at its OWN root — the very comparison compose judges — and, for a
// contained project member it references (no external, so no status names it),
// its own gate's findings on those references. Writes nothing, judges nothing.

/** The reach a relation read is bound with: the caller's grant, else the bound root; the request's record lookup kept. */
type RelationReach = { topRoot: string; parentReach: boolean; narrowed?: boolean; hostedLookup?: HostedRecordLookup };

/**
 * Step 2: the reach the caller granted — a hosted request's credential reach,
 * with its record lookup — or null when none was granted: a local caller reads
 * with no ceiling, the explicit walk `validate --family` makes, so a `../`
 * producer a project declares is compared rather than left out of reach.
 */
function relationReach(root: string): RelationReach | null {
  const granted = getRequestParentReach();
  if (!granted) return null;
  const lookup = getHostedLookup();
  const base = granted.parentReach
    ? { topRoot: granted.topRoot ?? root, parentReach: true, ...(granted.narrowed ? { narrowed: true } : {}) }
    : { topRoot: root, parentReach: true, narrowed: true };
  return { ...base, ...(lookup ? { hostedLookup: lookup } : {}) };
}

/** Why a contained member cannot be read in this request; null when it can (a hosted record the lookup answers, or no hosted request at all). */
function outsideReach(node: ProjectNode): string | null {
  const lookup = getHostedLookup();
  if (!lookup || node.namespace === '') return null;
  return lookup(node.id ?? node.namespace) === null ? `the project "${node.id ?? node.namespace}" lies outside this request's reach` : null;
}

/** What a reference into a contained member is called as a use: the public name it bound to, else the name it reaches. */
function referenceUse(ref: AuthoredReference): string {
  return ref.publicName ?? ref.resolved.split('::').pop() ?? ref.authored;
}

/** The gate's resolution failure at one reference's call site, if any. */
function failureAt(ref: AuthoredReference, failures: ValidationIssue[]): ValidationIssue | undefined {
  const site = `${ref.specId} (${ref.position})`;
  const last = ref.resolved.split('::').pop() ?? '';
  return failures.find((i) => i.resolution!.callSite === site
    && (i.resolution!.canonicalTarget === ref.authored || (i.resolution!.canonicalTarget ?? '').endsWith(`::${last}`)));
}

/** Step 11: one contained member's relation, from the consumer's own gate findings on its references into it. */
function containedStatus(child: ProjectNode, refs: AuthoredReference[], failures: ValidationIssue[]): ExternalStatus {
  const base = { alias: child.mountAlias!, project: child.id ?? child.namespace, sourceKind: 'family' as const, pinned: false };
  const unreachable = outsideReach(child);
  if (unreachable) {
    const uses = [...new Set(refs.map(referenceUse))].map((name) => ({ publicName: name, state: 'unavailable' as const, code: 'EXTERNAL_CHECK_UNAVAILABLE', detail: unreachable }));
    return { ...base, reachable: false, stale: false, outOfReach: true, uses, detail: unreachable };
  }
  const uses: ExternalStatus['uses'] = [];
  for (const ref of refs) {
    const failed = failureAt(ref, failures);
    const use: ExternalStatus['uses'][number] = failed
      ? { publicName: referenceUse(ref), state: 'removed', code: failed.code, detail: failed.resolution!.reason }
      : { publicName: referenceUse(ref), state: 'unchanged' };
    if (!uses.some((u) => u.publicName === use.publicName && u.state === use.state)) uses.push(use);
  }
  return { ...base, reachable: true, stale: uses.some((u) => u.state === 'removed'), uses, detail: 'a contained member, read live — nothing is pinned' };
}

/** Steps 7-11: with one project's root bound, a status per contained project member it references that no status already answers. */
function containedRelations(answered: ExternalStatus[]): ExternalStatus[] {
  // Step 8: its own graph — the references it writes into its own members.
  const own = projectFamily();
  const consumed = own.nodes
    .filter((n) => n.parent === '' && n.mountAlias !== undefined && !answered.some((s) => s.alias === n.mountAlias))
    .map((child) => ({
      child,
      refs: own.authoredReferences.filter((r) => (own.owners.get(r.specId) ?? '') === '' && r.producer === child.namespace && r.binding !== 'local'),
    }))
    .filter((c) => c.refs.length > 0);
  // Step 7: nothing contained is consumed.
  if (consumed.length === 0) return [];
  // Steps 9-10: its own gate under its own configuration, for the failures it raises on those references.
  const config = configOrNull();
  const failures = validateProject({ rules: config?.rules, projectType: config?.projectType })
    .issues.filter((i) => i.resolution !== undefined && i.resolution.outcome !== 'resolved');
  // Step 11.
  return consumed.map(({ child, refs }) => containedStatus(child, refs, failures));
}

/** Steps 5-12: one project's relations, bound to its own root within the reach. */
function relationsAt(key: string, dir: string, reach: RelationReach | null): ProjectRelations {
  const bound = <T>(fn: () => T): T => (reach === null ? runWithProjectRoot(dir, fn) : runWithProjectBinding(dir, reach, fn));
  return bound(() => {
    // Step 6: everything it consumes as an external or a referenced member.
    const statuses = getExternalsStatus();
    // Steps 7-11: what it consumes of its own contained members.
    const contained = containedRelations(statuses);
    // Step 12.
    return { project: key, externals: [...statuses, ...contained], comparedAt: new Date().toISOString() };
  });
}

/** Step 14: a project whose statuses could not be read — every edge from it unavailable, never a pass. */
function unopened(key: string, detail: string): ProjectRelations {
  return { project: key, externals: [], comparedAt: new Date().toISOString(), detail };
}

/**
 * ifamily_validator.relations — the family's relation health for the canvas:
 * the bound root and each project member at every level, contained and
 * referenced, each with its externals status read at its own root and stamped
 * with when; one that cannot be opened within the reach is answered with its
 * reason and no statuses. The caller grants the reach before it asks.
 */
export function familyRelations(): ProjectRelations[] {
  // Step 1: the bound root's graph.
  const family = projectFamily();
  const root = path.resolve(getProjectRoot());
  // Step 2: the projects to answer for, and the reach granted.
  const reach = relationReach(root);
  const out: ProjectRelations[] = [];
  // Steps 3-15: each contained project, root first.
  for (const node of family.nodes) {
    // Step 4: can its root be opened within the reach?
    const unreachable = outsideReach(node);
    if (unreachable || !fs.existsSync(node.directory)) {
      out.push(unopened(node.namespace, unreachable ?? `its root ${node.directory} does not exist`));
      continue;
    }
    out.push(relationsAt(node.namespace, node.directory, reach));
  }
  // Then each referenced project member, at the root it is opened at — its own root its ceiling.
  for (const ref of referencedOf(family.nodes)) {
    if (ref.directory === undefined) {
      out.push(unopened(ref.key, ref.problem ?? 'its root could not be located'));
      continue;
    }
    const lookup = getHostedLookup();
    out.push(relationsAt(ref.key, ref.directory, { topRoot: ref.directory, parentReach: true, narrowed: true, ...(lookup ? { hostedLookup: lookup } : {}) }));
  }
  // Step 16: root first.
  return out;
}

// ---- the governance checks -------------------------------------------------
//
// Each selected project that declares composition.requirePolicies requires
// those packs of every selected member below it. Judged from the members'
// committed files only, so the family verdict is the same on every machine;
// nothing here reads the requirements at a member's own gate, and nothing
// here compares a pack with wairon's defaults — a pack's own loosening of
// wairon's checks is never a finding.

/** How a requiring project reads in a finding. */
function requiredBy(key: string): string {
  return key === '' ? 'the family root' : `"${key}"`;
}

/** A requirement as a finding names it: pack, range and profile. */
function requirementText(requirement: PackRequirement): string {
  return `"${requirement.pack}" ${requirement.version}${requirement.profile ? ` (profile "${requirement.profile}")` : ''}`;
}

/** Whether `node` lies below `ancestor` in the graph, at any level. */
function isBelow(family: ProjectFamily, node: ProjectNode, ancestor: string): boolean {
  let at: ProjectNode | null = node;
  while (at && at.parent !== undefined) {
    if (at.parent === ancestor) return true;
    at = familyNode(family, at.parent);
  }
  return false;
}

/** A governance finding at its default severity, stamped with the member's key. */
function policyIssue(code: 'POLICY_NOT_ADOPTED' | 'POLICY_DEVIATION', message: string, member: string, specId?: string): ValidationIssue {
  return { severity: FAMILY_SEVERITY[code], code, message, project: member, ...(specId !== undefined ? { specId } : {}) };
}

/** Step 9 of checkPolicies: one requiring project's findings at its own sddRuleSeverity, those it turned off dropped. */
function tunedBy(config: ProjectConfig | null, issues: ValidationIssue[]): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of issues) {
    const tuned = finding(config, issue.code, issue.message, issue.project ?? '', issue.specId);
    if (tuned) out.push(tuned);
  }
  return out;
}

/**
 * ifamily_validator.checkPolicies — the governance checks over the root's
 * graph. Every selected project that declares composition.requirePolicies
 * requires those packs of every selected member below it; a requirement whose
 * range does not parse is skipped here (the requiring project's own gate
 * reports it). Each finding is at the REQUIRING project's sddRuleSeverity
 * override, else its default.
 */
export function checkPolicies(family: ProjectFamily): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  // Step 1: each selected project with members in the selection, root first.
  for (const requirer of family.nodes) {
    const members = family.nodes.filter((n) => isBelow(family, n, requirer.namespace));
    if (members.length === 0) continue;
    // Steps 2-4: its own configuration, and its requirements that parse.
    const config = runWithProjectRoot(requirer.directory, configOrNull);
    const valid = config ? requiredPolicies(config).filter((r) => r.pack.trim() !== '' && rangeProblem(r) === null) : [];
    // Step 5: nothing valid is required here.
    if (valid.length === 0) continue;
    const caused: ValidationIssue[] = [];
    // Steps 6-8: each member below it, judged with its own root bound.
    for (const member of members) {
      caused.push(...runWithProjectRoot(member.directory, () => judgeAdoption(requirer.namespace, member.namespace, valid)));
    }
    // Step 9: at this project's overrides.
    out.push(...tunedBy(config, caused));
  }
  // Step 10.
  return out;
}

/** The member's entry for a required pack: a selection of that name, else a legacy path reference whose committed manifest carries it. */
interface AdoptedEntry {
  entry: PackSelection | string;
  /** The committed version: the selection's pin, or the legacy manifest's declared version. */
  version?: string;
  /** For a legacy path reference: its committed manifest's name. */
  label: string;
}

/** Step 4 of adoption: the member's entry for the pack, read from its committed configuration and manifests. */
function entryFor(config: ProjectConfig, loaded: LoadedExtensions, pack: string): AdoptedEntry | null {
  const entries = config.extensions?.packs ?? [];
  const selection = entries.find((e): e is PackSelection => typeof e !== 'string' && e.name === pack);
  if (selection) return { entry: selection, ...(selection.version ? { version: selection.version } : {}), label: selection.version ? `${selection.name}@${selection.version}` : selection.name };
  for (const ref of entries.filter((e): e is string => typeof e === 'string')) {
    const committed = loaded.packs.find((p) => p.scope === 'project' && p.ref === ref && p.name === pack);
    if (committed) return { entry: ref, ...(committed.version ? { version: committed.version } : {}), label: `${ref} (${committed.name}${committed.version ? `@${committed.version}` : ', unversioned'})` };
  }
  return null;
}

/**
 * ifamily_validator.adoption — with one member's root bound: its adoption of
 * the requirements one requiring project places on it, from its committed
 * files only. POLICY_NOT_ADOPTED when it has no entry for the pack, the entry
 * floats (no version pin), the committed version is outside the range, or the
 * required profile does not govern it; an adopted requirement's settings are
 * then compared by policyDeviations. Answered at the default severities.
 */
export function judgeAdoption(requiring: string, member: string, requirements: PackRequirement[]): ValidationIssue[] {
  // Step 1: the member's own configuration.
  const config = configOrNull();
  if (!config) return [];
  // Step 2: its packs, for the committed manifests its legacy references name.
  const loaded = loadProjectExtensions();
  const out: ValidationIssue[] = [];
  const who = `The member ${named(member)}`;
  // Step 3: each requirement.
  for (const requirement of requirements) {
    const wanted = `${requirementText(requirement)}, required by ${requiredBy(requiring)}`;
    // Step 4: the member's entry for the pack.
    const adopted = entryFor(config, loaded, requirement.pack);
    // Steps 5-7: not selected at all.
    if (!adopted) {
      out.push(policyIssue('POLICY_NOT_ADOPTED', `${who} does not select the pack ${wanted}. Select it in the member's own configuration (\`wairon pack use ${requirement.pack}@<version> --pin\` at its root).`, member));
      continue;
    }
    // Steps 8-10: a floating selection cannot be judged.
    if (typeof adopted.entry !== 'string' && !adopted.entry.version) {
      out.push(policyIssue('POLICY_NOT_ADOPTED', `${who} selects "${adopted.label}" for the pack ${wanted}, unpinned — a family cannot judge a floating selection; pin a version (\`wairon pack use ${requirement.pack}@<version> --pin\`).`, member));
      continue;
    }
    // Steps 11-13: outside the range.
    if (!admits(requirement, adopted.version)) {
      out.push(policyIssue('POLICY_NOT_ADOPTED', `${who} selects "${adopted.label}", outside the range of the pack ${wanted}: ${adopted.version ? `version ${adopted.version} is not admitted by "${requirement.version}"` : `an unversioned pack is admitted by "*" only`}.`, member));
      continue;
    }
    // Steps 14-16: the required profile does not govern.
    if (requirement.profile && config.projectType !== requirement.profile) {
      out.push(policyIssue('POLICY_NOT_ADOPTED', `${who} selects "${adopted.label}" for the pack ${wanted}, but is governed by "${config.projectType}", not the required profile "${requirement.profile}". Set its projectType to "${requirement.profile}".`, member));
      continue;
    }
    // Steps 17-19: the adopted pack's manifest, the loader's way; one that did not load has no settings.
    const manifest = packManifest(adopted.entry);
    if (!manifest) continue;
    // Step 20: the member's overrides against the pack's settings under the governing profile.
    const governing = requirement.profile ?? (config.projectType in manifest.profiles ? config.projectType : null);
    out.push(...policyDeviations(member, requirement, packSettings(manifest, governing)));
    // Step 21: judged.
  }
  // Step 22.
  return out;
}

/** A value as a finding quotes it. */
function shown(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

/** One key-level overlay's deviations: each key the pack sets that the member replaces with another value. */
function keyDeviations(label: string, packValues: Record<string, unknown> | undefined, memberValues: Record<string, unknown> | undefined): { setting: string; pack: unknown; member: unknown }[] {
  const out: { setting: string; pack: unknown; member: unknown }[] = [];
  for (const [key, value] of Object.entries(packValues ?? {})) {
    if (value === undefined || key === 'stereotypes') continue;
    const mine = memberValues?.[key];
    if (mine !== undefined && JSON.stringify(mine) !== JSON.stringify(value)) out.push({ setting: `${label}.${key}`, pack: value, member: mine });
  }
  return out;
}

/** Every lint.allow on the member's specs, with the spec it sits on. */
function lintAllows(): { specId: string; code: string; at?: string }[] {
  const specs: { id: string; lint?: { allow?: { code: string; at?: string }[] } }[] = [
    ...loadSubsystemSpecs(), ...loadComponentSpecs(), ...loadInterfaceSpecs(), ...loadImplementationSpecs(), ...loadTypeSpecs(),
  ];
  return specs.flatMap((s) => (s.lint?.allow ?? []).map((a) => ({ specId: s.id, code: a.code, ...(a.at !== undefined ? { at: a.at } : {}) })));
}

/**
 * ifamily_validator.deviations — with one member's root bound: every override
 * the member makes against the settings an adopted pack sets under its
 * governing profile, as POLICY_DEVIATION (notice): rule severities, design
 * depth (project and subsystem), naming, complexity and documentation keys, a
 * subsystem profile other than the governing one, and each lint.allow over a
 * code the pack sets. A key the profile does not set is not a deviation, and
 * nothing is compared with wairon's defaults.
 */
export function policyDeviations(member: string, requirement: PackRequirement, settings: PackSettings): ValidationIssue[] {
  // Steps 1-6: the member's configuration and specs.
  const rules = configOrNull()?.rules;
  const subsystems = loadSubsystemSpecs();
  const allows = lintAllows();
  const under = settings.profile ? `under its profile "${settings.profile}"` : 'with none of its profiles governing';
  const about = `the pack "${requirement.pack}" (required ${requirement.version})`;
  const deviation = (setting: string, pack: unknown, mine: unknown, specId?: string): ValidationIssue =>
    policyIssue('POLICY_DEVIATION', `The member ${named(member)} adopted ${about} but changes ${setting}: the pack sets ${shown(pack)} ${under}, the member ${shown(mine)}. Visible, not blocking — the member's own configuration decides.`, member, specId);
  const out: ValidationIssue[] = [];
  // Step 7: rule severities the pack sets.
  for (const [code, severity] of Object.entries(rules?.sddRuleSeverity ?? {})) {
    const packs = settings.severities[code];
    if (packs !== undefined && packs !== severity) out.push(deviation(`rules.sddRuleSeverity.${code}`, packs, severity));
  }
  // Step 8: design depth, the project's and each subsystem's.
  if (settings.designDepth) {
    if (rules?.designDepth && rules.designDepth !== settings.designDepth) out.push(deviation('rules.designDepth', settings.designDepth, rules.designDepth));
    for (const s of subsystems) {
      if (s.designDepth && s.designDepth !== settings.designDepth) out.push(deviation(`the designDepth of subsystem "${s.id}"`, settings.designDepth, s.designDepth, s.id));
    }
  }
  // Step 9: naming (with each stereotypes entry), complexity and documentation keys.
  const overlays = [
    ...keyDeviations('rules.naming', settings.naming, rules?.naming),
    ...keyDeviations('rules.naming.stereotypes', settings.naming?.stereotypes, rules?.naming?.stereotypes),
    ...keyDeviations('rules.complexity', settings.complexity, rules?.complexity),
    ...keyDeviations('rules.documentation', settings.documentation, rules?.documentation),
  ];
  for (const o of overlays) out.push(deviation(o.setting, o.pack, o.member));
  // Step 10: a subsystem governed by another profile.
  if (settings.profile) {
    for (const s of subsystems) {
      if (s.profile && s.profile !== settings.profile) out.push(deviation(`the profile of subsystem "${s.id}"`, settings.profile, s.profile, s.id));
    }
  }
  // Step 11: each lint.allow over a code the pack sets.
  for (const allow of allows) {
    if (settings.severities[allow.code] === undefined) continue;
    out.push(deviation(`a lint.allow of ${allow.code}${allow.at ? ` at "${allow.at}"` : ''} on "${allow.specId}"`, settings.severities[allow.code], 'allowed', allow.specId));
  }
  // Step 12.
  return out;
}

// ---- reachability and networks ---------------------------------------------
//
// The proofs only the family can make. Each selected project's own gate judged
// its own tree; this composes the family's reach model from each project's own
// model and the family's cross-project references, and judges it: the networks
// around a member, every call that crosses into a network, and the proof of
// every network-scoped entry. A member's own verdict is unchanged by it.

/** Each selected project's network declaration, read from its configuration under its own binding. */
function networksOf(family: ProjectFamily): Map<string, NetworkDeclaration> {
  const out = new Map<string, NetworkDeclaration>();
  for (const node of family.nodes) {
    const network = runWithProjectRoot(node.directory, configOrNull)?.network;
    if (network) out.set(node.namespace, network);
  }
  return out;
}

/** A spec key qualified into the family root's key space, back to the owning project's local key. */
function localKey(project: string, key: string): string {
  return project !== '' && key.startsWith(`${project}::`) ? key.slice(project.length + 2) : key;
}

/**
 * The key of the project a finding of the family's reach model sits on: the
 * project holding the spec it names — a verb's Portal (MULTIPLE_GATEWAYS sits
 * on its network's first gateway Portal), a call's caller. Never read from a
 * name in the message.
 */
function projectOfFinding(model: ReachModel, finding: { code: string; specId?: string; at?: string; message: string }): string {
  if (finding.specId === undefined) return '';
  const verb = model.verbs.find((v) => v.portal === finding.specId);
  if (verb) return verb.project;
  const call = model.calls.find((c) => c.fromComponent === finding.specId && c.evidence === finding.at);
  return call?.fromProject ?? '';
}

/**
 * ifamily_validator.checkReach — the reachability and network checks only the
 * family run can make: GATEWAY_BYPASSED, MULTIPLE_GATEWAYS and
 * EXPORT_BEYOND_NETWORK on a member's verbs and on calls crossing into a
 * network, ENTRY_UNPROVEN and ENTRY_SCOPE_UNBOUNDED for every network-scoped
 * entry. A finding a project's own gate already carried is not repeated; each
 * is stamped with the project whose spec it sits on, tuned by that project's
 * rules.sddRuleSeverity, and dropped when a lint.allow on that spec covers it
 * at its site.
 */
export function checkReach(family: ProjectFamily, models: Map<string, ReachModel>): ValidationIssue[] {
  // Step 1: each selected project's network declaration.
  const networks = networksOf(family);
  // Steps 2-3: the family's reach model, judged.
  const model = composeReach(models, family, networks);
  const findings = judgeNetwork(model);
  // Step 4: what each declaring project's own gate already carried (its own
  // network over its own tree) is not repeated.
  const carried = new Set<string>();
  for (const [key, own] of models) {
    if (!networks.has(key)) continue;
    for (const f of judgeNetwork(own)) {
      carried.add(`${key}\u0000${f.code}\u0000${f.specId ?? ''}\u0000${f.at ?? ''}`);
    }
  }
  const nodeOf = new Map(family.nodes.map((n) => [n.namespace, n] as const));
  const configs = new Map<string, ProjectConfig | null>();
  const allows = new Map<string, { specId: string; code: string; at?: string }[]>();
  const out: ValidationIssue[] = [];
  for (const f of findings) {
    const project = projectOfFinding(model, f);
    const local = f.specId !== undefined ? localKey(project, f.specId) : undefined;
    if (carried.has(`${project}\u0000${f.code}\u0000${local ?? ''}\u0000${f.at ?? ''}`)) continue;
    const node = nodeOf.get(project);
    if (!configs.has(project)) configs.set(project, node ? runWithProjectRoot(node.directory, configOrNull) : null);
    if (!allows.has(project)) allows.set(project, node ? runWithProjectRoot(node.directory, lintAllows) : []);
    // A lint.allow on the spec the finding sits on covers it at its site.
    const allowed = local !== undefined && (allows.get(project) ?? []).some((a) =>
      a.specId === local && a.code === f.code && (a.at ?? undefined) === (f.at ?? undefined));
    if (allowed) continue;
    const tuned = finding(configs.get(project) ?? null, f.code, f.message, project, f.specId);
    if (tuned) out.push(tuned);
  }
  // Steps 5-6: an allow of a code the family judges, on a selected project's
  // own spec, that covers no finding of the family's model at its site (carried
  // by the project's own gate or not) is stale. The project's own gate left
  // that judgement here, because only this run sees every finding of them.
  const codes = new Set(familyCodes());
  const fired = new Set(carried);
  for (const f of findings) {
    const project = projectOfFinding(model, f);
    fired.add(`${project}\u0000${f.code}\u0000${f.specId !== undefined ? localKey(project, f.specId) : ''}\u0000${f.at ?? ''}`);
  }
  for (const key of models.keys()) {
    const node = nodeOf.get(key);
    if (!node) continue;
    if (!allows.has(key)) allows.set(key, runWithProjectRoot(node.directory, lintAllows));
    if (!configs.has(key)) configs.set(key, runWithProjectRoot(node.directory, configOrNull));
    for (const a of allows.get(key) ?? []) {
      // A contained member's specs are keyed under its namespace: its own run judges them.
      if (!codes.has(a.code) || a.specId.includes('::')) continue;
      if (fired.has(`${key}\u0000${a.code}\u0000${a.specId}\u0000${a.at ?? ''}`)) continue;
      const at = a.at !== undefined ? ` at "${a.at}"` : '';
      const stale = finding(
        configs.get(key) ?? null,
        'UNUSED_LINT_ALLOW',
        `Spec "${a.specId}"${key === '' ? '' : ` of ${named(key)}`} allows "${a.code}"${at}, but the family run reports no such finding there — remove the stale allow (the project's own gate leaves allows of the family's reach codes to this run).`,
        key,
        key === '' ? a.specId : `${key}::${a.specId}`,
      );
      if (stale) out.push(stale);
    }
  }
  // Step 7.
  return out;
}

/**
 * ifamily_validator.reachModel — the family's reach model at the bound root,
 * for the derived networking outputs: the same selection and reach the family
 * run makes, each selected project's own model (spec_validator.reachModel
 * under its own binding), composed with the family's references. At a project
 * without members it is that project's own model, composed. Reads; writes
 * nothing.
 */
export function reachModel(options: ValidationOptions): ReachModel {
  // Step 1: the bound root's project graph, and the selection the family run makes.
  const family = projectFamily();
  const root = path.resolve(getProjectRoot());
  const ceiling = reachCeiling(root, options.family);
  const selected = selectProjects(family, options);
  const models = new Map<string, ReachModel>();
  // Steps 2-4: each selected project's own model, under its own binding.
  for (const { node } of selected) {
    models.set(node.namespace, within(node.directory, ceiling, () => ownReachOf(options)));
  }
  // Step 5: composed.
  const scoped = narrowed(family, selected);
  return within(root, ceiling, () => {
    const model = composeReach(models, scoped, networksOf(scoped));
    // Steps 6-7: judged, so no derived output trusts a design that fails the
    // gate: each finding tuned by the severity of the project whose spec it
    // sits on, and dropped when a lint.allow there covers it at its site (an
    // error is never allowed, so a refused flow stays refused).
    return { ...model, findings: judgedFindings(model, scoped) };
  });
}

/** Steps 6-7 of reachModel: the composed model's network findings, tuned and lint-allow filtered. */
function judgedFindings(model: ReachModel, family: ProjectFamily): ReachFinding[] {
  const nodeOf = new Map(family.nodes.map((n) => [n.namespace, n] as const));
  const configs = new Map<string, ProjectConfig | null>();
  const allows = new Map<string, { specId: string; code: string; at?: string }[]>();
  const out: ReachFinding[] = [];
  for (const f of judgeNetwork(model)) {
    const project = projectOfFinding(model, f);
    const node = nodeOf.get(project);
    if (!configs.has(project)) configs.set(project, node ? runWithProjectRoot(node.directory, configOrNull) : null);
    if (!allows.has(project)) allows.set(project, node ? runWithProjectRoot(node.directory, lintAllows) : []);
    const local = f.specId !== undefined ? localKey(project, f.specId) : undefined;
    const tuned = finding(configs.get(project) ?? null, f.code, f.message, project, f.specId);
    if (!tuned) continue;
    const allowed = tuned.severity !== 'error' && local !== undefined && (allows.get(project) ?? []).some((a) =>
      a.specId === local && a.code === f.code && (a.at ?? undefined) === (f.at ?? undefined));
    if (allowed) continue;
    out.push({
      severity: tuned.severity,
      code: f.code,
      message: f.message,
      ...(f.specId !== undefined ? { specId: f.specId } : {}),
      ...(f.at !== undefined ? { at: f.at } : {}),
    });
  }
  return out;
}

// ---- topics across the family -----------------------------------------------

/**
 * Step 10 of run: pair topics across the family. A selected project's
 * UNCONSUMED_TOPIC (or UNSOURCED_SUBSCRIPTION) on a component is dropped when
 * every topic that component leaves unpaired inside its own project is
 * subscribed (or emitted) by another selected project — a topic a sibling
 * consumes goes somewhere. Read from the topic ends of the projects' own reach
 * models, never from a finding's message. The project's own gate, run alone,
 * still reports it.
 */
function pairTopicsAcrossFamily(issues: ValidationIssue[], models: Map<string, ReachModel>): ValidationIssue[] {
  const ends = [...models.entries()].flatMap(([project, m]) => (m.topics ?? []).map((t) => ({ ...t, project })));
  if (ends.length === 0) return [...issues];
  /** Whether a component's unpaired topics on one side are all paired by another project. */
  const pairedElsewhere = (project: string, component: string, emits: boolean): boolean => {
    const own = ends.filter((e) => e.project === project);
    const mine = own.filter((e) => e.component === component && e.emits === emits).map((e) => e.topic);
    const unpaired = mine.filter((t) => !own.some((o) => o.topic === t && o.emits !== emits));
    if (unpaired.length === 0) return false;
    return unpaired.every((t) => ends.some((o) => o.project !== project && o.topic === t && o.emits !== emits));
  };
  return issues.filter((i) => {
    if (i.code !== 'UNCONSUMED_TOPIC' && i.code !== 'UNSOURCED_SUBSCRIPTION') return true;
    if (i.project === undefined || i.specId === undefined) return true;
    return !pairedElsewhere(i.project, i.specId, i.code === 'UNCONSUMED_TOPIC');
  });
}
