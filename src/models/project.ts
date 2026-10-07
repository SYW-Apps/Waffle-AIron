import * as path from 'path';
import { z } from 'zod';
import { CustomTargetSchema } from './agent.js';
import { ExecutionConfigSchema } from './execution.js';
import { isNewerVersion } from '../utils/version.js';
import { ownGet } from '../utils/own.js';
import { identifierProblem, MAX_IDENTIFIER_LENGTH } from './identifiers.js';

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
  /**
   * Casing style or regular expression for interface/implementation/type
   * method names. When unset, it follows the target language's convention
   * (methodCasingFor), so a Rust tree is snake_case without configuring
   * anything.
   */
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

/** The method casing each target language's convention asks for, by lowercased language name. */
const LANGUAGE_METHOD_CASING: Readonly<Record<string, string>> = {
  rust: 'snake_case',
  python: 'snake_case',
  ruby: 'snake_case',
  c: 'snake_case',
  elixir: 'snake_case',
  csharp: 'PascalCase',
  'c#': 'PascalCase',
  go: 'PascalCase',
};

/**
 * naming_rule_config.methodCasingFor — the casing a method name must have in a
 * tree of this target language: the configured `methods` casing when set,
 * else the language's convention — snake_case for rust, python, ruby, c and
 * elixir; PascalCase for csharp and go exports; camelCase for typescript,
 * javascript, java, kotlin, swift, dart and any language not listed. The
 * naming-conventions rule and the authoring and rename tools ask it, so define
 * and rename accept the same names. Pure.
 */
export function methodCasingFor(naming: Pick<NamingRuleConfig, 'methods'> | undefined, targetLanguage?: string): string {
  if (naming?.methods) return naming.methods;
  const language = targetLanguage?.trim().toLowerCase();
  return (language && ownGet(LANGUAGE_METHOD_CASING, language)) || 'camelCase';
}

/** The casing styles a naming setting may name, as the naming-conventions rule reads them. */
const CASING_STYLES: Readonly<Record<string, RegExp>> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z0-9]+(_[a-z0-9]+)*$/,
  'kebab-case': /^[a-z0-9]+(-[a-z0-9]+)*$/,
  UPPER_CASE: /^[A-Z0-9]+(_[A-Z0-9]+)*$/,
};

/**
 * Whether a method name fits a casing (methodCasingFor's answer): a known
 * style, or a configured regular expression on top of the identifier grammar.
 * An unreadable expression refuses nothing here (the naming rule reports it as
 * INVALID_NAMING_PATTERN). Pure.
 */
export function fitsMethodCasing(name: string, casing: string): boolean {
  const known = ownGet(CASING_STYLES, casing);
  if (known) return known.test(name);
  try {
    return new RegExp(casing).test(name);
  } catch {
    return true;
  }
}

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
  /**
   * This classification is PROVISIONAL, and this is what would settle it.
   *
   * A confident-sounding `why` that is wrong is worse than a missing one: it
   * reads as settled, so nobody looks again, and the register keeps counting
   * the finding under a kind that was never true. Nothing can check a reason
   * for truth — `kind` and `why` are prose, and STALE_CARRIED_FINDING only
   * ever catches "this stopped applying", never "this still applies for a
   * reason that has become false". What a register CAN do is let an author say
   * out loud that they are not sure yet, and then keep saying it: every run
   * counts the groups marked here beside the kind totals, so the uncertainty
   * is as loud as the debt.
   *
   * It is deliberately a SENTENCE and not a flag, and deliberately on the
   * reason GROUP rather than the finding: what is provisional is the reason,
   * and a reader deciding whether to pick this up needs to know what to
   * measure — "is the adapter really realized by the file that consumes it, or
   * is that a modelling error?" — not merely that somebody once hesitated. A
   * finding whose own classification is uncertain while its neighbours' is not
   * is a different reason, and belongs in its own group.
   *
   * There is no counterpart on `lint.allow`, and that is a decision, not an
   * omission: see the note on ConformanceRuleConfig.carried.
   */
  revisit: z.string().min(1).optional(),
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
   * Project-relative directories holding this project's TESTS. Declaring none
   * means no test scan and no `testsToRevisit` on any write — opt-in on the
   * same terms as `sourceRoots`, so a project that never asked for it never
   * pays for it.
   *
   * Separate from `sourceRoots` deliberately: tests are not code the specs are
   * expected to claim, and putting them there would make every test file an
   * UNCLAIMED_SOURCE_FILE.
   */
  testRoots: z.array(z.string()).optional(),
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
   *
   * A reason group may also declare itself PROVISIONAL (`revisit`), and the
   * total says how many did. There is no such marker on a `lint.allow`, and
   * the asymmetry is the point: an entry here does not silence anything — the
   * finding is counted out loud on every run — so marking one uncertain adds a
   * second dial to something already visible. An allow DOES silence, and a
   * "provisional allow" would buy the silence and defer the decision, which is
   * the one combination that cannot be reviewed: the finding is gone and the
   * doubt is in a field nobody opens. The mechanism for a decision nobody has
   * taken is to not take it — leave the warning firing — or, where the code is
   * carryable, an entry of kind `undecided`, which is exactly that sentence.
   */
  carried: z.array(CarriedDebtSchema).optional(),
  /**
   * Opt-in strictness for teams that want CI to say "every designed component
   * has code": every implementation must have begun (some file it names
   * exists). When true, SOURCE_FILE_PLANNED and MISSING_SOURCE_PATH are
   * reported at error, naming this setting, instead of as notices. Off by
   * default, so a design-only tree passes `validate --ci`. Code-conformance
   * tuning like the rest of `rules.conformance`: it enters the analyzer's
   * digest, never the gate identity, so switching it never stales a lock.
   */
  requireCode: z.boolean().optional(),
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
   * Key: rule code (e.g. CIRCULAR_DEPENDENCY), Value: error | warning | notice | off.
   * A notice is still reported, but never makes the tree invalid and never
   * fails `--ci`; off is not reported at all.
   */
  sddRuleSeverity: z.record(z.enum(['error', 'warning', 'notice', 'off'])).default({}),

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

