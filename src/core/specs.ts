import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { aiPathsAt, WaiPaths } from '../config/loader.js';
import { ensureDir, listFiles, listFilesRecursive, pathExists, getProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import {
  SystemSpec,
  SystemSpecSchema,
  SubsystemSpec,
  SubsystemSpecSchema,
  ComponentSpec,
  ComponentSpecSchema,
  InterfaceSpec,
  InterfaceSpecSchema,
  ImplementationSpec,
  ImplementationSpecSchema,
  TypeSpec,
  TypeSpecSchema,
  GroupSpec,
  GroupSpecSchema,
  SpecStatus,
} from '../models/index.js';
import type { ValidationIssue } from './validation.js';

// ---------------------------------------------------------------------------
// Spec workspace
//
// All spec-tree state (index cache, loader issues, freshness signature, root
// subsystem set) lives on a SpecWorkspace instance keyed by project root.
// Nested subproject resolution asks for the CHILD's workspace instead of
// temporarily overriding a global project root — the override juggling that
// used to live here was the main source of namespacing regressions.
//
// The module-level functions at the bottom keep the historical flat API and
// delegate to the workspace of the current project root.
// ---------------------------------------------------------------------------

interface SpecIndex {
  subsystems: SubsystemSpec[];
  components: ComponentSpec[];
  interfaces: InterfaceSpec[];
  implementations: ImplementationSpec[];
  types: TypeSpec[];
  groups: GroupSpec[];
  paths: {
    subsystem: Record<string, string>;
    component: Record<string, string>;
    interface: Record<string, string>;
    implementation: Record<string, string>;
    type: Record<string, string>;
    group: Record<string, string>;
  };
}

function emptyIndex(): SpecIndex {
  return {
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    groups: [],
    paths: {
      subsystem: {},
      component: {},
      interface: {},
      implementation: {},
      type: {},
      group: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Pure namespace helpers
// ---------------------------------------------------------------------------

function qualifyId(id: string, prefix: string, rootSubsystems: ReadonlySet<string>): string;
function qualifyId(id: string | undefined, prefix: string, rootSubsystems: ReadonlySet<string>): string | undefined;
function qualifyId(id: string | undefined, prefix: string, rootSubsystems: ReadonlySet<string>): string | undefined {
  if (!id) return id;
  if (id.startsWith('::')) {
    return id.slice(2);
  }
  if (id.startsWith('super::')) {
    const prefixParts = prefix.split('::');
    const idParts = id.split('::');
    while (idParts[0] === 'super') {
      idParts.shift();
      prefixParts.pop();
    }
    return [...prefixParts, ...idParts].join('::');
  }
  const firstSegment = id.split('::')[0];
  if (rootSubsystems.has(firstSegment)) {
    return id;
  }
  return prefix ? `${prefix}::${id}` : id;
}

export function splitNamespace(qualifiedId: string): { prefix: string; localId: string } {
  if (!qualifiedId.includes('::')) {
    return { prefix: '', localId: qualifiedId };
  }
  const parts = qualifiedId.split('::');
  const localId = parts.pop()!;
  return { prefix: parts.join('::'), localId };
}

function stripNamespacePrefixes(id: string, prefix: string): string {
  if (id.startsWith('::') || id.startsWith('super::')) {
    return id;
  }
  let local = id;
  if (prefix && local.startsWith(`${prefix}::`)) {
    local = local.slice(prefix.length + 2);
  }
  if (local.includes('::')) {
    const parts = local.split('::');
    return parts[parts.length - 1];
  }
  return local;
}

function stripNamespaceFromSubsystem(spec: SubsystemSpec, prefix: string): SubsystemSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
    publicInterfaces: spec.publicInterfaces.map(pi => ({
      ...pi,
      component: pi.component ? stripNamespacePrefixes(pi.component, prefix) : undefined,
      interface: pi.interface ? stripNamespacePrefixes(pi.interface, prefix) : undefined,
    })),
  };
}

function stripNamespaceFromComponent(spec: ComponentSpec, prefix: string): ComponentSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
    subsystem: stripNamespacePrefixes(spec.subsystem, prefix),
    owns: spec.owns.map(o => stripNamespacePrefixes(o, prefix)),
    dependsOn: spec.dependsOn.map(d => stripNamespacePrefixes(d, prefix)),
  };
}

function stripNamespaceFromInterface(spec: InterfaceSpec, prefix: string): InterfaceSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
    component: stripNamespacePrefixes(spec.component, prefix),
  };
}

function stripNamespaceFromImplementation(spec: ImplementationSpec, prefix: string): ImplementationSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
    contract: stripNamespacePrefixes(spec.contract, prefix),
    methods: spec.methods.map(m => ({
      ...m,
      narrative: m.narrative.map(step => ({
        ...step,
        targetComponent: step.targetComponent ? stripNamespacePrefixes(step.targetComponent, prefix) : undefined,
      })),
    })),
  };
}

function stripNamespaceFromType(spec: TypeSpec, prefix: string): TypeSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
    subsystem: spec.subsystem ? stripNamespacePrefixes(spec.subsystem, prefix) : undefined,
  };
}

function stripNamespaceFromGroup(spec: GroupSpec, prefix: string): GroupSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
  };
}

// ---------------------------------------------------------------------------
// Pure structural helpers
// ---------------------------------------------------------------------------

/**
 * The pattern component that owns `id` via its `owns` list (at most one — the
 * SHARED_OWNED_MEMBER rule forbids two owners), or null. An owned member nests
 * physically under its owner because the owner owns its *implementation*; an
 * interface/port reference uses `dependsOn` and stays a flat sibling instead.
 */
function findOwner(id: string, components: ComponentSpec[]): ComponentSpec | null {
  const { localId } = splitNamespace(id);
  return components.find((c) => {
    const { localId: cLocalId } = splitNamespace(c.id);
    if (cLocalId === localId) return false;
    return (c.owns ?? []).some(ownedId => {
      const { localId: ownedLocalId } = splitNamespace(ownedId);
      return ownedLocalId === localId;
    });
  }) ?? null;
}

function moveComponentFolder(fromDir: string, toDir: string): boolean {
  if (path.normalize(fromDir) === path.normalize(toDir)) return false;
  if (!fs.existsSync(fromDir) || fs.existsSync(toDir)) return false; // don't clobber
  ensureDir(path.dirname(toDir));
  fs.renameSync(fromDir, toDir);
  return true;
}

/** Helper to clean up empty parent directories up to the given specs root. */
function cleanEmptyDirs(filePath: string, specsRoot: string): void {
  let dir = path.dirname(filePath);
  while (dir !== specsRoot && dir.startsWith(specsRoot)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
}

/**
 * Validate a spec object against its schema before it is written to disk, so a
 * malformed delta (e.g. via sdd_update_spec) fails loudly instead of writing a
 * corrupt file that only surfaces on the next scan. Returns the parsed value
 * (with schema defaults applied).
 */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, kind: string, id: string): z.infer<S> {
  const res = schema.safeParse(value);
  if (!res.success) {
    const detail = res.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`Refusing to write invalid ${kind} spec "${id}": ${detail}`);
  }
  return res.data;
}

