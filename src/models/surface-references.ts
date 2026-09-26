import { createHash } from 'crypto';
import type { MethodSignature, SurfaceContractEntry, SurfaceSnapshot, SurfaceTypeDef } from './specs.js';
import { extractTypeIdentifiers, matchTypeRef, methodTypeRefs } from './type-references.js';
import { canonicalize } from '../utils/canonical-json.js';

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

// ---------------------------------------------------------------------------
// Pinned-external digests: what a lock records, and what a status compares.
// ---------------------------------------------------------------------------

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

/**
 * surface_snapshot.contentDigest — sha256 over the snapshot's canonical content
 * with its provenance (stateId, generatedAt, origin) stripped, so re-pinning an
 * unchanged contract never moves it. The lock's `digest`.
 */
export function contentDigest(snapshot: SurfaceSnapshot): string {
  const { stateId, generatedAt, origin, ...content } = snapshot;
  return sha256(canonicalize(content));
}

/** A type definition's shape: what a caller depends on, never its prose. */
function typeShape(def: SurfaceTypeDef): unknown {
  return { id: def.id, kind: def.kind, fields: def.fields.map((f) => ({ name: f.name, type: f.type, optional: f.optional === true })) };
}

/** The shapes of every closure type the given references name, transitively, sorted by id. */
function closureShapes(snapshot: SurfaceSnapshot, refs: string[]): unknown[] {
  const seen = new Map<string, SurfaceTypeDef>();
  const queue = [...refs];
  while (queue.length) {
    const ref = queue.shift()!;
    for (const def of snapshot.types) {
      if (seen.has(def.id) || !matchTypeRef(ref, def.id)) continue;
      seen.set(def.id, def);
      for (const field of def.fields) queue.push(...extractTypeIdentifiers(field.type));
    }
  }
  return [...seen.keys()].sort().map((id) => typeShape(seen.get(id)!));
}

/** A method's signature as a caller depends on it: parameter types and optionality in order, never their names. */
function methodShape(method: MethodSignature): unknown {
  return {
    name: method.name,
    params: method.params && method.params.length > 0
      ? method.params.map((p) => ({ type: p.type, optional: p.optional === true }))
      : method.signature,
    returns: method.returns,
  };
}

/**
 * surface_snapshot.memberDigest — sha256 over one used member of one public
 * name, canonicalized so only what a caller depends on moves it: a contract
 * method's signature, a capability's binding and bound method, or an exported
 * type's shape, each followed by the shapes of every type in its transitive
 * closure. Null when the name or the member is not in the snapshot — a
 * removed member, never a pass.
 */
export function memberDigest(snapshot: SurfaceSnapshot, publicName: string, member: string): string | null {
  if (member === 'type') {
    const exported = snapshot.exportedTypes?.find((t) => t.id === publicName);
    if (!exported) return null;
    const def = snapshot.types.find((t) => t.id === exported.type);
    if (!def) return null;
    return sha256(canonicalize({ type: typeShape(def), closure: closureShapes(snapshot, [def.id]) }));
  }
  const entry = snapshot.interfaces.find((e) => e.id === publicName);
  if (!entry) return null;
  if (member.startsWith('capability:')) {
    const binding = entry.dispatch?.find((b) => b.capability === member.slice('capability:'.length));
    if (!binding) return null;
    const bound = entry.methods.find((m) => m.name === binding.method);
    return sha256(canonicalize({
      binding: { capability: binding.capability, method: binding.method },
      method: bound ? methodShape(bound) : null,
      closure: bound ? closureShapes(snapshot, methodTypeRefs(bound)) : [],
    }));
  }
  const method = entry.methods.find((m) => m.name === member);
  if (!method) return null;
  return sha256(canonicalize({ method: methodShape(method), closure: closureShapes(snapshot, methodTypeRefs(method)) }));
}
