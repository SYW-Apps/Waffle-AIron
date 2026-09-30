import * as path from 'path';
import { runWithProjectRoot } from '../utils/fs.js';
// cli_validator_adapter: the as-complete owner's gate and the gate identity.
import { validateAsComplete, computeGateStateId } from './validate.js';
import type { ValidationIssue, ValidationResult } from '../core/validation.js';
// cli_core_adapter: the project graph, the lock, the reach-gated walk up, the
// export tables and the types of the family's top.
import {
  loadProjectConfig,
  projectFamily,
  readLockState,
  resolveChainingParent,
  resolveProjectExports,
  loadTypeSpecs,
} from './adapters/core.js';
// position_reader: the positional match the migration writes from.
import { match, type PositionalMatch } from './position-reader.js';
import { keyIn, type AuthoredReference, type ProjectFamily, type ProjectNode } from '../models/index.js';

// ---------------------------------------------------------------------------
// verdict_changes — the stage-4 upgrade report behind
// `wairon doctor --report composed-validation`.
//
// It replaces a `--legacy` evaluator (none is kept) and says what stage 4
// changed in each project's verdict using only what exists now: each
// project's as-complete owner's gate today, the totals and validator version
// its last lock recorded, and — for a reference that no longer resolves — how
// the family's top matches it by position (position_reader), which is exactly
// how it passed before. The lock records totals and nothing per code, so the
// report never claims a per-code diff: it compares totals, and classes today's
// findings by a reason it can compute, counting what it cannot attribute. It
// writes nothing. The walk to the family's top is explicit — the report was
// asked for — and reach-gated: the caller must gate on reach itself.
// ---------------------------------------------------------------------------

/** upgrade_report_project — one project's totals: its last lock's and today's. */
export interface UpgradeReportProject {
  /** The project's key ('' for the bound root). */
  key: string;
  /** The validator version that took the project's lock; absent when never locked. */
  lockedBy?: string;
  /** The lock's validationResult totals, as recorded; absent when never locked. */
  lockedTotals?: string;
  /** Today's as-complete owner's gate totals, comparable with the lock's. */
  currentTotals: string;
  /** Whether the lock was taken by a validator older than stage 4: only then is a difference attributed to it. */
  predatesStage4: boolean;
}

/** upgrade_report_entry — one finding of today's owner's gate that stage 4 changed, with why. */
export interface UpgradeReportEntry {
  /** The key of the project whose gate reported it ('' for the bound root). */
  project: string;
  code: string;
  severity: string;
  specId?: string;
  /** escalated | pinned | positional */
  reason: 'escalated' | 'pinned' | 'positional';
  /** For a positional finding: what the family's top matched it to, `<producer id>::<id>`. */
  resolvedAs?: string;
  /** For a positional finding: what the positional migration writes. */
  rewrite?: string;
}

/** upgrade_report — what stage 4 changed in each project's verdict, from what can honestly be computed. */
export interface UpgradeReport {
  projects: UpgradeReportProject[];
  entries: UpgradeReportEntry[];
  /** Today's findings the report cannot attribute to stage 4 — counted, never explained away. */
  unclassified: number;
  /**
   * Every positional candidate the family top's match could not explain on its
   * own — ambiguous (with every candidate and why no tie-break rule chose) or
   * none — listed so a person can pick; each is also counted in unclassified.
   */
  unmatched: PositionalMatch[];
}

/**
 * The first validator version that judges with the owner's gate. A lock taken
 * by an older one recorded a pre-stage-4 verdict; only then is a difference in
 * totals attributed to the upgrade. Every build of this branch before the
 * stage-4 merge is 5.1.1-dev.83 or older.
 */
const STAGE4_FIRST_VERSION = '5.1.1-dev.84';

/** Codes stage 4 escalated from notices to errors. */
const ESCALATED = new Set([
  'EXTERNAL_NOT_EXPORTED', 'EXPORT_INVALID', 'EXPORT_UNCONSUMABLE', 'TRUSTED_LINK_CROSSES_PROJECT', 'EXTERNAL_UNDECLARED',
]);

/** Codes a reference the owner's scope no longer resolves reports. */
const UNRESOLVED = new Set(['UNDEFINED_TYPE_REFERENCE', 'INVALID_DEPENDENCY_REFERENCE', 'INVALID_TARGET_COMPONENT_REFERENCE']);

/** A version as comparable numbers: major, minor, patch, then the dev build (a release sorts after its dev builds). */
function versionKey(version: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?/.exec(version.trim());
  if (!m) return [0, 0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[4])];
}

