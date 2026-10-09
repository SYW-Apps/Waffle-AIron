import { extractTypeIdentifiers, methodTypeRefs, nameKey, qualifiedTypeId } from '../../../models/type-references.js';
import type { ImplementationSpec, SurfaceContractEntry, SurfaceTypeDef, TypeSpec } from '../../../models/specs.js';
import type { ProjectNode } from '../../../models/project-family.js';
import type { BindingDeclaration, BindingMember, BindingModule } from '../../binding-modules.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔pin for a consumer's hand-written BINDING MODULE
// (implementation_spec.bindings): the one file where the consumer's code
// spells another project's names. Everything else the consumer writes calls
// the binding, so tsc and the tests stay green on the binding's own stale
// declarations after a re-pin — a renamed verb, a removed one, a renamed
// parameter, field or type all survive until the code meets the real library.
//
// The rule compares the binding's exported declarations with what the
// projects the naming implementations' components reach publish: a method or
// function name, its parameters' arity and names, a type's name, its field
// names and the type names its fields are declared with — all by nameKey, so
// `tile_at` and `tileAt` are one name. A component reaches a project through
// every `alias::name` its specs write, the types its contract names included,
// so a types-only contracts library is reached by the types a contract uses.
// The rename traces (`formerly`, a param's `previousNames`) turn a mismatch
// into the rename to follow, and a pin's `retired` names a removed verb. A
// declaration nothing matches is the binding's own plumbing (a loader, an
// aggregate handle) and is never judged. Pure: the validator reads the
// modules (binding module adapter) and the pins; this rule does no I/O.
//
// A contained MEMBER project is never pinned — the family reads it live — so
// a binding into a member is compared with what the member's L0 export table
// exports now, built from the member's specs this scan already loaded. The
// bound references spell a member by its project id or by the alias the root
// declares it under; both name it.
// ---------------------------------------------------------------------------

/** A reached interface or type, under the alias the consumer declares its project by. */
interface PinnedEntry { alias: string; entry: SurfaceContractEntry }
interface PinnedType { alias: string; def: SurfaceTypeDef }

/** A former name as a trace records it: `<interface>.<method>` for a method, the bare name otherwise. */
const lastSegment = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

/** The bound root's node in the scan's project graph. */
function boundRoot(ctx: RuleContext): ProjectNode | undefined {
  return ctx.projectFamily?.nodes.find((n) => n.namespace === '');
}

/** The contained member project a segment names — by the alias the root declares it under, or by its key — or null. */
function memberNode(ctx: RuleContext, segment: string): ProjectNode | null {
  const nodes = ctx.projectFamily?.nodes ?? [];
  const key = boundRoot(ctx)?.aliases.get(segment) ?? segment;
  return nodes.find((n) => n.parent === '' && n.namespace !== '' && (n.mountAlias === segment || n.namespace === key)) ?? null;
}

/**
 * The surface a member project of the bound root exports now, under the alias
 * its parent declares it by, in a snapshot's shapes: each component its L0
 * table exports with its contract methods (narrowed to the exported
 * interface), each exported type with its fields — every one with its rename
 * trace.
 */
