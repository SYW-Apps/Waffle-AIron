import type { ComponentSpec, Endpoint } from '../../models/index.js';
import type { AssertionSelector, LoadedAssertion } from '../extensions.js';
import type { RuleContext, SddRule, Severity } from './types.js';

// ---------------------------------------------------------------------------
// Declarative rule assertions (docs/design/declarative-rule-dsl.md): packs
// contribute INSTANCES of closed assertion kinds — parameters, never logic —
// so hosted (declarative-only) packs can carry real doctrine. This one rule
// evaluates every loaded assertion; the finding codes are the packs'
// namespaced codes, which join knownIssueCodes at context build so
// lint.allow and sddRuleSeverity treat them exactly like builtins.
// ---------------------------------------------------------------------------

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '.*' : `\\${ch}`));
  return new RegExp(`^${escaped}$`);
}

function matches(sel: AssertionSelector, comp: ComponentSpec, ctx: RuleContext): boolean {
  if (sel.componentType?.length && !sel.componentType.includes(comp.componentType)) return false;
  if (sel.profile?.length && !sel.profile.includes(ctx.getComponentProfile(comp.id))) return false;
  if (sel.id && !globToRegExp(sel.id).test(comp.id)) return false;
  return true;
}

/** The one address field each transport carries (validated by EndpointSchema). */
function endpointAddress(ep: Endpoint): string {
  switch (ep.transport) {
    case 'HTTP': return ep.path;
    case 'gRPC': return `${ep.service}/${ep.method}`;
    case 'GraphQL': return ep.field;
    case 'MessageBus': return ep.topic;
    case 'NamedPipe': return ep.pipe;
    case 'IPC': return ep.channel;
    case 'CLI': return ep.command;
    case 'Custom': return ep.address;
  }
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

export const declarativeAssertionsRule: SddRule = {
  name: 'declarative-assertions',
  description:
    'Evaluates the declarative rule assertions loaded packs declare (forbid-edge / require-field / endpoint-shape) — closed kinds instantiated with pack data, the hosted-safe doctrine channel. Findings carry the pack\'s namespaced code (<PACK>_<CODE>) and its stated reason; severity is the pack\'s declaration (project sddRuleSeverity still wins, and error downgrades to warning in draft context).',
  // Static codes are unknown here — packs bring their own. buildRuleContext
  // adds every loaded assertion's fullCode to knownIssueCodes.
  codes: [],
  check(ctx) {
    const assertions: LoadedAssertion[] = ctx.ext.assertions;
    if (!assertions.length) return;

    const emit = (a: LoadedAssertion, message: string, specId: string, isDraftCtx: boolean): void => {
      // Pack severity is the default; drafts soften errors (doctrine is
      // completeness-class, and pack codes cannot join the static
      // COMPLETENESS_RULES set, so the downgrade lives here).
      const severity: Severity = isDraftCtx && a.severity === 'error' ? 'warning' : a.severity;
      ctx.addIssue(severity, a.fullCode, `${message} [pack "${a.pack}"]: ${a.reason}`, specId, isDraftCtx);
    };

    for (const a of assertions) {
      if (a.kind === 'forbid-edge') {
        for (const comp of ctx.components) {
          if (!matches(a.from, comp, ctx)) continue;
          const isDraftCtx = ctx.isComponentDraft(comp.id);
          for (const relation of a.relation) {
            for (const targetId of comp[relation]) {
              const target = ctx.componentMap.get(targetId);
              if (!target || !matches(a.to, target, ctx)) continue;
              emit(a, `Component "${comp.id}" (${comp.componentType}) ${relation === 'owns' ? 'owns' : 'depends on'} "${target.id}" (${target.componentType}), forbidden by assertion ${a.code}`, comp.id, isDraftCtx);
            }
          }
        }
      } else if (a.kind === 'require-field') {
        type Holder = { spec: Record<string, unknown>; specId: string; comp: ComponentSpec; draft: boolean };
        const holders: Holder[] = [];
        if (a.level === 'component') {
          for (const c of ctx.components) holders.push({ spec: c as unknown as Record<string, unknown>, specId: c.id, comp: c, draft: ctx.isComponentDraft(c.id) });
        } else if (a.level === 'interface') {
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
        for (const h of holders) {
          if (!matches(a.on, h.comp, ctx)) continue;
          const v = fieldValue(h.spec, a.field);
          if (v === undefined || v === null) {
            emit(a, `${a.level} spec "${h.specId}" does not declare "${a.field}", required by assertion ${a.code}`, h.specId, h.draft);
          } else if (a.values && !a.values.includes(String(v))) {
            emit(a, `${a.level} spec "${h.specId}" declares "${a.field}" = "${String(v)}", outside the allowed set (${a.values.join(', ')}) of assertion ${a.code}`, h.specId, h.draft);
          }
        }
      } else if (a.kind === 'endpoint-shape') {
        const pattern = a.pathPattern ? new RegExp(a.pathPattern) : undefined;
        for (const intf of ctx.interfaces) {
          const comp = ctx.componentMap.get(intf.component);
          if (!comp || !matches(a.on, comp, ctx)) continue;
          const isDraftCtx = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
          for (const method of intf.methods) {
            if (!method.endpoint) continue;
            const ep = method.endpoint;
            if (a.transport?.length && !a.transport.includes(ep.transport)) {
              emit(a, `Endpoint of "${intf.id}.${method.name}" uses transport ${ep.transport}, outside the allowlist (${a.transport.join(', ')}) of assertion ${a.code}`, intf.id, isDraftCtx);
              continue;
            }
            const address = endpointAddress(ep);
            if (pattern && !pattern.test(address)) {
              emit(a, `Endpoint of "${intf.id}.${method.name}" binds "${address}", which does not match ${a.pathPattern} required by assertion ${a.code}`, intf.id, isDraftCtx);
            }
          }
        }
      }
    }
  },
};
