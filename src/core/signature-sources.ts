import {
  deriveMethodSignature,
  typeMatchesRef,
  type AuthoredReference,
  type ComponentSpec,
  type InterfaceSpec,
  type MethodParam,
  type MethodSignature,
  type StoredInterfaceSpec,
  type StoredTypeSpec,
  type TypeSpec,
} from '../models/index.js';
import type { TypedSpecKind } from '../models/type-grammar.js';

// ---------------------------------------------------------------------------
// signature_resolver — every method signature of one scan, resolved.
//
// Pure logic over the specs it is handed, run by the Spec Index inside its scan
// once every reference of the family is bound (the arrangement the Export
// Resolver already has). Each contract method naming a `signatureFrom` is read
// BOTH ways — as a method source `component.method` and as a signature type —
// and bound when exactly one reading resolves; the source's params and returns
// are put on it. Then every params-bearing contract method and type method gets
// its derived text.
//
// It never refuses and never judges an edge: a source it cannot bind, a source
// naming a source of its own, a stored method restating its source and a stored
// text its params contradict are each a FACT for the rules. The loaded specs are
// resolved, so these facts are the one place the stored form stays visible.
// ---------------------------------------------------------------------------

/**
 * Which reading of a signatureFrom resolved: a contract method, a signature
 * type, or a contract method of another project's export entry
 * (`alias::name.method`, its types spelled as the referrer spells them).
 */
export type SignatureSourceForm = 'method' | 'signature' | 'export';

/** What resolving one signatureFrom found. */
export type SignatureSourceOutcome = 'resolved' | 'unresolved' | 'ambiguous' | 'chained' | 'restated';

/** signature_source_fact — what resolving one contract method's signatureFrom found. */
export interface SignatureSourceFact {
  /** The contract declaring the method, keyed as the index keys it. */
  interfaceId: string;
  /** The component that contract belongs to — the end the dependsOn/owns edge is read from. */
  component: string;
  /** The method naming the source. */
  method: string;
  /** The signatureFrom as the file wrote it. */
  source: string;
  /** Which reading resolved; absent when neither or both did. */
  form?: SignatureSourceForm;
  /** `<component key>.<method>` for a method source, the type's qualified id for a signature source. */
  target?: string;
  outcome: SignatureSourceOutcome;
  /** The kind of the type found, the source's own source, or the restated difference. */
  detail?: string;
  /** On a restated outcome: whether the stated params or returns differ from the source's. */
  differs?: boolean;
  /** On an ambiguous outcome: the method and the signature type the value both names. */
  candidates?: string[];
}

/** stale_signature_text — a stored signature text that differs from the text its params derive. */
export interface StaleSignatureText {
  /** The interface or type holding the method. */
  specId: string;
  kind: TypedSpecKind;
  /** The method whose text is stale. */
  method: string;
  /** The text the file holds. */
  stored: string;
  /** The text the params derive, which is what is shown. */
  derived: string;
}

/** signature_facts — what one scan's signature resolution recorded, for the rules to judge. */
export interface SignatureFacts {
  /** One fact per contract method naming a signatureFrom (two for a restated one: restated, then resolved). */
  sources: SignatureSourceFact[];
  /** One fact per contract or type method whose stored text differs from its derived text. */
  staleTexts: StaleSignatureText[];
}

/** signature_resolution — the scan's specs with every signature resolved, and the facts resolving them produced. */
export interface SignatureResolution {
  interfaces: InterfaceSpec[];
  types: TypeSpec[];
  facts: SignatureFacts;
}

/** No facts at all: what a resolution starts from. */
function emptySignatureFacts(): SignatureFacts {
  return { sources: [], staleTexts: [] };
}

/** The resolved method a contract method source names: its key and the method itself. */
interface MethodHit {
  target: string;
  method: MethodSignature;
}

/** The lookups one resolution is built on, computed once. */
interface ResolutionTables {
  /** Component key → the methods its contracts declare, in contract order (as stored, before resolution). */
  methodsOf: Map<string, MethodSignature[]>;
  componentKeys: Set<string>;
  types: TypeSpec[];
  /** `<interface key>|<authored text>` → the key the scan bound that type reference to. */
  boundTypes: Map<string, string>;
  /** `<referring namespace>|<alias>::<public name>.<method>` → that export entry's method, spelled as the referrer writes it. */
  exportMethods: ReadonlyMap<string, MethodSignature>;
}

/** The namespace a keyed id sits in: everything before its last `::` ('' at the bound root). */
function namespaceOf(key: string): string {
  const at = key.lastIndexOf('::');
  return at === -1 ? '' : key.slice(0, at);
}

/** A method as it stands with no params to show: no params, returns `unknown`. */
function unresolvedMethod(method: MethodSignature): MethodSignature {
  const { params: _params, ...rest } = method;
  return { ...rest, returns: 'unknown', signature: `${method.name}(...): unknown` };
}

