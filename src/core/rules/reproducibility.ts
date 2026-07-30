import { SddRule } from './types.js';

/**
 * Gives `rules.enforceReproducibility` teeth.
 *
 * The flag has existed (defaulting to true) since init started writing it, and was
 * READ NOWHERE — while a pack selection could float to "latest installed" off a
 * mutable machine store, which is precisely the irreproducibility it names. A
 * floating selection means two developers, or a developer and CI, can validate the
 * same tree against different rule sets and both see green.
 *
 * Graded by context rather than forbidden outright, matching how wairon already
 * treats draft specs: a warning while you work (so `pack use appenser` stays a
 * one-liner), an error under `wairon validate --ci`, which treats warnings as
 * errors. You may develop against a floating pack set; CI will not accept one.
 *
 * A BUNDLED selection is exempt: its bytes are committed, so it reproduces without
 * a pin. A selection with no fetchable source is a separate concern — it may pin
 * perfectly and still be unobtainable elsewhere.
 */
export const reproducibilityRule: SddRule = {
  name: 'pack-reproducibility',
  description:
    'Under rules.enforceReproducibility (default true), every by-name pack selection must be reproducible elsewhere: pinned to an exact version (ideally with an integrity digest) or bundled into the repository. A floating selection resolves against whatever the local machine happens to have installed, so a clone or CI can validate the same tree against a different rule set (UNPINNED_PACK_SELECTION). A selection that records no fetchable source cannot be obtained by CI at all (PACK_SOURCE_UNFETCHABLE).',
  codes: [
    { code: 'UNPINNED_PACK_SELECTION', defaultSeverity: 'warning', summary: 'Pack selection floats to the latest installed version instead of pinning one' },
    { code: 'PACK_SOURCE_UNFETCHABLE', defaultSeverity: 'warning', summary: 'Pack selection is neither bundled nor obtainable from a recorded source' },
  ],
  check(ctx) {
    // Opt-out is explicit: `enforceReproducibility: false` silences the family.
    if (ctx.rules?.enforceReproducibility === false) return;

    for (const selection of ctx.ext.packSelections) {
      // A committed copy reproduces without a pin — its bytes ARE the pin.
      if (selection.bundle) continue;

      if (!selection.version) {
        ctx.addIssue(
          'warning',
          'UNPINNED_PACK_SELECTION',
          `Pack selection "${selection.name}" pins no version, so it resolves to whatever version this machine happens to have installed — a clone or CI can enforce a different rule set than you do. Pin it (\`wairon pack use ${selection.name}@<version> --pin\`), bundle it (\`wairon pack bundle ${selection.name}\`), or set rules.enforceReproducibility: false to accept the drift.`,
        );
      }

      if (!selection.source) {
        ctx.addIssue(
          'warning',
          'PACK_SOURCE_UNFETCHABLE',
          `Pack selection "${selection.name}" records no source and is not bundled, so a fresh machine or CI runner cannot obtain it — \`wairon pack sync\` has nothing to fetch. Record a URL (\`wairon pack use ${selection.name} --source <url>\`) or commit a copy (\`wairon pack bundle ${selection.name}\`).`,
        );
      }
    }
  },
};
