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
  type ImplementationSpec,
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
} from './adapters/surfaces-core.js';

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
 * The keys and lookups one projection resolves references against: the
 * bound project's own components, interfaces and types.
 */
class KeyTable {
  private readonly components = new Set<string>();
  /** component key → the interfaces it declares. */
  private readonly interfacesOf = new Map<string, InterfaceSpec[]>();
  private readonly types: TypeSpec[];
  private readonly typeRefCache = new Map<string, string | null>();

  constructor(components: ComponentSpec[], interfaces: InterfaceSpec[], types: TypeSpec[]) {
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
    }
    return ref;
  }
}

/** The parse of one position with each named member's name replaced by the key it resolves to. */
function resolveExpression(expr: TypeExpression, keys: KeyTable, owner?: string): TypeExpression {
  const args = expr.args.map((a) => resolveExpression(a, keys, owner));
  if ((expr.form === 'named' || expr.form === 'applied') && expr.name !== undefined) {
    return { form: expr.form, name: keys.typeKey(expr.name, owner) ?? expr.name, args };
  }
  return expr.name !== undefined ? { form: expr.form, name: expr.name, args } : { form: expr.form, args };
}

/** Step 17: one type position as a DesignTypeRef — canonical text and the resolved parse, or the text alone when the grammar cannot read it. */
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
  }));
}

/** One row of a resolved export table, its target as a key. */
function exportEntry(e: ResolvedExport, keys: KeyTable): DesignExportEntry {
  const target = e.kind === 'type'
    ? { targetKind: 'type', target: keys.typeKey(String(e.typeDef), e.source) ?? String(e.typeDef) }
    : e.interface
      ? { targetKind: 'interface', target: e.interface }
      : { targetKind: 'component', target: String(e.component) };
  return {
    publicName: e.publicName,
    ...target,
    ...(e.audience !== undefined ? { audience: e.audience } : {}),
    ...(e.version !== undefined ? { version: e.version } : {}),
    ...(e.stability !== undefined ? { stability: e.stability } : {}),
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

/** Step 18: the L0 as DesignProject, with the resolved project export table. */
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

/** Step 18: one externals binding as a DesignDependency (the pinned digest is not on the core binding). */
function dependency(binding: ExternalBinding): DesignDependency {
  return {
    alias: binding.external.alias,
    projectId: binding.external.project,
    role: binding.external.role,
    uses: [...new Set((binding.usage?.used ?? []).map((u) => u.publicName))].sort(compareOrdinal),
  };
}

/** Step 19: one subsystem, its lifecycle roots, L1 table and trusted links. */
function subsystemSection(s: SubsystemSpec, table: ResolvedExport[], keys: KeyTable): DesignSubsystem {
  return {
    key: s.id,
    name: s.name,
    description: s.description,
    status: s.status,
    ...(s.profile !== undefined ? { profile: s.profile } : {}),
    ...(s.targetLanguage !== undefined ? { targetLanguage: s.targetLanguage } : {}),
    lifecycle: (s.lifecycle ?? []).map((l) => ({ ...l })),
    exports: exportRows(table, keys),
    trustedLinks: s.trustedLinks.map((t) => t.subsystem),
    ...(s.ext !== undefined ? { ext: s.ext } : {}),
  };
}

/** Step 20: one component, its edges as keys. */
function componentSection(c: ComponentSpec): DesignComponent {
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
    ...(c.portalType !== undefined ? { portalType: c.portalType } : {}),
    owns: [...c.owns],
    dependsOn: [...c.dependsOn],
    emits: (c.emits ?? []).map((e) => ({ ...e })),
    subscribesTo: (c.subscribesTo ?? []).map((e) => ({ ...e })),
    ...(c.auth !== undefined ? { auth: c.auth } : {}),
    ...(c.basePath !== undefined ? { basePath: c.basePath } : {}),
    dispatch: (c.dispatch ?? []).map((d) => ({ ...d })),
    formerly: [...(c.previousIds ?? [])],
    ...(c.ext !== undefined ? { ext: c.ext } : {}),
  };
}

/** Step 21: one contract method, its signature resolved and inlined. */
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

/** Step 21: one interface and its methods. */
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

/** A narrative step as stored, its call, register and dispatch targets as keys. */
function stepWithKeys(step: NarrativeStep, keys: KeyTable): NarrativeStep {
  if (step.targetMethod === undefined) return { ...step };
  return { ...step, targetMethod: keys.methodKey(step.targetComponent, step.targetMethod) };
}

/** A declared `calls` entry (`<component>.<method>`) as the method's key. */
function callKey(ref: string, keys: KeyTable): string {
  const dot = ref.lastIndexOf('.');
  if (dot <= 0) return ref;
  const key = keys.methodKey(ref.slice(0, dot), ref.slice(dot + 1));
  return key.includes('.') ? key : ref;
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

/** Step 23: one type, every position canonical and parsed. */
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
    ...(t.componentClass !== undefined ? { componentClass: t.componentClass } : {}),
    ...(t.database !== undefined ? { database: t.database } : {}),
    ...(t.table !== undefined ? { table: t.table } : {}),
    ...(t.linkedEntity !== undefined ? { linkedEntity: keys.typeKey(t.linkedEntity, owner) ?? t.linkedEntity } : {}),
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

  // Steps 12-14: the project's id, its dependencies, its content identity.
  const projectId = projectIdOf(system);
  const bindings = resolveExternals();
  const stateId = computeStateId();

  // Step 15: the source — the caller's verdict stamped, never decided here.
  const state: DesignApproval = approval ?? 'unjudged';
  const source = {
    projectId,
    stateId: `${stateId.algorithm}:${stateId.digest}`,
    approval: state,
    approved: state === 'locked',
  };

  // Steps 16-23: key, resolve and project every element.
  const keys = new KeyTable(components, interfaces, types);
  const componentById = new Map(components.map((c) => [c.id, c]));
  const interfaceById = new Map(interfaces.map((i) => [i.id, i]));
  const ownerOf = (componentId: string | undefined): string | undefined =>
    componentId !== undefined ? componentById.get(componentId)?.subsystem : undefined;

  const design: DesignExport = {
    format: DESIGN_FORMAT,
    formatVersion: DESIGN_FORMAT_VERSION,
    generator: WAIRON_VERSION,
    source,
    project: projectSection(system, projectTable.entries, keys),
    dependencies: bindings.map(dependency).sort((a, b) => compareOrdinal(a.alias, b.alias)),
    subsystems: subsystems.map((s) => subsystemSection(s, subsystemTables.get(s.id) ?? [], keys)).sort(byKey),
    components: components.map(componentSection).sort(byKey),
    interfaces: interfaces.map((i) => interfaceSection(i, keys, ownerOf(i.component))).sort(byKey),
    implementations: implementations
      .map((impl) => {
        const contract = interfaceById.get(impl.contract);
        return implementationSection(impl, contract, contract ? componentById.get(contract.component) : undefined, keys);
      })
      .sort(byKey),
    types: types.map((t) => typeSection(t, keys)).sort(byKey),
  };

  // Steps 25-26: sorted keys throughout, and the export.
  return sortedKeys(design);
}
