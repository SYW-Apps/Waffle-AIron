import { pathKey } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec for an ENUM: does the declaration at the type's sourcePath hold
// the values the design lists?
//
// `typeRealization` asks whether the declaration exists; nothing asked whether
// it holds the values. An enum is read by every diagram, OpenAPI document and
// brief as the closed set it claims, so a value the code would reject — or
// one the code accepts that no reader was told of — misleads all of them.
//
// Its own rule rather than a branch of `type-shape`, because a union alias is
// not a shape: the values come from their own fact (source_file_facts
// .enumValues) — a string-literal union alias, the array a z.enum constant
// holds, or a string enum's member values. Exact grade only; a declaration
// the analyzer read no values from is typeRealization's question. Values are
// compared EXACTLY — a value is data, and `local_only` is not `local-only` —
// and order is not judged: languages differ on whether declaration order is
// observable.
//
// Both codes are CARRYABLE: each measures this project's own code against its
// own spec at a site the finding names (the declaration), unit by unit (the
// values), exactly as type-shape's field codes do.
// ---------------------------------------------------------------------------

export const enumValuesRule: SddRule = {
  name: 'enum-values',
  judges: 'code',
  description: 'Code-to-contract for an ENUM: an enum type\'s values are compared, name by name, with the values the declaration at its sourcePath holds — a string-literal union alias, the array a z.enum constant holds, or a string enum\'s member values (source_file_facts.enumValues). `typeRealization` already asks whether the declaration exists; nothing asked whether it holds the values the design lists, and an enum is read by every diagram, OpenAPI document and brief as the closed set it claims. Exact grade only; a declaration the analyzer reads no values from is typeRealization\'s question, never this rule\'s. Order is not judged: languages differ on whether declaration order is observable.',
  codes: [
    {
      code: 'UNREALIZED_ENUM_VALUE',
      defaultSeverity: 'warning',
      summary: 'An enum type lists a value the declaration at its sourcePath does not hold — the design promises a value the code would reject',
      carryable: true,
    },
    {
      code: 'UNDECLARED_ENUM_VALUE',
      defaultSeverity: 'warning',
      summary: 'The declaration at an enum type\'s sourcePath holds a value the enum does not list — a value the design never described',
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const type of ctx.types) {
      // ---- 1. gather: an enum naming a file, and the values there ----
      if (type.kind !== 'enum' || !type.sourcePath) continue;
      if (type.subsystem && ctx.isInChainedSubproject(type.subsystem)) continue;
      const file = pathKey(type.sourcePath);
      const facts = code.factsAt(file);
      const symbol = type.symbol ?? type.name;

      // ---- 2 / 6. silent unless the values can honestly be read ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const declared = facts.enumValues;
      if (!declared || !Object.prototype.hasOwnProperty.call(declared, symbol)) continue;
      const held = new Set(declared[symbol]);
      const listed = (type.values ?? []).map((value) => value.name);
      const listedSet = new Set(listed);

      // ---- 3. a value the enum lists that the declaration does not hold ----
      const unrealized = listed.filter((value) => !held.has(value));
      if (unrealized.length > 0) {
        ctx.addIssue(
          'warning',
          'UNREALIZED_ENUM_VALUE',
          `Enum type "${type.id}" lists ${unrealized.length} value(s) the declaration "${symbol}" in "${file}" does not `
          + `hold — ${unrealized.map((value) => `"${value}"`).join(', ')}. The design promises a value the code would `
          + 'reject, and every diagram, OpenAPI document and brief offers it. Add it to the declaration, or drop it '
          + 'from the enum (values compare exactly: a value is data).',
          type.id,
          undefined,
          undefined,
          { at: symbol, covers: unrealized },
        );
      }

      // ---- 4. a value the declaration holds that the enum does not list ----
      const undeclared = declared[symbol].filter((value) => !listedSet.has(value));
      if (undeclared.length > 0) {
        ctx.addIssue(
          'warning',
          'UNDECLARED_ENUM_VALUE',
          `The declaration "${symbol}" in "${file}" holds ${undeclared.length} value(s) enum type "${type.id}" does `
          + `not list — ${undeclared.map((value) => `"${value}"`).join(', ')}. A value the design never described is `
          + 'one no diagram shows and no brief hands an implementer. List it on the enum, or take it out of the code.',
          type.id,
          undefined,
          undefined,
          { at: symbol, covers: undeclared },
        );
      }
      // ---- 5. judged ----
    }
  },
};
