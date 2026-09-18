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
  BUILTIN_TYPES,
  isProvidedBy,
  sameContract,
  typeMatchesRef,
} from '../../models/index.js';
import type { ValidationIssue } from '../validation.js';
import { emptyExtensions, LoadedExtensions } from '../extensions.js';
import type { VariantDef } from '../variants.js';
import type { PackSelection } from '../../models/project.js';
import {
  ArchProfile,
  BUILTIN_PROFILES,
  RuleContext,
  SddRule,
  Severity,
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
  PORTAL_AUTH_UNMET: 'implementations',
  MISSING_SOURCE_FILE: 'implementations',
  SOURCE_PATH_ESCAPES_ROOT: 'implementations',
  UNREALIZED_METHOD: 'implementations',
  UNREALIZED_FINDING: 'implementations',
  CONFORMANCE_ANALYSIS_SKIPPED: 'implementations',
  CONFORMANCE_DEGRADED: 'implementations',
  UNDECLARED_DEPENDENCY: 'implementations',
  UNREALIZED_DEPENDENCY: 'implementations',
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

// Completeness rules downgrade to warnings while the surrounding specs are
// still draft/design — the tree is allowed to be unfinished, not inconsistent.
const COMPLETENESS_RULES = new Set([
  'MISSING_IMPLEMENTATION_METHOD',
  'MISSING_NARRATIVE',
  'INTENT_FLOOR',
  'MISSING_ENDPOINT',
  'ENDPOINT_TRANSPORT_MISMATCH',
  'MISSING_PORTAL_TYPE',
  'UNEXPECTED_IMPLEMENTATION_METHOD',
  'ORPHANED_SUBSYSTEM',
  'PUBLIC_INTERFACE_UNBOUND',
  'PUBLIC_INTERFACE_TYPE_MISMATCH',
  // Structural conformance: a draft tree is allowed to name code that does
  // not exist yet — the findings gate only once the specs claim completeness.
  'MISSING_SOURCE_PATH',
  'MISSING_SOURCE_FILE',
  'SOURCE_PATH_ESCAPES_ROOT',
  'UNREALIZED_METHOD',
  'UNREALIZED_FINDING',
  'CONFORMANCE_ANALYSIS_SKIPPED',
  'UNDECLARED_DEPENDENCY',
  'UNREALIZED_DEPENDENCY',
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
    if (t) return t.subsystem === scopeSubsystem || (t.subsystem ? t.subsystem.startsWith(`${scopeSubsystem}::`) : false);

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
  /** Stored surface snapshots for cross-tree/remote reference resolution. */
  surfaceSnapshots?: SurfaceSnapshot[];
  /** Snapshots each chained mount holds, keyed by mount namespace (see RuleContext.mountSurfaceSnapshots). */
  mountSurfaceSnapshots?: import('./types.js').MountSurfaceSnapshots[];
  /** Source-code model for structural conformance; empty when not built. */
  codeModel?: CodeModel;
  /** The writer's round-trip dry-run findings for the in-scope specs, gathered by the caller (see RuleContext.roundTripIssues). */
  roundTripIssues: ValidationIssue[];
  /** Every code the registered rules and loaded declarative assertions can report, gathered by the caller (see RuleContext.knownIssueCodes). */
  knownIssueCodes: Set<string>;
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

  // A subsystem's published public surface: the component ids bound via its
  // publicInterfaces. Cross-subsystem dependencies may only target these.
  const publicSet = new Map<string, Set<string>>();
  for (const sub of subsystems) {
    publicSet.set(
      sub.id,
      new Set(sub.publicInterfaces.map(pi => pi.component).filter((c): c is string => !!c)),
    );
  }

  const surfaceSnapshots = opts.surfaceSnapshots ?? [];
  const mountSurfaceSnapshots = opts.mountSurfaceSnapshots ?? [];

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

  const isTypeResolved = (ref: string, generics: Set<string>): boolean => {
    const refLower = ref.toLowerCase();
    if (BUILTIN_TYPES.has(refLower)) return true;
    if (generics.has(refLower)) return true;

    return types.some(spec => typeMatchesRef(spec, ref));
  };

  const targetLanguageFor = (subsystemId: string | undefined): string | undefined => {
    if (subsystemId) {
      const sub = subsystems.find(s => s.id === subsystemId);
      if (sub?.targetLanguage) return normalizeLanguage(sub.targetLanguage);
    }
    return system.targetLanguage ? normalizeLanguage(system.targetLanguage) : undefined;
  };

  // ---- chained mounts and cross-tree references -----------------------------

  const isInChainedSubproject = (subsystemId: string): boolean => {
    const segments = subsystemId.split('::');
    let prefix = '';
    for (const segment of segments) {
      prefix = prefix ? `${prefix}::${segment}` : segment;
      const sub = subsystems.find(s => s.id === prefix);
      if (sub?.projectPath) return true;
    }
    return false;
  };

  /**
   * The chained mounts enclosing a subsystem, outermost first: every prefix of
   * its qualified id that is a subsystem carrying `projectPath`.
   */
  const enclosingMounts = (subsystemId: string): string[] => {
    const mounts: string[] = [];
    let prefix = '';
    for (const segment of subsystemId.split('::')) {
      prefix = prefix ? `${prefix}::${segment}` : segment;
      if (subsystems.some((s) => s.id === prefix && s.projectPath)) mounts.push(prefix);
    }
    return mounts;
  };

  const isExternalNamespaceRef = (ref: string): boolean => {
    if (ref.startsWith('::') || ref.startsWith('super::')) return true;
    const sep = ref.indexOf('::');
    if (sep === -1) return false; // a bare unresolved id is a local typo, not cross-tree
    return !subsystemIds.has(ref.slice(0, sep));
  };

  // The loader qualifies every reference a mount's spec authors locally into the
  // mount's own namespace (`kid::x`). Only a `super::` / `::` form climbs out of
  // it — and at a parent root that climb lands on an id WITHOUT the mount prefix,
  // typically a bare `x`, which isExternalNamespaceRef cannot tell from a local
  // typo. So: made from inside mount M and not under `M::` means it was authored
  // to leave M.
  const isCollapsedCrossTreeRef = (ref: string, fromSubsystem: string): boolean => {
    const nearest = enclosingMounts(fromSubsystem).pop();
    return nearest !== undefined && ref !== nearest && !ref.startsWith(`${nearest}::`);
  };

  // A hit means the edge is validated against the DECLARED contract instead of
  // falling back to the unresolvable warning. When the matching snapshots of the
  // first pool that has any disagree on the contract, the reference is ambiguous:
  // picking whichever loaded first would judge the edge against a contract its
  // author may never have meant.
  const resolveSurfaceRef = (ref: string, fromSubsystem?: string): SurfaceRefResolution => {
    const segments = ref.split('::').filter(seg => seg && seg !== 'super');
    const local = segments.pop();
    if (!local) return { kind: 'unresolved' };
    const provider = segments.pop();
    // For a reference made from inside a chained mount, the snapshots that mount
    // holds come first, nearest mount first — what the child authored against,
    // exactly as it resolves from the child's own root — then the bound root's
    // own. A mount's snapshots are never consulted for a reference made outside it.
    const mountPools = fromSubsystem
      ? enclosingMounts(fromSubsystem)
        .reverse()
        .map((ns) => mountSurfaceSnapshots.find((m) => m.namespace === ns)?.snapshots ?? [])
      : [];
    for (const pool of [...mountPools, surfaceSnapshots]) {
      const candidates: { snapshot: SurfaceSnapshot; entry: SurfaceContractEntry }[] = [];
      for (const snapshot of pool) {
        if (provider !== undefined && !isProvidedBy(snapshot, provider)) continue;
        const entry = snapshot.interfaces.find(e => e.component === local || e.id === local);
        if (entry) candidates.push({ snapshot, entry });
      }
      if (candidates.length === 0) continue;
      const [first] = candidates;
      if (candidates.every((c) => sameContract(c.entry, first.entry))) {
        return { kind: 'resolved', ...first };
      }
      return { kind: 'ambiguous', providers: [...new Set(candidates.map((c) => c.snapshot.projectName))] };
    }
    return { kind: 'unresolved' };
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

  const isBuiltinType = (ref: string): boolean => BUILTIN_TYPES.has(ref.toLowerCase());

  const getRuleSeverity = (
    ruleCode: string,
    defaultSeverity: Severity,
    isDraftContext?: boolean,
    subsystemId?: string,
  ): Severity | 'off' => {
    // Explicit project config wins over everything.
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
    if (isDraftContext && COMPLETENESS_RULES.has(ruleCode)) {
      return 'warning';
    }
    return defaultSeverity;
  };

  // Per-spec lint suppressions — wairon's #[allow(...)]. Collected from every
  // spec kind that carries a `lint` block; addIssue consults them AFTER
  // severity resolution: a matching allow silences a WARNING, while an error
  // still surfaces (architecture violations are never locally suppressible —
  // the allow is only marked used so it isn't flagged as stale).
  const lintAllows: RuleContext['lintAllows'] = [];
  const allowLookup = new Map<string, Map<string, RuleContext['lintAllows'][number]>>();
  const collectAllows = (specId: string, lint?: { allow: { code: string; reason: string }[] }): void => {
    for (const a of lint?.allow ?? []) {
      const entry = { specId, code: a.code, reason: a.reason, used: false };
      lintAllows.push(entry);
      if (!allowLookup.has(specId)) allowLookup.set(specId, new Map());
      allowLookup.get(specId)!.set(a.code, entry);
    }
  };
  for (const s of subsystems) collectAllows(s.id, s.lint);
  for (const c of components) collectAllows(c.id, c.lint);
  for (const i of interfaces) collectAllows(i.id, i.lint);
  for (const im of implementations) collectAllows(im.id, im.lint);
  for (const t of types) collectAllows(t.id, t.lint);

  const addIssue = (
    defaultSeverity: Severity,
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean,
    surfaceResolved?: boolean,
  ): void => {
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
    if (specId) {
      const allow = allowLookup.get(specId)?.get(code);
      if (allow) {
        allow.used = true;
        if (severity === 'warning') return;
      }
    }
    // Carry the draft/design provenance onto the issue (only when true, to keep
    // issues clean) so command-level policy can classify draft-related warnings
    // without re-deriving spec status. The rule stays fully emitted/visible.
    // surfaceResolved provenance rides along the same way: it tells the
    // chained-subproject pass this finding was verified against a vendored
    // snapshot and must keep full strength.
    issues.push({
      severity,
      code,
      message,
      specId,
      ...(isDraftContext ? { draftContext: true } : {}),
      ...(surfaceResolved ? { surfaceResolved: true } : {}),
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
    targetLanguageFor,
    isSpecInScope,
    isInChainedSubproject,
    isExternalNamespaceRef,
    isCollapsedCrossTreeRef,
    resolveSurfaceRef,
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
    ext: { profiles: extensions.profiles, languages: extensions.languages, patterns: extensions.patterns, guarantees: extensions.guarantees, assertions: extensions.assertions, packSelections: opts.packSelections ?? [], selectionFailures: extensions.selectionFailures ?? [] },
    variants: opts.variants ?? [],
    surfaceSnapshots,
    mountSurfaceSnapshots,
    codeModel: opts.codeModel ?? emptyCodeModel(),
    roundTripIssues: opts.roundTripIssues,
    lintAllows,
    knownIssueCodes: opts.knownIssueCodes,
    addIssue,
  };
  return ctx;
}
