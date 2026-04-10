import { aiDir, pathExists } from '../utils/fs.js';
import { readJsonFile, readYamlFile, writeJsonFile, writeYamlFile } from '../utils/yaml.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import {
  ProjectConfig,
  ProjectConfigSchema,
  Registry,
  RegistrySchema,
  createEmptyRegistry,
  DomainRegistry,
  DomainRegistrySchema,
  createEmptyDomainRegistry,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Paths within the .ai/ directory
// ---------------------------------------------------------------------------

export const AI_PATHS = {
  root: () => aiDir(),
  projectConfig: () => aiDir('project.yaml'),
  registryDir: () => aiDir('registry'),
  agentsRegistry: () => aiDir('registry', 'agents.json'),
  domainsRegistry: () => aiDir('registry', 'domains.json'),
  templatesDir: () => aiDir('templates'),
  bundlesDir: () => aiDir('bundles'),
  rulesDir: () => aiDir('rules'),
  docsDir: () => aiDir('docs'),
  generatedDir: () => aiDir('generated'),
  jobsDir: () => aiDir('jobs'),
} as const;

// ---------------------------------------------------------------------------
// Project config
// ---------------------------------------------------------------------------

/**
 * Check whether the current directory has been initialized as a waffagent project.
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
 * Load and validate the project config from .ai/project.yaml.
 */
export function loadProjectConfig(): ProjectConfig {
  assertProjectInitialized();
  const raw = readYamlFile(AI_PATHS.projectConfig());
  return ProjectConfigSchema.parse(raw);
}

/**
 * Write the project config to .ai/project.yaml.
 */
export function saveProjectConfig(config: ProjectConfig): void {
  writeYamlFile(AI_PATHS.projectConfig(), config);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Load and validate the agent registry from .ai/registry/agents.json.
 * Returns an empty registry if the file doesn't exist yet.
 */
export function loadRegistry(): Registry {
  assertProjectInitialized();
  const raw = readJsonFile(AI_PATHS.agentsRegistry());
  if (raw === null) return createEmptyRegistry();
  return RegistrySchema.parse(raw);
}

/**
 * Write the agent registry to .ai/registry/agents.json.
 */
export function saveRegistry(registry: Registry): void {
  registry.updatedAt = new Date().toISOString();
  writeJsonFile(AI_PATHS.agentsRegistry(), registry);
}

// ---------------------------------------------------------------------------
// Domain registry
// ---------------------------------------------------------------------------

/**
 * Load and validate the domain registry from .ai/registry/domains.json.
 */
export function loadDomainRegistry(): DomainRegistry {
  assertProjectInitialized();
  const raw = readJsonFile(AI_PATHS.domainsRegistry());
  if (raw === null) return createEmptyDomainRegistry();
  return DomainRegistrySchema.parse(raw);
}

/**
 * Write the domain registry to .ai/registry/domains.json.
 */
export function saveDomainRegistry(registry: DomainRegistry): void {
  registry.updatedAt = new Date().toISOString();
  writeJsonFile(AI_PATHS.domainsRegistry(), registry);
}
