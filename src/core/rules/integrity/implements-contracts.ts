import { SddRule, type RuleContext } from '../types.js';
import { isLocalEntry } from '../read-model.js';
import { canonicalTypeText, isTypeVocabulary, parseTypeExpression, type ComponentSpec, type MethodSignature, type TypeExpression } from '../../../models/index.js';

/**
 * A contract's `implements` lists what it realizes: a local abstract component,
 * or another project's extension point (`alias::name`: a trait, callback or
 * webhook contract). It must declare every method of each with the same params
 * and returns, read from the abstract component's contract or from the export
 * the reference resolves to. A Portal implementing a Portal abstraction may
 * leave a verb out by listing it in `omits` with a reason. Whether an
 * `alias::name` reference resolves, and names an entry exported with role
 * implement, is project-boundaries' finding; this rule judges the shape once it
 * does. Effects and dependency class are implements-compatibility's; conflicts
 * between entries and where omits may stand are implements-consistency's.
 */
export const implementsContractsRule: SddRule = {
  name: 'implements-contracts',
  judges: 'design',
  description:
    "A contract's `implements` lists what it realizes, each entry either a local abstract component or another project's extension point (`alias::name`). A local entry resolves to that abstract component's contract; an `alias::name` entry resolves to the export it names (a contained member's live table, or a declared external's pin). The contract must declare every method of each with the same params and returns, types compared semantically, never by spelling: the producer's own bare name and the consumer's `alias::name` (or the bare name its `use` imports) are one type. This holds at every level of a chain of abstractions: an abstraction's own contract that implements abstractions is exploded, declaring every method of each of them itself, so each abstraction is one complete contract and nothing inherits, and a manual edit that renames a method on an abstraction and not on what implements it is the mismatch reported here. A Portal that implements a Portal abstraction may leave a verb out by listing it in `omits` with a reason; any other missing verb is the mismatch. Whether an `alias::name` reference resolves and names an entry exported with role implement is project-boundaries' finding (EXTERNAL_NOT_EXPORTED); this rule judges the shape once it resolves. Extra methods are the implementer's own and are not reported. Effects and dependency class are implements-compatibility's; conflicts between entries and where omits may stand are implements-consistency's.",
  codes: [
    { code: 'IMPLEMENTS_MISMATCH', defaultSeverity: 'error', summary: 'An interface implementing an abstraction or extension point lacks one of its methods (and does not list it in omits, where a Portal may), or declares one with different params or returns' },
  ],
  check(ctx) {
    // Step 1: each in-scope contract that implements an abstraction or extension point.
    for (const intf of ctx.interfaces) {
      if (intf.implements === undefined || !ctx.isSpecInScope(intf.id)) continue;
      // Step 2: the entries (a single string loads as a one-element list) and the implementer.
      const implementer = ctx.componentMap.get(intf.component);
      const draft = intf.status === 'draft' || intf.status === 'design' || ctx.isComponentDraft(intf.component);
      for (const entry of intf.implements) {
        // Steps 4-5: the methods the entry asks for; an unresolved or unexported
        // reference is project-boundaries' finding, a local entry that is no
        // abstraction implements-compatibility's.
        const point = implementedEntry(ctx, intf.id, entry);
        if (!point) continue;
        const { methods: contract } = point;
        // Types compare semantically: the producer's bare name and the
        // implementer's `alias::name` (or the bare name its `use` imports) are one type.
        const alias = entry.split('::')[0];
        const foreign = !isLocalEntry(ctx.componentMap, ctx.projectOf, intf.id, entry);
        const expectedType = entryTypeText(point);
        const ownType = foreign
          ? (t: string): string => respelled(t, (n) => (n.startsWith(`${alias}::`) ? lastName(n.slice(alias.length + 2)) : n))
          : expectedType;
        // Steps 6-10: each method of the abstraction or extension point, declared alike.
        for (const expected of contract) {
          const own = intf.methods.find((m) => m.name === expected.name);
          const differs = own ? difference(expected, own, expectedType, ownType) : 'is not declared';
          if (!differs) continue;
          // Step 8: a verb this transport deliberately does not serve, between two Portals.
          const betweenPortals = point.abstraction?.componentType === 'Portal' && implementer?.componentType === 'Portal';
          if (!own && betweenPortals && (intf.omits ?? []).some((o) => o.method === expected.name)) continue;
          // The producer's rename trace: a former name this interface still declares is a rename to follow.
          const former = own ? undefined : (expected.formerly ?? []).find((f) => intf.methods.some((m) => m.name === f));
          const renamedFrom = former ? ` It was renamed from "${former}" (the producer's rename trace), which this interface still declares — rename it to "${expected.name}".` : '';
          const portalHint = !own && betweenPortals
            ? ' A Portal serves every verb of the Portal abstraction it implements, or lists the ones its transport deliberately does not serve in omits, each with a reason.'
            : '';
          ctx.addIssue(
            'error',
            'IMPLEMENTS_MISMATCH',
            `Interface "${intf.id}" implements "${entry}", whose method "${expected.name}" ${differs === 'is not declared' ? 'it does not declare' : `it declares with ${differs}`}.${renamedFrom}${portalHint} An implementation of ${foreign ? 'an extension point' : 'an abstraction'} declares every method of it with the same signature: ${expected.name}(${(expected.params ?? []).map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${expected.returns}.`,
            intf.id,
            draft,
            undefined,
            { at: expected.name },
          );
        }
      }
    }
  },
};

