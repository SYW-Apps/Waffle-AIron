import * as nodePath from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
import { getProjectRoot } from '../utils/fs.js';
// cli_core_adapter — every call these commands make into another subsystem
// lands on the adapter's own module.
import inquirer from 'inquirer';
import {
  createMember,
  moveMember,
  projectConfigExists,
} from './adapters/core.js';
// cli_migration_adapter — the family migrations every member verb runs through.
import * as migrations from './adapters/migrations.js';
import type { MemberCreation } from '../core/index.js';
import type { InternalizeDestination } from '../models/project.js';
import type { FamilyMigrationReport, MigrationPlan, MigrationRequest } from '../migrations/types.js';

// ---------------------------------------------------------------------------
// member commands — the projects this project contains
//
// A member is a project the bound project contains, declared in its
// project.yaml `members`. It is never a subsystem of its parent: nothing is
// written into the parent's spec tree, and the parent reaches it as
// `alias::name` through the member's L0 exports. `member add` and `member
// move` go to core's maintenance portal. Every verb that changes a family's
// shape — `member attach|detach|adopt|rename-alias|internalize`, `project
// rename` and `subsystem externalize` (which keeps its name because it acts on
// a subsystem) — runs through runMigration: plan, print, confirm, then apply
// all or nothing through the migration portal. None of them ever locks.
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

/** The initialized-project guard every member command opens with. */
function requireProject(): void {
  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project. Run `wairon init` first.');
  }
}

/** A path as the terminal shows it: relative to where the command ran. */
function shown(memberPath: string): string {
  return nodePath.relative(process.cwd(), nodePath.resolve(getProjectRoot(), memberPath)) || '.';
}

/**
 * What scaffolding applied: the required packs written into a new member's
 * configuration (an unattended pack write, so no impact report is shown), the
 * projectType it set, and each requirement nothing installed satisfies. Shared
 * by `wairon member add` and the member branch of `wairon init`.
 */
