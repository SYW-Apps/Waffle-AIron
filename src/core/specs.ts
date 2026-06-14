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
  paths: {
    subsystem: Record<string, string>;
    component: Record<string, string>;
    interface: Record<string, string>;
    implementation: Record<string, string>;
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
    paths: {
      subsystem: {},
      component: {},
      interface: {},
      implementation: {},
    },
  };

  const specsDir = AI_PATHS.specsDir();
  if (!pathExists(specsDir)) return index;

  const files = listFilesRecursive(specsDir, '.yaml');
  const systemYaml = path.normalize(AI_PATHS.specsSystem());

  for (const file of files) {
    const normFile = path.normalize(file);
    if (normFile === systemYaml) continue; // skip L0 System Spec

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

      let matched = false;
      if ('parentSystem' in raw) {
        matched = true;
        const parsed = SubsystemSpecSchema.parse(raw);
        index.subsystems.push(parsed);
        index.paths.subsystem[parsed.id] = file;
      } else if ('componentType' in raw) {
        matched = true;
        const parsed = ComponentSpecSchema.parse(raw);
        index.components.push(parsed);
        index.paths.component[parsed.id] = file;
      } else if ('component' in raw) {
        matched = true;
        const parsed = InterfaceSpecSchema.parse(raw);
        index.interfaces.push(parsed);
        index.paths.interface[parsed.id] = file;
      } else if ('contract' in raw) {
        matched = true;
        const parsed = ImplementationSpecSchema.parse(raw);
        index.implementations.push(parsed);
        index.paths.implementation[parsed.id] = file;
      }

      if (!matched) {
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
        message: `Failed to parse spec file "${file}": ${e.message || String(e)}`,
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

export function getComponentPath(id: string, subsystemId?: string): string {
  const index = scanAllSpecs();
  if (index.paths.component[id]) {
    return index.paths.component[id];
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


