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
  AgentRecord,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Path Builders
// ---------------------------------------------------------------------------
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
  const raw = readYamlFile(p);
  return SystemSpecSchema.parse(raw);
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
      specs.push(SubsystemSpecSchema.parse(raw));
    } catch (e) {
      // Skip or warn
    }
  }
  return specs;
}

export function loadSubsystemSpec(id: string): SubsystemSpec | null {
  const p = getSubsystemPath(id);
  if (!pathExists(p)) return null;
  const raw = readYamlFile(p);
  return SubsystemSpecSchema.parse(raw);
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
      specs.push(ComponentSpecSchema.parse(raw));
    } catch (e) {
      // Skip
    }
  }
  return specs;
}

export function loadComponentSpec(id: string): ComponentSpec | null {
  const p = getComponentPath(id);
  if (!pathExists(p)) return null;
  const raw = readYamlFile(p);
  return ComponentSpecSchema.parse(raw);
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
      specs.push(InterfaceSpecSchema.parse(raw));
    } catch (e) {
      // Skip
    }
  }
  return specs;
}

export function loadInterfaceSpec(id: string): InterfaceSpec | null {
  const p = getInterfacePath(id);
  if (!pathExists(p)) return null;
  const raw = readYamlFile(p);
  return InterfaceSpecSchema.parse(raw);
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
      specs.push(ImplementationSpecSchema.parse(raw));
    } catch (e) {
      // Skip
    }
  }
  return specs;
}

export function loadImplementationSpec(id: string): ImplementationSpec | null {
  const p = getImplementationPath(id);
  if (!pathExists(p)) return null;
  const raw = readYamlFile(p);
  return ImplementationSpecSchema.parse(raw);
}

export function saveImplementationSpec(spec: ImplementationSpec): void {
  const p = getImplementationPath(spec.id);
  ensureDir(path.dirname(p));
  spec.updatedAt = new Date().toISOString();
  writeYamlFile(p, spec);
}

// ---------------------------------------------------------------------------
// Topology Resolver: Translates SDD Spec Tree into Agent Topology
// ---------------------------------------------------------------------------
export function resolveAgentTopology(): AgentRecord[] {
  const system = loadSystemSpec();
  if (!system) return [];

  const subsystems = loadSubsystemSpecs();
  const components = loadComponentSpecs();
  const interfaces = loadInterfaceSpecs();
  const implementations = loadImplementationSpecs();

  const agents: AgentRecord[] = [];

  // 1. Global System Architect
  agents.push({
    id: 'system-architect',
    name: `${system.name} Architect`,
    description: `Global architect for ${system.name}. Vision: ${system.vision}`,
    template: 'architect',
    creationReason: 'Automatically inferred from L0 system spec',
    ownedPaths: ['.wai/specs/**'],
    readPaths: ['**'],
    writePaths: ['.wai/specs/**'],
    tags: ['architect', 'global', 'sdd'],
    dependencies: subsystems.map((s) => `${s.id}-owner`),
    status: 'active',
    targets: ['claude'],
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
  });

  // 2. Subsystem Owners (Domain Owners)
  for (const sub of subsystems) {
    const subComponents = components.filter((c) => c.subsystem === sub.id);
    const subCompIds = subComponents.map((c) => c.id);
    const subImpls = implementations.filter((impl) => {
      const contract = interfaces.find((i) => i.id === impl.contract);
      return contract && subCompIds.includes(contract.component);
    });

    const ownedPaths: string[] = [];
    for (const impl of subImpls) {
      if (impl.sourcePath) ownedPaths.push(impl.sourcePath);
    }
    // Add spec files path as owned too
    ownedPaths.push(`.wai/specs/subsystems/${sub.id}.yaml`);
    for (const c of subComponents) {
      ownedPaths.push(`.wai/specs/components/${c.id}.yaml`);
    }

    agents.push({
      id: `${sub.id}-owner`,
      name: `${sub.name} Owner`,
      description: `Domain owner responsible for subsystem: ${sub.description}`,
      template: 'domain-owner',
      creationReason: `Automatically inferred from L1 subsystem spec: ${sub.id}`,
      domainRoot: sub.id,
      ownedPaths,
      readPaths: ['**'],
      writePaths: ownedPaths,
      tags: ['owner', 'domain', 'sdd'],
      dependencies: subComponents.map((c) => `${c.id}-implementer`),
      status: 'active',
      targets: ['claude'],
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    });
  }

  // 3. Component Implementers
  for (const comp of components) {
    // Find contract interfaces for this component
    const compInterfaces = interfaces.filter((i) => i.component === comp.id);
    const compInterfaceIds = compInterfaces.map((i) => i.id);

    // Find implementations of those contracts
    const compImpls = implementations.filter((impl) => compInterfaceIds.includes(impl.contract));

    const ownedPaths: string[] = [];
    for (const impl of compImpls) {
      if (impl.sourcePath) ownedPaths.push(impl.sourcePath);
    }

    const dependencies = comp.dependencies.map((depId) => `${depId}-implementer`);

    // An implementer needs to read specs, interfaces, and direct dependency component files
    const readPaths = [
      '.wai/specs/system.yaml',
      `.wai/specs/components/${comp.id}.yaml`,
      ...compInterfaces.map((i) => `.wai/specs/interfaces/${i.id}.yaml`),
      ...compImpls.map((impl) => `.wai/specs/implementations/${impl.id}.yaml`),
    ];

    agents.push({
      id: `${comp.id}-implementer`,
      name: `${comp.name} Implementer`,
      description: `Developer agent implementing ${comp.name} (${comp.componentType})`,
      template: 'implementer',
      creationReason: `Automatically inferred from L2 component spec: ${comp.id}`,
      domainRoot: comp.subsystem,
      ownedPaths,
      readPaths,
      writePaths: ownedPaths,
      tags: ['implementer', 'component', 'sdd', comp.componentType.toLowerCase()],
      dependencies,
      status: 'active',
      targets: ['claude'],
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
    });
  }

  return agents;
}
