import * as path from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/fs.js';
// cli_core_adapter — every call these commands make into another subsystem
// lands on the adapter's own module.
import {
  createMember,
  moveMember,
  externalizeSubsystem,
  internalizeMember,
  projectConfigExists,
} from './adapters/core.js';

// ---------------------------------------------------------------------------
// member commands — the projects this project contains
//
// A member is a project the bound project contains, declared in its
// project.yaml `members` (`wairon member add|move|internalize`). It is never a
// subsystem of its parent: nothing is written into the parent's spec tree, and
// the parent reaches it as `alias::name` through the member's L0 exports.
// `wairon subsystem externalize` keeps its name because it acts on a subsystem,
// turning it into a member. Every write here is mechanical and goes to core's
// maintenance portal.
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

interface MemberAddOptions {
  description?: string;
}

interface SubsystemExternalizeOptions {
  path?: string;
}

/** The initialized-project guard every member command opens with. */
function requireProject(): void {
  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project. Run `wairon init` first.');
  }
}

/** A path as the terminal shows it: relative to where the command ran. */
function shown(memberPath: string): string {
  return path.relative(process.cwd(), path.resolve(getProjectRoot(), memberPath)) || '.';
}

export async function runMemberAdd(alias: string, memberPath: string, options: MemberAddOptions = {}): Promise<void> {
  logger.header('wairon member add');
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the member needs a path.
  if (!memberPath) {
    throw new WaironError('a path is required: wairon member add <alias> <path>');
  }
  // Step 4: scaffold the member and declare it in `members`.
  createMember(alias, memberPath, options.description);
  // Step 5: the confirmation and next steps.
  logger.success(`Added member "${alias}" → ${memberPath} (declared in project.yaml \`members\`)`);
  logger.info(`Scaffolded its project at ${shown(memberPath)} — its project id is "${alias}".`);
  logger.info(`Design it from its own root, and export what others consume from its L0; reference it here as ${alias}::<name>.`);
}

export async function runMemberMove(alias: string, newPath: string): Promise<void> {
  logger.header('wairon member move');
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the new location is required.
  if (!newPath) {
    throw new WaironError('a new path is required: wairon member move <alias> <path>');
  }
  // Step 4: move the member's directory and point its `members` entry there.
  moveMember(alias, newPath);
  // Step 5: the confirmation.
  logger.success(`Moved member "${alias}" → ${newPath}`);
}

export async function runSubsystemExternalize(id: string, options: SubsystemExternalizeOptions = {}): Promise<void> {
  logger.header('wairon subsystem externalize');
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the destination is required.
  if (!options.path) {
    throw new WaironError("--path (the member's destination) is required.");
  }
  // Step 4: turn the subsystem into a member declared in `members`.
  externalizeSubsystem(id, options.path);
  // Step 5: the confirmation and what is left to the user.
  logger.success(`Externalized subsystem "${id}" → member at ${options.path}`);
  logger.info(`Moved its specs into ${shown(options.path)} and declared it in project.yaml \`members\` as "${id}".`);
  logger.info('Move the source code there yourself, run `wairon doctor --fix` for the exports either side now needs, then `wairon validate`.');
}

export async function runMemberInternalize(alias: string): Promise<void> {
  logger.header('wairon member internalize');
  // Step 1: an initialized project.
  requireProject();
  // Step 2: take the member back into this project.
  internalizeMember(alias);
  // Step 3: the confirmation.
  logger.success(`Internalized member "${alias}" into this project.`);
  logger.info('Its .wai project was removed and its `members` entry dropped. Run `wairon validate` to confirm the tree.');
}