/** Whether a lock taken by `version` predates stage 4. */
function predatesStage4(version: string): boolean {
  const [a, b] = [versionKey(version), versionKey(STAGE4_FIRST_VERSION)];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function totals(errors: number, warnings: number, notices: number | undefined): string {
  return `${errors} error(s), ${warnings} warning(s), ${notices === undefined ? 'no notice count' : `${notices} notice(s)`}`;
}

/** A directory as a comparable key. */
function dirKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** One covered project's gate today, with its line in the report. */
interface Covered {
  node: ProjectNode;
  /** The ids of the members it contains: a reference into one is judged against its live table, not a pin. */
  memberIds: Set<string>;
  gate: ValidationResult;
  line: UpgradeReportProject;
}

/** Steps 3-8: one project's gate as-complete, its identity now and its lock's record. */
function coverProject(node: ProjectNode, family: ProjectFamily): Covered {
  return runWithProjectRoot(node.directory, () => {
    // Step 4: its own configuration judges it, as its own lock gate does.
    let config = null;
    try { config = loadProjectConfig(); } catch { /* judged with the defaults */ }
    // Step 5: as-complete, the strictness the lock's totals were taken at.
    const gate = validateAsComplete({ rules: config?.rules, projectType: config?.projectType });
    // Step 6: its gate identity now.
    const current = computeGateStateId();
    // Step 7: all the lock holds about a past verdict.
    const record = readLockState(current).record;
    // Step 8: its line.
    const count = (s: string): number => gate.issues.filter((i) => i.severity === s).length;
    const line: UpgradeReportProject = {
      key: node.namespace,
      ...(record ? { lockedBy: record.validatorVersion } : {}),
      // A format-2 record counts the design half and the code half apart; the
      // run below counts both, so the locked totals add them back together.
      ...(record ? { lockedTotals: totals(
        record.validationResult.errors + (record.code?.errors ?? 0),
        record.validationResult.warnings + (record.code?.warnings ?? 0),
        record.validationResult.notices === undefined ? undefined : record.validationResult.notices + (record.code?.notices ?? 0),
      ) } : {}),
      currentTotals: totals(count('error'), count('warning'), count('notice')),
      predatesStage4: record ? predatesStage4(record.validatorVersion) : false,
    };
    const memberIds = new Set(family.nodes.filter((n) => n.parent === node.namespace && n.id !== undefined).map((n) => n.id!));
    return { node, memberIds, gate, line };
  });
}

/** A self-prefixed reference the scan recorded: its own id as the first segment, bound locally. */
function isSelfPrefix(ref: AuthoredReference, owner: string | undefined): boolean {
  return ref.binding === 'local' && ref.form === 'path' && ref.producer === owner
    && ref.rewrite !== undefined && !ref.rewrite.includes('::') && ref.authored !== ref.rewrite;
}

/** Step 9: whether a finding is a positional candidate. */
function positionalCandidate(issue: ValidationIssue): boolean {
  return UNRESOLVED.has(issue.code)
    || (issue.code === 'DEPRECATED_REFERENCE_FORM' && issue.message.includes('own id used as a prefix'));
}

/** Step 9: the reason a finding is new in stage 4 that needs no match, or null. */
function directReason(issue: ValidationIssue, covered: Covered): 'escalated' | 'pinned' | null {
  if (ESCALATED.has(issue.code)) return 'escalated';
  const target = issue.resolution?.canonicalTarget;
  if (issue.resolution && issue.resolution.outcome !== 'forbidden' && target?.includes('::')) {
    // Into a project it does not contain: judged against its own pin.
    if (!covered.memberIds.has(target.split('::')[0])) return 'pinned';
  }
  return null;
}

/** Steps 11-16: walk up to the family's top, one reach-gated hop at a time, and match there. */
function matchAtTop(root: string): { top: ProjectFamily; matches: PositionalMatch[] } {
  let top = root;
  // Steps 11-12: explicit, and reach-gated — a request that may not read above its root stops here.
  for (;;) {
    const parent = runWithProjectRoot(top, () => resolveChainingParent());
    if (!parent) break;
    top = path.resolve(parent.parentRoot);
  }
  return runWithProjectRoot(top, () => {
    // Step 13: the family's graph with the top bound.
    const family = projectFamily();
    // Step 14: every project's resolved L0 export table.
    const tables = [resolveProjectExports(), ...family.nodes.filter((n) => n.namespace !== '').map((n) => resolveProjectExports(n.namespace))];
    // Step 15: every type of the family as the top's scan sees them.
    const types = loadTypeSpecs();
    const unresolved = family.authoredReferences.filter((r) =>
      (r.form === 'import' && r.binding === 'unresolved') || isSelfPrefix(r, family.owners.get(r.specId)));
    // Step 16: the positional match.
    return { top: family, matches: match(unresolved, family, tables, types) };
  });
}

/** Step 17: what the migration writes for an import match — the `use` line, and the export and external when missing. */
function importRewrite(top: ProjectFamily, m: PositionalMatch): string {
  const consumer = top.nodes.find((n) => n.namespace === m.consumer);
  const producer = top.nodes.find((n) => n.namespace === m.producer);
  const producerId = producer?.id ?? m.producer ?? '';
  const name = m.publicName ?? m.target?.split('::').pop() ?? m.authored;
  const alias = consumer ? [...consumer.aliases].find(([, key]) => key === m.producer)?.[0] : undefined;
  const section = consumer?.members.includes(m.producer ?? '') ? 'members' : 'externals';
  const parts = [`${section}.${alias ?? producerId}.use: [${name}]`];
  if (!m.publicName) parts.push(`export \`${name}\` from ${producerId}'s L0`);
  if (!alias) parts.push(`declare the external \`${producerId}\``);
  return parts.join('; ');
}

/** Step 17: the match that explains a positional candidate, or null when the top's match holds none for it. */
function matchOf(issue: ValidationIssue, covered: Covered, top: ProjectFamily, matches: PositionalMatch[]): PositionalMatch | null {
  const topNode = top.nodes.find((n) => dirKey(n.directory) === dirKey(covered.node.directory));
  if (!topNode || !issue.specId) return null;
  const specKey = keyIn(topNode.namespace, issue.specId);
  return matches.find((x) => x.consumer === topNode.namespace && x.specId === specKey && issue.message.includes(`"${x.authored}"`)) ?? null;
}

/** Step 17: a positional finding's entry, for an import or self-prefix match. */
function positionalEntry(issue: ValidationIssue, covered: Covered, top: ProjectFamily, m: PositionalMatch): UpgradeReportEntry {
  const topNode = top.nodes.find((n) => dirKey(n.directory) === dirKey(covered.node.directory))!;
  const base = { project: covered.node.namespace, code: issue.code, severity: issue.severity, specId: issue.specId, reason: 'positional' as const };
  if (m.kind === 'self-prefix') {
    return { ...base, resolvedAs: `${topNode.id ?? topNode.namespace}::${m.target}`, rewrite: `${m.authored} -> ${m.target}` };
  }
  return { ...base, ...(m.target ? { resolvedAs: m.target } : {}), rewrite: importRewrite(top, m) };
}

/**
 * iverdict_changes.explain — for the bound project and each member it
 * contains: its as-complete owner's gate today beside its lock's totals and
 * validator version, and every finding whose reason is new in stage 4
 * (escalated, pinned, positional), with the unattributable ones counted.
 * Writes nothing.
 */
export function explain(): UpgradeReport {
  // Step 1: the bound project and the members it contains.
  const family = projectFamily();
  const covered: Covered[] = [];
  const entries: UpgradeReportEntry[] = [];
  const unmatched: PositionalMatch[] = [];
  const candidates: { issue: ValidationIssue; covered: Covered }[] = [];
  let unclassified = 0;
  // Step 2: each covered project, root first.
  for (const node of family.nodes) {
    // Steps 3-8: its gate today, and its line.
    const c = coverProject(node, family);
    covered.push(c);
    // Step 9: classify its findings.
    for (const issue of c.gate.issues) {
      const reason = directReason(issue, c);
      if (reason) entries.push({ project: c.node.namespace, code: issue.code, severity: issue.severity, ...(issue.specId ? { specId: issue.specId } : {}), reason });
      else if (positionalCandidate(issue)) candidates.push({ issue, covered: c });
      else unclassified++;
    }
  }
  // Step 10: positional candidates to explain?
  if (candidates.length > 0) {
    // Steps 11-16: matched at the family's top.
    const root = family.nodes.find((n) => n.namespace === '')?.directory ?? '';
    const { top, matches } = matchAtTop(root);
    // Step 17: each candidate's entry; an ambiguous or unmatched one is
    // unclassified, and listed with its candidates for a person to pick.
    for (const { issue, covered: c } of candidates) {
      const m = matchOf(issue, c, top, matches);
      if (m && (m.kind === 'import' || m.kind === 'self-prefix')) {
        entries.push(positionalEntry(issue, c, top, m));
        continue;
      }
      unclassified++;
      if (m && !unmatched.includes(m)) unmatched.push(m);
    }
  }
  // Step 18: the report.
  return { projects: covered.map((c) => c.line), entries, unclassified, unmatched };
}
