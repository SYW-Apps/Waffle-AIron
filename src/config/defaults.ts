import * as os from 'os';
import * as path from 'path';
import { BuiltinTargetConfig } from '../models/project.js';

// ---------------------------------------------------------------------------
// Default output directory locations for each supported target
//
// These match the conventional directories used by each tool.
// Users can override these in project.yaml.
// ---------------------------------------------------------------------------

export const DEFAULT_TARGET_DIRS: Record<string, string> = {
  claude: '.claude/agents',
  gemini: '.gemini/agents',
  agy: '.gemini/agents',
  cursor: '.cursor/rules',
  copilot: '.github/prompts',
  codex: '.codex/agents',
};

export function defaultTargetConfig(type: 'claude' | 'gemini' | 'agy' | 'cursor' | 'copilot' | 'codex'): BuiltinTargetConfig {
  return {
    type,
    outputDir: DEFAULT_TARGET_DIRS[type],
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// waffle-airon CLI version embedded at build time
// ---------------------------------------------------------------------------

export const WAIRON_VERSION = '2.2.7';

// ---------------------------------------------------------------------------
// GitHub repository (owner/repo) — used by the update command
// ---------------------------------------------------------------------------

export const GITHUB_REPO = 'SYW-Apps/Waffle-AIron';

// ---------------------------------------------------------------------------
// The name of the architect agent created during init
// ---------------------------------------------------------------------------

export const ARCHITECT_AGENT_ID = 'agent-architect';
export const ARCHITECT_TEMPLATE_ID = 'architect';

// ---------------------------------------------------------------------------
// Global templates directory
//
// Resolution order for templates:
//   1. Project-local:  .wai/templates/<id>.yaml
//   2. Global user/org: WAIRON_TEMPLATES_DIR or globalTemplatesDir in project.yaml
//                       or ~/.wairon/templates/<id>.yaml
//   3. Built-in:        <package>/dist/templates/<id>.yaml
// ---------------------------------------------------------------------------

export function globalTemplatesDir(projectOverride?: string): string {
  // 1. Environment variable
  if (process.env.WAIRON_TEMPLATES_DIR) {
    return process.env.WAIRON_TEMPLATES_DIR;
  }
  // 2. Project config override
  if (projectOverride) {
    return projectOverride;
  }
  // 3. Default ~/.wairon/templates
  return path.join(os.homedir(), '.wairon', 'templates');
}

// ---------------------------------------------------------------------------
// Backend CLI commands
// Maps backend names to the shell command used to spawn them.
// ---------------------------------------------------------------------------

export const BACKEND_COMMANDS: Record<string, string> = {
  claude: 'claude',
  gemini: 'gemini',
};

export function backendCommand(backend: string): string {
  return BACKEND_COMMANDS[backend] ?? backend;
}

// ---------------------------------------------------------------------------
// Command aliases
//
// SUPPORTED_ALIASES — every short name wairon can be reached under.
// These are registered in package.json `bin` for npm installs, and created
// as symlinks / .cmd wrappers for binary installs.
// Users can disable any alias via `wairon aliases disable <name>`.
// ---------------------------------------------------------------------------

export const SUPPORTED_ALIASES = ['wai'] as const;
export type SupportedAlias = (typeof SUPPORTED_ALIASES)[number];

// ---------------------------------------------------------------------------
// Directories to exclude from domain detection scanning
// ---------------------------------------------------------------------------

export const SCAN_EXCLUDE_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.git',
  '.cache',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',   // Rust
  'vendor',
]);
