import { RuleContext, SddRule } from '../types.js';
import { typeMatchesRef } from '../../../models/index.js';
import { renamedExportMethod } from './implements-contracts.js';

// ---------------------------------------------------------------------------
// signature-sources — every `signatureFrom` the loader met, judged from the
// facts it recorded. The loaded specs are already resolved, so a sourced
// method carries its source's params by the time a rule sees it: whether the
// source bound, whether it was ambiguous or chained, and whether the stored
// method restated it are visible only in ctx.signatureFacts. Nothing here
// re-reads a stored method or infers a restatement from loaded params.
// ---------------------------------------------------------------------------

/** Whether the interface a fact sits on is judged in a draft context. */
function draftContext(ctx: RuleContext, interfaceId: string, component: string): boolean {
  const intf = ctx.interfaceMap.get(interfaceId);
  return ctx.isComponentDraft(component) || intf?.status === 'draft' || intf?.status === 'design';
}

/** The project namespace a component key lives in: '' for the bound project's own. */
function projectOf(componentKey: string): string {
  const at = componentKey.lastIndexOf('::');
  return at < 0 ? '' : componentKey.slice(0, at);
}

/** The component key of a method source's target (`<component key>.<method>`). */
function targetComponent(target: string): string {
  return target.slice(0, target.lastIndexOf('.'));
}

export const signatureSourcesRule: SddRule = {
  name: 'signature-sources',
  judges: 'design',
  description:
    'Judges every signatureFrom the loader met, from ctx.signatureFacts (the loaded specs are already resolved). The value is read both ways, as a contract method and as a signature type: neither resolving — or only a type that is an entity or value-object — is unresolved; both resolving is ambiguous, and the finding names both candidates and asks the author to qualify the reference; a source that itself names a signatureFrom is a chain, which is never followed (when that source\'s own source is a signature type, the finding names it as the one to take directly); a method source in the method\'s own project whose component the method\'s component does not name in dependsOn or owns is off the design\'s edges — another project\'s export (`alias::name.method`) is licensed by the declared relation to that project, an external or a member alike; a stored method that names a source and also states params or returns that differ from the source\'s restates it, and the source\'s are in force. Every finding sits at the method.',
  codes: [
    { code: 'SIGNATURE_SOURCE_UNRESOLVED', defaultSeverity: 'error', summary: 'A method\'s signatureFrom names no contract method and no signature type' },
    { code: 'SIGNATURE_SOURCE_AMBIGUOUS', defaultSeverity: 'error', summary: 'A method\'s signatureFrom resolves both as a contract method and as a signature type; qualify it' },
    { code: 'SIGNATURE_SOURCE_CHAINED', defaultSeverity: 'error', summary: 'A method\'s signature source takes its own signature from a source; sources do not chain' },
    { code: 'SIGNATURE_SOURCE_OFF_EDGE', defaultSeverity: 'error', summary: 'A method takes its signature from a method of a component its own component neither dependsOn nor owns' },
    { code: 'SIGNATURE_SOURCE_RESTATED', defaultSeverity: 'error', summary: 'A method names a signature source and also states params or returns that differ from the source\'s' },
  ],
  check(ctx) {
    // Step 1: every source fact the loader recorded, in scope.
    for (const fact of ctx.signatureFacts?.sources ?? []) {
      if (!ctx.isSpecInScope(fact.interfaceId)) continue;
      const isDraft = draftContext(ctx, fact.interfaceId, fact.component);
      const where = `Method "${fact.method}" on interface "${fact.interfaceId}"`;
      const at = { at: fact.method };
      // Step 2: dispatch on what resolving the source found.
      switch (fact.outcome) {
        case 'unresolved': {
          // Step 3: an exported contract's method the producer renamed is named by its new name.
          const renamed = renamedExportMethod(ctx, fact.source);
          const rename = renamed ? ` It was renamed to "${renamed}" (the producer's rename trace) — follow the rename: take it from "${fact.source.slice(0, fact.source.lastIndexOf('.'))}.${renamed}".` : '';
          ctx.addIssue(
            'error',
            'SIGNATURE_SOURCE_UNRESOLVED',
            `${where} takes its signature from "${fact.source}", which names ${fact.detail
              ? `no contract method, and ${fact.detail}`
              : 'no contract method and no signature type'}.${rename} A source is a \`component.method\` the component reaches, an exported contract's method (\`alias::name.method\`), or a type of kind signature.`,
            fact.interfaceId, isDraft, undefined, at,
          );
          continue;
        }
        case 'ambiguous':
          // Step 5.
          ctx.addIssue(
            'error',
            'SIGNATURE_SOURCE_AMBIGUOUS',
            `${where} takes its signature from "${fact.source}", which names both the contract method "${fact.candidates?.[0] ?? '?'}" and the signature type "${fact.candidates?.[1] ?? '?'}". Qualify the reference so only one reading matches.`,
            fact.interfaceId, isDraft, undefined, at,
          );
          continue;
        case 'chained': {
          // Step 7: the source's own source, and when that is a signature type, the one to take directly.
          const own = fact.detail ?? '';
          const direct = ctx.types.some((t) => t.kind === 'signature' && (t.id === own || typeMatchesRef(t, own)));
          ctx.addIssue(
            'error',
            'SIGNATURE_SOURCE_CHAINED',
            `${where} takes its signature from "${fact.target ?? fact.source}", which takes its own from "${own}"; sources do not chain.${direct
              ? ` "${own}" is a signature type: name it directly as this method's signatureFrom.`
              : ' State this method\'s params, or name a source that declares its own.'}`,
            fact.interfaceId, isDraft, undefined, at,
          );
          continue;
        }
        case 'restated':
          // Steps 9-11: only a differing restatement is a finding; the edge is
          // judged on the resolved fact the loader records right after it.
          if (fact.differs) {
            ctx.addIssue(
              'error',
              'SIGNATURE_SOURCE_RESTATED',
              `${where} takes its signature from "${fact.source}" and also states its own: ${fact.detail ?? 'they differ from the source\'s'}. The source's are in force — drop the stated params and returns, or drop the signatureFrom.`,
              fact.interfaceId, isDraft, undefined, at,
            );
          }
          continue;
        default:
          break;
      }
      // Step 12: a method source off the design's edges.
      if (fact.form !== 'method' || !fact.target) continue;
      const source = targetComponent(fact.target);
      // Another project's export (`alias::name.method`) is licensed by the
      // declared relation to that project — an external's or a member's alike,
      // one reference, one verdict — never by a dependsOn edge. (An extension
      // point a consumer implements is the clearest case: the producer calls
      // the implementer, so an edge to its component would point the wrong way.)
      if (fact.source.includes('::') && projectOf(source) !== projectOf(fact.component)) continue;
      const owner = ctx.componentMap.get(fact.component);
      const reached = new Set([...(owner?.dependsOn ?? []), ...(owner?.owns ?? [])]);
      if (reached.has(source)) continue;
      // Step 13.
      ctx.addIssue(
        'error',
        'SIGNATURE_SOURCE_OFF_EDGE',
        `${where} takes its signature from "${fact.target}", but "${fact.component}" neither dependsOn nor owns "${source}". Add "${source}" to its dependsOn (or owns, for a member), or name a source it reaches.`,
        fact.interfaceId, isDraft, undefined, at,
      );
    }
  },
};