function memberSurface(ctx: RuleContext, node: ProjectNode, alias: string): { entries: PinnedEntry[]; types: PinnedType[] } {
  const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === node.namespace);
  const entries: PinnedEntry[] = [];
  const types: PinnedType[] = [];
  const ns = node.namespace;
  // A type of the member, by a reference it writes (local, or qualified by its key or a subsystem).
  const memberType = (ref: string): TypeSpec | undefined => {
    const local = lastSegment(ref.replace(/::/g, '.'));
    return ctx.types.find((t) => qualifiedTypeId(t) === ref || t.id === ref)
      ?? ctx.types.find((t) => t.id === `${ns}::${local}` || (t.id.startsWith(`${ns}::`) && lastSegment(t.id.replace(/::/g, '.')) === local));
  };
  const asDef = (type: TypeSpec, id: string): SurfaceTypeDef => ({
    id,
    name: type.name,
    kind: type.kind ?? 'value-object',
    ...(type.holds !== undefined ? { holds: type.holds } : {}),
    fields: (type.fields ?? []).map((f) => ({ name: f.name, type: f.type, ...(f.previousNames?.length ? { formerly: f.previousNames } : {}) })),
    formerly: (type.previousIds ?? []).map((p) => lastSegment(p.replace(/::/g, '.'))),
  } as unknown as SurfaceTypeDef);
  const pending: string[] = [];
  for (const e of table?.entries ?? []) {
    if (e.kind === 'component' && e.component) {
      const contracts = (ctx.interfacesByComponent.get(e.component) ?? [])
        .filter((i) => !e.interface || i.id === e.interface || i.id.endsWith(`::${e.interface}`));
      const methods = contracts.flatMap((i) => i.methods).map((m) => ({
        ...m,
        formerly: (m.previousNames ?? []).map(lastSegment),
      }));
      entries.push({ alias, entry: { id: e.publicName, name: e.publicName, component: e.component, methods } as unknown as SurfaceContractEntry });
      for (const m of methods) pending.push(...methodTypeRefs(m));
    } else if (e.kind === 'type' && e.typeDef) {
      const type = memberType(e.typeDef);
      if (!type) continue;
      types.push({ alias, def: asDef(type, e.publicName) });
      for (const f of type.fields ?? []) pending.push(...extractTypeIdentifiers(f.type));
    }
  }
  // The closure the exported contracts and types name, as a pin's snapshot
  // carries it — each type under the project that OWNS it: a type the member
  // takes from another project (its own external, a sibling member) is that
  // project's, named by the alias the bound root reaches it by, never the member's.
  const seen = new Set(types.map((t) => `${t.alias}::${nameKey(t.def.id)}`));
  while (pending.length > 0) {
    const ref = pending.pop()!;
    const type = memberType(ref);
    if (!type) continue;
    const id = lastSegment(type.id.replace(/::/g, '.'));
    const owner = type.id.includes('::') ? type.id.slice(0, type.id.indexOf('::')) : ns;
    const ownerAlias = owner === ns ? alias : ownerAliasOf(ctx, owner);
    const key = `${ownerAlias}::${nameKey(id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    types.push({ alias: ownerAlias, def: asDef(type, id) });
    for (const f of type.fields ?? []) pending.push(...extractTypeIdentifiers(f.type));
  }
  return { entries, types };
}

/** The alias the bound root reaches a family project by: the alias it declares the member under, else the project's id, else its key. */
function ownerAliasOf(ctx: RuleContext, namespace: string): string {
  const node = (ctx.projectFamily?.nodes ?? []).find((n) => n.namespace === namespace);
  const declared = [...(boundRoot(ctx)?.aliases.entries() ?? [])].find(([, key]) => key === namespace)?.[0];
  return node?.mountAlias ?? declared ?? node?.id ?? namespace;
}

/** nameKey with a trailing Api, Port or Client dropped: `TilesApi` and `Tiles API` are the pin's `tiles`. */
function stem(name: string): string {
  return nameKey(name).replace(/(?:api|port|client)$/, '') || nameKey(name);
}

/** The first segment of every `seg::name` a list of references or type texts names. */
function firstSegments(refs: string[]): string[] {
  const out: string[] = [];
  for (const ref of refs) {
    const cut = ref.indexOf('::');
    if (cut > 0) out.push(ref.slice(0, cut));
  }
  return out;
}

/**
 * The first segments of every `alias::name` a component's specs write: a
 * dependsOn, owns, narrative or declared call, an implements — and every named
 * type its contracts' params and returns write, followed through the bound
 * project's own types they name, so a types-only library is reached too.
 */
function reachedSegments(ctx: RuleContext, impl: ImplementationSpec): Set<string> {
  const refs: string[] = [];
  const contract = ctx.interfaceMap.get(impl.contract);
  const component = contract ? ctx.componentMap.get(contract.component) : undefined;
  if (component) refs.push(...component.dependsOn, ...(component.owns ?? []));
  if (contract?.implements) refs.push(contract.implements);
  for (const other of ctx.implementations) {
    if (other.contract !== impl.contract) continue;
    for (const method of other.methods) {
      for (const step of method.narrative) if (step.targetComponent) refs.push(step.targetComponent);
      for (const call of method.calls ?? []) refs.push(call.slice(0, call.lastIndexOf('.')));
    }
  }
  // The types the component's contracts name, through its own types.
  const contracts = component ? (ctx.interfacesByComponent.get(component.id) ?? []) : contract ? [contract] : [];
  const pending = contracts.flatMap((c) => c.methods.flatMap((m) => methodTypeRefs(m)));
  const seen = new Set<string>();
  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
    if (ref.includes('::') && !ctx.types.some((t) => t.id === ref)) continue;
    const own: TypeSpec | undefined = ctx.types.find((t) => !t.id.includes('::') && (t.id === ref || qualifiedTypeId(t) === ref || nameKey(t.name) === nameKey(ref)));
    if (!own) continue;
    for (const f of own.fields ?? []) pending.push(...extractTypeIdentifiers(f.type));
    for (const p of own.params ?? []) pending.push(...extractTypeIdentifiers(p.type));
    if (own.returns) pending.push(...extractTypeIdentifiers(own.returns));
  }
  return new Set(firstSegments(refs));
}

/** One method's parameter names as the pin records them, with each one's rename trace. */
function pinnedParams(method: SurfaceContractEntry['methods'][number]): { name: string; previous: string[] }[] {
  return (method.params ?? []).map((p) => ({ name: p.name, previous: (p as { previousNames?: string[] }).previousNames ?? [] }));
}

/** How a binding's parameter list differs from the pinned method's; empty when it agrees. */
function paramDrift(where: string, params: string[], method: SurfaceContractEntry['methods'][number]): string[] {
  const pinned = pinnedParams(method);
  if (params.length !== pinned.length) {
    return [`"${where}" takes ${params.length} parameter(s) (${params.map((p) => p || '{…}').join(', ') || 'none'}), the pin's "${method.name}" takes ${pinned.length} (${pinned.map((p) => p.name).join(', ') || 'none'})`];
  }
  const out: string[] = [];
  params.forEach((name, i) => {
    if (name === '' || nameKey(name) === nameKey(pinned[i].name)) return;
    out.push(pinned[i].previous.some((prev) => nameKey(prev) === nameKey(name))
      ? `parameter "${name}" of "${where}" was renamed to "${pinned[i].name}" — follow the rename`
      : `parameter ${i + 1} of "${where}" is "${name}", the pin's is "${pinned[i].name}"`);
  });
  return out;
}