export function reportMemberPacks(creation: MemberCreation): void {
  if (!creation.configCreated) return;
  for (const selection of creation.adopted) {
    logger.info(`Applied the required pack ${selection.name}@${selection.version} to its new configuration (pinned, with its digest) — no impact report is shown for scaffolding; see it with \`wairon pack impact ${selection.name}\` at the member's root.`);
  }
  if (creation.projectType) logger.info(`Set its projectType to "${creation.projectType}", the profile the requirement names.`);
  for (const requirement of creation.unadopted) {
    logger.warn(`No installed version of "${requirement.pack}" satisfies ${requirement.version}: nothing was written for it, and the family run reports POLICY_NOT_ADOPTED until the member adopts it — \`wairon pack install <source>\`, then \`wairon pack use ${requirement.pack}@<version> --pin\` at the member's root.`);
  }
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
  const creation = createMember(alias, memberPath, options.description);
  // Step 5: the confirmation, what was applied, and next steps.
  logger.success(`Added member "${alias}" → ${memberPath} (declared in project.yaml \`members\`)`);
  logger.info(`Scaffolded its project at ${shown(memberPath)} — its project id is "${alias}".`);
  reportMemberPacks(creation);
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

/**
 * The options every family-migration command shares, plus the few one verb
 * reads (migration_command_options).
 */
export interface MigrationCommandOptions {
  /** --report: print the plan and write nothing. */
  report?: boolean;
  /** --yes: apply without asking; required in a non-interactive shell. */
  yes?: boolean;
  /** member attach --description: what the member is to this project. */
  description?: string;
  /** member internalize --into: the home subsystem for the member's L0 vision. */
  into?: string;
  /** member internalize --packs adopt|drop: packs only the member selects. */
  packs?: string;
  /** member internalize --export: public names of the member the parent exports afterwards. */
  exports?: string[];
  /** subsystem externalize --path: the new member's root. */
  path?: string;
  /** project rename --project: the member whose id moves (an alias path); the current project when absent. */
  project?: string;
  /** member detach --widen: widen exactly the used family-only exports to the instance audience, shown in the plan. */
  widen?: boolean;
}

/**
 * icli_runner.runMigration — the one flow every family-migration command runs:
 * plan, print, then drop the plan (--report, refused, empty) or confirm and
 * apply it all or nothing, printing the projects to re-lock. Never locks.
 */
export async function runMigration(request: MigrationRequest, options: MigrationCommandOptions): Promise<void> {
  // Step 1: plan the request from the current project.
  const planned = migrations.plan(request);
  // Step 2: print the plan.
  printPlan(planned);
  // Steps 3-5: report only, refused or empty — nothing is written.
  const refused = planned.refusals.length > 0;
  if (options.report || refused || planned.changes.length === 0) {
    migrations.discard(planned);
    if (refused) {
      logger.error(`The ${request.verb} migration is refused; nothing was written.`);
      process.exitCode = 1;
    } else if (planned.changes.length === 0) logger.info('Nothing to migrate: the family already reads this way.');
    else logger.info('Report only (--report): nothing was written.');
    return;
  }
  // Steps 6-9: confirmed, or dropped having written nothing.
  if (!(await confirmMigration(request.verb, options))) {
    migrations.discard(planned);
    return;
  }
  // Step 10: all or nothing.
  const report = migrations.apply(planned);
  // Step 11: the outcome.
  printOutcome(report);
}

/** A project key as the plan prints it. */
const ownerLabel = (key: string): string => (key === '' ? 'the top project' : key);

/** How many file lines of one owner the plan prints before it counts the rest. */
const SCREENFUL = 20;

/** A directory as the terminal shows it: relative to where the command ran. */
function shownDir(dir: string): string {
  return nodePath.relative(process.cwd(), dir) || '.';
}

/** Step 2 of runMigration: the verb, the family root, each owner's edits, the refusals, the notes, the files and the re-lock list. */
function printPlan(planned: MigrationPlan): void {
  logger.header(`wairon family migration: ${planned.request.verb}`);
  logger.info(`Family root: ${shownDir(planned.familyRoot)}${planned.whole ? '' : ' (not the whole family: the reach stops below its top)'}`);
  for (const key of [...new Set(planned.edits.map((e) => e.project))]) {
    console.log(`  ${ownerLabel(key)}:`);
    for (const e of planned.edits.filter((x) => x.project === key)) console.log(`    ${e.kind}: ${e.detail}`);
  }
  for (const r of planned.refusals) logger.error(`[${r.code}]${r.project ? ` ${ownerLabel(r.project)}:` : ''} ${r.detail}`);
  for (const note of planned.notes) logger.warn(`NOTE: ${note}`);
  printFiles(planned);
  if (planned.relock.length > 0) logger.info(`To re-lock once applied: ${planned.relock.map(shownDir).join(', ')}`);
}

/** The file changes per owner, one line each, a count past a screenful. */
function printFiles(planned: MigrationPlan): void {
  if (planned.changes.length === 0) return;
  const byOwner = new Map<string, string[]>();
  for (const c of planned.changes) byOwner.set(c.project, [...(byOwner.get(c.project) ?? []), `${c.action} ${c.path}`]);
  console.log(`  Files (${planned.changes.length}):`);
  for (const [dir, lines] of byOwner) {
    console.log(`    ${shownDir(dir)}:`);
    for (const line of lines.slice(0, SCREENFUL)) console.log(`      ${line}`);
    if (lines.length > SCREENFUL) console.log(`      … and ${lines.length - SCREENFUL} more`);
  }
}

/** Steps 6-7: --yes answers; a terminal asks; no terminal and no --yes is a no. */
async function confirmMigration(verb: string, options: MigrationCommandOptions): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    logger.warn(`No terminal to confirm the ${verb} migration — re-run with --yes to apply it. Nothing was written.`);
    return false;
  }
  const { confirmed } = await inquirer.prompt<{ confirmed: boolean }>([
    { type: 'confirm', name: 'confirmed', message: `Apply the ${verb} migration above?`, default: false },
  ]);
  if (!confirmed) logger.warn('Not applied. Nothing was written.');
  return confirmed;
}

