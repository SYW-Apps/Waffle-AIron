import type { ComplexityRuleConfig, DocumentationRuleConfig, NamingRuleConfig, PackEntry } from './project.js';
import type { ExtensionPack } from '../core/extensions.js';
import type { ProjectVerdict, ValidationIssue, ValidationResult } from '../core/validation.js';

// ---------------------------------------------------------------------------
// Pack impact — the value objects of the governance stage's pre-write report,
// and the three pure methods of the types that produce them:
// extension_pack.settings (packSettings), extension_pack.changesAgainst
// (doctrineChanges) and validation_result.changesTo (findingChanges).
//
// Nothing here judges. A pack that loosens wairon's checks is reported as
// changing them, exactly like one that raises them: packs exist to adjust the
// checks, and loosening is legitimate (pack-loosening-is-never-a-finding).
// ---------------------------------------------------------------------------

/** A rule severity as a configuration states it. */
export type SettingSeverity = 'error' | 'warning' | 'notice' | 'off';

/**
 * pack_candidate — a pack write that has not happened yet: the entry it would
 * write (or remove), the manifest when it is not on disk yet, whether it
 * removes, and the projectType the same write also sets.
 */
export interface PackCandidate {
  entry?: PackEntry;
  manifest?: ExtensionPack;
  remove?: boolean;
  projectType?: string;
}

/**
 * pack_settings — what one pack sets for a project governed by one of its
 * profiles (or by none): what a member that adopted it can deviate from.
 */
export interface PackSettings {
  pack: string;
  /** The profile the settings are read under; absent when none of the pack's profiles governs. */
  profile?: string;
  /** Rule code → the severity the pack gives it. */
  severities: Record<string, SettingSeverity>;
  /** The profile's rules.designDepth, when it sets one. */
  designDepth?: string;
  /** The profile's rules.naming, when it sets any. */
  naming?: NamingRuleConfig;
  /** The profile's rules.complexity, when it sets any. */
  complexity?: ComplexityRuleConfig;
  /** The profile's rules.documentation, when it sets any. */
  documentation?: DocumentationRuleConfig;
}

/** doctrine_baseline — wairon's defaults: what a project governs under with NO pack loaded. */
export interface DoctrineBaseline {
  /** Every builtin rule code → its default severity. */
  ruleDefaults: Record<string, string>;
  profiles: string[];
  projectKinds: string[];
  stereotypes: string[];
  guarantees: string[];
  designDepth: string;
}

/** What a doctrine change is about: a rule's codes, or a concept the vocabulary holds. */
export type DoctrineAxis = 'rule' | 'concept';

/** How a pack changes doctrine against wairon's defaults. */
export type DoctrineChangeKind = 'loosened' | 'raised' | 'off' | 'added' | 'depth' | 'inert' | 'redefined' | 'removed' | 'discouraged' | 'licensed' | 'gated';

/** doctrine_change — one thing a pack changes against wairon's defaults, stated neutrally. */
export interface DoctrineChange {
  axis: DoctrineAxis;
  change: DoctrineChangeKind;
  subject: string;
  profile?: string;
  from?: string;
  to?: string;
  reason?: string;
}

/** regraded_finding — one finding both runs report, at a different severity in each. */
export interface RegradedFinding {
  finding: ValidationIssue;
  from: ValidationIssue['severity'];
}

/** finding_changes — how one project's findings differ between two runs. */
export interface FindingChanges {
  introduced: ValidationIssue[];
  resolved: ValidationIssue[];
  regraded: RegradedFinding[];
}

/** Whether a pack write adds (or replaces) a pack, or drops it. */
export type PackImpactDirection = 'apply' | 'remove';

/** pack_impact — what one pack write would change, measured before it happens. */
export interface PackImpact {
  pack: string;
  version?: string;
  replaces?: string;
  direction: PackImpactDirection;
  doctrine: DoctrineChange[];
  previousDoctrine?: DoctrineChange[];
  governing: string[];
  findings: FindingChanges;
  before: ProjectVerdict;
  after: ProjectVerdict;
}

/** pack_doctrine — the doctrine half of a pack impact alone. */
export interface PackDoctrine {
  pack: string;
  version?: string;
  changes: DoctrineChange[];
}

// ---- extension_pack.settings -----------------------------------------------