/**
 * external_source — where an external's producer is found when the family does
 * not hold it: the producer project's root directory, relative to the declaring
 * project's root (an absolute path is kept as written), or — on a hosted
 * instance — the producer's hosted project record id (stage 7), which reaches a
 * producer in another isolated root where no path can. Exactly one of the two
 * is set; a source naming both or neither is REPORTED (the declaration's
 * problem), never unreadable. A hosted source is read live only through the
 * hosting server's record lookup within the request's reach; anywhere else it
 * is unavailable, never a pass.
 */
export const ExternalSourceSchema = z.object({
  path: z.string().optional(),
  hosted: z.string().optional(),
  /** A git repository URL holding the producer (stage 8). */
  git: z.string().optional(),
  /** git only: the branch or tag a pin or an update follows; never read by a verdict. */
  ref: z.string().optional(),
  /** git members only: the full commit the member is pinned at (an external's commit is its pin's). */
  commit: z.string().optional(),
  /** git only: the producer's root inside the repository. */
  dir: z.string().optional(),
});
export type ExternalSource = z.infer<typeof ExternalSourceSchema>;

/**
 * external_declaration — one `externals` entry of project.yaml as written: the
 * value under an alias key. `billing: {}` declares the producer whose id is
 * the alias; `crm: { project: crm }` names it; `ledger: { project: acme.ledger,
 * source: { path: ../ledger } }` also says where to find it.
 */
export const ExternalDeclarationSchema = z.object({
  /** The producer's project id; defaults to the alias. Plain string: a malformed id is REPORTED, never unreadable. */
  project: z.string().optional(),
  /**
   * Where the producer is found, in either form: the one location string
   * members use (`../geo-sdk`, `hosted:<id>`, `<git url>`, `<git url>#<commit>`
   * — a `#<commit>` read as the ref the pin follows) or the object form
   * ({ path } | { hosted } | { git, ref?, dir? }). Read leniently: any shape
   * loads, and one that is not a source is the declaration's problem
   * (readExternalSource), never a configuration that fails to load.
   */
  source: z.custom<ExternalSource | MemberSource>(() => true).optional(),
  /**
   * The producer's public names this project imports, so its specs may name
   * them bare: `['*']` imports every public name the producer exports to this
   * project, `[shared-error]` only those. Plain strings: a malformed entry is
   * REPORTED (the declaration's problem), never unreadable.
   */
  use: z.array(z.string()).optional(),
  /**
   * What the producer is to this project, in this project's words — the
   * external's twin of MemberDeclaration.description. `member detach` moves a
   * member's description here and `member adopt` moves it back, so detach
   * followed by adopt loses nothing.
   */
  description: z.string().optional(),
});
export type ExternalDeclaration = z.infer<typeof ExternalDeclarationSchema>;

/**
 * member_declaration — one `members` entry of project.yaml in its long form:
 * the value under an alias key. The usual form is the string shorthand, which
 * is the member's `source` alone: `scheduler: services/scheduler` (contained),
 * `admin: ../admin` (a sibling checkout), `payments:
 * git@host:acme/payments.git#<commit>` (git at a commit), `marketplace:
 * hosted:marketplace` (a hosted record). The long form `{ source, as?, ref?,
 * dir?, use?, description? }` is only for what the shorthand cannot say. WHAT
 * a member is follows from its content (stage 8): an id, an L0 or a lock make
 * it a project, anything else a part; `as` only asserts it. The pre-stage-8
 * long-form `path` is read for one release as `source` (DEPRECATED_MOUNT_FORM).
 * Plain strings throughout: a malformed source is REPORTED, never unreadable.
 */
export const MemberDeclarationSchema = z.object({
  /** DEPRECATED (stage 8): the pre-stage-8 key for a contained member's root; read as `source`. */
  path: z.string().optional(),
  /** Where the member lives, in the one location grammar. */
  source: z.string().optional(),
  /** part | project — only an assertion of what the content makes it. */
  as: z.string().optional(),
  /** git only: the branch or tag `member update` follows. */
  ref: z.string().optional(),
  /** git only: the member's root inside the repository. */
  dir: z.string().optional(),
  /** What the member is to this project, in the declaring project's words. */
  description: z.string().optional(),
  /** The member's public names this project imports, exactly as an external's `use` (project members only). */
  use: z.array(z.string()).optional(),
});
export type MemberDeclaration = z.infer<typeof MemberDeclarationSchema>;

/**
 * part_of — what a NON-CONTAINED part's own .wai/project.yaml says about it
 * (stage 8): the project it is a part of, and where that project's root is
 * when it sits on disk beside it. The only thing such a configuration declares.
 */
export const PartOfSchema = z.object({
  /** The parent project's id, as its project.yaml declares it. */
  project: z.string(),
  /** The parent's root relative to this part's root, when known. Read only by `externals pin` at the part. */
  path: z.string().optional(),
});
export type PartOf = z.infer<typeof PartOfSchema>;

/** A value read as a plain string: absent is empty, anything else its text. */
const plainString = z.preprocess((v) => (v === undefined || v === null ? '' : String(v)), z.string());

/**
 * pack_requirement — one entry of `composition.requirePolicies`: a pack the
 * project requires of its members, by name and semver range, optionally one
 * profile inside it. A requirement, never a selection: nothing loads from it.
 * Plain strings throughout, so a malformed range is REPORTED
 * (POLICY_REQUIREMENT_INVALID), never unreadable.
 */
export const PackRequirementSchema = z.object({
  pack: plainString,
  version: plainString,
  profile: z.string().optional(),
});
export type PackRequirement = z.infer<typeof PackRequirementSchema>;

/**
 * composition_config — what this project requires of the projects it contains
 * when they are composed. Judged in the family run; its own gate checks only
 * the syntax of its requirements. Coexists with, and is never merged into, the
 * hosted instance floor and profileSelection.
 */
export const CompositionConfigSchema = z.object({
  requirePolicies: z.array(PackRequirementSchema).optional(),
  /**
   * Opt-in, off by default (stage 5). When true, this project's lock refuses
   * while any DIRECT member is drifted or never approved, naming each, and
   * writes nothing. Off: the lock proceeds and records each member's state.
   */
  requireApprovedMembers: z.boolean().optional(),
});
export type CompositionConfig = z.infer<typeof CompositionConfigSchema>;

