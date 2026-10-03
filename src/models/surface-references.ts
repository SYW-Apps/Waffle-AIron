import { createHash } from 'crypto';
import type { MethodSignature, SurfaceContractEntry, SurfaceSnapshot, SurfaceTypeDef } from './specs.js';
import { extractTypeIdentifiers, matchTypeRef, methodTypeRefs, nameKey } from './type-references.js';
import { canonicalTypeText, isTypeVocabulary, parseTypeExpression, type TypeExpression } from './type-grammar.js';
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

/** An identifier inside a type expression: a name, optionally qualified by `::` or `.` segments. */
const TYPE_IDENTIFIER = /(?:::)?[A-Za-z0-9_][A-Za-z0-9_-]*(?:(?:::|\.)[A-Za-z0-9_][A-Za-z0-9_-]*)*/g;

/** The closure type one identifier names, compared by nameKey; the one exact key match when several suffix-match. */
function closureTypeOf(snapshot: SurfaceSnapshot, identifier: string): SurfaceTypeDef | undefined {
  const segments = identifier.replace(/^::/, '').split(/::|\./).filter(Boolean);
  const own = new Set([snapshot.projectId, snapshot.projectName].filter((s): s is string => !!s).map(nameKey));
  // A prefix naming this snapshot's own project is its own spelling of a local name.
  const local = segments.length > 1 && own.has(nameKey(segments[0])) ? segments.slice(1) : segments;
  const ref = local.join('::');
  const matches = snapshot.types.filter((def) => matchTypeRef(ref, def.id));
  if (matches.length === 1) return matches[0];
  return matches.find((def) => nameKey(def.id) === nameKey(ref));
}

/** The expression with every named reference rewritten through `rename`, the structure kept. */
function renamedRefs(expr: TypeExpression, rename: (name: string) => string): TypeExpression {
  const args = expr.args.map((a) => renamedRefs(a, rename));
  return expr.form === 'named' || expr.form === 'applied' ? { ...expr, name: rename(expr.name!), args } : { ...expr, args };
}

/**
 * surface_snapshot.canonicalTypeRef — a type expression rewritten into the one
 * spelling a digest may see: parsed under the type grammar and answered as its
 * canonical text, so an alias and its canonical spelling digest alike, with
 * every named reference rewritten in place — an identifier naming a type of
 * this snapshot's closure (bare, or prefixed with this snapshot's own project
 * id, compared by nameKey) becomes that type's id; anything else — another
 * project's name, which a snapshot cannot resolve on its own — is kept as
 * written. A text that does not parse (a prose signature) is kept as written,
 * identifier by identifier, as before the grammar: wairon's own vocabulary
 * lower-cased, closure types by id. Pure: the snapshot is the whole input.
 */
export function canonicalTypeRef(snapshot: SurfaceSnapshot, typeExpr: string): string {
  const rename = (identifier: string): string => closureTypeOf(snapshot, identifier)?.id ?? identifier;
  const parse = parseTypeExpression(typeExpr, 'returns');
  if (parse.expression) return canonicalTypeText(renamedRefs(parse.expression, rename));
  return typeExpr.replace(TYPE_IDENTIFIER, (identifier) => {
    if (!/[A-Za-z]/.test(identifier)) return identifier;
    if (isTypeVocabulary(identifier)) return identifier.toLowerCase();
    return rename(identifier);
  });
}

/**
 * A type definition's shape: what a caller depends on, never its prose; every
 * field type canonical. An enum's shape is its kind and its value names in
 * declared order, so adding, removing or reordering a value moves it.
 */
function typeShape(snapshot: SurfaceSnapshot, def: SurfaceTypeDef): unknown {
  return {
    id: def.id,
    kind: def.kind,
    fields: sortedBy(def.fields, (f) => f.name)
      .map((f) => ({ name: f.name, type: canonicalTypeRef(snapshot, f.type), optional: f.optional === true })),
    // A signature's shape: its params' types and optionality in order (never their names, as a method's), and its returns.
    ...(def.kind === 'signature'
      ? {
        params: (def.params ?? []).map((p) => ({ type: canonicalTypeRef(snapshot, p.type), optional: p.optional === true })),
        returns: canonicalTypeRef(snapshot, def.returns ?? 'unknown'),
      }
      : {}),
    ...(def.kind === 'enum' ? { values: (def.values ?? []).map((v) => v.name) } : {}),
  };
}

