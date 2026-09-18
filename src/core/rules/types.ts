import {
  SystemSpec,
  SubsystemSpec,
  ComponentSpec,
  InterfaceSpec,
  ImplementationSpec,
  TypeSpec,
  RulesConfig,
  SurfaceSnapshot,
  MethodSignature,
  ComplexityRuleConfig,
  DocumentationRuleConfig,
  NamingRuleConfig,
  CodeModel,
  SourceFileFacts,
  SurfaceRefResolution,
} from '../../models/index.js';
import type { ProfileDef, LanguagePackDef, LoadedPattern, LoadedAssertion } from '../extensions.js';
import type { VariantDef } from '../variants.js';
import type { PackSelection } from '../../models/project.js';
import type { PackSelectionFailure } from '../extensions.js';
import type { ValidationIssue } from '../validation.js';

// ---------------------------------------------------------------------------
// Rule registry contracts
//
// Every SDD conformance check is an SddRule: a named, documented unit with the
// issue codes it can emit and a check(ctx) over the shared RuleContext. The
// rule repository (rules/repository.ts) holds them in run order; severity
// resolution (user overrides + draft-context downgrades) is centralized in
// ctx.addIssue.
//
// This is the "custom linter" foundation: adding a rule is a new module in its
// family's folder plus a registry entry — no surgery on a monolith.
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

/**
 * code_index — the run's source-code model keyed for lookup: every analyzed
 * path's facts and the three anchor tiers a realization check reads. Eight
 * rules used to rebuild this map (with subtly different shapes) for
 * themselves; it is built once per run behind `ctx.codeIndex()`.
 */
export interface CodeIndex {
  /** Every canonical path the model holds — the closed set import specifiers resolve against. */
  paths: Set<string>;
  /** The paths analyzed at exact AST grade: the only files an import graph may accuse from, or a measured function be read in. */
  exactPaths: Set<string>;
  /** The analysis facts for a path, by its canonical key. */
  factsAt(path: string): SourceFileFacts | undefined;
  /** Declaration-tier anchors: the file's declared and exported names. */
  declarationsAt(path: string): ReadonlySet<string>;
  /** Anchored-tier anchors: the declarations together with the weak anchors. */
  anchorsAt(path: string): ReadonlySet<string>;
  /** The weak anchors alone — string literals and property-access names — which is where a declared finding code must appear. */
  findingAnchorsAt(path: string): ReadonlySet<string>;
}

/**
 * realization_index — which source files realize which components, both ways,
 * from ONE walk of the implementations whose contract and component resolve
 * and that do not sit in a chained subproject. The relation is unfiltered:
 * which files may accuse (exact grade) or count as present (analyzed or
 * unreadable) is the reading rule's doctrine, not the relation's.
 */
export interface RealizationIndex {
  /** Every file those implementations name, canonical keys, in the order they were first named. */
  paths: string[];
  /** The implementations realizing a component, in load order. */
  implementationsOf(compId: string): ImplementationSpec[];
  /** The implementations naming a file — N:1 sharing made readable, and the anchor a file-level finding takes. */
  implementationsAt(path: string): ImplementationSpec[];
  /** The files a component's implementations name, in declaration order. */
  filesOf(compId: string): string[];
  /** The files named across a whole subsystem — what a cross-subsystem hop is proven against, the published barrel being cosmetic at runtime. */
  filesIn(subsystemId: string): string[];
  /** The components a file realizes, in the order their implementations named it. */
  componentsAt(path: string): ComponentSpec[];
}

/**
 * import_graph — the resolved import graph over a CLOSED set of source paths.
 * Resolution is pure string matching against that set, so the set is part of
 * the graph's identity. Runtime imports are collaboration; export-from
 * re-exports are surface republication — together they are a file's TRACES,
 * never an accusation on their own but enough to realize a declared edge.
 */
export interface ImportGraph {
  /** The closed set this graph resolves against, in construction order. */
  paths: string[];
  /** A file's resolved runtime-import targets, itself excluded. */
  importsOf(path: string): ReadonlySet<string>;
  /** Its imports together with its resolved re-export targets. */
  tracesOf(path: string): ReadonlySet<string>;
  /** Whether any trace runs from one file set into the other — or, when the reverse is allowed (the mounting shape), back the other way. */
  connects(from: Iterable<string>, to: Iterable<string>, allowReverse: boolean): boolean;
  /** Every path reachable from a file by following traces transitively, the file included; traversal stops at a file the run did not analyze. */
  reachFrom(path: string): Set<string>;
}

