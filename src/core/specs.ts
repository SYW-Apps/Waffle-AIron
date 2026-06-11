import * as path from 'path';
import { AI_PATHS } from '../config/loader.js';
import { ensureDir, listFiles, pathExists } from '../utils/fs.js';
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
}

export function getSubsystemPath(id: string): string {
  return path.join(AI_PATHS.specsSubsystemsDir(), `${id}.yaml`);
}

export function getComponentPath(id: string): string {
  return path.join(AI_PATHS.specsComponentsDir(), `${id}.yaml`);
}

export function getInterfacePath(id: string): string {
  return path.join(AI_PATHS.specsInterfacesDir(), `${id}.yaml`);
}

export function getImplementationPath(id: string): string {
  return path.join(AI_PATHS.specsImplementationsDir(), `${id}.yaml`);
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
}

// ---------------------------------------------------------------------------
// Level 1: Subsystem Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadSubsystemSpecs(): SubsystemSpec[] {
  const dir = AI_PATHS.specsSubsystemsDir();
  const files = listFiles(dir, '.yaml');
  const specs: SubsystemSpec[] = [];
  for (const file of files) {
    try {
      const raw = readYamlFile(file);
      if (raw === null) continue;
      specs.push(SubsystemSpecSchema.parse(raw));
    } catch (e: any) {
      loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse subsystem spec: ${e.message || String(e)}`,
        specId: path.basename(file, '.yaml'),
      });
    }
  }
  return specs;
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
}

// ---------------------------------------------------------------------------
// Level 2: Component Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadComponentSpecs(): ComponentSpec[] {
  const dir = AI_PATHS.specsComponentsDir();
  const files = listFiles(dir, '.yaml');
  const specs: ComponentSpec[] = [];
  for (const file of files) {
    try {
      const raw = readYamlFile(file);
      if (raw === null) continue;
      specs.push(ComponentSpecSchema.parse(raw));
    } catch (e: any) {
      loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse component spec: ${e.message || String(e)}`,
        specId: path.basename(file, '.yaml'),
      });
    }
  }
  return specs;
}

export function loadComponentSpec(id: string): ComponentSpec | null {
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
  const p = getComponentPath(spec.id);
  ensureDir(path.dirname(p));
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
}

// ---------------------------------------------------------------------------
// Level 3: Interface Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadInterfaceSpecs(): InterfaceSpec[] {
  const dir = AI_PATHS.specsInterfacesDir();
  const files = listFiles(dir, '.yaml');
  const specs: InterfaceSpec[] = [];
  for (const file of files) {
    try {
      const raw = readYamlFile(file);
      if (raw === null) continue;
      specs.push(InterfaceSpecSchema.parse(raw));
    } catch (e: any) {
      loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse interface spec: ${e.message || String(e)}`,
        specId: path.basename(file, '.yaml'),
      });
    }
  }
  return specs;
}

export function loadInterfaceSpec(id: string): InterfaceSpec | null {
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
  const p = getInterfacePath(spec.id);
  ensureDir(path.dirname(p));
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
}

// ---------------------------------------------------------------------------
// Level 4: Implementation Spec Loader/Writer
// ---------------------------------------------------------------------------
export function loadImplementationSpecs(): ImplementationSpec[] {
  const dir = AI_PATHS.specsImplementationsDir();
  const files = listFiles(dir, '.yaml');
  const specs: ImplementationSpec[] = [];
  for (const file of files) {
    try {
      const raw = readYamlFile(file);
      if (raw === null) continue;
      specs.push(ImplementationSpecSchema.parse(raw));
    } catch (e: any) {
      loaderIssues.push({
        severity: 'error',
        code: 'SCHEMA_VALIDATION_ERROR',
        message: `Failed to parse implementation spec: ${e.message || String(e)}`,
        specId: path.basename(file, '.yaml'),
      });
    }
  }
  return specs;
}

export function loadImplementationSpec(id: string): ImplementationSpec | null {
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
  const p = getImplementationPath(spec.id);
  ensureDir(path.dirname(p));
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
}


