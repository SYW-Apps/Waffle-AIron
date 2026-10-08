import * as nodePath from 'path';
import { logger } from '../utils/logger.js';
import { WaironError } from '../utils/errors.js';
// cli_core_adapter — every call these commands make into another subsystem
// lands on the adapter's own module.
import inquirer from 'inquirer';
import {
  createMember,
  advanceMember,
  moveMember,
  projectConfigExists,
  projectFamily,
} from './adapters/core.js';
// cli_migration_adapter — the family migrations every member verb runs through.
import * as migrations from './adapters/migrations.js';
// What `wairon init` gives a project, given to one a migration made (runMigration steps 12-15).
import { runGenerate } from './generate.js';
import { runMcpInstall } from './mcp.js';
import { getProjectRoot, runWithProjectRoot, pathExists } from '../utils/fs.js';
import * as fs from 'fs';
import { listSkillNames } from './adapters/skills.js';
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
  /** --project: create an independent project instead of a part (stage 8). */
  project?: boolean;
}

/** The initialized-project guard every member command opens with. */
function requireProject(): void {
  if (!projectConfigExists()) {
    throw new WaironError('Not inside an initialized wairon project. Run `wairon init` first.');
  }
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

/**
 * icli_runner.runMemberAdd — `wairon member add <alias> <source> [--project]`:
 * create a member at a source in the members grammar — a PART by default
 * (stage 8: its subsystems are this project's own), a project with --project.
 */
export async function runMemberAdd(alias: string, source: string, options: MemberAddOptions = {}): Promise<void> {
  logger.header('wairon member add');
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the member needs a source.
  if (!source) {
    throw new WaironError('a source is required: wairon member add <alias> <path | ../path | git-url[#commit]>');
  }
  // Step 4: create the member — a part, or with --project a project — and declare it.
  const creation = createMember(alias, source, options.description, options.project ? 'project' : undefined);
  // Step 5: the confirmation, what was applied, and the growth path.
  const where = creation.storage === 'git' ? `${source.split('#')[0]} at ${creation.commit}` : source;
  logger.success(`Added the ${creation.as} "${alias}" → ${where} (declared in project.yaml \`members\`)`);
  if (creation.as === 'project') {
    logger.info(`It is an independent project — its id is "${alias}". Design it from its own root, export what others consume from its L0, and reference it here as ${alias}::<name>.`);
    reportMemberPacks(creation);
  } else {
    logger.info(`Its subsystems are this project's own: write them by their local ids, judged and locked with this project. \`wairon member promote ${alias}\` makes it a project when it needs its own team, release, approval or public surface.`);
  }
}

/**
 * icli_runner.runMemberPromote — `wairon member promote <alias> [--id <id>]`
 * (stage 8): a part becomes an independent project in place. Through
 * runMigration: plan first, confirmed, all or nothing, never locks.
 */
export async function runMemberPromote(alias: string, options: MigrationCommandOptions & { id?: string }): Promise<void> {
  // Step 1: an initialized project.
  requireProject();
  // Step 2: the request, with --id.
  const request: MigrationRequest = { verb: 'promote', alias, ...(options.id !== undefined ? { newId: options.id } : {}) };
  // Step 3: the shared flow.
  await runMigration(request, options);
}

/**
 * icli_runner.runMemberDemote — `wairon member demote <alias> [--home <subsystem>]`
 * (stage 8): a project member becomes a part of this project in place —
 * promote's inverse. Through runMigration.
 */
export async function runMemberDemote(alias: string, options: MigrationCommandOptions): Promise<void> {
  // Step 1: an initialized project.
  requireProject();
  // Step 2: the request, its destination from --home and the pack choice.
  const destination: InternalizeDestination = { home: options.into ?? '', ...(options.packs !== undefined ? { packs: options.packs } : {}) };
  // Step 3: the shared flow.
  await runMigration({ verb: 'demote', alias, destination }, options);
}

/**
 * icli_runner.runMemberUpdate — `wairon member update <alias> [--ref | --commit]
 * [--report]` (stage 8): move a git member's pinned commit, printing what
 * changed in its spec files first. Never locks.
 */
export async function runMemberUpdate(alias: string, options: { ref?: string; commit?: string; report?: boolean }): Promise<void> {
  logger.header('wairon member update');
  // Step 1: an initialized project.
  requireProject();
  // Step 2: move the pin — a dry run with --report.
  const advance = advanceMember(alias, options.ref, options.commit, options.report);
  // Step 3: the commits, the spec files that moved, and what the move leaves stale.
  logger.info(`${alias}: ${advance.from || '(no commit)'} → ${advance.to}${advance.ref ? ` (${advance.ref})` : ''}`);
  if (advance.from === advance.to) {
    logger.success(`"${alias}" is already at ${advance.to}: nothing to update.`);
    return;
  }
  for (const [label, files] of [['added', advance.added], ['changed', advance.changed], ['removed', advance.removed]] as const) {
    for (const file of files) logger.info(`  ${label}: ${file}`);
  }
  if (advance.added.length + advance.changed.length + advance.removed.length === 0) logger.info('  no spec file changed');
  if (!advance.written) {
    logger.info('Report only: nothing was written. Run without --report to move the pin.');
    return;
  }
  logger.success(`"${alias}" now pins ${advance.to}.`);
  if (advance.added.length + advance.changed.length + advance.removed.length > 0) {
    logger.warn('Its content moved, so this project\'s lock reads stale until it is re-locked (`wairon lock`).');
  }
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
  /** subsystem externalize --as part|project (stage 8): a storage move, or the move composed with a promote. */
  as?: string;
  /** member promote --id: the new project's id; the alias when absent. */
  id?: string;
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
  // Steps 12-15: a project made for a team is usable by that team's session.
  if (report.applied) await provisionMadeProjects(request);
  // Step 16: a demoted member's folder is a part, no project root — its session scaffold goes.
  if (report.applied && request.verb === 'demote') removeDemotedScaffold(request.alias ?? '');
}

/** The markers around the wairon guide section of a guide file (as `wairon generate` writes them). */
const GUIDE_START = '<!-- wairon-guide-start -->';
const GUIDE_END = '<!-- wairon-guide-end -->';

/** A guide file's text without its wairon section. */
function withoutGuideSection(content: string): string {
  const start = content.indexOf(GUIDE_START);
  const end = content.indexOf(GUIDE_END);
  return start === -1 || end === -1 ? content : content.slice(0, start) + content.slice(end + GUIDE_END.length);
}

/** The markers around wairon's block of a root pointer file (as `wairon generate` writes them). */
const ROOT_START = '<!-- wairon-root-start -->';
const ROOT_END = '<!-- wairon-root-end -->';

/** The root pointer an earlier `wairon generate` wrote for claude, unmarked, as a template to recognise it by (CLAUDE.md). */
const CLAUDE_POINTER_HEAD = '@.claude/CLAUDE.md';

/** A file's text with its line endings normalized and trailing space trimmed. */
function normalizedText(file: string): string {
  return fs.readFileSync(file, 'utf-8').replace(/\r\n/g, '\n').trim();
}

/**
 * Step 16 of runMigration: after an applied demote, remove the session
 * scaffold a promote gave the member's folder — the wairon entry of its
 * .mcp.json, the wairon guide and skills under .claude/, and the root pointer
 * CLAUDE.md — deleting a file only when nothing but wairon's own content is
 * left in it. Each removal and each kept file (with why) is printed.
 */
function removeDemotedScaffold(alias: string): void {
  const dir = projectFamily().nodes.find((n) => n.namespace === '')?.parts.find((p) => p.alias === alias)?.directory;
  if (dir === undefined || nodePath.resolve(dir) === nodePath.resolve(getProjectRoot())) return;
  const shown = (file: string): string => shownDir(file);
  const removed: string[] = [];
  const kept: string[] = [];
  // .mcp.json: the wairon server entry goes; the file only when nothing else is in it.
  const mcpJson = nodePath.join(dir, '.mcp.json');
  if (pathExists(mcpJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(mcpJson, 'utf-8')) as { mcpServers?: Record<string, unknown> } & Record<string, unknown>;
      if (parsed.mcpServers && 'wairon' in parsed.mcpServers) {
        delete parsed.mcpServers.wairon;
        const otherKeys = Object.keys(parsed).filter((k) => k !== 'mcpServers');
        if (Object.keys(parsed.mcpServers).length === 0 && otherKeys.length === 0) {
          fs.rmSync(mcpJson);
          removed.push(shown(mcpJson));
        } else {
          fs.writeFileSync(mcpJson, JSON.stringify(parsed, null, 2) + '\n');
          kept.push(`${shown(mcpJson)} (its wairon entry removed; other servers are configured there)`);
        }
      }
    } catch {
      kept.push(`${shown(mcpJson)} (not JSON wairon can read: left as it is)`);
    }
  }
  // .claude/CLAUDE.md: the wairon guide section goes; the file only when nothing else is in it.
  const guide = nodePath.join(dir, '.claude', 'CLAUDE.md');
  if (pathExists(guide)) {
    const rest = withoutGuideSection(fs.readFileSync(guide, 'utf-8'));
    if (rest.trim() === '') {
      fs.rmSync(guide);
      removed.push(shown(guide));
    } else {
      fs.writeFileSync(guide, rest.trimEnd() + '\n');
      kept.push(`${shown(guide)} (the wairon guide removed; someone else's text is in it)`);
    }
  }
  // The skills wairon installs.
  for (const name of listSkillNames()) {
    const skill = nodePath.join(dir, '.claude', 'skills', name);
    if (!pathExists(skill)) continue;
    fs.rmSync(skill, { recursive: true, force: true });
    removed.push(shown(skill));
  }
  for (const empty of [nodePath.join(dir, '.claude', 'skills'), nodePath.join(dir, '.claude')]) {
    if (pathExists(empty) && fs.readdirSync(empty).length === 0) fs.rmdirSync(empty);
  }
  // CLAUDE.md: the root pointer generate writes — removed only when it is exactly that.
  const pointer = nodePath.join(dir, 'CLAUDE.md');
  const raw = pathExists(pointer) ? fs.readFileSync(pointer, 'utf-8') : null;
  const rootStart = raw === null ? -1 : raw.indexOf(ROOT_START);
  const rootEnd = raw === null || rootStart < 0 ? -1 : raw.indexOf(ROOT_END, rootStart);
  if (raw !== null && rootStart >= 0 && rootEnd > rootStart) {
    // wairon's marked block goes; the file only when nothing but it was there.
    const after = raw.slice(rootEnd + ROOT_END.length).replace(/^\r?\n/, '');
    const rest = raw.slice(0, rootStart) + after;
    if (rest.trim() === '') {
      fs.rmSync(pointer);
      removed.push(shown(pointer));
    } else {
      fs.writeFileSync(pointer, rest);
      kept.push(`${shown(pointer)} (the wairon block removed; someone else's text is in it)`);
    }
  } else if (raw !== null) {
    const text = normalizedText(pointer);
    if (text.startsWith(CLAUDE_POINTER_HEAD) && text.includes('# Wairon SDD Project') && text.split('\n').length <= 12) {
      fs.rmSync(pointer);
      removed.push(shown(pointer));
    } else if (text.includes(CLAUDE_POINTER_HEAD)) {
      kept.push(`${shown(pointer)} (it points at the wairon guide, but someone else's text is in it — remove the pointer by hand)`);
    }
  }
  if (removed.length === 0 && kept.length === 0) return;
  logger.info(`"${alias}" is a part now, not a project root: the session scaffold its promote wrote goes with the boundary.`);
  for (const file of removed) logger.info(`  removed ${file}`);
  for (const file of kept) logger.warn(`  kept ${file}`);
}

