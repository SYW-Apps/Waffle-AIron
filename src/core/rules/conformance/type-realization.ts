import { pathKey, typeSourceFiles, type TypeSpec } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec Level 1 for the DATA MODEL: does the code hold the type?
//
// An implementation claims code with a sourcePath and is judged on it. A type
// could not, so the model layer was the one part of a tree that named no code
// and was asked nothing — which is exactly where unclaimed files pile up.
// `type.sourcePath` closes that, and this rule is what makes it a claim rather
// than a label:
//
//   - every file the type names must resolve to a readable file inside the
//     project root (the same three verdicts source-file-linkage gives an
//     implementation's files, reported here because this rule owns the type's
//     claim end to end),
//   - the type's declaration must be PUBLISHED by its file — among its
//     exported names, under its `symbol` when the code-level name legitimately
//     differs — and a pure re-export barrel publishes only what other files
//     declare, so a claim on one is never realized,
//   - each pure method must be a DECLARATION-tier anchor in its OWN file (the
//     method's sourcePath, else the type's) under the method's `symbol`, else
//     its name.
//
// The two tiers differ on purpose. A modelled type is part of the design's
// published vocabulary, and the declaration tier would accept a file that
// merely IMPORTS the name — which every consumer does, so any of them would
// satisfy the claim. A method is not: it is an interface member, a class
// method or a free function, at any nesting depth, and that is exactly what
// the declaration tier holds.
//
// Both read the export/declaration facts only at EXACT grade for the type:
// below it, nothing separates an export from a mention (several language
// pattern tables record no exports at all), so the declaration tier is the
// honest floor and the grade rides on every finding.
//
// The two overrides are not symmetry for its own sake. A type's methods
// routinely live apart from its declaration and under different names: wairon's
// own `method_implementation` declares its shape in src/models/specs.ts while
// `stepConfigVerdict` lives in step-config.ts, and `narrative_step.foreignFields`
// is realized by the free function `narrativeStepForeignFields` — the form a
// pure type method takes in a language whose data carries no methods. Without
// a per-method sourcePath and symbol the honest claim could not be written at
// all, and the dishonest one (point the type at a file it half-lives in) is
// what the rule exists to stop.
//
// A type that names no sourcePath claims nothing and is never reported: the
// model layer is opt-in, one type at a time.
// ---------------------------------------------------------------------------

/** The three file-status verdicts, as (code, severity, what it means for the reader). */
const FILE_PROBLEMS: Record<string, { code: string; severity: 'error' | 'warning'; detail: string }> = {
  escaped: {
    code: 'SOURCE_PATH_ESCAPES_ROOT',
    severity: 'error',
    detail: 'is absolute or escapes the project root — sourcePaths must stay inside the project.',
  },
  missing: {
    code: 'MISSING_SOURCE_FILE',
    severity: 'error',
    detail: 'does not resolve to a file — the spec names code that does not exist.',
  },
  unreadable: {
    code: 'CONFORMANCE_ANALYSIS_SKIPPED',
    severity: 'warning',
    detail: 'could not be analyzed (binary or unreadable) — what it would have realized was not checked.',
  },
};

/** How a finding names whoever pointed at this file: the type itself, or the methods that named it. */
function ownerOf(type: TypeSpec, file: string): string {
  if (type.sourcePath && pathKey(type.sourcePath) === pathKey(file)) return `Type "${type.id}"`;
  const users = (type.methods ?? []).filter(m => m.sourcePath && pathKey(m.sourcePath) === pathKey(file)).map(m => m.name);
  if (users.length === 0) return `Type "${type.id}"`;
  return `Type "${type.id}" method${users.length === 1 ? '' : 's'} ${users.map(n => `"${n}"`).join(', ')}`;
}

