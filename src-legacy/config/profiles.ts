import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Profile system
//
// A profile bundles per-tool configuration (command alias + config directory)
// so users can separate concerns like work vs. personal. Profiles are stored
// in ~/.wairon/profiles.json and can be activated globally (userconfig) or
// per-project (project.yaml `profile` field).
//
// For each tool in a profile, wairon can:
//   - Store a custom command alias (e.g. "claude-work")
//   - Create a wrapper script in ~/.wairon/bin/ that sets the config dir env
//     var and execs the original tool
//   - Copy the tool's base config dir to a profile-specific location
// ---------------------------------------------------------------------------

export interface ToolProfile {
  /** The CLI command for this tool in this profile (e.g. "claude-work") */
  command: string;
  /**
   * Absolute path to the config directory for this tool/profile.
   * e.g. "/home/user/.claude-work"
   * Used when setting up wrapper scripts and copying config dirs.
   */
  configDir?: string;
  /**
   * Environment variable name to set pointing at configDir when the wrapper
   * script is invoked. Defaults: "CLAUDE_HOME" for claude, "GEMINI_CONFIG_DIR"
   * for gemini. Can be overridden here if a different env var is needed.
   */
  configEnvVar?: string;
}

export interface Profile {
  /** Unique short identifier, e.g. "work", "personal" */
  id: string;
  /** Human-readable name, e.g. "Work", "Personal" */
  name: string;
  /** Per-tool configuration keyed by tool name (claude, gemini, ...) */
  tools: Partial<Record<string, ToolProfile>>;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Default env vars per tool
// ---------------------------------------------------------------------------

export const TOOL_CONFIG_ENV_VARS: Record<string, string> = {
  claude: 'CLAUDE_HOME',
  gemini: 'GEMINI_CONFIG_DIR',
};

/** Default base config dirs (where the tool stores its data out of the box) */
export const TOOL_DEFAULT_CONFIG_DIRS: Record<string, string> = {
  claude: path.join(os.homedir(), '.claude'),
  gemini: path.join(os.homedir(), '.gemini'),
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const PROFILES_FILE = path.join(os.homedir(), '.wairon', 'profiles.json');

interface ProfilesFile {
  profiles: Profile[];
}

export function loadProfiles(): Profile[] {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf-8')) as ProfilesFile;
      return Array.isArray(raw.profiles) ? raw.profiles : [];
    }
  } catch {
    // corrupt or missing — return empty
  }
  return [];
}

export function saveProfiles(profiles: Profile[]): void {
  const dir = path.dirname(PROFILES_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROFILES_FILE, JSON.stringify({ profiles }, null, 2) + '\n', 'utf-8');
}

export function getProfile(id: string): Profile | undefined {
  return loadProfiles().find((p) => p.id === id);
}

export function addProfile(profile: Profile): void {
  const profiles = loadProfiles();
  if (profiles.some((p) => p.id === profile.id)) {
    throw new Error(`Profile "${profile.id}" already exists.`);
  }
  profiles.push(profile);
  saveProfiles(profiles);
}

export function updateProfile(updated: Profile): void {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.id === updated.id);
  if (idx === -1) throw new Error(`Profile "${updated.id}" not found.`);
  profiles[idx] = updated;
  saveProfiles(profiles);
}

export function deleteProfile(id: string): void {
  const profiles = loadProfiles();
  const idx = profiles.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Profile "${id}" not found.`);
  profiles.splice(idx, 1);
  saveProfiles(profiles);
}

// ---------------------------------------------------------------------------
// Resolve active profile + tool command
// ---------------------------------------------------------------------------

/**
 * Resolve the active profile for the current invocation.
 * Priority: project config `profile` field > global activeProfile in userconfig.
 * Returns null if no profile is set or the specified profile doesn't exist.
 */
export function resolveActiveProfile(projectProfileId?: string): Profile | null {
  // 1. Project-level override
  if (projectProfileId) {
    const p = getProfile(projectProfileId);
    if (p) return p;
  }

  // 2. Global active profile
  const { getActiveProfileId } = require('./userconfig.js') as typeof import('./userconfig.js');
  const globalId = getActiveProfileId();
  if (globalId) {
    const p = getProfile(globalId);
    if (p) return p;
  }

  return null;
}

/**
 * Resolve the CLI command to use for a given backend, taking the active profile
 * into account. Falls back to the default command if no profile is configured.
 */
export function resolveToolCommand(
  backend: string,
  projectProfileId?: string,
): string {
  const profile = resolveActiveProfile(projectProfileId);
  if (profile?.tools[backend]?.command) {
    return profile.tools[backend]!.command;
  }
  // Default commands
  const defaults: Record<string, string> = { claude: 'claude', gemini: 'gemini' };
  return defaults[backend] ?? backend;
}

// ---------------------------------------------------------------------------
// Wrapper script scaffolding
// ---------------------------------------------------------------------------

const WAIRON_BIN_DIR = path.join(os.homedir(), '.wairon', 'bin');

/**
 * Create a wrapper script for a tool/profile combination.
 * On Windows: creates a .cmd file.
 * On Unix: creates a bash script with chmod 755.
 *
 * Returns the path of the created script.
 */
export function createWrapperScript(
  toolName: string,
  toolProfile: ToolProfile,
): string {
  fs.mkdirSync(WAIRON_BIN_DIR, { recursive: true });

  const isWindows = process.platform === 'win32';
  const scriptName = isWindows ? `${toolProfile.command}.cmd` : toolProfile.command;
  const scriptPath = path.join(WAIRON_BIN_DIR, scriptName);

  const envVar = toolProfile.configEnvVar ?? TOOL_CONFIG_ENV_VARS[toolName] ?? '';
  const configDir = toolProfile.configDir ?? '';

  let content: string;

  if (isWindows) {
    content = [
      '@echo off',
      envVar && configDir ? `set "${envVar}=${configDir}"` : '',
      `${toolName} %*`,
    ].filter(Boolean).join('\r\n') + '\r\n';
  } else {
    content = [
      '#!/bin/bash',
      envVar && configDir ? `export ${envVar}="${configDir}"` : '',
      `exec ${toolName} "$@"`,
    ].filter(Boolean).join('\n') + '\n';
  }

  fs.writeFileSync(scriptPath, content, 'utf-8');

  if (!isWindows) {
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}

/**
 * Copy a tool's base config directory to a profile-specific location.
 * Does nothing if the destination already exists.
 * Returns 'copied' | 'skipped' | 'source-missing'.
 */
export function copyConfigDir(
  sourceDir: string,
  destDir: string,
): 'copied' | 'skipped' | 'source-missing' {
  if (!fs.existsSync(sourceDir)) return 'source-missing';
  if (fs.existsSync(destDir)) return 'skipped';
  fs.cpSync(sourceDir, destDir, { recursive: true });
  return 'copied';
}

export function waironBinDir(): string {
  return WAIRON_BIN_DIR;
}
