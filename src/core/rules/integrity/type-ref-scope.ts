import { SddRule } from '../types.js';
import { fieldTypeRefs, isDraftSubsystem, methodTypeRefs, qualifiedTypeId, signatureTypeRefs } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// Type reference scope: a bare type name settles in the referring spec's own
// subsystem first (type_ref_resolution.resolve). Two readings are still worth
// a word, and each is reported once per (spec, reference): a name that matches
// several types and nothing in the referrer's own subsystem settles which is
// meant, and a name that binds to another subsystem's type while the
// referrer's own subsystem holds a type carrying that display name.
// ---------------------------------------------------------------------------

export const typeRefScopeRule: SddRule = {
  name: 'type-ref-scope',
  judges: 'design',
  description:
    "A bare type reference resolves in the referring spec's own subsystem first (type_ref_resolution.resolve). Two readings are reported, once per spec and reference: a reference that matches several types and nothing in its own subsystem settles which is meant (ambiguous), and a reference that silently lands in another subsystem's type while the referrer's own subsystem holds a type carrying that display name (shadowed). Judged for every type position — contract method params and returns, type fields, type-method signatures, signature-type params and returns — and for every L1 and L0 export entry's typeDef, in the draft context of the referring spec. An unresolved reference is UNDEFINED_TYPE_REFERENCE's to report, never this rule's.",
  codes: [
    { code: 'AMBIGUOUS_TYPE_REF', defaultSeverity: 'warning', summary: "A written type reference matches several types, or binds to another subsystem's type while the referrer's own subsystem holds a type of that name" },
  ],
  check(ctx) {
    const byQualified = new Map(ctx.types.map((t) => [qualifiedTypeId(t), t]));
    const reported = new Set<string>();

    /** Judge one reference as written in `owner` (a spec of subsystem `from`). */
    const judgeTypeRef = (owner: string, ref: string, from: string | undefined, isDraftCtx: boolean): void => {
      if (ctx.isBuiltinType(ref)) return;
      const key = `${owner}\u0000${ref}`;
      if (reported.has(key)) return;
      const r = ctx.resolveTypeRef(ref, from);
      if (r.outcome === 'ambiguous') {
        reported.add(key);
        const listed = r.candidates
          .map((id) => `${byQualified.get(id)?.id ?? id} (subsystem ${byQualified.get(id)?.subsystem ?? 'none'})`)
          .join(', ');
        ctx.addIssue(
          'warning',
          'AMBIGUOUS_TYPE_REF',
          `${ref} in ${owner} matches ${r.candidates.length} types: ${listed} — write it as subsystem::name to say which is meant`,
          owner,
          isDraftCtx,
        );
      } else if (r.outcome === 'resolved' && r.shadowedBy !== undefined) {
        reported.add(key);
        const hit = ctx.types.find((t) => t.id === r.type);
        const shadow = ctx.types.find((t) => t.id === r.shadowedBy);
        ctx.addIssue(
          'warning',
          'AMBIGUOUS_TYPE_REF',
          `${ref} in ${owner} binds to ${hit ? qualifiedTypeId(hit) : r.type}, while subsystem ${from} holds ${r.shadowedBy}, also named ${shadow?.name ?? ref} — write the type's id, or subsystem::name, to say which is meant`,
          owner,
          isDraftCtx,
        );
      }
    };

    // Steps 1-2: the references a contract's methods name, read from the component's subsystem.
    for (const intf of ctx.interfaces) {
      if (!ctx.isSpecInScope(intf.id)) continue;
      const from = ctx.componentMap.get(intf.component)?.subsystem;
      const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      for (const m of intf.methods) {
        if (m.signatureFrom !== undefined) continue;
        for (const ref of methodTypeRefs(m)) judgeTypeRef(intf.id, ref, from, isDraftCtx);
      }
    }

    // Steps 3-4: the references a type names, read from the type's own subsystem.
    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      const sub = ctx.subsystems.find((s) => s.id === t.subsystem);
      const isDraftCtx = sub ? isDraftSubsystem(sub) : false;
      const refs = [
        ...t.fields.flatMap((f) => fieldTypeRefs(t, f.type)),
        ...t.methods.filter((m) => m.params !== undefined).flatMap((m) => methodTypeRefs(m)),
        ...signatureTypeRefs(t),
      ];
      for (const ref of refs) judgeTypeRef(t.id, ref, t.subsystem, isDraftCtx);
    }

    // Steps 5-6: the typeDef of every L1 and L0 export entry.
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      for (const pi of sub.publicInterfaces) if (pi.typeDef) judgeTypeRef(sub.id, pi.typeDef, sub.id, isDraftCtx);
    }
    for (const e of ctx.system.publicInterfaces ?? []) {
      if (e.typeDef) judgeTypeRef(ctx.system.name ?? 'system', e.typeDef, undefined, false);
    }
  },
};
