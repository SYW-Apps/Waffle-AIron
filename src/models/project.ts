import { z } from 'zod';
import { CustomTargetSchema } from './agent.js';
import { ExecutionConfigSchema } from './execution.js';

// ---------------------------------------------------------------------------
// Project configuration — lives at .wai/project.yaml
//
// This is the primary project-level config. It is human-edited and defines
// which output targets are active, project metadata, and high-level rules.
// ---------------------------------------------------------------------------

export const BuiltinTargetConfigSchema = z.object({
  type: z.enum(['claude', 'gemini', 'agy', 'cursor', 'copilot', 'codex']),
  /** Output directory for generated agent files, relative to project root */
  outputDir: z.string(),
  /** Whether this target is active */
  enabled: z.boolean().default(true),
});
export type BuiltinTargetConfig = z.infer<typeof BuiltinTargetConfigSchema>;

export const CustomTargetConfigSchema = CustomTargetSchema.extend({
  enabled: z.boolean().default(true),
});
export type CustomTargetConfig = z.infer<typeof CustomTargetConfigSchema>;

export const TargetConfigSchema = z.union([BuiltinTargetConfigSchema, CustomTargetConfigSchema]);
export type TargetConfig = z.infer<typeof TargetConfigSchema>;

export const NamingRuleConfigSchema = z.object({
  /** Casing style or regular expression for subsystem names/IDs */
  subsystems: z.string().optional(),
  /** Casing style or regular expression for component names/IDs */
  components: z.string().optional(),
  /** Casing style or regular expression for interface names/IDs */
  interfaces: z.string().optional(),
  /** Casing style or regular expression for general type names/IDs */
  types: z.string().optional(),
  /** Casing style or regular expression for entity type names/IDs */
  entities: z.string().optional(),
  /** Casing style or regular expression for value-object type names/IDs */
  valueObjects: z.string().optional(),
  /** Casing style or regular expression for interface/implementation/type method names */
  methods: z.string().optional(),
  /** Casing style or regular expression for general type fields */
  fields: z.string().optional(),
  /** Casing style or regular expression for constants/enum variants */
  constants: z.string().optional(),
  /** Casing style or regular expression for parameters/variables */
  variables: z.string().optional(),
  /** Stereotype-specific naming rules (prefixes, suffixes, regexes) */
  stereotypes: z.record(z.object({
    match: z.enum(['id', 'name', 'both']).default('both'),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    regex: z.string().optional(),
  })).optional(),
});
export type NamingRuleConfig = z.infer<typeof NamingRuleConfigSchema>;

export const DocumentationRuleConfigSchema = z.object({
  /** Minimum character length for description fields */
  minDescriptionLength: z.number().int().nonnegative().optional(),
  /** Force subsystem, component, interface, and type specs to have non-empty descriptions */
  requireDescriptions: z.boolean().optional(),
  /** Force interface and type methods to have non-empty descriptions */
  requireMethodDescriptions: z.boolean().optional(),
  /** Force type fields to have non-empty descriptions */
  requireFieldDescriptions: z.boolean().optional(),
});
export type DocumentationRuleConfig = z.infer<typeof DocumentationRuleConfigSchema>;

export const ComplexityRuleConfigSchema = z.object({
  /** Maximum number of parameters allowed on a single interface method */
  maxMethodParams: z.number().int().nonnegative().optional(),
  /** Maximum number of methods allowed on a single interface contract */
  maxInterfaceMethods: z.number().int().nonnegative().optional(),
  /** Maximum number of dependencies allowed on a single component */
  maxComponentDependencies: z.number().int().nonnegative().optional(),
  /**
   * Maximum number of narrative steps allowed in a single method
   * implementation, reported as a warning. The narrative-complexity rule
   * applies a default of 25 when this is unset — the default belongs to the
   * rule, not this schema.
   */
  maxNarrativeSteps: z.number().int().nonnegative().optional(),
  /** Maximum number of direct components allowed in a single subsystem */
  maxSubsystemComponents: z.number().int().nonnegative().optional(),
  /**
   * Maximum cyclomatic complexity a realized function may measure (exact AST
   * grade) while its method's narrative detail sits below `full` with no
   * narrative — above it the detail-sufficiency lint fires
   * (UNNARRATED_COMPLEXITY). Default 8 when unset.
   */
  maxUnnarratedComplexity: z.number().int().nonnegative().optional(),
  /**
   * Step count above which a narrative is an error rather than a warning. No
   * default: unset means the step count only ever warns.
   */
  narrativeStepsHardMax: z.number().int().nonnegative().optional(),
  /**
   * The complexity band (linear | simple | moderate | complex | severe) a
   * narrative may reach before it warns. Defaults to moderate when unset, so
   * complex and severe warn.
   */
  cognitiveWarnAbove: z.string().optional(),
  /**
   * The complexity band above which a narrative is an error rather than a
   * warning. No default: unset means the cognitive band only ever warns.
   */
  maxCognitiveLevel: z.string().optional(),
});
export type ComplexityRuleConfig = z.infer<typeof ComplexityRuleConfigSchema>;

