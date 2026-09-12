import {
  SystemSpec,
  SubsystemSpec,
  ComponentSpec,
  InterfaceSpec,
  ImplementationSpec,
  TypeSpec,
  RulesConfig,
  SurfaceSnapshot,
} from '../../models/index.js';
import type { ProfileDef, LanguagePackDef, LoadedPattern, LoadedAssertion } from '../extensions.js';
import type { VariantDef } from '../variants.js';
import type { PackSelection } from '../../models/project.js';
import type { PackSelectionFailure } from '../extensions.js';
import type { CodeModel } from '../source-analysis.js';

// ---------------------------------------------------------------------------
// Rule registry contracts
//
// Every SDD conformance check is an SddRule: a named, documented unit with the
// issue codes it can emit and a check(ctx) over the shared RuleContext. The
// registry (rules/index.ts) runs them in order; severity resolution (user
// overrides + draft-context downgrades) is centralized in ctx.addIssue.
//
// This is the "custom linter" foundation: adding a rule is a new module in
// this directory plus a registry entry — no surgery on a monolith.
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

export interface RuleCode {
  code: string;
  defaultSeverity: Severity;
  summary: string;
}

/** The built-in architectural profiles; extension packs may register more. */
export const BUILTIN_PROFILES = [
  'backend',
  'frontend-reactive',
  'frontend-controller',
  'lowlevel-os',
  'game-ecs',
  'realtime-embedded',
  'plc-cyclic',
] as const;

/**
 * The built-in COMPOSITE PROJECT KINDS: legal `projectType` values that are not
 * architectural profiles and carry no profile doctrine of their own. Kept beside
 * BUILTIN_PROFILES so both halves of a legal projectType value come from one
 * source instead of being restated per consumer, where they would drift.
 */
export const PROJECT_KINDS = ['fullstack', 'system-of-systems', 'monorepo'] as const;

/**
 * A profile id — one of BUILTIN_PROFILES or a pack-registered name (open
 * string; UNKNOWN_PROFILE flags anything unregistered).
 */
export type ArchProfile = string;

