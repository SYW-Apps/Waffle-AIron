import { SddRule } from './types.js';

/**
 * Reports a project's declared pack selections that could not be resolved.
 *
 * The governing rule: a project's doctrine is what the project declares, so a
 * declared pack that is absent must be LOUD. A gate that quietly enforces less
 * than the project asked for reads as clean, which is the one failure direction
 * that must never happen silently — worse than a gate that fails.
 *
 * Three codes rather than one, because the remedies differ:
 *   - absent entirely            → obtain the pack (`pack sync` / `pack install`)
 *   - present at other versions  → adjust the pin
 *   - content off the pinned digest → reconcile the content
 *
 * All error severity. Errors are never locally suppressible via `lint.allow`, and
 * that is deliberate here: silencing "my doctrine is missing" on one spec would
 * defeat the point. A project that genuinely no longer wants a pack drops the
 * selection (`wairon pack unuse`), which is the honest way to say so.
 *
 * Resolution itself happens in core/extensions.ts (bundle first, then the store);
 * this rule only surfaces what it reported, so the two can never disagree about
 * whether a pack applies.
 */
export const packResolutionRule: SddRule = {
  name: 'pack-resolution',
  description:
    'Every pack a project declares must resolve — from a committed bundle under .wai/packs/, or from this wairon install\'s pack store. An unresolvable selection is an error reported under the code that names the remedy: PACK_NOT_INSTALLED (absent entirely), PACK_VERSION_UNSATISFIED (installed, but no version satisfies the pin), or PACK_INTEGRITY_MISMATCH (resolved content does not match the pinned digest). Never downgraded to a warning: a project whose declared doctrine is missing is misconfigured, and a gate running without it must not look clean.',
  codes: [
    { code: 'PACK_NOT_INSTALLED', defaultSeverity: 'error', summary: 'A declared pack is neither bundled nor installed in the pack store' },
    { code: 'PACK_VERSION_UNSATISFIED', defaultSeverity: 'error', summary: 'The pack is installed, but no installed version satisfies the selection\'s pin' },
    { code: 'PACK_INTEGRITY_MISMATCH', defaultSeverity: 'error', summary: 'Resolved pack content does not match the selection\'s pinned integrity digest' },
  ],
  check(ctx) {
    for (const failure of ctx.ext.selectionFailures) {
      ctx.addIssue('error', failure.code, failure.message);
    }
  },
};
