// ---------------------------------------------------------------------------
// design_exporter — the design export projector (sdd_surfaces).
//
// Projects the bound project's loaded, resolved spec tree into one DesignExport:
// every subsystem, component, interface, implementation and type keyed and
// resolved, the export tables resolved, the dependencies listed, and the source
// stamped with the tree's StateId and the approval state the CALLER decided
// (docs/design/generic-design-model/stage-4-5-export.md).
//
// A projector: stateless, reads only through the surfaces core adapter, writes
// nothing. Deterministic: object keys sorted, element lists sorted by key, inner
// lists in declared order, no timestamp — the same tree and verdict give
// byte-identical JSON whatever order the spec files sit in on disk.
// ---------------------------------------------------------------------------

import { WAIRON_VERSION } from '../config/defaults.js';
import { compareOrdinal } from '../utils/canonical-json.js';
import {
  DESIGN_FORMAT,
  DESIGN_FORMAT_VERSION,
  canonicalTypeText,
  effectiveDetail,
  effectiveProjectId,
  parseTypeExpression,
  qualifiedTypeId,
  technologyName,
  typeMatchesRef,
  type BoundaryItem,
  type ComponentSpec,
  type DesignApproval,
  type DesignComponent,
  type DesignDependency,
  type DesignExport,
  type DesignExportEntry,
  type DesignImplementation,
  type DesignInterface,
  type DesignMethod,
  type DesignMethodBody,
  type DesignParam,
  type DesignSubsystem,
  type DesignType,
  type DesignTypeRef,
  type ExternalBinding,
  type ExternalsLock,
  type ImplementationSpec,
  type ProjectFamily,
  type InterfaceSpec,
  type MethodParam,
  type NarrativeStep,
  type RequirementItem,
  type ResolvedExport,
  type SubsystemSpec,
  type SystemSpec,
  type TypeExpression,
  type TypePosition,
  type TypeSpec,
} from '../models/index.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  loadTypeSpecs,
  resolveProjectExports,
  resolveSubsystemExports,
  loadProjectConfig,
  resolveExternals,
  computeStateId,
  projectFamily,
} from './adapters/surfaces-core.js';
// externals_repository: the pinned digest of each dependency (the externals lock).
import { externalsRepository } from './externals.js';

/** Refusal raised when the tree has no L0 to export (`no-system`). */
export class NoSystemSpecError extends Error {
  readonly code = 'no-system';
  constructor() {
    super('no-system: the tree has no L0 system spec to export (.wai/specs holds no system spec).');
    this.name = 'NoSystemSpecError';
  }
}

/** A loaded spec of the bound project itself: a member project's specs arrive namespaced (`ns::id`) and are a dependency, never inlined. */
const isOwn = (spec: { id: string }): boolean => !spec.id.includes('::');

/** Ordinal order by key — the one order every element list is written in. */
const byKey = <T extends { key: string }>(a: T, b: T): number => compareOrdinal(a.key, b.key);

/**
 * One direct project member's published names: the bound key of every item
 * its L0 exports (as the loader keys a reference into it) mapped to the
 * stable `alias::publicName` a consumer resolves.
 */
export interface MemberPublicNames {
  alias: string;
  projectId: string;
  names: Map<string, string>;
  /** The member's public names the bound project's references reach, read off the project graph. */
  referenced?: string[];
}

/**
 * The keys and lookups one projection resolves references against: the
 * bound project's own components, interfaces and types, and the public names
 * of its direct members — a reference into another project is written as
 * `alias::publicName`, never as the loader's in-memory key.
 */
class KeyTable {
  private readonly components = new Set<string>();
  /** component key → the interfaces it declares. */
  private readonly interfacesOf = new Map<string, InterfaceSpec[]>();
  private readonly types: TypeSpec[];
  private readonly typeRefCache = new Map<string, string | null>();
  /** bound key → `alias::publicName`, over every direct member. */
  private readonly publicNames = new Map<string, string>();
  /** alias → the public names this projection wrote a reference to. */
  readonly used = new Map<string, Set<string>>();

