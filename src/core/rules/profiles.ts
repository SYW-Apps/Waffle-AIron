import { BUILTIN_PROFILES, SddRule } from './types.js';

/**
 * Architectural profile constraints. Built-in profiles carry built-in
 * doctrine (frontend stereotypes stay out of backend-oriented subsystems,
 * PLC-cyclic forbids concurrent stereotypes, backend runtime stereotypes in
 * frontend subsystems get a sanity warning). Extension packs register their
 * own profiles: `family` opts into the built-in fencing, and explicit
 * forbidden/discouraged stereotype lists carry the pack's doctrine with a
 * stated reason. Unregistered profile names are flagged, not guessed at.
 */
const BACKEND_LIKE = new Set(['backend', 'lowlevel-os', 'game-ecs', 'realtime-embedded', 'plc-cyclic']);
const FRONTEND_LIKE = new Set(['frontend-reactive', 'frontend-controller']);
/** projectType additionally allows the composite project kinds. */
const PROJECT_KINDS = new Set(['fullstack', 'system-of-systems', 'monorepo']);

export const profilesRule: SddRule = {
  name: 'architectural-profiles',
  description:
    'Per-profile stereotype constraints: View/FeatureComponent/RouterComponent only in frontend profiles; Actor/Supervisor forbidden in plc-cyclic (single scan cycle); Actor/Supervisor in frontend profiles warned. Extension packs may register custom profiles (family + forbidden/discouraged stereotype lists); unknown profile names are flagged.',
  codes: [
    { code: 'FRONTEND_STEREOTYPE_IN_BACKEND', defaultSeverity: 'error', summary: 'Frontend stereotype in a backend-oriented subsystem' },
    { code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION', defaultSeverity: 'error', summary: 'Concurrent stereotype in a PLC-cyclic profile' },
    { code: 'BACKEND_STEREOTYPE_IN_FRONTEND', defaultSeverity: 'warning', summary: 'Backend runtime stereotype in a frontend subsystem' },
    { code: 'PROFILE_FORBIDDEN_STEREOTYPE', defaultSeverity: 'error', summary: 'Stereotype forbidden by the governing pack-defined profile' },
    { code: 'PROFILE_DISCOURAGED_STEREOTYPE', defaultSeverity: 'warning', summary: 'Stereotype discouraged by the governing pack-defined profile' },
    { code: 'UNKNOWN_PROFILE', defaultSeverity: 'warning', summary: 'Profile name is neither built-in nor registered by an extension pack' },
  ],
  check(ctx) {
    const registered = new Set<string>([...BUILTIN_PROFILES, ...Object.keys(ctx.ext.profiles)]);

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
    if (!registered.has(ctx.projectType) && !PROJECT_KINDS.has(ctx.projectType)) {
      ctx.addIssue(
        'warning',
        'UNKNOWN_PROFILE',
        `projectType "${ctx.projectType}" (project.yaml) is neither a built-in profile/kind nor registered by a loaded extension pack. Components default to backend doctrine.`,
      );
    }

    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const profile = ctx.getComponentProfile(comp.id);
      const packDef = ctx.ext.profiles[profile];
      const family = packDef
        ? packDef.family
        : FRONTEND_LIKE.has(profile) ? 'frontend-like'
          : BACKEND_LIKE.has(profile) ? 'backend-like'
            : 'neutral'; // unknown profile — already flagged above, no doctrine to guess

      if (family === 'backend-like') {
        const frontendTypes = ['View', 'FeatureComponent', 'RouterComponent'];
        if (frontendTypes.includes(comp.componentType)) {
          ctx.addIssue(
            'error',
            'FRONTEND_STEREOTYPE_IN_BACKEND',
            `Architectural violation: Component "${comp.id}" is a frontend stereotype (${comp.componentType}) but subsystem "${comp.subsystem}" is configured as a backend-oriented subsystem.`,
            comp.id,
            isDraftCtx,
          );
        }

        // PLC Cyclic specific constraints
        if (profile === 'plc-cyclic') {
          if (comp.componentType === 'Actor' || comp.componentType === 'Supervisor') {
            ctx.addIssue(
              'error',
              'PLC_CYCLIC_CONCURRENCY_VIOLATION',
              `Architectural violation: Component "${comp.id}" is a concurrent stereotype (${comp.componentType}) which is forbidden in PLC Cyclic profile. PLC logic runs strictly single-threaded within the main execution scan cycle.`,
              comp.id,
              isDraftCtx,
            );
          }
        }
      } else if (family === 'frontend-like') {
        const backendOnlyTypes = ['Supervisor', 'Actor'];
        if (backendOnlyTypes.includes(comp.componentType)) {
          ctx.addIssue(
            'warning',
            'BACKEND_STEREOTYPE_IN_FRONTEND',
            `Subsystem "${comp.subsystem}" is a frontend subsystem, but component "${comp.id}" is a backend stereotype (${comp.componentType}). Ensure this runtime concern is genuinely client-side.`,
            comp.id,
            isDraftCtx,
          );
        }
      }

      // Pack-declared doctrine, applied on top of the family fencing.
      if (packDef) {
        for (const rule of packDef.forbiddenStereotypes) {
          if (rule.types.includes(comp.componentType)) {
            ctx.addIssue(
              'error',
              'PROFILE_FORBIDDEN_STEREOTYPE',
              `Component "${comp.id}" is a ${comp.componentType}, forbidden by profile "${profile}": ${rule.reason}`,
              comp.id,
              isDraftCtx,
            );
          }
        }
        for (const rule of packDef.discouragedStereotypes) {
          if (rule.types.includes(comp.componentType)) {
            ctx.addIssue(
              'warning',
              'PROFILE_DISCOURAGED_STEREOTYPE',
              `Component "${comp.id}" is a ${comp.componentType}, discouraged by profile "${profile}": ${rule.reason}`,
              comp.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
