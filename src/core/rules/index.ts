import {
  SystemSpec,
  SubsystemSpec,
  ComponentSpec,
  InterfaceSpec,
  ImplementationSpec,
  TypeSpec,
  RulesConfig,
  MethodSignature,
  ComplexityRuleConfig,
  DocumentationRuleConfig,
  NamingRuleConfig,
  SurfaceContractEntry,
  SurfaceSnapshot,
  SurfaceRefResolution,
  CodeModel,
  isTypeVocabulary,
  isProvidedBy,
  sameContract,
  typeMatchesRef,
  isOwnComponentEntry,
  nameKey,
  type AuthoredReference,
  type PinnedExternal,
  type ReferenceResolution,
} from '../../models/index.js';
import type { ResolvedExportTable } from '../../models/exports.js';
import { createHash } from 'crypto';
import { canonicalize } from '../../utils/canonical-json.js';
import type { ValidationIssue } from '../validation.js';
import { emptyExtensions, LoadedExtensions } from '../extensions.js';
import type { VariantDef } from '../variants.js';
import type { DeclaredMember, PackRequirement, PackSelection, ProjectIdentity } from '../../models/project.js';
import type { CarriedFindingEntry, FindingParts } from './types.js';
import {
  ArchProfile,
  BUILTIN_PROFILES,
  RuleContext,
  SddRule,
  Severity,
  type IssueSeverity,
  type CodeIndex,
  type DependencyEdges,
  type ImportGraph,
  type OwnershipIndex,
  type RealizationIndex,
  type ResolvedMethod,
  type SpecId,
} from './types.js';
import { buildCodeIndex, buildDependencyEdges, buildImplementationMethods, buildImportGraph, buildOwnershipIndex, buildRealizationIndex, buildSpecIds } from './read-model.js';
import { SDD_RULES } from './repository.js';
import { lintAllowsRule } from './integrity/lint-allows.js';
import { emptyCodeModel } from '../source-analysis.js';

export * from './types.js';

// The built-in rule set lives with the rule repository that registers it; it
// stays published on this barrel so the public surface is unchanged.
export { SDD_RULES };

/**
 * The full rule sequence for a validation run: built-ins, then extension-pack
 * rules, with the lint-allows audit LAST so it also sees every allow the pack
 * rules consumed (otherwise a suppressed pack warning reads as a stale allow).
 */
export function composeRuleSequence(extraRules: SddRule[] = []): SddRule[] {
  const base = SDD_RULES.filter(r => r !== lintAllowsRule);
  return [...base, ...extraRules, lintAllowsRule];
}

// ---------------------------------------------------------------------------
// Design depth — which layers a project/subsystem COMMITS to designing.
// EXPECTATION codes (something deeper must exist / be complete) are gated by
// the effective depth; SOUNDNESS codes (what is authored must be coherent)
// are deliberately absent from this map and always apply. The gate runs
// BEFORE severity overrides: a gated code is skipped, period — raising the
// depth is the way to get it back.
// ---------------------------------------------------------------------------

type DesignDepth = import('../../models/index.js').DesignDepth;

const DEPTH_RANK: Record<DesignDepth, number> = {
  components: 2,
  interfaces: 3,
  implementations: 4,
  narratives: 5,
};

/** Expectation code → the minimum design depth at which it applies. */
const DEPTH_GATED_CODES: Record<string, DesignDepth> = {
  // L3 expectations: contract content the design promises at interface depth.
  MISSING_ENDPOINT: 'interfaces',
  MISSING_EFFECT_TAG: 'interfaces',
  UNUSED_TYPE: 'interfaces',
  // L4 expectations: implementations and their code linkage.
  MISSING_IMPLEMENTATION_METHOD: 'implementations',
  MISSING_SOURCE_PATH: 'implementations',
  METHOD_SOURCE_PATH_MISSING: 'implementations',
  SOURCE_FILE_PLANNED: 'implementations',
  PORTAL_AUTH_UNMET: 'implementations',
  MISSING_SOURCE_FILE: 'implementations',
  SOURCE_PATH_ESCAPES_ROOT: 'implementations',
  UNREALIZED_METHOD: 'implementations',
  UNREALIZED_FINDING: 'implementations',
  CONFORMANCE_ANALYSIS_SKIPPED: 'implementations',
  CONFORMANCE_DEGRADED: 'implementations',
  UNDECLARED_DEPENDENCY: 'implementations',
  UNREALIZED_DEPENDENCY: 'implementations',
  IMPORT_BYPASSES_PORTAL: 'implementations',
  MISSING_INTEGRATION_SIM: 'implementations',
  // L5 expectations: narratives and everything whose fuel is narrative edges
  // (the reachability walk and the hydration round-trip would drown a
  // narrative-less tree in findings about flows nobody designed).
  MISSING_NARRATIVE: 'narratives',
  INTENT_FLOOR: 'narratives',
  UNNARRATED_COMPLEXITY: 'narratives',
  DETAIL_BELOW_STEREOTYPE: 'narratives',
  UNASSERTED_INVARIANT: 'narratives',
  MISSING_HYDRATION: 'narratives',
  UNUSED_COMPONENT: 'narratives',
  UNUSED_METHOD: 'narratives',
};

/** min(severity, warning) on the rank off < notice < warning < error. */
function atMostWarning(severity: IssueSeverity): IssueSeverity {
  return severity === 'error' ? 'warning' : severity;
}

// Completeness rules downgrade to warnings while the surrounding specs are
// still draft/design — the tree is allowed to be unfinished, not inconsistent.
// The downgrade is min(default, warning), so a notice is never raised by it.
const COMPLETENESS_RULES = new Set([
  'MISSING_IMPLEMENTATION_METHOD',
  'MISSING_NARRATIVE',
  'INTENT_FLOOR',
  'MISSING_ENDPOINT',
  'ENDPOINT_TRANSPORT_MISMATCH',
  'MISSING_PORTAL_TRANSPORT',
  'UNEXPECTED_IMPLEMENTATION_METHOD',
  'ORPHANED_SUBSYSTEM',
  'PUBLIC_INTERFACE_UNBOUND',
  // Structural conformance: a draft tree is allowed to name code that does
  // not exist yet — the findings gate only once the specs claim completeness.
  'MISSING_SOURCE_PATH',
  'METHOD_SOURCE_PATH_MISSING',
  'MISSING_SOURCE_FILE',
  'SOURCE_FILE_PLANNED',
  'SOURCE_PATH_ESCAPES_ROOT',
  'UNREALIZED_METHOD',
  'UNREALIZED_FINDING',
  'CONFORMANCE_ANALYSIS_SKIPPED',
  'UNDECLARED_DEPENDENCY',
  'UNREALIZED_DEPENDENCY',
  'IMPORT_BYPASSES_PORTAL',
  // Detail sufficiency reads the realized code like the conformance family
  // does — a draft tree is allowed to disagree with its code.
  'UNNARRATED_COMPLEXITY',
  // Invariant assertions are narrative completeness — a draft tree may not
  // have written its write-path narratives yet.
  'UNASSERTED_INVARIANT',
  // Call-step realization reads the realized code — a draft tree is allowed
  // to disagree with its code.
  'CALL_STEP_UNREALIZED',
  // Integration-sim gate: a draft tree may not have written its harness yet.
  'MISSING_INTEGRATION_SIM',
  'SIM_FILE_MISSING',
  'UNWIRED_INTEGRATION_SIM',
]);

