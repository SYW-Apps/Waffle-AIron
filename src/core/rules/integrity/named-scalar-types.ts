import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// named-scalar-types — a named scalar is a value-object that declares
// `holds: <primitive>` in place of fields: a newtype or type alias in every
// language (`type PackPath = string`). It models its value and nothing else
// beside its pure methods and invariants, so fields beside holds, or the
// table and component links a record carries, are shapes it does not have;
// holds on an entity, an enum or a signature type means nothing. Whether holds
// names one of the primitives is type-expressions' question (the grammar's
// holds position, TYPE_POSITION_INVALID), never a second voice here. The check
// mirrors enum-types and signature-types: judged at validate time, on the
// type's own fields.
// ---------------------------------------------------------------------------

export const namedScalarTypesRule: SddRule = {
  name: 'named-scalar-types',
  judges: 'design',
  description:
    'A named scalar is a value-object that declares `holds: <primitive>` in place of fields — a newtype or type alias in every language. It models its value and nothing else beside its pure methods and invariants: holds beside fields, componentClass, database, table or linkedEntity is reported, and so is holds on an entity, an enum or a signature type, where it means nothing. Whether holds names one of the primitives is the type-expressions rule\'s question (TYPE_POSITION_INVALID on the holds position), never a second voice here. Mirrors enum-types and signature-types: judged at validate time, on the type\'s own fields.',
  codes: [
    { code: 'NAMED_SCALAR_MEMBERS', defaultSeverity: 'error', summary: 'A named scalar (a value-object holding a primitive) carries fields or a member it cannot carry; or a type of another kind declares holds' },
  ],
  check(ctx) {
    // Step 1: every loaded type, in scope.
    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      // Step 2: does it declare holds? Step 4: nothing to judge without it.
      if (t.holds === undefined) continue;
      const sub = t.subsystem ? ctx.subsystems.find((s) => s.id === t.subsystem) : undefined;
      const isDraft = !!sub && (sub.status === 'draft' || sub.status === 'design');
      // Step 3: holds on another kind, and each member a named scalar cannot carry.
      if (t.kind !== 'value-object') {
        ctx.addIssue(
          'error',
          'NAMED_SCALAR_MEMBERS',
          `Type "${t.id}" is ${t.kind === 'entity' ? 'an entity' : `a ${t.kind}`} and declares holds, which only a value-object has: a named scalar is a value-object holding one primitive. Make it a value-object, or drop holds.`,
          t.id,
          isDraft,
        );
        continue;
      }
      const members = [
        ...(t.fields.length > 0 ? ['fields'] : []),
        ...(t.componentClass !== undefined ? ['componentClass'] : []),
        ...(t.database !== undefined ? ['database'] : []),
        ...(t.table !== undefined ? ['table'] : []),
        ...(t.linkedEntity !== undefined ? ['linkedEntity'] : []),
      ];
      if (members.length === 0) continue;
      ctx.addIssue(
        'error',
        'NAMED_SCALAR_MEMBERS',
        `Named scalar "${t.id}" holds ${t.holds} and carries ${members.join(', ')}. A named scalar is one primitive under a name, with optional pure methods and invariants and nothing else: drop ${members.length === 1 ? 'it' : 'them'}, or drop holds and model the value-object's fields.`,
        t.id,
        isDraft,
      );
    }
  },
};
