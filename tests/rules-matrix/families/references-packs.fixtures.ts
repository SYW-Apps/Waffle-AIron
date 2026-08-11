/**
 * Pack-selection resolution and reproducibility
 * (src/core/rules/pack-resolution.ts + src/core/rules/reproducibility.ts).
 *
 * Documented intents pinned here:
 *  - PACK_NOT_INSTALLED (error): a declared pack that is neither bundled under
 *    .wai/packs/ nor installed in this wairon install's pack store — a project
 *    whose declared doctrine is absent must be LOUD, never a silent skip.
 *  - PACK_VERSION_UNSATISFIED (error): the pack IS installed, but no installed
 *    version satisfies the selection's pin.
 *  - PACK_INTEGRITY_MISMATCH (error): the resolved content does not match the
 *    pinned integrity digest, recomputed from the files.
 *  - PACK_STORE_DRIFT (warning): a committed bundle and the store hold
 *    DIFFERENT content for the same name@version; the bundle applies and the
 *    store copy is silently ignored, which deserves saying.
 *  - UNPINNED_PACK_SELECTION (warning): under rules.enforceReproducibility
 *    (default true) a by-name selection with no version pin floats to whatever
 *    the machine has installed. Controls pin the version AND the documented
 *    explicit opt-out (enforceReproducibility: false).
 *  - PACK_SOURCE_UNFETCHABLE (warning): a selection that is neither bundled
 *    nor carries a fetchable source cannot be obtained by CI. Controls record
 *    a source AND use the documented BUNDLED exemption (committed bytes ARE
 *    the pin).
 *
 * Selections live in .wai/project.yaml, so these fixtures OVERWRITE the
 * harness-written project config through tree.files (files materialize after
 * the harness boilerplate; the replacement mirrors every harness field and
 * only adds `extensions.packs` entries).
 *
 * HERMETIC STORE: the pack store resolves via WAIRON_PACKS_DIR (the product's
 * own seam), which this module points at the committed store fixture
 * tests/rules-matrix/references-pack-store/ (carrier-doctrine@2.0.0) at import
 * time — BEFORE any fixture runs. Without this the store would be the
 * developer's real ~/.wairon/packs, making every store-dependent verdict
 * machine-dependent. Every fixture tree in this tier sets
 * `useGlobalPacks: false`, so the redirect affects ONLY by-name selection
 * resolution, which only this family exercises.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { defineRuleFixture } from '../harness.js';
import { computePackDigest } from '../../../src/core/packstore.js';

const STORE_DIR = path.resolve(__dirname, '..', 'references-pack-store');
process.env.WAIRON_PACKS_DIR = STORE_DIR;

const CARRIER_PACK_DIR = path.join(STORE_DIR, 'carrier-doctrine', '2.0.0');
/** The store copy's exact bytes — bundles that must NOT drift mirror these. */
const CARRIER_PACK_YAML = fs.readFileSync(path.join(CARRIER_PACK_DIR, 'pack.yaml'), 'utf8');
/** The store copy's content digest — the honest integrity pin. */
const CARRIER_PACK_DIGEST = computePackDigest(CARRIER_PACK_DIR);

const TS = '2026-01-01T00:00:00.000Z';

/**
 * Replacement .wai/project.yaml: the harness boilerplate plus the pack
 * selections under test (and optionally a rules override, mirrored into
 * tree.rules by the caller so the validator sees the same dial).
 */
function projectYaml(packs: Record<string, unknown>[], rules?: Record<string, unknown>): string {
  return yaml.dump(
    {
      schemaVersion: '1.0.0',
      name: 'rule-matrix-fixture',
      targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
      rules: {
        noOverlappingOwnership: true,
        requireOwnedPaths: true,
        metaAgentTags: ['meta', 'guardian', 'architect'],
        enforceReproducibility: true,
        ...(rules ?? {}),
      },
      extensions: { packs, useGlobalPacks: false },
      createdAt: TS,
      updatedAt: TS,
    },
    { noRefs: true, lineWidth: 200 },
  );
}

/** A tiny but real payout platform tree the pack governs. */
const payoutSpecs = {
  subsystems: [{ id: 'payouts', description: 'Merchant payout scheduling and carrier hand-off.' }],
  components: [
    {
      id: 'payout-scheduler',
      componentType: 'Orchestrator',
      subsystem: 'payouts',
      description: 'Schedules merchant payout runs across settlement carriers.',
    },
  ],
};