export const typeRealizationRule: SddRule = {
  name: 'type-realization',
  description:
    'Code↔spec Level 1 for the data model: a type that names a sourcePath is claiming code, so every file it names — its own and each method\'s — must resolve to a real, readable file inside the project root, its file must PUBLISH its declaration (an exported name at exact grade, the declaration tier below it, under its `symbol` when the code-level name differs from the type\'s name — and a pure re-export barrel publishes nothing of its own, so a claim on one is never realized), and each of its pure methods must appear in its own file (the method\'s sourcePath, else the type\'s) at the declaration tier, under the method\'s `symbol`, else the method\'s name. A type that names no sourcePath claims nothing and is never reported. Findings carry the analysis grade (exact AST | pattern table | generic scan) so weaker analysis is visible, a file that escapes the root, is missing or could not be analyzed is reported once and blocks only what it would have realized, and types under chained subsystems (projectPath) validate standalone in their own project run.',
  codes: [
    { code: 'UNREALIZED_TYPE', defaultSeverity: 'warning', summary: 'A type names a sourcePath but its declaration is nowhere in that file — the claim points at code that does not hold it' },
    { code: 'UNREALIZED_TYPE_METHOD', defaultSeverity: 'warning', summary: 'A pure method of a claimed type is nowhere in its own source file (the method\'s sourcePath, else the type\'s)' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'A source file a type or one of its methods names does not resolve to a file on disk' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'A source file a type or one of its methods names is absolute or escapes the project root (containment refusal)' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file a type or one of its methods names could not be analyzed (binary/unreadable) — what it would have realized was not checked' },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const type of ctx.types) {
      // A type that claims no file claims nothing; a chained child's
      // sourcePaths are relative to its own root, so the child judges them.
      if (!type.sourcePath) continue;
      if (type.subsystem && ctx.isInChainedSubproject(type.subsystem)) continue;

      // File status first, once per distinct file. A file reported here blocks
      // only what it would have realized, so a broken path costs one finding
      // rather than one per method.
      const blocked = new Set<string>();
      for (const file of typeSourceFiles(type)) {
        const key = pathKey(file);
        const facts = code.factsAt(key);
        if (!facts || facts.status === 'analyzed') continue;
        blocked.add(key);
        const problem = FILE_PROBLEMS[facts.status];
        if (!problem) continue;
        ctx.addIssue(problem.severity, problem.code, `${ownerOf(type, file)} sourcePath "${file}" ${problem.detail}`, type.id);
      }

      const typeKey = pathKey(type.sourcePath);
      const typeFacts = code.factsAt(typeKey);
      if (typeFacts && !blocked.has(typeKey)) {
        const symbol = type.symbol ?? type.name;
        // What the file PUBLISHES. Only exact analysis separates an export
        // from a mention, so below it the declaration tier is the floor and
        // the grade on the finding says so. A pure re-export barrel publishes
        // nothing of its own, whatever names pass through it.
        const published = typeFacts.analysisGrade === 'exact'
          ? new Set(typeFacts.reexportOnly ? [] : typeFacts.exportedNames)
          : code.declarationsAt(typeKey);
        if (!published.has(symbol)) {
          const label = type.symbol ? `"${type.name}" (symbol "${symbol}")` : `"${type.name}"`;
          ctx.addIssue(
            'warning',
            'UNREALIZED_TYPE',
            `Type ${label} is not published by "${type.sourcePath}" (analysis grade: ${typeFacts.analysisGrade})`
            + `${typeFacts.reexportOnly ? ', which is a pure re-export barrel and declares nothing of its own' : ''} — `
            + 'name the file the declaration lives in, or bind the code-level name with `symbol`.',
            type.id,
          );
        }
      }

      for (const method of type.methods ?? []) {
        const file = method.sourcePath ?? type.sourcePath;
        const key = pathKey(file);
        if (blocked.has(key)) continue;
        const facts = code.factsAt(key);
        if (!facts || facts.status !== 'analyzed') continue;
        const symbol = method.symbol ?? method.name;
        if (code.declarationsAt(key).has(symbol)) continue;
        const label = method.symbol ? `"${method.name}" (symbol "${symbol}")` : `"${method.name}"`;
        ctx.addIssue(
          'warning',
          'UNREALIZED_TYPE_METHOD',
          `Method ${label} of type "${type.id}" is not declared in "${file}" (analysis grade: ${facts.analysisGrade}) — `
          + 'a pure type method is often a free function named after its type; bind that name with `symbol`, '
          + 'or name the file it lives in with the method\'s own `sourcePath`.',
          type.id,
        );
      }
    }
  },
};