/**
 * Where this project's own source code lives, and what of it no spec claims
 * yet. Declaring a source root is what OPTS a project into the
 * unclaimed-source check: with no root the walk finds nothing and the check is
 * silent, so upgrading wairon never floods an existing project.
 *
 * `unclaimed` is a one-way debt register, not a suppression. A lint.allow
 * hides one finding behind one spec, forever, and is read only by whoever
 * opens that spec; this list is the WHOLE debt in one reviewable place, it
 * can only be shortened (an entry the walk no longer finds unclaimed is
 * STALE_UNCLAIMED_ENTRY), and a file that is neither claimed nor listed is
 * reported. That is what makes "the list cannot grow silently" a property
 * rather than a hope.
 */
/**
 * Why a conformance finding is carried instead of fixed. A register that
 * records only WHAT it holds is a suppression list with extra steps; the kind
 * is what lets a reader tell debt to pay from a limit to live with, and it is
 * required for exactly that reason.
 *
 *  - `drift`      the spec and the code genuinely disagree, and an author
 *                 fixes one of them. Debt, and whose it is is known.
 *  - `undecided`  the finding is right and the fix waits on a modelling
 *                 decision nobody has taken. Debt, but a decision comes first.
 *  - `unreadable` the analysis cannot follow the shape the code is written in,
 *                 so it reports what it did not check. Nothing in this tree is
 *                 wrong: a limit, until the reader learns the shape.
 */
export const CarriedDebtKindSchema = z.enum(['drift', 'undecided', 'unreadable']);
export type CarriedDebtKind = z.infer<typeof CarriedDebtKindSchema>;

/**
 * One carried finding, named precisely enough that the register can only hold
 * what would otherwise fire — and, crucially, precisely enough that a finding
 * which AGGREGATES cannot grow behind it.
 */
export const CarriedFindingSchema = z.object({
  /** The issue code, which must be one a rule declares CARRYABLE — anything else is UNCARRYABLE_FINDING, an error. */
  code: z.string(),
  /** The spec the finding is anchored to. */
  spec: z.string(),
  /** The site inside that spec the finding names — for the code-vs-spec call checks, the contract method. */
  at: z.string(),
  /**
   * The units an aggregating finding covers: the crossings of one
   * UNDECLARED_COLOCATED_CALL, the steps of one CALL_STEP_UNREALIZED. Keyed by
   * code + spec + site ALONE, a 24th crossing added to a finding that already
   * lists 23 would be carried by an entry nobody wrote for it — so a live
   * finding is carried only when every unit it reports is listed here, and a
   * unit that appears is reported as new.
   */
  covers: z.array(z.string()).optional(),
});
export type CarriedFinding = z.infer<typeof CarriedFindingSchema>;

/**
 * One REASON, and the conformance findings it explains. The grouping is the
 * point: the same fact usually produces many findings (one file modelled as
 * five components produces a crossing per method), and a reason restated per
 * finding is prose that rots in N places instead of one.
 */
export const CarriedDebtSchema = z.object({
  /** Which of the three kinds this reason is (see CarriedDebtKindSchema). */
  kind: CarriedDebtKindSchema,
  /** The reason itself, in the author's own words — what is true here, and what paying it would take. */
  why: z.string().min(1),
  /** The findings this reason explains. */
  findings: z.array(CarriedFindingSchema),
});
export type CarriedDebt = z.infer<typeof CarriedDebtSchema>;