/**
 * extension_pack.settings — the settings a pack sets for a project governed by
 * `profile` (null, or a profile the pack does not define: none governs): each
 * programmatic rule code at its default severity, then each assertion's
 * namespaced code at its declared severity, then the profile's
 * rules.sddRuleSeverity, which wins on a code both name; plus the profile's
 * designDepth, naming, complexity and documentation.
 */
export function packSettings(manifest: ExtensionPack, profile: string | null): PackSettings {
  const severities: Record<string, SettingSeverity> = {};
  for (const rule of manifest.rules) {
    for (const code of rule.codes) severities[code.code] = code.defaultSeverity;
  }
  for (const assertion of manifest.assertions) severities[assertionCode(manifest.name, assertion.code)] = assertion.severity;
  const def = profile !== null ? manifest.profiles[profile] : undefined;
  if (!def) return { pack: manifest.name, severities };
  Object.assign(severities, def.rules?.sddRuleSeverity ?? {});
  const rules = def.rules;
  return {
    pack: manifest.name,
    profile: profile!,
    severities,
    ...(rules?.designDepth ? { designDepth: rules.designDepth } : {}),
    ...(rules?.naming ? { naming: rules.naming } : {}),
    ...(rules?.complexity ? { complexity: rules.complexity } : {}),
    ...(rules?.documentation ? { documentation: rules.documentation } : {}),
  };
}