/**
 * network_declaration — a project's declaration that it and every member below
 * it form one isolated network boundary. Logical design, not deployment: no
 * address, range or region. `network: true` is the short form of an empty
 * declaration, read as `{}`; `false` reads as no declaration. Networks nest
 * one level per declaring project; a part cannot declare one.
 */
export const NetworkDeclarationSchema = z.object({
  /** What the boundary encloses, in the declaring project's words; shown on the network diagram. */
  description: z.string().optional(),
});
export type NetworkDeclaration = z.infer<typeof NetworkDeclarationSchema>;

/** A stored `network` value as the configuration reads it: true as `{}`, false or null as none. */
const NetworkFieldSchema = z.preprocess(
  (value) => (value === true ? {} : value === false || value === null ? undefined : value),
  NetworkDeclarationSchema.optional(),
);

export const ProjectConfigSchema = z.object({
  /**
   * Schema version — used to detect incompatible config formats in future
   * CLI versions.
   */
  schemaVersion: z.string().default('1.0.0'),

  /**
   * The project's stable identity: a slug of [a-z0-9-_.] that starts and ends
   * alphanumeric (PROJECT_ID_RE). Optional in the file: a project that declares
   * none answers to its name slugified (effectiveProjectId) until a deliberate
   * writer sets one — an ordinary save never writes the default. Deliberately a plain
   * string here rather than the grammar: a malformed id must be REPORTED
   * (PROJECT_ID_AMBIGUOUS), not make the whole configuration unreadable.
   */
  id: z.string().optional(),

  /**
   * The ids this project answered to before, oldest first, each appended by
   * the rename migration (`wairon project rename`) and never removed or
   * reordered by a writer. A lock that approved one of them reads as renamed
   * (PROJECT_ID_RENAMED, a notice) rather than changed, so the re-lock the
   * rename asks for is not refused. Nothing resolves through it: a reference
   * still naming an old id is rewritten by the rename, or reported.
   */
  previousIds: z.array(z.string()).optional(),

  /** Human-readable display name. Not an identity — `id` is. */
  name: z.string(),

  /**
   * The other projects this project consumes, keyed by alias (the name its
   * references use from stage 3). A producer is found through the family
   * (parent, members, siblings) or an explicit source.path; a member needs no
   * declaration — the mount is its alias. Read by the project graph at scan
   * time; stage 2 writes it by hand only. The alias is a plain record key: a
   * malformed alias is REPORTED (EXTERNAL_UNRESOLVED), never unreadable.
   */
  externals: z.record(ExternalDeclarationSchema).optional(),

  /**
   * What this project is made of beyond its own specs folder, keyed by alias,
   * each value one `source` in one grammar — `scheduler: services/scheduler`
   * (contained), `admin: ../admin` (sibling), `payments:
   * git@host:acme/payments.git#<commit>` (git), `marketplace:
   * hosted:marketplace` (hosted) — or the long form (MemberDeclaration). What
   * a member IS follows from its content (stage 8): one whose tree declares an
   * id, holds an L0 or carries a lock is a PROJECT, reached only as
   * `alias::name` through its L0 exports; anything else is a PART, whose
   * subsystems are this project's own. Together with `externals` it is this
   * project's alias table. The legacy L1 `projectPath` mount and the long-form
   * `path` key still load for one release (DEPRECATED_MOUNT_FORM).
   */
  members: z.record(z.union([z.string(), MemberDeclarationSchema])).optional(),

  /**
   * Set only in a NON-CONTAINED part's configuration (stage 8: a sibling
   * checkout or a git repository): the project it is a part of, so the part
   * opened alone can say what it belongs to. A configuration that sets it
   * declares nothing else a project declares; absent in every project's.
   */
  partOf: PartOfSchema.optional(),

  /**
   * What this project requires of the projects it contains when they are
   * composed: `requirePolicies`, the packs each member must select (by semver
   * range, optionally one profile). This project's own gate judges only its
   * syntax (POLICY_REQUIREMENT_INVALID); the family run judges members against
   * it, and createMember reads it once when it scaffolds a new member. No
   * member's own gate reads it. Written by hand.
   */
  composition: CompositionConfigSchema.optional(),

  /**
   * Opt-in: this project and every member below it form an isolated network
   * (`network: true`, or `{ description }`). Read by the family run's network
   * rules and by the derived networking outputs; part of the gate identity,
   * because it changes family-run verdicts. Written by hand. Absent in a
   * part's configuration.
   */
  network: NetworkFieldSchema.optional(),

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

// ── project_config type behaviour ───────────────────────────────────────────

/** The extension a pack path reference carries — the pattern server/packs.ts's stem() strips. */
const PACK_EXT_RE = /\.(ya?ml|cjs|js)$/i;

/**
 * The names of the packs a configuration declares, deduplicated in first-seen order:
 * each `extensions.packs` entry (a selection's name, or a path reference's file stem),
 * then the required and default pack names its profile selection records.
 */
export function declaredPackNames(config: Pick<ProjectConfig, 'extensions' | 'profileSelection'>): string[] {
  const selection = config.profileSelection;
  return [...new Set([
    ...(config.extensions?.packs ?? []).map((entry) =>
      (typeof entry === 'string' ? path.basename(entry).replace(PACK_EXT_RE, '') : entry.name)),
    ...(selection?.requiredPackNames ?? []),
    ...(selection?.defaultPackNames ?? []),
  ])];
}

/** The profile ids a configuration's profile selection records, deduplicated; never `projectType`. */
export function declaredProfileIds(config: Pick<ProjectConfig, 'profileSelection'>): string[] {
  return [...new Set(config.profileSelection?.profileIds ?? [])];
}

/** pack_path — a legacy path reference to a pack file, as `pack add` registers it in `extensions.packs`. */
export type PackPath = string;

/** One entry of `extensions.packs`: a by-name selection or a legacy path reference. */
export type PackEntry = PackSelection | PackPath;

/**
 * project_config.withPack — the configuration as it would read after one pack
 * write, without writing it: a selection drops every same-name selection and
 * is appended last (the highest precedence), a legacy path reference is
 * appended only when absent; with `remove`, the same-name selection (or that
 * exact path reference) is dropped instead. The one reading of a pack write
 * the dry validate and the registry share (impact-matches-apply).
 */
export function withPack(config: ProjectConfig, entry: PackEntry, remove = false): ProjectConfig {
  const packs = config.extensions?.packs ?? [];
  const same = (e: PackEntry): boolean => (typeof entry === 'string' ? e === entry : typeof e !== 'string' && e.name === entry.name);
  const others = packs.filter((e) => !same(e));
  let next: PackEntry[];
  if (remove) next = others;
  else if (typeof entry === 'string') next = packs.includes(entry) ? packs : [...packs, entry];
  else next = [...others, entry];
  return { ...config, extensions: { useGlobalPacks: false, ...config.extensions, packs: next } };
}

/**
 * project_config.requiredPolicies — `composition.requirePolicies` in
 * declaration order, a second requirement for a pack already required dropped
 * (the first stands). Empty when nothing is required.
 */
export function requiredPolicies(config: Pick<ProjectConfig, 'composition'>): PackRequirement[] {
  const seen = new Set<string>();
  const out: PackRequirement[] = [];
  for (const requirement of config.composition?.requirePolicies ?? []) {
    if (seen.has(requirement.pack)) continue;
    seen.add(requirement.pack);
    out.push(requirement);
  }
  return out;
}

// ── pack_requirement: an npm-style semver subset ────────────────────────────
//
// Ranges are evaluated with the store's own version comparator
// (utils/version.isNewerVersion) — no semver dependency. Supported: an exact
// version, caret (^1.2) and tilde (~1.2.3) ranges, x-ranges (1.x, 1.2.*, *),
// comparator sets joined by spaces (>=1.2.0 <2.0.0), and `||` alternatives.

/** A concrete version: major.minor.patch with an optional pre-release tag. */
interface ConcreteVersion { major: number; minor: number; patch: number; pre?: string }

/** One comparator of an alternative, its version always concrete. */
interface Comparator { op: '>=' | '>' | '<' | '<=' | '='; version: ConcreteVersion }

/** One `||` alternative: its comparators (empty: any version), and whether it is the bare any-range. */
interface Alternative { comparators: Comparator[]; any: boolean }

const CONCRETE_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;
const OPERATOR_RE = /^(>=|<=|>|<|=|\^|~)/;

function concrete(v: string): ConcreteVersion | null {
  const m = CONCRETE_RE.exec(v.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), ...(m[4] ? { pre: m[4] } : {}) };
}

const text = (v: ConcreteVersion): string => `${v.major}.${v.minor}.${v.patch}${v.pre ? `-${v.pre}` : ''}`;

/** -1, 0 or 1 — through the store's comparator, so a range reads versions the way the store orders them. */
function compare(a: ConcreteVersion, b: ConcreteVersion): number {
  if (isNewerVersion(text(a), text(b))) return -1;
  if (isNewerVersion(text(b), text(a))) return 1;
  return 0;
}

/** A partial version: each part a number, or null for a wildcard or an absent part. */
interface PartialVersion { major: number | null; minor: number | null; patch: number | null; pre?: string }

function partial(v: string): PartialVersion | null {
  const m = PARTIAL_RE.exec(v);
  if (!m) return null;
  const num = (s: string | undefined): number | null => (s === undefined || /^[xX*]$/.test(s) ? null : Number(s));
  const major = num(m[1]);
  const minor = major === null ? null : num(m[2]);
  const patch = minor === null ? null : num(m[3]);
  // A pre-release tag belongs to a full version only.
  if (m[4] && patch === null) return null;
  return { major, minor, patch, ...(m[4] ? { pre: m[4] } : {}) };
}

const cv = (major: number, minor: number, patch: number, pre?: string): ConcreteVersion => ({ major, minor, patch, ...(pre ? { pre } : {}) });

/** The upper bound of a partial's wildcard span: 1 → 2.0.0, 1.2 → 1.3.0. */
function nextOf(p: PartialVersion): ConcreteVersion {
  if (p.minor === null) return cv(p.major! + 1, 0, 0);
  return cv(p.major!, p.minor + 1, 0);
}

/** One operator token expanded into its comparators; null when it cannot be read. */
function expand(token: string): Comparator[] | null {
  const opMatch = OPERATOR_RE.exec(token);
  const op = opMatch ? opMatch[1] : '';
  const p = partial(token.slice(op.length));
  if (!p) return null;
  const low = cv(p.major ?? 0, p.minor ?? 0, p.patch ?? 0, p.pre);
  const exact = p.patch !== null;
  if (p.major === null) return op === '<' || op === '>' ? [{ op: '<', version: cv(0, 0, 0) }] : [];
  switch (op) {
    case '':
    case '=':
      return exact ? [{ op: '=', version: low }] : [{ op: '>=', version: low }, { op: '<', version: nextOf(p) }];
    case '^': {
      const upper = p.major > 0 || p.minor === null ? cv(p.major + 1, 0, 0)
        : p.minor > 0 || p.patch === null ? cv(0, p.minor + 1, 0)
          : cv(0, 0, p.patch + 1);
      return [{ op: '>=', version: low }, { op: '<', version: upper }];
    }
    case '~':
      return [{ op: '>=', version: low }, { op: '<', version: p.minor === null ? cv(p.major + 1, 0, 0) : cv(p.major, p.minor + 1, 0) }];
    case '>=':
      return [{ op: '>=', version: low }];
    case '<':
      return [{ op: '<', version: low }];
    case '>':
      return exact ? [{ op: '>', version: low }] : [{ op: '>=', version: nextOf(p) }];
    case '<=':
      return exact ? [{ op: '<=', version: low }] : [{ op: '<', version: nextOf(p) }];
    default:
      return null;
  }
}

/** The range read into alternatives, or the first token that cannot be read. */
function readRange(range: string): { alternatives: Alternative[] } | { problem: string } {
  if (range.trim() === '') return { problem: 'the range is empty' };
  const alternatives: Alternative[] = [];
  for (const raw of range.split('||')) {
    // An operator written apart from its version (">= 1.2.0") is one token.
    const tokens = raw.trim().split(/\s+/).filter((t) => t !== '');
    const joined: string[] = [];
    for (const t of tokens) {
      if (joined.length > 0 && /^(>=|<=|>|<|=|\^|~)$/.test(joined[joined.length - 1])) joined[joined.length - 1] += t;
      else joined.push(t);
    }
    const comparators: Comparator[] = [];
    for (const token of joined) {
      const expanded = expand(token);
      if (!expanded) return { problem: `"${token}" is neither a version, an x-range nor a comparator` };
      comparators.push(...expanded);
    }
    alternatives.push({ comparators, any: joined.length === 0 || (joined.length === 1 && /^[xX*]$/.test(joined[0])) });
  }
  return { alternatives };
}

function satisfies(version: ConcreteVersion, c: Comparator): boolean {
  const d = compare(version, c.version);
  switch (c.op) {
    case '=': return d === 0;
    case '>=': return d >= 0;
    case '>': return d > 0;
    case '<': return d < 0;
    case '<=': return d <= 0;
  }
}

/**
 * pack_requirement.rangeProblem — why the range cannot be read (the first
 * token that is neither a version, an x-range nor a comparator), or null when
 * it parses. What POLICY_REQUIREMENT_INVALID quotes.
 */
export function rangeProblem(requirement: Pick<PackRequirement, 'version'>): string | null {
  const read = readRange(requirement.version);
  return 'problem' in read ? read.problem : null;
}

/**
 * pack_requirement.admits — whether a concrete pack version satisfies the
 * requirement's range: true when it matches any `||` alternative, each the
 * conjunction of its comparators. An unversioned pack (undefined or empty) is
 * admitted by `*` alone; a pre-release only by an alternative naming the same
 * major.minor.patch with a pre-release tag. A version or range that does not
 * parse admits nothing.
 */
export function admits(requirement: Pick<PackRequirement, 'version'>, version?: string): boolean {
  const read = readRange(requirement.version);
  if ('problem' in read) return false;
  if (version === undefined || version.trim() === '') return read.alternatives.some((a) => a.any);
  const v = concrete(version);
  if (!v) return false;
  return read.alternatives.some((alt) => {
    if (v.pre && !alt.comparators.some((c) => c.version.pre && c.version.major === v.major && c.version.minor === v.minor && c.version.patch === v.patch)) return false;
    return alt.comparators.every((c) => satisfies(v, c));
  });
}

// ── project_config identity ─────────────────────────────────────────────────

/**
 * The project-id grammar: lower-case letters, digits, `-`, `_` and `.`,
 * starting and ending with a letter or a digit. Dots are allowed (a dotted id
 * needs an explicit alias once references name projects); nothing else is.
 */
// The whole identifier grammar for a project id (identifier.problemAs project-id), so every
// `.test` agrees with it: at most 64 characters, never a Windows device name or super.
export const PROJECT_ID_RE = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$))(?!super$)(?=.{1,64}$)[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

/**
 * A display name slugified into the project-id grammar: lower-cased, every run
 * of characters outside [a-z0-9-_.] collapsed to one '-', then trimmed until it
 * starts and ends with a letter or a digit. Null when nothing is left — there is
 * deliberately no fallback, so a name that yields no id is reported, never
 * papered over with an invented one.
 */
function slugifyProjectName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  // Cut to the cap and re-trimmed; a slug the grammar still refuses (a device
  // name, super) is no id — reported as missing, never papered over.
  const cut = slug.slice(0, MAX_IDENTIFIER_LENGTH).replace(/[^a-z0-9]+$/, '');
  return cut === '' || identifierProblem(cut, 'project-id') !== null ? null : cut;
}

