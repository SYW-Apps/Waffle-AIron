import { SddRule } from './types.js';

/**
 * Resolves a component's `variant` against the loaded variant registry. The
 * variant must be declared (UNKNOWN_VARIANT), and the component's stereotype must
 * equal the variant's declared base (VARIANT_BASE_MISMATCH) — a variant is always
 * "a kind of <base stereotype>", never a cross-cutting attribute. The base stays
 * authoritative for generic semantics; the variant adds domain vocabulary + a
 * stable rule target + the implementation guidance the implementer reuses across
 * same-variant components.
 */
export const variantReferencesRule: SddRule = {
  name: 'component-variants',
  description:
    "A component's variant resolves to a declared registry variant (UNKNOWN_VARIANT), and the component's stereotype equals the variant's declared base (VARIANT_BASE_MISMATCH). A variant is a base-anchored specialization (a kind of the base stereotype), not a cross-cutting attribute — those stay method guarantees.",
  codes: [
    { code: 'UNKNOWN_VARIANT', defaultSeverity: 'warning', summary: 'Component references a variant no registry declares' },
    { code: 'VARIANT_BASE_MISMATCH', defaultSeverity: 'error', summary: "Component's stereotype does not match the variant's declared base" },
  ],
  check(ctx) {
    if (!ctx.components.some(c => c.variant)) return;

    const byId = new Map(ctx.variants.map(v => [v.id, v]));

    for (const comp of ctx.components) {
      if (!comp.variant) continue;
      const isDraftCtx = ctx.isComponentDraft(comp.id);
      const def = byId.get(comp.variant);
      if (!def) {
        ctx.addIssue(
          'warning',
          'UNKNOWN_VARIANT',
          `Component "${comp.id}" declares variant "${comp.variant}", which no loaded variant registry declares. Define it under .wai/variants/ or the global variants directory (or remove the reference).`,
          comp.id,
          isDraftCtx,
        );
        continue;
      }
      if (def.base !== comp.componentType) {
        ctx.addIssue(
          'error',
          'VARIANT_BASE_MISMATCH',
          `Component "${comp.id}" is a ${comp.componentType}, but variant "${comp.variant}" specializes base "${def.base}". A variant may only be worn by a component of its base stereotype.`,
          comp.id,
          isDraftCtx,
        );
      }
    }
  },
};
