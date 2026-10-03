import type { MethodParam, MethodSignature } from '../../../models/index.js';
import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// signature-source-suggestions — where adopting a signatureFrom can never be
// wrong. A Repository facade forwards 1:1 to an owned member by doctrine
// (facade-forwarding), so a facade method whose params and returns equal the
// member method it forwards to IS that method's signature, restated. Only
// there is the reference suggested: a Portal restating an Orchestrator, or a
// client Adapter restating a remote Portal, is often a public surface that
// should stay decoupled from an internal signature. One notice per facade
// contract; the restating methods are the units it covers.
// ---------------------------------------------------------------------------

/** Whether two param lists are one contract: name, type, optional marker and order. */
function sameParams(a: ReadonlyArray<MethodParam>, b: ReadonlyArray<MethodParam> | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  return a.every((p, i) => p.name === b[i].name && p.type === b[i].type && !!p.optional === !!b[i].optional);
}

/** The local spelling of a keyed id, as an author writes it inside its own project. */
function localName(id: string): string {
  return id.split('::').pop()!;
}

export const signatureSourceSuggestionsRule: SddRule = {
  name: 'signature-source-suggestions',
  judges: 'design',
  description:
    'A Repository facade method is pure 1:1 forwarding to an owned member by doctrine (facade-forwarding), so its signature IS the member\'s: where its params (name, type, optional marker, order) and returns equal the owned member method it forwards to, it could name that method as its signatureFrom, and the reference can never be wrong. Suggested only where the adoption would be legal: the member method names no source of its own (no chain). Nothing else is suggested: another forwarder — a Portal restating an Orchestrator, a client Adapter restating a remote Portal — is often a public surface that should stay deliberately decoupled from an internal signature, so wairon does not suggest coupling them. Adoption is opt-in, so this is a notice, and ONE per facade contract, the restating methods being the units it covers.',
  codes: [
    { code: 'SIGNATURE_SOURCE_AVAILABLE', defaultSeverity: 'notice', summary: 'A Repository facade\'s methods restate exactly the owned member methods they forward to and could name them as their signatureFrom' },
  ],
  check(ctx) {
    // Step 1: every implementation of an in-scope Repository contract.
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract || !ctx.isSpecInScope(contract.id)) continue;
      const repository = ctx.componentMap.get(contract.component);
      if (!repository || repository.componentType !== 'Repository') continue;
      const owned = new Set(repository.owns);
      const restating: string[] = [];
      for (const realized of impl.methods) {
        // Step 2: a facade hand-off — exactly one call step, or no steps and exactly one declared call, to an owned member.
        const steps = realized.narrative ?? [];
        let member: string | undefined;
        let memberMethod: string | undefined;
        if (steps.length === 1 && steps[0].type === 'call') {
          member = steps[0].targetComponent;
          memberMethod = steps[0].targetMethod;
        } else if (steps.length === 0 && realized.calls?.length === 1) {
          const entry = realized.calls[0];
          const dot = entry.lastIndexOf('.');
          if (dot > 0) {
            member = entry.slice(0, dot);
            memberMethod = entry.slice(dot + 1);
          }
        }
        if (!member || !memberMethod) continue;
        const memberKey = [...owned].find((o) => o === member || localName(o) === localName(member!));
        if (!memberKey) continue;
        // Step 3: the facade method states params and no source; the member method names no source of its own; both shapes are equal.
        const own = contract.methods.find((m) => m.name === realized.name);
        if (!own || own.signatureFrom !== undefined || !own.params) continue;
        const target: MethodSignature | undefined = (ctx.interfacesByComponent.get(memberKey) ?? [])
          .flatMap((i) => i.methods)
          .find((m) => m.name === memberMethod);
        if (!target || target.signatureFrom !== undefined) continue;
        if (!sameParams(own.params, target.params) || own.returns !== target.returns) continue;
        restating.push(`${own.name} ← ${localName(memberKey)}.${memberMethod}`);
      }
      // Steps 4-5: one notice on the contract, covering the restating methods.
      if (restating.length === 0) continue;
      ctx.addIssue(
        'notice',
        'SIGNATURE_SOURCE_AVAILABLE',
        `${restating.length === 1 ? 'A method' : `${restating.length} methods`} of Repository facade "${contract.id}" restate${restating.length === 1 ? 's' : ''} exactly the owned member method${restating.length === 1 ? '' : 's'} ${restating.length === 1 ? 'it forwards' : 'they forward'} to: ${restating.map((u) => `"${u}"`).join('; ')}. `
          + `${restating.length === 1 ? 'It' : 'Each'} could name that member method as its signatureFrom (and drop its params and returns), so the signature is stated once. Optional — a facade's signature is its member's by doctrine.`,
        contract.id,
        ctx.isImplementationDraft(impl),
        undefined,
        { at: contract.id, covers: restating },
      );
    }
  },
};