/** Whether a pinned entry's retired list (a verb the producer removed since an earlier pin) holds a name. */
function retiredIn(entry: PinnedEntry, key: string): boolean {
  return (entry.entry.retired ?? []).some((r) => nameKey(r) === key);
}

/**
 * Compare one method member (or exported function) with a reached interface's
 * methods, under `method` when a tag names the one it mirrors.
 */
function methodDrift(where: string, params: string[], entry: PinnedEntry, reportMissing: boolean, method?: string): string[] {
  const key = nameKey(method ?? where);
  const current = entry.entry.methods.find((m) => nameKey(m.name) === key);
  if (current) return paramDrift(where, params, current);
  const renamed = entry.entry.methods.find((m) => (m.formerly ?? []).some((f) => nameKey(f) === key));
  if (renamed) return [`"${method ?? where}" was renamed to "${renamed.name}" in ${entry.alias}::${entry.entry.id} — follow the rename`];
  if (retiredIn(entry, key)) return [`"${method ?? where}" was removed from ${entry.alias}::${entry.entry.id} (an earlier pin held it) — drop it from the binding, and the calls that use it`];
  return reportMissing
    ? [`"${method ?? where}" is not exported by ${entry.alias}::${entry.entry.id} (it holds ${entry.entry.methods.map((m) => `"${m.name}"`).join(', ') || 'no methods'})`]
    : [];
}

/** The renamed type a type name in a binding still spells: one whose former id or name it is, and no reached type's current one. */
function formerType(name: string, types: PinnedType[]): PinnedType | undefined {
  const key = nameKey(name);
  // A name a reached type holds now — its id, or the display name code is
  // written by (rename_type leaves it to the author) — is current. A binding
  // that means the RETIRED id names it by tag, which matchOf reads first.
  if (types.some((t) => nameKey(t.def.id) === key || nameKey(t.def.name) === key)) return undefined;
  return types.find((t) => (t.def.formerly ?? []).some((f) => nameKey(f) === key));
}

