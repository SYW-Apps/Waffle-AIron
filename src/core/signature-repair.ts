import {
  invalidateSpecCache,
  loadInterfaceSpecs,
  loadTypeSpecs,
  saveInterfaceSpec,
  saveSpec,
  signatureFacts,
} from './specs.js';
import type { StaleSignatureText } from './signature-sources.js';
import type { TypedSpecKind } from '../models/type-grammar.js';

// ---------------------------------------------------------------------------
// Signature repair (sdd_core, behind `wairon doctor`)
//
// Stage 1 of the generic design model derives every params-bearing method's
// signature text from its params; the loader re-derives it on every load, so a
// stale stored text is never SHOWN — but the file still says it, and a diff, a
// review and a lock approval read the file. This is the one-time mechanical
// rewrite into the stored form, and it is exactly what any later save of the
// same spec would write: the repair re-saves the LOADED spec, and the writer's
// stored form derives the text and drops a restatement the source supplies.
//
// What it does NOT do is guess. A sourced method restating DIFFERENT params or
// returns is left alone — and with it the interface holding it, since any
// save stores a sourced method with only its source: only its author knows
// which contract was meant, and SIGNATURE_SOURCE_RESTATED keeps reporting it.
// ---------------------------------------------------------------------------

/** One spec the signature repair rewrites into its stored form (signature_text_repair). */
export interface SignatureTextRepair {
  /** The interface or type the repair rewrites. */
  specId: string;
  kind: TypedSpecKind;
  /** Each method whose stored text is replaced by its derived text. */
  regenerated: StaleSignatureText[];
  /** Each sourced method whose restated params and returns — equal to the source's — are dropped. */
  dropped: string[];
}

/**
 * icore_orchestrator.repairSignatures — plan, and with apply write, the
 * regeneration of every stored signature text its params contradict and the
 * removal of every restatement equal to its method's signature source, in the
 * bound project's own specs. Idempotent: after an applied run the plan is
 * empty. Without apply nothing is written.
 */
export function repairSignatures(apply: boolean): SignatureTextRepair[] {
  // Step 1: what the scan's signature resolution recorded.
  const facts = signatureFacts();

  // Step 2: one repair per interface or type of the bound project itself.
  const repairs = new Map<string, SignatureTextRepair>();
  const repairOf = (specId: string, kind: 'interface' | 'type'): SignatureTextRepair => {
    const key = `${kind}:${specId}`;
    let repair = repairs.get(key);
    if (!repair) {
      repair = { specId, kind, regenerated: [], dropped: [] };
      repairs.set(key, repair);
    }
    return repair;
  };
  // An interface holding a DIFFERING restatement is left whole: the writer
  // stores every sourced method with only its source, so re-saving it would
  // decide that contract for its author.
  const held = new Set(facts.sources
    .filter((f) => f.outcome === 'restated' && f.differs)
    .map((f) => f.interfaceId));
  const own = (specId: string, kind: 'interface' | 'type'): boolean =>
    !specId.includes('::') && !(kind === 'interface' && held.has(specId));
  for (const stale of facts.staleTexts) {
    if (own(stale.specId, stale.kind)) repairOf(stale.specId, stale.kind).regenerated.push(stale);
  }
  for (const fact of facts.sources) {
    if (fact.outcome !== 'restated' || fact.differs || !own(fact.interfaceId, 'interface')) continue;
    repairOf(fact.interfaceId, 'interface').dropped.push(fact.method);
  }
  const planned = [...repairs.values()];

  // Step 3: was the write asked for?
  if (apply && planned.length > 0) {
    // Every spec is read before the first write: each save invalidates the index.
    const interfaces = new Map(loadInterfaceSpecs().map((i) => [i.id, i]));
    const types = new Map(loadTypeSpecs().map((t) => [t.id, t]));
    // Steps 4-9: re-save each loaded spec; the writer stores its stored form.
    for (const repair of planned) {
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

  // Step 10: the planned repairs, written or not.
  return planned;
}
