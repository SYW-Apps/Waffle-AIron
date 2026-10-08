import { nameKey, qualifiedTypeId } from '../../../models/type-references.js';
import type { ImplementationSpec, SurfaceContractEntry, SurfaceTypeDef } from '../../../models/specs.js';
import type { BindingDeclaration, BindingMember, BindingModule } from '../../binding-modules.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔pin for a consumer's hand-written BINDING MODULE
// (implementation_spec.bindings): the one file where the consumer's code
// spells another project's names. Everything else the consumer writes calls
// the binding, so tsc and the tests stay green on the binding's own stale
// declarations after a re-pin — a renamed verb, a removed one, a renamed
// parameter or field all survive until the code meets the real library.
//
// The rule compares the binding's exported declarations with the pinned
// snapshots of the externals the naming implementations' components reach:
// a method or function name, its parameters' arity and names, a type's field
// names — all by nameKey, so `tile_at` and `tileAt` are one name. The
// snapshot's rename traces (`formerly`, a param's `previousNames`) turn a
// mismatch into the rename to follow. A declaration nothing in the pin
// matches is the binding's own plumbing (a loader, an aggregate handle) and
// is never judged. Pure: the validator reads the modules (binding module
// adapter) and the pins; this rule does no I/O.
//
// A MEMBER project is never pinned — the family reads it live — so a binding
// into a member is compared with what the member's L0 export table exports
// now, built from the member's specs this scan already loaded: the same
// shapes as a snapshot's, carrying the same rename traces (a method's and a
// param's previousNames, a field's). A parameter or field renamed in a member
// therefore reaches a member consumer at validate time, with the rename to
// follow, as it reaches a pinned consumer at re-pin.
// ---------------------------------------------------------------------------

/** A pinned interface or type, under the alias it is pinned for (or a member's, read live). */
interface PinnedEntry { alias: string; entry: SurfaceContractEntry }
interface PinnedType { alias: string; def: SurfaceTypeDef }

/** A former name as a trace records it: `<interface>.<method>` for a method, the bare name otherwise. */
const lastSegment = (key: string): string => key.slice(key.lastIndexOf('.') + 1);

/**
 * The surface a member project of the bound root exports now, under the alias
 * its parent declares it by, in a snapshot's shapes: each component its L0
 * table exports with its contract methods (narrowed to the exported
 * interface), each exported type with its fields — every one with its rename
 * trace. Null when the alias names no member of the bound root.
 */
function memberSurface(ctx: RuleContext, alias: string): { entries: PinnedEntry[]; types: PinnedType[] } | null {
  const node = ctx.projectFamily?.nodes.find((n) => n.parent === '' && n.mountAlias === alias);
  if (!node) return null;
  const table = (ctx.exportTables ?? []).find((t) => t.level === 'project' && t.owner === node.namespace);
  if (!table) return null;
  const entries: PinnedEntry[] = [];
  const types: PinnedType[] = [];
  for (const e of table.entries) {
    if (e.kind === 'component' && e.component) {
      const contracts = (ctx.interfacesByComponent.get(e.component) ?? [])
        .filter((i) => !e.interface || i.id === e.interface || i.id.endsWith(`::${e.interface}`));
      const methods = contracts.flatMap((i) => i.methods).map((m) => ({
        ...m,
        formerly: (m.previousNames ?? []).map(lastSegment),
      }));
      entries.push({ alias, entry: { id: e.publicName, name: e.publicName, component: e.component, methods } as unknown as SurfaceContractEntry });
    } else if (e.kind === 'type' && e.typeDef) {
      const type = ctx.types.find((t) => qualifiedTypeId(t) === e.typeDef || t.id === e.typeDef);
      if (!type) continue;
      types.push({
        alias,
        def: {
          id: e.publicName,
          name: type.name,
          kind: type.kind ?? 'value-object',
          ...(type.holds !== undefined ? { holds: type.holds } : {}),
          fields: (type.fields ?? []).map((f) => ({ name: f.name, type: f.type, ...(f.previousNames?.length ? { formerly: f.previousNames } : {}) })),
          formerly: (type.previousIds ?? []).map(lastSegment),
        } as unknown as SurfaceTypeDef,
      });
    }
  }
  return { entries, types };
}