// Freshness signature over file paths + mtimes + sizes, so a long-running
// process (the MCP server) notices external YAML edits.
const SIGNATURE_TTL_MS = 2000;

function computeSpecTreeSignature(dirs: string[]): string {
  const parts: string[] = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      parts.push(`${dir}:missing`);
      continue;
    }
    for (const f of listFilesRecursive(dir, '.yaml')) {
      try {
        const st = fs.statSync(f);
        parts.push(`${f}:${st.mtimeMs}:${st.size}`);
      } catch {
        parts.push(`${f}:gone`);
      }
    }
  }
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Status promotion types (see collectPromotableSpecs)
// ---------------------------------------------------------------------------

export type SpecKind = 'subsystem' | 'component' | 'interface' | 'implementation';

export interface PromotableSpec {
  kind: SpecKind;
  id: string;
  /** The current (pre-promotion) status — captured so callers can revert. */
  status: SpecStatus;
}

/**
 * Options for the spec save functions.
 * `allowStatusDemotion`: by default a re-save carrying status 'draft' does NOT
 * demote an existing 'design'/'complete' spec (the add tools always pass
 * 'draft', and re-adding must not silently reopen a locked spec). An explicit
 * status change via sdd_update_spec sets this to make deliberate demotion work.
 */
export interface SaveSpecOptions {
  allowStatusDemotion?: boolean;
}

// ---------------------------------------------------------------------------
// SpecWorkspace
// ---------------------------------------------------------------------------

export class SpecWorkspace {
  readonly rootDir: string;
  readonly paths: WaiPaths;

