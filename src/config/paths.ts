// ---------------------------------------------------------------------------
// Where the .wai/ directory keeps things.
//
// A path convention, not a responsibility: nineteen modules resolve their
// files through `aiPathsAt`/`AI_PATHS`, which is why this file belongs to no
// component — the same reason `src/utils/fs.ts` does not. Claiming it once
// made nineteen components owe a declared edge to it, an arrow that says
// "everything resolves paths" and tells a reader nothing.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../utils/fs.js';
import { ProjectNotInitializedError } from '../utils/errors.js';
import { projectConfigRepository, projectConfigRepositoryAt } from './project-config.js';

// ---------------------------------------------------------------------------
// Paths within the .wai/ directory
// ---------------------------------------------------------------------------

export interface WaiPaths {
  root: () => string;
  projectConfig: () => string;
  topologyConfig: () => string;
  templatesDir: () => string;
  rulesDir: () => string;
  docsDir: () => string;
  generatedDir: () => string;
  contextDir: () => string;
  contextProjectMd: () => string;
  contextArchitectureMd: () => string;
  contextDomainsMd: () => string;
  contextWaironGuideMd: () => string;
  specsDir: () => string;
  specsSystem: () => string;
  specsSubsystemsDir: () => string;
  specsComponentsDir: () => string;
  specsInterfacesDir: () => string;
  specsImplementationsDir: () => string;
  specsTypesDir: () => string;
}

/**
 * Build the .wai path accessors for an EXPLICIT project root. This is what the
 * spec workspace uses so nested subproject resolution never has to override the
 * global project root. AI_PATHS below stays the implicit-root convenience view.
 */
export function aiPathsAt(rootDir: string): WaiPaths {
  const resolvedRoot = path.resolve(rootDir);
  // .wai/ is primary; .wairon/ is the legacy fallback for older installs.
  const aiDirAt = (...segments: string[]): string => {
    const waiPath = path.join(resolvedRoot, '.wai');
    const waironPath = path.join(resolvedRoot, '.wairon');
    const base = !fs.existsSync(waiPath) && fs.existsSync(waironPath) ? waironPath : waiPath;
    return path.join(base, ...segments);
  };
  // Where the specs live is configuration (`paths.specsDir`, else .wai/specs), so it
  // is resolved through the project config Repository bound to THIS root. Its index
  // never throws, and still reads the folder from a configuration that fails the schema.
  const specsDir = (): string => projectConfigRepositoryAt(resolvedRoot).specsDir();
  return {
    root: () => aiDirAt(),
    projectConfig: () => aiDirAt('project.yaml'),
    topologyConfig: () => aiDirAt('topology.yaml'),
    templatesDir: () => aiDirAt('templates'),
    rulesDir: () => aiDirAt('rules'),
    docsDir: () => aiDirAt('docs'),
    generatedDir: () => aiDirAt('generated'),
    contextDir: () => aiDirAt('context'),
    contextProjectMd: () => aiDirAt('context', 'project.md'),
    contextArchitectureMd: () => aiDirAt('context', 'architecture.md'),
    contextDomainsMd: () => aiDirAt('context', 'domains.md'),
    contextWaironGuideMd: () => aiDirAt('context', 'wairon-guide.md'),
    specsDir,
    specsSystem: () => path.join(specsDir(), '.index.yaml'),
    specsSubsystemsDir: () => path.join(specsDir(), 'subsystems'),
    specsComponentsDir: () => path.join(specsDir(), 'components'),
    specsInterfacesDir: () => path.join(specsDir(), 'interfaces'),
    specsImplementationsDir: () => path.join(specsDir(), 'implementations'),
    specsTypesDir: () => path.join(specsDir(), 'types'),
  };
}

/** Path accessors for the CURRENT project root (override, else resolved cwd). */
export const AI_PATHS: WaiPaths = {
  root: () => aiPathsAt(getProjectRoot()).root(),
  projectConfig: () => aiPathsAt(getProjectRoot()).projectConfig(),
  topologyConfig: () => aiPathsAt(getProjectRoot()).topologyConfig(),
  templatesDir: () => aiPathsAt(getProjectRoot()).templatesDir(),
  rulesDir: () => aiPathsAt(getProjectRoot()).rulesDir(),
  docsDir: () => aiPathsAt(getProjectRoot()).docsDir(),
  generatedDir: () => aiPathsAt(getProjectRoot()).generatedDir(),
  contextDir: () => aiPathsAt(getProjectRoot()).contextDir(),
  contextProjectMd: () => aiPathsAt(getProjectRoot()).contextProjectMd(),
  contextArchitectureMd: () => aiPathsAt(getProjectRoot()).contextArchitectureMd(),
  contextDomainsMd: () => aiPathsAt(getProjectRoot()).contextDomainsMd(),
  contextWaironGuideMd: () => aiPathsAt(getProjectRoot()).contextWaironGuideMd(),
  specsDir: () => aiPathsAt(getProjectRoot()).specsDir(),
  specsSystem: () => aiPathsAt(getProjectRoot()).specsSystem(),
  specsSubsystemsDir: () => aiPathsAt(getProjectRoot()).specsSubsystemsDir(),
  specsComponentsDir: () => aiPathsAt(getProjectRoot()).specsComponentsDir(),
  specsInterfacesDir: () => aiPathsAt(getProjectRoot()).specsInterfacesDir(),
  specsImplementationsDir: () => aiPathsAt(getProjectRoot()).specsImplementationsDir(),
  specsTypesDir: () => aiPathsAt(getProjectRoot()).specsTypesDir(),
};

// ---------------------------------------------------------------------------
// Project config — held by the project config Repository (config/project-config.ts)
// ---------------------------------------------------------------------------

/**
 * Whether the current project is an initialized wairon project, meaning it has a
 * project configuration.
 */
export function isProjectInitialized(): boolean {
  return projectConfigRepository.exists();
}

/**
 * Assert the project has been initialized, throwing a clear error if not.
 */
export function assertProjectInitialized(): void {
  if (!isProjectInitialized()) {
    throw new ProjectNotInitializedError();
  }
}