export interface ScopeFilterOptions {
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];
  scopeSubsystem?: string;
}

/**
 * Scope filter for granular (per-subsystem) validation — shared by the rule
 * context and the loader-issue filtering that runs before rules.
 */
export function makeScopeFilter(opts: ScopeFilterOptions): (specId: string) => boolean {
  const { components, interfaces, implementations, types, scopeSubsystem } = opts;
  return (specId: string): boolean => {
    if (!scopeSubsystem) return true;
    if (specId === scopeSubsystem) return true;

    const comp = components.find(c => c.id === specId);
    if (comp) return comp.subsystem === scopeSubsystem || comp.subsystem.startsWith(`${scopeSubsystem}::`);

    const intf = interfaces.find(i => i.id === specId);
    if (intf) {
      const parentComp = components.find(c => c.id === intf.component);
      return parentComp ? (parentComp.subsystem === scopeSubsystem || parentComp.subsystem.startsWith(`${scopeSubsystem}::`)) : false;
    }

    const impl = implementations.find(i => i.id === specId);
    if (impl) {
      const contractIntf = interfaces.find(i => i.id === impl.contract);
      if (contractIntf) {
        const parentComp = components.find(c => c.id === contractIntf.component);
        return parentComp ? (parentComp.subsystem === scopeSubsystem || parentComp.subsystem.startsWith(`${scopeSubsystem}::`)) : false;
      }
      return false;
    }

    const t = types.find(type => type.id === specId);
    if (t) return t.subsystem === scopeSubsystem || (t.subsystem ? t.subsystem.startsWith(`${scopeSubsystem}::`) : specId.startsWith(`${scopeSubsystem}::`));

    if (specId.startsWith(`${scopeSubsystem}::`)) return true;

    return false;
  };
}

/**
 * Normalize a user-supplied language name onto the language-table key (ts →
 * typescript, js or node → javascript, rs → rust, py → python, c# or dotnet →
 * csharp, golang → go, else lowercased) — the form targetLanguageFor answers in.
 */
function normalizeLanguage(lang: string): string {
  const l = lang.toLowerCase().trim();
  if (l === 'ts' || l === 'typescript') return 'typescript';
  if (l === 'js' || l === 'javascript' || l === 'node' || l === 'nodejs') return 'javascript';
  if (l === 'rs' || l === 'rust') return 'rust';
  if (l === 'py' || l === 'python') return 'python';
  if (l === 'c#' || l === 'cs' || l === 'csharp' || l === 'dotnet') return 'csharp';
  if (l === 'golang' || l === 'go') return 'go';
  return l;
}

export interface BuildContextOptions {
  system: SystemSpec;
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];
  rules?: RulesConfig;
  projectType: string;
  scopeSubsystem?: string;
  /** Loaded extension packs (pack profiles/languages/rules); empty when absent. */
  extensions?: LoadedExtensions;
  /** Loaded component-variant registry (dynamic layer on top of packs); empty when absent. */
  variants?: VariantDef[];
  /** The project's by-name pack selections (legacy path refs excluded); empty when absent. */
  packSelections?: PackSelection[];
  /** The bound project's own composition.requirePolicies; empty when absent. */
  packRequirements?: PackRequirement[];
  /** Stored surface snapshots for cross-tree/remote reference resolution. */
  surfaceSnapshots?: SurfaceSnapshot[];
  /** The validated root's identity against its lock (see RuleContext.projectIdentity); absent when none was resolved. */
  projectIdentity?: ProjectIdentity;
  /** The bound root's declared members (see RuleContext.declaredMembers); absent when its configuration is unreadable. */
  declaredMembers?: DeclaredMember[];
  /** The bound project's own network declaration (see RuleContext.network); absent when it declares none. */
  network?: import('../../models/project.js').NetworkDeclaration;
  /** The retired reachability forms the scan met (see RuleContext.retiredReachFacts). */
  retiredReachFacts?: import('../../models/specs.js').RetiredReachFact[];
  /** The resolved export tables (see RuleContext.exportTables); absent when none were gathered. */
  exportTables?: import('../../models/exports.js').ResolvedExportTable[];
  /** The project graph of the run's scan (see RuleContext.projectFamily); absent on a candidate run. */
  projectFamily?: import('../../models/project-family.js').ProjectFamily;
  /** The export usage of every connected project pair (see RuleContext.exportUsages); absent on a candidate run. */
  exportUsages?: import('../../models/exports.js').ExportUsage[];
  /** What the loader's signature resolution recorded (see RuleContext.signatureFacts); absent on a candidate run. */
  signatureFacts?: import('../signature-sources.js').SignatureFacts;
  /** What the loader's type canonicalisation recorded (see RuleContext.typeSpellingFacts); absent on a candidate run. */
  typeSpellingFacts?: import('../../models/type-grammar.js').TypeSpellingFacts;
  /** The bound project's declared externals with their lock entries and pinned snapshots (see RuleContext.pinnedExternals). */
  pinnedExternals?: PinnedExternal[];
  /** Source-code model for structural conformance; empty when not built. */
  codeModel?: CodeModel;
  /** The writer's round-trip dry-run findings for the in-scope specs, gathered by the caller (see RuleContext.roundTripIssues). */
  roundTripIssues: ValidationIssue[];
  /** Every code the registered rules and loaded declarative assertions can report, gathered by the caller (see RuleContext.knownIssueCodes). */
  knownIssueCodes: Set<string>;
  /** Each known code's default severity, gathered by the caller beside knownIssueCodes (see RuleContext.severityOf); a loaded assertion's own severity is added here. */
  issueCodeSeverities?: Map<string, Severity>;
  /** Every code a registered rule declares CARRYABLE, gathered by the caller (see RuleContext.carryableIssueCodes). */
  carryableIssueCodes?: Set<string>;
  /** Collector the context's addIssue pushes into. */
  issues: ValidationIssue[];
}