  private cachedIndex: SpecIndex | null = null;
  private cachedRecursive: boolean | number | null = null;
  private cachedSpecDirs: string[] = [];
  private cachedSignature: string | null = null;
  private lastSignatureCheckMs = 0;
  private rootSubsystems = new Set<string>();
  private scanVisitedSpecDirs: string[] = [];
  loaderIssues: ValidationIssue[] = [];

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    this.paths = aiPathsAt(this.rootDir);
  }

  invalidate(): void {
    this.cachedIndex = null;
    this.cachedRecursive = null;
    this.cachedSpecDirs = [];
    this.cachedSignature = null;
    this.lastSignatureCheckMs = 0;
    this.rootSubsystems.clear();
  }

  // -------------------------------------------------------------------------
  // Scanning
  // -------------------------------------------------------------------------

  scanAll(options?: { recursive?: boolean | number }): SpecIndex {
    const recursive = options?.recursive ?? true;
    if (this.cachedIndex && this.cachedRecursive === recursive) {
      // Cache hit — but the files may have been edited externally (hand edits,
      // another process) since we scanned. Re-verify via mtime signature at
      // most once per TTL.
      const now = Date.now();
      if (now - this.lastSignatureCheckMs <= SIGNATURE_TTL_MS) return this.cachedIndex;
      this.lastSignatureCheckMs = now;
      if (computeSpecTreeSignature(this.cachedSpecDirs) === this.cachedSignature) return this.cachedIndex;
      this.invalidate();
    }

    this.loaderIssues = [];
    this.rootSubsystems.clear();
    this.cachedRecursive = recursive;
    this.scanVisitedSpecDirs = [];
    const visited = new Set<string>([path.resolve(this.rootDir)]);

    const maxDepth = typeof recursive === 'number' ? recursive : (recursive ? Infinity : 0);
    this.cachedIndex = this.scanSpecsForProject(this.rootDir, '', visited, maxDepth, 0);
    this.cachedSpecDirs = this.scanVisitedSpecDirs;
    this.cachedSignature = computeSpecTreeSignature(this.cachedSpecDirs);
    this.lastSignatureCheckMs = Date.now();
    return this.cachedIndex;
  }

  private scanSpecsForProject(
    projectDir: string,
    namespacePrefix: string,
    visitedDirs: Set<string>,
    maxDepth: number,
    currentDepth: number,
  ): SpecIndex {
    const index = emptyIndex();
    const projectPaths = aiPathsAt(projectDir);

    const specsDir = projectPaths.specsDir();
    // Track every visited specs dir (even absent ones, so their later creation
    // is picked up) for the freshness signature.
    this.scanVisitedSpecDirs.push(specsDir);
    if (!pathExists(specsDir)) return index;

    const files = listFilesRecursive(specsDir, '.yaml');
    const systemYaml = path.normalize(projectPaths.specsSystem());

    const localSubprojects: { subsystemId: string; projectPath: string }[] = [];

    for (const file of files) {
      const normFile = path.normalize(file);
      if (normFile === systemYaml) continue;

      let detectedType = 'spec';
      try {
        const raw = readYamlFile(file);
        if (raw === null || typeof raw !== 'object') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'INVALID_YAML',
            message: `Spec file "${file}" is not a valid YAML object or is empty.`,
            specId: path.basename(file, '.yaml'),
          });
          continue;
        }

        if ('parentSystem' in raw) {
          detectedType = 'subsystem';
          const parsed = SubsystemSpecSchema.parse(raw);
          if (currentDepth === 0) {
            this.rootSubsystems.add(parsed.id);
          }
          if (parsed.projectPath) {
            localSubprojects.push({
              subsystemId: parsed.id,
              projectPath: parsed.projectPath,
            });
          }
          index.subsystems.push(parsed);
          index.paths.subsystem[parsed.id] = file;
        } else if ('componentType' in raw) {
          detectedType = 'component';
          const parsed = ComponentSpecSchema.parse(raw);
          index.components.push(parsed);
          index.paths.component[parsed.id] = file;
        } else if ('component' in raw) {
          detectedType = 'interface';
          const parsed = InterfaceSpecSchema.parse(raw);
          index.interfaces.push(parsed);
          index.paths.interface[parsed.id] = file;
        } else if ('contract' in raw) {
          detectedType = 'implementation';
          const parsed = ImplementationSpecSchema.parse(raw);
          if (parsed.sourcePath) {
            const absSourcePath = path.resolve(projectDir, parsed.sourcePath);
            parsed.sourcePath = path.relative(projectDir, absSourcePath).replace(/\\/g, '/');
          }
          index.implementations.push(parsed);
          index.paths.implementation[parsed.id] = file;
        } else if ('kind' in raw) {
          if (raw.kind === 'group') {
            detectedType = 'group';
            const parsed = GroupSpecSchema.parse(raw);
            index.groups.push(parsed);
            index.paths.group[parsed.id] = file;
          } else {
            detectedType = 'type';
            const parsed = TypeSpecSchema.parse(raw);
            index.types.push(parsed);
            index.paths.type[parsed.id] = file;
          }
        }

        if (detectedType === 'spec') {
          this.loaderIssues.push({
            severity: 'error',
            code: 'UNKNOWN_SPEC_TYPE',
            message: `Spec file "${file}" does not match any recognized L1-L4 schema structure.`,
            specId: path.basename(file, '.yaml'),
          });
        }
      } catch (e: any) {
        const filename = path.basename(file, '.yaml');
        this.loaderIssues.push({
          severity: 'error',
          code: 'SCHEMA_VALIDATION_ERROR',
          message: `Failed to parse ${detectedType} spec "${file}": ${e.message || String(e)}`,
          specId: filename,
        });
      }
    }

    // 2. Namespace local subsystems (runs always to handle projectPath delegation)
    index.subsystems = index.subsystems.map(sub => {
      const qualifiedSubId = namespacePrefix ? qualifyId(sub.id, namespacePrefix, this.rootSubsystems) : sub.id;
      const componentPrefix = sub.projectPath ? qualifiedSubId : namespacePrefix;
      return {
        ...sub,
        id: qualifiedSubId,
        publicInterfaces: sub.publicInterfaces.map(p => ({
          ...p,
          component: p.component ? qualifyId(p.component, componentPrefix, this.rootSubsystems) : undefined,
          interface: p.interface ? qualifyId(p.interface, componentPrefix, this.rootSubsystems) : undefined,
        })),
      };
    });

    const originalSubsystemPaths = index.paths.subsystem;
    index.paths.subsystem = {};
    for (const [k, v] of Object.entries(originalSubsystemPaths)) {
      const qualifiedK = namespacePrefix ? qualifyId(k, namespacePrefix, this.rootSubsystems) : k;
      index.paths.subsystem[qualifiedK] = v;
    }

    if (namespacePrefix) {
      index.components = index.components.map(comp => ({
        ...comp,
        id: qualifyId(comp.id, namespacePrefix, this.rootSubsystems),
        subsystem: qualifyId(comp.subsystem, namespacePrefix, this.rootSubsystems),
        owns: comp.owns.map(o => qualifyId(o, namespacePrefix, this.rootSubsystems)),
        dependsOn: comp.dependsOn.map(d => qualifyId(d, namespacePrefix, this.rootSubsystems)),
      }));

      index.interfaces = index.interfaces.map(intf => ({
        ...intf,
        id: qualifyId(intf.id, namespacePrefix, this.rootSubsystems),
        component: qualifyId(intf.component, namespacePrefix, this.rootSubsystems),
      }));

      index.implementations = index.implementations.map(impl => ({
        ...impl,
        id: qualifyId(impl.id, namespacePrefix, this.rootSubsystems),
        contract: qualifyId(impl.contract, namespacePrefix, this.rootSubsystems),
        methods: impl.methods.map(m => ({
          ...m,
          narrative: m.narrative.map(step => ({
            ...step,
            targetComponent: step.targetComponent ? qualifyId(step.targetComponent, namespacePrefix, this.rootSubsystems) : undefined,
          })),
        })),
      }));

      index.types = index.types.map(t => ({
        ...t,
        id: qualifyId(t.id, namespacePrefix, this.rootSubsystems),
        subsystem: t.subsystem ? qualifyId(t.subsystem, namespacePrefix, this.rootSubsystems) : undefined,
        group: t.group ? qualifyId(t.group, namespacePrefix, this.rootSubsystems) : undefined,
      }));

      index.groups = index.groups.map(g => ({
        ...g,
        id: qualifyId(g.id, namespacePrefix, this.rootSubsystems),
      }));

      const originalPaths = index.paths;
      index.paths = {
        subsystem: index.paths.subsystem,
        component: {},
        interface: {},
        implementation: {},
        type: {},
        group: {},
      };

      for (const [k, v] of Object.entries(originalPaths.component)) {
        index.paths.component[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.interface)) {
        index.paths.interface[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.implementation)) {
        index.paths.implementation[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.type)) {
        index.paths.type[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.group)) {
        index.paths.group[qualifyId(k, namespacePrefix, this.rootSubsystems)] = v;
      }
    }

    if (currentDepth < maxDepth) {
      for (const subproj of localSubprojects) {
        const childDir = path.resolve(projectDir, subproj.projectPath);
        if (visitedDirs.has(childDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'CIRCULAR_SUBPROJECT_REFERENCE',
            message: `Circular reference detected: Subsystem "${subproj.subsystemId}" refers to subproject "${childDir}" which is already loaded.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        if (!fs.existsSync(childDir)) {
          this.loaderIssues.push({
            severity: 'error',
            code: 'SUBPROJECT_NOT_FOUND',
            message: `Subproject directory "${childDir}" declared by subsystem "${subproj.subsystemId}" does not exist.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        const childNamespace = namespacePrefix
          ? `${namespacePrefix}::${subproj.subsystemId}`
          : subproj.subsystemId;

        const newVisited = new Set(visitedDirs);
        newVisited.add(childDir);

        const childIndex = this.scanSpecsForProject(childDir, childNamespace, newVisited, maxDepth, currentDepth + 1);

        index.subsystems.push(...childIndex.subsystems);
        index.components.push(...childIndex.components);
        index.interfaces.push(...childIndex.interfaces);
        index.implementations.push(...childIndex.implementations);
        index.types.push(...childIndex.types);
        index.groups.push(...childIndex.groups);

        Object.assign(index.paths.subsystem, childIndex.paths.subsystem);
        Object.assign(index.paths.component, childIndex.paths.component);
        Object.assign(index.paths.interface, childIndex.paths.interface);
        Object.assign(index.paths.implementation, childIndex.paths.implementation);
        Object.assign(index.paths.type, childIndex.paths.type);
        Object.assign(index.paths.group, childIndex.paths.group);
      }
    }

    return index;
  }

  // -------------------------------------------------------------------------
  // Namespace / subproject resolution
  // -------------------------------------------------------------------------

  resolveSubprojectForNamespace(namespace: string): string | null {
    const parts = namespace.split('::');
    let currentDir = this.rootDir;
    let resolvedAny = false;
    let currentPrefix = '';
    for (const part of parts) {
      currentPrefix = currentPrefix ? `${currentPrefix}::${part}` : part;
      const index = this.scanAll();
      const sub = index.subsystems.find((s) => s.id === currentPrefix);
      if (sub && sub.projectPath) {
        currentDir = path.resolve(currentDir, sub.projectPath);
        resolvedAny = true;
      }
    }
    return resolvedAny ? currentDir : null;
  }

  getSubprojectPrefix(qualifiedId: string): string | null {
    const parts = qualifiedId.split('::');
    if (parts.length <= 1) return null;
    const index = this.scanAll();
    let currentPrefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      currentPrefix = currentPrefix ? `${currentPrefix}::${parts[i]}` : parts[i];
      const sub = index.subsystems.find(s => s.id === currentPrefix);
      if (sub && sub.projectPath) {
        return currentPrefix;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Path builders
  // -------------------------------------------------------------------------

  getSubsystemPath(id: string): string {
    const index = this.scanAll();
    if (index.paths.subsystem[id]) {
      return index.paths.subsystem[id];
    }
    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        return workspaceFor(childProj).getSubsystemPath(parts[parts.length - 1]);
      }
    }

    // Suffix match for bare IDs matching a unique qualified subsystem
    const suffix = `::${id}`;
    const matches = Object.keys(index.paths.subsystem).filter(key => key.endsWith(suffix));
    if (matches.length === 1) {
      return index.paths.subsystem[matches[0]];
    }

    if (pathExists(this.paths.specsSubsystemsDir()) && listFiles(this.paths.specsSubsystemsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsSubsystemsDir(), `${id}.yaml`);
    }
    return path.join(this.paths.specsDir(), id, '.index.yaml');
  }

  getComponentPath(id: string, subsystemId?: string): string {
    const index = this.scanAll();
    if (index.paths.component[id]) {
      return index.paths.component[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        return workspaceFor(childProj).getComponentPath(remainingId, remainingSubsystem);
      }
    }

    // Owned members nest one level deep inside their owning pattern's folder
    // (patterns never own patterns, so it is exactly one level).
    const owner = findOwner(id, index.components);
    if (owner) {
      const ownerPath = index.paths.component[owner.id];
      if (ownerPath && ownerPath.endsWith('.index.yaml')) {
        return path.join(path.dirname(ownerPath), id, '.index.yaml');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, id, '.index.yaml');
      }
    }

    if (pathExists(this.paths.specsComponentsDir()) && listFiles(this.paths.specsComponentsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsComponentsDir(), `${id}.yaml`);
    }

    const targetSubsystem = subsystemId || 'default';
    return path.join(this.paths.specsDir(), targetSubsystem, id, '.index.yaml');
  }

  getInterfacePath(id: string, componentId?: string): string {
    const index = this.scanAll();
    if (index.paths.interface[id]) {
      return index.paths.interface[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingComponent = componentId ? componentId.split('::').pop() : undefined;
        return workspaceFor(childProj).getInterfacePath(remainingId, remainingComponent);
      }
    }

    if (componentId && componentId.includes('::')) {
      const parts = componentId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingComponent = parts[parts.length - 1];
        return workspaceFor(childProj).getInterfacePath(id, remainingComponent);
      }
    }

    if (componentId) {
      const compPath = this.getComponentPath(componentId);
      const compDir = path.dirname(compPath);
      if (compPath.endsWith('.index.yaml')) {
        return path.join(compDir, '.interface.yaml');
      }
    }

    if (pathExists(this.paths.specsInterfacesDir()) && listFiles(this.paths.specsInterfacesDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsInterfacesDir(), `${id}.yaml`);
    }

    const targetComponent = componentId || 'default';
    return path.join(this.paths.specsDir(), 'default', targetComponent, '.interface.yaml');
  }

  getImplementationPath(id: string, contractId?: string): string {
    const index = this.scanAll();
    if (index.paths.implementation[id]) {
      return index.paths.implementation[id];
    }

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingContract = contractId ? contractId.split('::').pop() : undefined;
        return workspaceFor(childProj).getImplementationPath(remainingId, remainingContract);
      }
    }

    if (contractId && contractId.includes('::')) {
      const parts = contractId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingContract = parts[parts.length - 1];
        return workspaceFor(childProj).getImplementationPath(id, remainingContract);
      }
    }

    if (contractId) {
      const intfPath = this.getInterfacePath(contractId);
      const intfDir = path.dirname(intfPath);
      if (intfPath.endsWith('.interface.yaml')) {
        return path.join(intfDir, '.implementation.yaml');
      }
    }

    if (pathExists(this.paths.specsImplementationsDir()) && listFiles(this.paths.specsImplementationsDir(), '.yaml').length > 0) {
      return path.join(this.paths.specsImplementationsDir(), `${id}.yaml`);
    }

    const targetContract = contractId ? contractId.replace(/^i/, '') : 'default';
    return path.join(this.paths.specsDir(), 'default', targetContract, '.implementation.yaml');
  }

  getTypePath(id: string, subsystemId?: string, group?: string): string {
    const index = this.scanAll();
    if (index.paths.type[id]) return index.paths.type[id];

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        const remainingGroup = group ? group.split('::').pop() : undefined;
        return workspaceFor(childProj).getTypePath(remainingId, remainingSubsystem, remainingGroup);
      }
    }

    if (subsystemId && subsystemId.includes('::')) {
      const parts = subsystemId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingSubsystem = parts[parts.length - 1];
        const remainingGroup = group ? group.split('::').pop() : undefined;
        return workspaceFor(childProj).getTypePath(id, remainingSubsystem, remainingGroup);
      }
    }

    const { localId: plainId } = splitNamespace(id);
    const targetGroup = group || index.types.find((t) => t.id === id || t.id === plainId)?.group;
    if (targetGroup) {
      const { localId: plainGroup } = splitNamespace(targetGroup);
      const groupPath = index.paths.group[targetGroup] || index.paths.group[plainGroup];
      if (groupPath) {
        const localId = id.split('::').pop()!;
        return path.join(path.dirname(groupPath), `${localId}.yaml`);
      }
    }

    let localId = id;
    if (id.includes('::')) {
      const parts = id.split('::');
      localId = parts[parts.length - 1];
      if (!subsystemId) {
        subsystemId = parts.slice(0, -1).join('::');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, 'types', `${localId}.yaml`);
      }
    }
    return path.join(this.paths.specsTypesDir(), `${localId}.yaml`);
  }

  getGroupPath(id: string, subsystemId?: string): string {
    const index = this.scanAll();
    const { localId: plainId } = splitNamespace(id);
    if (index.paths.group[id]) return index.paths.group[id];
    if (index.paths.group[plainId]) return index.paths.group[plainId];

    if (id.includes('::')) {
      const parts = id.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingId = parts[parts.length - 1];
        const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
        return workspaceFor(childProj).getGroupPath(remainingId, remainingSubsystem);
      }
    }

    if (subsystemId && subsystemId.includes('::')) {
      const parts = subsystemId.split('::');
      const childProj = this.resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
      if (childProj) {
        const remainingSubsystem = parts[parts.length - 1];
        return workspaceFor(childProj).getGroupPath(id, remainingSubsystem);
      }
    }

    let localId = id;
    if (id.includes('::')) {
      const parts = id.split('::');
      localId = parts[parts.length - 1];
      if (!subsystemId) {
        subsystemId = parts.slice(0, -1).join('::');
      }
    }

    if (subsystemId) {
      const subPath = this.getSubsystemPath(subsystemId);
      const subDir = path.dirname(subPath);
      if (subPath.endsWith('.index.yaml')) {
        return path.join(subDir, 'types', localId, '.index.yaml');
      }
    }
    return path.join(this.paths.specsTypesDir(), localId, '.index.yaml');
  }

  // -------------------------------------------------------------------------
  // Level 0: System
  // -------------------------------------------------------------------------

  loadSystemSpec(): SystemSpec | null {
    const p = this.paths.specsSystem();
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return SystemSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse system spec: ${e.message || String(e)}`,
        specId: 'system',
      });
      return null;
    }
  }

  saveSystemSpec(spec: SystemSpec): void {
    const p = this.paths.specsSystem();
    ensureDir(path.dirname(p));
    writeYamlFile(p, parseOrThrow(SystemSpecSchema, spec, 'system', spec.name));
    invalidateSpecCache();
  }

  // -------------------------------------------------------------------------
  // Level 1: Subsystems
  // -------------------------------------------------------------------------

  loadSubsystemSpecs(): SubsystemSpec[] {
    return this.scanAll().subsystems;
  }

  loadSubsystemSpec(id: string): SubsystemSpec | null {
    const index = this.scanAll();
    const cached = index.subsystems.find((s) => s.id === id);
    if (cached) return cached;

    const p = this.getSubsystemPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return SubsystemSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse subsystem spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  saveSubsystemSpec(spec: SubsystemSpec): void {
    const p = this.getSubsystemPath(spec.id);
    ensureDir(path.dirname(p));

    const { prefix } = splitNamespace(spec.id);
    let specToWrite = prefix ? stripNamespaceFromSubsystem(spec, prefix) : spec;

    if (prefix) {
      const childProj = this.resolveSubprojectForNamespace(prefix);
      if (childProj) {
        const childSystem = workspaceFor(childProj).loadSystemSpec();
        if (childSystem) {
          specToWrite = {
            ...specToWrite,
            parentSystem: childSystem.name,
          };
        }
      }
    }

    const existing = this.loadSubsystemSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(SubsystemSpecSchema, specToWrite, 'subsystem', spec.id));
    invalidateSpecCache();
  }

  deleteSubsystemSpec(id: string): boolean {
    const p = this.getSubsystemPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Level 2: Components
  // -------------------------------------------------------------------------

  loadComponentSpecs(): ComponentSpec[] {
    return this.scanAll().components;
  }

  loadComponentSpec(id: string): ComponentSpec | null {
    const index = this.scanAll();
    const spec = index.components.find((c) => c.id === id);
    if (spec) return spec;

    const p = this.getComponentPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return ComponentSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse component spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  saveComponentSpec(spec: ComponentSpec, opts?: SaveSpecOptions): void {
    const p = this.getComponentPath(spec.id, spec.subsystem);
    ensureDir(path.dirname(p));

    const subprojPrefix = this.getSubprojectPrefix(spec.id);
    const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
    const specToWrite = prefix ? stripNamespaceFromComponent(spec, prefix) : spec;

    const existing = this.loadComponentSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(ComponentSpecSchema, specToWrite, 'component', spec.id));
    invalidateSpecCache();
    // Keep the physical layout in sync with ownership: nest owned members under
    // their pattern, and move anything an `owns` change has displaced.
    this.normalizeComponentLayout();
  }

  deleteComponentSpec(id: string): boolean {
    const p = this.getComponentPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  /** The directory a component's folder should live in, given current ownership. */
  private desiredComponentDir(comp: ComponentSpec, index: SpecIndex): string | null {
    const currentPath = index.paths.component[comp.id];
    // Only the nested-tree layout is normalized (skip the legacy flat components/ dir).
    if (!currentPath || !currentPath.endsWith('.index.yaml')) return null;
    if (comp.id.includes('::')) return null;

    const owner = findOwner(comp.id, index.components);
    if (owner) {
      const ownerPath = index.paths.component[owner.id];
      if (ownerPath && ownerPath.endsWith('.index.yaml')) {
        // The owner (a pattern) lives flat under its subsystem; the member nests inside it.
        const ownerSubDir = path.dirname(this.getSubsystemPath(owner.subsystem));
        return path.join(ownerSubDir, owner.id, comp.id);
      }
    }
    // Patterns, standalone blocks, and shared (interface-referenced) blocks stay flat.
    const subDir = path.dirname(this.getSubsystemPath(comp.subsystem));
    return path.join(subDir, comp.id);
  }

  /**
   * Move component folders so the physical tree mirrors ownership: each owned
   * member sits inside its pattern's folder, everything else flat under its
   * subsystem. Idempotent — only misplaced folders move. Returns the ids moved.
   * The interface.yaml / implementation.yaml travel with the folder.
   */
  normalizeComponentLayout(): string[] {
    const index = this.scanAll();
    const moved: string[] = [];
    for (const comp of index.components) {
      const currentPath = index.paths.component[comp.id];
      if (!currentPath) continue;
      const desiredDir = this.desiredComponentDir(comp, index);
      if (!desiredDir) continue;
      if (moveComponentFolder(path.dirname(currentPath), desiredDir)) moved.push(comp.id);
    }
    if (moved.length) invalidateSpecCache();
    return moved;
  }

  // -------------------------------------------------------------------------
  // Level 3: Interfaces
  // -------------------------------------------------------------------------

  loadInterfaceSpecs(): InterfaceSpec[] {
    return this.scanAll().interfaces;
  }

  loadInterfaceSpec(id: string): InterfaceSpec | null {
    const index = this.scanAll();
    const spec = index.interfaces.find((i) => i.id === id);
    if (spec) return spec;

    const p = this.getInterfacePath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return InterfaceSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse interface spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  saveInterfaceSpec(spec: InterfaceSpec, opts?: SaveSpecOptions): void {
    const p = this.getInterfacePath(spec.id, spec.component);
    ensureDir(path.dirname(p));

    const subprojPrefix = this.getSubprojectPrefix(spec.id);
    const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
    const specToWrite = prefix ? stripNamespaceFromInterface(spec, prefix) : spec;

    const existing = this.loadInterfaceSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
      // Preserve endpoint bindings for matching methods that don't carry their own
      for (const m of specToWrite.methods) {
        if (m.endpoint) continue;
        const existingMethod = existing.methods.find(x => x.name === m.name);
        if (existingMethod && existingMethod.endpoint) {
          m.endpoint = existingMethod.endpoint;
        }
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(InterfaceSpecSchema, specToWrite, 'interface', spec.id));
    invalidateSpecCache();
  }

  deleteInterfaceSpec(id: string): boolean {
    const p = this.getInterfacePath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Level 4: Implementations
  // -------------------------------------------------------------------------

  loadImplementationSpecs(): ImplementationSpec[] {
    return this.scanAll().implementations;
  }

  loadImplementationSpec(id: string): ImplementationSpec | null {
    const index = this.scanAll();
    const spec = index.implementations.find((impl) => impl.id === id);
    if (spec) return spec;

    const p = this.getImplementationPath(id);
    if (!pathExists(p)) return null;
    try {
      const raw = readYamlFile(p);
      return ImplementationSpecSchema.parse(raw);
    } catch (e: any) {
      this.loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse implementation spec "${id}": ${e.message || String(e)}`,
        specId: id,
      });
      return null;
    }
  }

  saveImplementationSpec(spec: ImplementationSpec, opts?: SaveSpecOptions): void {
    const p = this.getImplementationPath(spec.id, spec.contract);
    ensureDir(path.dirname(p));

    const subprojPrefix = this.getSubprojectPrefix(spec.id);
    const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
    const specToWrite = prefix ? stripNamespaceFromImplementation(spec, prefix) : spec;

    const existing = this.loadImplementationSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!opts?.allowStatusDemotion && existing.status && (!spec.status || spec.status === 'draft')) {
        specToWrite.status = existing.status;
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(ImplementationSpecSchema, specToWrite, 'implementation', spec.id));
    invalidateSpecCache();
  }

  deleteImplementationSpec(id: string): boolean {
    const p = this.getImplementationPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Types (entities / value objects)
  // -------------------------------------------------------------------------

  loadTypeSpecs(): TypeSpec[] {
    return this.scanAll().types;
  }

  loadTypeSpec(id: string): TypeSpec | null {
    return this.scanAll().types.find((t) => t.id === id) ?? null;
  }

  saveTypeSpec(spec: TypeSpec): void {
    const existing = this.loadTypeSpec(spec.id);
    const group = spec.group || (existing ? existing.group : undefined);
    const p = this.getTypePath(spec.id, spec.subsystem, group);
    ensureDir(path.dirname(p));

    const subprojPrefix = this.getSubprojectPrefix(spec.id);
    const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
    const specToWrite = prefix ? stripNamespaceFromType(spec, prefix) : spec;

    if (existing) {
      specToWrite.createdAt = existing.createdAt;
      if (!specToWrite.group && existing.group) {
        specToWrite.group = stripNamespacePrefixes(existing.group, prefix);
      }
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(TypeSpecSchema, specToWrite, 'type', spec.id));
    invalidateSpecCache();
  }

  deleteTypeSpec(id: string): boolean {
    const spec = this.loadTypeSpec(id);
    const p = this.getTypePath(id, spec?.subsystem, spec?.group);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Groups (folders/categories for types)
  // -------------------------------------------------------------------------

  loadGroupSpecs(): GroupSpec[] {
    return this.scanAll().groups;
  }

  loadGroupSpec(id: string): GroupSpec | null {
    return this.scanAll().groups.find((g) => g.id === id) ?? null;
  }

  saveGroupSpec(spec: GroupSpec): void {
    const p = this.getGroupPath(spec.id);
    ensureDir(path.dirname(p));

    const { prefix } = splitNamespace(spec.id);
    const specToWrite = prefix ? stripNamespaceFromGroup(spec, prefix) : spec;

    const existing = this.loadGroupSpec(spec.id);
    if (existing) {
      specToWrite.createdAt = existing.createdAt;
    }
    specToWrite.updatedAt = new Date().toISOString();
    writeYamlFile(p, parseOrThrow(GroupSpecSchema, specToWrite, 'group', spec.id));
    invalidateSpecCache();
  }

  deleteGroupSpec(id: string): boolean {
    const p = this.getGroupPath(id);
    if (!fs.existsSync(p)) return false;
    fs.unlinkSync(p);
    cleanEmptyDirs(p, path.resolve(this.paths.specsDir()));
    invalidateSpecCache();
    return true;
  }

  // -------------------------------------------------------------------------
  // Spec status promotion (draft/design → complete)
  // -------------------------------------------------------------------------

  /** Every spec whose status is not yet 'complete', with its current status captured. */
  collectPromotableSpecs(scopeSubsystem?: string): PromotableSpec[] {
    const out: PromotableSpec[] = [];
    const subsystems = this.loadSubsystemSpecs();
    const components = this.loadComponentSpecs();
    const interfaces = this.loadInterfaceSpecs();
    const implementations = this.loadImplementationSpecs();

    const isSpecInSubsystemScope = (specSubsystem: string | undefined): boolean => {
      if (!scopeSubsystem) return true;
      if (!specSubsystem) return false;
      return specSubsystem === scopeSubsystem || specSubsystem.startsWith(`${scopeSubsystem}::`);
    };

    for (const s of subsystems) {
      if (s.status !== 'complete' && (!scopeSubsystem || s.id === scopeSubsystem || s.id.startsWith(scopeSubsystem + '::'))) {
        out.push({ kind: 'subsystem', id: s.id, status: (s.status ?? 'complete') as SpecStatus });
      }
    }
    for (const c of components) {
      if (c.status !== 'complete' && isSpecInSubsystemScope(c.subsystem)) {
        out.push({ kind: 'component', id: c.id, status: (c.status ?? 'complete') as SpecStatus });
      }
    }
    for (const i of interfaces) {
      if (i.status !== 'complete') {
        const comp = components.find(c => c.id === i.component);
        if (comp && isSpecInSubsystemScope(comp.subsystem)) {
          out.push({ kind: 'interface', id: i.id, status: (i.status ?? 'complete') as SpecStatus });
        }
      }
    }
    for (const m of implementations) {
      if (m.status !== 'complete') {
        const intf = interfaces.find(i => i.id === m.contract);
        const comp = intf ? components.find(c => c.id === intf.component) : null;
        if (comp && isSpecInSubsystemScope(comp.subsystem)) {
          out.push({ kind: 'implementation', id: m.id, status: (m.status ?? 'complete') as SpecStatus });
        }
      }
    }
    return out;
  }

  /** Set a single spec's status (bumps updatedAt). Caller invalidates the cache. */
  applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
    switch (kind) {
      case 'subsystem':      { const s = this.loadSubsystemSpec(id);      if (s) this.saveSubsystemSpec({ ...s, status }); break; }
      case 'component':      { const s = this.loadComponentSpec(id);      if (s) this.saveComponentSpec({ ...s, status }); break; }
      case 'interface':      { const s = this.loadInterfaceSpec(id);      if (s) this.saveInterfaceSpec({ ...s, status }); break; }
      case 'implementation': { const s = this.loadImplementationSpec(id); if (s) this.saveImplementationSpec({ ...s, status }); break; }
    }
  }

  /**
   * Snapshot the raw bytes of every spec file under .wai/specs. Paired with
   * restoreSpecFiles() to give a byte-exact revert — used by `wairon lock` to
   * dry-run a promotion (write 'complete' → validate → restore) without leaving
   * any change behind if validation fails or the user cancels.
   */
  snapshotSpecFiles(): Map<string, string> {
    const index = this.scanAll();
    const snapshot = new Map<string, string>();
    const files = new Set<string>();

    const sysPath = this.paths.specsSystem();
    if (pathExists(sysPath)) {
      files.add(path.resolve(sysPath));
    }

    for (const group of Object.values(index.paths)) {
      for (const file of Object.values(group)) {
        files.add(path.resolve(file));
      }
    }

    for (const file of files) {
      if (fs.existsSync(file)) {
        snapshot.set(file, fs.readFileSync(file, 'utf8'));
      }
    }

    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Legacy layout detection
  // -------------------------------------------------------------------------

  findLegacySpecFiles(): { path: string; expected: string }[] {
    const specsDir = this.paths.specsDir();
    if (!pathExists(specsDir)) return [];
    const files = listFilesRecursive(specsDir, '.yaml');
    const legacy: { path: string; expected: string }[] = [];
    for (const f of files) {
      const base = path.basename(f);
      const dir = path.dirname(f);
      if (base === 'system.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'subsystem.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'component.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'group.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.index.yaml') });
      } else if (base === 'interface.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.interface.yaml') });
      } else if (base === 'implementation.yaml') {
        legacy.push({ path: f, expected: path.join(dir, '.implementation.yaml') });
      }
    }
    return legacy;
  }

  // -------------------------------------------------------------------------
  // Granular delta updates (sdd_update_spec)
  // -------------------------------------------------------------------------

  updateSpec(
    kind: 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
    id: string,
    delta: Record<string, any>
  ): void {
    const result = (() => {
      switch (kind) {
        case 'subsystem':      return this.loadSubsystemSpec(id);
        case 'component':      return this.loadComponentSpec(id);
        case 'interface':      return this.loadInterfaceSpec(id);
        case 'implementation': return this.loadImplementationSpec(id);
        case 'type':           return this.loadTypeSpec(id);
      }
    })();

    if (!result) {
      throw new Error(`Spec of kind "${kind}" with ID "${id}" does not exist. Define it first.`);
    }

    const mergeNarrative = (existingSteps: any[], deltaSteps: any[]): any[] => {
      let steps = [...existingSteps];
      const sortedDeltas = [...deltaSteps].sort((a, b) => a.stepNumber - b.stepNumber);
      for (const deltaStep of sortedDeltas) {
        const stepNum = deltaStep.stepNumber;
        if (deltaStep.action === 'delete' || deltaStep.remove === true) {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            steps.splice(idx, 1);
            steps = steps.map(s => {
              if (s.stepNumber > stepNum) {
                return { ...s, stepNumber: s.stepNumber - 1 };
              }
              return s;
            });
          }
        } else if (deltaStep.action === 'insert') {
          steps = steps.map(s => {
            if (s.stepNumber >= stepNum) {
              return { ...s, stepNumber: s.stepNumber + 1 };
            }
            return s;
          });
          const { action, remove, ...cleanStep } = deltaStep;
          steps.push(cleanStep);
        } else {
          const idx = steps.findIndex(s => s.stepNumber === stepNum);
          if (idx !== -1) {
            const { action, remove, ...cleanStep } = deltaStep;
            steps[idx] = {
              ...steps[idx],
              ...cleanStep,
            };
          } else {
            const { action, remove, ...cleanStep } = deltaStep;
            steps.push(cleanStep);
          }
        }
      }
      return steps.sort((a, b) => a.stepNumber - b.stepNumber);
    };

    const mergeMethods = (existingMethods: any[], deltaMethods: any[]): any[] => {
      const merged = [...existingMethods];
      for (const deltaMethod of deltaMethods) {
        const idx = merged.findIndex(m => m.name === deltaMethod.name);
        if (idx !== -1) {
          if (deltaMethod.remove === true || deltaMethod.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            const existingMethod = merged[idx];
            let narrative = existingMethod.narrative ? [...existingMethod.narrative] : [];
            if (deltaMethod.narrative && Array.isArray(deltaMethod.narrative)) {
              narrative = mergeNarrative(narrative, deltaMethod.narrative);
            }
            const { narrative: _, ...cleanMethod } = deltaMethod;
            merged[idx] = {
              ...existingMethod,
              ...cleanMethod,
              narrative,
            };
          }
        } else {
          if (deltaMethod.remove !== true && deltaMethod.action !== 'delete') {
            merged.push(deltaMethod);
          }
        }
      }
      return merged;
    };

    const mergeNamedArray = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const idx = merged.findIndex(item => item.name === deltaItem.name);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = {
              ...merged[idx],
              ...deltaItem,
            };
          }
        } else {
          if (deltaItem.remove !== true && deltaItem.action !== 'delete') {
            merged.push(deltaItem);
          }
        }
      }
      return merged;
    };

    const mergePublicInterfaces = (existing: any[], delta: any[]): any[] => {
      const merged = [...existing];
      for (const deltaItem of delta) {
        const idx = merged.findIndex(item => item.component === deltaItem.component && item.interface === deltaItem.interface);
        if (idx !== -1) {
          if (deltaItem.remove === true || deltaItem.action === 'delete') {
            merged.splice(idx, 1);
          } else {
            merged[idx] = {
              ...merged[idx],
              ...deltaItem,
            };
          }
        } else {
          if (deltaItem.remove !== true && deltaItem.action !== 'delete') {
            merged.push(deltaItem);
          }
        }
      }
      return merged;
    };

    const mergeDelta = (existing: any, delta2: any): any => {
      const res = { ...existing };
      for (const [key, value] of Object.entries(delta2)) {
        if (value === undefined || value === null) {
          continue;
        }
        if (key === 'methods' && Array.isArray(value) && Array.isArray(existing.methods)) {
          if (kind === 'implementation') {
            res.methods = mergeMethods(existing.methods, value);
          } else {
            res.methods = mergeNamedArray(existing.methods, value);
          }
        } else if (key === 'fields' && Array.isArray(value) && Array.isArray(existing.fields)) {
          res.fields = mergeNamedArray(existing.fields, value);
        } else if (key === 'publicInterfaces' && Array.isArray(value) && Array.isArray(existing.publicInterfaces)) {
          res.publicInterfaces = mergePublicInterfaces(existing.publicInterfaces, value);
        } else if (Array.isArray(value)) {
          res[key] = value;
        } else if (typeof value === 'object' && typeof existing[key] === 'object' && existing[key] !== null) {
          res[key] = mergeDelta(existing[key], value);
        } else {
          res[key] = value;
        }
      }
      return res;
    };

    const mergedResult = mergeDelta(result, delta);
    mergedResult.updatedAt = new Date().toISOString();

    // An explicit status in the delta is a deliberate change — allow demotion
    // (e.g. reopening a completed spec to 'draft' for revision).
    const opts: SaveSpecOptions = {
      allowStatusDemotion: Object.prototype.hasOwnProperty.call(delta, 'status'),
    };

    switch (kind) {
      case 'subsystem':      this.saveSubsystemSpec(mergedResult); break;
      case 'component':      this.saveComponentSpec(mergedResult, opts); break;
      case 'interface':      this.saveInterfaceSpec(mergedResult, opts); break;
      case 'implementation': this.saveImplementationSpec(mergedResult, opts); break;
      case 'type':           this.saveTypeSpec(mergedResult); break;
    }
  }
}