  constructor(components: ComponentSpec[], interfaces: InterfaceSpec[], types: TypeSpec[], members: MemberPublicNames[] = []) {
    for (const m of members) for (const [bound, name] of m.names) if (!this.publicNames.has(bound)) this.publicNames.set(bound, name);
    for (const c of components) this.components.add(c.id);
    for (const i of [...interfaces].sort((a, b) => compareOrdinal(a.id, b.id))) {
      const list = this.interfacesOf.get(i.component) ?? [];
      list.push(i);
      this.interfacesOf.set(i.component, list);
    }
    this.types = [...types].sort((a, b) => compareOrdinal(qualifiedTypeId(a), qualifiedTypeId(b)));
  }

  /** A contract method's key: `<interface key>.<name>` on the first of the component's interfaces declaring it, else the name as written. */
  methodKey(component: string | undefined, method: string): string {
    if (!component) return method;
    const intf = (this.interfacesOf.get(component) ?? []).find((i) => i.methods.some((m) => m.name === method));
    return intf ? `${intf.id}.${method}` : method;
  }

  /** Whether `component.method` names a contract method of an own component — a method signature source. */
  isMethodSource(value: string): boolean {
    const dot = value.lastIndexOf('.');
    if (dot <= 0 || dot === value.length - 1) return false;
    const head = value.slice(0, dot);
    const tail = value.slice(dot + 1);
    return this.components.has(head) && (this.interfacesOf.get(head) ?? []).some((i) => i.methods.some((m) => m.name === tail));
  }

  /**
   * The key of the own type a written name resolves to — same subsystem first,
   * then system-level, then any, ordinal by key within a rank — or null when
   * no own type answers to it (a generic parameter, or a name in another project).
   */
  typeKey(name: string, owner?: string, kind?: TypeSpec['kind']): string | null {
    const cacheKey = `${owner ?? ''}|${kind ?? ''}|${name}`;
    if (this.typeRefCache.has(cacheKey)) return this.typeRefCache.get(cacheKey)!;
    const rank = (t: TypeSpec): number => (t.subsystem === owner ? 0 : t.subsystem === undefined ? 1 : 2);
    const hit = this.types
      .filter((t) => (kind === undefined || t.kind === kind) && (t.id === name || qualifiedTypeId(t) === name || typeMatchesRef(t, name)))
      .sort((a, b) => rank(a) - rank(b))[0];
    const key = hit ? qualifiedTypeId(hit) : null;
    this.typeRefCache.set(cacheKey, key);
    return key;
  }

  /** A reference to a type field (`Type.field`) or a type, resolved to its key; as written when it resolves to nothing. */
  typeFieldRef(ref: string, owner?: string): string {
    const whole = this.typeKey(ref, owner);
    if (whole) return whole;
    const dot = ref.lastIndexOf('.');
    if (dot > 0) {
      const head = this.typeKey(ref.slice(0, dot), owner);
      if (head) return `${head}.${ref.slice(dot + 1)}`;
      const outside = this.external(ref.slice(0, dot));
      if (outside !== ref.slice(0, dot)) return `${outside}.${ref.slice(dot + 1)}`;
    }
    return this.external(ref);
  }

  /**
   * A reference as a consumer resolves it: a bound key of an item a direct
   * member exports as `alias::publicName` (recorded as used), anything else as
   * written — an own key, an external's reference (already `alias::name`), or
   * one binding no exported name, which the gate reports.
   */
  external(ref: string): string {
    const name = this.publicNames.get(ref);
    if (name === undefined) return ref;
    const cut = name.indexOf('::');
    const alias = name.slice(0, cut);
    const set = this.used.get(alias) ?? new Set<string>();
    set.add(name.slice(cut + 2));
    this.used.set(alias, set);
    return name;
  }

  /** A component reference: an own component's key, or another project's item by its public name. */
  componentRef(ref: string): string {
    return this.components.has(ref) ? ref : this.external(ref);
  }
}