export function buildRuleContext(opts: BuildContextOptions): RuleContext {
  const { system, subsystems, components, interfaces, implementations, types, rules, projectType, scopeSubsystem, issues } = opts;
  const extensions = opts.extensions ?? emptyExtensions();

  const componentMap = new Map(components.map(c => [c.id, c]));
  const interfaceMap = new Map(interfaces.map(i => [i.id, i]));
  const subsystemIds = new Set(subsystems.map(s => s.id));
  const componentIds = new Set(components.map(c => c.id));
  const interfaceIds = new Set(interfaces.map(i => i.id));

  const interfacesByComponent = new Map<string, InterfaceSpec[]>();
  for (const intf of interfaces) {
    const list = interfacesByComponent.get(intf.component);
    if (list) list.push(intf);
    else interfacesByComponent.set(intf.component, [intf]);
  }
  const implementationsByContract = new Map<string, ImplementationSpec[]>();
  for (const impl of implementations) {
    const list = implementationsByContract.get(impl.contract);
    if (list) list.push(impl);
    else implementationsByContract.set(impl.contract, [impl]);
  }

  // A subsystem's published public surface: the component ids its OWN
  // publicInterfaces entries bind. Cross-subsystem dependencies may only
  // target these — a re-export is a name, not a licence to depend on the
  // target, which is still reached through its owning subsystem.
  const publicSet = new Map<string, Set<string>>();
  for (const sub of subsystems) {
    publicSet.set(
      sub.id,
      new Set(sub.publicInterfaces.filter(isOwnComponentEntry).map(pi => pi.component).filter((c): c is string => !!c)),
    );
  }

  const surfaceSnapshots = opts.surfaceSnapshots ?? [];

  const isSpecInScope = makeScopeFilter({ components, interfaces, implementations, types, scopeSubsystem });

  // ---- design depth resolution --------------------------------------------
  // specId → owning subsystem, so a finding can be judged under the depth of
  // the subsystem it belongs to (project default otherwise).
  const subsystemOfSpec = new Map<string, string>();
  for (const s of subsystems) subsystemOfSpec.set(s.id, s.id);
  for (const c of components) subsystemOfSpec.set(c.id, c.subsystem);
  for (const i of interfaces) {
    const comp = componentMap.get(i.component);
    if (comp) subsystemOfSpec.set(i.id, comp.subsystem);
  }
  for (const im of implementations) {
    const contract = interfaceMap.get(im.contract);
    const comp = contract ? componentMap.get(contract.component) : undefined;
    if (comp) subsystemOfSpec.set(im.id, comp.subsystem);
  }
  for (const t of types) {
    if (t.subsystem) subsystemOfSpec.set(t.id, t.subsystem);
  }

  const profileDepth = (profileName: string | undefined): import('../../models/index.js').DesignDepth | undefined =>
    profileName ? extensions.profiles[profileName]?.rules?.designDepth : undefined;

  const effectiveDesignDepth = (subsystemId: string | undefined): import('../../models/index.js').DesignDepth => {
    const sub = subsystemId ? subsystems.find(s => s.id === subsystemId) : undefined;
    return sub?.designDepth
      ?? rules?.designDepth
      ?? profileDepth(sub?.profile)
      ?? profileDepth(projectType)
      ?? 'narratives';
  };

  const isComponentDraft = (compId: string): boolean => {
    const comp = componentMap.get(compId);
    if (!compId || !comp) return false;
    if (comp.status === 'draft' || comp.status === 'design') return true;

    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && (sub.status === 'draft' || sub.status === 'design')) return true;

    return false;
  };

  const isImplementationDraft = (impl: ImplementationSpec): boolean => {
    if (impl.status === 'draft' || impl.status === 'design') return true;
    const contract = interfaceMap.get(impl.contract);
    if (!contract) return false;
    return contract.status === 'draft' || contract.status === 'design' || isComponentDraft(contract.component);
  };

  const getComponentProfile = (compId: string): ArchProfile => {
    const comp = componentMap.get(compId);
    if (!comp) return 'backend';
    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && sub.profile) {
      return sub.profile;
    }
    if ((BUILTIN_PROFILES as readonly string[]).includes(projectType) || projectType in extensions.profiles) {
      return projectType;
    }
    return 'backend';
  };

  const targetLanguageFor =(subsystemId: string | undefined): string | undefined => {
    if (subsystemId) {
      const sub = subsystems.find(s => s.id === subsystemId);
      if (sub?.targetLanguage) return normalizeLanguage(sub.targetLanguage);
    }
    return system.targetLanguage ? normalizeLanguage(system.targetLanguage) : undefined;
  };

  // ---- the bound project, its members, its imports and its pins -------------
  //
  // The owner's gate (stage 4): everything below is read from the bound
  // project's own files — its scan (its own specs and the export tables of the
  // members it contains), its configuration's `use` imports, its externals lock
  // and its pinned snapshots. Nothing above the bound root is consulted, and no
  // name is ever matched family-wide.

  const family = opts.projectFamily;
  const pinnedExternals = opts.pinnedExternals ?? [];
  const memberKeys: string[] = family ? family.nodes.filter((n) => n.namespace !== '').map((n) => n.namespace) : [];
  /** The member that owns a key: its owner in the graph, else the longest member key prefixing it. */
  const memberOf = (key: string): string | undefined => {
    const owner = family?.owners.get(key);
    if (owner !== undefined) return owner === '' ? undefined : owner;
    let best: string | undefined;
    for (const k of memberKeys) {
      if ((key === k || key.startsWith(`${k}::`)) && (!best || k.length > best.length)) best = k;
    }
    return best;
  };

  const isInChainedSubproject = (subsystemId: string): boolean => memberOf(subsystemId) !== undefined;
  /** rule_context.projectOf — '' for the bound project, else the contained member owning the key. */
  const projectOf = (specId: string): string => memberOf(specId) ?? '';
  /**
   * Whether a finding's spec is one a contained member owns: its owner in the
   * graph, else a key strictly under a member's key. A member's own key names
   * the bound project's declaration of it (a legacy mount, a member entry),
   * which this project's gate judges.
   */
  const ownedByMember = (specId: string): boolean => {
    const owner = family?.owners.get(specId);
    if (owner !== undefined) return owner !== '';
    return memberKeys.some((k) => specId.startsWith(`${k}::`));
  };

  const boundNode = family?.nodes.find((n) => n.namespace === '');
  const ownerId = boundNode?.id ?? '';
  const nodeOf = (key: string | undefined) => (key === undefined ? undefined : family?.nodes.find((n) => n.namespace === key));
  const projectTableOf = (key: string): ResolvedExportTable | undefined =>
    (opts.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key && key !== '');
  const digestOf = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;

  /** One import of the bound project: the alias, where it is declared, what it imports and what it is judged against. */
  interface Supplier {
    alias: string;
    section: 'externals' | 'members';
    star: boolean;
    names: Set<string>;
    /** A contained member's live table, or a scanned external's. */
    table?: ResolvedExportTable;
    /** A declared external's pin, when its producer is outside the scan. */
    pin?: PinnedExternal;
  }
  const suppliers: Supplier[] = (boundNode?.imports ?? []).map((i) => {
    const key = boundNode?.aliases.get(i.alias);
    const table = key !== undefined ? projectTableOf(key) : undefined;
    const pin = key === undefined ? pinnedExternals.find((p) => p.alias === i.alias) : undefined;
    return {
      alias: i.alias, section: i.section, star: i.use.includes('*'),
      names: new Set(i.use.filter((u) => u !== '*').map(nameKey)),
      ...(table ? { table } : {}), ...(pin ? { pin } : {}),
    };
  });
  /** Whether a supplier has anything to judge against: a live table, or a readable pin. */
  const judgeable = (s: Supplier): boolean => s.table !== undefined || s.pin?.snapshot !== undefined;
  /** The public name a supplier exports under a nameKey, for a component or a type. */
  const exportedBy = (s: Supplier, key: string, kind: 'component' | 'type'): string | undefined => {
    if (s.table) return s.table.entries.find((e) => e.kind === kind && nameKey(e.publicName) === key)?.publicName;
    const snap = s.pin?.snapshot;
    if (!snap) return undefined;
    const ids = kind === 'type' ? (snap.exportedTypes ?? []).map((t) => t.id) : snap.interfaces.map((e) => e.id);
    return ids.find((id) => nameKey(id) === key);
  };

  /**
   * A bare name through the bound project's imports: an explicit name beats a
   * `*`; one supplier resolves, two are ambiguous; a supplier with nothing to
   * judge against leaves it unavailable; no supplier at all is none.
   */
  const importOf = (name: string, kind: 'component' | 'type'):
    { outcome: 'resolved' | 'ambiguous' | 'unavailable' | 'none'; supplier?: Supplier; publicName?: string; via: string } => {
    const key = nameKey(name);
    const offers = (s: Supplier): boolean => !judgeable(s) || exportedBy(s, key, kind) !== undefined;
    const explicit = suppliers.filter((s) => s.names.has(key) && offers(s));
    const pool = explicit.length > 0 ? explicit : suppliers.filter((s) => s.star && offers(s));
    const known = pool.filter(judgeable);
    const unknown = pool.filter((s) => !judgeable(s));
    const via = pool.map((s) => `${s.alias} (${s.names.has(key) ? 'by name' : 'by *'})`).join(', ');
    if (pool.length === 0) return { outcome: 'none', via };
    if ((explicit.length > 0 && pool.length > 1) || known.length > 1) return { outcome: 'ambiguous', via };
    if (unknown.length > 0) return { outcome: 'unavailable', via, supplier: unknown[0] };
    return { outcome: 'resolved', supplier: known[0], publicName: exportedBy(known[0], key, kind), via };
  };

  const importHint = (name: string): string | null => {
    const key = nameKey(name);
    for (const s of suppliers) {
      if (s.star || s.names.has(key)) continue;
      const publicName = exportedBy(s, key, 'type') ?? exportedBy(s, key, 'component');
      if (publicName) return `${s.section}.${s.alias}.use: [${publicName}]`;
    }
    return null;
  };

  /** The bound project's own types — the only ones a bare name resolves to locally. */
  const ownTypes = types.filter((t) => memberOf(t.id) === undefined);
  const aliasOf = (segment: string): Supplier | undefined => suppliers.find((s) => s.alias === segment);
  const authoredTypeRefs = new Set((family?.authoredReferences ?? [])
    .filter((r) => r.position === 'type' && r.binding !== 'local' && memberOf(r.specId) === undefined)
    .map((r) => r.authored));

  const isTypeResolved = (ref: string, generics: Set<string>): boolean => {
    const refLower = ref.toLowerCase();
    if (isTypeVocabulary(refLower)) return true;
    if (generics.has(refLower)) return true;
    // Local first: the bound project's own types, compared by nameKey per segment.
    if (ownTypes.some(spec => typeMatchesRef(spec, ref))) return true;
    const [first, ...rest] = ref.split(/::|\./);
    if (!rest.length) {
      // A bare name through the imports; any outcome but none is
      // project-boundaries' single finding (or no finding at all).
      return importOf(ref, 'type').outcome !== 'none';
    }
    // The project's own id used as a prefix is its own name (a deprecated form).
    if (ownerId && nameKey(first) === nameKey(ownerId)) return ownTypes.some((spec) => typeMatchesRef(spec, rest.join('::')));
    // A `::` reference the scan recorded as leaving the project is project-boundaries' to judge.
    if (ref.includes('::') && authoredTypeRefs.has(ref)) return true;
    // The dotted form names a subsystem's type: a first segment that is an
    // alias, not a subsystem, does not resolve — another project is reached
    // only as `alias::name`, and a dotted spelling left behind by a boundary
    // move must never pass silently (aliasSpelling names the replacement).
    return false;
  };

  /** rule_context.aliasSpelling — the `alias::publicName` a dotted `alias.name` must be written as; null otherwise. */
  const aliasSpelling = (ref: string): string | null => {
    const segments = ref.split('.');
    if (segments.length !== 2 || ref.includes('::')) return null;
    const [first, name] = segments;
    if (subsystems.some((s) => nameKey(s.id.split('::').pop()!) === nameKey(first) && memberOf(s.id) === undefined)) return null;
    const via = aliasOf(first);
    const publicName = via ? exportedBy(via, nameKey(name), 'type') : undefined;
    return via && publicName ? `${via.alias}::${publicName}` : null;
  };

  /** A foreign reference against the bound root's own foreign snapshots, matched by provider. */
  const foreignSurfaceRef = (ref: string): SurfaceRefResolution => {
    const segments = ref.split('::').filter(seg => seg && seg !== 'super');
    const local = segments.pop();
    if (!local) return { kind: 'unresolved' };
    const provider = segments.pop();
    const candidates: { snapshot: SurfaceSnapshot; entry: SurfaceContractEntry }[] = [];
    for (const snapshot of surfaceSnapshots) {
      if (provider !== undefined && !isProvidedBy(snapshot, provider)) continue;
      // An entry is found by its public name alone: a renamed or narrowed
      // export answers to its name, never to its backing component.
      const entry = snapshot.interfaces.find(e => e.id === local);
      if (entry) candidates.push({ snapshot, entry });
    }
    if (candidates.length === 0) return { kind: 'unresolved' };
    const [first] = candidates;
    if (candidates.every((c) => sameContract(c.entry, first.entry))) return { kind: 'resolved', ...first };
    return { kind: 'ambiguous', providers: [...new Set(candidates.map((c) => c.snapshot.projectName))] };
  };

  // The contract entry a reference leaving the bound project lands on: a
  // declared external's pin (by alias, or through a `use` import), else the
  // bound root's own foreign snapshots. No member's snapshots are consulted.
  const resolveSurfaceRef = (ref: string): SurfaceRefResolution => {
    const segments = ref.split('::');
    const pinOf = (s: Supplier | undefined): SurfaceSnapshot | undefined => s?.pin?.snapshot;
    if (segments.length === 2) {
      const snapshot = pinOf(aliasOf(segments[0]));
      if (snapshot) {
        const entry = snapshot.interfaces.find((e) => e.id === segments[1]);
        return entry ? { kind: 'resolved', snapshot, entry } : { kind: 'unresolved' };
      }
    }
    if (segments.length === 1) {
      const imported = importOf(ref, 'component');
      const snapshot = imported.outcome === 'resolved' ? pinOf(imported.supplier) : undefined;
      const entry = snapshot?.interfaces.find((e) => e.id === imported.publicName);
      if (snapshot && entry) return { kind: 'resolved', snapshot, entry };
    }
    return foreignSurfaceRef(ref);
  };

  // Every reference the scan recorded, by spec, position and either its text or its bound key.
  const authoredIndex = new Map<string, AuthoredReference>();
  for (const r of family?.authoredReferences ?? []) {
    for (const text of [r.authored, r.resolved]) {
      const k = `${r.specId}\u0000${r.position}\u0000${text}`;
      if (!authoredIndex.has(k)) authoredIndex.set(k, r);
    }
  }

  /** The owner's resolution of one recorded reference, before any severity; null for one that stays inside the project. */
  const resolutionOf = (r: AuthoredReference): ReferenceResolution | null => {
    const kind: 'component' | 'type' = r.position === 'type' ? 'type' : 'component';
    const base = { owner: ownerId, callSite: `${r.specId} (${r.position})` };
    const producer = nodeOf(r.producer);
    const producerId = producer?.id ?? r.producer ?? '';
    const liveDigest = (): { inputDigest?: string } => {
      const table = r.producer !== undefined ? projectTableOf(r.producer) : undefined;
      return table ? { inputDigest: digestOf(table.entries) } : {};
    };
    const unavailable = (reason: string) => ({ ...base, outcome: 'unavailable' as const, canonicalTarget: r.authored, reason });
    switch (r.binding) {
      case 'local':
        return null;
      case 'exported':
        if (r.producer === '' || r.producer === undefined) return null;
        return {
          ...base, outcome: 'resolved', canonicalTarget: `${producerId}::${r.publicName}`, ...liveDigest(),
          reason: `"${r.authored}" lands on the public name "${r.publicName}" of project "${producerId}"`,
          ...(r.importedVia ? { importedVia: r.importedVia } : {}),
        };
      case 'unexported':
        return {
          ...base, outcome: 'missing', canonicalTarget: `${producerId}::${r.resolved.split('::').pop()}`, ...liveDigest(),
          reason: `project "${producerId}" exports no public name for "${r.authored}" in its live L0 table`,
        };
      case 'undeclared':
        return {
          ...base, outcome: 'forbidden', canonicalTarget: `${producerId}::${r.resolved.split('::').pop()}`,
          reason: `"${r.authored}" reaches project "${producerId}", which this project declares neither as a member nor as an external`,
        };
      case 'ambiguous':
        return {
          ...base, outcome: 'ambiguous', canonicalTarget: r.authored, importedVia: r.importedVia,
          reason: `two imports supply the bare name "${r.authored}": ${r.importedVia}`,
        };
      case 'unresolved': {
        if (r.form === 'import') return null;
        const foreign = foreignSurfaceRef(r.authored);
        if (foreign.kind === 'resolved') {
          return { ...base, outcome: 'resolved', canonicalTarget: `${foreign.snapshot.projectId ?? foreign.snapshot.projectName}::${foreign.entry.id}`, reason: `"${r.authored}" lands on a foreign surface snapshot` };
        }
        if (foreign.kind === 'ambiguous') {
          return { ...base, outcome: 'ambiguous', canonicalTarget: r.authored, reason: `the foreign snapshots of ${foreign.providers.map((p) => `"${p}"`).join(', ')} expose "${r.authored}" with different contracts` };
        }
        if (r.form === 'leading' || r.form === 'super') return unavailable(`the deprecated form "${r.authored}" names no alias of this project, so there is nothing to judge it against — run \`wairon doctor --fix\``);
        return {
          ...base, outcome: 'forbidden', canonicalTarget: r.authored,
          reason: `the first segment of "${r.authored}" is none of this project's subsystems, aliases or foreign providers`,
        };
      }
      case 'outside': {
        if (r.form === 'import') {
          const imported = importOf(r.authored, kind);
          if (imported.outcome === 'none') return null;
          if (imported.outcome === 'ambiguous') return { ...base, outcome: 'ambiguous', canonicalTarget: r.authored, importedVia: imported.via, reason: `two imports supply the bare name "${r.authored}": ${imported.via}` };
          if (imported.outcome === 'unavailable') return unavailable(`the import through "${imported.supplier!.alias}" has nothing to be judged against: ${imported.supplier!.pin?.problem ?? 'no pin'}`);
          const s = imported.supplier!;
          return {
            ...base, outcome: 'resolved', canonicalTarget: `${s.pin?.project ?? s.alias}::${imported.publicName}`,
            ...(s.pin?.entry ? { inputDigest: s.pin.entry.digest } : {}), importedVia: imported.via,
            reason: `"${r.authored}" is the public name "${imported.publicName}" imported through "${s.alias}"`,
          };
        }
        const segments = r.authored.split('::');
        if (r.form === 'alias' && segments.length === 2) {
          const [alias, name] = segments;
          const member = suppliers.find((s) => s.alias === alias && s.section === 'members');
          // A referenced project member (stage 8) is judged against its pin, as an external is.
          if (member && !member.table && !member.pin) return unavailable(`the member "${alias}" is absent on disk, so its export table cannot be read`);
          const pin = pinnedExternals.find((p) => p.alias === alias);
          if (!pin?.snapshot) return unavailable(pin?.problem ?? `the external "${alias}" was never pinned (run \`wairon externals pin\`)`);
          const ids = kind === 'type' ? (pin.snapshot.exportedTypes ?? []).map((t) => t.id) : pin.snapshot.interfaces.map((e) => e.id);
          const found = ids.includes(name);
          return {
            ...base, outcome: found ? 'resolved' : 'missing', canonicalTarget: `${pin.project}::${name}`,
            ...(pin.entry ? { inputDigest: pin.entry.digest } : {}),
            reason: found
              ? `"${r.authored}" lands on the public name "${name}" of the pinned snapshot of "${pin.project}"`
              : `the pinned snapshot of "${pin.project}" (digest ${pin.entry?.digest ?? 'unknown'}) exports no ${kind === 'type' ? 'type' : 'public name'} "${name}"`,
          };
        }
        const foreign = foreignSurfaceRef(r.authored);
        if (foreign.kind === 'resolved') {
          return { ...base, outcome: 'resolved', canonicalTarget: `${foreign.snapshot.projectId ?? foreign.snapshot.projectName}::${foreign.entry.id}`, reason: `"${r.authored}" lands on a foreign surface snapshot` };
        }
        if (foreign.kind === 'ambiguous') {
          return { ...base, outcome: 'ambiguous', canonicalTarget: r.authored, reason: `the foreign snapshots of ${foreign.providers.map((p) => `"${p}"`).join(', ')} expose "${r.authored}" with different contracts` };
        }
        return unavailable(`the deprecated form "${r.authored}" reaches above this project, and no alias of it names its target — run \`wairon doctor --fix\``);
      }
      default:
        return null;
    }
  };

  const resolveCrossProject = (specId: string, position: string, reference: string): ReferenceResolution | null => {
    if (memberOf(specId) !== undefined) return null;
    const r = authoredIndex.get(`${specId}\u0000${position}\u0000${reference}`);
    return r ? resolutionOf(r) : null;
  };

  // ---- contract methods, rule configs and the type vocabulary ---------------

  // Memoized: eight rules ask for this per dispatch binding or per narrative
  // step, and rebuilding the array each time was pure waste. The answer is a
  // read-only view every caller treats as one.
  const contractMethods = new Map<string, MethodSignature[]>();
  const interfaceMethodsOf = (compId: string): MethodSignature[] => {
    const cached = contractMethods.get(compId);
    if (cached) return cached;
    const out: MethodSignature[] = [];
    for (const intf of interfacesByComponent.get(compId) ?? []) {
      out.push(...intf.methods);
    }
    contractMethods.set(compId, out);
    return out;
  };

  /** The pack profile governing a subsystem: its own profile, else the project type (an empty profile is no profile). */
  const profileDefFor = (subsystemId?: string) => {
    const sub = subsystemId ? subsystems.find(s => s.id === subsystemId) : undefined;
    const profile = sub?.profile || projectType;
    return extensions.profiles[profile];
  };

  // The pack profile supplies the base and the project's own explicit config
  // is applied LAST, so a project's setting wins over an installed pack's —
  // the same precedence sddRuleSeverity resolves a few lines below.
  const complexityConfigFor = (subsystemId?: string): ComplexityRuleConfig | undefined => {
    const projectComp = rules?.complexity;
    const packDef = profileDefFor(subsystemId);

    if (packDef?.rules?.complexity) {
      return { ...packDef.rules.complexity, ...projectComp };
    }
    return projectComp;
  };

  const documentationConfigFor = (subsystemId?: string): DocumentationRuleConfig | undefined => {
    const projectDoc = rules?.documentation;
    const packDef = profileDefFor(subsystemId);

    if (packDef?.rules?.documentation) {
      return { ...packDef.rules.documentation, ...projectDoc };
    }
    return projectDoc;
  };

  const namingConfigFor = (subsystemId?: string): NamingRuleConfig | undefined => {
    const projectNaming = rules?.naming;
    const packDef = profileDefFor(subsystemId);

    if (packDef?.rules?.naming) {
      return {
        ...packDef.rules.naming,
        ...projectNaming,
        stereotypes: {
          ...(packDef.rules.naming.stereotypes ?? {}),
          ...(projectNaming?.stereotypes ?? {}),
        },
      };
    }
    return projectNaming;
  };

  const isBuiltinType = (ref: string): boolean => isTypeVocabulary(ref);

  const getRuleSeverity = (
    ruleCode: string,
    defaultSeverity: Severity,
    isDraftContext?: boolean,
    subsystemId?: string,
  ): IssueSeverity | 'off' => {
    // Explicit project config wins over everything — including setting a code
    // to `notice`, or raising one from notice to warning or error.
    if (rules?.sddRuleSeverity?.[ruleCode]) {
      return rules.sddRuleSeverity[ruleCode];
    }
    // Then the governing pack profile's severity overrides — the mechanism a
    // platform pack (e.g. a low-code profile) uses to auto-apply its doctrine
    // to every subsystem running under it, scoped to those subsystems only.
    // An empty profile is no profile, as in profileDefFor: the project type governs.
    const sub = subsystemId ? subsystems.find(s => s.id === subsystemId) : undefined;
    const profileSeverity = extensions.profiles[sub?.profile || projectType]?.rules?.sddRuleSeverity?.[ruleCode];
    if (profileSeverity) {
      return profileSeverity;
    }
    // The draft downgrade is min(default, warning): it softens an error, and it
    // never RAISES anything — a notice stays a notice in draft context, and
    // nothing becomes one by being draft.
    if (isDraftContext && COMPLETENESS_RULES.has(ruleCode)) {
      return atMostWarning(defaultSeverity);
    }
    return defaultSeverity;
  };

  // Per-spec lint suppressions — wairon's #[allow(...)]. Collected from every
  // spec kind that carries a `lint` block; addIssue consults them AFTER
  // severity resolution: a matching allow silences a WARNING or a NOTICE, while an error
  // still surfaces (architecture violations are never locally suppressible —
  // the allow is only marked used so it isn't flagged as stale).
  //
  // A MATCH is site-for-site, in the conformance debt register's own
  // vocabulary: a finding that carries `parts` is covered only by an allow
  // naming that same `parts.at`, and a finding that carries none only by an
  // allow naming no site either. Keyed by code and spec alone — as it was —
  // one allow silenced every occurrence a rule reported there, which on
  // wairon's own tree made 14 of 46 suppressed findings invisible to the allow
  // that named them. Several allows may now share a code on one spec, so the
  // lookup holds a LIST; the first with the matching site wins and a second
  // one for it can never match, which the audit reports as stale.
  const lintAllows: RuleContext['lintAllows'] = [];
  const allowLookup = new Map<string, Map<string, RuleContext['lintAllows'][number][]>>();
  const collectAllows = (specId: string, lint?: { allow: { code: string; at?: string; covers?: string[]; reason: string }[] }): void => {
    for (const a of lint?.allow ?? []) {
      const entry = { specId, code: a.code, at: a.at, covers: a.covers, reason: a.reason, used: false };
      lintAllows.push(entry);
      if (!allowLookup.has(specId)) allowLookup.set(specId, new Map());
      const forSpec = allowLookup.get(specId)!;
      const forCode = forSpec.get(a.code) ?? [];
      forCode.push(entry);
      forSpec.set(a.code, forCode);
    }
  };
  // Where this run's findings landed, per spec and code — filled by addIssue
  // before any suppression, read by the lint-allows audit.
  const sitesSeen = new Map<string, { sites: Set<string>; unsited: boolean; errored: boolean }>();
  const sitesReported = (specId: string, code: string): { sites: string[]; unsited: boolean; errored: boolean } => {
    const seen = sitesSeen.get(`${specId}\u0000${code}`);
    return { sites: [...(seen?.sites ?? [])], unsited: seen?.unsited ?? false, errored: seen?.errored ?? false };
  };
  // Each known code's default severity — the caller's gathering, with every
  // loaded assertion's own — resolved the way addIssue resolves a finding
  // outside draft context.
  const codeDefaults = new Map<string, Severity>(opts.issueCodeSeverities ?? []);
  for (const a of opts.extensions?.assertions ?? []) {
    if (!codeDefaults.has(a.fullCode)) codeDefaults.set(a.fullCode, a.severity);
  }
  const severityOf = (code: string, specId: string): IssueSeverity | 'off' | undefined => {
    const defaultSeverity = codeDefaults.get(code);
    if (!defaultSeverity) return undefined;
    return getRuleSeverity(code, defaultSeverity, false, subsystemOfSpec.get(specId));
  };

  for (const s of subsystems) collectAllows(s.id, s.lint);
  for (const c of components) collectAllows(c.id, c.lint);
  for (const i of interfaces) collectAllows(i.id, i.lint);
  for (const im of implementations) collectAllows(im.id, im.lint);
  for (const t of types) collectAllows(t.id, t.lint);

  // The conformance debt register — wairon's counterpart to the frozen
  // `unclaimed` list, for findings about code a spec DOES claim. Flattened
  // here from the reason groups the config holds, so every entry carries the
  // kind and the reason that explain it; addIssue consults it AFTER the lint
  // allows, so an allow and an entry can never both claim one finding (the
  // entry is then reported stale, which is the truth: it carries nothing).
  const carriedFindings: CarriedFindingEntry[] = [];
  const carriedLookup = new Map<string, CarriedFindingEntry>();
  const carriedKey = (spec: string, code: string, at: string): string => `${spec}\u0000${code}\u0000${at}`;
  for (const group of rules?.conformance?.carried ?? []) {
    for (const f of group.findings ?? []) {
      const entry: CarriedFindingEntry = {
        kind: group.kind,
        why: group.why,
        code: f.code,
        spec: f.spec,
        at: f.at,
        covers: f.covers ?? [],
        fired: false,
        seen: new Set<string>(),
      };
      carriedFindings.push(entry);
      // A second entry for the same finding never matches, so it can never
      // carry anything; the audit names the duplicate for what it is.
      const key = carriedKey(f.spec, f.code, f.at);
      if (!carriedLookup.has(key)) carriedLookup.set(key, entry);
    }
  }

  const addIssue = (
    defaultSeverity: Severity,
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean,
    resolution?: ReferenceResolution,
    parts?: FindingParts,
  ): void => {
    // A finding on a spec a contained member owns is that member's own gate's,
    // judged under its own configuration — never this project's.
    if (specId && ownedByMember(specId)) return;
    if (scopeSubsystem && specId && !isSpecInScope(specId)) {
      return;
    }
    const owner = specId ? subsystemOfSpec.get(specId) : undefined;
    // Design-depth gate (before severity resolution): expectation codes below
    // the effective depth are skipped entirely — the team declared it does
    // not design that layer, so nothing at that layer can be "missing".
    const requiredDepth = DEPTH_GATED_CODES[code];
    if (requiredDepth) {
      if (DEPTH_RANK[effectiveDesignDepth(owner)] < DEPTH_RANK[requiredDepth]) return;
    }
    const severity = getRuleSeverity(code, defaultSeverity, isDraftContext, owner);
    if (severity === 'off') return;
    let text = message;
    // What this finding said about where it landed, recorded before anything
    // can silence it: the audit needs the sites of the findings an allow did
    // NOT match to tell a stale allow from a merely coarse one.
    if (specId) {
      const key = `${specId}\u0000${code}`;
      let seen = sitesSeen.get(key);
      if (!seen) sitesSeen.set(key, (seen = { sites: new Set<string>(), unsited: false, errored: false }));
      if (parts) seen.sites.add(parts.at);
      else seen.unsited = true;
      if (severity === 'error') seen.errored = true;
    }
    // The allow, matched on the finding's IDENTITY rather than its code alone.
    // An allow covers one occurrence: the site it names, and — where the
    // finding aggregates — the units it lists. A unit it does not list is a
    // decision nobody took, so the finding still fires and says which.
    let allowClaimed = false;
    if (specId) {
      const allow = (allowLookup.get(specId)?.get(code) ?? [])
        .find(a => (parts ? a.at === parts.at : a.at === undefined));
      if (allow) {
        allow.used = true;
        allowClaimed = true;
        const grew = (parts?.covers ?? []).filter(unit => !(allow.covers ?? []).includes(unit));
        if (grew.length === 0) {
          if (severity !== 'error') return;
        } else {
          text = `${text} A lint.allow covers this site, but not ${grew.length} part(s) of it — ${grew.map(u => `"${u}"`).join('; ')} ${grew.length === 1 ? 'is' : 'are'} new. Decide on them: add them to the allow's \`covers\` with a reason that is actually true, or fix them.`;
        }
      }
    }
    // The conformance debt register, consulted with the finding's IDENTITY
    // rather than its prose. An entry carries the warning only when it lists
    // EVERY unit the finding reports: a crossing or a step the entry does not
    // name is growth, and growth is exactly what a register must not absorb —
    // so the finding still fires, and its message says which units are new.
    // Errors are never carried, for the reason an allow never silences one; a
    // notice is carried like a warning, because a register entry for a code
    // the project set to notice still names a finding that fired — reporting
    // it stale would be a false warning about a true entry.
    // An allow that claimed this site is the end of it: the two mechanisms
    // make different claims, and one finding is never both "wrong by design"
    // and "right but unpaid" — the entry is then reported stale, which is the
    // truth, because it carries nothing.
    if (specId && parts && severity !== 'error' && !allowClaimed) {
      const entry = carriedLookup.get(carriedKey(specId, code, parts.at));
      if (entry) {
        entry.fired = true;
        const listed = new Set(entry.covers);
        const grew: string[] = [];
        for (const unit of parts.covers ?? []) {
          if (listed.has(unit)) entry.seen.add(unit);
          else grew.push(unit);
        }
        if (grew.length === 0) return;
        text = `${text} The conformance debt register carries this finding, but not ${grew.length} part(s) of it — ${grew.map(u => `"${u}"`).join('; ')} ${grew.length === 1 ? 'is' : 'are'} new. Fix them, or add them to the entry's \`covers\` with a reason that is actually true.`;
      }
    }
    // Carry the draft/design provenance onto the issue (only when true, to keep
    // issues clean) so command-level policy can classify draft-related warnings
    // without re-deriving spec status. The rule stays fully emitted/visible.
    // A finding about a cross-project reference carries its resolution, the
    // structured answer decided before this severity.
    issues.push({
      severity,
      code,
      message: text,
      specId,
      ...(isDraftContext ? { draftContext: true } : {}),
      ...(resolution ? { resolution } : {}),
    });
  };

  // ---- the shared derived read model ---------------------------------------
  // Four indexes rules used to rebuild for themselves, each derived once on
  // first ask (read-model.ts holds the semantics). The import graph is keyed
  // by its closed path set, because resolution is string matching AGAINST that
  // set: the graph dependency conformance accuses from (component-mapped exact
  // files only) is a different graph from the one an integration harness is
  // walked over (every analyzed path), and they must not be confused.
  let codeIndexMemo: CodeIndex | undefined;
  const codeIndex = (): CodeIndex => (codeIndexMemo ??= buildCodeIndex(ctx.codeModel));
  let realizationMemo: RealizationIndex | undefined;
  const realizationIndex = (): RealizationIndex => (realizationMemo ??= buildRealizationIndex(ctx));
  const importGraphs = new Map<string, ImportGraph>();
  const importGraph = (paths?: Set<string>): ImportGraph => {
    const universe = paths ?? codeIndex().paths;
    const key = `${universe.size}\u0000${[...universe].join('\u0000')}`;
    let graph = importGraphs.get(key);
    if (!graph) {
      graph = buildImportGraph(codeIndex(), universe);
      importGraphs.set(key, graph);
    }
    return graph;
  };
  let ownershipMemo: OwnershipIndex | undefined;
  const ownershipIndex = (): OwnershipIndex => (ownershipMemo ??= buildOwnershipIndex(ctx));
  let dependencyEdgesMemo: DependencyEdges | undefined;
  const dependencyEdges = (): DependencyEdges => (dependencyEdgesMemo ??= buildDependencyEdges(ctx));
  let specIdsMemo: SpecId[] | undefined;
  const specIds = (): SpecId[] => (specIdsMemo ??= buildSpecIds(ctx));
  let implementationMethodsMemo: ResolvedMethod[] | undefined;
  const implementationMethods = (): ResolvedMethod[] => (implementationMethodsMemo ??= buildImplementationMethods(ctx));

  const ctx: RuleContext = {
    system,
    subsystems,
    components,
    interfaces,
    implementations,
    types,
    rules,
    projectType,
    scopeSubsystem,
    componentMap,
    interfaceMap,
    subsystemIds,
    componentIds,
    interfaceIds,
    publicSet,
    interfacesByComponent,
    implementationsByContract,
    isComponentDraft,
    isImplementationDraft,
    getComponentProfile,
    isTypeResolved,
    aliasSpelling,
    targetLanguageFor,
    isSpecInScope,
    isInChainedSubproject,
    projectOf,
    resolveSurfaceRef,
    resolveCrossProject,
    importHint,
    interfaceMethodsOf,
    codeIndex,
    realizationIndex,
    importGraph,
    ownershipIndex,
    dependencyEdges,
    specIds,
    implementationMethods,
    complexityConfigFor,
    documentationConfigFor,
    namingConfigFor,
    isBuiltinType,
    ext: { profiles: extensions.profiles, languages: extensions.languages, patterns: extensions.patterns, guarantees: extensions.guarantees, assertions: extensions.assertions, packSelections: opts.packSelections ?? [], selectionFailures: extensions.selectionFailures ?? [], packRequirements: opts.packRequirements ?? [], deprecations: extensions.deprecations ?? [] },
    variants: opts.variants ?? [],
    surfaceSnapshots,
    ...(opts.projectIdentity ? { projectIdentity: opts.projectIdentity } : {}),
    ...(opts.declaredMembers ? { declaredMembers: opts.declaredMembers } : {}),
    ...(opts.network ? { network: opts.network } : {}),
    // Each scanned project's L0 language, from the project graph's nodes.
    ...(family
      ? { projectLanguages: new Map(family.nodes.filter((n) => n.targetLanguage).map((n) => [n.namespace, normalizeLanguage(n.targetLanguage!)] as const)) }
      : {}),
    ...(opts.retiredReachFacts ? { retiredReachFacts: opts.retiredReachFacts } : {}),
    ...(opts.exportTables ? { exportTables: opts.exportTables } : {}),
    ...(opts.projectFamily ? { projectFamily: opts.projectFamily } : {}),
    ...(opts.exportUsages ? { exportUsages: opts.exportUsages } : {}),
    ...(opts.signatureFacts ? { signatureFacts: opts.signatureFacts } : {}),
    ...(opts.typeSpellingFacts ? { typeSpellingFacts: opts.typeSpellingFacts } : {}),
    pinnedExternals,
    codeModel: opts.codeModel ?? emptyCodeModel(),
    roundTripIssues: opts.roundTripIssues,
    lintAllows,
    sitesReported,
    severityOf,
    knownIssueCodes: opts.knownIssueCodes,
    carriedFindings,
    carryableIssueCodes: opts.carryableIssueCodes ?? new Set<string>(),
    addIssue,
  };
  return ctx;
}
