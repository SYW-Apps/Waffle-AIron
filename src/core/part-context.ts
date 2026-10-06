import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { projectConfigRepository } from '../config/project-config.js';
import { effectiveProjectId, isPart, memberLocationOf, parseMemberSource, type ProjectConfig } from '../models/project.js';
import {
  fieldTypeRefs,
  methodTypeRefs,
  parseDeclaredCall,
  signatureTypeRefs,
  typeMatchesRef,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type ParentExcerpt,
  type TypeSpec,
  retiredMountsOf,
} from '../models/index.js';
import { canonicalize } from '../utils/canonical-json.js';
import { getProjectRoot, runWithProjectRoot } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import * as gitSource from './adapters/git-source.js';
import {
  graph,
  loadComponentSpecs,
  loadImplementationSpecs,
  loadInterfaceSpecs,
  loadSpec,
  loadSubsystemSpecs,
  loadTypeSpecs,
  type ScannedPart,
} from './specs.js';

// ---------------------------------------------------------------------------
// part_context (sdd_core) — what a part needs to know about the project it is
// a part of, read with the parent on disk (stage 8): the excerpt of the
// parent's specs the part's files reference, closed over what judging them
// needs, with the governing configuration the parent judges its parts under.
// It reads and never writes: pinning the excerpt is the surface plane's
// (`wairon externals pin` at a part), and judging against it is the owner's
// gate's. A read Orchestrator: it reads two roots (the part's and its
// parent's) under two bindings and composes one answer from them.
// ---------------------------------------------------------------------------

/** Thrown when there is no parent on disk that really claims the bound part. */
export class PartContextUnavailable extends WaironError {
  constructor(message: string) {
    super(message);
    this.name = 'PartContextUnavailable';
  }
}