// ---------------------------------------------------------------------------
// Workspace registry + flat module API (delegates to the current root)
// ---------------------------------------------------------------------------

const workspaces = new Map<string, SpecWorkspace>();

/** The workspace for an explicit project root (created on first use). */
export function workspaceFor(rootDir: string): SpecWorkspace {
  const key = path.resolve(rootDir);
  let ws = workspaces.get(key);
  if (!ws) {
    ws = new SpecWorkspace(key);
    workspaces.set(key, ws);
  }
  return ws;
}

/** The workspace for the current project root (override, else resolved cwd). */
function current(): SpecWorkspace {
  return workspaceFor(getProjectRoot());
}

/**
 * Invalidate every workspace's cache and drop the instances. Invalidation must
 * hit the instances themselves (not just the map) because a workspace method
 * may still be mid-flight holding `this` — e.g. saveComponentSpec invalidates
 * globally and then runs normalizeComponentLayout on the same instance, which
 * must rescan rather than serve its stale index.
 */
export function invalidateSpecCache(): void {
  for (const ws of workspaces.values()) ws.invalidate();
  workspaces.clear();
}

export function getLoaderIssues(): ValidationIssue[] {
  return current().loaderIssues;
}

export function clearLoaderIssues(): void {
  current().loaderIssues = [];
  invalidateSpecCache();
}