/** The parse of one position with each named member's name replaced by the key it resolves to. */
function resolveExpression(expr: TypeExpression, keys: KeyTable, owner?: string): TypeExpression {
  const args = expr.args.map((a) => resolveExpression(a, keys, owner));
  if ((expr.form === 'named' || expr.form === 'applied') && expr.name !== undefined) {
    return { form: expr.form, name: keys.typeKey(expr.name, owner) ?? keys.external(expr.name), args };
  }
  return expr.name !== undefined ? { form: expr.form, name: expr.name, args } : { form: expr.form, args };
}

/** Step 20: one type position as a DesignTypeRef — canonical text and the resolved parse, or the text alone when the grammar cannot read it. */
function typeRef(text: string, position: TypePosition, keys: KeyTable, owner?: string): DesignTypeRef {
  const parse = parseTypeExpression(text, position);
  if (!parse.expression) return { text };
  const expression = resolveExpression(parse.expression, keys, owner);
  return { text: canonicalTypeText(expression), expression };
}

function projectParams(params: MethodParam[] | undefined, position: TypePosition, keys: KeyTable, owner?: string): DesignParam[] {
  return (params ?? []).map((p) => ({
    name: p.name,
    type: typeRef(p.type, position, keys, owner),
    optional: p.optional === true,
    ...(p.description !== undefined ? { description: p.description } : {}),
    ...(p.previousNames && p.previousNames.length > 0 ? { formerly: [...p.previousNames] } : {}),
  }));
}

/** One row of a resolved export table, its target as a key. */
function exportEntry(e: ResolvedExport, keys: KeyTable): DesignExportEntry {
  const target = e.kind === 'type'
    ? { targetKind: 'type', target: keys.typeKey(String(e.typeDef), e.source) ?? keys.external(String(e.typeDef)) }
    : e.interface
      ? { targetKind: 'interface', target: keys.external(e.interface) }
      : { targetKind: 'component', target: keys.componentRef(String(e.component)) };
  return {
    publicName: e.publicName,
    ...target,
    ...(e.audience !== undefined ? { audience: e.audience } : {}),
    ...(e.version !== undefined ? { version: e.version } : {}),
    ...(e.stability !== undefined ? { stability: e.stability } : {}),
    // The derived export kind (transport.exportKind) and the role, call by default.
    ...(e.kind === 'component' && e.type !== undefined ? { type: e.type } : {}),
    ...(e.role !== undefined && e.role !== 'call' ? { role: e.role } : {}),
  };
}

/** A resolved table's rows in a fixed order: by public name, then target. */
function exportRows(entries: ResolvedExport[], keys: KeyTable): DesignExportEntry[] {
  return entries
    .map((e) => exportEntry(e, keys))
    .sort((a, b) => compareOrdinal(a.publicName, b.publicName) || compareOrdinal(`${a.targetKind}:${a.target}`, `${b.targetKind}:${b.target}`));
}

const boundaryText = (b: BoundaryItem): string => (typeof b === 'string' ? b : b.description ? `${b.name}: ${b.description}` : b.name);
const requirementText = (r: RequirementItem): string => (typeof r === 'string' ? r : r.description);

/** Step 21: the L0 as DesignProject, with the resolved project export table. */
function projectSection(system: SystemSpec, table: ResolvedExport[], keys: KeyTable): DesignExport['project'] {
  return {
    name: system.name,
    vision: system.vision,
    boundaries: system.boundaries.map(boundaryText),
    requirements: system.globalRequirements.map(requirementText),
    ...(system.targetLanguage !== undefined ? { targetLanguage: system.targetLanguage } : {}),
    exports: exportRows(table, keys),
  };
}

/** Step 23: one externals binding as a DesignDependency, with the digest its lock entry pins. */
function dependency(binding: ExternalBinding, lock: ExternalsLock | null, keys: KeyTable): DesignDependency {
  const alias = binding.external.alias;
  const digest = lock?.externals[alias]?.digest;
  return {
    alias,
    projectId: binding.external.project,
    role: binding.external.role,
    ...(digest !== undefined ? { digest } : {}),
    uses: [...new Set([...(binding.usage?.used ?? []).map((u) => u.publicName), ...(keys.used.get(alias) ?? [])])].sort(compareOrdinal),
  };
}

