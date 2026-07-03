import { SddRule } from './types.js';

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
 * Public interface binding: each declared publicInterface must be backed by a
 * real component in the SAME subsystem whose type can realize the declared
 * interface. This is what makes "which components are public"
 * machine-checkable (and catches a declared interface no component implements).
 */
export const publicSurfaceRule: SddRule = {
  name: 'public-surface',
  description:
    'Every declared publicInterface is bound to an existing component of this subsystem whose stereotype can realize the declared interface type; Custom entries whose prose implies eventing must be backed by an event-capable component.',
  codes: [
    { code: 'PUBLIC_INTERFACE_UNBOUND', defaultSeverity: 'error', summary: 'Public interface with no backing component' },
    { code: 'PUBLIC_INTERFACE_INVALID_COMPONENT', defaultSeverity: 'error', summary: 'Public interface references a non-existent component' },
    { code: 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', defaultSeverity: 'error', summary: 'Subsystem publishing a component it does not own' },
    { code: 'PUBLIC_INTERFACE_TYPE_MISMATCH', defaultSeverity: 'error', summary: 'Backing component cannot realize the declared interface type' },
    { code: 'PUBLIC_INTERFACE_INVALID_INTERFACE', defaultSeverity: 'error', summary: 'Bound L3 interface missing or belonging to another component' },
    { code: 'PUBLIC_INTERFACE_EVENT_MISTYPED', defaultSeverity: 'warning', summary: 'Custom interface describing eventing backed by a non-event component' },
  ],
  check(ctx) {
    for (const sub of ctx.subsystems) {
      const isDraftCtx = sub.status === 'draft' || sub.status === 'design';
      for (const pi of sub.publicInterfaces) {
        if (!pi.component) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_UNBOUND', `Subsystem "${sub.id}" declares a ${pi.type} public interface with no backing component. Bind it to the component that realizes it (publicInterfaces[].component).`, sub.id, isDraftCtx);
          continue;
        }
        const backing = ctx.componentMap.get(pi.component);
        if (!backing) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_COMPONENT', `Subsystem "${sub.id}" public interface references component "${pi.component}" which does not exist.`, sub.id, isDraftCtx);
          continue;
        }
        const isSubsystemOwner = backing.subsystem === sub.id || backing.subsystem.startsWith(sub.id + '::');
        if (!isSubsystemOwner) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_FOREIGN_COMPONENT', `Subsystem "${sub.id}" publishes component "${pi.component}", but it belongs to subsystem "${backing.subsystem}". A subsystem may only publish its own components.`, sub.id, isDraftCtx);
        }
        if (!pubTypeMatches(pi.type, backing.componentType, backing.portalType)) {
          ctx.addIssue('error', 'PUBLIC_INTERFACE_TYPE_MISMATCH', `Subsystem "${sub.id}" declares a ${pi.type} public interface backed by "${pi.component}" (${backing.componentType}${backing.portalType ? `/${backing.portalType}` : ''}), which cannot realize ${pi.type}. Expected ${expectedFor(pi.type)}.`, sub.id, isDraftCtx);
        }
        if (pi.interface) {
          const intf = ctx.interfaceMap.get(pi.interface);
          if (!intf) {
            ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" public interface references interface "${pi.interface}" which does not exist.`, sub.id, isDraftCtx);
          } else if (intf.component !== pi.component) {
            ctx.addIssue('error', 'PUBLIC_INTERFACE_INVALID_INTERFACE', `Subsystem "${sub.id}" binds interface "${pi.interface}" to component "${pi.component}", but that interface belongs to component "${intf.component}".`, sub.id, isDraftCtx);
          }
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