/** Whether two directories are the same, as the filesystem resolves them. */
function sameDirectory(a: string, b: string): boolean {
  const canonical = (d: string): string => {
    try {
      return fs.realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  };
  const [x, y] = [canonical(a), canonical(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** The parent's declaration of this part: a member whose contained path or `../` source names the part's directory. */
function declaresPart(parent: ProjectConfig, parentRoot: string, partRoot: string): boolean {
  return Object.values(parent.members ?? {}).some((value) => {
    const location = memberLocationOf(value);
    if (location === undefined) return false;
    const parsed = parseMemberSource(location);
    if (parsed.problem || (parsed.storage !== 'contained' && parsed.storage !== 'path')) return false;
    return sameDirectory(path.resolve(parentRoot, location), partRoot);
  });
}

/**
 * Step 6: every key a part spec's reference names that the part does not
 * declare — dependsOn and owns targets, call, register and dispatch targets,
 * declared calls, dispatch-table bindings, lifecycle entries, trusted links,
 * contracts, subsystems and type positions.
 */
function referencedKeys(part: ScannedPart, types: TypeSpec[]): Set<string> {
  const own = new Set(part.specIds);
  const out = new Set<string>();
  const add = (key: string | undefined): void => { if (key && !own.has(key)) out.add(key); };
  const addTypes = (refs: string[]): void => {
    for (const ref of refs) for (const t of types) if (typeMatchesRef(t, ref)) add(t.id);
  };
  for (const s of loadSubsystemSpecs().filter((x) => own.has(x.id))) {
    (s.trustedLinks ?? []).forEach((l) => add(l.subsystem));
    (s.lifecycle ?? []).forEach((l) => add(l.component));
  }
  for (const c of loadComponentSpecs().filter((x) => own.has(x.id))) {
    add(c.subsystem);
    c.dependsOn.forEach(add);
    (c.owns ?? []).forEach(add);
    (c.dispatch ?? []).forEach((b) => add(b.component));
    retiredMountsOf(c).mounts.forEach((m) => add(m.portal));
  }
  for (const i of loadInterfaceSpecs().filter((x) => own.has(x.id))) {
    add(i.component);
    for (const m of i.methods) addTypes(sourcedMethodTypeRefs(m));
  }
  for (const impl of loadImplementationSpecs().filter((x) => own.has(x.id))) {
    add(impl.contract);
    for (const m of impl.methods) {
      for (const step of m.narrative) {
        if (step.type === 'call' || step.type === 'register' || step.type === 'dispatch') add(step.targetComponent);
      }
      for (const entry of m.calls ?? []) add(parseDeclaredCall(entry)?.compId);
    }
  }
  for (const t of types.filter((x) => own.has(x.id))) {
    add(t.subsystem);
    addTypes(typeSpecTypeRefs(t));
  }
  return out;
}

/**
 * The types a contract method names: its signature's, and its signatureFrom
 * read as a type — a signature type it takes its params from is as much a
 * reference as a param typed by one. (A `component.method` source reaches its
 * component along dependsOn/owns, which the closure already follows.)
 */
function sourcedMethodTypeRefs(m: InterfaceSpec['methods'][number]): string[] {
  return [...methodTypeRefs(m), ...(m.signatureFrom !== undefined ? [m.signatureFrom] : [])];
}

/** The types a type names: its fields', its methods' params and returns when they carry params, and a signature's params and returns. */
function typeSpecTypeRefs(t: TypeSpec): string[] {
  return [
    ...(t.fields ?? []).flatMap((f) => fieldTypeRefs(t, f.type)),
    ...(t.methods ?? []).filter((m) => m.params !== undefined).flatMap((m) => methodTypeRefs(m)),
    ...signatureTypeRefs(t),
  ];
}

/** The kinds a key may be loaded as, in the order a reference most often names them. */
const KINDS = ['component', 'interface', 'subsystem', 'type', 'implementation'] as const;

/** Steps 7-8: the referenced specs closed over what judging them needs, keyed by id. */
function closeOver(keys: Set<string>, types: TypeSpec[]): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const queue = [...keys];
  const interfaces = loadInterfaceSpecs();
  const addTypes = (refs: string[]): void => {
    for (const ref of refs) for (const t of types) if (typeMatchesRef(t, ref) && !out.has(t.id)) queue.push(t.id);
  };
  while (queue.length > 0) {
    const key = queue.shift()!;
    if (out.has(key)) continue;
    const found = KINDS.map((kind) => ({ kind, spec: loadSpec(kind, key) })).find((x) => x.spec !== null);
    if (!found) continue;
    out.set(key, found.spec as unknown as Record<string, unknown>);
    if (found.kind === 'component') {
      const comp = found.spec as ComponentSpec;
      queue.push(comp.subsystem);
      for (const contract of interfaces.filter((i) => i.component === comp.id)) queue.push(contract.id);
    } else if (found.kind === 'interface') {
      for (const m of (found.spec as InterfaceSpec).methods) addTypes(sourcedMethodTypeRefs(m));
    } else if (found.kind === 'type') {
      addTypes(typeSpecTypeRefs(found.spec as TypeSpec));
    } else if (found.kind === 'implementation') {
      queue.push((found.spec as ImplementationSpec).contract);
    }
    // A subsystem's L1 is taken as it is: its trusted links and public
    // interfaces name what judging the part's references needs.
  }
  return out;
}

/** Steps 3-9 under the parent's binding: the parent's configuration checked, its graph read, the excerpt collected. */
function readParent(parentRoot: string, partRoot: string, partOfProject: string): Omit<ParentExcerpt, 'digest'> {
  // Step 4: the parent answers to PartOf.project and declares this part.
  const parent = projectConfigRepository.load();
  if (!parent) throw new PartContextUnavailable(`no wairon project at ${parentRoot}`);
  const id = effectiveProjectId(parent);
  if (id !== partOfProject) {
    throw new PartContextUnavailable(`the project at ${parentRoot} answers to ${id === null ? 'no id' : `"${id}"`}, not "${partOfProject}" as this part's partOf says`);
  }
  if (!declaresPart(parent, parentRoot, partRoot)) {
    throw new PartContextUnavailable(`"${partOfProject}" at ${parentRoot} does not declare this part (${partRoot}) among its members`);
  }
  // Step 5: the parent's graph — its scan folds this part in.
  const root = graph().nodes.find((n) => n.namespace === '');
  const part = root?.parts.find((p) => p.directory !== undefined && sameDirectory(p.directory, partRoot));
  if (!part) throw new PartContextUnavailable(`"${partOfProject}" declares this part but could not read it`);
  // Steps 6-8: what the part's files reference, closed over what judging them needs.
  const types = loadTypeSpecs();
  const specs = closeOver(referencedKeys(part, types), types);
  const system = loadSpec('system', 'system');
  const ordered = [...specs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, spec]) => spec);
  // Step 9: the parent's commit, for provenance.
  const commit = gitSource.head(parentRoot);
  return {
    project: partOfProject,
    ...(commit ? { commit } : {}),
    ...(parent.projectType ? { projectType: parent.projectType } : {}),
    rules: (parent.rules ?? {}) as Record<string, unknown>,
    packs: (parent.extensions?.packs ?? []) as ParentExcerpt['packs'],
    specs: [...(system ? [system as unknown as Record<string, unknown>] : []), ...ordered],
  };
}

/**
 * ipart_context.excerpt — with a part's root bound: the ParentExcerpt it can
 * be judged against alone. Refuses, naming why, when the bound root is not a
 * part, when its PartOf names no path or the parent is not on disk there,
 * when the project there answers to another id, or when that project does not
 * declare this part — a pin is only ever taken from the parent that really
 * claims the part. Writes nothing; the caller's binding is restored.
 */
export function excerpt(): ParentExcerpt {
  // Step 1: the bound root's configuration and its PartOf.
  const partRoot = getProjectRoot();
  const config = projectConfigRepository.load();
  const partOf = config?.partOf;
  // Steps 2 and 12: a parent on disk to excerpt, or a refusal naming why.
  if (!isPart(config) || !partOf) throw new PartContextUnavailable(`${partRoot} is not a part: its configuration declares no partOf`);
  if (partOf.path === undefined) throw new PartContextUnavailable(`the part at ${partRoot} records no path to its parent "${partOf.project}"`);
  const parentRoot = path.resolve(partRoot, partOf.path);
  if (!fs.existsSync(parentRoot)) throw new PartContextUnavailable(`the parent "${partOf.project}" is not on disk at ${parentRoot}`);
  // Step 3: the parent's root, bound read-only; the caller's binding comes back on every path.
  const read = runWithProjectRoot(parentRoot, () => readParent(parentRoot, partRoot, partOf.project));
  // Steps 10-11: the excerpt, its digest over everything but the commit.
  const { commit: _provenance, ...content } = read;
  const digest = `sha256:${crypto.createHash('sha256').update(canonicalize(content)).digest('hex')}`;
  return { ...read, digest };
}
