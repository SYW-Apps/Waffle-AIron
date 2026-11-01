import * as os from 'os';
import * as path from 'path';
import { files } from '../io/index.js';
import { withFileLock } from '../utils/file-lock.js';
import { replaceFile } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// User-level CLI config
//
// Stored at: ~/.wairon/config.json
// Created on first write; all fields are optional. Every setter is one
// read-change-write under the file's write lock, so two wairon processes
// setting different fields at once both keep theirs.
// ---------------------------------------------------------------------------

export type UpdateChannel = 'stable' | 'beta' | 'preview' | 'dev';

/** Every channel, narrowest first — the order `wairon update --channel` accepts. */
export const UPDATE_CHANNELS: UpdateChannel[] = ['stable', 'beta', 'preview', 'dev'];

export function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as string[]).includes(value);
}

export interface UserConfig {
  /** Which release channel to track for updates. Default: 'stable' */
  channel?: UpdateChannel;
  /**
   * Aliases that the user has explicitly disabled.
   * All aliases in SUPPORTED_ALIASES are active by default; add names here to
   * opt out. This only affects binary installations (pkg builds). When installed
   * via npm, the bin entries in package.json are always registered.
   */
  disabledAliases?: string[];
  /** The wairon version whose release notes were last shown on this machine. */
  lastSeenVersion?: string;
}

const CONFIG_DIR = path.join(os.homedir(), '.wairon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadUserConfig(): UserConfig {
  try {
    if (files.exists(CONFIG_FILE)) {
      return JSON.parse(files.readText(CONFIG_FILE)) as UserConfig;
    }
  } catch {
    // Corrupt or unreadable — return defaults
  }
  return {};
}

/** The settings folder, made on the first write: the lock files sit beside the settings in it. */
function ensureConfigDir(): void {
  if (!files.exists(CONFIG_DIR)) {
    files.ensureDir(CONFIG_DIR);
  }
}

export function saveUserConfig(config: UserConfig): void {
  ensureConfigDir();
  // A temp file of this writer's own renamed over the old one: a concurrent read never sees half a file.
  replaceFile(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function setChannel(channel: UpdateChannel): void {
  ensureConfigDir();
  withFileLock(CONFIG_FILE, () => {
    const config = loadUserConfig();
    config.channel = channel;
    saveUserConfig(config);
  });
}

export function getChannel(): UpdateChannel {
  // A hand-edited or future-version config can carry a channel this build does
  // not know. Fall back to the narrowest channel rather than letting an
  // unrecognized value widen what a stable install is willing to install.
  const channel = loadUserConfig().channel;
  return channel && isUpdateChannel(channel) ? channel : 'stable';
}

export function getDisabledAliases(): string[] {
  return loadUserConfig().disabledAliases ?? [];
}

export function setDisabledAliases(names: string[]): void {
  ensureConfigDir();
  withFileLock(CONFIG_FILE, () => {
    const config = loadUserConfig();
    config.disabledAliases = names;
    saveUserConfig(config);
  });
}

/** The version whose release notes were last shown here, or null when none was. */
export function lastSeenVersion(): string | null {
  const seen = loadUserConfig().lastSeenVersion;
  return typeof seen === 'string' && seen.length > 0 ? seen : null;
}

/** Record the version whose release notes were just shown, leaving every other setting untouched. */
export function setLastSeenVersion(version: string): void {
  ensureConfigDir();
  withFileLock(CONFIG_FILE, () => {
    const config = loadUserConfig();
    config.lastSeenVersion = version;
    saveUserConfig(config);
  });
}
