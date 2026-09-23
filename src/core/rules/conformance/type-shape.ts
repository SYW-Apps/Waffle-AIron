import { pathKey, type TypeShapeFact } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec for the DATA: is the type the SHAPE the spec claims?
//
// `typeRealization` asks whether a type EXISTS in code. Nothing ever asked
// whether it is the shape the spec describes, and that is the worst of the
// code-to-spec gaps: a wrong method signature eventually breaks at a call
// site, while a type spec that lies about its data is only ever READ — by the
// ERD, by an agent brief, by whoever is about to implement against it. So a
// spec could describe two fields of a six-field record, and call the two that
// are optional required, straight through a lock and a CI gate with nothing in
// the world to correct it.
//
// Four decisions make that a finding rather than a flood:
//
//  1. THE TWO AXES STAY APART. `structure?(text: string): string` is a method
//     signature, not a field. Counted as data it made every behavioural
//     interface in this tree — RuleContext, CodeIndex, ImportGraph — read as
//     massive field drift, and it is the method axis `typeRealization` already
//     judges. The same fact in the other spelling is treated the same way: a
//     spec field the code writes as a method, and a code field the spec models
//     as a method, are one fact in two spellings and not a disagreement.
//
//  2. EXACT GRADE, OR NOTHING. Below it a member list cannot be told from a
//     mention, and a guess about somebody's data model is worse than silence:
//     it would be read as measurement by every reader downstream.
//
//  3. A MISSING DECLARATION IS NOT THIS RULE'S FINDING. When the file holds no
//     shape of that name at all, `typeRealization` says so, and saying it here
//     too would make one absence look like two. The same goes for the shapes
//     the analyzer will not guess at — a union alias, and a derived alias whose
//     one hop lands on nothing readable.
//
//  4. AN EXTENDING SHAPE IS JUDGED ON WHAT IT SHOWS. Its inherited members are
//     not in this file to count, so presence and absence cannot be asked of it
//     — but a member it DOES list is one it answers for, so optionality is.
//
// Optionality is read as ABSENT-ABLE, the only reading a spec can be wrong
// about in a way a reader would notice. In a derived shape that means the
// wrappers which let a key be missing, and never the one that FILLS it:
// `.default(x)` leaves the field REQUIRED in the value the type finally holds,
// which is the thing the spec describes, and `.optional().default(x)` is
// required too. Reading it the other way doubled this tree's optionality drift
// on its own.
//
// All three codes are CARRYABLE: each measures this project's own code against
// its own spec at a site the finding names, and paying one means changing the
// code or the spec. The units are field names, so a record cannot grow a
// seventh field behind a register entry written for six.
// ---------------------------------------------------------------------------

/** What a shape is, in the words a message uses for it. */
function originOf(shape: TypeShapeFact): string {
  if (shape.origin === 'derived') return 'derived shape';
  return shape.inherited ? 'declared shape (which extends another)' : 'declared shape';
}

/** How a message spells one side of an optionality disagreement. */
function absence(optional: boolean): string {
  return optional ? 'may be absent' : 'is always there';
}

