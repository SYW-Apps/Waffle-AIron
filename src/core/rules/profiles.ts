import { SddRule } from './types.js';

/**
 * Architectural profile constraints: frontend stereotypes stay out of
 * backend-oriented subsystems, PLC-cyclic forbids concurrent stereotypes, and
 * backend runtime stereotypes in frontend subsystems get a sanity warning.
 */
export const profilesRule: SddRule = {
  name: 'architectural-profiles',
  description:
    'Per-profile stereotype constraints: View/FeatureComponent/RouterComponent only in frontend profiles; Actor/Supervisor forbidden in plc-cyclic (single scan cycle); Actor/Supervisor in frontend profiles warned.',
  codes: [
    { code: 'FRONTEND_STEREOTYPE_IN_BACKEND', defaultSeverity: 'error', summary: 'Frontend stereotype in a backend-oriented subsystem' },
    { code: 'PLC_CYCLIC_CONCURRENCY_VIOLATION', defaultSeverity: 'error', summary: 'Concurrent stereotype in a PLC-cyclic profile' },
    { code: 'BACKEND_STEREOTYPE_IN_FRONTEND', defaultSeverity: 'warning', summary: 'Backend runtime stereotype in a frontend subsystem' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const profile = ctx.getComponentProfile(comp.id);

      if (profile === 'backend' || profile === 'lowlevel-os' || profile === 'game-ecs' || profile === 'realtime-embedded' || profile === 'plc-cyclic') {
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
      } else {
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