/** Whether two param lists are one contract: name, type, optional marker and order. */
function sameParams(a: ReadonlyArray<MethodParam> | undefined, b: ReadonlyArray<MethodParam> | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length
    && left.every((p, i) => p.name === right[i].name && p.type === right[i].type && !!p.optional === !!right[i].optional);
}

/**
 * Step 1: index the copies — each component key to its contracts' methods, the
 * types, and every type reference the scan bound (an `alias::name` lands where
 * the referring root's alias table sends it, whatever the producer's id is).
 */
function tablesOf(
  interfaces: InterfaceSpec[],
  components: ComponentSpec[],
  types: TypeSpec[],
  references: ReadonlyArray<AuthoredReference>,
  exportMethods: ReadonlyMap<string, MethodSignature> = new Map(),
): ResolutionTables {
  const methodsOf = new Map<string, MethodSignature[]>();
  for (const intf of interfaces) methodsOf.set(intf.component, [...(methodsOf.get(intf.component) ?? []), ...intf.methods]);
  const boundTypes = new Map<string, string>();
  for (const ref of references) {
    if (ref.position !== 'type' || ref.binding === 'outside' || ref.binding === 'unresolved') continue;
    boundTypes.set(`${ref.specId}|${ref.authored}`, ref.resolved);
  }
  return { methodsOf, componentKeys: new Set(components.map((c) => c.id)), types, boundTypes, exportMethods };
}

/** Step 3, the method reading: the head a component in the owning interface's namespace, the tail a method on its contracts. */
function methodReading(tables: ResolutionTables, intf: InterfaceSpec, value: string): MethodHit | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const head = value.slice(0, dot);
  const tail = value.slice(dot + 1);
  const ns = namespaceOf(intf.id);
  const keys = [head, ...(ns && !head.startsWith(`${ns}::`) ? [`${ns}::${head}`] : [])];
  for (const key of keys) {
    if (!tables.componentKeys.has(key)) continue;
    const method = (tables.methodsOf.get(key) ?? []).find((m) => m.name === tail);
    if (method) return { target: `${key}.${tail}`, method };
  }
  return null;
}

/**
 * Step 3, the export reading: no component of the scan answers, and the value
 * names a method of another project's export entry the scan handed in
 * (`alias::name.method` — a declared external's pin, a contained member's live
 * table), keyed by the owning interface's namespace.
 */
function exportReading(tables: ResolutionTables, intf: InterfaceSpec, value: string): MethodHit | null {
  if (!value.includes('::')) return null;
  const method = tables.exportMethods.get(`${namespaceOf(intf.id)}|${value}`);
  return method ? { target: value, method } : null;
}

/**
 * Step 3, the type reading: the types the value names as every type reference
 * is matched, same project first. A value the scan bound (an `alias::name`)
 * lands on its bound key exactly, as every other bound type reference does.
 */
function typeReading(tables: ResolutionTables, intf: InterfaceSpec, value: string): { signature?: TypeSpec; other?: TypeSpec } {
  const bound = value.includes('::') ? tables.boundTypes.get(`${intf.id}|${value}`) : undefined;
  const named = bound !== undefined
    ? tables.types.filter((t) => t.id === bound)
    : tables.types.filter((t) => t.id === value || typeMatchesRef(t, value));
  const ns = namespaceOf(intf.id);
  const local = (t: TypeSpec): number => (namespaceOf(t.id) === ns ? 0 : 1);
  const ranked = [...named].sort((a, b) => local(a) - local(b));
  return { signature: ranked.find((t) => t.kind === 'signature'), other: ranked.find((t) => t.kind !== 'signature') };
}

/** The qualified id a fact names a signature type by. */
function typeTarget(type: TypeSpec): string {
  return type.subsystem && !type.id.includes('::') ? `${type.subsystem}::${type.id}` : type.id;
}

/** Step 6: a restated fact when the stored method also states params or returns, with whether they differ. */
function restatedFact(base: Omit<SignatureSourceFact, 'outcome'>, stored: MethodSignature, params: MethodParam[] | undefined, returns: string): SignatureSourceFact | null {
  const statesParams = stored.params !== undefined;
  const statesReturns = stored.returns !== undefined;
  if (!statesParams && !statesReturns) return null;
  const paramsDiffer = statesParams && !sameParams(stored.params, params);
  const returnsDiffer = statesReturns && stored.returns !== returns;
  const differs = paramsDiffer || returnsDiffer;
  const detail = !differs ? 'restates its source exactly'
    : [paramsDiffer ? 'its params differ from the source\'s' : '', returnsDiffer ? `its returns "${stored.returns}" differ from the source's "${returns}"` : '']
      .filter(Boolean).join('; ');
  return { ...base, outcome: 'restated', differs, detail };
}