export function scanAllSpecs(options?: { recursive?: boolean | number }): SpecIndex {
  return current().scanAll(options);
}

export function resolveSubprojectForNamespace(namespace: string): string | null {
  return current().resolveSubprojectForNamespace(namespace);
}

export function getSubprojectPrefix(qualifiedId: string): string | null {
  return current().getSubprojectPrefix(qualifiedId);
}

export function getSubsystemPath(id: string): string {
  return current().getSubsystemPath(id);
}

export function getComponentPath(id: string, subsystemId?: string): string {
  return current().getComponentPath(id, subsystemId);
}

export function getInterfacePath(id: string, componentId?: string): string {
  return current().getInterfacePath(id, componentId);
}

export function getImplementationPath(id: string, contractId?: string): string {
  return current().getImplementationPath(id, contractId);
}

export function getTypePath(id: string, subsystemId?: string, group?: string): string {
  return current().getTypePath(id, subsystemId, group);
}

export function getGroupPath(id: string, subsystemId?: string): string {
  return current().getGroupPath(id, subsystemId);
}

export function loadSystemSpec(): SystemSpec | null {
  return current().loadSystemSpec();
}

export function saveSystemSpec(spec: SystemSpec): void {
  current().saveSystemSpec(spec);
}

export function loadSubsystemSpecs(): SubsystemSpec[] {
  return current().loadSubsystemSpecs();
}

