#!/usr/bin/env node
// The release QA gate's CI check (see docs/release-qa.md).
//
//   node qa/scripts/check-verdict.mjs [--dir qa/verdicts] [--head HEAD]
//
// Run in a git checkout of the pull request's HEAD with full history. Passes when
// at least one verdict file in --dir satisfies all three:
//   1. its front matter says `result: PASS`;
//   2. its `rc` commit is an ancestor of --head;
//   3. nothing that changes the shipped product moved between `rc` and --head.
// Lock records, docs, CHANGELOG, qa/ and regenerated .wai/ context may change after
// the RC; a change below a SHIPPED path means the QA has to run again.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Paths that make up the shipped product. A change here invalidates a verdict.
const SHIPPED = [/^src\//, /^web\//, /^sdk\//, /^schemas\//, /(^|\/)templates(\/|$)/, /^package\.json$/, /^package-lock\.json$/];

// The release bot's version stamp after every merge into dev: never a product change.
const RELEASE_SUBJECT = /^chore: release v\S+$/;
const VERSION_FILE = 'src/config/defaults.ts';

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : dflt);
const dir = opt('dir', 'qa/verdicts');
const head = opt('head', 'HEAD');

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitOk = (...args) => { try { git(...args); return true; } catch { return false; } };

/** Top-level scalar keys of the YAML front matter (all this check needs). */
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  for (const line of (m ? m[1] : '').split(/\r?\n/)) {
    const kv = /^([A-Za-z]+):\s*(.*?)\s*$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

/**
 * The shipped files the commits after the RC changed, read commit by commit. The
 * release bot's own commits (`chore: release v...` touching only the version
 * constant) stamp the version every merge into dev produces, so they never count.
 */
function shippedChanges(rc) {
  const log = git('log', '--no-merges', '--format=%x00%s', '--name-only', `${rc}..${head}`);
  const moved = new Set();
  for (const entry of log.split('\0').filter((e) => e.trim())) {
    const [subject, ...rest] = entry.split('\n');
    const files = rest.map((f) => f.trim()).filter(Boolean);
    if (RELEASE_SUBJECT.test(subject) && files.every((f) => f === VERSION_FILE)) continue;
    for (const f of files) if (SHIPPED.some((re) => re.test(f))) moved.add(f);
  }
  return [...moved];
}

/** Why this verdict does not clear the PR, or null when it does. */
function problem(file) {
  const v = frontMatter(fs.readFileSync(file, 'utf8'));
  if (v.result !== 'PASS') return `result is "${v.result ?? 'missing'}", not PASS`;
  if (!/^[0-9a-f]{40}$/.test(v.rc ?? '')) return 'rc is not a full 40-character commit sha';
  if (!gitOk('cat-file', '-e', `${v.rc}^{commit}`)) return `rc ${v.rc} is not in this checkout (fetch full history)`;
  if (!gitOk('merge-base', '--is-ancestor', v.rc, head)) return `rc ${v.rc} is not an ancestor of ${head}`;
  const moved = shippedChanges(v.rc);
  if (moved.length) return `${moved.length} shipped file(s) changed after the RC, so the QA has to run again: ${moved.slice(0, 5).join(', ')}`;
  return null;
}

const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').sort()
  : [];
if (!files.length) {
  console.error(`FAIL: no verdict file in ${dir}/ (see docs/release-qa.md)`);
  process.exit(1);
}
const results = files.map((f) => [f, problem(path.join(dir, f))]);
for (const [f, why] of results) console.log(`${why ? 'no ' : 'OK '} ${f}${why ? `: ${why}` : ''}`);
if (results.some(([, why]) => !why)) process.exit(0);
console.error(`FAIL: no verdict in ${dir}/ clears this pull request`);
process.exit(1);
