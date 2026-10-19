import { SddRule } from '../types.js';
import { fieldTypeRefs, isDraftSubsystem, methodTypeRefs, qualifiedTypeId, writtenTypeRefs } from '../../../models/index.js';

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
    "A bare type reference resolves in the referring spec's own subsystem first (type_ref_resolution.resolve). Two readings are reported, once per spec and written reference (never per type, so a type having other referents never masks it), naming every position in that spec where the reference is written: a reference that matches several types and nothing in its own subsystem settles which is meant (ambiguous), and a reference that silently lands on one type while another type carries that display name and sits at least as close to the referrer — the referrer's own subsystem nearest, a project-level type in the middle, another subsystem far (shadowed). Judged for every type position — contract method params and returns, type fields, type-method signatures, signature-type params and returns — and for every L1 and L0 export entry's typeDef, in the draft context of the referring spec, whether or not the referring spec is reached or the type used. An unresolved reference is UNDEFINED_TYPE_REFERENCE's to report, never this rule's.",
  codes: [
    { code: 'AMBIGUOUS_TYPE_REF', defaultSeverity: 'warning', summary: "A written type reference matches several types, or binds to a type while another type carries that name and sits at least as close to the referrer" },
  ],
  check(ctx) {
    const byQualified = new Map(ctx.types.map((t) => [qualifiedTypeId(t), t]));
    /** Every written (owner, reference): where it is judged from and every position it is written at, in order. */
    const noted = new Map<string, { owner: string; ref: string; from: string | undefined; isDraftCtx: boolean; positions: string[] }>();

    /** Note one reference as written in `owner` (a spec of subsystem `from`) at `position`. */
    const noteTypeRef = (owner: string, ref: string, from: string | undefined, isDraftCtx: boolean, position: string): void => {
      if (ctx.isBuiltinType(ref)) return;
      const key = `${owner}|${ref}`;
      const held = noted.get(key);
      if (held) { if (!held.positions.includes(position)) held.positions.push(position); return; }
      noted.set(key, { owner, ref, from, isDraftCtx, positions: [position] });
    };
    /** The positions a method's references are written at (params first, then the result). */
    const methodPositions = (m: { name: string; signature?: string; returns?: string; params?: { name: string; type: string }[] }, prefix: string): [string, string[]][] => {
      if (m.params && m.params.length > 0) {
        return [
          ...m.params.map((prm): [string, string[]] => [`${prefix}method ${m.name} param ${prm.name}`, writtenTypeRefs(prm.type, 'param')]),
          ...(m.returns !== undefined ? [[`${prefix}method ${m.name} returns`, writtenTypeRefs(m.returns, 'returns')] as [string, string[]]] : []),
        ];
      }
      return [[`${prefix}method ${m.name}`, methodTypeRefs(m)]];
    };

    // Steps 1-2: the references a contract's methods name, read from the component's subsystem.
    for (const intf of ctx.interfaces) {
      if (!ctx.isSpecInScope(intf.id)) continue;
      const from = ctx.componentMap.get(intf.component)?.subsystem;
      const isDraftCtx = ctx.isComponentDraft(intf.component) || intf.status === 'draft' || intf.status === 'design';
      for (const m of intf.methods) {
        if (m.signatureFrom !== undefined) continue;
        for (const [position, refs] of methodPositions(m, '')) for (const ref of refs) noteTypeRef(intf.id, ref, from, isDraftCtx, position);
      }
    }

    // Steps 3-4: the references a type names, read from the type's own subsystem.
    for (const t of ctx.types) {
      if (!ctx.isSpecInScope(t.id)) continue;
      const sub = ctx.subsystems.find((s) => s.id === t.subsystem);
      const isDraftCtx = sub ? isDraftSubsystem(sub) : false;
      for (const f of t.fields) for (const ref of fieldTypeRefs(t, f.type)) noteTypeRef(t.id, ref, t.subsystem, isDraftCtx, `field ${f.name}`);
      for (const m of t.methods.filter((x) => x.params !== undefined)) {
        for (const [position, refs] of methodPositions(m, '')) for (const ref of refs) noteTypeRef(t.id, ref, t.subsystem, isDraftCtx, position);
      }
      if (t.kind === 'signature') {
        for (const prm of t.params ?? []) for (const ref of writtenTypeRefs(prm.type, 'signature-param')) noteTypeRef(t.id, ref, t.subsystem, isDraftCtx, `signature param ${prm.name}`);
        if (t.returns !== undefined) for (const ref of writtenTypeRefs(t.returns, 'signature-returns')) noteTypeRef(t.id, ref, t.subsystem, isDraftCtx, 'signature returns');
      }
    }

    // Steps 5-6: the typeDef of every L1 and L0 export entry.
    const entryName = (e: { as?: string; typeDef?: string }): string => e.as ?? (e.typeDef ?? '').split('::').pop() ?? '';
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      for (const pi of sub.publicInterfaces) if (pi.typeDef) noteTypeRef(sub.id, pi.typeDef, sub.id, isDraftCtx, `export entry ${entryName(pi)}`);
    }
    for (const e of ctx.system.publicInterfaces ?? []) {
      if (e.typeDef) noteTypeRef(ctx.system.name ?? 'system', e.typeDef, undefined, false, `export entry ${entryName(e)}`);
    }

    // Steps 7-8: each (owner, reference) judged once, naming every position it is written at.
    for (const { owner, ref, from, isDraftCtx, positions } of noted.values()) {
      const r = ctx.resolveTypeRef(ref, from);
      const at = `(at ${positions.join(', ')})`;
      if (r.outcome === 'ambiguous') {
        const listed = r.candidates
          .map((id) => `${byQualified.get(id)?.id ?? id} (subsystem ${byQualified.get(id)?.subsystem ?? 'none'})`)
          .join(', ');
        ctx.addIssue(
          'warning',
          'AMBIGUOUS_TYPE_REF',
          `${ref} in ${owner} matches ${r.candidates.length} types: ${listed} — write it as subsystem::name to say which is meant ${at}`,
          owner,
          isDraftCtx,
        );
      } else if (r.outcome === 'resolved' && r.shadowedBy !== undefined) {
        const hit = ctx.types.find((t) => t.id === r.type);
        const shadow = ctx.types.find((t) => t.id === r.shadowedBy);
        const where = shadow?.subsystem !== undefined ? `subsystem ${shadow.subsystem}` : 'the project level';
        ctx.addIssue(
          'warning',
          'AMBIGUOUS_TYPE_REF',
          `${ref} in ${owner} binds to ${hit ? qualifiedTypeId(hit) : r.type}, while ${where} holds ${r.shadowedBy}, also named ${shadow?.name ?? ref} — write the type's id, or subsystem::name, to say which is meant ${at}`,
          owner,
          isDraftCtx,
        );
      }
    }
  },
};
