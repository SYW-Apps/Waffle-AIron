import * as path from 'path';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { createMember } from '../../src/core/provision.js';
import type { SubsystemSpec } from '../../src/models/index.js';

/**
 * Declare `subsystem.id` as a member PROJECT of the bound project, at
 * `subsystem.projectPath`, and scaffold the child project there. For the tests
 * that need a chained child project and are not about how a member is declared.
 */
export function writeMemberProject(subsystem: SubsystemSpec, _projectName: string): void {
  const projectPath = subsystem.projectPath!.split(path.sep).join('/');
  createMember(subsystem.id, projectPath, subsystem.description || undefined, 'project');
  invalidateSpecCache();
}
