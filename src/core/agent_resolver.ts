import * as path from 'path';
import * as fs from 'fs';
import { AgentRecord } from '../models/agent.js';
import { loadProjectConfig, AI_PATHS, loadTopologyConfig } from '../config/loader.js';
import { getProjectRoot, pathExists } from '../utils/fs.js';
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
  resolveSubprojectForNamespace,
} from './specs.js';
import { ComponentSpec } from '../models/specs.js';

// Cache for project files relative to the system root
const projectFilesCache = new Map<string, string[]>();

function listFilesRecursiveSafe(dirPath: string, ext: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  const nameLower = path.basename(dirPath).toLowerCase();
  const IGNORED_DIRS = new Set([
    'node_modules',
    'target',
    'dist',
    'build',
    '.git',
    '.wai',
    '.claude',
    '.gemini',
    '.codex',
    '.agents',
    '.vscode',
  ]);
  if (IGNORED_DIRS.has(nameLower)) return [];

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursiveSafe(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

function getProjectFiles(projectDir: string): string[] {
  let files = projectFilesCache.get(projectDir);
  if (!files) {
    files = [];
    const srcDir = path.join(projectDir, 'src');
    const legacySrcDir = path.join(projectDir, 'legacy-src');
    
    let searchDir = projectDir;
    if (pathExists(srcDir)) {
      searchDir = srcDir;
    } else if (pathExists(legacySrcDir)) {
      searchDir = legacySrcDir;
    } else if (projectDir === getProjectRoot()) {
      // Avoid scanning the entire monorepo root recursively
      projectFilesCache.set(projectDir, []);
      return [];
    }
    
    const extensions = ['.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.c', '.cpp', '.cs', '.java', '.kt', '.swift', '.rb', '.php', '.lua'];
    for (const ext of extensions) {
      files.push(...listFilesRecursiveSafe(searchDir, ext));
    }
    const rootDir = getProjectRoot();
    files = files.map(f => path.relative(rootDir, f).replace(/\\/g, '/'));
    projectFilesCache.set(projectDir, files);
  }
  return files;
}

function inferSourcePathForComponent(comp: ComponentSpec, subsystems: any[]): string | null {
  try {
    const projectDir = resolveSubprojectForNamespace(comp.subsystem) || getProjectRoot();
    const files = getProjectFiles(projectDir);
    if (files.length === 0) return null;

    const compRelativeId = comp.id.split('::').pop() || comp.id;
    const subRelativeId = comp.subsystem.split('::').pop() || comp.subsystem;

    let cleanName = compRelativeId;
    if (cleanName.startsWith(`${subRelativeId}-`)) {
      cleanName = cleanName.slice(subRelativeId.length + 1);
    }

    const candidates = new Set<string>();
    candidates.add(cleanName.toLowerCase());
    candidates.add(cleanName.replace(/-/g, '_').toLowerCase());
    candidates.add(compRelativeId.toLowerCase());
    candidates.add(compRelativeId.replace(/-/g, '_').toLowerCase());
    candidates.add(comp.componentType.toLowerCase());

    let bestFile: string | null = null;
    let bestScore = -1;

    for (const f of files) {
      const ext = path.extname(f);
      const base = path.basename(f, ext).toLowerCase();
      if (candidates.has(base)) {
        let score = 0;
        const normalizedPath = f.toLowerCase();
        
        // Match directory to subsystem name or its segments
        const subPattern1 = `/${subRelativeId.toLowerCase()}/`;
        const subPattern2 = `/${subRelativeId.replace(/-/g, '_').toLowerCase()}/`;
        const hasSubsystemSegmentMatch = subRelativeId
          .split(/[-_]/)
          .some((seg: string) => seg.length >= 3 && normalizedPath.includes(`/${seg.toLowerCase()}/`));

        const hasSubsystemMatch = normalizedPath.includes(subPattern1) || 
                                  normalizedPath.includes(subPattern2) || 
                                  hasSubsystemSegmentMatch;

        if (hasSubsystemMatch) {
          score += 10;
        }

        // Deduct points or skip if file belongs to another subsystem folder
        let belongsToOtherSubsystem = false;
        for (const otherSub of subsystems) {
          if (otherSub.id === comp.subsystem) continue;
          const otherSubRelativeId = otherSub.id.split('::').pop() || otherSub.id;
          const otherPattern1 = `/${otherSubRelativeId.toLowerCase()}/`;
          const otherPattern2 = `/${otherSubRelativeId.replace(/-/g, '_').toLowerCase()}/`;
          const otherSegmentMatch = otherSubRelativeId
            .split(/[-_]/)
            .some((seg: string) => seg.length >= 3 && normalizedPath.includes(`/${seg.toLowerCase()}/`));

          if (normalizedPath.includes(otherPattern1) || 
              normalizedPath.includes(otherPattern2) || 
              otherSegmentMatch) {
            belongsToOtherSubsystem = true;
            break;
          }
        }
        if (belongsToOtherSubsystem) {
          continue; // Skip this file because it belongs to another subsystem
        }

        // Exact match of clean name
        const isCleanNameMatch = base === cleanName.toLowerCase() || base === cleanName.replace(/-/g, '_').toLowerCase();
        if (isCleanNameMatch) {
          score += 5;
        }

        // Exact match of component ID
        const isIdMatch = base === compRelativeId.toLowerCase() || base === compRelativeId.replace(/-/g, '_').toLowerCase();
        if (isIdMatch) {
          score += 3;
        }

        // A specific name match means it matches the clean name and that clean name is not just the generic component type
        const isSpecificNameMatch = isCleanNameMatch && cleanName.toLowerCase() !== comp.componentType.toLowerCase();

        // Reject matches that don't have any specific relation to the component or subsystem
        if (!hasSubsystemMatch && !isSpecificNameMatch && !isIdMatch) {
          continue;
        }

        // Under src or legacy-src folder
        if (normalizedPath.startsWith('src/') || normalizedPath.includes('/src/') ||
            normalizedPath.startsWith('legacy-src/') || normalizedPath.includes('/legacy-src/')) {
          score += 2;
        }

        // Match component type suffix
        if (base === comp.componentType.toLowerCase()) {
          score += 1;
        }

        if (score > bestScore) {
          bestScore = score;
          bestFile = f;
        }
      }
    }

    return bestFile;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Topology Resolver: Translates SDD Spec Tree into Agent Topology
// ---------------------------------------------------------------------------
export function resolveAgentTopology(): AgentRecord[] {
  projectFilesCache.clear();

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
    ownedPaths.push(path.relative(getProjectRoot(), getSubsystemPath(sub.id)).replace(/\\/g, '/'));
    for (const c of subComponents) {
      ownedPaths.push(path.relative(getProjectRoot(), getComponentPath(c.id, sub.id)).replace(/\\/g, '/'));
    }

    if (!config.rules.generateComponentImplementers) {
      // Aggregate all component implementation source paths under the subsystem owner
      for (const comp of subComponents) {
        // Find contract interfaces for this component
        const compInterfaces = interfaces.filter((i) => i.component === comp.id);
        const compInterfaceIds = compInterfaces.map((i) => i.id);

        // Find implementations of those contracts
        const compImpls = implementations.filter((impl) => compInterfaceIds.includes(impl.contract));

        for (const impl of compImpls) {
          if (impl.sourcePath) {
            ownedPaths.push(impl.sourcePath);
          }
        }

        const inferred = inferSourcePathForComponent(comp, subsystems);
        if (inferred && !ownedPaths.includes(inferred)) {
          ownedPaths.push(inferred);
        }
      }
    }

    let dependencies: string[] = [];
    if (config.rules.generateComponentImplementers) {
      dependencies = subComponents.map((c) => `${c.id}-implementer`);
    } else {
      // Subsystem depends on other subsystem owners that its components depend on
      const depSubsystems = new Set<string>();
      for (const c of subComponents) {
        for (const depId of c.dependsOn) {
          const depComp = components.find((other) => other.id === depId);
          if (depComp && depComp.subsystem !== sub.id) {
            depSubsystems.add(`${depComp.subsystem}-owner`);
          }
        }
      }
      dependencies = Array.from(depSubsystems);
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
      dependencies,
      status: 'active',
      targets: activeTargets,
      createdAt: sub.createdAt,
      updatedAt: sub.updatedAt,
    });
  }

  // 3. Component Implementers
  if (config.rules.generateComponentImplementers) {
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

      if (ownedPaths.length === 0) {
        const inferred = inferSourcePathForComponent(comp, subsystems);
        if (inferred) {
          ownedPaths.push(inferred);
        }
      }

      const dependencies = comp.dependsOn.map((depId) => `${depId}-implementer`);

      // An implementer needs to read specs, interfaces, and direct dependency component files
      const readPaths = [
        path.relative(getProjectRoot(), AI_PATHS.specsSystem()).replace(/\\/g, '/'),
        path.relative(getProjectRoot(), getComponentPath(comp.id, comp.subsystem)).replace(/\\/g, '/'),
        ...compInterfaces.map((i) => path.relative(getProjectRoot(), getInterfacePath(i.id, comp.id)).replace(/\\/g, '/')),
        ...compImpls.map((impl) => path.relative(getProjectRoot(), getImplementationPath(impl.id, impl.contract)).replace(/\\/g, '/')),
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
  }


  // 4. Free-standing domain owners (declared in .wai/topology.yaml)
  const now = new Date().toISOString();
  for (const dom of loadTopologyConfig().domains) {
    agents.push({
      id: `${dom.id}-owner`,
      name: `${dom.name ?? dom.id} Owner`,
      description: dom.description ?? `Owner agent for the free-standing "${dom.id}" domain.`,
      template: 'domain-owner',
      creationReason: 'Inferred from a free-standing domain in .wai/topology.yaml',
      domainRoot: dom.id,
      ownedPaths: dom.ownedPaths,
      readPaths: ['**'],
      writePaths: dom.ownedPaths,
      tags: ['owner', 'domain'],
      dependencies: [],
      status: 'active',
      targets: activeTargets,
      createdAt: now,
      updatedAt: now,
    });
  }

  return agents;
}