/** Step 11: committed with the projects to re-lock; failed and restored; or failed with the files doctor must restore. */
function printOutcome(report: FamilyMigrationReport): void {
  const verb = report.plan.request.verb;
  if (report.applied) {
    logger.success(`Applied the ${verb} migration: ${report.plan.changes.length} file(s) across ${new Set(report.plan.changes.map((c) => c.project)).size} project(s).`);
    for (const dir of report.relock) logger.info(`Re-lock ${shownDir(dir)}: run \`wairon lock\` there.`);
    return;
  }
  process.exitCode = 1;
  const outcome = report.outcome;
  if (!outcome) {
    for (const r of report.plan.refusals) logger.error(`[${r.code}]${r.project ? ` ${ownerLabel(r.project)}:` : ''} ${r.detail}`);
    logger.error(`The ${verb} migration was not applied; nothing was written.`);
  } else if (outcome.restored) {
    logger.error(`The ${verb} migration failed and was rolled back; the family is exactly as before: ${outcome.failure ?? 'unknown failure'}`);
  } else {
    logger.error(`The ${verb} migration failed and ${outcome.unrestored.length} file(s) could not be restored — run \`wairon doctor --fix\` to finish the rollback: ${outcome.failure ?? 'unknown failure'}`);
    for (const file of outcome.unrestored) console.log(`    ${file}`);
  }
}

/** icli_runner.runMemberAttach — `wairon member attach <alias> <path>`: an existing project becomes a member. */
export async function runMemberAttach(alias: string, path: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1.
  requireProject();
  // Step 2.
  const request: MigrationRequest = { verb: 'attach', alias, path, ...(options.description !== undefined ? { description: options.description } : {}) };
  // Step 3.
  await runMigration(request, options);
}

/** icli_runner.runProjectRename — `wairon project rename <new-id>`: a project's id, family-wide. */
export async function runProjectRename(newId: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1.
  requireProject();
  // Step 2.
  const request: MigrationRequest = { verb: 'rename', newId, ...(options.project ? { project: options.project } : {}) };
  // Step 3.
  await runMigration(request, options);
}

/** icli_runner.runMemberRenameAlias — `wairon member rename-alias <old> <new>`: one alias of this project. */
export async function runMemberRenameAlias(alias: string, newAlias: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1.
  requireProject();
  // Step 2.
  const request: MigrationRequest = { verb: 'rename-alias', alias, newAlias };
  // Step 3.
  await runMigration(request, options);
}

/** icli_runner.runMemberDetach — `wairon member detach <alias>`: a member leaves the family, reached as an external by path. */
export async function runMemberDetach(alias: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1.
  requireProject();
  // Step 2.
  const request: MigrationRequest = { verb: 'detach', alias, ...(options.widen ? { widen: true } : {}) };
  // Step 3.
  await runMigration(request, options);
}

/** icli_runner.runMemberAdopt — `wairon member adopt <alias>`: detach's inverse. */
export async function runMemberAdopt(alias: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1.
  requireProject();
  // Step 2.
  const request: MigrationRequest = { verb: 'adopt', alias };
  // Step 3.
  await runMigration(request, options);
}

/** icli_runner.runSubsystemExternalize — `wairon subsystem externalize <id> --path <dir>`: a subsystem becomes a member, family-wide. */
export async function runSubsystemExternalize(id: string, options: MigrationCommandOptions = {}): Promise<void> {
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the destination is required.
  if (!options.path) {
    throw new WaironError("--path (the member's destination) is required.");
  }
  // Step 4: the request.
  const request: MigrationRequest = { verb: 'externalize', subsystem: id, path: options.path };
  // Step 5: the shared flow; source code is the user's to move.
  await runMigration(request, options);
}

/** icli_runner.runMemberInternalize — `wairon member internalize <alias>`: a member, every subsystem of it, folded back in. */
export async function runMemberInternalize(alias: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1: an initialized project.
  requireProject();
  // Step 2: the request, its destination from --into, --packs and --export.
  const destination: InternalizeDestination = {
    home: options.into ?? '',
    ...(options.packs !== undefined ? { packs: options.packs } : {}),
    ...(options.exports && options.exports.length > 0 ? { exports: options.exports } : {}),
  };
  // Step 3: the shared flow.
  await runMigration({ verb: 'internalize', alias, destination }, options);
}
