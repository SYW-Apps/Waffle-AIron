import { conceptNoun, headNoun } from '../../../models/index.js';
import type { ComponentSpec, InterfaceSpec, MethodSignature } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// A name says what a thing is, once. Four ways it stops doing that:
//   - the head noun claims a building block the component is not
//     (spec_manager_store that is an Orchestrator);
//   - the name leans on a generic role word that carries no meaning
//     ("Manager", "Helper", "Utils");
//   - a method repeats its component's concept (policy_repository.getPolicy),
//     so the call site says "policy" twice;
//   - a component with one method is merely that method's name, which means
//     it is a function wearing a component's costume.
// All four are warnings: they are judgements about naming, and a project may
// have a reason. None of them reads the description — only the identifier.
// ---------------------------------------------------------------------------

/** The words that NAME a building block, mapped to the componentType each one claims. */
const BLOCK_WORDS: Record<string, string> = {
  portal: 'Portal',
  orchestrator: 'Orchestrator',
  supervisor: 'Supervisor',
  actor: 'Actor',
  store: 'Store',
  index: 'Index',
  query: 'Query',
  registry: 'Registry',
  adapter: 'Adapter',
  observer: 'Observer',
  repository: 'Repository',
  view: 'View',
};

/**
 * Role words that describe no responsibility: every component manages,
 * handles and processes something, so the word narrows nothing.
 */
const GENERIC_WORDS: ReadonlySet<string> = new Set([
  'manager', 'helper', 'helpers', 'util', 'utils', 'handler', 'service',
  'processor', 'coordinator', 'engine', 'wrapper', 'common', 'misc', 'data', 'info',
]);

/** A concept shorter than this is too small to judge repetition on ("id", "spec", "job"). */
const MIN_CONCEPT_LENGTH = 4;

