import { implementationSourceFiles, pathKey, typeSourceFiles, type TypeSpec } from '../../../models/index.js';
import { plannedCode } from './source-file-linkage.js';
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
// A type that names no sourcePath claims no code, so nothing ever compares its
// shape with the code — and that is said (MISSING_TYPE_SOURCE_PATH): a notice
// while its subsystem has no code, a warning once it has. Until a claim has BEGUN
// (code_index.holdsAny over the type's own file and its methods' files) a
// named file not on disk is PLANNED — a notice — and nothing else is judged.
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
    detail: 'does not resolve to a file although the type\'s realization has begun — a broken link: the spec names code that does not exist.',
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
  judges: 'code',
  description:
    'Code↔spec Level 1 for the data model: a type that names a sourcePath is claiming code. Until that claim has BEGUN (code_index.holdsAny over the type\'s own file and its methods\' files) a named file that is not on disk is PLANNED (SOURCE_FILE_PLANNED, a notice; an error under rules.conformance.requireCode). Once it has begun, every file it names must resolve to a real, readable file inside the project root (MISSING_SOURCE_FILE, an error, otherwise), its file must PUBLISH its declaration (an exported name at exact grade, the declaration tier below it, under its `symbol` when the code-level name differs from the type\'s name — and a pure re-export barrel publishes nothing of its own, so a claim on one is never realized), and each of its pure methods must appear in its own file (the method\'s sourcePath, else the type\'s) at the declaration tier, under the method\'s `symbol`, else the method\'s name. A type that names no sourcePath of its own claims no code, so nothing ever compares its shape with the code — and that is said, never left silent: before the code of the type\'s subsystem has begun (no file an implementation of that subsystem names exists; for a type no subsystem owns, no file of any implementation) it is unlinked design (MISSING_TYPE_SOURCE_PATH, a notice — plan the type\'s sourcePath with the implementations\'), and once that code exists it is a type no check reads (a warning). rules.conformance.requireCode reports the notice at error, naming the setting. Findings carry the analysis grade, a file that escapes the root or could not be analyzed is reported once and blocks only what it would have realized, and types under chained subsystems (projectPath) validate standalone in their own project run.',
  codes: [
    { code: 'UNREALIZED_TYPE', defaultSeverity: 'warning', summary: 'A type names a sourcePath but its declaration is nowhere in that file — the claim points at code that does not hold it' },
    { code: 'UNREALIZED_TYPE_METHOD', defaultSeverity: 'warning', summary: 'A pure method of a claimed type is nowhere in its own source file (the method\'s sourcePath, else the type\'s)' },
    { code: 'MISSING_SOURCE_FILE', defaultSeverity: 'error', summary: 'A source file a type or one of its methods names does not resolve to a file on disk although the type\'s realization has begun (another file it names exists)' },
    { code: 'SOURCE_PATH_ESCAPES_ROOT', defaultSeverity: 'error', summary: 'A source file a type or one of its methods names is absolute or escapes the project root (containment refusal)' },
    { code: 'CONFORMANCE_ANALYSIS_SKIPPED', defaultSeverity: 'warning', summary: 'A source file a type or one of its methods names could not be analyzed (binary/unreadable) — what it would have realized was not checked' },
    { code: 'SOURCE_FILE_PLANNED', defaultSeverity: 'notice', summary: 'A source file a type names is not on disk and none of its named files is — planned, not written yet; an error under rules.conformance.requireCode' },
    { code: 'MISSING_TYPE_SOURCE_PATH', defaultSeverity: 'notice', summary: "A type names no sourcePath of its own, so its shape is never compared with code — a notice while its subsystem has no code yet (plan the path with the implementations'), a warning once it has; an error under rules.conformance.requireCode" },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    // Whether the code of a subsystem has begun: some file an implementation of
    // a component in it names exists. A type no subsystem owns asks of the
    // whole project. Asked once per subsystem.
    const begunIn = new Map<string, boolean>();
    const codeBegunFor = (subsystem: string | undefined): boolean => {
      const key = subsystem ?? '';
      let begun = begunIn.get(key);
      if (begun === undefined) {
        begun = ctx.implementations.some((impl) => {
          if (subsystem !== undefined) {
            const owner = ctx.componentMap.get(ctx.interfaceMap.get(impl.contract)?.component ?? '');
            if (owner?.subsystem !== subsystem) return false;
          }
          return code.holdsAny(implementationSourceFiles(impl));
        });
        begunIn.set(key, begun);
      }
      return begun;
    };

    for (const type of ctx.types) {
      // A chained child's sourcePaths are relative to its own root, so the
      // child judges them.
      if (type.subsystem && ctx.isInChainedSubproject(type.subsystem)) continue;
      // A type that claims no file of its own claims no code, so nothing ever
      // compares its shape with the code — said, never left silent. Unlinked
      // design before its subsystem's code begins; a type no check reads after.
      if (!type.sourcePath) {
        const begunHere = codeBegunFor(type.subsystem);
        const planned = plannedCode(ctx);
        const methods = typeSourceFiles(type).length > 0 ? ' (only its methods name files)' : '';
        ctx.addIssue(
          begunHere ? 'warning' : planned.severity,
          'MISSING_TYPE_SOURCE_PATH',
          begunHere
            ? `Type "${type.id}" names no sourcePath of its own${methods}, and the code of ${type.subsystem ? `subsystem "${type.subsystem}"` : 'this project'} exists — so nothing compares its fields with the code: it is data no check reads. Name the file that declares it (sourcePath, and symbol when the code name differs).`
            : `Type "${type.id}" names no sourcePath of its own${methods} — designed, not linked to code yet, so its shape will never be compared with the code. Plan its sourcePath now, with the implementations': code linkage is not part of the approval, so it costs no re-lock${planned.note}.`,
          type.id,
        );
        continue;
      }

      // File status first, once per distinct file. A file reported here blocks
      // only what it would have realized, so a broken path costs one finding
      // rather than one per method.
      const blocked = new Set<string>();
      // Realization has begun once any file the type names exists.
      const begun = code.holdsAny(typeSourceFiles(type));
      for (const file of typeSourceFiles(type)) {
        const key = pathKey(file);
        const facts = code.factsAt(key);
        if (!facts || facts.status === 'analyzed') continue;
        blocked.add(key);
        if (facts.status === 'missing' && !begun) {
          const planned = plannedCode(ctx);
          ctx.addIssue(
            planned.severity,
            'SOURCE_FILE_PLANNED',
            `${ownerOf(type, file)} sourcePath "${file}" is planned, not written yet — conformance judges the type once a file it names exists${planned.note}.`,
            type.id,
          );
          continue;
        }
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