/**
 * project_config.effectiveId — the declared id as written, else `name`
 * slugified; null when neither yields one.
 */
export function effectiveProjectId(config: Pick<ProjectConfig, 'id' | 'name'>): string | null {
  if (config.id !== undefined) return config.id;
  return slugifyProjectName(config.name);
}

/** One thing wrong with a project's identity, as project_config.identity names it. */
export interface ProjectIdentityProblem {
  kind: 'defaulted' | 'ambiguous' | 'renamed' | 'changed';
  detail: string;
}

/** Where a project's effective id came from. */
export type ProjectIdSource = 'declared' | 'defaulted' | 'none';

/** project_identity — a project's resolved identity and what is wrong with it. */
export interface ProjectIdentity {
  /** The effective id; absent when there is no declared id and the name yields no slug. */
  id?: string;
  /** Where the effective id came from. */
  source: ProjectIdSource;
  /** The display name, as configured. */
  name: string;
  /** The id the current lock approved, when one was given. */
  lockedId?: string;
  /** Every problem with the identity; empty when it is declared, well-formed and matches the lock. */
  problems: ProjectIdentityProblem[];
}

/**
 * project_config.identity — resolve the effective id against the id a lock
 * approved and name every problem with it: defaulted (no id declared, one
 * derived from the name), ambiguous (the name yields none, or the declared id
 * breaks the grammar), renamed (the effective id differs from lockedProjectId,
 * which is one of `previousIds`: the rename migration moved it, and only the
 * re-lock is owed), changed (the effective id — none included — differs from
 * lockedProjectId otherwise).
 */
