import { SddRule } from '../types.js';

/**
 * Built-in profile-family doctrine: which stereotypes a runtime family can
 * host at all. Frontend view/routing stereotypes stay out of backend-oriented
 * subsystems, plc-cyclic forbids concurrent stereotypes (the runtime is a
 * single scan cycle), and a backend runtime stereotype in a frontend
 * subsystem gets a sanity warning. A pack-registered profile opts into this
 * fencing by declaring a `family`; the doctrine the pack itself states is the
 * pack-profile-stereotypes rule's subject.
 */
const BACKEND_LIKE = new Set(['backend', 'lowlevel-os', 'game-ecs', 'realtime-embedded', 'plc-cyclic']);
const FRONTEND_LIKE = new Set(['frontend-reactive', 'frontend-controller']);

export const profileStereotypeFencingRule: SddRule = {
  name: 'profile-stereotype-fencing',
  description:
    'The built-in profile families fence which stereotypes may run under them: View/FeatureComponent/RouterComponent only in a frontend-like profile; Actor/Supervisor forbidden in plc-cyclic, whose logic runs single-threaded inside one execution scan cycle; Actor/Supervisor in a frontend-like profile warned. A pack profile opts in by declaring its family; an unregistered profile is neutral, with no doctrine to guess.',
  codes: [
    { code: 'FRONTEND_STEREOTYPE_IN_BACKEND', defaultSeverity: 'error', summary: 'Frontend stereotype in a backend-oriented subsystem' },
    { code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION', defaultSeverity: 'error', summary: 'Concurrent stereotype in a PLC-cyclic profile' },
    { code: 'BACKEND_STEREOTYPE_IN_FRONTEND', defaultSeverity: 'warning', summary: 'Backend runtime stereotype in a frontend subsystem' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const profile = ctx.getComponentProfile(comp.id);
      const packDef = ctx.ext.profiles[profile];
      const family = packDef
        ? packDef.family
        : FRONTEND_LIKE.has(profile) ? 'frontend-like'
          : BACKEND_LIKE.has(profile) ? 'backend-like'
            : 'neutral'; // unknown profile — profile-registration flags it, no doctrine to guess

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
    }
  },
};
