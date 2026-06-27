import * as path from 'path';
import { aiDir, pathExists, fromProjectRoot } from '../utils/fs.js';
import { readYamlFile, writeYamlFile } from '../utils/yaml.js';
import { ProjectNotInitializedError, WaironError } from '../utils/errors.js';
import {
  ProjectConfig,
  ProjectConfigSchema,
  Registry,
  createEmptyRegistry,
  TopologyConfig,
  TopologyConfigSchema,
  createEmptyTopologyConfig,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Paths within the .wai/ directory
// ---------------------------------------------------------------------------

export const AI_PATHS = {
  root: () => aiDir(),
  projectConfig: () => aiDir('project.yaml'),
  topologyConfig: () => aiDir('topology.yaml'),
  templatesDir: () => aiDir('templates'),
  rulesDir: () => aiDir('rules'),
  docsDir: () => aiDir('docs'),
  generatedDir: () => aiDir('generated'),
  contextDir: () => aiDir('context'),
  contextProjectMd: () => aiDir('context', 'project.md'),
  contextArchitectureMd: () => aiDir('context', 'architecture.md'),
  contextDomainsMd: () => aiDir('context', 'domains.md'),
  contextWaironGuideMd: () => aiDir('context', 'wairon-guide.md'),
  specsDir: () => {
    try {
      const projConfig = aiDir('project.yaml');
      if (pathExists(projConfig)) {
        const raw = readYamlFile(projConfig) as any;
        if (raw && raw.paths && raw.paths.specsDir) {
          return fromProjectRoot(raw.paths.specsDir);
        }
      }
    } catch {
      // ignore and fallback
    }
    return aiDir('specs');
  },
  specsSystem: () => path.join(AI_PATHS.specsDir(), '.system.yaml'),
  specsSubsystemsDir: () => path.join(AI_PATHS.specsDir(), 'subsystems'),
  specsComponentsDir: () => path.join(AI_PATHS.specsDir(), 'components'),
  specsInterfacesDir: () => path.join(AI_PATHS.specsDir(), 'interfaces'),
  specsImplementationsDir: () => path.join(AI_PATHS.specsDir(), 'implementations'),
  specsTypesDir: () => path.join(AI_PATHS.specsDir(), 'types'),
} as const;

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

/**
 * Check whether the current directory has been initialized as a wairon project.
 */
export function isProjectInitialized(): boolean {
  return pathExists(AI_PATHS.root()) && pathExists(AI_PATHS.projectConfig());
}

/**
 * Assert the project has been initialized, throwing a clear error if not.
 */
export function assertProjectInitialized(): void {
  if (!isProjectInitialized()) {
    throw new ProjectNotInitializedError();
  }
}

/**
 * Load and validate the project config from .wai/project.yaml.
 */
export function loadProjectConfig(): ProjectConfig {
  assertProjectInitialized();
  const raw = readYamlFile(AI_PATHS.projectConfig());
  try {
    return ProjectConfigSchema.parse(raw);
  } catch (e: unknown) {
    throw new WaironError(`Invalid .wai/project.yaml: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Write the project config to .wai/project.yaml.
 */
export function saveProjectConfig(config: ProjectConfig): void {
  writeYamlFile(AI_PATHS.projectConfig(), config);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Resolve the agent registry. The SDD spec tree (.wai/specs/) is the single
 * source of truth for agents — the topology is always derived from it via
 * resolveAgentTopology(), never read from a hand-maintained agents.json.
 * Returns an empty registry when no system spec exists yet.
 */
export function loadRegistry(): Registry {
  assertProjectInitialized();
  if (!pathExists(AI_PATHS.specsSystem())) return createEmptyRegistry();
  const { resolveAgentTopology } = require('../core/agent_resolver.js') as typeof import('../core/agent_resolver.js');
  return {
    schemaVersion: '1.0.0',
    agents: resolveAgentTopology(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Topology config (free-standing domains) — .wai/topology.yaml
//
// Spec-backed domains are derived from the spec tree at read time and are NOT
// stored here. This file holds only free-standing (cross-cutting) domains.
// ---------------------------------------------------------------------------

export function loadTopologyConfig(): TopologyConfig {
  assertProjectInitialized();
  if (!pathExists(AI_PATHS.topologyConfig())) return createEmptyTopologyConfig();
  const raw = readYamlFile(AI_PATHS.topologyConfig());
  if (!raw) return createEmptyTopologyConfig();
  return TopologyConfigSchema.parse(raw);
}

export function saveTopologyConfig(config: TopologyConfig): void {
  writeYamlFile(AI_PATHS.topologyConfig(), config);
}