/** Step 23: one direct project member not among the externals, as a DesignDependency (role member). */
function memberDependency(member: MemberPublicNames, lock: ExternalsLock | null, keys: KeyTable): DesignDependency {
  const digest = lock?.externals[member.alias]?.digest;
  return {
    alias: member.alias,
    projectId: member.projectId,
    role: 'member',
    ...(digest !== undefined ? { digest } : {}),
    // Every public name a reference reaches (the graph's), and every one the projection wrote.
    uses: [...new Set([...(member.referenced ?? []), ...(keys.used.get(member.alias) ?? [])])].sort(compareOrdinal),
  };
}

/**
 * Steps 14-16: the bound project's direct project members — each node of the
 * graph whose parent is the bound root, an in-tree subdirectory member and a
 * legacy mount included (a part is no node: its subsystems are this
 * project's own) — each with its L0 table's bound keys mapped to
 * `alias::publicName`.
 */
function directMembers(family: ProjectFamily): MemberPublicNames[] {
  return family.nodes
    .filter((n) => n.parent === '' && n.namespace !== '')
    .map((n) => {
      const alias = n.mountAlias ?? n.namespace;
      const names = new Map<string, string>();
      const bound = (key: string): string[] => {
        const local = key.startsWith(`${n.namespace}::`) ? key : `${n.namespace}::${key}`;
        const last = `${n.namespace}::${key.split('::').pop() ?? key}`;
        return [...new Set([local, last])];
      };
      const rows = [...resolveProjectExports(n.namespace).entries]
        .sort((a, b) => compareOrdinal(a.publicName, b.publicName));
      for (const e of rows) {
        const name = `${alias}::${e.publicName}`;
        const targets = e.kind === 'type'
          ? [e.typeDef]
          : e.interface !== undefined ? [e.interface, e.component] : [e.component];
        for (const target of targets) {
          if (target === undefined) continue;
          for (const key of bound(target)) if (!names.has(key)) names.set(key, name);
        }
      }
      const referenced = [...new Set(family.references
        .filter((r) => r.consumer === '' && r.producer === n.namespace && r.publicName !== undefined)
        .map((r) => r.publicName!))];
      return { alias, projectId: n.id ?? alias, names, referenced };
    })
    .sort((a, b) => compareOrdinal(a.alias, b.alias));
}

/** Step 21: one subsystem, its lifecycle roots, L1 table and trusted links. */
function subsystemSection(s: SubsystemSpec, table: ResolvedExport[], keys: KeyTable): DesignSubsystem {
  return {
    key: s.id,
    name: s.name,
    description: s.description,
    status: s.status,
    ...(s.profile !== undefined ? { profile: s.profile } : {}),
    ...(s.targetLanguage !== undefined ? { targetLanguage: s.targetLanguage } : {}),
    lifecycle: (s.lifecycle ?? []).map((l) => ({ ...l, component: keys.componentRef(l.component) })),
    exports: exportRows(table, keys),
    trustedLinks: s.trustedLinks.map((t) => t.subsystem),
    ...(s.ext !== undefined ? { ext: s.ext } : {}),
  };
}