/** nameKey with a trailing Api, Port or Client dropped: `TilesApi` and `Tiles API` are the pin's `tiles`. */
function stem(name: string): string {
  return nameKey(name).replace(/(?:api|port|client)$/, '') || nameKey(name);
}

/** The aliases a component reaches through `alias::name`: a dependsOn, owns, narrative or declared call, an implements. */
function reachedAliases(ctx: RuleContext, impl: ImplementationSpec): Set<string> {
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
  const aliases = new Set<string>();
  for (const ref of refs) {
    const cut = ref.indexOf('::');
    if (cut > 0) aliases.add(ref.slice(0, cut));
  }
  return aliases;
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

/** Compare one method member (or exported function) with a pinned interface's methods. */
function methodDrift(where: string, params: string[], entry: PinnedEntry, reportMissing: boolean): string[] {
  const key = nameKey(where);
  const current = entry.entry.methods.find((m) => nameKey(m.name) === key);
  if (current) return paramDrift(where, params, current);
  const renamed = entry.entry.methods.find((m) => (m.formerly ?? []).some((f) => nameKey(f) === key));
  if (renamed) return [`"${where}" was renamed to "${renamed.name}" in ${entry.alias}::${entry.entry.id} — follow the rename`];
  return reportMissing
    ? [`"${where}" is not exported by ${entry.alias}::${entry.entry.id} any more (the pin holds ${entry.entry.methods.map((m) => `"${m.name}"`).join(', ') || 'no methods'})`]
    : [];
}

/** Compare a declaration's fields with a pinned type's. */
function fieldDrift(members: BindingMember[], type: PinnedType): string[] {
  if (type.def.holds !== undefined || type.def.kind === 'enum' || type.def.kind === 'signature') return [];
  const fields = type.def.fields;
  const out: string[] = [];
  const explained = new Set<string>();
  for (const member of members.filter((m) => m.params === undefined)) {
    const key = nameKey(member.name);
    if (fields.some((f) => nameKey(f.name) === key)) continue;
    const renamed = fields.find((f) => (f.formerly ?? []).some((prev) => nameKey(prev) === key));
    if (renamed) {
      explained.add(renamed.name);
      out.push(`field "${member.name}" was renamed to "${renamed.name}" — follow the rename`);
    } else {
      out.push(`field "${member.name}" is not in the pinned type`);
    }
  }
  const held = new Set(members.map((m) => nameKey(m.name)));
  for (const field of fields) {
    if (!held.has(nameKey(field.name)) && !explained.has(field.name)) out.push(`the pinned type has field "${field.name}" the binding does not declare`);
  }
  return out;
}

/** The pinned interface or type a declaration mirrors, if any. */
function matchOf(decl: BindingDeclaration, entries: PinnedEntry[], types: PinnedType[]): { entry?: PinnedEntry; type?: PinnedType; renamedType?: PinnedType } {
  // Its doc comment's alias::name first: the author's own word.
  if (decl.tag) {
    const [alias, name] = decl.tag.split('::');
    const entry = entries.find((e) => e.alias === alias && (nameKey(e.entry.id) === nameKey(name) || nameKey(e.entry.name) === nameKey(name)));
    if (entry) return { entry };
    const type = types.find((t) => t.alias === alias && (nameKey(t.def.id) === nameKey(name) || nameKey(t.def.name) === nameKey(name)));
    if (type) return { type };
  }
  const methods = decl.members.filter((m) => m.params !== undefined);
  const byName = stem(decl.name);
  const entryByName = entries.find((e) => stem(e.entry.id) === byName || stem(e.entry.name) === byName);
  const typeByName = types.find((t) => nameKey(t.def.id) === nameKey(decl.name) || nameKey(t.def.name) === nameKey(decl.name));
  if (methods.length > 0 && entryByName) return { entry: entryByName };
  if (typeByName && decl.kind !== 'function') return { type: typeByName };
  if (entryByName && decl.kind !== 'function' && decl.kind !== 'alias' && decl.kind !== 'enum') return { entry: entryByName };
  // A type the pin renamed, still declared under its former name.
  const renamedType = types.find((t) => (t.def.formerly ?? []).some((f) => nameKey(f) === nameKey(decl.name)));
  if (renamedType) return { renamedType };
  // An interface by the pinned interface most of its methods (current or former names) belong to.
  if (methods.length === 0) return {};
  const scored = entries.map((e) => ({
    e,
    score: methods.filter((m) => e.entry.methods.some((pm) => nameKey(pm.name) === nameKey(m.name) || (pm.formerly ?? []).some((f) => nameKey(f) === nameKey(m.name)))).length,
  })).sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score === 0 || best.score * 2 < methods.length) return {};
  if (scored[1] && scored[1].score === best.score) return {};
  return { entry: best.e };
}

