import * as fs from 'fs';
import * as path from 'path';
import { AI_PATHS } from '../config/loader.js';
import { ensureDir, listFiles, listFilesRecursive, pathExists, getProjectRoot, setProjectRoot, getProjectRootOverride } from '../utils/fs.js';
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
import { ValidationIssue } from './validation.js';

// ---------------------------------------------------------------------------
// Path Builders and Loader Issues Tracking
// ---------------------------------------------------------------------------
let loaderIssues: ValidationIssue[] = [];

export function getLoaderIssues(): ValidationIssue[] {
  return loaderIssues;
}

export function clearLoaderIssues(): void {
  loaderIssues = [];
  invalidateSpecCache();
}

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

let cachedIndex: SpecIndex | null = null;
let cachedRootDir: string | null = null;
let cachedRecursive: boolean | number | null = null;
const rootSubsystems = new Set<string>();

export function invalidateSpecCache(): void {
  cachedIndex = null;
  cachedRootDir = null;
  cachedRecursive = null;
  rootSubsystems.clear();
}

function qualifyId(id: string, prefix: string): string;
function qualifyId(id: string | undefined, prefix: string): string | undefined;
function qualifyId(id: string | undefined, prefix: string): string | undefined {
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

function scanSpecsForProject(projectDir: string, namespacePrefix: string, visitedDirs: Set<string>, maxDepth = Infinity, currentDepth = 0): SpecIndex {
  const index: SpecIndex = {
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

  const prevOverride = getProjectRootOverride();
  setProjectRoot(projectDir);

  try {
    const specsDir = AI_PATHS.specsDir();
    if (!pathExists(specsDir)) return index;

    const files = listFilesRecursive(specsDir, '.yaml');
    const systemYaml = path.normalize(AI_PATHS.specsSystem());

    const localSubprojects: { subsystemId: string; projectPath: string }[] = [];

    for (const file of files) {
      const normFile = path.normalize(file);
      if (normFile === systemYaml) continue;

      let detectedType = 'spec';
      try {
        const raw = readYamlFile(file);
        if (raw === null || typeof raw !== 'object') {
          loaderIssues.push({
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
            rootSubsystems.add(parsed.id);
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
            parsed.sourcePath = path.relative(getProjectRoot(), absSourcePath).replace(/\\/g, '/');
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
          loaderIssues.push({
            severity: 'error',
            code: 'UNKNOWN_SPEC_TYPE',
            message: `Spec file "${file}" does not match any recognized L1-L4 schema structure.`,
            specId: path.basename(file, '.yaml'),
          });
        }
      } catch (e: any) {
        const filename = path.basename(file, '.yaml');
        loaderIssues.push({
          severity: 'error',
          code: 'SCHEMA_VALIDATION_ERROR',
          message: `Failed to parse ${detectedType} spec "${file}": ${e.message || String(e)}`,
          specId: filename,
        });
      }
    }

    // 2. Namespace local subsystems (runs always to handle projectPath delegation)
    index.subsystems = index.subsystems.map(sub => {
      const qualifiedSubId = namespacePrefix ? qualifyId(sub.id, namespacePrefix) : sub.id;
      const componentPrefix = sub.projectPath ? qualifiedSubId : namespacePrefix;
      return {
        ...sub,
        id: qualifiedSubId,
        publicInterfaces: sub.publicInterfaces.map(p => ({
          ...p,
          component: p.component ? qualifyId(p.component, componentPrefix) : undefined,
          interface: p.interface ? qualifyId(p.interface, componentPrefix) : undefined,
        })),
      };
    });

    const originalSubsystemPaths = index.paths.subsystem;
    index.paths.subsystem = {};
    for (const [k, v] of Object.entries(originalSubsystemPaths)) {
      const qualifiedK = namespacePrefix ? qualifyId(k, namespacePrefix) : k;
      index.paths.subsystem[qualifiedK] = v;
    }

    if (namespacePrefix) {
      index.components = index.components.map(comp => ({
        ...comp,
        id: qualifyId(comp.id, namespacePrefix),
        subsystem: qualifyId(comp.subsystem, namespacePrefix),
        owns: comp.owns.map(o => qualifyId(o, namespacePrefix)),
        dependsOn: comp.dependsOn.map(d => qualifyId(d, namespacePrefix)),
      }));

      index.interfaces = index.interfaces.map(intf => ({
        ...intf,
        id: qualifyId(intf.id, namespacePrefix),
        component: qualifyId(intf.component, namespacePrefix),
      }));

      index.implementations = index.implementations.map(impl => ({
        ...impl,
        id: qualifyId(impl.id, namespacePrefix),
        contract: qualifyId(impl.contract, namespacePrefix),
        methods: impl.methods.map(m => ({
          ...m,
          narrative: m.narrative.map(step => ({
            ...step,
            targetComponent: step.targetComponent ? qualifyId(step.targetComponent, namespacePrefix) : undefined,
          })),
        })),
      }));

      index.types = index.types.map(t => ({
        ...t,
        id: qualifyId(t.id, namespacePrefix),
        subsystem: t.subsystem ? qualifyId(t.subsystem, namespacePrefix) : undefined,
        group: t.group ? qualifyId(t.group, namespacePrefix) : undefined,
      }));

      index.groups = index.groups.map(g => ({
        ...g,
        id: qualifyId(g.id, namespacePrefix),
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
        index.paths.component[qualifyId(k, namespacePrefix)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.interface)) {
        index.paths.interface[qualifyId(k, namespacePrefix)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.implementation)) {
        index.paths.implementation[qualifyId(k, namespacePrefix)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.type)) {
        index.paths.type[qualifyId(k, namespacePrefix)] = v;
      }
      for (const [k, v] of Object.entries(originalPaths.group)) {
        index.paths.group[qualifyId(k, namespacePrefix)] = v;
      }
    }

    if (currentDepth < maxDepth) {
      for (const subproj of localSubprojects) {
        const childDir = path.resolve(projectDir, subproj.projectPath);
        if (visitedDirs.has(childDir)) {
          loaderIssues.push({
            severity: 'error',
            code: 'CIRCULAR_SUBPROJECT_REFERENCE',
            message: `Circular reference detected: Subsystem "${subproj.subsystemId}" refers to subproject "${childDir}" which is already loaded.`,
            specId: subproj.subsystemId,
          });
          continue;
        }

        if (!fs.existsSync(childDir)) {
          loaderIssues.push({
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

        const childIndex = scanSpecsForProject(childDir, childNamespace, newVisited, maxDepth, currentDepth + 1);

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

  } finally {
    setProjectRoot(prevOverride);
  }

  return index;
}

export function scanAllSpecs(options?: { recursive?: boolean | number }): SpecIndex {
  const recursive = options?.recursive ?? true;
  const rootDir = getProjectRoot();
  if (cachedIndex && cachedRootDir === rootDir && cachedRecursive === recursive) return cachedIndex;

  loaderIssues = [];
  rootSubsystems.clear();
  cachedRootDir = rootDir;
  cachedRecursive = recursive;
  const visited = new Set<string>([path.resolve(rootDir)]);
  
  const maxDepth = typeof recursive === 'number' ? recursive : (recursive ? Infinity : 0);
  cachedIndex = scanSpecsForProject(rootDir, '', visited, maxDepth, 0);
  return cachedIndex;
}

export function resolveSubprojectForNamespace(namespace: string): string | null {
  const parts = namespace.split('::');
  let currentDir = getProjectRoot();
  let resolvedAny = false;
  let currentPrefix = '';
  for (const part of parts) {
    currentPrefix = currentPrefix ? `${currentPrefix}::${part}` : part;
    const index = scanAllSpecs();
    const sub = index.subsystems.find((s) => s.id === currentPrefix);
    if (sub && sub.projectPath) {
      currentDir = path.resolve(currentDir, sub.projectPath);
      resolvedAny = true;
    }
  }
  return resolvedAny ? currentDir : null;
}


export function getSubprojectPrefix(qualifiedId: string): string | null {
  const parts = qualifiedId.split('::');
  if (parts.length <= 1) return null;
  const index = scanAllSpecs();
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

export function getSubsystemPath(id: string): string {
  const index = scanAllSpecs();
  if (index.paths.subsystem[id]) {
    return index.paths.subsystem[id];
  }
  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getSubsystemPath(remainingId);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  // Suffix match for bare IDs matching a unique qualified subsystem
  const suffix = `::${id}`;
  const matches = Object.keys(index.paths.subsystem).filter(key => key.endsWith(suffix));
  if (matches.length === 1) {
    return index.paths.subsystem[matches[0]];
  }

  if (pathExists(AI_PATHS.specsSubsystemsDir()) && listFiles(AI_PATHS.specsSubsystemsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsSubsystemsDir(), `${id}.yaml`);
  }
  return path.join(AI_PATHS.specsDir(), id, '.index.yaml');
}

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

export function getComponentPath(id: string, subsystemId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.component[id]) {
    return index.paths.component[id];
  }

  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getComponentPath(remainingId, remainingSubsystem);
      } finally {
        setProjectRoot(prevOverride);
      }
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
    const subPath = getSubsystemPath(subsystemId);
    const subDir = path.dirname(subPath);
    if (subPath.endsWith('.index.yaml')) {
      return path.join(subDir, id, '.index.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsComponentsDir()) && listFiles(AI_PATHS.specsComponentsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsComponentsDir(), `${id}.yaml`);
  }

  const targetSubsystem = subsystemId || 'default';
  return path.join(AI_PATHS.specsDir(), targetSubsystem, id, '.index.yaml');
}

export function getInterfacePath(id: string, componentId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.interface[id]) {
    return index.paths.interface[id];
  }

  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const remainingComponent = componentId ? componentId.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getInterfacePath(remainingId, remainingComponent);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (componentId && componentId.includes('::')) {
    const parts = componentId.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingComponent = parts[parts.length - 1];
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getInterfacePath(id, remainingComponent);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (componentId) {
    const compPath = getComponentPath(componentId);
    const compDir = path.dirname(compPath);
    if (compPath.endsWith('.index.yaml')) {
      return path.join(compDir, '.interface.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsInterfacesDir()) && listFiles(AI_PATHS.specsInterfacesDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsInterfacesDir(), `${id}.yaml`);
  }

  const targetComponent = componentId || 'default';
  return path.join(AI_PATHS.specsDir(), 'default', targetComponent, '.interface.yaml');
}

export function getImplementationPath(id: string, contractId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.implementation[id]) {
    return index.paths.implementation[id];
  }

  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const remainingContract = contractId ? contractId.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getImplementationPath(remainingId, remainingContract);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (contractId && contractId.includes('::')) {
    const parts = contractId.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingContract = parts[parts.length - 1];
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getImplementationPath(id, remainingContract);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (contractId) {
    const intfPath = getInterfacePath(contractId);
    const intfDir = path.dirname(intfPath);
    if (intfPath.endsWith('.interface.yaml')) {
      return path.join(intfDir, '.implementation.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsImplementationsDir()) && listFiles(AI_PATHS.specsImplementationsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsImplementationsDir(), `${id}.yaml`);
  }

  const targetContract = contractId ? contractId.replace(/^i/, '') : 'default';
  return path.join(AI_PATHS.specsDir(), 'default', targetContract, '.implementation.yaml');
}

// ---------------------------------------------------------------------------
// Level 0: System Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadSystemSpec(): SystemSpec | null {
  const p = AI_PATHS.specsSystem();
  if (!pathExists(p)) return null;
  try {
    const raw = readYamlFile(p);
    return SystemSpecSchema.parse(raw);
  } catch (e: any) {
    loaderIssues.push({
      severity: 'error',
      code: 'SCHEMA_VALIDATION_ERROR',
      message: `Failed to parse system spec: ${e.message || String(e)}`,
      specId: 'system',
    });
    return null;
  }
}

export function saveSystemSpec(spec: SystemSpec): void {
  const p = AI_PATHS.specsSystem();
  ensureDir(path.dirname(p));
  writeYamlFile(p, spec);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Level 1: Subsystem Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadSubsystemSpecs(): SubsystemSpec[] {
  return scanAllSpecs().subsystems;
}

export function loadSubsystemSpec(id: string): SubsystemSpec | null {
  const index = scanAllSpecs();
  const cached = index.subsystems.find((s) => s.id === id);
  if (cached) return cached;

  const p = getSubsystemPath(id);
  if (!pathExists(p)) return null;
  try {
    const raw = readYamlFile(p);
    return SubsystemSpecSchema.parse(raw);
  } catch (e: any) {
    loaderIssues.push({
      severity: 'error',
      code: 'SCHEMA_VALIDATION_ERROR',
      message: `Failed to parse subsystem spec "${id}": ${e.message || String(e)}`,
      specId: id,
    });
    return null;
  }
}

export function saveSubsystemSpec(spec: SubsystemSpec): void {
  const p = getSubsystemPath(spec.id);
  ensureDir(path.dirname(p));

  const { prefix } = splitNamespace(spec.id);
  let specToWrite = prefix ? stripNamespaceFromSubsystem(spec, prefix) : spec;

  if (prefix) {
    const childProj = resolveSubprojectForNamespace(prefix);
    if (childProj) {
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        const childSystem = loadSystemSpec();
        if (childSystem) {
          specToWrite = {
            ...specToWrite,
            parentSystem: childSystem.name,
          };
        }
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  const existing = loadSubsystemSpec(spec.id);
  if (existing) {
    specToWrite.createdAt = existing.createdAt;
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Level 2: Component Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadComponentSpecs(): ComponentSpec[] {
  return scanAllSpecs().components;
}

export function loadComponentSpec(id: string): ComponentSpec | null {
  const index = scanAllSpecs();
  const spec = index.components.find((c) => c.id === id);
  if (spec) return spec;

  const p = getComponentPath(id);
  if (!pathExists(p)) return null;
  try {
    const raw = readYamlFile(p);
    return ComponentSpecSchema.parse(raw);
  } catch (e: any) {
    loaderIssues.push({
      severity: 'error',
      code: 'SCHEMA_VALIDATION_ERROR',
      message: `Failed to parse component spec "${id}": ${e.message || String(e)}`,
      specId: id,
    });
    return null;
  }
}

export function saveComponentSpec(spec: ComponentSpec): void {
  const p = getComponentPath(spec.id, spec.subsystem);
  ensureDir(path.dirname(p));

  const subprojPrefix = getSubprojectPrefix(spec.id);
  const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
  const specToWrite = prefix ? stripNamespaceFromComponent(spec, prefix) : spec;

  const existing = loadComponentSpec(spec.id);
  if (existing) {
    specToWrite.createdAt = existing.createdAt;
    if (existing.status && (!spec.status || spec.status === 'draft')) {
      specToWrite.status = existing.status;
    }
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
  // Keep the physical layout in sync with ownership: nest owned members under
  // their pattern, and move anything an `owns` change has displaced.
  normalizeComponentLayout();
}

/** The directory a component's folder should live in, given current ownership. */
function desiredComponentDir(comp: ComponentSpec, index: SpecIndex): string | null {
  const currentPath = index.paths.component[comp.id];
  // Only the nested-tree layout is normalized (skip the legacy flat components/ dir).
  if (!currentPath || !currentPath.endsWith('.index.yaml')) return null;
  if (comp.id.includes('::')) return null;

  const owner = findOwner(comp.id, index.components);
  if (owner) {
    const ownerPath = index.paths.component[owner.id];
    if (ownerPath && ownerPath.endsWith('.index.yaml')) {
      // The owner (a pattern) lives flat under its subsystem; the member nests inside it.
      const ownerSubDir = path.dirname(getSubsystemPath(owner.subsystem));
      return path.join(ownerSubDir, owner.id, comp.id);
    }
  }
  // Patterns, standalone blocks, and shared (interface-referenced) blocks stay flat.
  const subDir = path.dirname(getSubsystemPath(comp.subsystem));
  return path.join(subDir, comp.id);
}

function moveComponentFolder(fromDir: string, toDir: string): boolean {
  if (path.normalize(fromDir) === path.normalize(toDir)) return false;
  if (!fs.existsSync(fromDir) || fs.existsSync(toDir)) return false; // don't clobber
  ensureDir(path.dirname(toDir));
  fs.renameSync(fromDir, toDir);
  return true;
}

/**
 * Move component folders so the physical tree mirrors ownership: each owned
 * member sits inside its pattern's folder, everything else flat under its
 * subsystem. Idempotent — only misplaced folders move. Returns the ids moved.
 * The interface.yaml / implementation.yaml travel with the folder.
 */
export function normalizeComponentLayout(): string[] {
  const index = scanAllSpecs();
  const moved: string[] = [];
  for (const comp of index.components) {
    const currentPath = index.paths.component[comp.id];
    if (!currentPath) continue;
    const desiredDir = desiredComponentDir(comp, index);
    if (!desiredDir) continue;
    if (moveComponentFolder(path.dirname(currentPath), desiredDir)) moved.push(comp.id);
  }
  if (moved.length) invalidateSpecCache();
  return moved;
}

// ---------------------------------------------------------------------------
// Level 3: Interface Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadInterfaceSpecs(): InterfaceSpec[] {
  return scanAllSpecs().interfaces;
}

export function loadInterfaceSpec(id: string): InterfaceSpec | null {
  const index = scanAllSpecs();
  const spec = index.interfaces.find((i) => i.id === id);
  if (spec) return spec;

  const p = getInterfacePath(id);
  if (!pathExists(p)) return null;
  try {
    const raw = readYamlFile(p);
    return InterfaceSpecSchema.parse(raw);
  } catch (e: any) {
    loaderIssues.push({
      severity: 'error',
      code: 'SCHEMA_VALIDATION_ERROR',
      message: `Failed to parse interface spec "${id}": ${e.message || String(e)}`,
      specId: id,
    });
    return null;
  }
}

export function saveInterfaceSpec(spec: InterfaceSpec): void {
  const p = getInterfacePath(spec.id, spec.component);
  ensureDir(path.dirname(p));

  const subprojPrefix = getSubprojectPrefix(spec.id);
  const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
  const specToWrite = prefix ? stripNamespaceFromInterface(spec, prefix) : spec;

  const existing = loadInterfaceSpec(spec.id);
  if (existing) {
    specToWrite.createdAt = existing.createdAt;
    if (existing.status && (!spec.status || spec.status === 'draft')) {
      specToWrite.status = existing.status;
    }
    // Preserve endpoint bindings for matching methods
    for (const m of specToWrite.methods) {
      const existingMethod = existing.methods.find(x => x.name === m.name);
      if (existingMethod && existingMethod.endpoint) {
        m.endpoint = existingMethod.endpoint;
      }
    }
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Level 4: Implementation Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadImplementationSpecs(): ImplementationSpec[] {
  return scanAllSpecs().implementations;
}

export function loadImplementationSpec(id: string): ImplementationSpec | null {
  const index = scanAllSpecs();
  const spec = index.implementations.find((impl) => impl.id === id);
  if (spec) return spec;

  const p = getImplementationPath(id);
  if (!pathExists(p)) return null;
  try {
    const raw = readYamlFile(p);
    return ImplementationSpecSchema.parse(raw);
  } catch (e: any) {
    loaderIssues.push({
      severity: 'error',
      code: 'SCHEMA_VALIDATION_ERROR',
      message: `Failed to parse implementation spec "${id}": ${e.message || String(e)}`,
      specId: id,
    });
    return null;
  }
}

export function saveImplementationSpec(spec: ImplementationSpec): void {
  const p = getImplementationPath(spec.id, spec.contract);
  ensureDir(path.dirname(p));

  const subprojPrefix = getSubprojectPrefix(spec.id);
  const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
  const specToWrite = prefix ? stripNamespaceFromImplementation(spec, prefix) : spec;

  const existing = loadImplementationSpec(spec.id);
  if (existing) {
    specToWrite.createdAt = existing.createdAt;
    if (existing.status && (!spec.status || spec.status === 'draft')) {
      specToWrite.status = existing.status;
    }
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Types (entities / value objects) Loader/Writer
//
// Entities/value objects live in a `types/` directory — at the subsystem that
// owns them, or at the system level for shared value objects.
// ---------------------------------------------------------------------------
export function getTypePath(id: string, subsystemId?: string, group?: string): string {
  const index = scanAllSpecs();
  if (index.paths.type[id]) return index.paths.type[id];

  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
      const remainingGroup = group ? group.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getTypePath(remainingId, remainingSubsystem, remainingGroup);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (subsystemId && subsystemId.includes('::')) {
    const parts = subsystemId.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingSubsystem = parts[parts.length - 1];
      const remainingGroup = group ? group.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getTypePath(id, remainingSubsystem, remainingGroup);
      } finally {
        setProjectRoot(prevOverride);
      }
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
    const subPath = getSubsystemPath(subsystemId);
    const subDir = path.dirname(subPath);
    if (subPath.endsWith('.index.yaml')) {
      return path.join(subDir, 'types', `${localId}.yaml`);
    }
  }
  return path.join(AI_PATHS.specsTypesDir(), `${localId}.yaml`);
}

export function loadTypeSpecs(): TypeSpec[] {
  return scanAllSpecs().types;
}

export function loadTypeSpec(id: string): TypeSpec | null {
  return scanAllSpecs().types.find((t) => t.id === id) ?? null;
}

export function saveTypeSpec(spec: TypeSpec): void {
  const existing = loadTypeSpec(spec.id);
  const group = spec.group || (existing ? existing.group : undefined);
  const p = getTypePath(spec.id, spec.subsystem, group);
  ensureDir(path.dirname(p));

  const subprojPrefix = getSubprojectPrefix(spec.id);
  const prefix = subprojPrefix || splitNamespace(spec.id).prefix;
  const specToWrite = prefix ? stripNamespaceFromType(spec, prefix) : spec;

  if (existing) {
    specToWrite.createdAt = existing.createdAt;
    if (!specToWrite.group && existing.group) {
      specToWrite.group = stripNamespacePrefixes(existing.group, prefix);
    }
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Spec status promotion (draft/design → complete)
//
// Used by the `wairon lock` command to freeze the design. TypeSpecs carry no
// status, so only subsystems / components / interfaces / implementations promote.
// ---------------------------------------------------------------------------
export type SpecKind = 'subsystem' | 'component' | 'interface' | 'implementation';

export interface PromotableSpec {
  kind: SpecKind;
  id: string;
  /** The current (pre-promotion) status — captured so callers can revert. */
  status: SpecStatus;
}

/** Every spec whose status is not yet 'complete', with its current status captured. */
export function collectPromotableSpecs(scopeSubsystem?: string): PromotableSpec[] {
  const out: PromotableSpec[] = [];
  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

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
export function applySpecStatus(kind: SpecKind, id: string, status: SpecStatus): void {
  switch (kind) {
    case 'subsystem':      { const s = loadSubsystemSpec(id);      if (s) saveSubsystemSpec({ ...s, status }); break; }
    case 'component':      { const s = loadComponentSpec(id);      if (s) saveComponentSpec({ ...s, status }); break; }
    case 'interface':      { const s = loadInterfaceSpec(id);      if (s) saveInterfaceSpec({ ...s, status }); break; }
    case 'implementation': { const s = loadImplementationSpec(id); if (s) saveImplementationSpec({ ...s, status }); break; }
  }
}

/**
 * Snapshot the raw bytes of every spec file under .wai/specs. Paired with
 * restoreSpecFiles() to give a byte-exact revert — used by `wairon lock` to
 * dry-run a promotion (write 'complete' → validate → restore) without leaving
 * any change behind if validation fails or the user cancels.
 */
export function snapshotSpecFiles(): Map<string, string> {
  const index = scanAllSpecs();
  const snapshot = new Map<string, string>();
  const files = new Set<string>();

  const sysPath = AI_PATHS.specsSystem();
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

/** Restore files captured by snapshotSpecFiles(). Caller invalidates the cache. */
export function restoreSpecFiles(snapshot: Map<string, string>): void {
  for (const [file, content] of snapshot) {
    fs.writeFileSync(file, content);
  }
}

/** Helper to clean up empty parent directories up to `.wai/specs` folder */
function cleanEmptyDirs(filePath: string): void {
  let dir = path.dirname(filePath);
  const specsRoot = path.resolve(AI_PATHS.specsDir());
  while (dir !== specsRoot && dir.startsWith(specsRoot)) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    } else {
      break;
    }
  }
}

export function deleteSubsystemSpec(id: string): boolean {
  const p = getSubsystemPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

export function deleteComponentSpec(id: string): boolean {
  const p = getComponentPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

export function deleteInterfaceSpec(id: string): boolean {
  const p = getInterfacePath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

export function deleteImplementationSpec(id: string): boolean {
  const p = getImplementationPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

export function deleteTypeSpec(id: string): boolean {
  const spec = loadTypeSpec(id);
  const p = getTypePath(id, spec?.subsystem, spec?.group);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

// ---------------------------------------------------------------------------
// Groups (folders/categories for types) Loader/Writer
// ---------------------------------------------------------------------------
export function getGroupPath(id: string, subsystemId?: string): string {
  const index = scanAllSpecs();
  const { localId: plainId } = splitNamespace(id);
  if (index.paths.group[id]) return index.paths.group[id];
  if (index.paths.group[plainId]) return index.paths.group[plainId];

  if (id.includes('::')) {
    const parts = id.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingId = parts[parts.length - 1];
      const remainingSubsystem = subsystemId ? subsystemId.split('::').pop() : undefined;
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getGroupPath(remainingId, remainingSubsystem);
      } finally {
        setProjectRoot(prevOverride);
      }
    }
  }

  if (subsystemId && subsystemId.includes('::')) {
    const parts = subsystemId.split('::');
    const childProj = resolveSubprojectForNamespace(parts.slice(0, -1).join('::'));
    if (childProj) {
      const remainingSubsystem = parts[parts.length - 1];
      const prevOverride = getProjectRootOverride();
      setProjectRoot(childProj);
      try {
        return getGroupPath(id, remainingSubsystem);
      } finally {
        setProjectRoot(prevOverride);
      }
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
    const subPath = getSubsystemPath(subsystemId);
    const subDir = path.dirname(subPath);
    if (subPath.endsWith('.index.yaml')) {
      return path.join(subDir, 'types', localId, '.index.yaml');
    }
  }
  return path.join(AI_PATHS.specsTypesDir(), localId, '.index.yaml');
}

export function loadGroupSpecs(): GroupSpec[] {
  return scanAllSpecs().groups;
}

export function loadGroupSpec(id: string): GroupSpec | null {
  return scanAllSpecs().groups.find((g) => g.id === id) ?? null;
}

export function saveGroupSpec(spec: GroupSpec): void {
  const p = getGroupPath(spec.id);
  ensureDir(path.dirname(p));

  const { prefix } = splitNamespace(spec.id);
  const specToWrite = prefix ? stripNamespaceFromGroup(spec, prefix) : spec;

  const existing = loadGroupSpec(spec.id);
  if (existing) {
    specToWrite.createdAt = existing.createdAt;
  }
  specToWrite.updatedAt = new Date().toISOString();
  writeYamlFile(p, specToWrite);
  invalidateSpecCache();
}

export function deleteGroupSpec(id: string): boolean {
  const p = getGroupPath(id);
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  cleanEmptyDirs(p);
  invalidateSpecCache();
  return true;
}

function stripNamespaceFromGroup(spec: GroupSpec, prefix: string): GroupSpec {
  return {
    ...spec,
    id: stripNamespacePrefixes(spec.id, prefix),
  };
}

export function findLegacySpecFiles(): { path: string; expected: string }[] {
  const specsDir = AI_PATHS.specsDir();
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

export function updateSpec(
  kind: 'subsystem' | 'component' | 'interface' | 'implementation' | 'type',
  id: string,
  delta: Record<string, any>
): void {
  const result = (() => {
    switch (kind) {
      case 'subsystem':      return loadSubsystemSpec(id);
      case 'component':      return loadComponentSpec(id);
      case 'interface':      return loadInterfaceSpec(id);
      case 'implementation': return loadImplementationSpec(id);
      case 'type':           return loadTypeSpec(id);
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

  const mergeDelta = (existing: any, delta: any): any => {
    const res = { ...existing };
    for (const [key, value] of Object.entries(delta)) {
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

  switch (kind) {
    case 'subsystem':      saveSubsystemSpec(mergedResult); break;
    case 'component':      saveComponentSpec(mergedResult); break;
    case 'interface':      saveInterfaceSpec(mergedResult); break;
    case 'implementation': saveImplementationSpec(mergedResult); break;
    case 'type':           saveTypeSpec(mergedResult); break;
  }
}