export function loadSubsystemSpec(id: string): SubsystemSpec | null {
  return current().loadSubsystemSpec(id);
}

export function saveSubsystemSpec(spec: SubsystemSpec): void {
  current().saveSubsystemSpec(spec);
}

export function deleteSubsystemSpec(id: string): boolean {
  return current().deleteSubsystemSpec(id);
}

export function loadComponentSpecs(): ComponentSpec[] {
  return current().loadComponentSpecs();
}

export function loadComponentSpec(id: string): ComponentSpec | null {
  return current().loadComponentSpec(id);
}

export function saveComponentSpec(spec: ComponentSpec, opts?: SaveSpecOptions): void {
  current().saveComponentSpec(spec, opts);
}

export function deleteComponentSpec(id: string): boolean {
  return current().deleteComponentSpec(id);
}

export function normalizeComponentLayout(): string[] {
  return current().normalizeComponentLayout();
}

export function loadInterfaceSpecs(): InterfaceSpec[] {
  return current().loadInterfaceSpecs();
}

export function loadInterfaceSpec(id: string): InterfaceSpec | null {
  return current().loadInterfaceSpec(id);
}

export function saveInterfaceSpec(spec: InterfaceSpec, opts?: SaveSpecOptions): void {
  current().saveInterfaceSpec(spec, opts);
}

