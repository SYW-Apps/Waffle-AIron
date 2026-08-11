/**
 * The rule-matrix INVARIANT: every finding code the validator can emit must be
 * pinned by at least one TRIGGERING fixture (and, once it has one, a CONTROL
 * fixture) — or be explicitly listed in tests/rules-matrix/ratchet.json as
 * not-yet-covered debt.
 *
 * The ratchet only moves one way:
 *  - a code that is neither fixture-covered nor ratcheted FAILS here — so a
 *    NEW rule (builtin or pack assertion) without fixtures turns CI red the
 *    moment it starts emitting a new code;
 *  - a ratchet entry whose code IS now covered FAILS here as stale — covering
 *    a code forces its entry to be deleted, so the file only shrinks;
 *  - growing the file back requires editing ratchet.json in a commit, which a
 *    reviewer sees as exactly what it is: deleting test coverage.
 *
 * The universe is built from the REAL rule registry (buildRuleContext's
 * knownIssueCodes) with the test fixture pack loaded, so pack-namespaced
 * assertion codes are enforced on the same terms as builtins.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRuleContext } from '../../src/core/rules/index.js';
import { loadExtensions } from '../../src/core/extensions.js';
import type { SystemSpec } from '../../src/models/index.js';
import { collectRuleFixtures } from './collect.js';
import { FIXTURE_PACK_DIR, FIXTURE_PACK_NAME } from './harness.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RATCHET_FILE = path.join(__dirname, 'ratchet.json');

interface Ratchet {
  uncoveredFire: string[];
  uncoveredControl: string[];
}

// ---------------------------------------------------------------------------
// Inputs: the enforced code universe, the collected fixtures, the ratchet.
// ---------------------------------------------------------------------------

const extensions = loadExtensions([FIXTURE_PACK_DIR], REPO_ROOT);

const probeSystem = {
  schemaVersion: '1.0.0',
  name: 'rule-matrix-meta-probe',
  vision: 'Minimal L0 used only to build a rule context and read knownIssueCodes.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as SystemSpec;

const universe = buildRuleContext({
  system: probeSystem,
  subsystems: [],
  components: [],
  interfaces: [],
  implementations: [],
  types: [],
  projectType: 'backend',
  extensions,
  issues: [],
}).knownIssueCodes;

const fixtures = collectRuleFixtures().map((c) => c.fixture);
const fireCovered = new Set(fixtures.filter((f) => f.expectFire).map((f) => f.code));
const controlCovered = new Set(fixtures.filter((f) => !f.expectFire).map((f) => f.code));

const ratchet: Ratchet = JSON.parse(fs.readFileSync(RATCHET_FILE, 'utf8'));

const HOW_TO =
  `Fix: add a fire+control fixture pair for the code in tests/rules-matrix/families/ ` +
  `(see tests/rules-matrix/README.md), or — only for pre-existing debt — list the code in ratchet.json. ` +
  `Never grow ratchet.json to make a covered code uncovered again.`;

describe('rule-matrix invariant (meta)', () => {
  it('the test fixture pack loads — its namespaced codes are part of the enforced universe', () => {
    expect(extensions.errors, 'the rule-matrix fixture pack failed to load; the pack half of the universe would silently vanish').toEqual([]);
    expect(extensions.packNames).toContain(FIXTURE_PACK_NAME);
    expect(
      [...universe].some((c) => c.startsWith('LEDGER_PLATFORM_')),
      'expected the ledger-platform pack assertion codes inside knownIssueCodes',
    ).toBe(true);
  });

  it('every fixture targets a code the validator can actually emit', () => {
    const unknown = [...new Set(fixtures.map((f) => f.code))].filter((c) => !universe.has(c)).sort();
    expect(
      unknown,
      `These fixture codes are not in knownIssueCodes — typo, or the rule was removed. A control for a ` +
      `misspelled code would pass forever without guarding anything.`,
    ).toEqual([]);
  });

  // ---- fire coverage ------------------------------------------------------

  it('every emittable code has a triggering fixture or an explicit ratchet entry', () => {
    const ratcheted = new Set(ratchet.uncoveredFire);
    const missing = [...universe].filter((c) => !fireCovered.has(c) && !ratcheted.has(c)).sort();
    expect(
      missing,
      `These codes have NO triggering fixture and NO ratchet entry (did you add a rule or pack assertion?). ${HOW_TO}`,
    ).toEqual([]);
  });

  it('the fire ratchet holds no stale entries (covered codes must be deleted from it)', () => {
    const stale = ratchet.uncoveredFire.filter((c) => fireCovered.has(c)).sort();
    expect(
      stale,
      `These ratchet.uncoveredFire entries are now fixture-covered — delete them from ratchet.json so coverage can only go up.`,
    ).toEqual([]);
  });

  it('the fire ratchet lists only real codes', () => {
    const unknown = ratchet.uncoveredFire.filter((c) => !universe.has(c)).sort();
    expect(
      unknown,
      `These ratchet.uncoveredFire entries are not in knownIssueCodes — remove them (the rule is gone or the code was renamed).`,
    ).toEqual([]);
  });

  // ---- control coverage ---------------------------------------------------
  // A code owes a control fixture as soon as it has a fire fixture: the pair
  // is the contract. Codes with no fire fixture at all live in uncoveredFire,
  // not here.

  it('every fire-covered code has a control fixture or an explicit ratchet entry', () => {
    const ratcheted = new Set(ratchet.uncoveredControl);
    const missing = [...universe]
      .filter((c) => fireCovered.has(c) && !controlCovered.has(c) && !ratcheted.has(c))
      .sort();
    expect(
      missing,
      `These codes have a triggering fixture but NO control fixture. A rule nobody can silence is as broken as ` +
      `one that never fires — add the near-identical quiet twin. ${HOW_TO}`,
    ).toEqual([]);
  });

  it('the control ratchet holds no stale entries', () => {
    const stale = ratchet.uncoveredControl.filter((c) => controlCovered.has(c) || !fireCovered.has(c)).sort();
    expect(
      stale,
      `These ratchet.uncoveredControl entries are stale (the code gained a control fixture, or lost its fire ` +
      `fixture and belongs in uncoveredFire) — update ratchet.json.`,
    ).toEqual([]);
  });

  it('the control ratchet lists only real codes', () => {
    const unknown = ratchet.uncoveredControl.filter((c) => !universe.has(c)).sort();
    expect(unknown, `These ratchet.uncoveredControl entries are not in knownIssueCodes — remove them.`).toEqual([]);
  });

  // ---- ratchet file hygiene ----------------------------------------------

  it('ratchet lists are sorted and duplicate-free (one-line-per-code diffs)', () => {
    for (const key of ['uncoveredFire', 'uncoveredControl'] as const) {
      const list = ratchet[key];
      const canonical = [...new Set(list)].sort();
      expect(list, `ratchet.json ${key} must be sorted and unique — keeps every ratchet change a minimal, reviewable diff`).toEqual(canonical);
    }
  });
});