/**
 * A type text in the one spelling an `implements` entry's methods are compared by: the expression in canonical
 * form, its named types read as the public names the entry's producer exports them by (the bare name where it
 * exports none). implements-contracts compares an implementer by it, and implements-consistency compares two
 * entries by it, so the two rules never disagree on whether two types are one.
 */
export function entryTypeText(point: ExtensionPoint): (text: string) => string {
  return (t) => respelled(t, (n) => point.publicNames.get(lastName(n)) ?? lastName(n));
}

/** The last segment of a possibly-qualified type name. */
function lastName(name: string): string {
  return name.split('::').pop()!.split('.').pop()!;
}

/** The expression with every named reference rewritten through `rename`, the structure kept. */
function renamed(expr: TypeExpression, rename: (name: string) => string): TypeExpression {
  const args = expr.args.map((a) => renamed(a, rename));
  return expr.form === 'named' || expr.form === 'applied' ? { ...expr, name: rename(expr.name!), args } : { ...expr, args };
}

/**
 * A type expression in the one spelling both sides compare by: parsed under
 * the type grammar and answered canonical, every named type read through
 * `rename` (wairon's own vocabulary kept). A text that does not parse is
 * compared as written, identifier by identifier.
 */
function respelled(text: string, rename: (name: string) => string): string {
  const keep = (name: string): string => (isTypeVocabulary(name) ? name : rename(name));
  const parsed = parseTypeExpression(text, 'returns');
  if (parsed.expression) return canonicalTypeText(renamed(parsed.expression, keep));
  return text.replace(/[A-Za-z_][A-Za-z0-9_-]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_-]*)*/g, keep);
}

/** How an implementer's method differs from the extension point's; undefined when it does not. Types compare semantically. */
function difference(
  expected: Pick<MethodSignature, 'params' | 'returns'>,
  own: Pick<MethodSignature, 'params' | 'returns'>,
  expectedType: (t: string) => string,
  ownType: (t: string) => string,
): string | undefined {
  const shape = (m: Pick<MethodSignature, 'params'>, as: (t: string) => string): string => (m.params ?? []).map((p) => `${as(p.type)}${p.optional ? '?' : ''}`).join(', ');
  const written = (m: Pick<MethodSignature, 'params'>): string => (m.params ?? []).map((p) => `${p.type}${p.optional ? '?' : ''}`).join(', ');
  if (shape(expected, expectedType) !== shape(own, ownType)) return `params (${written(own)}) instead of (${written(expected)})`;
  if (expectedType(expected.returns) !== ownType(own.returns)) return `returns ${own.returns} instead of ${expected.returns}`;
  return undefined;
}

/** What an `implements` entry asks for: its methods, and how its producer's own type names read as its public names. */
export interface ExtensionPoint {
  /** Each method with the former names the producer's rename trace records for it. */
  methods: (Pick<MethodSignature, 'name' | 'params' | 'returns'> & { effect?: string; formerly?: string[] })[];
  /** The producer's type name (last segment) → the public name it exports it by, where they differ. */
  publicNames: Map<string, string>;
  /** The local abstract component a local entry names; absent for another project's extension point. */
  abstraction?: ComponentSpec;
}

