import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// signature-types — a type of kind signature is a named function type: params
// and one returns, nothing else. Data members on it, a missing returns, and
// params or returns on a data type are all shapes the kinds do not have.
// Judged at validate time; the authoring seam does not refuse them (its
// candidate gate judges components only).
// ---------------------------------------------------------------------------

export const signatureTypesRule: SddRule = {
  name: 'signature-types',
  judges: 'design',
  description:
    'A type of kind signature is a named function type and carries params and one returns, nothing else: fields, methods, invariants, componentClass, database, table or linkedEntity on it — or a returns missing from it — are reported; so are params or returns on an entity or a value-object, where they mean nothing.',
  codes: [
    { code: 'SIGNATURE_TYPE_MEMBERS', defaultSeverity: 'error', summary: 'A signature type carries a member other than params and returns, or lacks returns; or a data type carries params or returns' },
  ],
  check(ctx) {
    // Step 1: every loaded type, in scope.
    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      const sub = t.subsystem ? ctx.subsystems.find((s) => s.id === t.subsystem) : undefined;
      const isDraft = !!sub && (sub.status === 'draft' || sub.status === 'design');
      // Step 2: is it a signature?
      if (t.kind === 'signature') {
        // Step 3: every member a signature cannot carry, and a missing returns.
        const members = [
          ...(t.fields.length > 0 ? ['fields'] : []),
          ...(t.methods.length > 0 ? ['methods'] : []),
          ...((t.invariants?.length ?? 0) > 0 ? ['invariants'] : []),
          ...(t.componentClass !== undefined ? ['componentClass'] : []),
          ...(t.database !== undefined ? ['database'] : []),
          ...(t.table !== undefined ? ['table'] : []),
          ...(t.linkedEntity !== undefined ? ['linkedEntity'] : []),
        ];
        const missingReturns = t.returns === undefined;
        if (members.length === 0 && !missingReturns) continue;
        const problems = [
          ...(members.length > 0 ? [`carries ${members.join(', ')}`] : []),
          ...(missingReturns ? ['states no returns'] : []),
        ];
        ctx.addIssue(
          'error',
          'SIGNATURE_TYPE_MEMBERS',
          `Signature type "${t.id}" ${problems.join(' and ')}. A signature is a named function type: params and one returns, nothing else.`,
          t.id,
          isDraft,
        );
        continue;
      }
      // Step 4: a data type carrying params or returns.
      const stated = [...(t.params !== undefined ? ['params'] : []), ...(t.returns !== undefined ? ['returns'] : [])];
      if (stated.length === 0) continue;
      ctx.addIssue(
        'error',
        'SIGNATURE_TYPE_MEMBERS',
        `Type "${t.id}" is ${t.kind === 'entity' ? 'an entity' : `a ${t.kind}`} and carries ${stated.join(' and ')}, which only a signature type has. Make it kind signature, or drop them.`,
        t.id,
        isDraft,
      );
    }
  },
};
