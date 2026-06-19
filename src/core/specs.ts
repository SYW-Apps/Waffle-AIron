import * as fs from 'fs';
import * as path from 'path';
import { AI_PATHS } from '../config/loader.js';
import { ensureDir, listFiles, listFilesRecursive, pathExists } from '../utils/fs.js';
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
  paths: {
    subsystem: Record<string, string>;
    component: Record<string, string>;
    interface: Record<string, string>;
    implementation: Record<string, string>;
    type: Record<string, string>;
  };
}

let cachedIndex: SpecIndex | null = null;

export function invalidateSpecCache(): void {
  cachedIndex = null;
}

export function scanAllSpecs(): SpecIndex {
  if (cachedIndex) return cachedIndex;

  const index: SpecIndex = {
    subsystems: [],
    components: [],
    interfaces: [],
    implementations: [],
    types: [],
    paths: {
      subsystem: {},
      component: {},
      interface: {},
      implementation: {},
      type: {},
    },
  };

  const specsDir = AI_PATHS.specsDir();
  if (!pathExists(specsDir)) return index;

  const files = listFilesRecursive(specsDir, '.yaml');
  const systemYaml = path.normalize(AI_PATHS.specsSystem());

  for (const file of files) {
    const normFile = path.normalize(file);
    if (normFile === systemYaml) continue; // skip L0 System Spec

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
        index.implementations.push(parsed);
        index.paths.implementation[parsed.id] = file;
      } else if ('kind' in raw) {
        detectedType = 'type';
        const parsed = TypeSpecSchema.parse(raw);
        index.types.push(parsed);
        index.paths.type[parsed.id] = file;
      }

      if (detectedType === 'spec') {
        loaderIssues.push({
          severity: 'error',
          code: 'UNKNOWN_SPEC_TYPE',
          message: `Spec file "${file}" does not match any recognized L1-L4 schema structure. Ensure required discriminator fields (e.g. parentSystem, componentType, component, or contract) are declared.`,
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

  cachedIndex = index;
  return index;
}

export function getSubsystemPath(id: string): string {
  const index = scanAllSpecs();
  if (index.paths.subsystem[id]) {
    return index.paths.subsystem[id];
  }
  if (pathExists(AI_PATHS.specsSubsystemsDir()) && listFiles(AI_PATHS.specsSubsystemsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsSubsystemsDir(), `${id}.yaml`);
  }
  return path.join(AI_PATHS.specsDir(), id, 'subsystem.yaml');
}

/**
 * The pattern component that owns `id` via its `owns` list (at most one — the
 * SHARED_OWNED_MEMBER rule forbids two owners), or null. An owned member nests
 * physically under its owner because the owner owns its *implementation*; an
 * interface/port reference uses `dependsOn` and stays a flat sibling instead.
 */
function findOwner(id: string, components: ComponentSpec[]): ComponentSpec | null {
  return components.find((c) => c.id !== id && (c.owns ?? []).includes(id)) ?? null;
}

export function getComponentPath(id: string, subsystemId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.component[id]) {
    return index.paths.component[id];
  }

  // Owned members nest one level deep inside their owning pattern's folder
  // (patterns never own patterns, so it is exactly one level).
  const owner = findOwner(id, index.components);
  if (owner) {
    const ownerPath = index.paths.component[owner.id];
    if (ownerPath && ownerPath.endsWith('component.yaml')) {
      return path.join(path.dirname(ownerPath), id, 'component.yaml');
    }
  }

  if (subsystemId) {
    const subPath = getSubsystemPath(subsystemId);
    const subDir = path.dirname(subPath);
    if (subPath.endsWith('subsystem.yaml')) {
      return path.join(subDir, id, 'component.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsComponentsDir()) && listFiles(AI_PATHS.specsComponentsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsComponentsDir(), `${id}.yaml`);
  }

  const targetSubsystem = subsystemId || 'default';
  return path.join(AI_PATHS.specsDir(), targetSubsystem, id, 'component.yaml');
}

export function getInterfacePath(id: string, componentId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.interface[id]) {
    return index.paths.interface[id];
  }

  if (componentId) {
    const compPath = getComponentPath(componentId);
    const compDir = path.dirname(compPath);
    if (compPath.endsWith('component.yaml')) {
      return path.join(compDir, 'interface.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsInterfacesDir()) && listFiles(AI_PATHS.specsInterfacesDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsInterfacesDir(), `${id}.yaml`);
  }

  const targetComponent = componentId || 'default';
  return path.join(AI_PATHS.specsDir(), 'default', targetComponent, 'interface.yaml');
}

export function getImplementationPath(id: string, contractId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.implementation[id]) {
    return index.paths.implementation[id];
  }

  if (contractId) {
    const intfPath = getInterfacePath(contractId);
    const intfDir = path.dirname(intfPath);
    if (intfPath.endsWith('interface.yaml')) {
      return path.join(intfDir, 'implementation.yaml');
    }
  }

  if (pathExists(AI_PATHS.specsImplementationsDir()) && listFiles(AI_PATHS.specsImplementationsDir(), '.yaml').length > 0) {
    return path.join(AI_PATHS.specsImplementationsDir(), `${id}.yaml`);
  }

  const targetContract = contractId ? contractId.replace(/^i/, '') : 'default';
  return path.join(AI_PATHS.specsDir(), 'default', targetContract, 'implementation.yaml');
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
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
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
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
  invalidateSpecCache();
  // Keep the physical layout in sync with ownership: nest owned members under
  // their pattern, and move anything an `owns` change has displaced.
  normalizeComponentLayout();
}

/** The directory a component's folder should live in, given current ownership. */
function desiredComponentDir(comp: ComponentSpec, index: SpecIndex): string | null {
  const currentPath = index.paths.component[comp.id];
  // Only the nested-tree layout is normalized (skip the legacy flat components/ dir).
  if (!currentPath || !currentPath.endsWith('component.yaml')) return null;

  const owner = findOwner(comp.id, index.components);
  if (owner) {
    const ownerPath = index.paths.component[owner.id];
    if (ownerPath && ownerPath.endsWith('component.yaml')) {
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
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
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
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Types (entities / value objects) Loader/Writer
//
// Entities/value objects live in a `types/` directory — at the subsystem that
// owns them, or at the system level for shared value objects.
// ---------------------------------------------------------------------------
export function getTypePath(id: string, subsystemId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.type[id]) return index.paths.type[id];

  if (subsystemId) {
    const subPath = getSubsystemPath(subsystemId);
    const subDir = path.dirname(subPath);
    if (subPath.endsWith('subsystem.yaml')) {
      return path.join(subDir, 'types', `${id}.yaml`);
    }
  }
  return path.join(AI_PATHS.specsTypesDir(), `${id}.yaml`);
}

export function loadTypeSpecs(): TypeSpec[] {
  return scanAllSpecs().types;
}

export function loadTypeSpec(id: string): TypeSpec | null {
  return scanAllSpecs().types.find((t) => t.id === id) ?? null;
}

export function saveTypeSpec(spec: TypeSpec): void {
  const p = getTypePath(spec.id, spec.subsystem);
  ensureDir(path.dirname(p));
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
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
export function collectPromotableSpecs(): PromotableSpec[] {
  const out: PromotableSpec[] = [];
  for (const s of loadSubsystemSpecs())      if (s.status !== 'complete') out.push({ kind: 'subsystem', id: s.id, status: (s.status ?? 'complete') as SpecStatus });
  for (const c of loadComponentSpecs())      if (c.status !== 'complete') out.push({ kind: 'component', id: c.id, status: (c.status ?? 'complete') as SpecStatus });
  for (const i of loadInterfaceSpecs())      if (i.status !== 'complete') out.push({ kind: 'interface', id: i.id, status: (i.status ?? 'complete') as SpecStatus });
  for (const m of loadImplementationSpecs()) if (m.status !== 'complete') out.push({ kind: 'implementation', id: m.id, status: (m.status ?? 'complete') as SpecStatus });
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
  const root = path.dirname(AI_PATHS.specsSystem());
  const snapshot = new Map<string, string>();
  if (!pathExists(root)) return snapshot;
  for (const file of listFilesRecursive(root, '.yaml')) {
    snapshot.set(file, fs.readFileSync(file, 'utf8'));
  }
  return snapshot;
}

/** Restore files captured by snapshotSpecFiles(). Caller invalidates the cache. */
export function restoreSpecFiles(snapshot: Map<string, string>): void {
  for (const [file, content] of snapshot) {
    fs.writeFileSync(file, content);
  }
}


