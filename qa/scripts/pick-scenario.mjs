#!/usr/bin/env node
// Pick a seat's scenario for a release, deterministically.
//
//   node qa/scripts/pick-scenario.mjs <release-version> <qa/seats/seat.md>
//
// The rule is (major + minor + patch) mod bank size, over the numbered rows of the
// brief's "Scenario bank" table. The same release always gets the same scenario,
// and consecutive releases walk the bank instead of repeating one app.
import * as fs from 'node:fs';

const [version, file] = process.argv.slice(2);
const v = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
if (!v || !file) {
  console.error('usage: pick-scenario.mjs <major.minor.patch> <seat-brief.md>');
  process.exit(2);
}
const text = fs.readFileSync(file, 'utf8');
const bank = text.slice(text.indexOf('## Scenario bank'));
const rows = [...bank.matchAll(/^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)]
  .map((m) => ({ index: Number(m[1]), name: m[2], what: m[3] }));
if (!rows.length) {
  console.error(`${file} has no numbered rows under "## Scenario bank"`);
  process.exit(2);
}
const index = (Number(v[1]) + Number(v[2]) + Number(v[3])) % rows.length;
const pick = rows.find((r) => r.index === index);
if (!pick) {
  console.error(`${file}: the bank has no row numbered ${index}`);
  process.exit(2);
}
console.log(`${pick.index}: ${pick.name} - ${pick.what}`);
