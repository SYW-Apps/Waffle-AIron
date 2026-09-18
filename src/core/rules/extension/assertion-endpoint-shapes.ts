import type { Endpoint, InterfaceSpec, MethodSignature } from '../../../models/index.js';
import type { RuleContext, SddRule } from '../types.js';
import { assertionsOfKind, matchesSelector, reportAssertion, type AssertionSelector } from './declared-assertion.js';

// ---------------------------------------------------------------------------
// The `endpoint-shape` assertion kind: a pack names a selector over the
// component that publishes a contract, an optional transport allowlist and an
// optional anchored pattern over the transport's address field. Every endpoint
// bound on a matching contract must fit both. The finding is the pack's
// namespaced code.
// ---------------------------------------------------------------------------

/** One endpoint the assertion's selector puts in scope, with the draft context a finding on it takes. */
interface BoundEndpoint {
  intf: InterfaceSpec;
  method: MethodSignature;
  endpoint: Endpoint;
  draft: boolean;
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

/** Every endpoint bound on a contract whose owning component resolves and matches the selector. */
function boundEndpoints(ctx: RuleContext, on: AssertionSelector): BoundEndpoint[] {
  const out: BoundEndpoint[] = [];
  for (const intf of ctx.interfaces) {
    const comp = ctx.componentMap.get(intf.component);
    if (!comp || !matchesSelector(on, comp, ctx)) continue;
    const draft = ctx.isComponentDraft(comp.id) || intf.status === 'draft' || intf.status === 'design';
    for (const method of intf.methods) {
      if (!method.endpoint) continue;
      out.push({ intf, method, endpoint: method.endpoint, draft });
    }
  }
  return out;
}

export const assertionEndpointShapesRule: SddRule = {
  name: 'assertion-endpoint-shapes',
  description:
    'Evaluates the `endpoint-shape` assertions loaded packs declare: every endpoint bound on a contract whose component matches the on-selector must use an allowed transport and bind an address (path / topic / command / pipe / channel) matching the assertion\'s anchored pattern. Findings carry the pack\'s namespaced code (<PACK>_<CODE>) and its stated reason; severity is the pack\'s declaration (project sddRuleSeverity still wins, and error downgrades to warning in draft context). The codes are the packs\' own, so no fixed code list applies.',
  // Static codes are unknown here — packs bring their own. The validator
  // gathers every loaded assertion's fullCode into knownIssueCodes.
  codes: [],
  check(ctx) {
    for (const a of assertionsOfKind(ctx, 'endpoint-shape')) {
      const pattern = a.pathPattern ? new RegExp(a.pathPattern) : undefined;
      for (const bound of boundEndpoints(ctx, a.on)) {
        const { intf, method, endpoint } = bound;
        if (a.transport?.length && !a.transport.includes(endpoint.transport)) {
          reportAssertion(ctx, a, `Endpoint of "${intf.id}.${method.name}" uses transport ${endpoint.transport}, outside the allowlist (${a.transport.join(', ')}) of assertion ${a.code}`, intf.id, bound.draft);
          continue;
        }
        const address = endpointAddress(endpoint);
        if (pattern && !pattern.test(address)) {
          reportAssertion(ctx, a, `Endpoint of "${intf.id}.${method.name}" binds "${address}", which does not match ${a.pathPattern} required by assertion ${a.code}`, intf.id, bound.draft);
        }
      }
    }
  },
};
