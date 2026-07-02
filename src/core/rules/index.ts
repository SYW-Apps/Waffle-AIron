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
import { ArchProfile, RuleContext, SddRule, Severity } from './types.js';
import { BUILTIN_TYPES, matchTypeRef, normalizeLanguage } from './type-analysis.js';

import { hierarchyRule } from './hierarchy.js';
import { typeReferencesRule } from './type-references.js';
import { contractsRule } from './contracts.js';
import { narrativeFlowRule } from './narrative-flow.js';
import { narrativeDetailRule } from './narrative-detail.js';
import { portalsRule } from './portals.js';
import { stereotypeDepsRule } from './stereotype-deps.js';
import { patternsRule } from './patterns.js';
import { profilesRule } from './profiles.js';
import { publicSurfaceRule } from './public-surface.js';
import { cyclesRule, reachabilityRule } from './graph.js';
import { couplingRule } from './coupling.js';
import { languageRule } from './language.js';

export * from './types.js';
export * from './type-analysis.js';

// ---------------------------------------------------------------------------
// The registry. Order matters only for issue-list readability (hierarchy first,
// heuristics last) — rules are independent.
// ---------------------------------------------------------------------------

export const SDD_RULES: SddRule[] = [
  hierarchyRule,
  typeReferencesRule,
  contractsRule,
  narrativeFlowRule,
  narrativeDetailRule,
  portalsRule,
  stereotypeDepsRule,
  patternsRule,
  profilesRule,
  publicSurfaceRule,
  cyclesRule,
  reachabilityRule,
  couplingRule,
  languageRule,
];

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
  /** Collector the context's addIssue pushes into. */
  issues: ValidationIssue[];
}

export function buildRuleContext(opts: BuildContextOptions): RuleContext {
  const { system, subsystems, components, interfaces, implementations, types, rules, projectType, scopeSubsystem, issues } = opts;

  const componentMap = new Map(components.map(c => [c.id, c]));
  const interfaceMap = new Map(interfaces.map(i => [i.id, i]));
  const subsystemIds = new Set(subsystems.map(s => s.id));
  const componentIds = new Set(components.map(c => c.id));
  const interfaceIds = new Set(interfaces.map(i => i.id));

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

  const getComponentProfile = (compId: string): ArchProfile => {
    const comp = componentMap.get(compId);
    if (!comp) return 'backend';
    const sub = subsystems.find(s => s.id === comp.subsystem);
    if (sub && sub.profile) {
      return sub.profile;
    }
    const validProfiles = ['frontend-reactive', 'frontend-controller', 'lowlevel-os', 'game-ecs', 'realtime-embedded', 'plc-cyclic'];
    if (validProfiles.includes(projectType)) {
      return projectType as ArchProfile;
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
    if (severity !== 'off') {
      issues.push({ severity, code, message, specId });
    }
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
    isComponentDraft,
    getComponentProfile,
    isTypeResolved,
    targetLanguageFor,
    isSpecInScope,
    addIssue,
  };
}
