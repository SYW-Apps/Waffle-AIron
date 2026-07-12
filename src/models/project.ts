import { z } from 'zod';
import { CustomTargetSchema } from './agent.js';

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
  /** Maximum number of narrative steps allowed in a single method implementation */
  maxNarrativeSteps: z.number().int().nonnegative().optional(),
  /** Maximum number of direct components allowed in a single subsystem */
  maxSubsystemComponents: z.number().int().nonnegative().optional(),
});
export type ComplexityRuleConfig = z.infer<typeof ComplexityRuleConfigSchema>;

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
});

export type RulesConfig = z.infer<typeof RulesConfigSchema>;

export const PathsConfigSchema = z.object({
  /** Base directory containing SDD specification files, relative to project root */
  specsDir: z.string().default('.wai/specs'),
});
export type PathsConfig = z.infer<typeof PathsConfigSchema>;

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
   * Extension packs — wairon's plugin surface. Each entry is a relative path
   * to a declarative YAML pack (custom profiles + language/platform tables)
   * or a requireable JS module id (which may also inject SddRule[] `rules`).
   * Loaded identically by CLI and MCP at validation time.
   */
  extensions: z.object({
    packs: z.array(z.string()).default([]),
    /**
     * Whether to also load machine-wide packs from the global folder
     * (WAIRON_PACKS_DIR or ~/.wairon/packs). Default true; set false for
     * strict reproducibility (only committed project packs apply).
     */
    useGlobalPacks: z.boolean().default(true),
  }).optional(),

  paths: PathsConfigSchema.default({}),

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
