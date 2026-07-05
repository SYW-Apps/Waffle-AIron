import * as fs from 'fs';
import * as path from 'path';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  loadSubsystemSpec,
  collectPromotableSpecs,
  applySpecStatus,
  invalidateSpecCache,
} from './specs.js';
import { saveProjectConfig, aiPathsAt } from '../config/loader.js';
import { getProjectRoot, runWithProjectRoot, ensureDir } from '../utils/fs.js';
import { WaironError } from '../utils/errors.js';
import type { ProjectConfig } from '../models/project.js';
import type { SubsystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// Project provisioning + bulk status promotion (sdd_core, used by sdd_host)
//
// provisionProject bootstraps a fresh isolated project at the currently-bound
// root: a default project.yaml plus an L0 system spec. promoteAllComplete is the
// lock status write — every promotable spec → complete. Both operate on the
// active (request-scoped) project root, so the hosting server binds the target
// root first and these Just Work against it.
// ---------------------------------------------------------------------------

function defaultProjectConfig(name: string, now: string): ProjectConfig {
  return {
    schemaVersion: '1.0.0',
    name,
    projectType: 'backend',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {
      noOverlappingOwnership: true,
      requireOwnedPaths: true,
      metaAgentTags: ['meta', 'guardian', 'architect'],
      enforceReproducibility: true,
      generateComponentImplementers: true,
      sddRuleSeverity: {},
    },
    paths: { specsDir: '.wai/specs' },
    createdAt: now,
    updatedAt: now,
  };
}

/** Bootstrap a fresh isolated project (project.yaml + L0 system spec) at the bound root. */
export function provisionProject(name: string): void {
  const now = new Date().toISOString();
  saveProjectConfig(defaultProjectConfig(name, now));
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name,
    vision: `Core vision for ${name}`,
    boundaries: [],
    globalRequirements: [],
    createdAt: now,
    updatedAt: now,
  });
}

/** Promote every promotable spec in the bound project to status complete. */
export function promoteAllComplete(): void {
  for (const p of collectPromotableSpecs()) {
    applySpecStatus(p.kind, p.id, 'complete');
  }
  invalidateSpecCache();
}

// ---------------------------------------------------------------------------
// Chained (external) subsystem lifecycle
//
// An external subsystem is an L1 whose `projectPath` points at a sibling wairon
// project; the loader recursively federates that child tree under the parent's
// namespace. These helpers keep the two halves — the parent link and the child
// project — in sync, so authoring one never leaves the other dangling.
// ---------------------------------------------------------------------------

/**
 * Create a chained subproject subsystem: persist the parent L1 subsystem spec
 * (with `projectPath`) at the bound root, then scaffold an isolated child wairon
 * project at that path when one does not already exist. Idempotent — re-running
 * against an already-initialized child wires the parent only.
 */
export function createChainedSubsystem(subsystem: SubsystemSpec, projectName: string): void {
  if (!subsystem.projectPath || subsystem.projectPath.trim() === '') {
    throw new WaironError('projectPath is required to create a chained subsystem.');
  }

  // Store projectPath with forward slashes so the spec tree stays portable
  // across platforms (path.resolve accepts them everywhere).
  const projectPath = toPosixPath(subsystem.projectPath);

  // 1. Persist the parent L1 subsystem spec (with projectPath) at the parent root.
  saveSubsystemSpec({ ...subsystem, projectPath });

  // 2. Resolve the child project directory relative to the bound (parent) root.
  const childDir = path.resolve(getProjectRoot(), projectPath);

  // 3. Scaffold the child project unless it is already initialized (idempotent).
  const alreadyInitialized = fs.existsSync(aiPathsAt(childDir).projectConfig());
  if (!alreadyInitialized) {
    runWithProjectRoot(childDir, () => {
      ensureDir(aiPathsAt(childDir).specsDir());
      provisionProject(projectName);
    });
  }

  invalidateSpecCache();
}

/**
 * Relocate an external subsystem's subproject: move its directory on disk from
 * the current `projectPath` to `newProjectPath` and persist the updated link.
 * Throws if the subsystem has no `projectPath` (i.e. it is not external).
 */
export function moveSubsystemProject(subsystemId: string, newProjectPath: string): void {
  const sub = loadSubsystemSpec(subsystemId);
  if (!sub) {
    throw new WaironError(`Subsystem "${subsystemId}" does not exist.`);
  }
  if (!sub.projectPath || sub.projectPath.trim() === '') {
    throw new WaironError(
      `Subsystem "${subsystemId}" has no projectPath to move (not an external subproject).`,
    );
  }

  const nextPath = toPosixPath(newProjectPath);
  const root = getProjectRoot();
  const oldDir = path.resolve(root, sub.projectPath);
  const newDir = path.resolve(root, nextPath);

  if (oldDir !== newDir) {
    if (!fs.existsSync(oldDir)) {
      throw new WaironError(`Subproject directory not found at its current path: ${oldDir}`);
    }
    if (fs.existsSync(newDir)) {
      throw new WaironError(`Target directory already exists: ${newDir}`);
    }
    ensureDir(path.dirname(newDir));
    fs.renameSync(oldDir, newDir);
  }

  saveSubsystemSpec({ ...sub, projectPath: nextPath, updatedAt: new Date().toISOString() });
  invalidateSpecCache();
}

/** Normalize a filesystem path to forward-slash form for portable storage. */
function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