export function projectIdentity(config: Pick<ProjectConfig, 'id' | 'name' | 'previousIds'>, lockedProjectId?: string): ProjectIdentity {
  const id = effectiveProjectId(config);
  const source: ProjectIdentity['source'] = config.id !== undefined ? 'declared' : id !== null ? 'defaulted' : 'none';
  const problems: ProjectIdentityProblem[] = [];
  if (source === 'defaulted') {
    problems.push({ kind: 'defaulted', detail: `no id is declared; the name "${config.name}" yields "${id}"` });
  } else if (source === 'none') {
    problems.push({ kind: 'ambiguous', detail: `no id is declared, and the name "${config.name}" yields no id` });
  } else if (identifierProblem(config.id!, 'project-id') !== null) {
    problems.push({ kind: 'ambiguous', detail: `the declared id "${config.id}" breaks the project-id grammar: ${identifierProblem(config.id!, 'project-id')}` });
  }
  if (lockedProjectId !== undefined && id !== lockedProjectId && id !== null && (config.previousIds ?? []).includes(lockedProjectId)) {
    problems.push({ kind: 'renamed', detail: `the lock approved "${lockedProjectId}", and the project was renamed to "${id}"` });
  } else if (lockedProjectId !== undefined && id !== lockedProjectId) {
    problems.push({
      kind: 'changed',
      detail: id === null ? `the lock approved "${lockedProjectId}", and the project now has no id` : `the lock approved "${lockedProjectId}", and the project now resolves to "${id}"`,
    });
  }
  return {
    ...(id !== null ? { id } : {}),
    source,
    name: config.name,
    ...(lockedProjectId !== undefined ? { lockedId: lockedProjectId } : {}),
    problems,
  };
}

