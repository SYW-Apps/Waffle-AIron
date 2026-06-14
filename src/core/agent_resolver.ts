import * as path from 'path';
import { AgentRecord } from '../models/agent.js';
import { loadProjectConfig, AI_PATHS } from '../config/loader.js';
import {
  loadSystemSpec,
  loadSubsystemSpecs,
  loadComponentSpecs,
  loadInterfaceSpecs,
  loadImplementationSpecs,
  getSubsystemPath,
  getComponentPath,
  getInterfacePath,
  getImplementationPath,
} from './specs.js';

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

  const config = loadProjectConfig();
  const activeTargets = config.targets
    .filter((t) => !('enabled' in t) || t.enabled)
    .map((t) => typeof t === 'string' ? t : t.type) as AgentRecord['targets'];

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
    targets: activeTargets,
    createdAt: system.createdAt,
    updatedAt: system.updatedAt,
  });

  // 2. Subsystem Owners (Domain Owners)
  for (const sub of subsystems) {
    const subComponents = components.filter((c) => c.subsystem === sub.id);

    const ownedPaths: string[] = [];
    // Subsystem Owners own subsystem specification and component specifications under their domain
    ownedPaths.push(path.relative(process.cwd(), getSubsystemPath(sub.id)).replace(/\\/g, '/'));
    for (const c of subComponents) {
      ownedPaths.push(path.relative(process.cwd(), getComponentPath(c.id, sub.id)).replace(/\\/g, '/'));
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
      targets: activeTargets,
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
      path.relative(process.cwd(), AI_PATHS.specsSystem()).replace(/\\/g, '/'),
      path.relative(process.cwd(), getComponentPath(comp.id, comp.subsystem)).replace(/\\/g, '/'),
      ...compInterfaces.map((i) => path.relative(process.cwd(), getInterfacePath(i.id, comp.id)).replace(/\\/g, '/')),
      ...compImpls.map((impl) => path.relative(process.cwd(), getImplementationPath(impl.id, impl.contract)).replace(/\\/g, '/')),
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
      targets: activeTargets,
      createdAt: comp.createdAt,
      updatedAt: comp.updatedAt,
    });
  }

  return agents;
}