export function deleteInterfaceSpec(id: string): boolean {
  return current().deleteInterfaceSpec(id);
}

export function loadImplementationSpecs(): ImplementationSpec[] {
  return current().loadImplementationSpecs();
}

export function loadImplementationSpec(id: string): ImplementationSpec | null {
  return current().loadImplementationSpec(id);
}

export function saveImplementationSpec(spec: ImplementationSpec, opts?: SaveSpecOptions): void {
  current().saveImplementationSpec(spec, opts);
}

export function deleteImplementationSpec(id: string): boolean {
  return current().deleteImplementationSpec(id);
}

export function loadTypeSpecs(): TypeSpec[] {
  return current().loadTypeSpecs();
}

export function loadTypeSpec(id: string): TypeSpec | null {
  return current().loadTypeSpec(id);
}

export function saveTypeSpec(spec: TypeSpec): void {
  current().saveTypeSpec(spec);
}

export function deleteTypeSpec(id: string): boolean {
  return current().deleteTypeSpec(id);
}

export function loadGroupSpecs(): GroupSpec[] {
  return current().loadGroupSpecs();
}

export function loadGroupSpec(id: string): GroupSpec | null {
  return current().loadGroupSpec(id);
}

export function saveGroupSpec(spec: GroupSpec): void {
  current().saveGroupSpec(spec);
}

export function deleteGroupSpec(id: string): boolean {
  return current().deleteGroupSpec(id);
}

export function collectPromotableSpecs(scopeSubsystem?: string): PromotableSpec[] {
  return current().collectPromotableSpecs(scopeSubsystem);
}

export function applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
  current().applySpecStatus(kind, id, status);
}

export function snapshotSpecFiles(): Map<string, string> {
  return current().snapshotSpecFiles();
}

/** Restore files captured by snapshotSpecFiles(). Caller invalidates the cache. */
export function restoreSpecFiles(snapshot: Map<string, string>): void {
  for (const [file, content] of snapshot) {
    fs.writeFileSync(file, content);
  }
}

export function findLegacySpecFiles(): { path: string; expected: string }[] {
  return current().findLegacySpecFiles();
}

export function updateSpec(
  kind: 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
  id: string,
  delta: Record<string, any>
): void {
  current().updateSpec(kind, id, delta);
}
