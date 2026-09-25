import * as path from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/fs.js';
// cli_core_adapter and cli_authoring_adapter — every call these commands make
// into another subsystem lands on the adapter's own module.
import {
  loadSystemSpec,
  loadSubsystemSpec,
  moveSubsystemProject,
  externalizeSubsystem,
  internalizeSubsystem,
  projectConfigExists,
} from './adapters/core.js';
import { writeSpec } from './adapters/authoring.js';
import type { SpecRestatement } from '../core/authoring.js';
import type { SubsystemSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// subsystem command — create/relocate external (chained) subprojects
//
// The AI authors in-tree subsystems through the sdd_* tools; this CLI surface is
// specifically for the *external* case, where a subsystem lives in its own
// sibling wairon project wired by `projectPath`. `add` AUTHORS the subsystem,
// so it writes through the authoring seam (which wires the parent link and
// scaffolds the child project in one write); the relocations are mechanical
// and go to core's maintenance portal.
// ---------------------------------------------------------------------------

// The rest of the diagram surface `wairon diagram` needs, republished by
// identity rather than wrapped.
//
// These are NOT on icli_core_adapter: the contract names renderDiagram alone,
// because runDiagram's narrative models only the four-format path. The command
// also has --all, --sequence and --subsystem — scopes DiagramOptions models as
// fields while no method takes them — and those need generateDiagramSet,
// generateSequenceDiagram, generateComponentDiagram and the set's index. That
// gap belongs in the spec, and it is reported rather than papered over. The
// re-export lands on the core portal file; this file itself calls none of them.
//
// buildCanvasDataModel (a spec_tree_portal method now) is the model as DATA:
// `wairon host demo` counts what it just seeded rather than drawing it. It is
// not on icli_core_adapter, so it rides here until the host command's own
// adapter work moves it.
export {
  generateComponentDiagram,
  generateSequenceDiagram,
  generateDiagramSet,
  diagramSetIndex,
  toMarkdown,
  loadSpecGraph,
  buildCanvasDataModel,
} from '../core/index.js';

/**
 * The restatement `wairon subsystem add` states: only what the command owns —
 * the id, the projectPath, and the display name when --name is given — plus,
 * for a subsystem not yet stored, the name (--name or the id) and the
 * placeholder description a new subsystem requires. `fields` lists exactly
 * those, so a re-run carries the stored description, published surface,
 * trusted links and status instead of overwriting them; the seam derives
 * parentSystem and fills a new spec's lists from the schema defaults.
 */
function subsystemAddRestatement(
  id: string,
  projectPath: string,
  name: string | undefined,
  stored: SubsystemSpec | null,
): SpecRestatement {
  const spec: Record<string, unknown> = { id, projectPath };
  const fields = ['id', 'projectPath'];
  if (name !== undefined || !stored) {
    spec.name = name ?? id;
    fields.push('name');
  }
  if (!stored) {
    spec.description = `External subsystem ${spec.name}`;
    fields.push('description');
  }
  return { kind: 'subsystem', spec: spec as unknown as SubsystemSpec, fields };
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

  if (!projectConfigExists()) {
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

  // Step 4: the subsystem already stored under that id, if any — a re-run
  // must not overwrite what the author set since.
  const stored = loadSubsystemSpec(id);

  // Step 5: the restatement, with only what this command owns.
  const restatement = subsystemAddRestatement(id, options.projectPath, options.name, stored);

  // Step 6: through the authoring client adapter into the seam.
  const receipt = writeSpec(restatement);

  // Step 7: the confirmation, and what a re-authoring did beyond the input.
  const childDir = path.resolve(getProjectRoot(), options.projectPath);
  logger.success(`${receipt.replacedExisting ? 'Re-authored' : 'Added'} external subsystem "${id}" → ${options.projectPath}`);
  for (const notice of receipt.notices) logger.info(notice);
  logger.info(`Scaffolded child project at ${path.relative(process.cwd(), childDir) || '.'}`);
  logger.info(`Design its spec tree from this parent using namespaced ids (e.g. ${id}::<component>).`);
}

export async function runSubsystemMove(id: string, options: SubsystemMoveOptions = {}): Promise<void> {
  logger.header('wairon subsystem move');

  if (!projectConfigExists()) {
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

  if (!projectConfigExists()) {
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

  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project.');
  }

  internalizeSubsystem(id);
  logger.success(`Internalized subsystem "${id}" back into this project.`);
  logger.info('Its child .wai project was removed. Run `wairon validate` to confirm the tree.');
}
