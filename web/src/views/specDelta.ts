/**
 * The spec value-editor's save delta (SpecsEditor) — kept free of React so the
 * round-trip test drives it against the real `sdd_update_spec` merge.
 */

export type SpecKind = 'system' | 'subsystem' | 'component' | 'interface' | 'implementation' | 'type';

const jeq = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Top-level scalar/enum fields editable per kind (values only). */
const SCALAR_FIELDS: Record<SpecKind, string[]> = {
  system: ['vision'],
  subsystem: ['name', 'description', 'status', 'profile', 'designDepth', 'targetLanguage'],
  component: ['name', 'description', 'status', 'componentType', 'transport', 'basePath', 'durability'],
  interface: ['name', 'description'],
  implementation: ['name', 'description', 'status', 'detail', 'conformance'],
  type: ['name', 'description', 'kind'],
};

/** Optional enum fields the delta merge cannot UNSET (JSON drops undefined; the
 *  merge spreads, so '' would fail schema). Changing to a real value works;
 *  clearing a previously-set value is a no-op (documented). */
const OPTIONAL_ENUM_FIELDS = new Set(['profile', 'designDepth', 'transport', 'durability', 'detail', 'conformance']);

/**
 * The delta that turns a stored list into the list an editor shows — in the
 * merge vocabulary of `sdd_update_spec`, which has no whole-list replace.
 *
 * A delta list MERGES on the server: a list of plain values (owns, dependsOn,
 * guarantees, technologies written as names, boundaries and requirements
 * written as text) appends each value it lacks and keeps every value it
 * holds, and a list whose elements carry an identity (a boundary by `name`, a
 * technology by `name`) upserts by it. Neither drops an element the delta
 * leaves out — so an editor that sends the whole list after removing an item
 * silently keeps it. A value leaves only by an explicit removal marker, and
 * `[]` clears.
 *
 * So the editor sends exactly what changed: a removal marker for every stored
 * element the draft no longer holds, and the draft's new or changed elements.
 * When the merge would not leave them in the draft's order (an item edited in
 * place is a removal plus an append; a reorder), every stored element is
 * removed and the draft re-added in order — one atomic delta, applied element
 * by element. A list mixing shapes (a text item beside an object) has no
 * uniform identity; the server replaces it wholesale, so the whole draft goes.
 */

const isPlain = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** A requirement written as an object is the same requirement as its text. */
const isRequirementObject = (field: string, v: unknown): boolean =>
  field === 'globalRequirements' && isObject(v) && typeof v.description === 'string';

/** The key an object element is upserted by (the server's identityKeyOf, for the fields an editor writes). */
function objectIdentity(field: string, v: Record<string, unknown>): string | null {
  const str = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null);
  if (field === 'globalRequirements') return str(v.description);
  return str(v.name) ?? str(v.id);
}

type Shape =
  | { kind: 'plain'; key: (v: unknown) => string; marker: (v: unknown) => Record<string, unknown> }
  | { kind: 'identified'; key: (v: unknown) => string; marker: (v: unknown) => Record<string, unknown> }
  | { kind: 'wholesale' };

/** How the server merges a delta for this field over these two lists. */
function shapeOf(field: string, stored: unknown[], draft: unknown[]): Shape {
  const both = [...stored, ...draft];
  const plainish = (v: unknown): boolean => isPlain(v) || isRequirementObject(field, v);
  if (both.every(plainish)) {
    return {
      kind: 'plain',
      key: (v) => (isPlain(v) ? String(v) : String((v as Record<string, unknown>).description)),
      marker: (v) => (isPlain(v) ? { value: v, action: 'delete' } : { description: (v as Record<string, unknown>).description, action: 'delete' }),
    };
  }
  if (both.every((v) => isObject(v) && objectIdentity(field, v) !== null)) {
    return {
      kind: 'identified',
      key: (v) => objectIdentity(field, v as Record<string, unknown>)!,
      marker: (v) => {
        const o = v as Record<string, unknown>;
        return o.name !== undefined || field === 'globalRequirements'
          ? { ...(field === 'globalRequirements' ? { description: o.description } : { name: o.name }), action: 'delete' }
          : { id: o.id, action: 'delete' };
      },
    };
  }
  return { kind: 'wholesale' };
}

/**
 * The delta value for one list field, or `undefined` when the draft equals the
 * stored list. A draft that names one key twice cannot be held by a merging
 * list; the merge keeps the first.
 */