/** Step 21: one component, its edges as keys. */
function componentSection(c: ComponentSpec, keys: KeyTable): DesignComponent {
  return {
    key: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
    subsystem: c.subsystem,
    stereotype: c.componentType,
    ...(c.variant !== undefined ? { variant: c.variant } : {}),
    ...(c.dependencyClass !== undefined ? { dependencyClass: c.dependencyClass } : {}),
    ...(c.durability !== undefined ? { durability: c.durability } : {}),
    ...(c.transport !== undefined ? { transport: c.transport } : {}),
    ...(c.abi !== undefined ? { abi: c.abi } : {}),
    ...(c.invokedBy !== undefined ? { invokedBy: { ...c.invokedBy } } : {}),
    owns: c.owns.map((o) => keys.componentRef(o)),
    dependsOn: c.dependsOn.map((d) => keys.componentRef(d)),
    emits: (c.emits ?? []).map((e) => ({ ...e })),
    subscribesTo: (c.subscribesTo ?? []).map((e) => ({ ...e })),
    ...(c.auth !== undefined ? { auth: c.auth } : {}),
    ...(c.basePath !== undefined ? { basePath: c.basePath } : {}),
    dispatch: (c.dispatch ?? []).map((d) => ({ ...d, component: keys.componentRef(d.component) })),
    patterns: (c.patterns ?? []).map((p) => ({ ...p })),
    externalLinks: (c.externalLinks ?? []).map((l) => ({ ...l })),
    formerly: [...(c.previousIds ?? [])],
    ...(c.ext !== undefined ? { ext: c.ext } : {}),
  };
}

/** Step 22: one contract method, its signature resolved and inlined. */
function contractMethod(intf: InterfaceSpec, m: InterfaceSpec['methods'][number], keys: KeyTable, owner?: string): DesignMethod {
  // A sourced method arrives with its source's params and returns already
  // inlined by the loader; only a signature TYPE is named, so a generator can
  // emit the function type once.
  const signatureType = m.signatureFrom !== undefined && !keys.isMethodSource(m.signatureFrom)
    ? keys.typeKey(m.signatureFrom, owner, 'signature') ?? undefined
    : undefined;
  return {
    key: `${intf.id}.${m.name}`,
    name: m.name,
    description: m.description,
    params: projectParams(m.params, 'param', keys, owner),
    returns: typeRef(m.returns, 'returns', keys, owner),
    signature: m.signature,
    ...(signatureType !== undefined ? { signatureType } : {}),
    ...(m.effect !== undefined ? { effect: m.effect } : {}),
    guarantees: [...(m.guarantees ?? [])],
    ...(m.invokedBy !== undefined ? { invokedBy: { ...m.invokedBy } } : {}),
    ...(m.endpoint !== undefined ? { endpoint: endpointFields(m.endpoint) } : {}),
    formerly: [...(m.previousNames ?? [])],
    ...(m.ext !== undefined ? { ext: m.ext } : {}),
  };
}

/** The endpoint exactly as declared: `transport` plus that transport's address fields. */
function endpointFields(endpoint: object): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(endpoint)) if (v !== undefined) out[k] = String(v);
  return out;
}

/** Step 22: one interface and its methods. */
function interfaceSection(intf: InterfaceSpec, keys: KeyTable, owner?: string): DesignInterface {
  return {
    key: intf.id,
    component: intf.component,
    name: intf.name,
    description: intf.description,
    status: intf.status,
    methods: intf.methods.map((m) => contractMethod(intf, m, keys, owner)),
    formerly: [...(intf.previousIds ?? [])],
    ...(intf.ext !== undefined ? { ext: intf.ext } : {}),
  };
}

/** A narrative step as stored, its call, register and dispatch targets and its credential source as keys. */
function stepWithKeys(step: NarrativeStep, keys: KeyTable): NarrativeStep {
  const out: NarrativeStep = { ...step };
  if (step.targetMethod !== undefined) out.targetMethod = keys.methodKey(step.targetComponent, step.targetMethod);
  if (step.targetComponent !== undefined) out.targetComponent = keys.componentRef(step.targetComponent);
  const from = step.auth?.from;
  if (from !== undefined && from.startsWith('component:')) {
    out.auth = { ...step.auth!, from: `component:${keys.componentRef(from.slice('component:'.length))}` };
  }
  return out;
}

/** A declared `calls` entry (`<component>.<method>`) as the method's key. */
function callKey(ref: string, keys: KeyTable): string {
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) return ref;
  const key = keys.methodKey(ref.slice(0, dot), ref.slice(dot + 1));
  return key.includes('.') ? key : `${keys.componentRef(ref.slice(0, dot))}.${ref.slice(dot + 1)}`;
}