/**
 * Where a dependsOn edge lands, decided once per edge so the rules that judge
 * it never re-derive it. The six answers are exhaustive: a ref either names a
 * component in this tree (`internal` when it shares the source's subsystem,
 * `cross-subsystem` when it does not), or it leaves the tree and a vendored
 * surface snapshot declares it (`surface`) or several providers' snapshots
 * disagree about it (`ambiguous`), or nothing declares it — `unpinned` when it
 * was authored to leave this root, `missing` when it is a local typo.
 */
export type EdgeReach =
  | 'internal'
  | 'cross-subsystem'
  | 'surface'
  | 'ambiguous'
  | 'unpinned'
  | 'missing';

/**
 * dependency_edge — one dependsOn edge, resolved: what declares it, what it
 * names, what that reached, and the verdicts every consumer would otherwise
 * re-derive (retirement, draft context, pack licensing).
 */
export interface DependencyEdge {
  /** The component whose dependsOn declares the edge. */
  from: ComponentSpec;
  /** The dependency id exactly as the spec names it. */
  ref: string;
  /** Where the ref lands (see EdgeReach). */
  reach: EdgeReach;
  /** The component the ref names in this tree — set for an `internal` or `cross-subsystem` edge only. */
  to?: ComponentSpec;
  /** What the surface snapshots answered — set for a `surface` or `ambiguous` edge only, and then always carrying that kind. */
  surface?: SurfaceRefResolution;
  /**
   * Either end is a retired stereotype, so no boundary or matrix rule judges
   * the edge: retired-stereotypes reports the component once, and its
   * migration decides what the edge becomes. Never set on an edge that
   * resolved nothing — a reference finding stands whatever declares it.
   */
  retired: boolean;
  /** The draft context a finding on this edge takes: the source's, and the target's too once the target resolves. */
  draftContext: boolean;
  /**
   * The governing pack profile's `allowedEdges` licenses this stereotype pair
   * — the platform's own idiom, declared with a reason. It is carried on the
   * edge because the matrix is five rules: repeated per rule, a licensed edge
   * would escape some of them and not others.
   */
  licensed: boolean;
}

/**
 * dependency_edges — every dependsOn edge in the tree, resolved once per run
 * behind rule_context.dependencyEdges. Five doctrine rules judge these edges,
 * and each of them used to re-pay the same prologue before it could judge
 * anything: walk the components, walk their dependsOn, resolve the id, decide
 * what an unresolved one means, skip an edge with a retired end, tell an
 * intra-subsystem edge from a boundary crossing, and let the governing pack
 * profile license the pair. That prologue is the edge.
 */
export interface DependencyEdges {
  /** Every edge, in component order then declaration order — the ones that reached nothing included. */
  all: DependencyEdge[];
  /** The edges the intra-subsystem stereotype matrix judges: resolved inside one subsystem, both ends live, unlicensed. Their target always resolved. */
  matrix: (DependencyEdge & { to: ComponentSpec })[];
}

/**
 * ownership_index — which pattern privately owns each member block, the tree's
 * ONE ownership reading. The skips are semantics, not shortcuts: see
 * buildOwnershipIndex for which claims record an owner and which do not.
 */
