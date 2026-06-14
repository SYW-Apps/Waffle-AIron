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
   * Severity overrides for SDD validation rules.
   * Key: rule code (e.g. CIRCULAR_DEPENDENCY), Value: error | warning | off
   */
  sddRuleSeverity: z.record(z.enum(['error', 'warning', 'off'])).default({}),
});
export type RulesConfig = z.infer<typeof RulesConfigSchema>;

export const GitConfigSchema = z.object({
  /**
   * Whether wairon is allowed to run git commands (create branches, worktrees,
   * merge, etc.). Must be explicitly set to true — default is false.
   */
  waironManaged: z.boolean().default(false),

  /**
   * Whether wairon should auto-merge worktree branches after validation.
   * Default: false — wairon prepares the merge but waits for human approval.
   */
  autoMerge: z.boolean().default(false),

  /**
   * Base directory for worktrees, relative to project root.
   * Default: .wai/worktrees
   */
  worktreeBase: z.string().default('.wai/worktrees'),

  /**
   * Branch names that wairon will never auto-merge into without explicit
   * user confirmation, even when autoMerge is true.
   */
  protectedBranches: z.array(z.string()).default(['main', 'master', 'develop']),
});
export type GitConfig = z.infer<typeof GitConfigSchema>;

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

  /** Optional short description of this project */
  description: z.string().optional(),

  /**
   * Active output targets. At least one must be enabled.
   * Configured during `wairon init` and editable afterward.
   */
  targets: z.array(TargetConfigSchema).default([]),

  rules: RulesConfigSchema.default({}),

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
   * Default AI backend for wairon delegate commands.
   * Can be overridden per-domain or per-command.
   */
  defaultBackend: z.enum(['claude', 'gemini', 'ollama', 'openai', 'custom']).default('claude'),

  /**
   * Default bundle id applied to every domain during init / scaffold-domains.
   * Users can override per-domain at scaffold time.
   */
  defaultBundle: z.string().optional(),

  /**
   * Profile id to use for this project (overrides the global activeProfile).
   * e.g. "work" or "personal"
   */
  profile: z.string().optional(),

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

  /**
   * Git integration settings.
   * waironManaged must be true before wairon will run any git commands.
   */
  git: GitConfigSchema.optional(),

  /**
   * Waffler integration settings.
   * When set, `wairon waffler session` connects to the Waffler MCP server
   * to let AI agents build and manage Waffler blueprints.
   */
  waffler: z.object({
    /**
     * URL of the Waffler MCP server endpoint.
     * If omitted, wairon tries the local default (localhost:42069/_mcp)
     * and prompts for a custom URL if unreachable.
     * Set explicitly to skip auto-detection, e.g. for a remote instance.
     */
    mcpServerUrl: z.string().optional(),
  }).optional(),

  /** Created by wairon at init time */
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