/**
 * The methods an `implements` entry asks for. A local entry (no `::`) names an
 * abstract component and answers its contract; an `alias::name` entry
 * resolves to the export it names (extensionPoint). Answers none for a local
 * entry that is no abstract component, and for a reference that does not
 * resolve with role implement: those are other rules' findings.
 */
export function implementedEntry(ctx: RuleContext, specId: string, entry: string): ExtensionPoint | undefined {
  if (!isLocalEntry(ctx.componentMap, ctx.projectOf, specId, entry)) return extensionPoint(ctx, specId, entry);
  const abstraction = ctx.componentMap.get(entry);
  if (!abstraction || abstraction.abstract !== true) return undefined;
  return { methods: ctx.interfaceMethodsOf(entry), publicNames: new Map(), abstraction };
}

/**
 * The methods of the extension point a reference names, read from the export
 * it resolves to: a declared external's pin or a foreign snapshot entry, else a
 * contained member's live table. Only an entry exported with role implement
 * is an extension point; anything else answers none.
 */
function extensionPoint(ctx: RuleContext, specId: string, ref: string): ExtensionPoint | undefined {
  const resolution = ctx.resolveCrossProject(specId, 'implements', ref);
  if (resolution && resolution.outcome !== 'resolved') return undefined;
  const surface = ctx.resolveSurfaceRef(ref);
  if (surface.kind === 'resolved') {
    if (surface.entry.role !== 'implement') return undefined;
    // An exported type reads as its public name: a pin's closure id may differ from it.
    const publicNames = new Map<string, string>();
    for (const t of surface.snapshot.exportedTypes ?? []) publicNames.set(lastName(t.type), t.id);
    return { methods: surface.entry.methods, publicNames };
  }

  const [alias, name] = ref.split('::');
  if (name === undefined) return undefined;
  const bound = ctx.projectFamily?.nodes.find((n) => n.namespace === '');
  const key = bound?.aliases.get(alias);
  if (key === undefined) return undefined;
  const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key);
  const entry = table?.entries.find((e) => e.kind === 'component' && e.publicName === name);
  if (!entry || entry.role !== 'implement' || !entry.component) return undefined;
  const methods = entry.interface ? ctx.interfaceMap.get(entry.interface)?.methods : ctx.interfaceMethodsOf(entry.component);
  if (!methods) return undefined;
  const traced = methods.map((m) => ({ ...m, formerly: (m.previousNames ?? []).map((k) => k.slice(k.lastIndexOf('.') + 1)) }));
  // A member's exported type reads as its public name.
  const publicNames = new Map<string, string>();
  for (const e of table?.entries ?? []) {
    if (e.kind === 'type' && e.typeDef) publicNames.set(lastName(e.typeDef), e.publicName);
  }
  return { methods: traced, publicNames };
}

/**
 * The method an exported contract's rename trace carries a former method name
 * to: `alias::name.method` whose method the producer renamed, answered with
 * its current name; undefined when the source names no export, or the method
 * was not renamed. Read from the pin (or a foreign snapshot), else from a
 * contained member's live table.
 */
export function renamedExportMethod(ctx: RuleContext, source: string): string | undefined {
  const dot = source.lastIndexOf('.');
  if (dot <= 0 || !source.includes('::')) return undefined;
  const [head, method] = [source.slice(0, dot), source.slice(dot + 1)];
  const surface = ctx.resolveSurfaceRef(head);
  if (surface.kind === 'resolved') return surface.entry.methods.find((m) => (m.formerly ?? []).includes(method))?.name;
  const [alias, name] = head.split('::');
  const key = ctx.projectFamily?.nodes.find((n) => n.namespace === '')?.aliases.get(alias);
  if (key === undefined || name === undefined) return undefined;
  const entry = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key)?.entries.find((e) => e.kind === 'component' && e.publicName === name);
  if (!entry?.component) return undefined;
  const methods = entry.interface ? ctx.interfaceMap.get(entry.interface)?.methods : ctx.interfaceMethodsOf(entry.component);
  return methods?.find((m) => (m.previousNames ?? []).some((k) => k.slice(k.lastIndexOf('.') + 1) === method))?.name;
}