/** Step 22: one implementation, its method bodies with targets as keys. */
function implementationSection(
  impl: ImplementationSpec,
  contract: InterfaceSpec | undefined,
  component: ComponentSpec | undefined,
  keys: KeyTable,
): DesignImplementation {
  const methods: DesignMethodBody[] = impl.methods.map((m) => ({
    method: `${impl.contract}.${m.name}`,
    detail: effectiveDetail(m, impl, component).level,
    ...(m.intent !== undefined ? { intent: m.intent } : {}),
    calls: (m.calls ?? []).map((c) => callKey(c, keys)),
    narrative: m.narrative.map((s) => stepWithKeys(s, keys)),
  }));
  return {
    key: impl.id,
    contract: impl.contract,
    component: contract?.component ?? component?.id ?? '',
    name: impl.name,
    description: impl.description,
    status: impl.status,
    technologies: (impl.technologies ?? []).map(technologyName),
    ...(impl.sourcePath !== undefined ? { sourcePath: impl.sourcePath } : {}),
    methods,
    formerly: [...(impl.previousIds ?? [])],
    ...(impl.ext !== undefined ? { ext: impl.ext } : {}),
  };
}

/** Step 22: one type, every position canonical and parsed. */
function typeSection(t: TypeSpec, keys: KeyTable): DesignType {
  const key = qualifiedTypeId(t);
  const owner = t.subsystem;
  return {
    key,
    kind: t.kind,
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    fields: t.fields.map((f) => ({
      name: f.name,
      type: typeRef(f.type, 'field', keys, owner),
      optional: f.optional === true,
      ...(f.description !== undefined ? { description: f.description } : {}),
      ...(f.key !== undefined ? { key: f.key } : {}),
      ...(f.references !== undefined ? { references: keys.typeFieldRef(f.references, owner) } : {}),
      // The field's rename trace, only when it was renamed: an export of a
      // never-renamed field reads exactly as before.
      ...(f.previousNames && f.previousNames.length > 0 ? { formerly: [...f.previousNames] } : {}),
    })),
    methods: t.methods.map((m) => ({
      key: `${key}.${m.name}`,
      name: m.name,
      ...(m.description !== undefined ? { description: m.description } : {}),
      params: projectParams(m.params, 'type-method-param', keys, owner),
      returns: typeRef(m.returns, 'type-method-returns', keys, owner),
      signature: m.signature,
      guarantees: [],
      formerly: [],
    })),
    params: t.kind === 'signature' ? projectParams(t.params, 'signature-param', keys, owner) : [],
    ...(t.kind === 'signature' && t.returns !== undefined ? { returns: typeRef(t.returns, 'signature-returns', keys, owner) } : {}),
    values: (t.values ?? []).map((v) => ({ ...v })),
    ...(t.holds !== undefined ? { holds: t.holds } : {}),
    invariants: (t.invariants ?? []).map((i) => ({ ...i })),
    ...(t.componentClass !== undefined ? { componentClass: keys.componentRef(t.componentClass) } : {}),
    ...(t.database !== undefined ? { database: t.database } : {}),
    ...(t.table !== undefined ? { table: t.table } : {}),
    ...(t.linkedEntity !== undefined ? { linkedEntity: keys.typeKey(t.linkedEntity, owner) ?? keys.external(t.linkedEntity) } : {}),
    formerly: [...(t.previousIds ?? [])],
    ...(t.ext !== undefined ? { ext: t.ext } : {}),
  };
}

/** Every object's keys in ordinal order, recursively, undefined values dropped — so the JSON is one byte sequence. */
function sortedKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sortedKeys) as unknown as T;
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort(compareOrdinal)) {
      if (src[k] !== undefined) out[k] = sortedKeys(src[k]);
    }
    return out as T;
  }
  return value;
}

/** The effective id of the bound project, else its system name. */
function projectIdOf(system: SystemSpec): string {
  try {
    const config = loadProjectConfig();
    return (config ? effectiveProjectId(config) : null) ?? system.name;
  } catch {
    // A configuration failing its schema is reported by the paths that load it.
    return system.name;
  }
}