/** Compare a declaration's fields with a reached type's: their names, and the type names they are declared with. */
function fieldDrift(members: BindingMember[], type: PinnedType, types: PinnedType[]): string[] {
  if (type.def.holds !== undefined || type.def.kind === 'enum' || type.def.kind === 'signature') return [];
  const fields = type.def.fields;
  const out: string[] = [];
  const explained = new Set<string>();
  for (const member of members.filter((m) => m.params === undefined)) {
    const key = nameKey(member.name);
    if (!fields.some((f) => nameKey(f.name) === key)) {
      const renamed = fields.find((f) => (f.formerly ?? []).some((prev) => nameKey(prev) === key));
      if (renamed) {
        explained.add(renamed.name);
        out.push(`field "${member.name}" was renamed to "${renamed.name}" — follow the rename`);
      } else {
        out.push(`field "${member.name}" is not in the pinned type`);
      }
    }
  }
  out.push(...fieldTypeDrift(members, types));
  const held = new Set(members.map((m) => nameKey(m.name)));
  for (const field of fields) {
    if (!held.has(nameKey(field.name)) && !explained.has(field.name)) out.push(`the pinned type has field "${field.name}" the binding does not declare`);
  }
  return out;
}

/** Each field declared with a type name the producer renamed (a reached type's former id or name), with the new name. */
function fieldTypeDrift(members: BindingMember[], types: PinnedType[]): string[] {
  const out: string[] = [];
  for (const member of members) {
    for (const name of new Set(member.type?.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
      const renamedType = formerType(name, types);
      if (renamedType) out.push(`field "${member.name}" is typed "${name}", which ${renamedType.alias}::${renamedType.def.id} was renamed from ("${renamedType.def.name}" now) — follow the rename`);
    }
  }
  return out;
}

/** The reached interface or type a declaration mirrors, if any. */
function matchOf(decl: BindingDeclaration, entries: PinnedEntry[], types: PinnedType[], tagAlias: (alias: string) => string): { entry?: PinnedEntry; type?: PinnedType; renamedType?: PinnedType } {
  // Its doc comment's alias::name first: the author's own word.
  if (decl.tag) {
    const [rawAlias, rawName] = decl.tag.split('::');
    const alias = tagAlias(rawAlias);
    const name = rawName.split('.')[0];
    const entry = entries.find((e) => e.alias === alias && (nameKey(e.entry.id) === nameKey(name) || nameKey(e.entry.name) === nameKey(name)));
    if (entry) return { entry };
    // A tag names a public name or type id: the id first, then a former id (the
    // type under its retired name), and a display name only when neither does.
    const byId = types.find((t) => t.alias === alias && nameKey(t.def.id) === nameKey(name));
    if (byId) return { type: byId };
    const renamed = types.find((t) => t.alias === alias && (t.def.formerly ?? []).some((f) => nameKey(f) === nameKey(name)));
    if (renamed) return { renamedType: renamed };
    const byName = types.find((t) => t.alias === alias && nameKey(t.def.name) === nameKey(name));
    if (byName) return { type: byName };
  }
  const methods = decl.members.filter((m) => m.params !== undefined);
  const byName = stem(decl.name);
  const entryByName = entries.find((e) => stem(e.entry.id) === byName || stem(e.entry.name) === byName);
  const typeByName = types.find((t) => nameKey(t.def.id) === nameKey(decl.name) || nameKey(t.def.name) === nameKey(decl.name));
  if (methods.length > 0 && entryByName) return { entry: entryByName };
  if (typeByName && decl.kind !== 'function') return { type: typeByName };
  if (entryByName && decl.kind !== 'function' && decl.kind !== 'alias' && decl.kind !== 'enum') return { entry: entryByName };
  // A type the producer renamed, still declared under its former name.
  const renamedType = decl.kind !== 'function' ? formerType(decl.name, types) : undefined;
  if (renamedType) return { renamedType };
  // An interface by the reached interface most of its methods (current or former names) belong to.
  if (methods.length === 0) return {};
  const scored = entries.map((e) => ({
    e,
    score: methods.filter((m) => e.entry.methods.some((pm) => nameKey(pm.name) === nameKey(m.name) || (pm.formerly ?? []).some((f) => nameKey(f) === nameKey(m.name)))
      || retiredIn(e, nameKey(m.name))).length,
  })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0 || best.score * 2 < methods.length) return {};
  if (scored[1] && scored[1].score === best.score) return {};
  return { entry: best.e };
}

/** Every difference between one declaration and what it mirrors; empty when it agrees or mirrors nothing. */
function declarationDrift(decl: BindingDeclaration, entries: PinnedEntry[], types: PinnedType[], tagAlias: (alias: string) => string): { against?: string; drift: string[] } {
  if (decl.kind === 'function') {
    // A tagged function: against its tagged interface alone, a missing verb named.
    if (decl.tag) {
      const [rawAlias, rawName] = decl.tag.split('::');
      const [name, method] = rawName.split('.');
      const entry = entries.find((e) => e.alias === tagAlias(rawAlias) && (nameKey(e.entry.id) === nameKey(name) || nameKey(e.entry.name) === nameKey(name)));
      if (entry) return { against: `${entry.alias}::${entry.entry.id}`, drift: methodDrift(decl.name, decl.params ?? [], entry, true, method) };
    }
    // An exported function: against every reached method of that name (or former, or retired name).
    for (const entry of entries) {
      const drift = methodDrift(decl.name, decl.params ?? [], entry, false);
      if (drift.length > 0 || entry.entry.methods.some((m) => nameKey(m.name) === nameKey(decl.name))) {
        return { against: `${entry.alias}::${entry.entry.id}`, drift };
      }
    }
    return { drift: [] };
  }
  const match = matchOf(decl, entries, types, tagAlias);
  if (match.entry) {
    const drift = decl.members.filter((m) => m.params !== undefined).flatMap((m) => methodDrift(m.name, m.params!, match.entry!, true));
    return { against: `${match.entry.alias}::${match.entry.entry.id}`, drift };
  }
  const type = match.type ?? match.renamedType;
  if (type) {
    // A declaration still named by the type's former name says the new one.
    const renamedFrom = formerType(decl.name, [type]) ?? (match.renamedType ? type : undefined);
    // The new name as the producer spells it now: its display name, else (a display name kept through the rename) its id.
    const now = nameKey(type.def.name) === nameKey(decl.name) ? type.def.id : type.def.name;
    const named = renamedFrom ? [`the type "${decl.name}" was renamed to "${now}" (${type.alias}::${type.def.id}) — follow the rename`] : [];
    const drift = decl.kind === 'alias' || decl.kind === 'enum' ? named : [...named, ...fieldDrift(decl.members, type, types)];
    return { against: `${type.alias}::${type.def.id}`, drift };
  }
  // The binding's own plumbing is never judged — but a field of it typed by a
  // type the producer renamed still spells the old name.
  if (decl.kind === 'alias' || decl.kind === 'enum') return { drift: [] };
  const typed = fieldTypeDrift(decl.members, types);
  const renamed = typed.length > 0 ? types.find((t) => typed[0].includes(`which ${t.alias}::${t.def.id} `)) : undefined;
  return renamed ? { against: `${renamed.alias}::${renamed.def.id}`, drift: typed } : { drift: [] };
}

/** The projects one module's implementations reach, sorted by how they can be compared. */
interface Reach {
  /** Pinned externals: alias → snapshot. */
  pins: RuleContext['pinnedExternals'];
  /** Contained members, under the alias the root declares them by, with what they export now. */
  members: { alias: string; node: ProjectNode; surface: { entries: PinnedEntry[]; types: PinnedType[] } }[];
  /** Declared externals with no pin held. */
  unpinned: string[];
}

/** Classify every reached segment: a pinned external, a contained member, a declared external without a pin; anything else (a subsystem qualifier) is local. */
function reachOf(ctx: RuleContext, segments: Set<string>): Reach {
  const pins = ctx.pinnedExternals.filter((p) => segments.has(p.alias) && p.snapshot);
  const members: Reach['members'] = [];
  const unpinned: string[] = [];
  const externals = new Set((boundRoot(ctx)?.imports ?? []).filter((i) => i.section === 'externals').map((i) => i.alias));
  for (const segment of segments) {
    if (pins.some((p) => p.alias === segment)) continue;
    const node = memberNode(ctx, segment);
    if (node) {
      const alias = node.mountAlias ?? segment;
      if (members.some((m) => m.node === node) || pins.some((p) => p.alias === alias)) continue;
      members.push({ alias, node, surface: memberSurface(ctx, node, alias) });
      continue;
    }
    if (externals.has(segment)) unpinned.push(segment);
  }
  return { pins, members, unpinned };
}

/** Why a module cannot be compared, in words; null when it can. */
function unreadReason(module: BindingModule, reach: Reach): string | null {
  switch (module.status) {
    case 'missing': return 'it is not on disk yet (planned)';
    case 'escaped': return 'it is absolute or escapes the project root, so it is never read';
    case 'unreadable': return 'it cannot be read as text';
    case 'unsupported': return 'it is not TypeScript or JavaScript, the languages binding conformance reads';
    default: break;
  }
  if (module.declarations.length === 0) {
    const forms = module.unreadForms ?? [];
    return `it declares no exported function, interface, class, type, enum or CommonJS export the reader compares${forms.length
      ? ` — it exports through ${forms.map((f) => `\`${f}\``).join(', ')}, which the reader cannot see into: declare the producer's names in the binding itself (\`export interface …\`, \`exports.X = { … }\`) so they can be compared`
      : ''}`;
  }
  const exporting = reach.members.filter((m) => m.surface.entries.length + m.surface.types.length > 0);
  if (reach.pins.length > 0 || exporting.length > 0) return null;
  const why: string[] = [];
  for (const m of reach.members) {
    const id = m.node.id ?? m.node.namespace;
    why.push(`the member project "${m.alias}"${id !== m.alias ? ` (${id})` : ''} it reaches exports nothing in its L0 export table — a member is read live and never pinned, so export what the binding mirrors there`);
  }
  for (const alias of reach.unpinned) why.push(`no pinned snapshot is held for the external "${alias}" — pin it (\`wairon externals pin ${alias}\`)`);
  return why.length > 0 ? why.join('; ') : 'the components of the implementations naming it reach no other project (`alias::name`)';
}

export const bindingModulesRule: SddRule = {
  name: 'binding-modules',
  judges: 'code',
  description: "Code-to-pin for a consumer's hand-written binding module (implementation_spec.bindings): the one file where the consumer's code spells another project's names is compared with what the projects the implementation's component reaches publish, so a re-pin (or a member's edit) that renamed, removed or reshaped a name the binding still declares is reported instead of surviving tsc and the tests on the binding's own stale declarations. A component reaches a project through every `alias::name` its specs write: a dependsOn, owns, narrative or declared call, an implements, and every named type its contract's params and returns write, directly or through the bound project's own types they name (so a binding to a types-only contracts library is reached by the types a contract names). A pinned external is compared with its pinned snapshot. A contained MEMBER project (an alias the bound root declares under `members` — named by that alias or by the member's project id — read live and never pinned) is compared the same way against what its L0 export table exports now: each exported contract's methods with their params and rename traces, each exported type's fields with theirs (a type its exports name that another project owns is that project's, compared and named under the alias the bound root reaches it by, never the member's), so a parameter, field or method rename in a member reaches a member consumer at validate time, with the rename to follow. Each binding declaration is matched to a reached interface or type by the `alias::name` its doc comment names (a public name or type id, never a display name: a tag naming a type's former id is that type under its retired name), else by name (nameKey of the interface's id or name, a type's id or name, with an Api/Port/Client suffix ignored), else — for an interface with methods — by the reached interface most of its member names belong to (a trace in `formerly` counts); an exported function is matched by name against the methods of every reached interface, or, when its doc comment names `alias::name` (or `alias::name.method`), against that interface alone. A matched member that is a former name is reported with the rename to follow; a member of a matched interface it does not hold, a function its tagged interface no longer holds, and a function or member a pinned entry's `retired` list names (a method the producer removed since an earlier pin) are reported removed; a parameter list whose arity or names differ from the method's (a param's previousNames giving the rename) is reported; a type declaration is compared field by field — a field the matched type does not declare (a field's `formerly` giving the rename), a field it declares that the binding lacks, a declaration still named by the type's former name, and a field whose declared type names a type the producer renamed are each reported with the new name. Names compare by nameKey, so snake_case and camelCase spellings of one name agree. A declaration nothing matches is the binding's own plumbing and is never judged. A binding that cannot be read, is not TypeScript or JavaScript, declares nothing the reader compares (naming each export form it met but cannot see into, such as a CommonJS `module.exports = require(…)`), or whose component reaches neither a pinned external nor a member project is reported once as unread — a member is named as a member (one that exports nothing is told to export there), and pinning is suggested only for a declared external, never for a member — a notice, so a planned binding passes a design-only gate.",
  codes: [
    { code: 'BINDING_DRIFT', defaultSeverity: 'warning', summary: 'A binding module declares a producer name its pin (or a member project\'s live export) renamed (with the rename to follow) or removed, a parameter list that differs from the method\'s, or a type whose name or fields differ from the producer\'s type — code calling into another project through a shape the producer no longer has' },
    { code: 'BINDING_UNREAD', defaultSeverity: 'notice', summary: 'A binding module an implementation names could not be compared: it is not on disk yet, escapes the root, cannot be read, is in a language the reader does not read, declares nothing the reader compares (naming the export forms it cannot see into), or its component reaches neither a pinned external nor a member project that exports something' },
  ],

  check(ctx: RuleContext): void {
    const modules = ctx.bindingModules ?? [];
    if (modules.length === 0) return;
    const own = ctx.implementations.filter((impl) => !impl.id.includes('::'));
    // Step 1: each module, the implementations naming it and the projects they reach.
    for (const module of modules) {
      const naming = own.filter((impl) => (impl.bindings ?? []).some((b) => b.replace(/\\/g, '/') === module.path));
      if (naming.length === 0) continue;
      const anchor = naming[0];
      const draft = ctx.isImplementationDraft(anchor);
      const reach = reachOf(ctx, new Set(naming.flatMap((impl) => [...reachedSegments(ctx, impl)])));
      // Steps 2-3: unread, once per module.
      const reason = unreadReason(module, reach);
      if (reason !== null) {
        ctx.addIssue('notice', 'BINDING_UNREAD',
          `Binding module "${module.path}" (named by implementation "${anchor.id}") is not compared: ${reason}.`,
          anchor.id, draft, undefined, { at: module.path });
        continue;
      }
      // Step 4: what the reached projects publish.
      const entries: PinnedEntry[] = [
        ...reach.pins.flatMap((p) => p.snapshot!.interfaces.map((entry) => ({ alias: p.alias, entry }))),
        ...reach.members.flatMap((m) => m.surface.entries),
      ];
      const types: PinnedType[] = [
        ...reach.pins.flatMap((p) => p.snapshot!.types.map((def) => ({ alias: p.alias, def }))),
        ...reach.members.flatMap((m) => m.surface.types),
      ];
      // Compared live: every alias a member surface spoke for — the member's own, and each project owning a type it names.
      const live = new Set(reach.members.flatMap((m) => [m.alias, ...m.surface.types.map((t) => t.alias)]));
      // A tag names a project by its alias, or a member by its project id.
      const tagAlias = (alias: string): string => {
        if (reach.pins.some((p) => p.alias === alias)) return alias;
        return reach.members.find((m) => m.alias === alias || m.node.namespace === alias || m.node.id === alias)?.alias ?? alias;
      };
      // Steps 5-7: each declaration against what it mirrors.
      for (const decl of module.declarations) {
        const { against, drift } = declarationDrift(decl, entries, types, tagAlias);
        if (drift.length === 0) continue;
        // Compared with a member's live export, never a pin: said so, and the fix follows it.
        const member = against !== undefined && live.has(against.slice(0, against.indexOf('::')));
        ctx.addIssue('warning', 'BINDING_DRIFT',
          `Binding module "${module.path}" line ${decl.line}: "${decl.name}" no longer matches ${against} ${member ? 'as its member project exports it now' : 'as pinned'} — ${drift.join('; ')}. `
          + 'The code calling the producer through this binding still compiles against the binding\'s own declarations, so nothing else will notice until it meets the real library: '
          + `update the binding to ${member ? 'the member\'s export' : 'the pin'}, then the calls that use it.`,
          anchor.id, draft, undefined, { at: `${module.path}#${decl.name}` });
      }
    }
    // Step 9: judged.
  },
};
