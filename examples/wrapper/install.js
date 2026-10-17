#!/usr/bin/env node
/*
 * An installer a wrapper product can ship — the vendoring path: a release
 * contains the pack files plus this script, which injects them through the
 * user's existing wairon installation (`@wairon/cli` from npm, or a release
 * binary). The other path is a `.wpack` archive the user installs with
 * `wairon pack install` and selects per project with `wairon pack use`. Injection is a one-time act — afterwards
 * plain `wairon validate` (and the MCP server's sdd_validate_tree) enforce
 * the doctrine, and this script leaves nothing behind.
 *
 *   node install.js [path-to-project]     vendor into that project (.wai/packs/)
 *   node install.js --global              machine-wide (~/.wairon/packs); a
 *                                         project still has to select it
 *
 * Everything it does the user can equally do by hand:
 *   wairon pack add packs/flowops.yaml
 *   wairon pack add packs/flowops-rules.cjs
 * Undo with `wairon pack remove <name> [--global]`.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const isGlobal = args.includes('--global');
const target = args.find((a) => a !== '--global');

// In a shipped ZIP this is simply the `wairon` binary on PATH:
//   spawnSync('wairon', ['pack', 'add', pack, ...])
// Inside this repo we call the built CLI directly (run `npm run build` first).
const cli = path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

const packs = ['flowops.yaml', 'flowops-rules.cjs'].map((f) => path.join(__dirname, 'packs', f));
for (const pack of packs) {
  const res = spawnSync(
    process.execPath,
    [cli, 'pack', 'add', pack, ...(isGlobal ? ['--global'] : [])],
    { stdio: 'inherit', cwd: target ? path.resolve(target) : process.cwd() },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
}
console.log('\nFlowOps doctrine installed. Run `wairon validate` to enforce it.');