/**
 * idesign_exporter.exportDesign — project the bound project's whole design,
 * resolved, into one DesignExport. The approval verdict is the one the CALLER
 * decided against the gate identity; omitted, the source says unjudged.
 */
export function exportDesign(approval?: DesignApproval): DesignExport {
  // Steps 1-3: the L0, or a refusal.
  const system = loadSystemSpec();
  if (!system) throw new NoSystemSpecError();

  // Steps 4-8: every spec of the bound project (a part's included); a member
  // project's namespaced specs are left out (step 24).
  const subsystems = loadSubsystemSpecs().filter(isOwn);
  const components = loadComponentSpecs().filter(isOwn);
  const interfaces = loadInterfaceSpecs().filter(isOwn);
  const implementations = loadImplementationSpecs().filter(isOwn);
  const types = loadTypeSpecs().filter(isOwn);

  // Steps 9-11: the resolved project table and each subsystem's own.
  const projectTable = resolveProjectExports();
  const subsystemTables = new Map(subsystems.map((s) => [s.id, resolveSubsystemExports(s.id).entries]));

  // Steps 12-13: the project's id and its externals.
  const projectId = projectIdOf(system);
  const bindings = resolveExternals();
  // Steps 14-16: its direct project members and the names each publishes.
  const members = directMembers(projectFamily());
  // Step 17: the externals lock, for each dependency's pinned digest; one
  // that is absent or cannot be read pins nothing.
  let lock: ExternalsLock | null = null;
  try {
    lock = externalsRepository.readLock();
  } catch {
    lock = null;
  }
  // Step 18: the content identity.
  const stateId = computeStateId();

  // Step 19: the source — the caller's verdict stamped, never decided here.
  const state: DesignApproval = approval ?? 'unjudged';
  const source = {
    projectId,
    stateId: `${stateId.algorithm}:${stateId.digest}`,
    approval: state,
    approved: state === 'locked',
  };

  // Steps 20-23: key, resolve and project every element, then the dependencies.
  const keys = new KeyTable(components, interfaces, types, members);
  const componentById = new Map(components.map((c) => [c.id, c]));
  const interfaceById = new Map(interfaces.map((i) => [i.id, i]));
  const ownerOf = (componentId: string | undefined): string | undefined =>
    componentId !== undefined ? componentById.get(componentId)?.subsystem : undefined;

  // Every section that writes references comes first, so the dependencies
  // read the public names the projection actually used.
  const project = projectSection(system, projectTable.entries, keys);
  const subsystemSections = subsystems.map((s) => subsystemSection(s, subsystemTables.get(s.id) ?? [], keys)).sort(byKey);
  const componentSections = components.map((c) => componentSection(c, keys)).sort(byKey);
  const interfaceSections = interfaces.map((i) => interfaceSection(i, keys, ownerOf(i.component))).sort(byKey);
  const implementationSections = implementations
    .map((impl) => {
      const contract = interfaceById.get(impl.contract);
      return implementationSection(impl, contract, contract ? componentById.get(contract.component) : undefined, keys);
    })
    .sort(byKey);
  const typeSections = types.map((t) => typeSection(t, keys)).sort(byKey);
  const externalAliases = new Set(bindings.map((b) => b.external.alias));
  const dependencies = [
    ...bindings.map((b) => dependency(b, lock, keys)),
    ...members.filter((m) => !externalAliases.has(m.alias)).map((m) => memberDependency(m, lock, keys)),
  ].sort((a, b) => compareOrdinal(a.alias, b.alias));

  const design: DesignExport = {
    format: DESIGN_FORMAT,
    formatVersion: DESIGN_FORMAT_VERSION,
    generator: WAIRON_VERSION,
    source,
    project,
    dependencies,
    subsystems: subsystemSections,
    components: componentSections,
    interfaces: interfaceSections,
    implementations: implementationSections,
    types: typeSections,
  };

  // Steps 24-25: what is left out was never projected; sorted keys throughout, and the export.
  return sortedKeys(design);
}