/**
 * Steps 12-15 of runMigration: each project an applied promote (or an
 * externalize --as project) made gets what `wairon init` gives a project — its
 * guide and root pointer, skills and context (generate's own layer) and, when
 * claude is a configured target, its portable .mcp.json — so a teammate opening
 * its folder has the wairon tools. A failure is reported with the commands to
 * run there, never fatal: the migration itself already committed.
 */
async function provisionMadeProjects(request: MigrationRequest): Promise<void> {
  const madeProject = request.verb === 'promote' || (request.verb === 'externalize' && request.as === 'project');
  if (!madeProject) return;
  const root = nodePath.resolve(getProjectRoot());
  // Where the project was made: a promoted member's folder, or externalize's --path.
  let made: string | undefined;
  if (request.verb === 'externalize') made = request.path ? nodePath.resolve(root, request.path) : undefined;
  else made = projectFamily().nodes.find((n) => n.parent === '' && n.mountAlias === request.alias)?.directory;
  for (const dir of made ? [nodePath.resolve(made)] : []) {
    if (dir === root || !pathExists(nodePath.join(dir, '.wai', 'project.yaml'))) continue;
    const shown = shownDir(dir);
    try {
      await runWithProjectRoot(dir, async () => {
        await runGenerate({});
        runMcpInstall({ global: false, backend: 'claude' });
      });
      logger.success(`Set ${shown} up for its own sessions (guide, skills, .mcp.json): a teammate opens that folder in their AI tool.`);
    } catch (e) {
      logger.warn(`Could not set ${shown} up for its own sessions (${e instanceof Error ? e.message : String(e)}). Run there: \`wairon generate\` and \`wairon mcp install --backend claude\`.`);
    }
  }
}