export const ConformanceRuleConfigSchema = z.object({
  /**
   * Project-relative paths holding this project's own source code; a
   * directory is walked recursively, a file names itself. Absolute or
   * parent-escaping entries are refused by containment, exactly as a
   * sourcePath is.
   */
  sourceRoots: z.array(z.string()).optional(),
  /**
   * Paths inside a source root that are not this project's code to claim —
   * vendored libraries, generated output, a chained subproject's own
   * directory (the child claims its files in its own run). A file at, or
   * under, one of these is never walked, so it is neither reported nor
   * carried as debt.
   */
  exclude: z.array(z.string()).optional(),
  /**
   * The files under the source roots that no spec names yet, frozen. A listed
   * file is not reported; an unlisted one is UNCLAIMED_SOURCE_FILE; an entry
   * that is now claimed, proven a barrel, or no longer found is
   * STALE_UNCLAIMED_ENTRY.
   */
  unclaimed: z.array(z.string()).optional(),
  /**
   * The conformance findings this tree carries as declared debt, grouped by
   * the reason that explains them — `unclaimed`'s shape, for findings about
   * code a spec DOES claim.
   *
   * It is not a second lint.allow, and the difference is the claim each makes.
   * An allow says "this finding is wrong here, by design", and is meant to
   * live forever; an entry here says "this finding is RIGHT, and it is not
   * paid yet". A mechanism that cannot tell those apart can never be asked how
   * much the tree owes. Four properties keep it a register:
   *   • only a code a rule declares CARRYABLE may appear (UNCARRYABLE_FINDING,
   *     an error, which no allow and no --ci waiver can reach);
   *   • an entry carries a finding only when it lists EVERY unit that finding
   *     reports, so an aggregating finding cannot grow behind it;
   *   • an entry that stops applying — gone, or listing a unit no longer
   *     reported — is STALE_CARRIED_FINDING, so the register only shrinks;
   *   • every entry states its kind and its reason, and `wairon validate`
   *     prints the running total, so the debt is loud where a suppression is
   *     silent.
   */
  carried: z.array(CarriedDebtSchema).optional(),
});
export type ConformanceRuleConfig = z.infer<typeof ConformanceRuleConfigSchema>;

/**
 * How deep this project (or subsystem, or pack profile) commits to DESIGNING.
 * The validator gates EXPECTATION checks by depth — nothing below the declared
 * depth is demanded to exist (no missing-narrative/-implementation/-endpoint
 * findings, no reachability walk that would need narrative edges) — while
 * SOUNDNESS checks always apply to whatever IS authored (a malformed narrative
 * errors even at designDepth: interfaces). Default is `narratives` (full
 * depth): shallower depth is a per-team choice, never the tool's default.
 * Resolution: subsystem.designDepth → project rules.designDepth → the
 * subsystem's pack-profile designDepth → narratives.
 */
export const DesignDepthSchema = z.enum(['components', 'interfaces', 'implementations', 'narratives']);
export type DesignDepth = z.infer<typeof DesignDepthSchema>;

export const RulesConfigSchema = z.object({
  /**
   * Prevent two agents from declaring overlapping ownedPaths.
   * Strongly recommended: true.
   */
  noOverlappingOwnership: z.boolean().default(true),

  /**
   * Require every non-meta agent to have at least one ownedPath.
   */
  requireOwnedPaths: z.boolean().default(true),

  /**
   * Tags that mark an agent as a meta/guardian agent — exempt from
   * requireOwnedPaths.
   */
  metaAgentTags: z.array(z.string()).default(['meta', 'guardian', 'architect']),

  /**
   * Generated outputs should exactly reproduce from the registry.
   * Warn if generated files differ from what the registry would produce.
   */
  enforceReproducibility: z.boolean().default(true),

  /**
   * Whether to generate an individual implementer agent PER COMPONENT. Off by
   * default: one subsystem-owner agent per subsystem owns its components'
   * implementations, which keeps the generated topology (and the per-session
   * agent context every session loads) proportional to the number of
   * subsystems, not components. A large project or subproject with `true` can
   * emit thousands of agents — reserve it for small trees that genuinely want
   * per-component isolation.
   */
  generateComponentImplementers: z.boolean().default(false),

  /**
   * Whether `wairon generate` writes per-subsystem owner/architect agent FILES.
   * Off by default: agents are served as LIVE briefs (sdd_get_agent_brief /
   * wairon-agent://), and files are merely the opt-in materialized view of the
   * same briefs. When off, generate reconciles to zero agent files — leftover
   * wairon-managed files are removed (hand-authored files never are).
   */
  materializeAgentFiles: z.boolean().default(false),

  /**
   * Severity overrides for SDD validation rules.
   * Key: rule code (e.g. CIRCULAR_DEPENDENCY), Value: error | warning | off
   */
  sddRuleSeverity: z.record(z.enum(['error', 'warning', 'off'])).default({}),

  /** Dynamic naming conventions and stereotype suffix rules */
  naming: NamingRuleConfigSchema.optional(),

  /** Dynamic metadata documentation constraints */
  documentation: DocumentationRuleConfigSchema.optional(),

  /** Dynamic structural complexity caps (method limit, step limit, dependency limit) */
  complexity: ComplexityRuleConfigSchema.optional(),

  /** Where this project's own source lives and what of it no spec claims yet (see ConformanceRuleConfigSchema) */
  conformance: ConformanceRuleConfigSchema.optional(),

  /** Project-default design depth (see DesignDepthSchema); subsystems may override. */
  designDepth: DesignDepthSchema.optional(),
});

