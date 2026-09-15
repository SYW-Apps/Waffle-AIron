import type { SurfaceContractEntry, SurfaceSnapshot } from './specs.js';

// ---------------------------------------------------------------------------
// Cross-tree references resolved against stored surface snapshots: the
// resolution verdict and the snapshot and contract-entry behaviour it is
// decided with.
// ---------------------------------------------------------------------------

/**
 * How a cross-tree reference fared against the stored surface snapshots
 * (surface_ref_resolution).
 *
 * `ambiguous` is a verdict of its own, not a kind of resolution: several
 * snapshots expose the name with different contracts and the reference does not
 * single one out, so no declared contract may judge the edge.
 */
export type SurfaceRefResolution =
  | { kind: 'resolved'; snapshot: SurfaceSnapshot; entry: SurfaceContractEntry }
  | { kind: 'ambiguous'; providers: string[] }
  | { kind: 'unresolved' };

/**
 * surface_snapshot.isProvidedBy — whether the named provider published this
 * snapshot. A snapshot's key is its projectName: the family surface is keyed by
 * the parent system name and a sibling's by `<systemName>::<subsystemId>`, so a
 * reference names a sibling by its subsystem id and the family surface or a
 * foreign import by its name.
 */
export function isProvidedBy(snapshot: Pick<SurfaceSnapshot, 'projectName'>, provider: string): boolean {
  return snapshot.projectName === provider || snapshot.projectName.split('::').pop() === provider;
}

/**
 * surface_contract_entry.sameContract — two entries carry the same contract
 * when they front the same component with the same methods and the same
 * dispatch table, so whichever of them judges an edge, the verdict is the same.
 * Snapshots carry a component's local name, so that is what identifies it.
 */
export function sameContract(a: SurfaceContractEntry, b: SurfaceContractEntry): boolean {
  return a.component.split('::').pop() === b.component.split('::').pop()
    && JSON.stringify(a.methods) === JSON.stringify(b.methods)
    && JSON.stringify(a.dispatch ?? []) === JSON.stringify(b.dispatch ?? []);
}

/**
 * surface_ref_resolution.ambiguityMessage — the message for an ambiguous
 * resolution: the subject clause leading up to the reference (e.g.
 * `Component "invoice-client" depends on`), the providers whose contracts
 * disagree, and the remedy. Every rule that resolves references reports it under
 * SURFACE_REF_AMBIGUOUS itself, so the finding reads the same on every kind of
 * edge.
 */
export function ambiguityMessage(resolution: SurfaceRefResolution, subject: string, ref: string): string {
  const providers = resolution.kind === 'ambiguous' ? resolution.providers : [];
  const local = ref.split('::').filter(seg => seg && seg !== 'super').pop() ?? ref;
  return `${subject} cross-tree component "${ref}", which the surface snapshots of ${providers.map((p) => `"${p}"`).join(', ')} expose with different contracts — the reference matches more than one declared contract, so none of them can judge it. Name the provider it means (super::<provider>::${local}), or remove the snapshot that no longer applies.`;
}
