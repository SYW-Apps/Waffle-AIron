import {
  SystemSpec,
  SubsystemSpec,
  ComponentSpec,
  InterfaceSpec,
  ImplementationSpec,
  TypeSpec,
  RulesConfig,
} from '../../models/index.js';

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

export type ArchProfile =
  | 'backend'
  | 'frontend-reactive'
  | 'frontend-controller'
  | 'lowlevel-os'
  | 'game-ecs'
  | 'realtime-embedded'
  | 'plc-cyclic';

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

  /** True when the spec (or its ancestors) is in draft/design status. */
  isComponentDraft(compId: string): boolean;
  /** The architectural profile governing a component (subsystem override, else project type). */
  getComponentProfile(compId: string): ArchProfile;
  /** Whether a type reference resolves against builtins, generics, or defined types. */
  isTypeResolved(ref: string, generics: Set<string>): boolean;
  /** Effective target language for a subsystem (subsystem override, else system), lowercase, or undefined. */
  targetLanguageFor(subsystemId: string | undefined): string | undefined;
  /** Scope filter for granular (per-subsystem) validation. */
  isSpecInScope(specId: string): boolean;

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
   */
  addIssue(
    defaultSeverity: Severity,
    code: string,
    message: string,
    specId?: string,
    isDraftContext?: boolean,
  ): void;
}

export interface SddRule {
  /** Stable rule id (kebab-case), e.g. "stereotype-dependencies". */
  name: string;
  /** One-paragraph description of what the rule enforces and why. */
  description: string;
  /** Every issue code this rule can emit, with default severity and summary. */
  codes: RuleCode[];
  check(ctx: RuleContext): void;
}
