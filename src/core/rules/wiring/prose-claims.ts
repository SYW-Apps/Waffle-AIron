import { ComponentSpec } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Prose-claim linter — durability/side-effect phrases whose step graph has no
// matching edge. A heuristic tripwire, deliberately conservative: the durable
// fix is dispatch tables + durability tags making the claims structural.
// ---------------------------------------------------------------------------

/** Data-layer stereotypes — where persistence/registration claims are structurally realized. */
const DATA_STEREOTYPES = new Set(['Store', 'Registry', 'Index', 'Adapter', 'Repository']);

function componentOfImpl(ctx: RuleContext, implContract: string): ComponentSpec | undefined {
  const contract = ctx.interfaceMap.get(implContract);
  return contract ? ctx.componentMap.get(contract.component) : undefined;
}

const CLAIM_PHRASES = /\b(persist(s|ed|ent)?|survives?\s+(a\s+)?restart|writ(es?|ten)\s+to\s+disk|registered\s+into|durabl[ey])\b/i;

export const proseClaimRule: SddRule = {
  name: 'prose-claims',
  description:
    'Flags durability/side-effect claims that exist only in prose: a local step description or an intent paragraph claiming persistence ("persisted", "survives restart", "registered into") on a logic component whose narrative has no call/dispatch edge to any data-layer component (Store/Registry/Index/Adapter/Repository). Data-layer components are exempt — they ARE the persistence.',
  codes: [
    { code: 'UNREALIZED_CLAIM', defaultSeverity: 'warning', summary: 'Durability/side-effect claim in prose with no matching structural edge' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const comp = componentOfImpl(ctx, impl.contract);
      if (!comp) continue;
      // The persistence layer legitimately talks about persisting.
      if (DATA_STEREOTYPES.has(comp.componentType)) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);

      for (const implMethod of impl.methods) {
        // Cheap regex gate first: almost no methods carry claims, so the
        // graph probing below only runs on actual hits.
        const stepClaims = implMethod.narrative
          .filter(step => step.type === 'local')
          .map(step => ({ step, claim: CLAIM_PHRASES.exec(step.description) }))
          .filter((c): c is { step: (typeof implMethod.narrative)[number]; claim: RegExpExecArray } => c.claim !== null);
        const intentClaim = implMethod.intent ? CLAIM_PHRASES.exec(implMethod.intent) : null;
        if (!stepClaims.length && !intentClaim) continue;

        const hasDataEdge = implMethod.narrative.some(step => {
          if (step.type !== 'call' && step.type !== 'dispatch') return false;
          if (!step.targetComponent) return false;
          const target = ctx.componentMap.get(step.targetComponent);
          if (target && DATA_STEREOTYPES.has(target.componentType)) return true;
          // A dispatch resolves to its bound server.
          const binding = target?.dispatch?.find(b => b.capability === step.capability);
          const server = binding ? ctx.componentMap.get(binding.component) : undefined;
          return server ? DATA_STEREOTYPES.has(server.componentType) : false;
        });

        // Steps: a LOCAL step claiming persistence in a narrative with no
        // data-layer edge realizes nothing. (call/dispatch steps carry their
        // own edge and are exempt.)
        for (const { step, claim } of stepClaims) {
          if (!hasDataEdge) {
            ctx.addIssue(
              'warning',
              'UNREALIZED_CLAIM',
              `Step ${step.stepNumber} of "${implMethod.name}" in implementation "${impl.id}" claims "${claim[0]}" but no call/dispatch edge in this narrative reaches a Store/Registry/Index/Adapter — realize the claim as a structural edge (and durability tags), or reword the prose.`,
              impl.id,
              isDraftCtx,
            );
          }
        }

        // Intent prose: no steps to inspect, so fall back to the component's
        // declared collaborators — a persistence claim with no data-layer
        // dependency anywhere cannot be realized.
        if (intentClaim && !hasDataEdge) {
          const dependsOnDataLayer = [...comp.dependsOn, ...comp.owns].some(depId => {
            const dep = ctx.componentMap.get(depId);
            return dep ? DATA_STEREOTYPES.has(dep.componentType) : false;
          });
          if (!dependsOnDataLayer) {
            ctx.addIssue(
              'warning',
              'UNREALIZED_CLAIM',
              `The intent of "${implMethod.name}" in implementation "${impl.id}" claims "${intentClaim[0]}" but component "${comp.id}" neither depends on nor owns any Store/Registry/Index/Adapter — the claim has no structural realization.`,
              impl.id,
              isDraftCtx,
            );
          }
        }
      }
    }
  },
};
