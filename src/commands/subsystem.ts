import * as path from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/fs.js';
import { isProjectInitialized } from '../config/loader.js';
import { loadSystemSpec } from '../core/specs.js';
import { composeAgentBrief as coreComposeAgentBrief } from '../core/agent_resolver.js';
import {
  exportSpecTree as coreExportSpecTree,
  importSpecTree as coreImportSpecTree,
} from '../core/treetransfer.js';
import type { TreeExportResult, TreeImportOptions, TreeImportResult } from '../core/treetransfer.js';
import {
  createChainedSubsystem,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
} from '../core/provision.js';
import type { AgentBrief, SubsystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// subsystem command — create/relocate external (chained) subprojects
//
// The AI authors in-tree subsystems through the sdd_* tools; this CLI surface is
// specifically for the *external* case, where a subsystem lives in its own
// sibling wairon project wired by `projectPath`. Both actions delegate to the
// core chained-subsystem helpers so the parent link and the child project stay
// in sync.
// ---------------------------------------------------------------------------

// cli_core_adapter.composeAgentBrief — 1:1 forward of the live delegation-brief
// composition to the core portal; backs `wairon agent brief` and the
// `wairon agent customize` scaffold seed. Composed against the CURRENT spec
// tree on every call (a re-lock changes the next call).
export function composeAgentBrief(agentId: string): AgentBrief {
  return coreComposeAgentBrief(agentId);
}

// cli_core_adapter.exportSpecTree / importSpecTree — 1:1 forwards of the whole
// spec-tree transfer to the core portal, backing `wairon remote push|pull`.
//
// The import deliberately does NOT set the executable-entry guard: a developer
// extracting an archive from an instance they chose to trust is the
// trusted-filesystem tier — the same tier `wairon packs add` installs code packs
// through. Refusing a bundled code pack here would make a hosted project
// unpullable, while the hosted import (which accepts archives from anyone with
// project:admin) always applies it.
export function exportSpecTree(includeDerived?: boolean): TreeExportResult {
  return coreExportSpecTree(includeDerived);
}

export function importSpecTree(archive: Uint8Array, options: TreeImportOptions): TreeImportResult {
  return coreImportSpecTree(archive, options);
}

interface SubsystemAddOptions {
  projectPath?: string;
  name?: string;
}

interface SubsystemMoveOptions {
  projectPath?: string;
}

export async function runSubsystemAdd(id: string, options: SubsystemAddOptions = {}): Promise<void> {
  logger.header('wairon subsystem add');

  if (!isProjectInitialized()) {
    throw new WaironError('Not inside an initialized wairon project. Run `wairon init` first.');
  }
  if (!options.projectPath) {
    throw new WaironError(
      '--project-path is required (use the sdd_add_subsystem MCP tool for in-tree subsystems).',
    );
  }

  const system = loadSystemSpec();
  if (!system) {
    throw new WaironError('System spec is missing. Run `wairon init` first.');
  }

  const displayName = options.name ?? id;
  const now = new Date().toISOString();
  const subsystem: SubsystemSpec = {
    id,
    name: displayName,
    description: `External subsystem ${displayName}`,
    parentSystem: system.name,
    publicInterfaces: [],
    projectPath: options.projectPath,
    trustedLinks: [],
    status: 'draft',
    createdAt: now,
    updatedAt: now,
  };

  createChainedSubsystem(subsystem, displayName);

  const childDir = path.resolve(getProjectRoot(), options.projectPath);
  logger.success(`Added external subsystem "${id}" → ${options.projectPath}`);
  logger.info(`Scaffolded child project at ${path.relative(process.cwd(), childDir) || '.'}`);
  logger.info(`Design its spec tree from this parent using namespaced ids (e.g. ${id}::<component>).`);
}

export async function runSubsystemMove(id: string, options: SubsystemMoveOptions = {}): Promise<void> {
  logger.header('wairon subsystem move');

  if (!isProjectInitialized()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }
  if (!options.projectPath) {
    throw new WaironError('--project-path (the new location) is required.');
  }

  moveSubsystemProject(id, options.projectPath);
  logger.success(`Moved subsystem "${id}" → ${options.projectPath}`);
}

export async function runSubsystemExternalize(id: string, options: SubsystemAddOptions = {}): Promise<void> {
  logger.header('wairon subsystem externalize');

  if (!isProjectInitialized()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }
  if (!options.projectPath) {
    throw new WaironError('--project-path (the subproject destination) is required.');
  }

  externalizeSubsystem(id, options.projectPath);

  const childDir = path.resolve(getProjectRoot(), options.projectPath);
  logger.success(`Externalized subsystem "${id}" → ${options.projectPath}`);
  logger.info(`Moved its specs into ${path.relative(process.cwd(), childDir) || '.'} (now a standalone subproject).`);
  logger.info('Move the source code there yourself, then run `wairon validate` to confirm the tree.');
}

export async function runSubsystemInternalize(id: string): Promise<void> {
  logger.header('wairon subsystem internalize');

  if (!isProjectInitialized()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }

  internalizeSubsystem(id);
  logger.success(`Internalized subsystem "${id}" back into this project.`);
  logger.info('Its child .wai project was removed. Run `wairon validate` to confirm the tree.');
}
