import { SddRule } from '../types.js';
import { isDraftSubsystem } from '../../../models/index.js';

const pubTypeMatches = (piType: string, ct: string, portalType?: string): boolean => {
  switch (piType) {
    case 'REST':       return ct === 'Portal' && portalType === 'HTTP_API';
    case 'GraphQL':    return ct === 'Portal' && portalType === 'GraphQL';
    case 'RPC':        return ct === 'Portal' && portalType === 'gRPC';
    case 'MessageBus': return (ct === 'Portal' && portalType === 'MessageBus') || ct === 'Observer';
    case 'Custom':     return true;
    default:           return true;
  }
};

// Strong event/async signal words. Used only to flag a Custom-typed public
// interface whose prose describes eventing but whose backing component can't
// realize it (see PUBLIC_INTERFACE_EVENT_MISTYPED below).
// Verb-form "subscribe" signals eventing; the noun "subscription" is deliberately
// omitted — it collides with domain nouns (e.g. billing "subscription plans").
const EVENT_VOCAB = /\b(async|asynchronous|queue|queued|queues|event|events|event-driven|listen|listens|listening|listener|subscribe|subscribes|pub\/sub|stream|streams|streaming|emit|emits|emitted|message[\s-]?bus)\b/i;

const expectedFor = (t: string): string => {
  switch (t) {
    case 'REST':       return 'a Portal with portalType HTTP_API';
    case 'GraphQL':    return 'a Portal with portalType GraphQL';
    case 'RPC':        return 'a Portal with portalType gRPC';
    case 'MessageBus': return 'a Portal with portalType MessageBus, or an Observer';
    default:           return 'a compatible component';
  }
};

/**
 * Public surface, question two: CAN THE BACKING COMPONENT REALIZE WHAT THE
 * ENTRY DECLARES. The declared type (REST, GraphQL, RPC, MessageBus, Custom)
 * is matched against the backing component's stereotype and portalType — and
 * `Custom`, the escape hatch that carries no backing obligation, is held to
 * its prose.
 *
 * The type matrix lives here and nowhere else: pubTypeMatches, expectedFor and
 * EVENT_VOCAB are read by this rule alone. Whether the entry is BOUND at all
 * stays public-surface-binding's question, whose two preconditions (a named
 * component that resolves) are restated here — a broken binding says nothing
 * about a type, and accusing on top of it would be a second finding for one
 * fault.
 */
export const publicSurfaceDeclaredTypeRule: SddRule = {
  name: 'public-surface-declared-type',
  description:
    'A publicInterface entry\'s declared type must be realizable by the stereotype of its backing component; Custom entries whose prose implies eventing must be backed by an event-capable component.',
  codes: [
    { code: 'PUBLIC_INTERFACE_TYPE_MISMATCH', defaultSeverity: 'error', summary: 'Backing component cannot realize the declared interface type' },
    { code: 'PUBLIC_INTERFACE_EVENT_MISTYPED', defaultSeverity: 'warning', summary: 'Custom interface describing eventing backed by a non-event component' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = isDraftSubsystem(sub);
      for (const pi of sub.publicInterfaces) {
        // public-surface-binding's preconditions, restated: an unbound or
        // unresolvable entry is its finding, and has no stereotype to judge.
        const backing = pi.component ? ctx.componentMap.get(pi.component) : undefined;
        if (!backing) continue;

        if (!pubTypeMatches(pi.type, backing.componentType, backing.portalType)) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_TYPE_MISMATCH', `Subsystem "${sub.id}" declares a ${pi.type} public interface backed by "${pi.component}" (${backing.componentType}${backing.portalType ? `/${backing.portalType}` : ''}), which cannot realize ${pi.type}. Expected ${expectedFor(pi.type)}.`, sub.id, isDraftCtx);
        }
        // Heuristic — closes the "escape to Custom" hole. `Custom` is the only public
        // interface type that carries no backing obligation, so an unrealized event
        // boundary can hide there: declare an async queue/event contract as Custom and
        // back it with an ordinary Orchestrator (a synchronous push). The type matrix
        // can't catch that, but the contradiction is legible in the prose — event/async
        // vocabulary in `details` while the backing component cannot actually realize
        // eventing. Warn so the mislabel surfaces; override via rules.sddRuleSeverity.
        if (pi.type === 'Custom' && EVENT_VOCAB.test(pi.details)) {
          const eventCapable = backing.componentType === 'Observer'
            || (backing.componentType === 'Portal' && backing.portalType === 'MessageBus');
          if (!eventCapable) {
            ctx.addIssue('warning', 'PUBLIC_INTERFACE_EVENT_MISTYPED', `Subsystem "${sub.id}" declares a Custom public interface whose description implies an event/async boundary ("${pi.details}"), but it is backed by "${pi.component}" (${backing.componentType}${backing.portalType ? `/${backing.portalType}` : ''}), which cannot realize eventing. If this is genuinely event-driven, type it MessageBus and back it with an Observer or a Portal(MessageBus); otherwise reword the description to match the synchronous contract.`, sub.id, isDraftCtx);
          }
        }
      }
    }
  },
};
