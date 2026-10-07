import { isDraftSubsystem, methodCasingFor } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

const casingPatterns: Record<string, RegExp> = {
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/,
  snake_case: /^[a-z0-9]+(_[a-z0-9]+)*$/,
  'kebab-case': /^[a-z0-9]+(-[a-z0-9]+)*$/,
  UPPER_CASE: /^[A-Z0-9]+(_[A-Z0-9]+)*$/,
};

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

/**
 * The method names of the extension point an interface implements
 * (`implements: alias::name`), read where implements-contracts reads them: a
 * declared external's pin (or a foreign snapshot), else a contained member's
 * live export table. Empty when the interface implements nothing or the
 * reference does not resolve (project-boundaries reports that).
 */
function implementedNames(ctx: RuleContext, ref: string | undefined): Set<string> {
  if (ref === undefined) return new Set();
  const surface = ctx.resolveSurfaceRef(ref);
  if (surface.kind === 'resolved') {
    return surface.entry.role === 'implement' ? new Set(surface.entry.methods.map((m) => m.name)) : new Set();
  }
  const [alias, name] = ref.split('::');
  if (name === undefined) return new Set();
  const key = ctx.projectFamily?.nodes.find((n) => n.namespace === '')?.aliases.get(alias);
  if (key === undefined) return new Set();
  const entry = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key)
    ?.entries.find((e) => e.kind === 'component' && e.publicName === name);
  if (!entry || entry.role !== 'implement' || !entry.component) return new Set();
  const methods = entry.interface ? ctx.interfaceMap.get(entry.interface)?.methods : ctx.interfaceMethodsOf(entry.component);
  return new Set((methods ?? []).map((m) => m.name));
}

export const namingRule: SddRule = {
  name: 'naming-conventions',
  judges: 'design',
  description:
    "Enforces naming conventions (casing styles or regular expressions) for subsystem, component, interface, type (differentiating entities and value-objects), method, variables/parameters, fields, and constants names/IDs, plus stereotype-specific naming patterns. A method name is judged by naming_rule_config.methodCasingFor the subsystem's effective targetLanguage: the configured methods casing when set, else the language's own convention, so a Rust tree is snake_case without configuring anything, and the authoring and rename tools accept exactly what this rule accepts. A contract that implements another project's extension point (`implements`) takes the names of the methods it implements — and of their parameters — from the producer, whose language they are spelled in: those methods, on the contract and on its implementations, are exempt from the casing rule, and the rename tools accept them.",
  codes: [
    { code: 'NAMING_CONVENTION_VIOLATION', defaultSeverity: 'warning', summary: 'Item name or ID does not match the configured casing pattern or regex' },
    { code: 'STEREOTYPE_NAMING_VIOLATION', defaultSeverity: 'warning', summary: 'Component name or ID does not match stereotype suffix/prefix/regex rules' },
    { code: 'INVALID_NAMING_PATTERN', defaultSeverity: 'error', summary: 'Configured naming pattern is not a known casing style or valid regular expression' },
  ],
  check(ctx) {
    // 1. Subsystems
    for (const sub of ctx.subsystems) {
      const namingConfig = ctx.namingConfigFor(sub.id);
      if (!namingConfig?.subsystems) continue;
      const isDraft = isDraftSubsystem(sub);

      const baseId = getBaseId(sub.id);
      checkNamedValue(ctx, baseId, namingConfig.subsystems, `Subsystem ID "${sub.id}" does not match naming convention "${namingConfig.subsystems}".`, sub.id, isDraft);
      checkNamedValue(ctx, sub.name, namingConfig.subsystems, `Subsystem Name "${sub.name}" does not match naming convention "${namingConfig.subsystems}".`, sub.id, isDraft);
    }

    // 2. Components & Stereotypes
    for (const comp of ctx.components) {
      const namingConfig = ctx.namingConfigFor(comp.subsystem);
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
      const namingConfig = ctx.namingConfigFor(comp?.subsystem);
      const isDraft = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';

      if (namingConfig?.interfaces) {
        const baseId = getBaseId(intf.id);
        // Strip the leading 'i' prefix if it is required by the SpecIdSchema itself.
        const cleanId = baseId.startsWith('i') ? baseId.slice(1) : baseId;
        checkNamedValue(ctx, cleanId, namingConfig.interfaces, `Interface ID "${intf.id}" does not match naming convention "${namingConfig.interfaces}".`, intf.id, isDraft);
        checkNamedValue(ctx, intf.name, namingConfig.interfaces, `Interface Name "${intf.name}" does not match naming convention "${namingConfig.interfaces}".`, intf.id, isDraft);
      }

      // A method name follows the configured casing, else its tree's target
      // language's convention (methodCasingFor) — the authoring and rename
      // tools ask the same question.
      const methodCasing = methodCasingFor(namingConfig, ctx.targetLanguageFor(comp?.subsystem));
      // The producer named the methods of an extension point this contract
      // implements — and their parameters — in its own language.
      const dictated = implementedNames(ctx, intf.implements);
      for (const m of intf.methods) {
        if (dictated.has(m.name)) continue;
        checkNamedValue(ctx, m.name, methodCasing, `Interface method "${m.name}" on "${intf.id}" does not match naming convention "${methodCasing}"${namingConfig?.methods ? '' : ' (its target language\'s convention)'}.`, intf.id, isDraft);

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
      const namingConfig = ctx.namingConfigFor(comp?.subsystem);
      const isDraft = ctx.isImplementationDraft(impl);

      const methodCasing = methodCasingFor(namingConfig, ctx.targetLanguageFor(comp?.subsystem));
      const dictated = implementedNames(ctx, intf?.implements);
      for (const m of impl.methods) {
        if (dictated.has(m.name)) continue;
        checkNamedValue(ctx, m.name, methodCasing, `Implementation method "${m.name}" on "${impl.id}" does not match naming convention "${methodCasing}".`, impl.id, isDraft);
      }
    }

    // 5. Types & Fields & Methods & Constants
    for (const t of ctx.types) {
      const namingConfig = ctx.namingConfigFor(t.subsystem);
      
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

      const methodCasing = methodCasingFor(namingConfig, ctx.targetLanguageFor(t.subsystem));
      for (const m of t.methods) {
        checkNamedValue(ctx, m.name, methodCasing, `Method "${m.name}" on type "${t.id}" does not match naming convention "${methodCasing}".`, t.id);
      }
    }
  },
};