export function listDelta(field: string, stored: unknown[] | undefined, draft: unknown[] | undefined): unknown[] | undefined {
  const before = stored ?? [];
  const after = draft ?? [];
  if (jeq(before, after)) return undefined;
  if (after.length === 0) return [];
  const shape = shapeOf(field, before, after);
  if (shape.kind === 'wholesale') return after;

  const draftKeys = new Set(after.map(shape.key));
  const storedByKey = new Map(before.map((v) => [shape.key(v), v] as const));
  const removals = before.filter((v) => !draftKeys.has(shape.key(v))).map(shape.marker);
  // Plain values are their identity, so only a new one is sent; an identified
  // element is sent when it is new or any of its fields changed.
  const writes = after.filter((v) => {
    const held = storedByKey.get(shape.key(v));
    return held === undefined || (shape.kind === 'identified' && !jeq(held, v));
  });
  // The order the merge leaves: the kept stored elements in place, the new ones appended.
  const merged = [
    ...before.map(shape.key).filter((k) => draftKeys.has(k)),
    ...after.map(shape.key).filter((k) => !storedByKey.has(k)),
  ];
  const wanted = after.map(shape.key);
  if (jeq(merged, wanted)) return [...removals, ...writes];
  // Not the draft's order: remove every stored element, then add the draft in order.
  return [...before.map(shape.marker), ...after];
}

// ── Delta builder ───────────────────────────────────────────────────────────────

function scalarDelta(kind: SpecKind, orig: Record<string, unknown>, draft: Record<string, unknown>): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const f of SCALAR_FIELDS[kind]) {
    const nv = draft[f];
    const ov = orig[f];
    if (nv === ov) continue;
    if ((nv === '' || nv === undefined) && ov === undefined) continue; // no-op
    if (nv === undefined) continue;
    if (nv === '' && OPTIONAL_ENUM_FIELDS.has(f)) continue; // merge cannot unset optional enums
    delta[f] = nv;
  }
  return delta;
}

/** Interface method value deltas (merged by name). Params merge by name and are
 *  sent complete; guarantees are a plain-value list, so a removed one goes back
 *  as a removal marker (listDelta) — sent whole, it would be kept. */
function interfaceMethodsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const dm of draft.methods ?? []) {
    const om = (orig.methods ?? []).find((m: any) => m.name === dm.name);
    if (!om) continue;
    const ch: any = {};
    if (dm.description !== om.description) ch.description = dm.description;
    // A method with params or a signatureFrom shows a DERIVED signature, which
    // is never written back; only a prose method's signature is edited.
    if (dm.signature !== om.signature && !dm.signatureFrom && !(dm.params ?? []).length) ch.signature = dm.signature;
    if (dm.returns !== om.returns && !dm.signatureFrom) ch.returns = dm.returns;
    if ((dm.signatureFrom ?? '') !== (om.signatureFrom ?? '')) {
      if (dm.signatureFrom) {
        // Adopting a source: the method states no params or returns of its own.
        ch.signatureFrom = dm.signatureFrom;
        if (!om.signatureFrom) ch.unset = ['params', 'returns', 'signature'];
      } else {
        // Dropping the source: the method keeps the signature it showed, as its own.
        const resolved = (draft.resolvedSignatures ?? []).find((r: any) => r.method === dm.name);
        ch.unset = ['signatureFrom'];
        if (resolved?.params) ch.params = resolved.params;
        ch.returns = resolved?.returns ?? dm.returns ?? 'unknown';
        if (!resolved?.params) ch.signature = resolved?.signature ?? `${dm.name}(): ${ch.returns}`;
      }
    }
    if ((dm.effect ?? '') !== (om.effect ?? '') && dm.effect) ch.effect = dm.effect;
    const guarantees = listDelta('guarantees', om.guarantees, dm.guarantees);
    if (guarantees !== undefined) ch.guarantees = guarantees;
    if (!dm.signatureFrom && !om.signatureFrom && !jeq(dm.params ?? [], om.params ?? [])) ch.params = dm.params ?? [];
    if (!jeq(dm.endpoint, om.endpoint)) ch.endpoint = dm.endpoint;
    if (Object.keys(ch).length) out.push({ name: dm.name, ...ch });
  }
  return out;
}

/** Implementation method value deltas (merged by name; narrative untouched). */
function implMethodsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const dm of draft.methods ?? []) {
    const om = (orig.methods ?? []).find((m: any) => m.name === dm.name);
    if (!om) continue;
    const ch: any = {};
    if ((dm.detail ?? '') !== (om.detail ?? '') && dm.detail) ch.detail = dm.detail;
    if ((dm.conformance ?? '') !== (om.conformance ?? '') && dm.conformance) ch.conformance = dm.conformance;
    if ((dm.intent ?? '') !== (om.intent ?? '')) ch.intent = dm.intent ?? '';
    if (Object.keys(ch).length) out.push({ name: dm.name, ...ch });
  }
  return out;
}

/** Enum value deltas (merged by name): a value's description; its name is its identity. */
function enumValuesDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const dv of draft.values ?? []) {
    const ov = (orig.values ?? []).find((v: any) => v.name === dv.name);
    if (!ov) continue;
    if ((dv.description ?? '') !== (ov.description ?? '')) out.push({ name: dv.name, description: dv.description ?? '' });
  }
  return out;
}

