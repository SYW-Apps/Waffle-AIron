import { NamingRuleConfig } from '../../models/index.js';
import { RuleContext, SddRule } from './types.js';

const casingPatterns: Record<string, RegExp> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z0-9]+(_[a-z0-9]+)*$/,
  'kebab-case': /^[a-z0-9]+(-[a-z0-9]+)*$/,
  UPPER_CASE: /^[A-Z0-9]+(_[A-Z0-9]+)*$/,
};

function extensionProfileFor(ctx: RuleContext, subsystemId?: string) {
  const sub = subsystemId ? ctx.subsystems.find(s => s.id === subsystemId) : undefined;
  const profile = sub?.profile || ctx.projectType;
  return ctx.ext.profiles[profile];
}

function getEffectiveNamingConfig(ctx: RuleContext, subsystemId?: string): NamingRuleConfig | undefined {
  const projectNaming = ctx.rules?.naming;
  const packDef = extensionProfileFor(ctx, subsystemId);
  
  if (packDef?.rules?.naming) {
    return {
      ...projectNaming,
      ...packDef.rules.naming,
      stereotypes: {
        ...(projectNaming?.stereotypes ?? {}),
        ...(packDef.rules.naming.stereotypes ?? {}),
      },
    };
  }
  return projectNaming;
}

function compilePattern(patternOrCasing: string): RegExp | null {
  if (casingPatterns[patternOrCasing]) return casingPatterns[patternOrCasing];
  try {
    return new RegExp(patternOrCasing);
  } catch {
    return null;
  }
}

function checkCasingOrRegex(value: string, patternOrCasing: string): boolean | null {
  if (!patternOrCasing) return true;
  
  // Strip generics for type testing (e.g. "IdentifiedEntity<T>" -> "IdentifiedEntity")
  const valueToTest = value.split('<')[0].trim();
  const regex = compilePattern(patternOrCasing);
  if (!regex) return null;
  return regex.test(valueToTest);
}

function checkNamedValue(
  ctx: RuleContext,
  value: string,
  pattern: string,
  message: string,
  specId?: string,
  isDraft?: boolean,
): void {
  const result = checkCasingOrRegex(value, pattern);
  if (result === null) {
    ctx.addIssue(
      'error',
      'INVALID_NAMING_PATTERN',
      `Naming pattern "${pattern}" is neither a known casing style nor a valid regular expression.`,
      specId,
      isDraft,
    );
    return;
  }
  if (!result) {
    ctx.addIssue('warning', 'NAMING_CONVENTION_VIOLATION', message, specId, isDraft);
  }
}

function getBaseId(id: string): string {
  const parts = id.split('::');
  return parts[parts.length - 1];
}

const isAllUppercase = (s: string) => /^[A-Z0-9_]+$/.test(s);

