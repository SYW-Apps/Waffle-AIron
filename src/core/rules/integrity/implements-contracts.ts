import { SddRule, type RuleContext } from '../types.js';
import { canonicalTypeText, isTypeVocabulary, parseTypeExpression, type MethodSignature, type TypeExpression } from '../../../models/index.js';

/**
 * An interface that declares `implements: alias::name` realizes another
 * project's extension point (a trait, callback or webhook contract): it must
 * declare every method of that contract with the same params and returns, read
 * from the export the reference resolves to. Whether the reference resolves,
 * and names an entry exported with role implement, is project-boundaries'
 * finding; this rule judges the shape once it does.
 */
export const implementsContractsRule: SddRule = {
  name: 'implements-contracts',
  judges: 'design',
  description:
    "An interface that declares `implements: alias::name` realizes another project's extension point, so it must declare every method of that contract with the same params and returns, read from the export the reference resolves to (a contained member's live table, or a declared external's pin). Types are compared semantically, never by spelling: the producer's own bare name and the consumer's `alias::name` (or the bare name its `use` imports) are one type. Whether the reference resolves and names an entry exported with role implement is project-boundaries' finding (EXTERNAL_NOT_EXPORTED); this rule judges the shape once it resolves. Extra methods are the implementer's own and are not reported.",
  codes: [
    { code: 'IMPLEMENTS_MISMATCH', defaultSeverity: 'error', summary: 'An interface implementing an extension point lacks one of its methods, or declares one with different params or returns' },
  ],
  check(ctx) {
    // Step 1: each in-scope interface that declares `implements`.
    for (const intf of ctx.interfaces) {
      if (intf.implements === undefined || !ctx.isSpecInScope(intf.id)) continue;
      // Steps 2-3: the extension point's methods; an unresolved or unexported
      // reference is project-boundaries' finding.
      const point = extensionPoint(ctx, intf.id, intf.implements);
      if (!point) continue;
      const { methods: contract, publicNames } = point;
      // Types compare semantically: the producer's bare name and the
      // implementer's `alias::name` (or the bare name its `use` imports) are one type.
      const alias = intf.implements.split('::')[0];
      const expectedType = (t: string): string => respelled(t, (n) => publicNames.get(lastName(n)) ?? lastName(n));
      const ownType = (t: string): string => respelled(t, (n) => (n.startsWith(`${alias}::`) ? lastName(n.slice(alias.length + 2)) : n));
      const draft = intf.status === 'draft' || intf.status === 'design' || ctx.isComponentDraft(intf.component);
      // Steps 4-6: each method of the extension point, declared alike.
      for (const expected of contract) {
        const own = intf.methods.find((m) => m.name === expected.name);
        const differs = own ? difference(expected, own, expectedType, ownType) : 'is not declared';
        if (!differs) continue;
        // The producer's rename trace: a former name this interface still declares is a rename to follow.
        const former = own ? undefined : (expected.formerly ?? []).find((f) => intf.methods.some((m) => m.name === f));
        const renamedFrom = former ? ` It was renamed from "${former}" (the producer's rename trace), which this interface still declares — rename it to "${expected.name}".` : '';
        ctx.addIssue(
          'error',
          'IMPLEMENTS_MISMATCH',
          `Interface "${intf.id}" implements "${intf.implements}", whose method "${expected.name}" ${differs === 'is not declared' ? 'it does not declare' : `it declares with ${differs}`}.${renamedFrom} An implementation of an extension point declares every method of it with the same signature: ${expected.name}(${(expected.params ?? []).map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${expected.returns}.`,
          intf.id,
          draft,
          undefined,
          { at: expected.name },
        );
      }
    }
  },
};

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

/** An extension point's methods, and how its producer's own type names read as its public names. */
interface ExtensionPoint {
  /** Each method with the former names the producer's rename trace records for it. */
  methods: (Pick<MethodSignature, 'name' | 'params' | 'returns'> & { formerly?: string[] })[];
  /** The producer's type name (last segment) → the public name it exports it by, where they differ. */
  publicNames: Map<string, string>;
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