/** A project key as the plan prints it. */
const ownerLabel = (key: string): string => (key === '' ? 'the top project' : key);

/** How many file lines of one owner the plan prints before it counts the rest. */
const SCREENFUL = 20;

/** A directory as the terminal shows it: relative to where the command ran. */
function shownDir(dir: string): string {
  return nodePath.relative(process.cwd(), dir) || '.';
}

/**
 * A project to re-lock as the plan names it: the directory the command ran in is
 * "this project (.)" — a bare "." read as an empty list.
 */
function relockLabel(dir: string): string {
  const shown = shownDir(dir);
  return shown === '.' ? 'this project (.)' : shown;
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
  if (planned.relock.length > 0) logger.info(`To re-lock once applied: ${planned.relock.map(relockLabel).join(', ')}`);
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
    for (const dir of report.relock) logger.info(`Re-lock ${relockLabel(dir)}: run \`wairon lock\` ${shownDir(dir) === '.' ? 'here' : 'there'}.`);
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

/** icli_runner.runSubsystemExternalize — `wairon subsystem externalize <id> --path <dir> [--as project]`: a subsystem's specs move into a part, or with --as project into a member project. */
export async function runSubsystemExternalize(id: string, options: MigrationCommandOptions = {}): Promise<void> {
  // Step 1: an initialized project.
  requireProject();
  // Steps 2-3: the destination is required.
  if (!options.path) {
    throw new WaironError("--path (the member's destination) is required.");
  }
  // Step 4: the request, with --as (a part by default).
  const request: MigrationRequest = { verb: 'externalize', subsystem: id, path: options.path, ...(options.as !== undefined ? { as: options.as } : {}) };
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
