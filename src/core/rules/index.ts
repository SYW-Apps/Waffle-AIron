import {
  SystemSpec,
  SubsystemSpec,
  ComponentSpec,
  InterfaceSpec,
  ImplementationSpec,
  TypeSpec,
  RulesConfig,
} from '../../models/index.js';
import type { ValidationIssue } from '../validation.js';
import { emptyExtensions, LoadedExtensions } from '../extensions.js';
import type { VariantDef } from '../variants.js';
import { ArchProfile, BUILTIN_PROFILES, RuleContext, SddRule, Severity } from './types.js';
import { BUILTIN_TYPES, matchTypeRef, normalizeLanguage } from './type-analysis.js';

import { hierarchyRule } from './hierarchy.js';
import { typeReferencesRule } from './type-references.js';
import { contractsRule } from './contracts.js';
import { narrativeFlowRule } from './narrative-flow.js';
import { narrativeDetailRule } from './narrative-detail.js';
import { portalsRule } from './portals.js';
import { stereotypeDepsRule } from './stereotype-deps.js';
import { patternsRule } from './patterns.js';
import { patternReferencesRule } from './pattern-references.js';
import { variantReferencesRule } from './variant-references.js';
import { profilesRule } from './profiles.js';
import { publicSurfaceRule } from './public-surface.js';
import { cyclesRule, reachabilityRule } from './graph.js';
import { dispatchRule, lifecycleRule, durabilityRule, untypedSeamRule, proseClaimRule } from './semantic-edges.js';
import { invariantBackingRule } from './invariants.js';
import { roundtripRule, namespaceHygieneRule, surfaceFreshnessRule } from './namespace.js';
import { couplingRule } from './coupling.js';
import { languageRule } from './language.js';
import { technologyRule } from './technology.js';
import { namingRule } from './naming.js';
import { complexityRule } from './complexity.js';
import { structuralConformanceRule } from './conformance.js';
import { dependencyConformanceRule } from './dependency-conformance.js';
import { lintAllowsRule } from './lint-allows.js';
import { emptyCodeModel, CodeModel } from '../source-analysis.js';

export * from './types.js';
export * from './type-analysis.js';

// ---------------------------------------------------------------------------
// The registry. Order matters only for issue-list readability (hierarchy first,
// heuristics last) — rules are independent.
// ---------------------------------------------------------------------------

export const SDD_RULES: SddRule[] = [
  hierarchyRule,
  // Namespace integrity right after hierarchy: unresolvable/unwritable ids
  // explain many downstream findings, so surface them early in the list.
  namespaceHygieneRule,
  roundtripRule,
  surfaceFreshnessRule,
  typeReferencesRule,
  contractsRule,
  narrativeFlowRule,
  narrativeDetailRule,
  portalsRule,
  stereotypeDepsRule,
  patternsRule,
  profilesRule,
  patternReferencesRule,
  variantReferencesRule,
  publicSurfaceRule,
  cyclesRule,
  // Semantic-edge family: dispatch/lifecycle validity BEFORE reachability so a
  // reader sees the broken edge finding next to the unused-detection fallout
  // it explains.
  dispatchRule,
  lifecycleRule,
  reachabilityRule,
  durabilityRule,
  untypedSeamRule,
  proseClaimRule,
  // Invariant registry rides with the semantic-edge family: declared entity
  // invariants must be asserted on every write path (declarations, not proofs).
  invariantBackingRule,
  // Code↔spec: structural conformance consumes the injected CodeModel (built
  // by the source analysis adapter next to the surface snapshots); dependency
  // conformance lifts its import edges onto the declared dependsOn/owns graph.
  structuralConformanceRule,
  dependencyConformanceRule,
  couplingRule,
  languageRule,
  technologyRule,
  namingRule,
  complexityRule,
  // MUST run last: it audits which lint.allow entries the earlier rules
  // actually consumed (stale/unknown allows).
  lintAllowsRule,
];

/**
 * The full rule sequence for a validation run: built-ins, then extension-pack
 * rules, with the lint-allows audit LAST so it also sees every allow the pack
 * rules consumed (otherwise a suppressed pack warning reads as a stale allow).
 */
export function composeRuleSequence(extraRules: SddRule[] = []): SddRule[] {
  const base = SDD_RULES.filter(r => r !== lintAllowsRule);
  return [...base, ...extraRules, lintAllowsRule];
}

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
  'CONFORMANCE_ANALYSIS_SKIPPED',
  'UNDECLARED_DEPENDENCY',
  'UNREALIZED_DEPENDENCY',
  // Detail sufficiency reads the realized code like the conformance family
  // does — a draft tree is allowed to disagree with its code.
  'UNNARRATED_COMPLEXITY',
  // Invariant assertions are narrative completeness — a draft tree may not
  // have written its write-path narratives yet.
  'UNASSERTED_INVARIANT',
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
  /** Stored surface snapshots for cross-tree/remote reference resolution. */
  surfaceSnapshots?: import('../../models/index.js').SurfaceSnapshot[];
  /** Source-code model for structural conformance; empty when not built. */
  codeModel?: CodeModel;
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

  const isSpecInScope = makeScopeFilter({ components, interfaces, implementations, types, scopeSubsystem });

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

    return types.some(spec => {
      const typeQualifiedId = spec.subsystem && !spec.id.startsWith(`${spec.subsystem}::`)
        ? `${spec.subsystem}::${spec.id}`
        : spec.id;
      return matchTypeRef(ref, typeQualifiedId);
    });
  };

  const targetLanguageFor = (subsystemId: string | undefined): string | undefined => {
    if (subsystemId) {
      const sub = subsystems.find(s => s.id === subsystemId);
      if (sub?.targetLanguage) return normalizeLanguage(sub.targetLanguage);
    }
    return system.targetLanguage ? normalizeLanguage(system.targetLanguage) : undefined;
  };

  const getRuleSeverity = (
    ruleCode: string,
    defaultSeverity: Severity,
    isDraftContext?: boolean,
  ): Severity | 'off' => {
    if (rules?.sddRuleSeverity?.[ruleCode]) {
      return rules.sddRuleSeverity[ruleCode];
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

  const knownIssueCodes = new Set([...SDD_RULES, ...extensions.rules].flatMap(r => r.codes.map(c => c.code)));

  const addIssue = (
    defaultSeverity: Severity,
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean,
  ): void => {
    if (scopeSubsystem && specId && !isSpecInScope(specId)) {
      return;
    }
    const severity = getRuleSeverity(code, defaultSeverity, isDraftContext);
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
    issues.push({ severity, code, message, specId, ...(isDraftContext ? { draftContext: true } : {}) });
  };

  return {
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
    ext: { profiles: extensions.profiles, languages: extensions.languages, patterns: extensions.patterns },
    variants: opts.variants ?? [],
    surfaceSnapshots: opts.surfaceSnapshots ?? [],
    codeModel: opts.codeModel ?? emptyCodeModel(),
    lintAllows,
    knownIssueCodes,
    addIssue,
  };
}
