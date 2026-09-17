import { BUILTIN_PROFILES, PROJECT_KINDS as PROJECT_KIND_IDS, SddRule } from '../types.js';

/** projectType additionally allows the composite project kinds — the shared
 *  registry constant (PROJECT_KINDS), so the hosted profile-application path and
 *  this rule can never disagree about which kinds are legal. */
const PROJECT_KINDS = new Set<string>(PROJECT_KIND_IDS);

/**
 * Is the profile name real? A profile governs doctrine, so a name nobody
 * registered governs nothing — and silence would read as approval. Both the
 * project's own projectType and every subsystem's declared profile are checked
 * against the built-ins plus whatever the loaded packs register. WHICH doctrine
 * a registered profile then carries is the fencing rules' subject, not this
 * one's.
 */
export const profileRegistrationRule: SddRule = {
  name: 'profile-registration',
  description:
    'Every profile name in play — the project\'s own projectType and each subsystem\'s declared profile — must be a built-in profile, a composite project kind, or one a loaded extension pack registers. An unregistered name is flagged rather than guessed at: no doctrine is governing it.',
  codes: [
    { code: 'UNKNOWN_PROFILE', defaultSeverity: 'warning', summary: 'Profile name is neither built-in nor registered by an extension pack' },
  ],
  check(ctx) {
    const registered = new Set<string>([...BUILTIN_PROFILES, ...Object.keys(ctx.ext.profiles)]);

    if (!registered.has(ctx.projectType) && !PROJECT_KINDS.has(ctx.projectType)) {
      ctx.addIssue(
        'warning',
        'UNKNOWN_PROFILE',
        `projectType "${ctx.projectType}" (project.yaml) is neither a built-in profile/kind nor registered by a loaded extension pack. Components default to backend doctrine.`,
      );
    }

    for (const sub of ctx.subsystems) {
      if (sub.profile && !registered.has(sub.profile)) {
        ctx.addIssue(
          'warning',
          'UNKNOWN_PROFILE',
          `Subsystem "${sub.id}" declares profile "${sub.profile}", which is neither a built-in profile (${BUILTIN_PROFILES.join(', ')}) nor registered by a loaded extension pack. No profile doctrine is being enforced for it.`,
          sub.id,
        );
      }
    }
  },
};