export type RulesConfig = z.infer<typeof RulesConfigSchema>;

export const PathsConfigSchema = z.object({
  /** Base directory containing SDD specification files, relative to project root */
  specsDir: z.string().default('.wai/specs'),
});
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

/**
 * A pack SELECTION: the project states which pack it applies, by name, and the
 * pack itself lives in the committed bundle or this wairon install's store.
 *
 * This is the separation the old `--global` install never made: installing a pack
 * on a machine must not grant it authority over every project there, because then
 * the gate differs per developer and CI disagrees with every local run. A project
 * declares its doctrine; the machine merely has it available.
 *
 * See docs/design/pack-scoping.md.
 */
export const PackSelectionSchema = z.object({
  /** The pack name — the only required field. */
  name: z.string().min(1),
  /** Exact version pin. Omitted = the latest version installed in the store. */
  version: z.string().min(1).optional(),
  /** Content digest pin (`sha256-…`), verified on resolution. */
  integrity: z.string().min(1).optional(),
  /**
   * Where to obtain this pack — recorded automatically from the store's install
   * record at selection time, so a fresh machine or CI runner can fetch it
   * (`wairon pack sync`). Supports a `{version}` placeholder and `${VAR}` env
   * expansion for private URLs.
   */
  source: z.string().min(1).optional(),
  /**
   * Commit a copy under `.wai/packs/<name>/<version>/` and resolve from there
   * first, so the project needs no machine setup at all — the answer for private
   * packs, air-gapped CI, and repos that must be self-sufficient.
   */
  bundle: z.boolean().optional(),
});
export type PackSelection = z.infer<typeof PackSelectionSchema>;

/**
 * The identity a profile selection was made by — structurally the hosting
 * layer's PrincipalSubject, modeled here because project.yaml is core's file.
 */
export const ProfileSelectionSubjectSchema = z.object({
  userId: z.string(),
  kind: z.string(),
  issuer: z.string(),
  externalSubject: z.string().optional(),
  displayName: z.string().optional(),
  email: z.string().optional(),
});

/**
 * The profile/pack selection applied to a project by a hosted policy workflow
 * (initialization, an explicit profile write, or reconciliation).
 *
 * Modeled here rather than left as an un-schema'd key because the config is
 * parsed and written back through this schema: an unmodeled key is STRIPPED on
 * the round trip, so a later pack install or removal silently erased the
 * recorded selection. `projectType` is what actually governs validation; this is
 * the record of what was chosen for the project.
 */
export const ProjectProfileSelectionSchema = z.object({
  /** Selected architectural profile ids. The first resolvable one is applied as projectType. */
  profileIds: z.array(z.string()).default([]),
  /** Pack names the governing policy requires for this project. */
  requiredPackNames: z.array(z.string()).default([]),
  /** Pack names applied by default unless explicitly overridden. */
  defaultPackNames: z.array(z.string()).optional(),
  selectedBy: ProfileSelectionSubjectSchema.optional(),
  selectedAt: z.string(),
});
export type ProjectProfileSelection = z.infer<typeof ProjectProfileSelectionSchema>;

