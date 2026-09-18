import type { ComponentSpec } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';
import { assertionsOfKind, matchesSelector, reportAssertion } from './declared-assertion.js';

// ---------------------------------------------------------------------------
// The `require-field` assertion kind: a pack names a spec level, a selector
// over the owning component and a field that must be declared there (and,
// when it states a closed value set, be one of those values). Only two field
// roots are addressable — the spec's own top-level fields and `ext.*`, the
// sanctioned pack data channel — so the DSL can never grow into a general
// query language by accident. The finding is the pack's namespaced code.
// ---------------------------------------------------------------------------

/** One spec the assertion's level puts in scope, with the component that decides selection and draft context. */
interface FieldHolder {
  spec: Record<string, unknown>;
  specId: string;
  comp: ComponentSpec;
  draft: boolean;
}

/** Resolve `field` on a spec: one top-level name, or an `ext.*` path. */
function fieldValue(spec: Record<string, unknown>, field: string): unknown {
  const segments = field.split('.');
  if (segments[0] !== 'ext') {
    return segments.length === 1 ? spec[field] : undefined;
  }
  let cur: unknown = spec.ext;
  for (const seg of segments.slice(1)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** The specs one level puts in scope — each anchored to the component the selector and the draft context read. */
function holdersAt(ctx: RuleContext, level: 'component' | 'interface' | 'implementation'): FieldHolder[] {
  const holders: FieldHolder[] = [];
  if (level === 'component') {
    for (const c of ctx.components) {
      holders.push({ spec: c as unknown as Record<string, unknown>, specId: c.id, comp: c, draft: ctx.isComponentDraft(c.id) });
    }
  } else if (level === 'interface') {
    for (const i of ctx.interfaces) {
      const comp = ctx.componentMap.get(i.component);
      if (comp) holders.push({ spec: i as unknown as Record<string, unknown>, specId: i.id, comp, draft: ctx.isComponentDraft(comp.id) || i.status === 'draft' || i.status === 'design' });
    }
  } else {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      const comp = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (comp) holders.push({ spec: impl as unknown as Record<string, unknown>, specId: impl.id, comp, draft: ctx.isImplementationDraft(impl) });
    }
  }
  return holders;
}

export const assertionRequiredFieldsRule: SddRule = {
  name: 'assertion-required-fields',
  description:
    'Evaluates the `require-field` assertions loaded packs declare: at the assertion\'s level (component / interface / implementation), every spec whose owning component matches the on-selector must declare the named field — a top-level spec field or an `ext.*` path — and, when the assertion states a closed value set, hold one of those values. Findings carry the pack\'s namespaced code (<PACK>_<CODE>) and its stated reason; severity is the pack\'s declaration (project sddRuleSeverity still wins, and error downgrades to warning in draft context). The codes are the packs\' own, so no fixed code list applies.',
  // Static codes are unknown here — packs bring their own. The validator
  // gathers every loaded assertion's fullCode into knownIssueCodes.
  codes: [],
  check(ctx) {
    for (const a of assertionsOfKind(ctx, 'require-field')) {
      for (const h of holdersAt(ctx, a.level)) {
        if (!matchesSelector(a.on, h.comp, ctx)) continue;
        const v = fieldValue(h.spec, a.field);
        if (v === undefined || v === null) {
          reportAssertion(ctx, a, `${a.level} spec "${h.specId}" does not declare "${a.field}", required by assertion ${a.code}`, h.specId, h.draft);
          continue;
        }
        if (a.values && !a.values.includes(String(v))) {
          reportAssertion(ctx, a, `${a.level} spec "${h.specId}" declares "${a.field}" = "${String(v)}", outside the allowed set (${a.values.join(', ')}) of assertion ${a.code}`, h.specId, h.draft);
        }
      }
    }
  },
};
