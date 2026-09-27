import * as path from 'path';
import { saveSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { ensureProjectInitialized } from '../../src/core/provision.js';
import { aiPathsAt } from '../../src/config/paths.js';
import { ensureDir, getProjectRoot, runWithProjectRoot } from '../../src/utils/fs.js';
import type { SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// A legacy L1 mount, written on purpose — for the tests that prove the
// deprecated form still loads for its one-release grace.
//
// wairon's own writers never emit this form any more (stage 3: a member is
// declared in project.yaml `members`, and the authoring seam refuses a
// subsystem naming projectPath). These fixtures still need a tree as a
// pre-stage-3 wairon wrote it: the parent's L1 subsystem carrying projectPath,
// and the child project scaffolded at that path, identified by the mount's
// local id. This is what the retired createChainedSubsystem did.
// ---------------------------------------------------------------------------

/** Write `subsystem` (carrying projectPath) at the bound root and scaffold its child project. */
export function writeLegacyMount(subsystem: SubsystemSpec, projectName: string): void {
  const projectPath = subsystem.projectPath!.replace(/\\/g, '/');
  saveSpec('subsystem', { ...subsystem, projectPath });
  const childDir = path.resolve(getProjectRoot(), projectPath);
  runWithProjectRoot(childDir, () => {
    ensureDir(aiPathsAt(childDir).specsDir());
    ensureProjectInitialized(projectName, subsystem.id.split('::').pop()!);
  });
  invalidateSpecCache();
}