/** Steps 3-11 for one sourced method: bound and filled, or left without params — with the facts it produced. */
function resolveSourced(tables: ResolutionTables, intf: InterfaceSpec, stored: MethodSignature, facts: SignatureFacts): MethodSignature {
  const source = stored.signatureFrom!;
  const base = { interfaceId: intf.id, component: intf.component, method: stored.name, source };
  const local = methodReading(tables, intf, source);
  const external = local ? null : exportReading(tables, intf, source);
  const hit = local ?? external;
  const { signature, other } = typeReading(tables, intf, source);
  // Step 4: exactly one reading resolves?
  if (hit && signature) {
    facts.sources.push({ ...base, outcome: 'ambiguous', candidates: [hit.target, typeTarget(signature)] });
    return unresolvedMethod(stored);
  }
  if (!hit && !signature) {
    facts.sources.push({ ...base, outcome: 'unresolved', ...(other ? { detail: `"${typeTarget(other)}" is a type of kind ${other.kind}, not a signature` } : {}) });
    return unresolvedMethod(stored);
  }
  // Step 5: a chained source is recorded and never followed.
  if (hit && hit.method.signatureFrom !== undefined) {
    facts.sources.push({ ...base, form: 'method', target: hit.target, outcome: 'chained', detail: hit.method.signatureFrom });
    return unresolvedMethod(stored);
  }
  const form: SignatureSourceForm = external ? 'export' : hit ? 'method' : 'signature';
  const target = hit ? hit.target : typeTarget(signature!);
  const params = hit ? hit.method.params : signature!.params;
  const returns = hit ? hit.method.returns : (signature!.returns ?? 'unknown');
  // Step 6: a stored restatement, differing or not.
  const restated = restatedFact({ ...base, form, target }, stored, params, returns);
  if (restated) facts.sources.push(restated);
  // Step 7: the source's params and returns are in force.
  facts.sources.push({ ...base, form, target, outcome: 'resolved' });
  const resolved: MethodSignature = { ...stored, returns };
  // Step 7, the effect: it travels with the signature from a method source (local
  // or another project's export): a verb forwarding a pure method is itself
  // pure unless it declares otherwise. A signature type carries no effect.
  if (stored.effect === undefined && hit?.method.effect !== undefined) resolved.effect = hit.method.effect;
  if (params) resolved.params = params.map((p) => ({ ...p }));
  else delete resolved.params;
  // A prose source shows its own prose under this method's name.
  if (!params && hit) resolved.signature = hit.method.signature.replace(new RegExp(`^\\s*${hit.method.name}\\b`), stored.name);
  return resolved;
}

/** Step 13 for one method: its derived text, a stale fact recorded where a stored one differed. */
function withDerivedText<M extends { name: string; signature?: string; params?: MethodParam[]; returns?: string }>(
  method: M,
  stored: string | undefined,
  specId: string,
  kind: 'interface' | 'type',
  facts: SignatureFacts,
): M {
  const derived = deriveMethodSignature({ ...method, signature: stored ?? method.signature });
  if (derived === undefined) return method;
  if (stored !== undefined && stored !== derived) facts.staleTexts.push({ specId, kind, method: method.name, stored, derived });
  return { ...method, signature: derived };
}

/**
 * isignature_resolver.resolveTree — resolve every signature of one scan:
 * sourced methods bound and filled, every params-bearing contract method and
 * type method given its derived text, the facts beside them. A signature
 * type's own text is never stored: it is derived where it is shown
 * (deriveTypeSignature). The specs handed in are never mutated.
 *
 * `references` are the scan's authored references: an `alias::name` type
 * reading lands on the key the scan bound it to.
 */
export function resolveTree(
  interfaces: ReadonlyArray<InterfaceSpec | StoredInterfaceSpec>,
  components: ReadonlyArray<ComponentSpec>,
  types: ReadonlyArray<TypeSpec | StoredTypeSpec>,
  references: ReadonlyArray<AuthoredReference> = [],
  exportMethods: ReadonlyMap<string, MethodSignature> = new Map(),
): SignatureResolution {
  // Step 1: copies, so nothing the caller holds is mutated, and the lookups over them.
  const intfs = interfaces.map((i) => ({ ...i, methods: i.methods.map((m) => ({ ...m })) })) as InterfaceSpec[];
  const typeCopies = types.map((t) => ({ ...t, methods: t.methods.map((m) => ({ ...m })) })) as TypeSpec[];
  const tables = tablesOf(intfs, [...components], typeCopies, references, exportMethods);
  const facts = emptySignatureFacts();
  // Steps 2-12: every contract method naming a signatureFrom.
  const sourced = intfs.map((intf) => ({
    ...intf,
    methods: intf.methods.map((m) => (m.signatureFrom !== undefined ? resolveSourced(tables, intf, m, facts) : m)),
  }));
  // Step 13: the derived text of every params-bearing contract method and type
  // method. A signature type is answered as it is: its text is derived on display.
  const resolvedInterfaces = sourced.map((intf, i) => ({
    ...intf,
    methods: intf.methods.map((m, j) => withDerivedText(m, intfs[i].methods[j].signature, intf.id, 'interface', facts)),
  }));
  const resolvedTypes = typeCopies.map((t) => ({
    ...t,
    methods: t.methods.map((m) => withDerivedText(m, m.signature, t.id, 'type', facts)),
  }));
  // Step 14.
  return { interfaces: resolvedInterfaces, types: resolvedTypes, facts };
}
