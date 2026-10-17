import { SddRule, RuleContext } from '../types.js';
import { methodCasingFor, qualifiedTypeId, reservedWordProblem, type IdentifierKind } from '../../../models/index.js';

// ---------------------------------------------------------------------------
// member-names — the names inside a spec. A contract's methods, each method's
// parameters, a type's fields and methods: unique where they live, and never a
// word the spec's effective target language reserves for that kind of
// identifier. The identifier grammar itself (empty, too long, a leading digit,
// __proto__) is the schema's; a reserved word needs the tree's targetLanguage,
// which only a rule can read.
// ---------------------------------------------------------------------------

/** One named member list: where it lives, and the names in it. */
interface Place {
  where: string;
  kind: Extract<IdentifierKind, 'method' | 'param' | 'field'>;
  names: string[];
}

/** Report each name two members of one place share, once. */
function duplicates(ctx: RuleContext, place: Place, specId: string, draft: boolean): void {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of place.names) {
    if (seen.has(name) && !reported.has(name)) {
      reported.add(name);
      ctx.addIssue('error', 'DUPLICATE_MEMBER_NAME', `${place.where} declares ${place.kind === 'param' ? 'the parameter' : place.kind === 'field' ? 'the field' : 'the method'} "${name}" twice — every lookup by name binds one of them at random, so the design has no single reading. Rename or remove one.`, specId, draft);
    }
    seen.add(name);
  }
}

/** Report each name the target language reserves for its kind. */
function reserved(ctx: RuleContext, place: Place, specId: string, language: string | undefined, casing: string, draft: boolean): void {
  for (const name of new Set(place.names)) {
    const problem = reservedWordProblem(name, place.kind, language, casing);
    if (problem) ctx.addIssue('error', 'RESERVED_IDENTIFIER', `${place.where}: ${problem}.`, specId, draft);
  }
}

export const memberNamesRule: SddRule = {
  name: 'member-names',
  judges: 'design',
  description:
    "The names inside a spec — a contract's methods and each method's parameters, a type's fields and methods and each type method's parameters — must be unique where they live (DUPLICATE_MEMBER_NAME: two methods of one contract, two parameters of one method, two fields of one type; a loaded spec otherwise binds one of them at random wherever a name is looked up), and never a word the spec's effective target language reserves for that kind of identifier (RESERVED_IDENTIFIER, identifier.reservedIn: TypeScript and JavaScript forbid a keyword as a parameter and constructor as a method, Rust its keywords everywhere, and so on per language), because the implementation the brief asks for could not be written. The message names the language and offers an alternative.",
  codes: [
    { code: 'DUPLICATE_MEMBER_NAME', defaultSeverity: 'error', summary: 'Two methods of one contract or type, two parameters of one method, or two fields of one type share a name' },
    { code: 'RESERVED_IDENTIFIER', defaultSeverity: 'error', summary: 'A method, parameter or field name is a word the target language reserves for that kind of identifier' },
  ],
  check(ctx) {
    // Steps 1-5: every interface and type in scope, in its subsystem's language.
    const judge = (specId: string, subsystem: string | undefined, places: Place[], draft: boolean): void => {
      const language = ctx.targetLanguageFor(subsystem);
      const casing = methodCasingFor(ctx.namingConfigFor(subsystem), language);
      for (const place of places) {
        duplicates(ctx, place, specId, draft);
        reserved(ctx, place, specId, language, casing, draft);
      }
    };
    for (const intf of ctx.interfaces) {
      if (!ctx.isSpecInScope(intf.id)) continue;
      const subsystem = ctx.componentMap.get(intf.component)?.subsystem;
      const places: Place[] = [{ where: `Contract "${intf.id}"`, kind: 'method', names: intf.methods.map((m) => m.name) }];
      for (const m of intf.methods) places.push({ where: `Method "${m.name}" of contract "${intf.id}"`, kind: 'param', names: (m.params ?? []).map((p) => p.name) });
      judge(intf.id, subsystem, places, ctx.isComponentDraft(intf.component));
    }
    for (const type of ctx.types) {
      const key = qualifiedTypeId(type);
      if (!ctx.isSpecInScope(type.id)) continue;
      const places: Place[] = [
        { where: `Type "${key}"`, kind: 'field', names: (type.fields ?? []).map((f) => f.name) },
        { where: `Type "${key}"`, kind: 'method', names: (type.methods ?? []).map((m) => m.name) },
        { where: `Signature type "${key}"`, kind: 'param', names: (type.params ?? []).map((p) => p.name) },
      ];
      for (const m of type.methods ?? []) places.push({ where: `Method "${m.name}" of type "${key}"`, kind: 'param', names: (m.params ?? []).map((p) => p.name) });
      judge(type.id, type.subsystem, places, false);
    }
    // Step 6: judged.
  },
};
