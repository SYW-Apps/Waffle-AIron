import { nameKey } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// enum-types — a type of kind enum is a closed, ordered set of named values
// with optional pure methods, and nothing else. No values, two values one
// identifier in every language, or a member an enum cannot hold are all
// shapes the kind does not have; so are values on a type of another kind.
// The check mirrors signature-types: judged at validate time, on the type's
// own fields.
// ---------------------------------------------------------------------------

export const enumTypesRule: SddRule = {
  name: 'enum-types',
  judges: 'design',
  description:
    'An enum is a closed, ordered set of named values with optional pure methods, nothing else: an enum without values, with two values equal by reference_resolution.nameKey (every language derives one identifier from both), or carrying fields, params, returns, invariants, componentClass, database, table or linkedEntity is reported; so are values on a type of any other kind, where they mean nothing.',
  codes: [
    { code: 'ENUM_MEMBERS', defaultSeverity: 'error', summary: 'An enum has no values, two values equal by nameKey, or a member it cannot carry; or a type of another kind carries values' },
  ],
  check(ctx) {
    // Step 1: every loaded type, in scope.
    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      const sub = t.subsystem ? ctx.subsystems.find((s) => s.id === t.subsystem) : undefined;
      const isDraft = !!sub && (sub.status === 'draft' || sub.status === 'design');
      // Step 2: is it an enum?
      if (t.kind === 'enum') {
        // Step 3: no values, values one name apart, and members an enum cannot carry.
        const values = t.values ?? [];
        const problems: string[] = [];
        if (values.length === 0) problems.push('lists no values');
        const seen = new Map<string, string>();
        for (const value of values) {
          const key = nameKey(value.name);
          const earlier = seen.get(key);
          if (earlier !== undefined) problems.push(`lists "${earlier}" and "${value.name}", which every language derives one identifier from`);
          else seen.set(key, value.name);
        }
        const members = [
          ...(t.fields.length > 0 ? ['fields'] : []),
          ...(t.params !== undefined ? ['params'] : []),
          ...(t.returns !== undefined ? ['returns'] : []),
          ...((t.invariants?.length ?? 0) > 0 ? ['invariants'] : []),
          ...(t.componentClass !== undefined ? ['componentClass'] : []),
          ...(t.database !== undefined ? ['database'] : []),
          ...(t.table !== undefined ? ['table'] : []),
          ...(t.linkedEntity !== undefined ? ['linkedEntity'] : []),
        ];
        if (members.length > 0) problems.push(`carries ${members.join(', ')}`);
        if (problems.length === 0) continue;
        ctx.addIssue(
          'error',
          'ENUM_MEMBERS',
          `Enum type "${t.id}" ${problems.join('; ')}. An enum is a closed, ordered set of named values, unique by name ignoring case and separators, with optional pure methods and nothing else.`,
          t.id,
          isDraft,
        );
        continue;
      }
      // Step 4: values on a type of any other kind mean nothing.
      if (t.values === undefined) continue;
      ctx.addIssue(
        'error',
        'ENUM_MEMBERS',
        `Type "${t.id}" is ${t.kind === 'entity' ? 'an entity' : `a ${t.kind}`} and carries values, which only an enum has. Make it kind enum, or drop them.`,
        t.id,
        isDraft,
      );
    }
  },
};
