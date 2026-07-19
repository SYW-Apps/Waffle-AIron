import { RuleContext, SddRule } from './types.js';

// ---------------------------------------------------------------------------
// Event topology — the bipartite completeness of the pub/sub graph.
//
// Emit side: component `emits` declarations + MessageBus endpoints with
// direction: publish. Subscribe side: component `subscribesTo` declarations +
// MessageBus endpoints with direction: subscribe. Every emitted topic needs a
// consumer and every subscription a source — the observer-never-subscribed
// and announce-topic-mismatch class of bug, caught at spec level.
//
// Pairing is by exact topic string (v1; `event` is informational). A tree
// that declares no event edges at all sees nothing — request/response
// systems pay zero noise. Warnings + lint.allow (a topic consumed by an
// EXTERNAL system is a legitimate, declarable exception).
// ---------------------------------------------------------------------------

interface TopicEnd {
  topic: string;
  compId: string;
  via: string;
}

function collectEnds(ctx: RuleContext): { emitters: TopicEnd[]; subscribers: TopicEnd[] } {
  const emitters: TopicEnd[] = [];
  const subscribers: TopicEnd[] = [];

  for (const comp of ctx.components) {
    for (const e of comp.emits ?? []) {
      emitters.push({ topic: e.topic, compId: comp.id, via: 'emits declaration' });
    }
    for (const s of comp.subscribesTo ?? []) {
      subscribers.push({ topic: s.topic, compId: comp.id, via: 'subscribesTo declaration' });
    }
  }

  for (const intf of ctx.interfaces) {
    for (const method of intf.methods) {
      const ep = method.endpoint;
      if (!ep || ep.transport !== 'MessageBus') continue;
      const end: TopicEnd = {
        topic: ep.topic,
        compId: intf.component,
        via: `MessageBus endpoint on ${intf.id}.${method.name}`,
      };
      if (ep.direction === 'publish') emitters.push(end);
      else subscribers.push(end);
    }
  }

  return { emitters, subscribers };
}

export const eventTopologyRule: SddRule = {
  name: 'event-topology',
  description:
    'Bipartite completeness of the declared pub/sub graph: every topic a component emits (emits declarations, MessageBus publish endpoints) must have at least one subscriber (subscribesTo declarations, MessageBus subscribe endpoints), and every subscription must have at least one source. Pairing is by exact topic name. Trees that declare no event edges see nothing — the rule costs request/response systems zero noise. Warnings + lint.allow: a topic produced for (or consumed from) an EXTERNAL system is a legitimate, declarable exception.',
  codes: [
    { code: 'UNCONSUMED_TOPIC', defaultSeverity: 'warning', summary: 'Topic is emitted but nothing in the tree subscribes to it' },
    { code: 'UNSOURCED_SUBSCRIPTION', defaultSeverity: 'warning', summary: 'Topic is subscribed to but nothing in the tree emits it' },
  ],
  check(ctx) {
    const { emitters, subscribers } = collectEnds(ctx);
    if (emitters.length === 0 && subscribers.length === 0) return;

    const emittedTopics = new Set(emitters.map(e => e.topic));
    const subscribedTopics = new Set(subscribers.map(s => s.topic));

    for (const e of emitters) {
      if (subscribedTopics.has(e.topic)) continue;
      ctx.addIssue(
        'warning',
        'UNCONSUMED_TOPIC',
        `Component "${e.compId}" emits topic "${e.topic}" (${e.via}), but nothing in this tree subscribes to it — the event goes nowhere. Wire a subscriber (subscribesTo, or a MessageBus subscribe endpoint), fix the topic name, or lint.allow with the external consumer named.`,
        e.compId,
        ctx.isComponentDraft(e.compId),
      );
    }
    for (const s of subscribers) {
      if (emittedTopics.has(s.topic)) continue;
      ctx.addIssue(
        'warning',
        'UNSOURCED_SUBSCRIPTION',
        `Component "${s.compId}" subscribes to topic "${s.topic}" (${s.via}), but nothing in this tree emits it — the handler can never fire from inside this system. Wire the emitter (emits, or a MessageBus publish endpoint), fix the topic name, or lint.allow with the external source named.`,
        s.compId,
        ctx.isComponentDraft(s.compId),
      );
    }
  },
};