/** Split an identifier into lowercase words on underscores, hyphens and camel-case boundaries. */
function words(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/** Whether `word` is `noun` in either number — the naming stutter survives pluralization. */
function isSameNoun(word: string, noun: string): boolean {
  if (word === noun) return true;
  if (word === `${noun}s`) return true;
  return noun.endsWith('s') && word === noun.slice(0, -1);
}

/** The method name that remains once the repeated concept word is dropped: getPolicyPack → getPack. */
function withoutWord(methodWords: string[], dropIndex: number): string {
  const kept = methodWords.filter((_, i) => i !== dropIndex);
  return kept.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
}

export const namingDisciplineRule: SddRule = {
  name: 'naming-discipline',
  description:
    'A name says what a thing is and never repeats itself: a component\'s head noun names its own block, generic role words say nothing, a method does not repeat its component\'s head noun, and a component with one method is not merely that method\'s name. Adapters and Portals are exempt from the repetition check, because a forwarder\'s method mirrors the command or route it exposes.',
  codes: [
    { code: 'MISLEADING_BLOCK_WORD', defaultSeverity: 'warning', summary: 'Component\'s head noun names a building block that is not its componentType' },
    { code: 'GENERIC_COMPONENT_NAME', defaultSeverity: 'warning', summary: 'Component name or id uses a generic role word that says nothing (manager, helper, utils, handler, service)' },
    { code: 'METHOD_REPEATS_COMPONENT', defaultSeverity: 'warning', summary: 'Method name repeats its component\'s head noun; not reported on Adapter or Portal forwarders' },
    { code: 'COMPONENT_IS_ITS_ONLY_METHOD', defaultSeverity: 'warning', summary: 'Component with a single method is named after that method — fold it into its caller, or name it for its responsibility' },
  ],
  check(ctx) {
    // 1. The three component-name judgements.
    for (const comp of ctx.components) {
      const head = headNoun(comp);
      const isDraft = ctx.isComponentDraft(comp.id);
      const idWords = [...words(comp.id), ...words(comp.name)];

      // 1a. A head noun that claims another block: the id promises a Store and
      //     the spec declares an Orchestrator, so every reader is misled.
      if (BLOCK_WORDS[head] && BLOCK_WORDS[head] !== comp.componentType) {
        ctx.addIssue(
          'warning',
          'MISLEADING_BLOCK_WORD',
          `Component "${comp.id}" ends in "${head}", which names a ${BLOCK_WORDS[head]}, but it is declared a ${comp.componentType}. Rename it for what it is, or change its componentType.`,
          comp.id,
          isDraft,
        );
      }

      // 1b. A generic role word: it fits every component, so it distinguishes none.
      const generic = [...new Set(idWords.filter(w => GENERIC_WORDS.has(w)))];
      if (generic.length > 0) {
        ctx.addIssue(
          'warning',
          'GENERIC_COMPONENT_NAME',
          `Component "${comp.id}" leans on the generic role word${generic.length > 1 ? 's' : ''} ${generic.map(w => `"${w}"`).join(', ')}, which says nothing about what it does. Name it for its responsibility.`,
          comp.id,
          isDraft,
        );
      }

      // 1c. One method, named after the component: a function in a component's
      //     costume. Adapters are exempt — a client shim legitimately exposes
      //     the single remote call it wraps. Matched against the CONCEPT noun,
      //     not the head noun: a component whose id ends in a block word
      //     (skills_orchestrator, secret_write_registry) is named after its
      //     single method just as plainly, but its head noun never matches.
      //     A method named exactly the concept, singular or plural, is the
      //     component's one verb rather than a restatement of it — write() on
      //     secret_write_registry and hash() on state_hash say no more than
      //     the concept alone, so they stay silent. Only a method that adds
      //     words around the concept (buildGraph, createMcpServer, listRoles)
      //     restates the component's name and fires.
      const methods = ctx.interfaceMethodsOf(comp.id);
      if (comp.componentType !== 'Adapter' && methods.length === 1) {
        const only = methods[0];
        const concept = conceptNoun(comp);
        const onlyWords = words(only.name);
        if (onlyWords.length > 1 && onlyWords.some(w => isSameNoun(w, concept))) {
          ctx.addIssue(
            'warning',
            'COMPONENT_IS_ITS_ONLY_METHOD',
            `Component "${comp.id}" declares one method, "${only.name}", and is named after it. Fold it into its caller, or name the component for the responsibility it holds.`,
            comp.id,
            isDraft,
          );
        }
      }
    }

    // 2. The stutter check, over contract methods. A forwarder's method mirrors
    //    the command or route it exposes, so Adapters and Portals are exempt,
    //    and a concept too short to be a word is not judged at all.
    const pairs: { intf: InterfaceSpec; comp: ComponentSpec; concept: string; method: MethodSignature }[] = [];
    for (const intf of ctx.interfaces) {
      const comp = ctx.componentMap.get(intf.component);
      if (!comp || comp.componentType === 'Adapter' || comp.componentType === 'Portal') continue;
      const concept = conceptNoun(comp);
      if (concept.length < MIN_CONCEPT_LENGTH) continue;
      for (const method of intf.methods) pairs.push({ intf, comp, concept, method });
    }

    for (const { intf, comp, concept, method } of pairs) {
      // The concept must sit DIRECTLY after the leading verb: getPolicy on
      // policy_repository repeats it, while getPackPolicy qualifies it and is
      // a different thing entirely.
      const methodWords = words(method.name);
      if (methodWords.length < 2 || !isSameNoun(methodWords[1], concept)) continue;
      ctx.addIssue(
        'warning',
        'METHOD_REPEATS_COMPONENT',
        `Method "${method.name}" on component "${comp.id}" repeats the component's concept "${concept}" — the call site says it twice. Name it "${withoutWord(methodWords, 1)}".`,
        intf.id,
        ctx.isComponentDraft(comp.id),
      );
    }
  },
};
