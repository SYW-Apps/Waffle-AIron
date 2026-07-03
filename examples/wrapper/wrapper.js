#!/usr/bin/env node
/*
 * ADVANCED path: embedding wairon as a library — e.g. to build a branded
 * gate binary with its doctrine compiled in. Most wrapper products do NOT
 * need this: ship packs + install.js instead (the packs are injected once
 * and plain `wairon validate` enforces them from then on).
 *
 * Run from the repo root after `npm run build`:
 *   node examples/wrapper/wrapper.js [path-to-project]
 * (defaults to ./demo-project)
 *
 * Embedding requires a built checkout of this repo as a `file:` dependency
 * (wairon is distributed as standalone CLI binaries, not on npm).
 */
const path = require('path');
const wairon = require('../../dist/index.js');

const projectDir = path.resolve(process.argv[2] ?? path.join(__dirname, 'demo-project'));
wairon.setProjectRoot(projectDir);

// The wrapper owns its doctrine, so the packs are injected programmatically —
// the target project does not have to list them itself. (Projects can ALSO
// self-serve via `.wai/project.yaml → extensions.packs`; the demo project
// shows that path. An explicitly passed `extensions` takes precedence over
// config auto-loading.)
const extensions = wairon.loadExtensions(
  [
    path.join(__dirname, 'packs', 'flowops.yaml'),
    path.join(__dirname, 'packs', 'flowops-rules.cjs'),
  ],
  projectDir,
);
for (const err of extensions.errors) {
  console.error(`pack load failed: ${err}`);
  process.exit(2);
}

const result = wairon.validateSddTree({ extensions });

const errors = result.issues.filter((i) => i.severity === 'error');
const warnings = result.issues.filter((i) => i.severity === 'warning');
console.log(`FlowOps Enforcer — ${projectDir}`);
console.log(`${errors.length} error(s), ${warnings.length} warning(s)\n`);
for (const i of [...errors, ...warnings]) {
  console.log(`  [${i.severity}] ${i.code}${i.specId ? ` (${i.specId})` : ''} — ${i.message}`);
}
if (errors.length === 0 && warnings.length === 0) {
  console.log('  clean — specs conform to the FlowOps doctrine.');
}
process.exit(errors.length ? 1 : 0);