export default [
  // -------------------------------------------------------------------------
  // PACK_NOT_INSTALLED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PACK_NOT_INSTALLED',
    severity: 'error',
    expectFire: true,
    scenario:
      'The payout project declares the quota-doctrine pack, but it is neither bundled under .wai/packs/ nor installed in this wairon install\'s pack store.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'quota-doctrine', version: '1.2.0', source: 'https://packs.example.dev/quota-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_NOT_INSTALLED',
    expectFire: false,
    reason: 'The selection resolves from the committed bundle under .wai/packs/, so the project needs no machine setup at all.',
    scenario:
      'The payout project declares quota-doctrine and commits the pack as a bundle under .wai/packs/quota-doctrine/1.2.0/.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'quota-doctrine', version: '1.2.0', source: 'https://packs.example.dev/quota-doctrine-{version}.wpack' },
        ]),
        '.wai/packs/quota-doctrine/1.2.0/pack.yaml': 'name: quota-doctrine\nversion: 1.2.0\n',
      },
    },
  }),

  // -------------------------------------------------------------------------
  // PACK_VERSION_UNSATISFIED
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PACK_VERSION_UNSATISFIED',
    severity: 'error',
    expectFire: true,
    scenario:
      'The payout project pins carrier-doctrine at 3.1.0, but the store only has 2.0.0 installed, so no installed version satisfies the pin.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '3.1.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_VERSION_UNSATISFIED',
    expectFire: false,
    reason: 'The pin names 2.0.0, exactly the version the store has installed, so the selection resolves.',
    scenario:
      'The payout project pins carrier-doctrine at the 2.0.0 version this install actually has in its pack store.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '2.0.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // PACK_INTEGRITY_MISMATCH
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PACK_INTEGRITY_MISMATCH',
    severity: 'error',
    expectFire: true,
    scenario:
      'The payout project pins carrier-doctrine to an integrity digest, but the committed bundle was edited after pinning so its recomputed content digest no longer matches.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          {
            name: 'carrier-doctrine',
            version: '2.0.0',
            integrity: 'sha256-0000000000000000000000000000000000000000000000000000000000000000',
            source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack',
          },
        ]),
        '.wai/packs/carrier-doctrine/2.0.0/pack.yaml': CARRIER_PACK_YAML,
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_INTEGRITY_MISMATCH',
    expectFire: false,
    reason: 'The bundle content recomputes to exactly the pinned digest — a pin means "these bytes", and these are those bytes.',
    scenario:
      'The payout project pins carrier-doctrine to the digest of the exact bundled content it commits.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          {
            name: 'carrier-doctrine',
            version: '2.0.0',
            integrity: CARRIER_PACK_DIGEST,
            source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack',
          },
        ]),
        '.wai/packs/carrier-doctrine/2.0.0/pack.yaml': CARRIER_PACK_YAML,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // PACK_STORE_DRIFT
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PACK_STORE_DRIFT',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The payout project bundles a locally patched carrier-doctrine while the store holds different content for the same 2.0.0 version, so store edits silently have no effect here.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '2.0.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
        // The defect: same name@version as the store, different bytes.
        '.wai/packs/carrier-doctrine/2.0.0/pack.yaml': `${CARRIER_PACK_YAML}# locally patched copy awaiting upstream release\n`,
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_STORE_DRIFT',
    expectFire: false,
    reason: 'Bundle and store hold byte-identical content for carrier-doctrine@2.0.0, so nothing is being silently ignored.',
    scenario:
      'The payout project bundles carrier-doctrine with exactly the bytes the store holds for the same version.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '2.0.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
        '.wai/packs/carrier-doctrine/2.0.0/pack.yaml': CARRIER_PACK_YAML,
      },
    },
  }),

  // -------------------------------------------------------------------------
  // UNPINNED_PACK_SELECTION
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'UNPINNED_PACK_SELECTION',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The payout project selects carrier-doctrine without a version pin, so a clone or CI can validate the same tree against whatever version its machine happens to have installed.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          // The defect: no version pin, not bundled.
          { name: 'carrier-doctrine', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNPINNED_PACK_SELECTION',
    expectFire: false,
    reason: 'The selection pins an exact version, so every machine resolves the same rule set.',
    scenario:
      'The payout project pins carrier-doctrine at 2.0.0, making the selection reproducible on any clone or CI runner.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '2.0.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'UNPINNED_PACK_SELECTION',
    expectFire: false,
    reason: 'rules.enforceReproducibility: false is the documented explicit opt-out that silences the whole reproducibility family.',
    scenario:
      'The payout project floats its carrier-doctrine selection but has explicitly accepted the drift by turning enforceReproducibility off.',
    tree: {
      ...payoutSpecs,
      rules: { enforceReproducibility: false },
      files: {
        '.wai/project.yaml': projectYaml(
          [{ name: 'carrier-doctrine', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' }],
          { enforceReproducibility: false },
        ),
      },
    },
  }),

  // -------------------------------------------------------------------------
  // PACK_SOURCE_UNFETCHABLE
  // -------------------------------------------------------------------------
  defineRuleFixture({
    code: 'PACK_SOURCE_UNFETCHABLE',
    severity: 'warning',
    expectFire: true,
    scenario:
      'The payout project selects carrier-doctrine with no recorded source and no committed bundle, so a fresh machine or CI runner has nothing to fetch.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          // The defect: no source, not bundled (resolves locally from the store only).
          { name: 'carrier-doctrine', version: '2.0.0' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_SOURCE_UNFETCHABLE',
    expectFire: false,
    reason: 'The selection records a fetchable source URL, so `wairon pack sync` can obtain it anywhere.',
    scenario:
      'The payout project records the download URL for its carrier-doctrine selection so CI can fetch the pack.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'carrier-doctrine', version: '2.0.0', source: 'https://packs.example.dev/carrier-doctrine-{version}.wpack' },
        ]),
      },
    },
  }),
  defineRuleFixture({
    code: 'PACK_SOURCE_UNFETCHABLE',
    expectFire: false,
    reason: 'A BUNDLED selection is documented as exempt: its bytes are committed, so it reproduces without any fetchable source.',
    scenario:
      'The payout project commits its quota-doctrine pack as a bundle, so the selection reproduces from the repository itself.',
    tree: {
      ...payoutSpecs,
      files: {
        '.wai/project.yaml': projectYaml([
          { name: 'quota-doctrine', version: '1.2.0', bundle: true },
        ]),
        '.wai/packs/quota-doctrine/1.2.0/pack.yaml': 'name: quota-doctrine\nversion: 1.2.0\n',
      },
    },
  }),
];