export interface OwnershipIndex {
  /** The member blocks a legal claim was made on — the domain of ownerOf; a block outside it is a facade or standalone. */
  ownedMembers: Set<string>;
  /** The pattern that owns a member block, or none when no legal claim was made on it. */
  ownerOf(memberId: string): string | undefined;
}

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
   * Level 1 conformance rules check realization against. Empty when the
   * context was built without one (the family then only reports missing
   * sourcePaths, never file-level findings).
   */
  codeModel: CodeModel;
  /** Implementations grouped by their contract interface id. */
  implementationsByContract: Map<string, ImplementationSpec[]>;
  /**
   * The writer's round-trip dry-run findings for every in-scope spec, gathered
   * by the validator before the rules run, so the roundtrip-serialization rule
   * reports them without doing I/O.
   */
  roundTripIssues: ValidationIssue[];

  /** True when the spec (or its ancestors) is in draft/design status. */
  isComponentDraft(compId: string): boolean;
  /** True when the implementation, its contract, or the contract's component is in draft/design status — the shared draft recipe for implementation-scoped findings. */
  isImplementationDraft(impl: ImplementationSpec): boolean;
  /** The architectural profile governing a component (subsystem override, else project type). */
  getComponentProfile(compId: string): ArchProfile;
  /** Whether a type reference resolves against builtins, generics, or defined types. */
  isTypeResolved(ref: string, generics: Set<string>): boolean;
  /** Effective target language for a subsystem (subsystem override, else system), normalized to the language-table key, or undefined. */
  targetLanguageFor(subsystemId: string | undefined): string | undefined;
  /** Scope filter for granular (per-subsystem) validation. */
  isSpecInScope(specId: string): boolean;
  /**
   * True when the subsystem sits inside a chained mount: some prefix of its
   * qualified id is a subsystem carrying `projectPath`. Conformance skips such
   * specs — their sourcePaths are relative to the child project's root, and
   * the child validates them standalone in its own run.
   */
  isInChainedSubproject(subsystemId: string): boolean;
  /**
   * True when an unresolved reference points OUTSIDE the current loading root,
   * rather than being a genuine local typo — so it warrants the softer
   * CROSS_TREE_REF_UNRESOLVED warning ("validate from the parent project")
   * instead of a hard "does not exist" error. Two shapes qualify:
   *  - an explicit relative form (`::x` / `super::x`), and
   *  - a qualified id whose leading namespace segment is not a subsystem in THIS
   *    tree — e.g. `waffler_core::blueprints-portal` authored from a parent root,
   *    where `waffler_core` is absent when the same specs are validated from the
   *    child subproject's own directory.
   */
  isExternalNamespaceRef(ref: string): boolean;
  /**
   * True when an unresolved reference made from inside a chained mount was
   * authored in a cross-tree form that the loader collapsed at THIS root: made
   * from inside mount M and not under `M::`, so it was authored to leave M. This
   * only licenses consulting the snapshots M holds; a reference they do not
   * cover is judged exactly as it was before.
   */
  isCollapsedCrossTreeRef(ref: string, fromSubsystem: string): boolean;
  /**
   * Resolve a cross-tree reference against the stored surface snapshots,
   * matched by provider. The final segment is the local name, matched against
   * each snapshot's exported entry ids and backing component names; the segment
   * before it, when there is one, names the provider, and only that provider's
   * snapshots are consulted. The snapshots of the mounts enclosing
   * `fromSubsystem` come first, nearest mount first, then the bound root's own;
   * the first pool with matches decides, and matches that disagree on the
   * contract make the reference ambiguous.
   */
  resolveSurfaceRef(ref: string, fromSubsystem?: string): SurfaceRefResolution;
  /** Every contract method across the component's interfaces (memoized — eight rules ask per binding or per step). */
  interfaceMethodsOf(compId: string): MethodSignature[];
  /** The run's source-code model keyed for lookup (memoized). */
  codeIndex(): CodeIndex;
  /** Which files realize which components, both ways (memoized). */
  realizationIndex(): RealizationIndex;
  /** The import graph over a closed set of paths — every path the run analyzed when none is given (memoized per set). */
  importGraph(paths?: Set<string>): ImportGraph;
  /** Which pattern privately owns each member block (memoized). */
  ownershipIndex(): OwnershipIndex;
  /** Every dependsOn edge in the tree, resolved (memoized). */
  dependencyEdges(): DependencyEdges;
  /** The complexity rule config in force for a subsystem: the project's, overlaid with its profile pack's when the pack sets one. */
  complexityConfigFor(subsystemId?: string): ComplexityRuleConfig | undefined;
  /** The documentation rule config in force for a subsystem: the project's, overlaid with its profile pack's when the pack sets one. */
  documentationConfigFor(subsystemId?: string): DocumentationRuleConfig | undefined;
  /** The naming rule config in force for a subsystem: the project's, overlaid with its profile pack's when the pack sets one, stereotype patterns merged key by key. */
  namingConfigFor(subsystemId?: string): NamingRuleConfig | undefined;
  /** Whether a type identifier is in the language-agnostic builtin vocabulary, compared ignoring case. */
  isBuiltinType(ref: string): boolean;

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
    /** Declarative rule assertions (closed kinds, pack-instantiated), evaluated by one assertion-* rule per kind. */
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
  /** Every issue code a registered rule or loaded declarative assertion can emit, gathered by the validator (for allow validation). */
  knownIssueCodes: Set<string>;

  /**
   * Report an issue. Applies scope filtering, user severity overrides
   * (rules.sddRuleSeverity), and draft-context downgrades for completeness
   * rules. 'off' suppresses the issue entirely.
   *
   * `surfaceResolved` marks a finding whose reference DID resolve against a
   * vendored surface snapshot — a genuine contract/boundary verdict rather
   * than a resolution failure, so it keeps full strength in a chained
   * subproject.
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
  /** Stable rule id (kebab-case), e.g. "subsystem-boundary-dependencies". */
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
