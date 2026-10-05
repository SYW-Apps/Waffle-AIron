import {
  invalidateSpecCache,
  loadInterfaceSpecs,
  loadTypeSpecs,
  saveInterfaceSpec,
  saveSpec,
  signatureFacts,
  typeSpellingFacts,
} from './specs.js';
import { typeProblemEnumProposal, typeProblemIntProposal, type TypeSpellingRepair } from '../models/index.js';

// ---------------------------------------------------------------------------
// Type-spelling repair (sdd_core, behind `wairon doctor`)
//
// Stage 2 of the generic design model gives every structured type position
// one neutral grammar, and the loader reads every position canonical in
// memory — so a stored alias (`string[]`, `boolean`, `T | null`) is never
// SHOWN, but the file still says it, and a diff, a review and a lock approval
// read the file. This is the one-time mechanical rewrite into the canonical
// spelling, and it is exactly what any later save of the same spec would
// write: the repair re-saves the LOADED spec, and the writer stores every
// position canonical (a position that cannot be made canonical is written as
// it stands).
//
// What it does NOT do is guess. A `number` position whose name plainly says a
// whole number gets int PROPOSED (type_expression_problem.intProposal), and a
// union of string literals an enum (type_expression_problem.enumProposal); each
// is left as written for an author to confirm, and every other position no
// rewrite can settle is listed as needing an author. And an interface holding a
// sourced method whose restatement differs from its source is never re-saved:
// the writer stores a sourced method with only its source, so re-saving it
// would decide that contract for its author (SIGNATURE_SOURCE_RESTATED keeps
// reporting it, and its aliases wait with it).
// ---------------------------------------------------------------------------

/**
 * icore_orchestrator.repairTypeSpellings — plan, and with apply write, the
 * rewrite of every stored type position that is an alias into its canonical
 * spelling, in the bound project's own specs, with int proposed (never
 * written) for the `number` positions whose name says an integer and the
 * positions only an author can settle listed beside it. Idempotent: after an
 * applied run no repair rewrites anything. Without apply nothing is written.
 */
export function repairTypeSpellings(apply: boolean): TypeSpellingRepair[] {
  // Step 1: what the scan's type canonicalisation recorded.
  const facts = typeSpellingFacts();

  // Step 2: the interfaces holding a differing restatement, which no re-save may touch.
  const held = new Set(signatureFacts().sources
    .filter((f) => f.outcome === 'restated' && f.differs)
    .map((f) => f.interfaceId));

  // Step 3: one repair per interface or type of the bound project itself.
  const repairs = new Map<string, TypeSpellingRepair>();
  const repairOf = (specId: string, kind: 'interface' | 'type'): TypeSpellingRepair => {
    const key = `${kind}:${specId}`;
    let repair = repairs.get(key);
    if (!repair) {
      repair = { specId, kind, rewritten: [], proposals: [], enumProposals: [], authorNeeded: [] };
      repairs.set(key, repair);
    }
    return repair;
  };
  // A contained member's specs are keyed under its namespace: its own doctor's.
  const own = (specId: string): boolean => !specId.includes('::');
  for (const respelling of facts.respellings) {
    if (!own(respelling.specId)) continue;
    if (respelling.kind === 'interface' && held.has(respelling.specId)) continue;
    repairOf(respelling.specId, respelling.kind).rewritten.push(respelling);
  }
  for (const problem of facts.problems) {
    if (problem.specId === undefined || problem.kind === undefined || !own(problem.specId)) continue;
    const repair = repairOf(problem.specId, problem.kind);
    const proposal = typeProblemIntProposal(problem);
    const enumProposal = proposal ? null : typeProblemEnumProposal(problem);
    if (proposal) repair.proposals.push(proposal);
    else if (enumProposal) repair.enumProposals.push(enumProposal);
    else repair.authorNeeded.push(problem);
  }
  const planned = [...repairs.values()];
  const rewriting = planned.filter((repair) => repair.rewritten.length > 0);

  // Step 4: was the write asked for?
  if (apply && rewriting.length > 0) {
    // Every spec is read before the first write: each save invalidates the index.
    const interfaces = new Map(loadInterfaceSpecs().map((i) => [i.id, i]));
    const types = new Map(loadTypeSpecs().map((t) => [t.id, t]));
    // Steps 5-10: re-save each loaded spec; the writer stores every position canonical.
    for (const repair of rewriting) {
      if (repair.kind === 'interface') {
        const intf = interfaces.get(repair.specId);
        if (intf) saveInterfaceSpec(intf);
        continue;
      }
      const type = types.get(repair.specId);
      if (type) saveSpec('type', type);
    }
    invalidateSpecCache();
  }

  // Step 11: the planned repairs, written or not, with their int and enum proposals and the positions needing an author.
  return planned;
}