/** Type field value deltas (merged by name). */
function typeFieldsDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  for (const df of draft.fields ?? []) {
    const of = (orig.fields ?? []).find((f: any) => f.name === df.name);
    if (!of) continue;
    const ch: any = {};
    if (df.type !== of.type) ch.type = df.type;
    if ((df.description ?? '') !== (of.description ?? '')) ch.description = df.description ?? '';
    if (!!df.optional !== !!of.optional) ch.optional = !!df.optional;
    if ((df.key ?? '') !== (of.key ?? '') && df.key) ch.key = df.key; // cannot unset
    if ((df.references ?? '') !== (of.references ?? '')) ch.references = df.references ?? '';
    if (Object.keys(ch).length) out.push({ name: df.name, ...ch });
  }
  return out;
}

/**
 * publicInterfaces value deltas. The server merges an entry by its identity:
 * component+interface for an own item, source+item+alias for a re-export — so
 * every identity field the entry carries goes back with the change, or a
 * re-export's edit would land as a new own entry.
 */
function piDelta(orig: any, draft: any, kind: SpecKind): any[] {
  const out: any[] = [];
  const list = draft.publicInterfaces ?? [];
  for (let i = 0; i < list.length; i++) {
    const dpi = list[i];
    const opi = (orig.publicInterfaces ?? [])[i];
    if (!opi) continue;
    const ch: any = {};
    if ((dpi.type ?? '') !== (opi.type ?? '') && dpi.type) ch.type = dpi.type;
    if ((dpi.details ?? '') !== (opi.details ?? '')) ch.details = dpi.details ?? '';
    if (kind === 'system') {
      if ((dpi.name ?? '') !== (opi.name ?? '')) ch.name = dpi.name ?? '';
      if ((dpi.audience ?? '') !== (opi.audience ?? '') && dpi.audience) ch.audience = dpi.audience;
    }
    if (Object.keys(ch).length) {
      out.push({
        ...(opi.from !== undefined ? { from: opi.from } : {}),
        ...(opi.component !== undefined ? { component: opi.component } : {}),
        ...(opi.typeDef !== undefined ? { typeDef: opi.typeDef } : {}),
        ...(opi.interface !== undefined ? { interface: opi.interface } : {}),
        ...(opi.as !== undefined ? { as: opi.as } : {}),
        ...ch,
      });
    }
  }
  return out;
}

/** Subsystem lifecycle deltas — description only (phase+component+method are the
 *  merge identity, so they are never changed here). */
function lifecycleDelta(orig: any, draft: any): any[] {
  const out: any[] = [];
  const list = draft.lifecycle ?? [];
  for (let i = 0; i < list.length; i++) {
    const dl = list[i];
    const ol = (orig.lifecycle ?? [])[i];
    if (!ol) continue;
    if ((dl.description ?? '') !== (ol.description ?? '')) {
      out.push({ phase: ol.phase, component: ol.component, method: ol.method, description: dl.description ?? '' });
    }
  }
  return out;
}

export function buildDelta(kind: SpecKind, orig: any, draft: any): Record<string, unknown> {
  const delta = scalarDelta(kind, orig, draft);
  if (kind === 'component' && !jeq(draft.externalLinks ?? [], orig.externalLinks ?? [])) {
    delta.externalLinks = draft.externalLinks ?? [];
  }
  if (kind === 'component' && !jeq(draft.auth ?? null, orig.auth ?? null)) {
    delta.auth = draft.auth ?? { scheme: 'none' };
  }
  // Lists MERGE on the server — an item left out is kept — so each goes back
  // as what changed: removal markers, new items, and the draft's order (listDelta).
  if (kind === 'implementation') {
    const technologies = listDelta('technologies', orig.technologies, draft.technologies);
    if (technologies !== undefined) delta.technologies = technologies;
  }
  if (kind === 'interface') {
    const md = interfaceMethodsDelta(orig, draft);
    if (md.length) delta.methods = md;
  }
  if (kind === 'implementation') {
    const md = implMethodsDelta(orig, draft);
    if (md.length) delta.methods = md;
  }
  if (kind === 'type') {
    // A named scalar's holds: set, changed, or cleared (an unset, since '' would be a type position).
    if ((draft.holds ?? '') !== (orig.holds ?? '')) {
      if (draft.holds) delta.holds = draft.holds;
      else delta.unset = ['holds'];
    }
    const fd = typeFieldsDelta(orig, draft);
    if (fd.length) delta.fields = fd;
    const vd = enumValuesDelta(orig, draft);
    if (vd.length) delta.values = vd;
  }
  if (kind === 'subsystem' || kind === 'system') {
    const pd = piDelta(orig, draft, kind);
    if (pd.length) delta.publicInterfaces = pd;
  }
  if (kind === 'system') {
    // boundaries (by name) and globalRequirements (by text) merge: a removed
    // item goes back as a removal marker, never by its absence (listDelta).
    const boundaries = listDelta('boundaries', orig.boundaries, draft.boundaries);
    if (boundaries !== undefined) delta.boundaries = boundaries;
    const requirements = listDelta('globalRequirements', orig.globalRequirements, draft.globalRequirements);
    if (requirements !== undefined) delta.globalRequirements = requirements;
  }
  if (kind === 'subsystem') {
    const ld = lifecycleDelta(orig, draft);
    if (ld.length) delta.lifecycle = ld;
  }
  return delta;
}