// ── project_config externals ────────────────────────────────────────────────

/**
 * An external's alias: a reference segment, so no dot (a dotted producer id
 * needs an explicit alias), and never a name Windows reserves for a device
 * (`con`, `aux`, `com1`, …) — the alias names its pin file
 * (`.wai/externals/<alias>.yaml`), which no Windows checkout could hold.
 */
// The whole identifier grammar for an alias (identifier.problemAs alias), so every `.test`
// agrees with it: at most 64 characters, no leading "-", never super or __proto__.
export const EXTERNAL_ALIAS_RE = /^(?!(?:con|prn|aux|nul|com[0-9]|lpt[0-9]|super|__proto__)$)(?!-)[a-z0-9_-]{1,64}$/;

/** Why an alias breaks EXTERNAL_ALIAS_RE, in words (identifier.problemAs alias): the grammar, a device name, the length, ... */
export function aliasGrammarProblem(alias: string): string {
  const problem = identifierProblem(alias, 'alias') ?? `"${alias}" breaks [a-z0-9-_]+`;
  return `the alias ${problem}${/Windows reserves for a device/.test(problem) ? ' (an alias names a file)' : ''}`;
}

/**
 * declared_external — one external as the configuration declares it,
 * normalized: the alias, the producer id it defaults or names, the explicit
 * source path when one is given, and what is wrong with the declaration on its
 * own (before any producer is looked for).
 */
export interface DeclaredExternal {
  alias: string;
  /** The producer id: the declaration's `project`, else the alias. */
  project: string;
  /** The declaration's `source.path`, as written. */
  sourcePath?: string;
  /** The declaration's `source.hosted`, as written: the producer's hosted record id (stage 7). */
  sourceHosted?: string;
  /** The declaration's `source.git`, as written: the producer's repository URL (stage 8). */
  sourceGit?: string;
  /** The declaration's `source.ref`, as written: the branch or tag a pin follows. */
  sourceRef?: string;
  /** The declaration's `source.dir`, as written: the producer's root inside the repository. */
  sourceDir?: string;
  /** Why the declaration cannot be used as written. */
  problem?: string;
  /** The declaration's `use` as written, deduplicated in first-seen order; empty when it imports nothing. */
  use: string[];
}

/** The forms an external's `source` is accepted in, as a refusal names them. */
export const EXTERNAL_SOURCE_FORMS = 'a location string (`../sibling`, `hosted:<id>`, `<git url>` or `<git url>#<commit>`) or an object ({ path } | { hosted } | { git, ref?, dir? })';

/** An external's source as read: its object form, normalized, or why it cannot be read. */
export interface ReadExternalSource {
  /** The object form; absent when nothing usable was written. */
  source?: ExternalSource;
  /** Why the source cannot be used as written — the declaration's problem, never a load failure. */
  problem?: string;
}

/** The string form of an external's source, read through the one location grammar. */
function readSourceString(written: string): ReadExternalSource {
  const text = written.trim();
  if (text === '') return { problem: `its \`source\` is empty — write ${EXTERNAL_SOURCE_FORMS}` };
  if (GIT_URL_RE.test(text)) {
    const hash = text.lastIndexOf('#');
    const url = hash >= 0 ? text.slice(0, hash) : text;
    const commit = hash >= 0 ? text.slice(hash + 1).trim() : '';
    if (hash < 0 || commit === '') return { source: { git: url } };
    // For an external a `#<commit>` is the ref the pin follows, fixed at that commit.
    if (!FULL_COMMIT_RE.test(commit)) {
      return { source: { git: url }, problem: `its git source pins "${commit}", which is not a full commit — write the full commit after \`#\`, or follow a branch or tag with \`ref\`` };
    }
    return { source: { git: url, ref: commit } };
  }
  const parsed = parseMemberSource(text);
  if (parsed.storage === 'hosted') return { source: parsed.source, ...(parsed.problem ? { problem: parsed.problem } : {}) };
  if (isAbsolutePath(text)) return { source: { path: text }, problem: `its \`source\` is the absolute path "${text}" — a location string is relative to the declaring project (\`../sibling\`)` };
  return { source: { path: text }, ...(parsed.problem ? { problem: parsed.problem } : {}) };
}

/**
 * external_declaration.source read leniently: the location string or the
 * object form, normalized into the object form. A source of the wrong shape,
 * one naming none or several of path/hosted/git, one naming `commit`, or a
 * string the grammar refuses is answered as the problem — never thrown — so a
 * configuration holding it still loads and every other external still shows.
 */
export function readExternalSource(written: unknown): ReadExternalSource {
  if (written === undefined || written === null) return {};
  if (typeof written === 'string') return readSourceString(written);
  if (typeof written !== 'object' || Array.isArray(written)) {
    return { problem: `its \`source\` is neither of the accepted forms — write ${EXTERNAL_SOURCE_FORMS}` };
  }
  const raw = written as Record<string, unknown>;
  const keys = ['path', 'hosted', 'git', 'ref', 'commit', 'dir'] as const;
  const wrong = keys.find((k) => raw[k] !== undefined && typeof raw[k] !== 'string');
  if (wrong) return { problem: `its \`source.${wrong}\` is not a string — write ${EXTERNAL_SOURCE_FORMS}` };
  const source: ExternalSource = Object.fromEntries(keys.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k] as string]));
  const named = [source.path, source.hosted, source.git].filter((v) => v !== undefined).length;
  if (named === 0) return { source, problem: 'its `source` names none of `path`, `hosted` and `git` — give exactly one' };
  if (named > 1) return { source, problem: 'its `source` names more than one of `path`, `hosted` and `git` — give exactly one' };
  if (source.commit !== undefined) {
    return { source, problem: 'its `source` names `commit`, but an external follows a ref — write `ref: <commit>` or `<url>#<commit>`' };
  }
  return { source };
}

