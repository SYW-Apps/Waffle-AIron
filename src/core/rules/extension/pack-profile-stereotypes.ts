import { SddRule } from '../types.js';

/**
 * The doctrine a PACK states about its own profile, applied on top of the
 * built-in family fencing: explicit forbidden and discouraged stereotype
 * lists, each carrying the reason the pack gives for them. Whether the
 * profile name is registered at all is profile-registration's finding; the
 * built-in family doctrine is profile-stereotype-fencing's.
 */
export const packProfileStereotypesRule: SddRule = {
  name: 'pack-profile-stereotypes',
  description:
    'A pack-registered profile carries its own stereotype doctrine on top of the built-in family fencing: the stereotypes it lists as forbidden are errors and the ones it discourages are warnings, each reported with the reason the pack states for it.',
  codes: [
    { code: 'PROFILE_FORBIDDEN_STEREOTYPE', defaultSeverity: 'error', summary: 'Stereotype forbidden by the governing pack-defined profile' },
    { code: 'PROFILE_DISCOURAGED_STEREOTYPE', defaultSeverity: 'warning', summary: 'Stereotype discouraged by the governing pack-defined profile' },
  ],
  check(ctx) {
    for (const comp of ctx.components) {
      const profile = ctx.getComponentProfile(comp.id);
      const packDef = ctx.ext.profiles[profile];
      if (!packDef) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);

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
  },
};