/** Every difference between one declaration and the pin; empty when it agrees or mirrors nothing. */
function declarationDrift(decl: BindingDeclaration, entries: PinnedEntry[], types: PinnedType[]): { against?: string; drift: string[] } {
  if (decl.kind === 'function') {
    // An exported function: against every pinned method of that name (or former name).
    for (const entry of entries) {
      const drift = methodDrift(decl.name, decl.params ?? [], entry, false);
      if (drift.length > 0 || entry.entry.methods.some((m) => nameKey(m.name) === nameKey(decl.name))) {
        return { against: `${entry.alias}::${entry.entry.id}`, drift };
      }
    }
    return { drift: [] };
  }
  const match = matchOf(decl, entries, types);
  if (match.entry) {
    const drift = decl.members.filter((m) => m.params !== undefined).flatMap((m) => methodDrift(m.name, m.params!, match.entry!, true));
    return { against: `${match.entry.alias}::${match.entry.entry.id}`, drift };
  }
  if (match.type) {
    const drift = decl.kind === 'alias' || decl.kind === 'enum' ? [] : fieldDrift(decl.members, match.type);
    return { against: `${match.type.alias}::${match.type.def.id}`, drift };
  }
  if (match.renamedType) {
    return {
      against: `${match.renamedType.alias}::${match.renamedType.def.id}`,
      drift: [`the type "${decl.name}" was renamed to "${match.renamedType.def.name}" — follow the rename`],
    };
  }
  return { drift: [] };
}

/** Why a module cannot be compared, in words. */
function unreadReason(module: BindingModule, reached: Set<string>, compared: string[]): string | null {
  switch (module.status) {
    case 'missing': return 'it is not on disk yet (planned)';
    case 'escaped': return 'it is absolute or escapes the project root, so it is never read';
    case 'unreadable': return 'it cannot be read as text';
    case 'unsupported': return 'it is not TypeScript or JavaScript, the languages binding conformance reads';
    default: break;
  }
  if (compared.length > 0) return null;
  return reached.size === 0
    ? 'the components of the implementations naming it reach no other project (`alias::name`)'
    : `no pinned snapshot is held for ${[...reached].map((a) => `"${a}"`).join(', ')} — pin it (\`wairon externals pin\`)`;
}

