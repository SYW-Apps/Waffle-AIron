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
};

export function defaultTargetConfig(type: 'claude' | 'gemini'): BuiltinTargetConfig {
  return {
    type,
    outputDir: DEFAULT_TARGET_DIRS[type],
    enabled: true,
  };
}

// ---------------------------------------------------------------------------
// waffagent CLI version embedded at build time
// ---------------------------------------------------------------------------

export const WAFFAGENT_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// GitHub repository (owner/repo) — used by the update command
// ---------------------------------------------------------------------------

export const GITHUB_REPO = 'SYW-Apps/waffagent';

// ---------------------------------------------------------------------------
// The name of the architect agent created during init
// ---------------------------------------------------------------------------

export const ARCHITECT_AGENT_ID = 'agent-architect';
export const ARCHITECT_TEMPLATE_ID = 'architect';

// ---------------------------------------------------------------------------
// Global templates directory
//
// Resolution order for templates:
//   1. Project-local:  .ai/templates/<id>.yaml
//   2. Global user/org: WAFFAGENT_TEMPLATES_DIR or globalTemplatesDir in project.yaml
//                       or ~/.waffagent/templates/<id>.yaml
//   3. Built-in:        <package>/dist/templates/<id>.yaml
// ---------------------------------------------------------------------------

export function globalTemplatesDir(projectOverride?: string): string {
  // 1. Environment variable
  if (process.env.WAFFAGENT_TEMPLATES_DIR) {
    return process.env.WAFFAGENT_TEMPLATES_DIR;
  }
  // 2. Project config override
  if (projectOverride) {
    return projectOverride;
  }
  // 3. Default ~/.waffagent/templates
  return path.join(os.homedir(), '.waffagent', 'templates');
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