export const ProjectConfigSchema = z.object({
  /**
   * Schema version — used to detect incompatible config formats in future
   * CLI versions.
   */
  schemaVersion: z.string().default('1.0.0'),

  /** Human-readable project name */
  name: z.string(),

  /**
   * The type/profile of the project, which configures targeted guidelines, rules,
   * templates, and validation constraints. Open string: built-ins are backend,
   * frontend-reactive, frontend-controller, lowlevel-os, game-ecs,
   * realtime-embedded, plc-cyclic, fullstack, system-of-systems, monorepo;
   * extension packs may register more (unknown names get UNKNOWN_PROFILE).
   */
  projectType: z.string().default('backend'),

  /** Optional short description of this project */
  description: z.string().optional(),

  /**
   * Active output targets. At least one must be enabled.
   * Configured during `wairon init` and editable afterward.
   */
  targets: z.array(TargetConfigSchema).default([]),

  rules: RulesConfigSchema.default({}),

  /**
   * Execution budgets — the RESOURCE axis of the derived topology. Controls
   * whether generated agent files carry model/effort/turn/tool constraints in
   * addition to their authority scope.
   *
   * Defaults to tier `off`, so adding this feature changes no existing
   * project's generated output until it is deliberately turned on.
   */
  execution: ExecutionConfigSchema.default({ tier: 'off', overrides: {} }),

  /**
   * Extension packs — wairon's plugin surface. Each entry is a relative path
   * to a declarative YAML pack (custom profiles + language/platform tables)
   * or a requireable JS module id (which may also inject SddRule[] `rules`).
   * Loaded identically by CLI and MCP at validation time.
   */
  extensions: z.object({
    /**
     * The packs this project APPLIES. Two forms:
     *
     *  - A SELECTION (preferred): `{ name, version?, integrity?, source?, bundle? }`
     *    — the project names what it wants and the pack is resolved from the
     *    committed bundle, else this wairon install's store. Omitting `version`
     *    means "latest installed".
     *  - A legacy PATH string (`.wai/packs/foo.yaml`, an absolute path, or a
     *    module id) — still loaded, deprecated.
     *
     * A declared pack that cannot be resolved is an error, never a silent skip:
     * a project whose doctrine is absent is misconfigured, and the gate says so.
     */
    packs: z.array(z.union([z.string(), PackSelectionSchema])).default([]),
    /**
     * Whether to ALSO apply every pack installed machine-wide (WAIRON_PACKS_DIR
     * or ~/.wairon/packs) to this project, without the project naming them.
     *
     * Defaults to **false**: a project's doctrine is what the project declares.
     * Installing a pack on a machine makes it available, not authoritative —
     * otherwise the gate, the skills list, and the MCP instructions differ per
     * developer, and CI (which has no store) disagrees with every local run.
     *
     * Set true to restore the old machine-wide behaviour; `wairon doctor` reports
     * packs that are installed but applied by no route, and `--fix` records them
     * as explicit selections.
     */
    useGlobalPacks: z.boolean().default(false),
  }).optional(),

  paths: PathsConfigSchema.default({}),

  /**
   * The profile/pack selection a hosted policy workflow applied to this project.
   * The RECORD of what was chosen; `projectType` above is what actually governs
   * validation. Modeled so the parse/write round trip preserves it (see
   * ProjectProfileSelectionSchema).
   */
  profileSelection: ProjectProfileSelectionSchema.optional(),

  /**
   * Path to a directory containing org/user-level default templates.
   * Resolved before built-in templates but after project-local templates.
   *
   * Default: ~/.wairon/templates
   * Can also be set via WAIRON_TEMPLATES_DIR environment variable.
   */
  globalTemplatesDir: z.string().optional(),

  /**
   * Tracks whether the wairon usage guide has been injected into each target's
   * AI tool configuration files so the tool knows how to use wairon.
   */
  aiGuide: z.object({
    claudeGlobal: z.boolean().default(false),
    claudeLocal: z.boolean().default(false),
    geminiGlobal: z.boolean().default(false),
    geminiLocal: z.boolean().default(false),
  }).optional(),

  /** Created by wairon at init time */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * project_config.activeTargetTypes — the target types this configuration
 * enables: every target not explicitly disabled, in declaration order. A legacy
 * string target names its type directly and carries no enabled flag. Empty for a
 * configuration with no enabled targets.
 */
export function activeTargetTypes(config: ProjectConfig): string[] {
  const targets = config.targets as ReadonlyArray<TargetConfig | string>;
  return targets
    .filter((t) => typeof t === 'string' || t.enabled !== false)
    .map((t) => (typeof t === 'string' ? t : t.type));
}