export const bindingModulesRule: SddRule = {
  name: 'binding-modules',
  judges: 'code',
  description: "Code-to-pin for a consumer's hand-written binding module (implementation_spec.bindings): the one file where the consumer's code spells another project's names is compared with the pinned snapshots of the externals the implementation's component reaches, so a re-pin that renamed, removed or reshaped a name the binding still declares is reported instead of surviving tsc and the tests on the binding's own stale declarations. A member project the component reaches (an alias the bound root declares under `members`, which is read live and never pinned) is compared the same way against what its L0 export table exports now — each exported contract's methods with their params and rename traces, each exported type's fields with theirs — so a parameter, field or method rename in a member reaches a member consumer at validate time, with the rename to follow, as a pinned consumer is told at re-pin. Each binding declaration is matched to a pinned interface or type by the `alias::name` its doc comment names, else by name (nameKey of the interface's id or name, a type's id or name, with an Api/Port/Client suffix ignored), else — for an interface with methods — by the pinned interface most of its member names belong to (a trace in `formerly` counts); an exported function is matched by name against the methods of every pinned interface. A matched member that is a pinned name's former name is reported with the rename to follow; a member of a matched interface the pin does not export, a parameter list whose arity or names differ from the pinned method's (a param's previousNames giving the rename), and a field the matched pinned type does not declare (a field's `formerly` giving the rename) or a pinned field the binding lacks are reported. Names compare by nameKey, so snake_case and camelCase spellings of one name agree. A declaration nothing matches is the binding's own plumbing and is never judged. A binding that cannot be read, is not TypeScript or JavaScript, or whose implementation's component reaches neither a pinned external nor a member project is reported once as unread — a notice, so a planned binding passes a design-only gate.",
  codes: [
    { code: 'BINDING_DRIFT', defaultSeverity: 'warning', summary: 'A binding module declares a producer name its pin (or a member project\'s live export) renamed (with the rename to follow) or no longer exports, a parameter list that differs from the pinned method\'s, or fields that differ from the pinned type\'s — code calling into another project through a shape the pin no longer has' },
    { code: 'BINDING_UNREAD', defaultSeverity: 'notice', summary: 'A binding module an implementation names could not be compared with a pin: it is not on disk yet, escapes the root, cannot be read, is in a language the reader does not read, or its component reaches neither a pinned external nor a member project' },
  ],

  check(ctx: RuleContext): void {
    const modules = ctx.bindingModules ?? [];
    if (modules.length === 0) return;
    const own = ctx.implementations.filter((impl) => !impl.id.includes('::'));
    // Step 1: each module, the implementations naming it and the aliases they reach.
    for (const module of modules) {
      const naming = own.filter((impl) => (impl.bindings ?? []).some((b) => b.replace(/\\/g, '/') === module.path));
      if (naming.length === 0) continue;
      const anchor = naming[0];
      const draft = ctx.isImplementationDraft(anchor);
      const reached = new Set(naming.flatMap((impl) => [...reachedAliases(ctx, impl)]));
      const pins = ctx.pinnedExternals.filter((p) => reached.has(p.alias) && p.snapshot);
      // A member project reached: its live export table, never a pin.
      const members = [...reached]
        .filter((alias) => !pins.some((p) => p.alias === alias))
        .map((alias) => ({ alias, surface: memberSurface(ctx, alias) }))
        .filter((m): m is { alias: string; surface: { entries: PinnedEntry[]; types: PinnedType[] } } => m.surface !== null);
      const live = new Set(members.map((m) => m.alias));
      // Steps 2-3: unread, once per module.
      const reason = unreadReason(module, reached, [...pins.map((p) => p.alias), ...live]);
      if (reason !== null) {
        ctx.addIssue('notice', 'BINDING_UNREAD',
          `Binding module "${module.path}" (named by implementation "${anchor.id}") is not compared with any pin: ${reason}.`,
          anchor.id, draft, undefined, { at: module.path });
        continue;
      }
      // Step 4: what the pins hold.
      const entries: PinnedEntry[] = [
        ...pins.flatMap((p) => p.snapshot!.interfaces.map((entry) => ({ alias: p.alias, entry }))),
        ...members.flatMap((m) => m.surface.entries),
      ];
      const types: PinnedType[] = [
        ...pins.flatMap((p) => p.snapshot!.types.map((def) => ({ alias: p.alias, def }))),
        ...members.flatMap((m) => m.surface.types),
      ];
      // Steps 5-7: each declaration against what it mirrors.
      for (const decl of module.declarations) {
        const { against, drift } = declarationDrift(decl, entries, types);
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
