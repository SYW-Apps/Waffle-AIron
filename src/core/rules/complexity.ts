import { DocumentationRuleConfig, ComplexityRuleConfig } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';

function extensionProfileFor(ctx: RuleContext, subsystemId?: string) {
  const sub = subsystemId ? ctx.subsystems.find(s => s.id === subsystemId) : undefined;
  const profile = sub?.profile || ctx.projectType;
  return ctx.ext.profiles[profile];
}

function getEffectiveDocConfig(ctx: RuleContext, subsystemId?: string): DocumentationRuleConfig | undefined {
  const projectDoc = ctx.rules?.documentation;
  const packDef = extensionProfileFor(ctx, subsystemId);
  
  if (packDef?.rules?.documentation) {
    return { ...projectDoc, ...packDef.rules.documentation };
  }
  return projectDoc;
}

function getEffectiveComplexityConfig(ctx: RuleContext, subsystemId?: string): ComplexityRuleConfig | undefined {
  const projectComp = ctx.rules?.complexity;
  const packDef = extensionProfileFor(ctx, subsystemId);
  
  if (packDef?.rules?.complexity) {
    return { ...projectComp, ...packDef.rules.complexity };
  }
  return projectComp;
}

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
    'Enforces metadata documentation completeness (checking if descriptions are missing or too short) and structural complexity caps (limits on methods per interface, dependencies per component, and narrative steps per method) configured globally or in architectural profiles.',
  codes: [
    { code: 'MISSING_DESCRIPTION', defaultSeverity: 'warning', summary: 'Required description field is missing or empty' },
    { code: 'DESCRIPTION_TOO_SHORT', defaultSeverity: 'warning', summary: 'Description is shorter than the configured minimum length' },
    { code: 'EXCESSIVE_METHODS', defaultSeverity: 'warning', summary: 'Interface declares more methods than the configured limit' },
    { code: 'EXCESSIVE_METHOD_PARAMS', defaultSeverity: 'warning', summary: 'Interface method declares more parameters than the configured limit' },
    { code: 'EXCESSIVE_DEPENDENCIES', defaultSeverity: 'warning', summary: 'Component has more dependencies than the configured limit' },
    { code: 'EXCESSIVE_NARRATIVE_STEPS', defaultSeverity: 'warning', summary: 'Method implementation contains more narrative steps than the configured limit' },
    { code: 'EXCESSIVE_SUBSYSTEM_COMPONENTS', defaultSeverity: 'warning', summary: 'Subsystem has more direct components than the configured limit' },
  ],
  check(ctx) {
    // 1. Subsystems (Doc checks)
    for (const sub of ctx.subsystems) {
      const docConfig = getEffectiveDocConfig(ctx, sub.id);
      checkDescription(ctx, sub.description, docConfig?.requireDescriptions ?? false, docConfig?.minDescriptionLength, sub.id, 'Subsystem', false);

      const complexityConfig = getEffectiveComplexityConfig(ctx, sub.id);
      const directComponents = ctx.components.filter(c => c.subsystem === sub.id).length;
      if (complexityConfig?.maxSubsystemComponents !== undefined && directComponents > complexityConfig.maxSubsystemComponents) {
        ctx.addIssue(
          'warning',
          'EXCESSIVE_SUBSYSTEM_COMPONENTS',
          `Subsystem "${sub.id}" has ${directComponents} direct components, exceeding the configured limit of ${complexityConfig.maxSubsystemComponents}.`,
          sub.id,
        );
      }
    }

    // 2. Components (Doc & Complexity checks)
    for (const comp of ctx.components) {
      const docConfig = getEffectiveDocConfig(ctx, comp.subsystem);
      const complexityConfig = getEffectiveComplexityConfig(ctx, comp.subsystem);
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

      if (complexityConfig?.maxComponentDependencies !== undefined && comp.dependsOn.length > complexityConfig.maxComponentDependencies) {
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
      const docConfig = getEffectiveDocConfig(ctx, comp?.subsystem);
      const complexityConfig = getEffectiveComplexityConfig(ctx, comp?.subsystem);
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

    // 4. Implementations (Complexity checks)
    for (const impl of ctx.implementations) {
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      const complexityConfig = getEffectiveComplexityConfig(ctx, comp?.subsystem);
      const isDraft = impl.status === 'draft' || impl.status === 'design';

      if (complexityConfig?.maxNarrativeSteps !== undefined) {
        for (const m of impl.methods) {
          if (m.narrative.length > complexityConfig.maxNarrativeSteps) {
            ctx.addIssue(
              'warning',
              'EXCESSIVE_NARRATIVE_STEPS',
              `Method "${m.name}" in implementation "${impl.id}" contains ${m.narrative.length} narrative steps, exceeding the configured limit of ${complexityConfig.maxNarrativeSteps}.`,
              impl.id,
              isDraft
            );
          }
        }
      }
    }

    // 5. Types (Doc checks)
    for (const t of ctx.types) {
      const docConfig = getEffectiveDocConfig(ctx, t.subsystem);

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
