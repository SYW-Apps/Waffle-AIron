#!/usr/bin/env node
/*
 * The installer a wrapper product actually ships — the "unzip and run"
 * distribution model, no npm involved: a GitHub release ZIP contains the
 * pack files plus this script, which injects them through the user's
 * existing wairon installation. Injection is a one-time act — afterwards
 * plain `wairon validate` (and the MCP server's sdd_validate_tree) enforce
 * the doctrine, and this script leaves nothing behind.
 *
 *   node install.js [path-to-project]     vendor into that project (.wai/packs/)
 *   node install.js --global              machine-wide (~/.wairon/packs)
 *
 * Everything it does the user can equally do by hand:
 *   wairon packs add packs/flowops.yaml
 *   wairon packs add packs/flowops-rules.cjs
 * Undo with `wairon packs remove <name> [--global]`.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const isGlobal = args.includes('--global');
const target = args.find((a) => a !== '--global');

// In a shipped ZIP this is simply the `wairon` binary on PATH:
//   spawnSync('wairon', ['packs', 'add', pack, ...])
// Inside this repo we call the built CLI directly (run `npm run build` first).
const cli = path.join(__dirname, '..', '..', 'dist', 'cli', 'index.js');

const packs = ['flowops.yaml', 'flowops-rules.cjs'].map((f) => path.join(__dirname, 'packs', f));
for (const pack of packs) {
  const res = spawnSync(
    process.execPath,
    [cli, 'packs', 'add', pack, ...(isGlobal ? ['--global'] : [])],
    { stdio: 'inherit', cwd: target ? path.resolve(target) : process.cwd() },
  );
  if (res.status !== 0) process.exit(res.status ?? 1);
}
console.log('\nFlowOps doctrine installed. Run `wairon validate` to enforce it.');