/** One `use` entry: `*`, or a public name of [a-z0-9-_]+. */
export const USE_ENTRY_RE = /^(\*|[a-z0-9_-]+)$/;

/** A `use` list deduplicated in first-seen order, and the first malformed entry's problem, if any. */
function readUse(alias: string, use: unknown): { use: string[]; problem?: string } {
  const list = Array.isArray(use) ? use.map((u) => String(u)) : [];
  const deduped = [...new Set(list)];
  const bad = deduped.find((u) => !USE_ENTRY_RE.test(u));
  return {
    use: deduped,
    ...(bad !== undefined ? { problem: `the \`use\` of "${alias}" lists "${bad}", which is neither \`*\` nor a public name ([a-z0-9-_]+)` } : {}),
  };
}

/**
 * project_config.declaredExternals — the configuration's `externals`, one
 * DeclaredExternal per alias in declaration order. A malformed alias,
 * producer id or `use` entry is recorded as the entry's problem, never dropped.
 */
export function declaredExternals(config: Pick<ProjectConfig, 'externals'> & Partial<Pick<ProjectConfig, 'members'>>): DeclaredExternal[] {
  return Object.entries(config.externals ?? {}).map(([alias, declaration]) => {
    const project = declaration?.project ?? alias;
    const imports = readUse(alias, declaration?.use);
    // Either form of the source, normalized; a malformed one is the declaration's problem.
    const read = readExternalSource(declaration?.source);
    const source = read.source;
    const problem = !EXTERNAL_ALIAS_RE.test(alias)
      ? (PROJECT_ID_RE.test(alias) && alias.includes('.')
        ? `the alias "${alias}" is not a reference name ([a-z0-9-_]+) — a dotted producer id needs an explicit alias, e.g. \`${alias.replace(/\./g, '-')}: { project: ${alias} }\``
        : aliasGrammarProblem(alias))
      : ownGet(config.members, alias) !== undefined
        ? `the alias "${alias}" is also declared under \`members\` — one alias names one project`
        : !PROJECT_ID_RE.test(project)
          ? `the producer id "${project}" breaks the project-id grammar`
          : read.problem ?? imports.problem;
    return {
      alias,
      project,
      ...(source?.path !== undefined ? { sourcePath: source.path } : {}),
      ...(source?.hosted !== undefined ? { sourceHosted: source.hosted } : {}),
      ...(source?.git !== undefined ? { sourceGit: source.git } : {}),
      ...(source?.ref !== undefined ? { sourceRef: source.ref } : {}),
      ...(source?.dir !== undefined ? { sourceDir: source.dir } : {}),
      ...(problem ? { problem } : {}),
      use: imports.use,
    };
  });
}

// ── project_config members ──────────────────────────────────────────────────

/** contained | path | git | hosted: where a member's files live (stage 8). */
export type MemberStorage = 'contained' | 'path' | 'git' | 'hosted';

/** What a member is, as its content makes it (stage 8): a part of its parent, or a project of its own. */
export type MemberKind = 'part' | 'project';

/** A full git commit: 40 (sha1) or 64 (sha256) hex digits. */
export const FULL_COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A git URL: a scheme git speaks, or the scp form user@host:path. */
const GIT_URL_RE = /^(?:(?:https?|ssh|git|file):\/\/|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:)/;

/**
 * member_source — a member's location in its one string grammar: the
 * shorthand a `members` entry may be instead of its long form, and the long
 * form's `source`.
 */
export type MemberSource = string;

/** One source string read: its object form and storage, or why it cannot be read. */
export interface ParsedMemberSource {
  source: ExternalSource;
  storage: MemberStorage;
  problem?: string;
}

/** An absolute path on any platform this configuration may be read on. */
function isAbsolutePath(p: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(p);
}

/** A relative path's segments, either separator. */
function segmentsOf(p: string): string[] {
  return p.split(/[/\\]/).filter((s) => s !== '' && s !== '.');
}

/**
 * member_declaration.source parsed — the one location grammar (stage 8): a
 * `hosted:<id>` record; a git URL with `#<full commit>`; a path beginning with
 * `../` is a SIBLING checkout (leaving the root is only ever this explicit
 * `..`); any other relative path is CONTAINED. Refused: an empty source, an
 * absolute path, an inner `..`, and a git source without its commit — each
 * answered as the problem, never thrown.
 */
export function parseMemberSource(written: MemberSource): ParsedMemberSource {
  const text = written.trim();
  if (text === '') return { source: { path: '' }, storage: 'contained', problem: 'its source is empty' };
  if (text.startsWith('hosted:')) {
    const id = text.slice('hosted:'.length).trim();
    return { source: { hosted: id }, storage: 'hosted', ...(id === '' ? { problem: `its source "${text}" names no hosted record` } : {}) };
  }
  if (GIT_URL_RE.test(text)) {
    const hash = text.lastIndexOf('#');
    const url = hash >= 0 ? text.slice(0, hash) : text;
    const commit = hash >= 0 ? text.slice(hash + 1).trim() : undefined;
    const source: ExternalSource = { git: url, ...(commit ? { commit } : {}) };
    if (!commit) {
      return { source, storage: 'git', problem: `its git source "${url}" names no commit — write it as "${url}#<full commit>" (\`wairon member add\` and \`member update\` write it)` };
    }
    if (!FULL_COMMIT_RE.test(commit)) {
      return { source, storage: 'git', problem: `its git source pins "${commit}", which is not a full commit — a member is pinned at a full commit, never a branch` };
    }
    return { source, storage: 'git' };
  }
  if (isAbsolutePath(text)) {
    return { source: { path: text }, storage: 'contained', problem: `its source is the absolute path "${text}" — a member's location is relative to the project declaring it` };
  }
  const segments = segmentsOf(text);
  let leading = 0;
  while (segments[leading] === '..') leading++;
  if (segments.slice(leading).includes('..')) {
    return { source: { path: text }, storage: leading > 0 ? 'path' : 'contained', problem: `its source "${text}" has an inner \`..\` — leaving the root is only ever a leading \`../\`` };
  }
  if (leading > 0 && leading === segments.length) {
    return { source: { path: text }, storage: 'path', problem: `its source "${text}" names a directory above the project but no member in it` };
  }
  return { source: { path: text }, storage: leading > 0 ? 'path' : 'contained' };
}