export const typeShapeRule: SddRule = {
  name: 'type-shape',
  description: 'Code-to-contract for the DATA: a type spec\'s `fields` are compared, name by name, against the shape its `sourcePath` actually declares. `typeRealization` asks whether a type EXISTS in code; nothing asked whether it is the shape the spec claims, so a type spec could describe two fields of a six-field record — and call the two that are optional required — straight through a lock and a CI gate, while the ERD, the agent briefs and every implementer read it as truth. That is the worst of the code-to-spec gaps, because a wrong signature eventually breaks at a call site and a type spec that lies is only ever read by humans and agents. Two origins answer at exact grade: a DECLARED shape, whose members the file lists, and a DERIVED one, an alias followed one hop to the object literal its schema is built from, where the keys are the members. A shape that extends another is judged on what it shows and never on what it omits, since its inherited members are not in this file to count.',
  codes: [
    {
      code: 'UNREALIZED_TYPE_FIELD',
      defaultSeverity: 'warning',
      summary: 'A type spec declares a field the shape at its sourcePath does not carry — the spec describes data the code does not have, and every reader of the ERD and the briefs has been told it exists',
      // Measured code↔spec drift, field by field, at a site the finding names
      // — which is why every one of them hands over `parts`.
      carryable: true,
    },
    {
      code: 'UNDECLARED_TYPE_FIELD',
      defaultSeverity: 'warning',
      summary: 'The shape at a type\'s sourcePath carries a field the type spec does not declare — data the design never described, so no diagram draws it and no brief hands it to an implementer',
      carryable: true,
    },
    {
      code: 'TYPE_FIELD_OPTIONALITY',
      defaultSeverity: 'warning',
      summary: 'A type spec and the shape at its sourcePath disagree about whether a field may be absent — one of them is telling a reader the data is guaranteed when it is not, or the reverse',
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    for (const type of ctx.types) {
      // ---- 1. gather: the shape declared under the type's own code name ----
      // A type that names no file is making no claim about code; a chained
      // child's sourcePaths are relative to its own root, so the child judges
      // them.
      if (!type.sourcePath) continue;
      if (type.subsystem && ctx.isInChainedSubproject(type.subsystem)) continue;
      const file = pathKey(type.sourcePath);
      const facts = code.factsAt(file);

      // ---- 2 / 9. silent unless the shape can honestly be read at all ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const symbol = type.symbol ?? type.name;
      const shapes = facts.typeShapes;
      // Own-property lookup: a type may legitimately be named "constructor" or
      // "toString", and a bare index would answer with Object.prototype's.
      if (!shapes || !Object.prototype.hasOwnProperty.call(shapes, symbol)) continue;
      const shape = shapes[symbol];

      // ---- 3. read: the data members, both sides of the comparison ----
      // Method-style members are left to the method axis, and are carried into
      // the comparison only so a field written in the other spelling is never
      // accused of being missing or undeclared.
      const specFields = type.fields ?? [];
      const specFieldNames = new Set(specFields.map(field => field.name));
      const specMethodNames = new Set((type.methods ?? []).map(method => method.name));
      const codeFields = new Map(shape.fields.map(field => [field.name, field.optional]));
      const codeMethodNames = new Set(shape.methods);

      // ---- 4 / 5. presence, spec → code (never for a shape that extends) ----
      const unrealized = shape.inherited ? [] : specFields
        .filter(field => !codeFields.has(field.name) && !codeMethodNames.has(field.name))
        .map(field => field.name);
      if (unrealized.length > 0) {
        ctx.addIssue(
          'warning',
          'UNREALIZED_TYPE_FIELD',
          `Type "${type.id}" declares ${unrealized.length} field(s) the ${originOf(shape)} "${symbol}" in `
          + `"${file}" does not carry — ${unrealized.map(name => `"${name}"`).join(', ')}. The spec is describing `
          + 'data the code does not have, and nothing breaks at a call site to correct it: the ERD draws those '
          + 'fields and every brief hands them to an implementer as if they were there. Add them to the code, or '
          + 'drop them from the type.',
          type.id,
          undefined,
          undefined,
          { at: symbol, covers: unrealized },
        );
      }

      // ---- 6. presence, code → spec (the same silence for an extending shape) ----
      const undeclared = shape.inherited ? [] : shape.fields
        .filter(field => !specFieldNames.has(field.name) && !specMethodNames.has(field.name))
        .map(field => field.name);
      if (undeclared.length > 0) {
        ctx.addIssue(
          'warning',
          'UNDECLARED_TYPE_FIELD',
          `The ${originOf(shape)} "${symbol}" in "${file}" carries ${undeclared.length} field(s) type `
          + `"${type.id}" does not declare — ${undeclared.map(name => `"${name}"`).join(', ')}. Data the design `
          + 'never described is data no diagram draws and no brief hands to an implementer, which is how a record '
          + 'grows past the model of it without anyone deciding to. Model the field, or take it out of the shape.',
          type.id,
          undefined,
          undefined,
          { at: symbol, covers: undeclared },
        );
      }

      // ---- 7. optionality, judged even for a shape that extends another ----
      // A member this file lists is a member this file answers for.
      const disagreed = specFields.filter(field => {
        const absentable = codeFields.get(field.name);
        return absentable !== undefined && absentable !== !!field.optional;
      });
      if (disagreed.length > 0) {
        const told = disagreed.map(field =>
          `"${field.name}" (the spec says it ${absence(!!field.optional)}, the code says it `
          + `${absence(!!codeFields.get(field.name))})`).join('; ');
        ctx.addIssue(
          'warning',
          'TYPE_FIELD_OPTIONALITY',
          `Type "${type.id}" and the ${originOf(shape)} "${symbol}" in "${file}" disagree about whether `
          + `${disagreed.length} field(s) may be absent — ${told}. One of them is telling a reader the data is `
          + 'guaranteed when it is not, or the reverse. Absent-able is the code\'s word for it — a wrapper that '
          + 'lets the key be missing — and a wrapper that FILLS a missing key leaves the field required in the '
          + 'value the type finally holds, which is the shape the spec describes.',
          type.id,
          undefined,
          undefined,
          { at: symbol, covers: disagreed.map(field => field.name) },
        );
      }
      // ---- 8. done: the type's data was compared to the code's ----
    }
  },
};
