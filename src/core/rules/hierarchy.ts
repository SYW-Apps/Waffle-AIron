import { SddRule } from './types.js';

/**
 * Tree integrity: every spec points at an existing parent, and draft/design
 * specs are surfaced as informational warnings.
 */
export const hierarchyRule: SddRule = {
  name: 'hierarchy-integrity',
  description:
    'Every subsystem references the system, every component an existing subsystem, every interface an existing component, and every implementation an existing interface contract. Draft/design specs are reported informationally.',
  codes: [
    { code: 'DRAFT_SUBSYSTEM_WARNING', defaultSeverity: 'warning', summary: 'Subsystem is in draft/design status' },
    { code: 'DRAFT_COMPONENT_WARNING', defaultSeverity: 'warning', summary: 'Component is in draft/design status' },
    { code: 'ORPHANED_SUBSYSTEM', defaultSeverity: 'warning', summary: 'Subsystem does not reference the L0 system' },
    { code: 'INVALID_SUBSYSTEM_REFERENCE', defaultSeverity: 'error', summary: 'Reference to a non-existent subsystem' },
    { code: 'INVALID_COMPONENT_REFERENCE', defaultSeverity: 'error', summary: 'Interface references a non-existent component' },
    { code: 'INVALID_INTERFACE_REFERENCE', defaultSeverity: 'error', summary: 'Implementation references a non-existent interface contract' },
  ],
  check(ctx) {
    // Informational draft warnings
    for (const sub of ctx.subsystems) {
      if (sub.status === 'draft' || sub.status === 'design') {
        ctx.addIssue('warning', 'DRAFT_SUBSYSTEM_WARNING', `Subsystem "${sub.id}" is in draft/design status.`, sub.id, true);
      }
    }
    for (const comp of ctx.components) {
      if (ctx.isComponentDraft(comp.id)) {
        ctx.addIssue('warning', 'DRAFT_COMPONENT_WARNING', `Component "${comp.id}" is in draft/design status.`, comp.id, true);
      }
    }

    // Check subsystems reference parent system
    for (const sub of ctx.subsystems) {
      const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
      if (!sub.parentSystem || (sub.parentSystem !== ctx.system.name && !sub.id.includes('::'))) {
        ctx.addIssue(
          'warning',
          'ORPHANED_SUBSYSTEM',
          `Subsystem "${sub.id}" does not reference system "${ctx.system.name}".`,
          sub.id,
          isDraftCtx,
        );
      }
    }

    // Check components reference existing subsystem
    for (const comp of ctx.components) {
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      if (!ctx.subsystemIds.has(comp.subsystem)) {
        ctx.addIssue(
          'error',
          'INVALID_SUBSYSTEM_REFERENCE',
          `Component "${comp.id}" references non-existent subsystem "${comp.subsystem}".`,
          comp.id,
          isDraftCtx,
        );
      }
    }

    // Check interfaces reference existing component
    for (const intf of ctx.interfaces) {
      const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      if (!ctx.componentIds.has(intf.component)) {
        ctx.addIssue(
          'error',
          'INVALID_COMPONENT_REFERENCE',
          `Interface "${intf.id}" references non-existent component "${intf.component}".`,
          intf.id,
          isDraftCtx,
        );
      }
    }

    // Check implementations reference existing interface
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaces.find(i => i.id === impl.contract);
      const isDraftCtx = impl.status === 'draft' || impl.status === 'design' || (contract && (ctx.isComponentDraft(contract.component) || contract.status === 'draft' || contract.status === 'design'));
      if (!ctx.interfaceIds.has(impl.contract)) {
        ctx.addIssue(
          'error',
          'INVALID_INTERFACE_REFERENCE',
          `Implementation "${impl.id}" references non-existent interface contract "${impl.contract}".`,
          impl.id,
          isDraftCtx,
        );
      }
    }
  },
};