export interface RuleContext {
  system: SystemSpec;
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];

  rules?: RulesConfig;
  projectType: string;
  scopeSubsystem?: string;

  componentMap: Map<string, ComponentSpec>;
  interfaceMap: Map<string, InterfaceSpec>;
  subsystemIds: Set<string>;
  componentIds: Set<string>;
  interfaceIds: Set<string>;
  /** Per-subsystem published component ids (its public surface). */
  publicSet: Map<string, Set<string>>;
  /** Interfaces grouped by owning component id — the shared read path for a component's contract methods (rules and the reachability walker must agree on this enumeration). */
  interfacesByComponent: Map<string, InterfaceSpec[]>;
  /** Stored surface snapshots (.wai/surfaces/) — declared contracts that unresolved cross-tree/remote references validate against. */
  surfaceSnapshots: SurfaceSnapshot[];
  /**
   * The snapshots each chained mount holds in its own `.wai/surfaces/`, keyed
   * by mount namespace. Consulted ONLY for references made from inside that
   * mount — never pooled into `surfaceSnapshots`, so a contract a child
   * imported can never decide the bound root's own references.
   */
  mountSurfaceSnapshots: MountSurfaceSnapshots[];
  /**
   * The pure source-code model (per-sourcePath declaration/export/import/
   * anchor facts) built by the source analysis adapter — what the
   * structural-conformance family checks realization against. Empty when the
   * context was built without one (the family then only reports missing
   * sourcePaths, never file-level findings).
   */
  codeModel: CodeModel;
  /** Implementations grouped by their contract interface id. */
  implementationsByContract: Map<string, ImplementationSpec[]>;

  /** True when the spec (or its ancestors) is in draft/design status. */
  isComponentDraft(compId: string): boolean;
  /** True when the implementation, its contract, or the contract's component is in draft/design status — the shared draft recipe for implementation-scoped findings. */
  isImplementationDraft(impl: ImplementationSpec): boolean;
  /** The architectural profile governing a component (subsystem override, else project type). */
  getComponentProfile(compId: string): ArchProfile;
  /** Whether a type reference resolves against builtins, generics, or defined types. */
  isTypeResolved(ref: string, generics: Set<string>): boolean;
  /** Effective target language for a subsystem (subsystem override, else system), lowercase, or undefined. */
  targetLanguageFor(subsystemId: string | undefined): string | undefined;
  /** Scope filter for granular (per-subsystem) validation. */
  isSpecInScope(specId: string): boolean;

  /**
   * Extension-pack data (empty when no packs are loaded): pack-registered
   * profiles, language/platform tables, and reusable pattern definitions.
   * Rules merge these over their built-in tables and resolve spec references
   * (component.patterns) against ext.patterns.
   */
  ext: {
    profiles: Record<string, ProfileDef>;
    languages: Record<string, LanguagePackDef>;
    patterns: LoadedPattern[];
    /** Pack-declared semantic guarantee tokens — unioned with SEMANTIC_GUARANTEES by the guarantee-token rule. */
    guarantees: string[];
    /** Declarative rule assertions (closed kinds, pack-instantiated) evaluated by the declarative-assertions rule. */
    assertions: LoadedAssertion[];
    /**
     * The project's by-name pack SELECTIONS (legacy path refs excluded). The
     * reproducibility rule checks these for a version/integrity pin, since a
     * floating selection resolved off a mutable machine store is exactly what
     * `enforceReproducibility` exists to prevent.
     */
    packSelections: PackSelection[];
    /**
     * Declared selections that could not be resolved, each carrying the code the
     * pack-resolution rule reports it under. Resolution itself happens in the
     * extension loader (bundle first, then the store), so the rule surfaces what
     * the loader found rather than deciding again — the two can never disagree
     * about whether a pack applies.
     */
    selectionFailures: PackSelectionFailure[];
  };

  /**
   * Component-variant registry (the dynamic layer on top of packs; empty when
   * none): the resolution set for component.variant references — each a
   * base-anchored specialization carrying implementation guidance.
   */
  variants: VariantDef[];

  /**
   * Bookkeeping for per-spec lint suppressions (lint.allow). Suppression
   * itself happens inside addIssue (warnings only — errors always surface);
   * the lint-allows rule audits these entries at the end of the run.
   */
  lintAllows: { specId: string; code: string; reason: string; used: boolean }[];
  /** Every issue code any registered rule can emit (for allow validation). */
  knownIssueCodes: Set<string>;

  /**
   * Report an issue. Applies scope filtering, user severity overrides
   * (rules.sddRuleSeverity), and draft-context downgrades for completeness
   * rules. 'off' suppresses the issue entirely.
   *
   * `surfaceResolved` marks a finding whose reference DID resolve against a
   * vendored surface snapshot — a genuine contract/boundary verdict rather
   * than a resolution failure, so the chained-subproject pass never replaces
   * it with UNVERIFIED_EXTERNAL_REF.
   */
  addIssue(
    defaultSeverity: Severity,
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean,
    surfaceResolved?: boolean,
  ): void;
}

/**
 * How much of the tree a rule must see to reach its verdict.
 *
 * - `'tree'` (the default) — the check reads relationships BETWEEN specs: a
 *   component's interfaces, narrative reachability, the dependency graph. It is
 *   only meaningful against a fully loaded tree.
 * - `'spec'` — the check reads nothing but each spec's OWN fields, so it is a
 *   pure function of one spec. That is what lets it also run against a
 *   CANDIDATE spec BEFORE the write (see rules/candidate.ts), turning what
 *   would otherwise be a permanent validate-time error into a refused write
 *   with the same code and message.
 *
 * A rule that mixes the two belongs SPLIT in two, so the intrinsic half can
 * reach the write boundary — see portalFieldsRule/portalsRule and
 * durabilityDeclarationRule/durabilityRule.
 */
export type RuleScope = 'spec' | 'tree';

export interface SddRule {
  /** Stable rule id (kebab-case), e.g. "stereotype-dependencies". */
  name: string;
  /** One-paragraph description of what the rule enforces and why. */
  description: string;
  /**
   * What the check needs to see (see RuleScope). Defaults to 'tree' — the
   * conservative answer, since a rule that has not declared itself intrinsic
   * must never be handed a one-spec context.
   */
  scope?: RuleScope;
  /** Every issue code this rule can emit, with default severity and summary. */
  codes: RuleCode[];
  check(ctx: RuleContext): void;
}

/** The surface snapshots one chained mount holds, keyed by the mount's namespace. */
export interface MountSurfaceSnapshots {
  namespace: string;
  snapshots: SurfaceSnapshot[];
}
