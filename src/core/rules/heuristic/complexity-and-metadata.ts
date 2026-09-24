import { isDraftSubsystem } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import { routingTableComponents } from './method-cohesion.js';

function checkDescription(
  ctx: RuleContext,
  desc: string | undefined,
  required: boolean,
  minLength: number | undefined,
  specId: string,
  typeName: string,
  isDraft: boolean
) {
  if (required && (!desc || desc.trim().length === 0)) {
    ctx.addIssue(
      'warning',
      'MISSING_DESCRIPTION',
      `${typeName} "${specId}" is missing a required description.`,
      specId,
      isDraft
    );
    return;
  }
  if (desc && minLength && desc.trim().length < minLength) {
    ctx.addIssue(
      'warning',
      'DESCRIPTION_TOO_SHORT',
      `${typeName} "${specId}" description is too short (${desc.trim().length} chars, min ${minLength}).`,
      specId,
      isDraft
    );
  }
}

export const complexityRule: SddRule = {
  name: 'complexity-and-metadata',
  description:
    'Enforces metadata documentation completeness (checking if descriptions are missing or too short) and structural complexity caps (limits on methods per interface, parameters per method, dependencies per component, and components per subsystem) configured globally or in architectural profiles. A narrative\'s own length and shape are judged by narrative-complexity.',
  codes: [
    { code: 'MISSING_DESCRIPTION', defaultSeverity: 'warning', summary: 'Required description field is missing or empty' },
    { code: 'DESCRIPTION_TOO_SHORT', defaultSeverity: 'warning', summary: 'Description is shorter than the configured minimum length' },
    { code: 'EXCESSIVE_METHODS', defaultSeverity: 'warning', summary: 'Interface declares more methods than the configured limit' },
    { code: 'EXCESSIVE_METHOD_PARAMS', defaultSeverity: 'warning', summary: 'Interface method declares more parameters than the configured limit' },
    { code: 'EXCESSIVE_DEPENDENCIES', defaultSeverity: 'warning', summary: 'Component has more dependencies than the configured limit; not reported on a routing table, which reaches every collaborator it has only through single hand-offs' },
    { code: 'EXCESSIVE_SUBSYSTEM_COMPONENTS', defaultSeverity: 'warning', summary: 'Subsystem has more direct components than the configured limit' },
  ],
  check(ctx) {
    // 1. Subsystems (Doc checks)
    for (const sub of ctx.subsystems) {
      const docConfig = ctx.documentationConfigFor(sub.id);
      const isSubDraft = isDraftSubsystem(sub);
      checkDescription(ctx, sub.description, docConfig?.requireDescriptions ?? false, docConfig?.minDescriptionLength, sub.id, 'Subsystem', isSubDraft);

      const complexityConfig = ctx.complexityConfigFor(sub.id);
      const directComponents = ctx.components.filter(c => c.subsystem === sub.id).length;
      if (complexityConfig?.maxSubsystemComponents !== undefined && directComponents > complexityConfig.maxSubsystemComponents) {
        ctx.addIssue(
          'warning',
          'EXCESSIVE_SUBSYSTEM_COMPONENTS',
          `Subsystem "${sub.id}" has ${directComponents} direct components, exceeding the configured limit of ${complexityConfig.maxSubsystemComponents}.`,
          sub.id,
          isSubDraft,
        );
      }
    }

    // 2. Components (Doc & Complexity checks)
    //
    // The dependency cap spares a ROUTING TABLE — a component whose every
    // narrated method that reaches a collaborator is a single hand-off, a
    // method reaching none being neutral — for the reason GOD_COMPONENT does,
    // since the two read the same number: a door's fan-out counts how many
    // areas it publishes, not how much it knows, so capping it would punish
    // the component for the size of the subsystem behind it. The test is the
    // one GOD_COMPONENT applies (isRoutingTable), not method cohesion's
    // stricter pure-forwarder test; a component nobody has narrated is not
    // exempt, because absence of narrative is not evidence of routing.
    const routingTables = routingTableComponents(ctx);
    for (const comp of ctx.components) {
      const docConfig = ctx.documentationConfigFor(comp.subsystem);
      const complexityConfig = ctx.complexityConfigFor(comp.subsystem);
      const isDraft = ctx.isComponentDraft(comp.id);

      checkDescription(
        ctx,
        comp.description,
        docConfig?.requireDescriptions ?? false,
        docConfig?.minDescriptionLength,
        comp.id,
        'Component',
        isDraft
      );

      if (
        complexityConfig?.maxComponentDependencies !== undefined
        && comp.dependsOn.length > complexityConfig.maxComponentDependencies
        && !routingTables.has(comp.id)
      ) {
        ctx.addIssue(
          'warning',
          'EXCESSIVE_DEPENDENCIES',
          `Component "${comp.id}" has ${comp.dependsOn.length} dependencies, exceeding the configured limit of ${complexityConfig.maxComponentDependencies}.`,
          comp.id,
          isDraft
        );
      }
    }

    // 3. Interfaces & Methods (Doc & Complexity checks)
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      const docConfig = ctx.documentationConfigFor(comp?.subsystem);
      const complexityConfig = ctx.complexityConfigFor(comp?.subsystem);
      const isDraft = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';

      checkDescription(
        ctx,
        intf.description,
        docConfig?.requireDescriptions ?? false,
        docConfig?.minDescriptionLength,
        intf.id,
        'Interface',
        isDraft
      );

      if (complexityConfig?.maxInterfaceMethods !== undefined && intf.methods.length > complexityConfig.maxInterfaceMethods) {
        ctx.addIssue(
          'warning',
          'EXCESSIVE_METHODS',
          `Interface "${intf.id}" declares ${intf.methods.length} methods, exceeding the configured limit of ${complexityConfig.maxInterfaceMethods}.`,
          intf.id,
          isDraft
        );
      }

      for (const m of intf.methods) {
        checkDescription(
          ctx,
          m.description,
          docConfig?.requireMethodDescriptions ?? false,
          docConfig?.minDescriptionLength,
          `${intf.id}.${m.name}`,
          'Interface method',
          isDraft
        );

        const paramCount = (m.params ?? []).length;
        if (complexityConfig?.maxMethodParams !== undefined && paramCount > complexityConfig.maxMethodParams) {
          ctx.addIssue(
            'warning',
            'EXCESSIVE_METHOD_PARAMS',
            `Method "${m.name}" on interface "${intf.id}" declares ${paramCount} parameters, exceeding the configured limit of ${complexityConfig.maxMethodParams}.`,
            intf.id,
            isDraft
          );
        }
      }
    }

    // 4. Types (Doc checks)
    for (const t of ctx.types) {
      const docConfig = ctx.documentationConfigFor(t.subsystem);

      checkDescription(
        ctx,
        t.description,
        docConfig?.requireDescriptions ?? false,
        docConfig?.minDescriptionLength,
        t.id,
        'Type',
        false
      );

      for (const f of t.fields) {
        checkDescription(
          ctx,
          f.description,
          docConfig?.requireFieldDescriptions ?? false,
          docConfig?.minDescriptionLength,
          `${t.id}.${f.name}`,
          'Type field',
          false
        );
      }

      for (const m of t.methods) {
        checkDescription(
          ctx,
          m.description,
          docConfig?.requireMethodDescriptions ?? false,
          docConfig?.minDescriptionLength,
          `${t.id}.${m.name}`,
          'Type method',
          false
        );
      }
    }
  },
};
