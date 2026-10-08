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
 * declared order, so adding, removing or reordering a value moves it. A
 * named scalar's shape is its kind and the primitive it holds.
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
    ...(def.holds !== undefined ? { holds: canonicalTypeRef(snapshot, def.holds) } : {}),
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

/** A value as a fact compares it: its canonical JSON, or '' when absent. */
function factValue(value: unknown): string {
  return value === undefined || value === null ? '' : canonicalize(value);
}

/**
 * surface_snapshot.carriedFactChanges — the carried facts a pinned snapshot
 * holds differently from the live one, each named where it sits: per public
 * entry its export kind, transport, abi, role, stereotype, basePath, auth
 * scheme and rename trace, per contract method its effect and rename trace,
 * per type its rename trace, the producer's id and targetLanguage, and the
 * names it declares but no longer resolves. Facts no digest reads, which the
 * rules judge from a pin (LANGUAGE_BRIDGE_MISSING reads the abi), so a pin
 * whose content digest is unchanged can still be stale. Prose and provenance
 * are never a fact. Empty when the snapshot says what the producer says now.
 */
export function carriedFactChanges(pinned: SurfaceSnapshot, live: SurfaceSnapshot): string[] {
  const changes: string[] = [];
  const differs = (label: string, a: unknown, b: unknown): void => {
    if (factValue(a) !== factValue(b)) changes.push(label);
  };
  differs("the producer's id", pinned.projectId, live.projectId);
  differs('targetLanguage', pinned.targetLanguage, live.targetLanguage);
  const liveEntries = new Map(live.interfaces.map((e) => [e.id, e] as const));
  for (const entry of pinned.interfaces) {
    const now = liveEntries.get(entry.id);
    // A name gone from the live table is a used-name verdict (removed or renamed), never a carried fact.
    if (!now) continue;
    differs(`export kind of ${entry.id}`, entry.type, now.type);
    differs(`transport of ${entry.id}`, entry.transport, now.transport);
    differs(`abi of ${entry.id}`, entry.abi, now.abi);
    differs(`role of ${entry.id}`, entry.role, now.role);
    differs(`stereotype of ${entry.id}`, entry.componentType, now.componentType);
    differs(`basePath of ${entry.id}`, entry.basePath, now.basePath);
    differs(`auth of ${entry.id}`, entry.auth?.scheme, now.auth?.scheme);
    differs(`rename trace of ${entry.id}`, entry.formerly, now.formerly);
    const liveMethods = new Map(now.methods.map((m) => [m.name, m] as const));
    for (const method of entry.methods) {
      const nowMethod = liveMethods.get(method.name);
      if (!nowMethod) continue;
      differs(`effect of ${entry.id}.${method.name}`, method.effect, nowMethod.effect);
      differs(`rename trace of ${entry.id}.${method.name}`, method.formerly, nowMethod.formerly);
      // A parameter's name is no part of a signature digest, so a rename never
      // breaks a caller — but the pin still spells the old name: named with
      // the new one, as a renamed method is.
      for (const r of paramRenames(method, nowMethod)) {
        changes.push(`parameter "${r.from}" of ${entry.id}.${method.name} (renamed to "${r.to}")`);
      }
    }
  }
  const liveTypes = new Map(live.types.map((t) => [t.id, t] as const));
  for (const def of pinned.types) {
    const now = liveTypes.get(def.id);
    if (!now) continue;
    differs(`rename trace of ${def.id}`, def.formerly, now.formerly);
    for (const r of fieldRenames(def, now)) changes.push(`field "${r.from}" of ${def.id} (renamed to "${r.to}")`);
    // A type's own methods are carried for bindings, never digested: a change is a stale pin.
    const methods = (d: SurfaceTypeDef): unknown => (d.methods ?? []).map((m) => ({ name: m.name, params: (m.params ?? []).map((p) => ({ type: p.type, optional: p.optional === true })), returns: m.returns }));
    differs(`methods of ${def.id}`, def.methods?.length ? methods(def) : undefined, now.methods?.length ? methods(now) : undefined);
  }
  const unresolved = (snapshot: SurfaceSnapshot): unknown => [...(snapshot.unresolvedExports ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  differs('the unresolved re-exports', unresolved(pinned), unresolved(live));
  return changes;
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

/** What moved on one public name (or one of its members) between two snapshots of one producer's surface. */
export type SurfaceChangeKind = 'added' | 'removed' | 'renamed' | 'changed';

/**
 * surface_change — one entry of a public-surface changelog: a public name (and
 * the member, for a contract method) that was added, removed, renamed (from
 * the former name the rename trace records) or changed in signature, with a
 * one-line reading. What a producer writes release notes from.
 */
export interface SurfaceChange {
  kind: SurfaceChangeKind;
  /** The public name, as the newer surface spells it (the older one for a removal). */
  name: string;
  /** The contract method, for a change inside a contract; absent for the name as a whole. */
  member?: string;
  /** The former name a rename was traced from. */
  from?: string;
  /** What changed, said in one line. */
  detail: string;
}

/** A contract method's signature as a changelog shows it. */
function shownSignature(method: MethodSignature): string {
  return method.signature || `${method.name}(${(method.params ?? []).map((p) => `${p.name}${p.optional ? '?' : ''}: ${p.type}`).join(', ')}): ${method.returns}`;
}

/** The facts of a contract entry a consumer's pin carries beside its digests, as (label, before, after). */
function entryFacts(before: SurfaceContractEntry, after: SurfaceContractEntry): [string, unknown, unknown][] {
  return [
    ['export kind', before.type, after.type],
    ['transport', before.transport, after.transport],
    ['abi', before.abi, after.abi],
    ['role', before.role, after.role],
    ['stereotype', before.componentType, after.componentType],
    ['basePath', before.basePath, after.basePath],
    ['auth', before.auth?.scheme, after.auth?.scheme],
  ];
}

/** One name a rename trace carries forward: the former name and the current one. */
export interface TracedRename {
  from: string;
  to: string;
}

/**
 * surface_snapshot.fieldRenames — the fields of one type renamed between an
 * older and a newer definition of it, per the newer one's rename trace
 * (`formerly`): a field the older definition had that the newer lacks, which a
 * newer field's trace names. Pure.
 */
export function fieldRenames(was: SurfaceTypeDef, now: SurfaceTypeDef): TracedRename[] {
  return tracedRenames(was.fields, now.fields, (f) => f.formerly);
}

/**
 * The parameters of one contract method renamed between two snapshots of it,
 * per the newer method's parameter rename trace (`previousNames`). Pure.
 */
function paramRenames(was: MethodSignature, now: MethodSignature): TracedRename[] {
  return tracedRenames(was.params ?? [], now.params ?? [], (p) => p.previousNames);
}

/** The names `now` carries forward from `was` by its trace: each old name gone from `now` that a new name's trace holds. */
function tracedRenames<T extends { name: string }>(was: readonly T[], now: readonly T[], trace: (t: T) => readonly string[] | undefined): TracedRename[] {
  const before = new Set(was.map((x) => x.name));
  const after = new Set(now.map((x) => x.name));
  const out: TracedRename[] = [];
  for (const x of now) {
    if (before.has(x.name)) continue;
    const from = (trace(x) ?? []).find((n) => before.has(n) && !after.has(n));
    if (from !== undefined) out.push({ from, to: x.name });
  }
  return out;
}

/** A type definition with the given field renames undone: what a rename-only change reads back as. */
function withFieldsRenamedBack(def: SurfaceTypeDef, renames: readonly TracedRename[]): SurfaceTypeDef {
  const back = new Map(renames.map((r) => [r.to, r.from] as const));
  return { ...def, fields: def.fields.map((f) => (back.has(f.name) ? { ...f, name: back.get(f.name)! } : f)) };
}

/** field_rename_reading — the field renames inside a used member's closure, and whether they are its whole change. */
export interface FieldRenameReading {
  /** Each rename, read `field "<type>.<old>" renamed to "<new>"`. */
  renames: string[];
  /** Whether undoing the renames gives back the pinned member digest exactly. */
  renameOnly: boolean;
}

/**
 * surface_snapshot.fieldRenamesSince — every field rename inside the closure
 * of one used member between a pinned snapshot and the live one, as
 * `<type>.<old> → <new>` readings, and whether undoing them leaves the
 * member's digest exactly as pinned (a rename and nothing else). Empty
 * when no field of its closure was renamed. Pure.
 */
export function fieldRenamesSince(pinned: SurfaceSnapshot, live: SurfaceSnapshot, publicName: string, member: string, pinnedDigest: string): FieldRenameReading {
  const pinnedDefs = new Map(pinned.types.map((d) => [d.id, d] as const));
  const renames: string[] = [];
  const undone = new Map<string, SurfaceTypeDef>();
  for (const def of live.types) {
    const was = pinnedDefs.get(def.id);
    if (!was) continue;
    const moved = fieldRenames(was, def);
    if (moved.length === 0) continue;
    for (const r of moved) renames.push(`field "${def.id}.${r.from}" renamed to "${r.to}"`);
    undone.set(def.id, withFieldsRenamedBack(def, moved));
  }
  if (renames.length === 0) return { renames, renameOnly: false };
  const back: SurfaceSnapshot = { ...live, types: live.types.map((d) => undone.get(d.id) ?? d) };
  return { renames, renameOnly: memberDigest(back, publicName, member) === pinnedDigest };
}

/** A carried fact as a changelog shows it: its value, or none. */
function shownFact(value: unknown): string {
  return value === undefined || value === null || value === '' ? 'none' : typeof value === 'string' ? value : canonicalize(value);
}

/**
 * An effect as a changelog shows it: its value, or `undeclared` — never
 * `none`, which is a declared effect of its own (pure), so a newly declared
 * `effect: none` reads `undeclared → none`, not as a no-op.
 */
function shownEffect(value: unknown): string {
  return value === undefined || value === null || value === '' ? 'undeclared' : shownFact(value);
}

/** A type's own methods as a pin compares them: names, param types and optionality, returns. */
function typeMethods(def: SurfaceTypeDef): unknown {
  return def.methods?.length ? def.methods.map((m) => ({ name: m.name, params: (m.params ?? []).map((p) => ({ type: p.type, optional: p.optional === true })), returns: m.returns })) : undefined;
}

/** The type ids a method's signature reaches, its closure included. */
function closureIds(snapshot: SurfaceSnapshot, method: MethodSignature): string[] {
  const byId = new Map(snapshot.types.map((def) => [def.id, def] as const));
  const seen = new Set<string>();
  const queue = methodTypeRefs(method).flatMap((expr) => extractTypeIdentifiers(canonicalTypeRef(snapshot, expr)));
  while (queue.length) {
    const def = byId.get(queue.shift()!);
    if (!def || seen.has(def.id)) continue;
    seen.add(def.id);
    for (const expr of typeDefExprs(def)) queue.push(...extractTypeIdentifiers(canonicalTypeRef(snapshot, expr)));
  }
  return [...seen].sort();
}

/** The closure type ids a type definition reaches, itself included, sorted. */
function closureOfDef(snapshot: SurfaceSnapshot, def: SurfaceTypeDef): string[] {
  const byId = new Map(snapshot.types.map((d) => [d.id, d] as const));
  const seen = new Set<string>();
  const queue = [def.id];
  while (queue.length) {
    const next = byId.get(queue.shift()!);
    if (!next || seen.has(next.id)) continue;
    seen.add(next.id);
    for (const expr of typeDefExprs(next)) queue.push(...extractTypeIdentifiers(canonicalTypeRef(snapshot, expr)));
  }
  return [...seen].sort();
}

/**
 * Every traced rename of the newer closure against the older, per type id:
 * the type's own (`type "old" renamed to "new"`) and each of its fields'
 * (`field "type.old" renamed to "new"`).
 */
function closureRenames(newer: SurfaceSnapshot, older: SurfaceSnapshot): Map<string, string[]> {
  const olderDefs = new Map(older.types.map((d) => [d.id, d] as const));
  const newerIds = new Set(newer.types.map((d) => d.id));
  const notes = new Map<string, string[]>();
  for (const def of newer.types) {
    const traced = olderDefs.has(def.id) ? undefined : (def.formerly ?? []).find((f) => olderDefs.has(f) && !newerIds.has(f));
    const was = olderDefs.get(def.id) ?? (traced !== undefined ? olderDefs.get(traced) : undefined);
    if (!was) continue;
    const said = [
      ...(traced !== undefined ? [`renamed type "${traced}" → "${def.id}"`] : []),
      ...fieldRenames(was, def).map((r) => `renamed field "${def.id}.${r.from}" → "${r.to}"`),
    ];
    if (said.length > 0) notes.set(def.id, said);
  }
  return notes;
}

/** The renames a set of closure ids carries, in id order. */
function renamesIn(ids: string[], notes: Map<string, string[]>): string[] {
  return ids.flatMap((id) => notes.get(id) ?? []);
}

/**
 * How a method whose digest moved changed: its signature, when it reads
 * differently; else the types it names whose shape moved — null when every one
 * of them is an exported type whose own shape change the changelog lists.
 */
function signatureChange(older: SurfaceSnapshot, newer: SurfaceSnapshot, was: MethodSignature, now: MethodSignature, undoneNow: MethodSignature = now): string | null {
  // A rename is its own row: the signature reads differently only when it
  // still does with the method's own name and the traced renames undone.
  if (shownSignature(was) !== shownSignature(underName(undoneNow, was.name))) return `signature ${shownSignature(was)} → ${shownSignature(now)}`;
  const oldDefs = new Map(older.types.map((d) => [d.id, d] as const));
  const newDefs = new Map(newer.types.map((d) => [d.id, d] as const));
  const ids = [...new Set([...closureIds(older, was), ...closureIds(newer, now)])].sort();
  const moved = ids.filter((id) => {
    const a = oldDefs.get(id);
    const b = newDefs.get(id);
    return !a || !b || canonicalize(typeShape(older, a)) !== canonicalize(typeShape(newer, b));
  });
  const exported = new Set([...(newer.exportedTypes ?? []), ...(older.exportedTypes ?? [])].map((t) => t.type));
  const unlisted = moved.filter((id) => !exported.has(id));
  if (moved.length > 0 && unlisted.length === 0) return null;
  const named = (unlisted.length > 0 ? unlisted : moved).map((id) => `"${id}"`).join(', ');
  return named ? `signature reads the same, but a type it names changed shape: ${named}` : 'signature reads the same, but a type it names changed shape';
}

/** A method read under another name: its name, and the name its prose signature opens with. */
function underName(method: MethodSignature, name: string): MethodSignature {
  if (method.name === name) return method;
  const signature = typeof method.signature === 'string' && method.signature.startsWith(`${method.name}(`)
    ? `${name}${method.signature.slice(method.name.length)}`
    : method.signature;
  return { ...method, name, ...(signature !== undefined ? { signature } : {}) } as MethodSignature;
}

/**
 * A newer snapshot with every traced rename against an older one undone: each
 * closure type renamed per its trace (`formerly`) read back under its old id,
 * each reference to another project's type that only changed alias
 * (`a::name` → `b::name`, the same local name) read under the older
 * spelling, and each field renamed per its trace read back under its old
 * name — so a rename is counted once, as its rename, and never again as a
 * shape change of everything that names it. Pure.
 */
function withRenamesUndone(newer: SurfaceSnapshot, older: SurfaceSnapshot): SurfaceSnapshot {
  const olderIds = new Set(older.types.map((d) => d.id));
  const newerIds = new Set(newer.types.map((d) => d.id));
  const back = new Map<string, string>();
  for (const def of newer.types) {
    if (olderIds.has(def.id)) continue;
    const from = (def.formerly ?? []).find((n) => olderIds.has(n) && !newerIds.has(n));
    if (from !== undefined) back.set(def.id, from);
  }
  // Every qualified identifier each side spells, for alias respellings.
  const spelled = (snapshot: SurfaceSnapshot): Set<string> => {
    const out = new Set<string>(snapshot.types.map((d) => d.id).filter((id) => id.includes('::')));
    const add = (text: unknown): void => {
      if (typeof text !== 'string') return;
      for (const token of text.match(TYPE_IDENTIFIER) ?? []) if (token.includes('::')) out.add(token.replace(/^::/, ''));
    };
    for (const e of snapshot.interfaces) for (const m of e.methods) { for (const p of m.params ?? []) add(p.type); add(m.returns); add(m.signature); }
    for (const d of snapshot.types) { for (const x of d.fields) add(x.type); for (const p of d.params ?? []) add(p.type); add(d.returns); add(d.holds); }
    return out;
  };
  const was = spelled(older);
  const now = spelled(newer);
  const local = (id: string): string => id.slice(id.lastIndexOf('::') + 2);
  for (const id of now) {
    if (was.has(id) || back.has(id)) continue;
    const candidates = [...was].filter((w) => !now.has(w) && local(w) === local(id));
    if (candidates.length === 1) back.set(id, candidates[0]);
  }
  const respell = <T>(text: T): T => (typeof text === 'string' && back.size > 0
    ? text.replace(TYPE_IDENTIFIER, (token) => {
      const bare = token.replace(/^::/, '');
      const to = back.get(bare);
      return to === undefined ? token : `${token.startsWith('::') ? '::' : ''}${to}`;
    }) as T
    : text);
  const olderDefs = new Map(older.types.map((d) => [d.id, d] as const));
  const types = newer.types.map((d) => {
    const id = back.get(d.id) ?? d.id;
    const respelled: SurfaceTypeDef = {
      ...d,
      id,
      fields: d.fields.map((x) => ({ ...x, type: respell(x.type) })),
      ...(d.params ? { params: d.params.map((p) => ({ ...p, type: respell(p.type) })) } : {}),
      ...(d.returns !== undefined ? { returns: respell(d.returns) } : {}),
      ...(d.holds !== undefined ? { holds: respell(d.holds) } : {}),
    };
    const was = olderDefs.get(id);
    return was ? withFieldsRenamedBack(respelled, fieldRenames(was, respelled)) : respelled;
  });
  return {
    ...newer,
    types,
    interfaces: newer.interfaces.map((e) => ({
      ...e,
      methods: e.methods.map((m) => ({
        ...m,
        ...(m.params ? { params: m.params.map((p) => ({ ...p, type: respell(p.type) })) } : {}),
        returns: respell(m.returns),
        ...(typeof m.signature === 'string' ? { signature: respell(m.signature) } : {}),
      })),
    })),
    ...(newer.exportedTypes ? { exportedTypes: newer.exportedTypes.map((t) => ({ ...t, type: back.get(t.type) ?? t.type })) } : {}),
  };
}

/**
 * surface_snapshot.changesSince — what one producer's public surface changed
 * from an older snapshot of it to this one: each public name (contract entry
 * or exported type) added, removed, renamed per the newer snapshot's rename
 * trace (`formerly`), or changed — its audience, or a type's shape — and
 * inside each contract kept, each method added, removed, renamed per its
 * trace, or changed in signature (memberDigest). Prose and provenance are
 * never a change. Sorted by name, then member. Pure.
 */
export function surfaceChanges(newer: SurfaceSnapshot, older: SurfaceSnapshot): SurfaceChange[] {
  const out: SurfaceChange[] = [];
  const oldEntries = new Map(older.interfaces.map((e) => [e.id, e] as const));
  const oldTypes = new Map((older.exportedTypes ?? []).map((t) => [t.id, t] as const));
  const consumed = new Set<string>();
  // Every row past a rename is judged with the traced renames undone.
  const undone = withRenamesUndone(newer, older);
  const notes = closureRenames(newer, older);
  const formerOf = (formerly: string[] | undefined, has: (n: string) => boolean): string | undefined =>
    (formerly ?? []).find((f) => has(f) && !consumed.has(f));
  // Contract entries: added, renamed, changed member by member.
  newer.interfaces.forEach((entry, entryIndex) => {
    let before = oldEntries.get(entry.id);
    if (!before) {
      const from = formerOf(entry.formerly, (n) => oldEntries.has(n) && !newer.interfaces.some((e) => e.id === n));
      if (from === undefined) {
        out.push({ kind: 'added', name: entry.id, detail: `added: ${entry.type} contract with ${entry.methods.length} method(s), audience ${entry.audience}` });
        return;
      }
      consumed.add(from);
      before = oldEntries.get(from)!;
      out.push({ kind: 'renamed', name: entry.id, from, detail: `renamed from "${from}"` });
    }
    if (before.audience !== entry.audience) out.push({ kind: 'changed', name: entry.id, detail: `audience ${before.audience} → ${entry.audience}` });
    // Every other fact a consumer's pin carries and is drifted by.
    for (const [label, was, now] of entryFacts(before, entry)) {
      if (factValue(was) !== factValue(now)) out.push({ kind: 'changed', name: entry.id, detail: `${label} ${shownFact(was)} → ${shownFact(now)}` });
    }
    const oldMethods = new Map(before.methods.map((m) => [m.name, m] as const));
    const usedOld = new Set<string>();
    entry.methods.forEach((method, methodIndex) => {
      let was = oldMethods.get(method.name);
      if (!was) {
        const from = (method.formerly ?? []).find((f) => oldMethods.has(f) && !entry.methods.some((m) => m.name === f));
        if (from === undefined) {
          out.push({ kind: 'added', name: entry.id, member: method.name, detail: `method added: ${shownSignature(method)}` });
          return;
        }
        was = oldMethods.get(from)!;
        out.push({ kind: 'renamed', name: entry.id, member: method.name, from, detail: `method renamed from "${from}"` });
      }
      usedOld.add(was.name);
      const a = memberDigest(older, before.id, was.name);
      const b = memberDigest(newer, entry.id, method.name);
      // A rename alone moves the digest's name, and a traced type or field
      // rename the shapes of its closure: compare under the old names.
      const undoneMethod = undone.interfaces[entryIndex].methods[methodIndex];
      const underOld = (snapshot: SurfaceSnapshot, m: MethodSignature): string | null => memberDigest({ ...snapshot, interfaces: snapshot.interfaces.map((e, i) => (i !== entryIndex ? e : { ...e, id: before!.id, methods: e.methods.map((x) => (x === m ? underName(x, was!.name) : x)) })) }, before!.id, was!.name);
      const sameShape = a === b || underOld(newer, method) === a || underOld(undone, undoneMethod) === a;
      if (!sameShape) {
        const changed = signatureChange(older, undone, was, method, undoneMethod);
        if (changed !== null) out.push({ kind: 'changed', name: entry.id, member: method.name, detail: changed });
      } else if (a !== b) {
        // Moved only through renames of types it names: said on the method when
        // no row of this surface lists them (a type it exports under no name —
        // another project's type expanded into it).
        const exported = new Set((newer.exportedTypes ?? []).map((t) => t.type));
        const embedded = renamesIn(closureIds(newer, method).filter((id) => !exported.has(id)), notes);
        if (embedded.length > 0) out.push({ kind: 'changed', name: entry.id, member: method.name, detail: `signature reads the same, but it names renamed types: ${embedded.join('; ')}` });
      }
      for (const r of paramRenames(was, method)) {
        out.push({ kind: 'renamed', name: entry.id, member: method.name, from: r.from, detail: `parameter "${r.from}" renamed to "${r.to}"` });
      }
      if (factValue(was.effect) !== factValue(method.effect)) {
        out.push({ kind: 'changed', name: entry.id, member: method.name, detail: `effect ${shownEffect(was.effect)} → ${shownEffect(method.effect)}` });
      }
    });
    for (const m of before.methods) {
      if (!usedOld.has(m.name)) out.push({ kind: 'removed', name: entry.id, member: m.name, detail: `method removed: ${shownSignature(m)}` });
    }
  });
  // Exported types: added, renamed, changed in shape.
  for (const t of newer.exportedTypes ?? []) {
    let before = oldTypes.get(t.id);
    if (!before) {
      const def = newer.types.find((d) => d.id === t.type);
      const gone = (n: string): boolean => oldTypes.has(n) && !(newer.exportedTypes ?? []).some((x) => x.id === n);
      // Traced (the definition's rename trace), or the same definition under a new public name.
      const from = formerOf(def?.formerly, gone)
        ?? (older.exportedTypes ?? []).find((x) => x.type === t.type && gone(x.id) && !consumed.has(x.id))?.id;
      if (from === undefined) {
        out.push({ kind: 'added', name: t.id, detail: `type added (${def?.kind ?? 'type'}), audience ${t.audience}` });
        continue;
      }
      consumed.add(from);
      before = oldTypes.get(from)!;
      out.push({ kind: 'renamed', name: t.id, from, detail: `type renamed from "${from}"` });
    }
    if (before.audience !== t.audience) out.push({ kind: 'changed', name: t.id, detail: `audience ${before.audience} → ${t.audience}` });
    const a = memberDigest(older, before.id, 'type');
    const b = memberDigest(newer, t.id, 'type');
    const oldDef = older.types.find((d) => d.id === before!.type);
    const newDef = newer.types.find((d) => d.id === t.type);
    // A field renamed with a trace reads as the rename, with its new name —
    // beside the type's own rename, never folded into it.
    const renames = oldDef && newDef ? fieldRenames(oldDef, newDef) : [];
    for (const r of renames) out.push({ kind: 'renamed', name: t.id, member: r.to, from: r.from, detail: `field "${r.from}" renamed to "${r.to}"` });
    if (a !== b) {
      // Judged with every traced rename undone: the anonymous shape row stays
      // only for what the renames do not explain, and a type whose shape moved
      // only through renames it embeds says which.
      if (memberDigest(undone, t.id, 'type') !== a) {
        out.push({ kind: 'changed', name: t.id, detail: 'type shape changed (fields, values, held primitive or a type it names)' });
      } else if (renames.length === 0 && newDef) {
        const embedded = renamesIn(closureOfDef(newer, newDef).filter((id) => id !== newDef.id), notes);
        if (embedded.length > 0) out.push({ kind: 'changed', name: t.id, detail: `embeds ${embedded.join('; ')}` });
      }
    }
    // A type's own methods are carried for bindings, never digested: a change drifts a pin.
    if (oldDef && newDef && factValue(typeMethods(oldDef)) !== factValue(typeMethods(newDef))) out.push({ kind: 'changed', name: t.id, detail: 'type methods changed (a method added, removed, or its params or returns)' });
  }
  // The producer's targetLanguage: what a consumer in another language bridges to.
  if (factValue(older.targetLanguage) !== factValue(newer.targetLanguage)) {
    out.push({ kind: 'changed', name: newer.projectId ?? newer.projectName, detail: `targetLanguage ${shownFact(older.targetLanguage)} → ${shownFact(newer.targetLanguage)}` });
  }
  // Whatever the older surface had that the newer neither keeps nor renamed.
  for (const e of older.interfaces) {
    if (!newer.interfaces.some((x) => x.id === e.id) && !consumed.has(e.id)) out.push({ kind: 'removed', name: e.id, detail: `removed: ${e.type} contract with ${e.methods.length} method(s)` });
  }
  for (const t of older.exportedTypes ?? []) {
    if (!(newer.exportedTypes ?? []).some((x) => x.id === t.id) && !consumed.has(t.id)) out.push({ kind: 'removed', name: t.id, detail: 'type removed' });
  }
  return out.sort((x, y) => (x.name === y.name ? ((x.member ?? '') < (y.member ?? '') ? -1 : (x.member ?? '') > (y.member ?? '') ? 1 : 0) : x.name < y.name ? -1 : 1));
}