/**
 * declared_member — one member as the configuration declares it, normalized
 * from the shorthand or the long form: the alias, its source parsed into its
 * object form with the storage that implies, the `as` it asserts (if any), the
 * description, and what is wrong with the declaration on its own (before the
 * loader looks for the directory). What the member IS follows from its
 * content, so it is the scan's to decide, never this value's.
 */
export interface DeclaredMember {
  alias: string;
  /** A contained member's root as written, relative to the declaring root; absent for any other storage. */
  path?: string;
  /** The long form's description, when given. */
  description?: string;
  /** Why the declaration cannot be used as written. */
  problem?: string;
  /** The long form's `use` as written, deduplicated in first-seen order; empty for the shorthand and when it imports nothing. */
  use: string[];
  /** part | project when the declaration asserts one. */
  as?: string;
  /** The source string parsed: { path } for a contained or sibling path, { git, commit, ref?, dir? }, or { hosted }. */
  source: ExternalSource;
  /** contained | path | git | hosted. */
  storage: MemberStorage;
  /** Whether the entry used the deprecated long-form `path` key. */
  deprecatedPath: boolean;
}

/** A `members` value read the way both forms mean it: the shorthand is the source alone. */
export function memberDeclarationOf(value: string | MemberDeclaration): MemberDeclaration {
  return typeof value === 'string' ? { source: value } : value;
}

/** The one location a `members` value names — its `source`, else the deprecated `path` — as written. */
export function memberLocationOf(value: string | MemberDeclaration): string | undefined {
  const declaration = memberDeclarationOf(value);
  return declaration.source ?? declaration.path;
}

/**
 * The contained path a `members` value names, relative to the declaring root,
 * or undefined when it names any other storage (or nothing readable): what the
 * pre-stage-8 writers and readers that follow a member into a directory under
 * the declaring root still read.
 */
export function containedPathOf(value: string | MemberDeclaration): string | undefined {
  const location = memberLocationOf(value);
  if (location === undefined) return undefined;
  const parsed = parseMemberSource(location);
  return parsed.storage === 'contained' && !parsed.problem ? location : undefined;
}

/**
 * project_config.declaredMembers — the configuration's `members`, one
 * DeclaredMember per alias in declaration order: the source string (the
 * shorthand, the long form's `source`, or for one release the deprecated
 * `path`, flagged) parsed into its object form and storage, the asserted `as`,
 * the description and `use` copied as written. A malformed alias, a missing or
 * unparseable source, a git source without its commit, a bad `as`, a hosted
 * source asserted to be a part, an alias `externals` also declares, or a
 * malformed `use` entry is recorded as the entry's problem, never dropped.
 */
export function declaredMembers(config: Partial<Pick<ProjectConfig, 'members' | 'externals'>>): DeclaredMember[] {
  return Object.entries(config.members ?? {}).map(([alias, value]) => {
    const declaration = memberDeclarationOf(value) ?? {};
    const source = typeof declaration.source === 'string' ? declaration.source : undefined;
    const deprecated = typeof declaration.path === 'string' ? declaration.path : undefined;
    const parsed = parseMemberSource(source ?? deprecated ?? '');
    // The git-only long-form fields join the parsed source.
    if (parsed.storage === 'git') {
      if (declaration.ref !== undefined) parsed.source.ref = declaration.ref;
      if (declaration.dir !== undefined) parsed.source.dir = declaration.dir;
    }
    const imports = readUse(alias, declaration.use);
    const as = declaration.as;
    const problem = !EXTERNAL_ALIAS_RE.test(alias)
      ? `the member ${aliasGrammarProblem(alias).replace(/^the /, '')}`
      : source !== undefined && deprecated !== undefined
        ? `the member "${alias}" names both \`source\` and the deprecated \`path\` — keep \`source\``
        : source === undefined && deprecated === undefined
          ? `the member "${alias}" declares no source`
          : parsed.problem
            ? `the member "${alias}": ${parsed.problem}`
            : as !== undefined && as !== 'part' && as !== 'project'
              ? `the member "${alias}" asserts \`as: ${as}\` — a member is a part or a project`
              : parsed.storage === 'hosted' && as === 'part'
                ? `the member "${alias}" is a hosted record asserted \`as: part\` — a part is part of its parent's record, so a hosted source is a project`
                : (declaration.ref !== undefined || declaration.dir !== undefined) && parsed.storage !== 'git'
                  ? `the member "${alias}" names \`${declaration.ref !== undefined ? 'ref' : 'dir'}\`, which only a git source carries`
                  : ownGet(config.externals, alias) !== undefined
                    ? `the alias "${alias}" is also declared under \`externals\` — one alias names one project`
                    : imports.problem;
    const location = source ?? deprecated ?? '';
    return {
      alias,
      ...(parsed.storage === 'contained' ? { path: location } : {}),
      ...(declaration.description !== undefined ? { description: declaration.description } : {}),
      ...(problem ? { problem } : {}),
      use: imports.use,
      ...(as !== undefined ? { as } : {}),
      source: parsed.source,
      storage: parsed.storage,
      deprecatedPath: deprecated !== undefined,
    };
  });
}

/**
 * project_config.isPart — whether this is a non-contained part's
 * configuration: `partOf` is set. The test every reader that treats such a
 * root differently from a project's asks, so they cannot disagree about it.
 */
export function isPart(config: Pick<ProjectConfig, 'partOf'> | null | undefined): boolean {
  return config?.partOf !== undefined;
}

/** internalize_destination — where a member's own metadata goes when `member internalize` folds it into its parent (stage 6). */
export interface InternalizeDestination {
  /** The parent subsystem that receives the member's metadata. */
  home: string;
  /** The member's packs: adopt | drop. */
  packs?: string;
  /** The member's L0 export names carried into the parent's L0. */
  exports?: string[];
}