/** <PACK>_<CODE> — the namespaced code a pack assertion reports under (the loader's own normalization). */
function assertionCode(packName: string, code: string): string {
  const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${norm(packName)}_${norm(code)}`;
}

// ---- extension_pack.changesAgainst -----------------------------------------

const RANK: Record<string, number> = { notice: 1, warning: 2, error: 3 };

/** One profile severity against the baseline default: a change, or null when it is none. */
function severityChange(code: string, to: string, profile: string, baseline: DoctrineBaseline, packCodes: Set<string>): DoctrineChange | null {
  const from = baseline.ruleDefaults[code];
  if (from === undefined) {
    // A code wairon does not have: the pack's own (added), or one no loaded rule reports (inert).
    return { axis: 'rule', change: packCodes.has(code) ? 'added' : 'inert', subject: code, profile, to };
  }
  if (from === to) return null;
  if (to === 'off') return { axis: 'rule', change: 'off', subject: code, profile, from, to };
  return { axis: 'rule', change: (RANK[to] ?? 0) < (RANK[from] ?? 0) ? 'loosened' : 'raised', subject: code, profile, from, to };
}

/** Everything one profile changes: the profile itself, its severities, depth, fencing and edge licences. */
function profileChanges(id: string, manifest: ExtensionPack, baseline: DoctrineBaseline, packCodes: Set<string>): DoctrineChange[] {
  const def = manifest.profiles[id];
  const out: DoctrineChange[] = [{ axis: 'concept', change: baseline.profiles.includes(id) ? 'redefined' : 'added', subject: id, profile: id }];
  for (const [code, to] of Object.entries(def.rules?.sddRuleSeverity ?? {})) {
    const change = severityChange(code, to, id, baseline, packCodes);
    if (change) out.push(change);
  }
  const depth = def.rules?.designDepth;
  if (depth && depth !== baseline.designDepth) out.push({ axis: 'rule', change: 'depth', subject: 'designDepth', profile: id, from: baseline.designDepth, to: depth });
  for (const f of def.forbiddenStereotypes) for (const t of f.types) out.push({ axis: 'concept', change: 'removed', subject: t, profile: id, reason: f.reason });
  for (const d of def.discouragedStereotypes) for (const t of d.types) out.push({ axis: 'concept', change: 'discouraged', subject: t, profile: id, reason: d.reason });
  for (const e of def.allowedEdges) {
    for (const from of e.from) for (const to of e.to) out.push({ axis: 'concept', change: 'licensed', subject: `${from} → ${to}`, profile: id, reason: e.reason });
  }
  return out;
}

/** The pack-wide changes: added codes, patterns, guarantee tokens and language tables, and each gated flow construct. */
function packWideChanges(manifest: ExtensionPack, baseline: DoctrineBaseline): DoctrineChange[] {
  const out: DoctrineChange[] = [];
  for (const a of manifest.assertions) {
    out.push({ axis: 'rule', change: 'added', subject: assertionCode(manifest.name, a.code), to: a.severity, reason: a.reason });
  }
  for (const rule of manifest.rules) {
    for (const code of rule.codes) out.push({ axis: 'rule', change: 'added', subject: code.code, to: code.defaultSeverity });
  }
  for (const p of manifest.patterns) out.push({ axis: 'concept', change: 'added', subject: `pattern ${p.id}@${p.version}` });
  for (const g of manifest.guarantees) {
    if (!baseline.guarantees.includes(g)) out.push({ axis: 'concept', change: 'added', subject: `guarantee ${g}` });
  }
  for (const [lang, def] of Object.entries(manifest.languages)) {
    out.push({ axis: 'concept', change: 'added', subject: `language ${lang}` });
    for (const [construct, guidance] of Object.entries(def.unsupportedFlow)) {
      out.push({ axis: 'concept', change: 'gated', subject: `${lang}: ${construct}`, reason: guidance });
    }
  }
  return out;
}

/**
 * extension_pack.changesAgainst — everything a pack changes against wairon's
 * defaults, as neutral changes: per profile, the profile itself (added, or
 * redefined when its id is a builtin), each severity against the default
 * (loosened, raised or off; added for a code of the pack's own; inert for one
 * no loaded rule reports), a designDepth other than the default, each
 * forbidden (removed) and discouraged stereotype and each licensed edge; then
 * pack-wide each added code, pattern, guarantee token and language table and
 * each gated flow construct. An entry equal to the default is no change. Pure:
 * the baseline is handed in.
 */
export function doctrineChanges(manifest: ExtensionPack, baseline: DoctrineBaseline): DoctrineChange[] {
  const packCodes = new Set([
    ...manifest.assertions.map((a) => assertionCode(manifest.name, a.code)),
    ...manifest.rules.flatMap((r) => r.codes.map((c) => c.code)),
  ]);
  const perProfile = Object.keys(manifest.profiles).flatMap((id) => profileChanges(id, manifest, baseline, packCodes));
  return [...perProfile, ...packWideChanges(manifest, baseline)];
}

// ---- validation_result.changesTo -------------------------------------------

/** A finding's identity across two runs: code, project, spec and message with the severity word removed. */
function identity(issue: ValidationIssue): string {
  const message = issue.message.replace(/\b(error|warning|notice)s?\b/gi, '').replace(/\s+/g, ' ').trim();
  return [issue.code, issue.project ?? '', issue.specId ?? '', message].join('\u0000');
}

/**
 * validation_result.changesTo — how `after` differs from `before`, finding by
 * finding: introduced (only in after), resolved (only in before) and regraded
 * (in both, at another severity). Findings are matched by identity, never by
 * position, and as a multiset, so a finding reported twice is matched twice.
 */
export function findingChanges(before: ValidationResult, after: ValidationResult): FindingChanges {
  const pending = new Map<string, ValidationIssue[]>();
  for (const issue of before.issues) {
    const key = identity(issue);
    pending.set(key, [...(pending.get(key) ?? []), issue]);
  }
  const introduced: ValidationIssue[] = [];
  const regraded: RegradedFinding[] = [];
  for (const issue of after.issues) {
    const matches = pending.get(identity(issue));
    const earlier = matches?.shift();
    if (!earlier) introduced.push(issue);
    else if (earlier.severity !== issue.severity) regraded.push({ finding: issue, from: earlier.severity });
  }
  const resolved = [...pending.values()].flat();
  return { introduced, resolved, regraded };
}

// ---- pack_impact.headline --------------------------------------------------

/**
 * pack_impact.headline — the impact in one line: the pack (and version), its
 * doctrine changes counted by kind, the introduced / resolved / regraded
 * finding counts and both totals. Stated, never judged. What an unattended
 * hosted policy write puts in its messages and on an approval's
 * executionSummary.
 */
export function impactHeadline(impact: PackImpact): string {
  const kinds = new Map<string, number>();
  for (const c of impact.doctrine) kinds.set(c.change, (kinds.get(c.change) ?? 0) + 1);
  const doctrine = impact.doctrine.length === 0
    ? 'no doctrine changes'
    : `${impact.doctrine.length} doctrine change(s) (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')})`;
  const f = impact.findings;
  const totals = (v: ProjectVerdict): string => `${v.errors} error(s), ${v.warnings} warning(s), ${v.notices} notice(s)`;
  return `${impact.pack}${impact.version ? ` v${impact.version}` : ''}: ${doctrine}; findings ${f.introduced.length} introduced, ` +
    `${f.resolved.length} resolved, ${f.regraded.length} regraded; ${totals(impact.before)} before, ${totals(impact.after)} after`;
}
