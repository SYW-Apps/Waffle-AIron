import { processes } from '../io/index.js';

// ---------------------------------------------------------------------------
// agent_plugin_adapter — the AI tools' own plugin listings
//
// Claude Code (`claude plugin list --json`) and Codex (`codex plugin list --json`)
// answer which plugins are installed and enabled. This asks them whether the
// wairon plugin is one. Reads only; holds no state; never throws, because it
// runs inside init and doctor and a broken tool must not break them.
// ---------------------------------------------------------------------------

/** plugin_presence — what a tool's own plugin listing says about the wairon plugin. */
export type PluginPresence = 'enabled' | 'absent' | 'unknown';

/** How long a listing may take before it is read as unknown. */
const LISTING_TIMEOUT_MS = 5000;

/** The tools that answer `plugin list --json`, by target type: target type -> command. */
const LISTING_COMMANDS: Readonly<Record<string, string>> = { claude: 'claude', codex: 'codex' };

/** Run a tool's listing; the output text, or null when it did not run or did not succeed. */
function runListing(command: string): string | null {
  const args = ['plugin', 'list', '--json'];
  const options = { timeout: LISTING_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] as ('ignore' | 'pipe')[] };
  try {
    return processes.run(command, args, options);
  } catch (err) {
    // On Windows a command can be a .cmd shim, which a program run (no shell) cannot start.
    if (process.platform === 'win32' && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        return processes.runShell(`${command} ${args.join(' ')}`, options);
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** The plugin entries of a listing: a bare array (Claude Code) or an `installed`/`plugins` array in an object (Codex). */
function listingEntries(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj['installed'])) return obj['installed'];
    if (Array.isArray(obj['plugins'])) return obj['plugins'];
  }
  return null;
}

/** Whether one entry is the wairon plugin: name `wairon` or `wairon@<marketplace>`. */
function isWaironEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  const ids = [e['name'], e['id'], e['pluginId']].filter((v): v is string => typeof v === 'string');
  return ids.some((id) => id === 'wairon' || id.startsWith('wairon@'));
}

/**
 * agent_plugin_adapter.detectPlugin — whether the tool behind this target type lists the
 * wairon plugin as installed and enabled. Any other target type, a missing command, a failed
 * or slow listing and unreadable output answer unknown.
 */
export function detectPlugin(targetType: string): PluginPresence {
  const command = LISTING_COMMANDS[targetType];
  if (!command) return 'unknown';
  // The test environments' opt-out: never run a developer's real tool.
  if (process.env['WAIRON_NO_PLUGIN_DETECT']) return 'unknown';
  const out = runListing(command);
  if (out === null) return 'unknown';
  let entries: unknown[] | null;
  try {
    entries = listingEntries(JSON.parse(out));
  } catch {
    return 'unknown';
  }
  if (!entries) return 'unknown';
  const enabled = entries.some((e) => isWaironEntry(e) && (e as Record<string, unknown>)['enabled'] !== false);
  return enabled ? 'enabled' : 'absent';
}
