import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// User-level CLI config
//
// Stored at: ~/.wairon/config.json
// Created on first write; all fields are optional.
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
}

const CONFIG_DIR = path.join(os.homedir(), '.wairon');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function loadUserConfig(): UserConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) as UserConfig;
    }
  } catch {
    // Corrupt or unreadable — return defaults
  }
  return {};
}

export function saveUserConfig(config: UserConfig): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

export function setChannel(channel: UpdateChannel): void {
  const config = loadUserConfig();
  config.channel = channel;
  saveUserConfig(config);
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

export function setDisabledAliases(disabled: string[]): void {
  const config = loadUserConfig();
  config.disabledAliases = disabled;
  saveUserConfig(config);
}