export const namingRule: SddRule = {
  name: 'naming-conventions',
  description:
    'Enforces naming conventions (casing styles or regular expressions) for subsystem, component, interface, type (differentiating entities and value-objects), method, variables/parameters, fields, and constants names/IDs, plus stereotype-specific naming patterns.',
  codes: [
    { code: 'NAMING_CONVENTION_VIOLATION', defaultSeverity: 'warning', summary: 'Item name or ID does not match the configured casing pattern or regex' },
    { code: 'STEREOTYPE_NAMING_VIOLATION', defaultSeverity: 'warning', summary: 'Component name or ID does not match stereotype suffix/prefix/regex rules' },
    { code: 'INVALID_NAMING_PATTERN', defaultSeverity: 'error', summary: 'Configured naming pattern is not a known casing style or valid regular expression' },
  ],
  check(ctx) {
    // 1. Subsystems
    for (const sub of ctx.subsystems) {
      const namingConfig = getEffectiveNamingConfig(ctx, sub.id);
      if (!namingConfig?.subsystems) continue;

      const baseId = getBaseId(sub.id);
      checkNamedValue(ctx, baseId, namingConfig.subsystems, `Subsystem ID "${sub.id}" does not match naming convention "${namingConfig.subsystems}".`, sub.id);
      checkNamedValue(ctx, sub.name, namingConfig.subsystems, `Subsystem Name "${sub.name}" does not match naming convention "${namingConfig.subsystems}".`, sub.id);
    }

    // 2. Components & Stereotypes
    for (const comp of ctx.components) {
      const namingConfig = getEffectiveNamingConfig(ctx, comp.subsystem);
      const isDraft = ctx.isComponentDraft(comp.id);

      if (namingConfig?.components) {
        const baseId = getBaseId(comp.id);
        checkNamedValue(ctx, baseId, namingConfig.components, `Component ID "${comp.id}" does not match naming convention "${namingConfig.components}".`, comp.id, isDraft);
        checkNamedValue(ctx, comp.name, namingConfig.components, `Component Name "${comp.name}" does not match naming convention "${namingConfig.components}".`, comp.id, isDraft);
      }

      // Stereotype suffix/prefix/regex checks
      const stereotypesConfig = namingConfig?.stereotypes?.[comp.componentType];
      if (stereotypesConfig) {
        const matchMode = stereotypesConfig.match ?? 'both';
        const prefix = stereotypesConfig.prefix;
        const suffix = stereotypesConfig.suffix;
        const regexStr = stereotypesConfig.regex;

        const baseId = getBaseId(comp.id);
        const idsToTest = matchMode === 'id' || matchMode === 'both' ? [baseId] : [];
        const namesToTest = matchMode === 'name' || matchMode === 'both' ? [comp.name] : [];
        const allToTest = [...idsToTest, ...namesToTest];

        for (const val of allToTest) {
          if (prefix && !val.startsWith(prefix)) {
            ctx.addIssue(
              'warning',
              'STEREOTYPE_NAMING_VIOLATION',
              `Component "${comp.id}" (${comp.componentType}) naming check failed: "${val}" must start with prefix "${prefix}".`,
              comp.id,
              isDraft
            );
          }
          if (suffix && !val.endsWith(suffix)) {
            ctx.addIssue(
              'warning',
              'STEREOTYPE_NAMING_VIOLATION',
              `Component "${comp.id}" (${comp.componentType}) naming check failed: "${val}" must end with suffix "${suffix}".`,
              comp.id,
              isDraft
            );
          }
          const regex = regexStr ? compilePattern(regexStr) : null;
          if (regexStr && !regex) {
            ctx.addIssue(
              'error',
              'INVALID_NAMING_PATTERN',
              `Stereotype naming regex "${regexStr}" for component type "${comp.componentType}" is invalid.`,
              comp.id,
              isDraft
            );
          } else if (regex && !regex.test(val)) {
            ctx.addIssue(
              'warning',
              'STEREOTYPE_NAMING_VIOLATION',
              `Component "${comp.id}" (${comp.componentType}) naming check failed: "${val}" does not match regex "${regexStr}".`,
              comp.id,
              isDraft
            );
          }
        }
      }
    }

    // 3. Interfaces & Methods & Variables
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      const namingConfig = getEffectiveNamingConfig(ctx, comp?.subsystem);
      const isDraft = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';

      if (namingConfig?.interfaces) {
        const baseId = getBaseId(intf.id);
        // Strip the leading 'i' prefix if it is required by the SpecIdSchema itself.
        const cleanId = baseId.startsWith('i') ? baseId.slice(1) : baseId;
        checkNamedValue(ctx, cleanId, namingConfig.interfaces, `Interface ID "${intf.id}" does not match naming convention "${namingConfig.interfaces}".`, intf.id, isDraft);
        checkNamedValue(ctx, intf.name, namingConfig.interfaces, `Interface Name "${intf.name}" does not match naming convention "${namingConfig.interfaces}".`, intf.id, isDraft);
      }

      for (const m of intf.methods) {
        if (namingConfig?.methods) {
          checkNamedValue(ctx, m.name, namingConfig.methods, `Interface method "${m.name}" on "${intf.id}" does not match naming convention "${namingConfig.methods}".`, intf.id, isDraft);
        }

        // Method parameter variable naming
        if (namingConfig?.variables) {
          for (const param of m.params ?? []) {
            checkNamedValue(ctx, param.name, namingConfig.variables, `Method parameter "${param.name}" in method "${m.name}" on "${intf.id}" does not match naming convention "${namingConfig.variables}".`, intf.id, isDraft);
          }
        }
      }
    }

    // 4. Implementations (check their methods match naming.methods casing)
    for (const impl of ctx.implementations) {
      const intf = ctx.interfaceMap.get(impl.contract);
      const comp = intf ? ctx.componentMap.get(intf.component) : undefined;
      const namingConfig = getEffectiveNamingConfig(ctx, comp?.subsystem);
      const isDraft = impl.status === 'draft' || impl.status === 'design';

      if (namingConfig?.methods) {
        for (const m of impl.methods) {
          checkNamedValue(ctx, m.name, namingConfig.methods, `Implementation method "${m.name}" on "${impl.id}" does not match naming convention "${namingConfig.methods}".`, impl.id, isDraft);
        }
      }
    }

    // 5. Types & Fields & Methods & Constants
    for (const t of ctx.types) {
      const namingConfig = getEffectiveNamingConfig(ctx, t.subsystem);
      
      // Determine type naming rule pattern based on kind (entity vs value-object)
      let typePattern = namingConfig?.types;
      if (t.kind === 'entity' && namingConfig?.entities) {
        typePattern = namingConfig.entities;
      } else if (t.kind === 'value-object' && namingConfig?.valueObjects) {
        typePattern = namingConfig.valueObjects;
      }

      if (typePattern) {
        const baseId = getBaseId(t.id);
        checkNamedValue(ctx, baseId, typePattern, `Type ID "${t.id}" (${t.kind}) does not match naming convention "${typePattern}".`, t.id);
        checkNamedValue(ctx, t.name, typePattern, `Type Name "${t.name}" (${t.kind}) does not match naming convention "${typePattern}".`, t.id);
      }

      // Fields & Constants checks
      for (const f of t.fields) {
        // If field name is all uppercase, consider it a constant
        const isConst = isAllUppercase(f.name);
        const fieldPattern = (isConst && namingConfig?.constants) ? namingConfig.constants : namingConfig?.fields;
        
        if (fieldPattern) {
          checkNamedValue(ctx, f.name, fieldPattern, `${isConst ? 'Constant' : 'Field'} "${f.name}" on type "${t.id}" does not match naming convention "${fieldPattern}".`, t.id);
        }
      }

      if (namingConfig?.methods) {
        for (const m of t.methods) {
          checkNamedValue(ctx, m.name, namingConfig.methods, `Method "${m.name}" on type "${t.id}" does not match naming convention "${namingConfig.methods}".`, t.id);
        }
      }
    }
  },
};