/** Every type expression a closure type names: its fields', and a signature's params' and returns. */
function typeDefExprs(def: SurfaceTypeDef): string[] {
  return [
    ...def.fields.map((f) => f.type),
    ...(def.params ?? []).map((p) => p.type),
    ...(def.returns !== undefined ? [def.returns] : []),
  ];
}

/**
 * The shapes of every closure type the given type expressions name,
 * transitively, sorted by id — found by CANONICAL id, never by the suffix
 * match, so a reference re-spelled inside the producer finds the same type.
 */
function closureShapes(snapshot: SurfaceSnapshot, exprs: string[]): unknown[] {
  const byId = new Map(snapshot.types.map((def) => [def.id, def] as const));
  const seen = new Map<string, SurfaceTypeDef>();
  const queue = exprs.flatMap((expr) => extractTypeIdentifiers(canonicalTypeRef(snapshot, expr)));
  while (queue.length) {
    const def = byId.get(queue.shift()!);
    if (!def || seen.has(def.id)) continue;
    seen.set(def.id, def);
    for (const expr of typeDefExprs(def)) queue.push(...extractTypeIdentifiers(canonicalTypeRef(snapshot, expr)));
  }
  return [...seen.keys()].sort().map((id) => typeShape(snapshot, seen.get(id)!));
}

/** A method's signature as a caller depends on it: parameter types and optionality in order, never their names; every type canonical. */
function methodShape(snapshot: SurfaceSnapshot, method: MethodSignature): unknown {
  return {
    name: method.name,
    params: method.params && method.params.length > 0
      ? method.params.map((p) => ({ type: canonicalTypeRef(snapshot, p.type), optional: p.optional === true }))
      : canonicalTypeRef(snapshot, method.signature),
    returns: canonicalTypeRef(snapshot, method.returns),
  };
}

/** A copy sorted by a key. */
function sortedBy<T>(list: readonly T[], key: (t: T) => string): T[] {
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/**
 * surface_snapshot.contentDigest — sha256 over the snapshot's canonical
 * CONTRACT, never over how its references are spelled: the public names with
 * each entry's stereotype, transport, auth kind, dispatch bindings and method
 * shapes, the exported types and the closure's type shapes — every type
 * expression passed through canonicalTypeRef, every list in a fixed order —
 * with provenance (stateId, generatedAt, origin) and prose (descriptions,
 * groups, display names) left out. Re-pinning an unchanged contract never
 * moves it. The lock's `digest`, and what EXTERNAL_DRIFTED compares.
 */
export function contentDigest(snapshot: SurfaceSnapshot): string {
  const contract = {
    interfaces: sortedBy(snapshot.interfaces, (e) => e.id).map((e) => ({
      id: e.id,
      componentType: e.componentType ?? null,
      type: e.type,
      auth: e.auth?.scheme ?? null,
      dispatch: sortedBy(e.dispatch ?? [], (b) => `${b.capability} ${b.method}`).map((b) => ({ capability: b.capability, method: b.method })),
      methods: sortedBy(e.methods, (m) => m.name).map((m) => methodShape(snapshot, m)),
    })),
    exportedTypes: sortedBy(snapshot.exportedTypes ?? [], (t) => t.id).map((t) => ({ id: t.id, type: t.type })),
    types: sortedBy(snapshot.types, (t) => t.id).map((t) => typeShape(snapshot, t)),
  };
  return sha256(canonicalize(contract));
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
    return sha256(canonicalize({ type: typeShape(snapshot, def), closure: closureShapes(snapshot, [def.id]) }));
  }
  const entry = snapshot.interfaces.find((e) => e.id === publicName);
  if (!entry) return null;
  if (member.startsWith('capability:')) {
    const binding = entry.dispatch?.find((b) => b.capability === member.slice('capability:'.length));
    if (!binding) return null;
    const bound = entry.methods.find((m) => m.name === binding.method);
    return sha256(canonicalize({
      binding: { capability: binding.capability, method: binding.method },
      method: bound ? methodShape(snapshot, bound) : null,
      closure: bound ? closureShapes(snapshot, methodTypeRefs(bound)) : [],
    }));
  }
  const method = entry.methods.find((m) => m.name === member);
  if (!method) return null;
  return sha256(canonicalize({ method: methodShape(snapshot, method), closure: closureShapes(snapshot, methodTypeRefs(method)) }));
}
