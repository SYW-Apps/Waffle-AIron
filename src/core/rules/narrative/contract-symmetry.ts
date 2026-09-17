import { SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Contract ↔ implementation symmetry: an L4 implementation realizes its L3
// contract method-for-method — it adds no method the contract does not define,
// and leaves none of the contract's methods unrealized. Nothing here reads a
// narrative: what a narrative step TARGETS is narrative-target-references'
// subject, and a target outside this tree is cross-tree-references'.
// ---------------------------------------------------------------------------

export const contractSymmetryRule: SddRule = {
  name: 'contract-symmetry',
  description:
    'Implementations mirror their contract method-for-method: every method an implementation declares is defined on the contract it realizes, and every contract method has an implementation.',
  codes: [
    { code: 'UNEXPECTED_IMPLEMENTATION_METHOD', defaultSeverity: 'error', summary: 'Implementation method not present on the contract' },
    { code: 'MISSING_IMPLEMENTATION_METHOD', defaultSeverity: 'error', summary: 'Contract method missing from the implementation' },
  ],
  check(ctx) {
    for (const impl of ctx.implementations) {
      const contract = ctx.interfaceMap.get(impl.contract);
      if (!contract) continue;

      const isDraftCtx = ctx.isImplementationDraft(impl);

      const contractMethodNames = new Set(contract.methods.map(m => m.name));
      const implMethodNames = new Set(impl.methods.map(m => m.name));

      // Check implementation has extra methods not defined in interface
      for (const implMethod of impl.methods) {
        if (!contractMethodNames.has(implMethod.name)) {
          ctx.addIssue(
            'error',
            'UNEXPECTED_IMPLEMENTATION_METHOD',
            `Implementation "${impl.id}" implements method "${implMethod.name}" which is not defined on contract "${contract.id}".`,
            impl.id,
            isDraftCtx,
          );
        }
      }

      // Check implementation is missing methods defined in interface
      for (const contractMethod of contract.methods) {
        if (!implMethodNames.has(contractMethod.name)) {
          ctx.addIssue(
            'error',
            'MISSING_IMPLEMENTATION_METHOD',
            `Implementation "${impl.id}" is missing implementation for contract method "${contractMethod.name}" from interface "${contract.id}".`,
            impl.id,
            isDraftCtx,
          );
        }
      }
    }
  },
};
