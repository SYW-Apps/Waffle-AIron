import { saveSystemSpec, collectPromotableSpecs, applySpecStatus, invalidateSpecCache } from './specs.js';
import { saveProjectConfig } from '../config/loader.js';
import type { ProjectConfig } from '../models/project.js';

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
