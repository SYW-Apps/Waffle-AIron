// Stamp (or check) the wairon version in every agent-tool plugin manifest.
//
// The plugin pins the MCP server to one published CLI (`npx -y @wairon/cli@<v>`),
// and each tool's manifest and marketplace entry carries the same version. The
// stamp runs when a stable release is prepared; the Release workflow runs the
// check on a stable tag and fails when a manifest names another version.
//
// Usage:
//   node scripts/plugin/stamp-version.mjs <version>          rewrite every file
//   node scripts/plugin/stamp-version.mjs --check <version>  exit 1 on a mismatch
//   node scripts/plugin/stamp-version.mjs --check            every file agrees
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Every file that carries the version, relative to the repository root. */
export const VERSIONED_FILES = [
  'plugins/wairon/.claude-plugin/plugin.json',
  'plugins/wairon/.codex-plugin/plugin.json',
  'plugins/wairon/.cursor-plugin/plugin.json',
  'plugins/wairon/plugin.json',
  'plugins/wairon/gemini-extension.json',
  'plugins/wairon/.mcp.json',
  'plugins/wairon/mcp.json',
  'plugins/wairon/mcp_config.json',
  '.claude-plugin/marketplace.json',
];

const VERSION_FIELD = /("version"\s*:\s*")([^"]*)(")/g;
const CLI_PIN = /(@wairon\/cli@)([0-9A-Za-z.+-]+)/g;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The versions one file's text names (manifest fields and CLI pins). */
export function versionsIn(text) {
  const found = [];
  for (const m of text.matchAll(VERSION_FIELD)) found.push(m[2]);
  for (const m of text.matchAll(CLI_PIN)) found.push(m[2]);
  return found;
}

/** The file's text with every manifest version and CLI pin set to `version`. */
export function stamp(text, version) {
  return text
    .replace(VERSION_FIELD, (_all, open, _old, close) => open + version + close)
    .replace(CLI_PIN, (_all, prefix) => prefix + version);
}

function main(argv) {
  const check = argv[0] === '--check';
  const version = check ? argv[1] : argv[0];
  if (!check && !version) {
    console.error('usage: stamp-version.mjs <version> | --check [version]');
    return 2;
  }
  if (version !== undefined && !SEMVER.test(version)) {
    console.error(`"${version}" is not a version (expected e.g. 6.7.4)`);
    return 2;
  }

  const seen = new Map();
  for (const rel of VERSIONED_FILES) {
    const file = path.join(ROOT, rel);
    const text = fs.readFileSync(file, 'utf8');
    const found = versionsIn(text);
    if (found.length === 0) {
      console.error(`${rel}: names no version`);
      return 1;
    }
    if (check) {
      for (const v of found) seen.set(v, [...(seen.get(v) ?? []), rel]);
      continue;
    }
    const next = stamp(text, version);
    if (next !== text) fs.writeFileSync(file, next);
  }

  if (!check) {
    console.log(`plugin manifests stamped ${version} (${VERSIONED_FILES.length} files)`);
    return 0;
  }
  const versions = [...seen.keys()];
  if (versions.length === 1 && (version === undefined || versions[0] === version)) {
    console.log(`plugin manifests all name ${versions[0]}`);
    return 0;
  }
  for (const [v, where] of seen) console.error(`${v}: ${[...new Set(where)].join(', ')}`);
  console.error(version === undefined ? 'plugin manifests disagree' : `plugin manifests must all name ${version}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
