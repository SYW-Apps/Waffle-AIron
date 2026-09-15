import { RuleContext, SddRule } from '../types.js';

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

/** One topic on one component, on one side of the pub/sub graph. */
interface TopicEnd {
  topic: string;
  compId: string;
  /** Every distinct declaration binding the topic on this component, in declaration order. */
  vias: string[];
}

function collectEnds(ctx: RuleContext): { emitters: TopicEnd[]; subscribers: TopicEnd[] } {
  const emitters = new Map<string, TopicEnd>();
  const subscribers = new Map<string, TopicEnd>();

  // A topic declared more than once on one component (an emits entry and a
  // publish endpoint, or two endpoints) is one end, so it is judged once.
  // Keyed with '#', which no component id contains, so the first '#' always
  // ends the id whatever the topic holds.
  const addEnd = (ends: Map<string, TopicEnd>, topic: string, compId: string, via: string): void => {
    const key = `${compId}#${topic}`;
    const end = ends.get(key);
    if (!end) ends.set(key, { topic, compId, vias: [via] });
    else if (!end.vias.includes(via)) end.vias.push(via);
  };

  for (const comp of ctx.components) {
    for (const e of comp.emits ?? []) {
      addEnd(emitters, e.topic, comp.id, 'emits declaration');
    }
    for (const s of comp.subscribesTo ?? []) {
      addEnd(subscribers, s.topic, comp.id, 'subscribesTo declaration');
    }
  }

  for (const intf of ctx.interfaces) {
    for (const method of intf.methods) {
      const ep = method.endpoint;
      if (!ep || ep.transport !== 'MessageBus') continue;
      addEnd(
        ep.direction === 'publish' ? emitters : subscribers,
        ep.topic,
        intf.component,
        `MessageBus endpoint on ${intf.id}.${method.name}`,
      );
    }
  }

  return { emitters: [...emitters.values()], subscribers: [...subscribers.values()] };
}

export const eventTopologyRule: SddRule = {
  name: 'event-topology',
  description:
    'Bipartite completeness of the declared pub/sub graph: every topic a component emits (emits declarations, MessageBus publish endpoints) must have at least one subscriber (subscribesTo declarations, MessageBus subscribe endpoints), and every subscription must have at least one source. Pairing is by exact topic name, and a topic is reported once per component however many declarations bind it there. Trees that declare no event edges see nothing — the rule costs request/response systems zero noise. Warnings + lint.allow: a topic produced for (or consumed from) an EXTERNAL system is a legitimate, declarable exception.',
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
        `Component "${e.compId}" emits topic "${e.topic}" (${e.vias.join(', ')}), but nothing in this tree subscribes to it — the event goes nowhere. Wire a subscriber (subscribesTo, or a MessageBus subscribe endpoint), fix the topic name, or lint.allow with the external consumer named.`,
        e.compId,
        ctx.isComponentDraft(e.compId),
      );
    }
    for (const s of subscribers) {
      if (emittedTopics.has(s.topic)) continue;
      ctx.addIssue(
        'warning',
        'UNSOURCED_SUBSCRIPTION',
        `Component "${s.compId}" subscribes to topic "${s.topic}" (${s.vias.join(', ')}), but nothing in this tree emits it — the handler can never fire from inside this system. Wire the emitter (emits, or a MessageBus publish endpoint), fix the topic name, or lint.allow with the external source named.`,
        s.compId,
        ctx.isComponentDraft(s.compId),
      );
    }
  },
};
