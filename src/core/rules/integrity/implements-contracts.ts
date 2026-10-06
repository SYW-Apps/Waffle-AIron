import { SddRule, type RuleContext } from '../types.js';
import type { MethodSignature } from '../../../models/index.js';

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
    "An interface that declares `implements: alias::name` realizes another project's extension point, so it must declare every method of that contract with the same params and returns, read from the export the reference resolves to (a contained member's live table, or a declared external's pin). Whether the reference resolves and names an entry exported with role implement is project-boundaries' finding (EXTERNAL_NOT_EXPORTED); this rule judges the shape once it resolves. Extra methods are the implementer's own and are not reported.",
  codes: [
    { code: 'IMPLEMENTS_MISMATCH', defaultSeverity: 'error', summary: 'An interface implementing an extension point lacks one of its methods, or declares one with different params or returns' },
  ],
  check(ctx) {
    // Step 1: each in-scope interface that declares `implements`.
    for (const intf of ctx.interfaces) {
      if (intf.implements === undefined || !ctx.isSpecInScope(intf.id)) continue;
      // Steps 2-3: the extension point's methods; an unresolved or unexported
      // reference is project-boundaries' finding.
      const contract = extensionPoint(ctx, intf.id, intf.implements);
      if (!contract) continue;
      const draft = intf.status === 'draft' || intf.status === 'design' || ctx.isComponentDraft(intf.component);
      // Steps 4-6: each method of the extension point, declared alike.
      for (const expected of contract) {
        const own = intf.methods.find((m) => m.name === expected.name);
        const differs = own ? difference(expected, own) : 'is not declared';
        if (!differs) continue;
        ctx.addIssue(
          'error',
          'IMPLEMENTS_MISMATCH',
          `Interface "${intf.id}" implements "${intf.implements}", whose method "${expected.name}" ${differs === 'is not declared' ? 'it does not declare' : `it declares with ${differs}`}. An implementation of an extension point declares every method of it with the same signature: ${expected.name}(${(expected.params ?? []).map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${expected.returns}.`,
          intf.id,
          draft,
          undefined,
          { at: expected.name },
        );
      }
    }
  },
};

/** How an implementer's method differs from the extension point's; undefined when it does not. */
function difference(expected: Pick<MethodSignature, 'params' | 'returns'>, own: Pick<MethodSignature, 'params' | 'returns'>): string | undefined {
  const shape = (m: Pick<MethodSignature, 'params'>): string => (m.params ?? []).map((p) => `${p.type}${p.optional ? '?' : ''}`).join(', ');
  if (shape(expected) !== shape(own)) return `params (${shape(own)}) instead of (${shape(expected)})`;
  if (expected.returns !== own.returns) return `returns ${own.returns} instead of ${expected.returns}`;
  return undefined;
}

/**
 * The methods of the extension point a reference names, read from the export
 * it resolves to: a declared external's pin or a foreign snapshot entry, else a
 * contained member's live table. Only an entry exported with role implement
 * is an extension point; anything else answers none.
 */
function extensionPoint(ctx: RuleContext, specId: string, ref: string): Pick<MethodSignature, 'name' | 'params' | 'returns'>[] | undefined {
  const resolution = ctx.resolveCrossProject(specId, 'implements', ref);
  if (resolution && resolution.outcome !== 'resolved') return undefined;
  const surface = ctx.resolveSurfaceRef(ref);
  if (surface.kind === 'resolved') return surface.entry.role === 'implement' ? surface.entry.methods : undefined;

  const [alias, name] = ref.split('::');
  if (name === undefined) return undefined;
  const bound = ctx.projectFamily?.nodes.find((n) => n.namespace === '');
  const key = bound?.aliases.get(alias);
  if (key === undefined) return undefined;
  const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === key);
  const entry = table?.entries.find((e) => e.kind === 'component' && e.publicName === name);
  if (!entry || entry.role !== 'implement' || !entry.component) return undefined;
  if (entry.interface) return ctx.interfaceMap.get(entry.interface)?.methods;
  return ctx.interfaceMethodsOf(entry.component);
}
