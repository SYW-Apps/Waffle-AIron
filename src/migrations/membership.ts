import * as path from 'path';
import * as core from './adapters/core.js';
import * as surfaces from './adapters/surfaces.js';
import * as authoring from './adapters/authoring.js';
// family_file_adapter: where a path lands (the containment guard, through links) — a planner touches no file itself.
import * as files from './family-files.js';
import { getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import {
  admits,
  effectiveProjectId,
  memberDeclarationOf,
  requiredPolicies,
  EXTERNAL_ALIAS_RE,
  type ExternalDeclaration,
  type PackSelection,
  type ProjectConfig,
} from '../models/project.js';
import { familyNode, type ProjectFamily, type ProjectNode } from '../models/project-family.js';
import { SURFACE_AUDIENCES } from '../models/specs.js';
import type { ResolvedExportTable } from '../models/exports.js';
import { rehearsalRoot, type MigrationPlan, type MigrationRequest, type PlannedEdit, type PlannedWrite, type Rehearsal } from './types.js';

// ---------------------------------------------------------------------------
// membership_migration — attach, detach and adopt: a project entering or
// leaving the family without any of its own specs moving.
//
// attach declares an EXISTING project as a member (its L0, subsystems, packs
// and lock untouched; `member add` scaffolds a new one instead). detach takes
// a member out: the parent and every family consumer reach it as an external
// by path from then on, pinned. adopt is detach's inverse: an external found
// by a path inside the bound project becomes a member again.
//
// Plans read the live family (the caller has bound its top root) and write
// nothing; each edit carries the one write that realizes it. write binds each
// owner's rehearsal root in turn and makes exactly those calls, restoring the
// caller's binding on every path (each hop is a scoped binding).
// ---------------------------------------------------------------------------

/**
 * A plan with nothing in it yet, over the graph's top root — whole unless a
 * hosted request's reach stops below the family's true top.
 */
function emptyPlan(family: ProjectFamily, request: MigrationRequest): MigrationPlan {
  const reach = getRequestParentReach();
  const whole = !(reach !== null && !reach.parentReach);
  return { request, familyRoot: familyNode(family, '')!.directory, whole, edits: [], refusals: [], changes: [], relock: [], notes: [] };
}

const posix = (p: string): string => p.split(path.sep).join('/');
const refuse = (plan: MigrationPlan, code: string, project: string, detail: string): void => {
  plan.refusals.push({ code, project, detail });
};
const edit = (plan: MigrationPlan, project: string, kind: string, detail: string, write: PlannedWrite): void => {
  plan.edits.push({ project, kind, detail, write });
};
const label = (key: string): string => (key === '' ? 'the top project' : `"${key}"`);


/** A project's configuration, read under its own binding; null when it has none or it fails its schema. */
function configAt(dir: string): ProjectConfig | null {
  return runWithProjectRoot(dir, () => {
    try {
      return core.loadProjectConfig();
    } catch {
      return null;
    }
  });
}

/** Whether a directory holds a project L0, read under its own binding. */
function hasSystemAt(dir: string): boolean {
  return runWithProjectRoot(dir, () => {
    try {
      return core.loadSpec('system', 'system') !== null;
    } catch {
      return false;
    }
  });
}

/** The node the bound project is in the graph. */
function boundNode(family: ProjectFamily, bound: string): ProjectNode {
  return familyNode(family, bound)!;
}

/** The family node at a directory, if one is there. */
function nodeAt(family: ProjectFamily, dir: string): ProjectNode | undefined {
  return family.nodes.find((n) => path.resolve(n.directory) === path.resolve(dir));
}

// ── attach ──────────────────────────────────────────────────────────────────

/** imembership_migration.planAttach — plan making an existing project a member. Writes nothing. */
export function planAttach(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const node = boundNode(family, bound);
  const alias = request.alias ?? '';
  // Step 1: the path, under the containment guard.
  const dir = files.resolve(node.directory, request.path ?? '');
  if (dir === null) refuse(plan, 'not-contained', bound, `the path "${request.path ?? ''}" does not resolve strictly within ${label(bound)} (${node.directory})`);
  // Step 2: the alias against the bound project's alias table.
  const config = configAt(node.directory) ?? ({} as ProjectConfig);
  // A completed attach plans nothing: the alias already declares this directory.
  const held = config.members?.[alias];
  if (dir !== null && held !== undefined && path.resolve(node.directory, memberDeclarationOf(held).path) === dir) return plan;
  if (!EXTERNAL_ALIAS_RE.test(alias)) refuse(plan, 'alias-taken', bound, `"${alias}" is no alias: an alias must fit [a-z0-9-_]+`);
  else if (config.members?.[alias] !== undefined || config.externals?.[alias] !== undefined) refuse(plan, 'alias-taken', bound, `${label(bound)} already declares "${alias}"`);
  if (dir !== null) {
    const external = Object.entries(config.externals ?? {}).find(([, e]) => e.source?.path && path.resolve(node.directory, e.source.path) === dir);
    if (external) refuse(plan, 'already-member', bound, `${label(bound)}'s external "${external[0]}" already names ${dir} — make it a member with \`wairon member adopt ${external[0]}\``);
    else if (nodeAt(family, dir)) refuse(plan, 'already-member', nodeAt(family, dir)!.namespace, `${dir} is already the family project ${label(nodeAt(family, dir)!.namespace)}`);
  }
  // Steps 3-4.
  if (plan.refusals.length > 0) return plan;
  return attachEdits(plan, family, bound, dir!, alias, config);
}

/** Steps 5-9 of planAttach: read the project, judge it, plan its edits. */
function attachEdits(plan: MigrationPlan, family: ProjectFamily, bound: string, dir: string, alias: string, bindingConfig: ProjectConfig): MigrationPlan {
  // Step 5: its configuration.
  const attached = configAt(dir);
  // Step 6: the id its lock approved.
  const approved = core.approvalRecord(dir)?.projectId;
  // Step 7: judge it.
  if (!attached && !hasSystemAt(dir)) {
    refuse(plan, 'not-a-project', dir, `${dir} holds no project: no .wai/project.yaml and no L0`);
    return plan;
  }
  const effective = attached ? effectiveProjectId(attached) ?? undefined : undefined;
  const id = attached?.id ?? approved ?? effective;
  const colliding = id !== undefined ? family.nodes.find((n) => n.id === id) : undefined;
  if (colliding) {
    refuse(plan, 'id-collision', colliding.namespace, `the project at ${dir} answers to "${id}", which ${label(colliding.namespace)} (${colliding.directory}) answers to as well (PROJECT_ID_COLLISION)`);
    return plan;
  }
  // Step 8: its id declared only when it declares none; then the member.
  const key = id ?? alias;
  if (attached && attached.id === undefined && id !== undefined) {
    edit(plan, key, 'id', `id: ${id} (declared${approved !== undefined ? ', the id its lock approved' : ''})`, { root: dir, call: 'setId', args: [id] });
  }
  if (!attached) plan.notes.push(`${dir} has no project.yaml of its own — \`wairon doctor --fix\` writes one declaring "${alias}" as its id`);
  const relPath = posix(path.relative(familyNode(family, bound)!.directory, dir));
  const declaration = { path: relPath, ...(plan.request.description !== undefined ? { description: plan.request.description } : {}) };
  edit(plan, bound, 'member', `members: ${alias} → ${relPath} (an existing project, kept as it is)`, { root: familyNode(family, bound)!.directory, call: 'declareMember', args: [alias, declaration] });
  for (const requirement of requiredPolicies(bindingConfig)) {
    const selected = (attached?.extensions?.packs ?? []).find((p): p is PackSelection => typeof p !== 'string' && p.name === requirement.pack);
    if (!selected || !admits(requirement, selected.version)) {
      plan.notes.push(`${label(bound)} requires the pack ${requirement.pack}@${requirement.version}, which the attached project does not select — the family run reports it (POLICY_NOT_ADOPTED); nothing is scaffolded into it`);
    }
  }
  // Step 9.
  return plan;
}

// ── detach ──────────────────────────────────────────────────────────────────

/** Whether a project is the member itself or lies below it (one of its own members, at any depth). */
function withinMember(family: ProjectFamily, member: ProjectNode, key: string): boolean {
  for (let node = familyNode(family, key); node; node = node.parent !== undefined ? familyNode(family, node.parent) : null) {
    if (node.namespace === member.namespace) return true;
  }
  return false;
}

/** The member of the bound project under an alias, or the refusal that says why there is none. */
function memberUnder(family: ProjectFamily, bound: string, alias: string, plan: MigrationPlan): ProjectNode | null {
  const member = family.nodes.find((n) => n.parent === bound && n.mountAlias === alias);
  if (member) return member;
  const absent = family.problems.find((p) => p.kind === 'member-absent' && p.id === alias && p.projects.includes(bound));
  if (absent) refuse(plan, 'member-absent', bound, `${label(bound)}'s member "${alias}" is absent: ${absent.detail}`);
  else refuse(plan, 'not-a-member', bound, `${label(bound)} declares no member "${alias}"`);
  return null;
}

/** imembership_migration.planDetach — plan taking a member out of the family. Writes nothing. */
export function planDetach(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  // A completed detach plans nothing: the alias is an external found by path.
  const done = configAt(familyNode(family, bound)!.directory)?.externals?.[alias];
  if (done?.source?.path && !family.nodes.some((n) => n.parent === bound && n.mountAlias === alias)) return plan;
  // Step 1.
  const member = memberUnder(family, bound, alias, plan);
  // Steps 2-3.
  if (!member) return plan;
  // Step 4: the member's export table — the audience of each name the family reaches in it.
  const table = core.resolveProjectExports(member.namespace || undefined);
  // Step 5: the family consumers finding it through the family, and its own family externals.
  // The member's own members leave with it, so they are neither consumers nor producers it must find by path.
  const leaving = (key: string | undefined): boolean => key !== undefined && withinMember(family, member, key);
  const consumers = family.nodes.flatMap((n) => (leaving(n.namespace) ? [] : n.externals
    .filter((e) => e.sourceKind === 'family' && e.producer === member.namespace && !(n.namespace === bound && e.alias === alias))
    .map((e) => ({ node: n, alias: e.alias }))));
  const outward = member.externals.filter((e) => e.sourceKind === 'family' && e.producer !== undefined && !leaving(e.producer));
  if (member.mountForm === 'mount') refuse(plan, 'not-a-member', bound, `${label(bound)} declares "${alias}" in the legacy L1 mount form — run \`wairon doctor --fix\` first, which moves it into \`members\``);
  if (!plan.whole) refuse(plan, 'family-partial', '', 'the family\'s top is out of this request\'s reach, and a consumer of the member could live there — run from the top project');
  const narrow = familyOnlyUses(family, member, table);
  if (!plan.request.widen) refuseNarrow(plan, member, narrow);
  if (plan.refusals.length > 0) return plan;
  // With --widen, each of them is widened in the member's L0 first — or refused when no entry names it.
  if (plan.request.widen) planWidening(plan, member, narrow);
  if (plan.refusals.length > 0) return plan;
  // Step 6: the member's declaration.
  const boundDir = familyNode(family, bound)!.directory;
  const declared = memberDeclarationOf(configAt(boundDir)?.members?.[alias] ?? posix(path.relative(boundDir, member.directory)));
  // Step 7: the edits.
  detachEdits(plan, family, bound, member, alias, declared, consumers, outward);
  // Step 8.
  return plan;
}

/** One export of the member the family uses below the instance audience, with who uses it. */
interface NarrowExport {
  name: string;
  audience: string;
  users: string[];
}

/**
 * Step 5: every public name a family project reaches in the member that the
 * member exports below the instance audience, with its users. Outside the
 * family, a pin taken by path sees instance and above, so each such use would
 * stop resolving.
 */
function familyOnlyUses(family: ProjectFamily, member: ProjectNode, table: ResolvedExportTable): NarrowExport[] {
  const floor = SURFACE_AUDIENCES.indexOf('instance');
  const out = new Map<string, NarrowExport>();
  for (const ref of family.authoredReferences) {
    const user = family.owners.get(ref.specId) ?? '';
    if (ref.producer !== member.namespace || withinMember(family, member, user) || !ref.publicName) continue;
    const audience = table.entries.find((e) => e.publicName === ref.publicName)?.audience ?? 'instance';
    if (SURFACE_AUDIENCES.indexOf(audience as (typeof SURFACE_AUDIENCES)[number]) >= floor) continue;
    const held = out.get(ref.publicName) ?? { name: ref.publicName, audience, users: [] };
    if (!held.users.includes(user)) held.users.push(user);
    out.set(ref.publicName, held);
  }
  return [...out.values()];
}

/** Without --widen: one audience-too-narrow per export, naming every project that uses it — widening is a design decision, never a silent side effect. */
function refuseNarrow(plan: MigrationPlan, member: ProjectNode, narrow: NarrowExport[]): void {
  for (const e of narrow) {
    refuse(plan, 'audience-too-narrow', member.namespace, `${label(member.namespace)} exports "${e.name}" to audience "${e.audience}" only, and ${e.users.map(label).join(', ')} use${e.users.length === 1 ? 's' : ''} it — outside the family a pin sees "instance" and above, so the use would stop resolving; it needs audience "instance" (detach --widen widens exactly the used exports)`);
  }
}

/**
 * With --widen: each used family-only export's L0 entry in the member widened
 * to the instance audience, through the gated authoring seam — exactly those,
 * each shown. An export no L0 entry of the member names directly (one reached
 * through a wholesale re-export) cannot be widened here and stays refused.
 */
function planWidening(plan: MigrationPlan, member: ProjectNode, narrow: NarrowExport[]): void {
  if (narrow.length === 0) return;
  const system = runWithProjectRoot(member.directory, () => core.loadSpec('system', 'system')) as { publicInterfaces?: Record<string, unknown>[] } | null;
  const entries = system?.publicInterfaces ?? [];
  for (const e of narrow) {
    const entry = entries.find((x) => (x.as ?? x.component ?? x.typeDef) === e.name);
    if (!entry) {
      refuse(plan, 'audience-too-narrow', member.namespace, `${label(member.namespace)} exports "${e.name}" to audience "${e.audience}" only through no L0 entry of its own (a wholesale re-export) — --widen cannot widen it; give it an entry at audience "instance" by hand`);
      continue;
    }
    const delta = { publicInterfaces: [{ ...entry, audience: 'instance' }] };
    edit(plan, member.namespace, 'export', `widen ${e.name} ${e.audience}→instance (used by ${e.users.map(label).join(', ')})`, { root: member.directory, call: 'updateSpecGated', args: ['system', 'system', delta] });
  }
}

/** Step 7 of planDetach. */
function detachEdits(
  plan: MigrationPlan,
  family: ProjectFamily,
  bound: string,
  member: ProjectNode,
  alias: string,
  declared: { path: string; description?: string; use?: string[] },
  consumers: { node: ProjectNode; alias: string }[],
  outward: ProjectNode['externals'],
): void {
  const boundDir = familyNode(family, bound)!.directory;
  edit(plan, bound, 'member', `members: ${alias} removed (${declared.path} stays as it is)`, { root: boundDir, call: 'removeMember', args: [alias] });
  const external: ExternalDeclaration = {
    ...(member.id !== undefined && member.id !== alias ? { project: member.id } : {}),
    source: { path: declared.path },
    ...(declared.use && declared.use.length > 0 ? { use: declared.use } : {}),
    ...(declared.description !== undefined ? { description: declared.description } : {}),
  };
  edit(plan, bound, 'external', `externals: ${alias} → ${member.id ?? alias} at ${declared.path}`, { root: boundDir, call: 'declareExternal', args: [alias, external] });
  for (const c of consumers) {
    const held = configAt(c.node.directory)?.externals?.[c.alias];
    const source = { path: posix(path.relative(c.node.directory, member.directory)) };
    edit(plan, c.node.namespace, 'external', `externals: ${c.alias} found at ${source.path} (it leaves the family)`, { root: c.node.directory, call: 'repointExternal', args: [c.alias, held?.project ?? null, source] });
  }
  const own = configAt(member.directory)?.externals ?? {};
  for (const e of outward) {
    const producer = familyNode(family, e.producer!)!;
    const source = { path: posix(path.relative(member.directory, producer.directory)) };
    edit(plan, member.namespace, 'external', `externals: ${e.alias} found at ${source.path} (the member leaves the family)`, { root: member.directory, call: 'repointExternal', args: [e.alias, own[e.alias]?.project ?? null, source] });
  }
  edit(plan, bound, 'pin', `pin ${alias} (the detached project's surface, read last)`, { root: boundDir, call: 'pinExternals', args: [[alias]] });
  plan.notes.push(`Consumers outside the family are not affected: they already name ${member.id ?? alias} by path, or not at all.`);
}

// ── adopt ───────────────────────────────────────────────────────────────────

/** imembership_migration.planAdopt — plan making an external found by path a member again. Writes nothing. */
export function planAdopt(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  const boundDir = familyNode(family, bound)!.directory;
  // Step 1: the external under the alias.
  const boundConfig = configAt(boundDir);
  const external = boundConfig?.externals?.[alias];
  // A completed adopt plans nothing: the alias is a member again.
  if (!external && boundConfig?.members?.[alias] !== undefined) return plan;
  // Step 2: judge it.
  let dir: string | null = null;
  if (!external) refuse(plan, 'not-an-external', bound, `${label(bound)} declares no external "${alias}"`);
  else {
    // Step 2: where its source path lands, under the containment guard.
    dir = files.resolve(boundDir, external.source?.path ?? '');
    if (dir === null) refuse(plan, 'not-contained', bound, `the external "${alias}" ${external.source?.path ? `is found at "${external.source.path}", which is not strictly within ${label(bound)}` : 'names no source.path'}`);
    else if (nodeAt(family, dir)) refuse(plan, 'already-member', nodeAt(family, dir)!.namespace, `${dir} is already the family project ${label(nodeAt(family, dir)!.namespace)}`);
  }
  // Steps 3-4.
  if (plan.refusals.length > 0) return plan;
  return adoptEdits(plan, family, bound, alias, external!, dir!);
}

/** Steps 5-8 of planAdopt. */
function adoptEdits(plan: MigrationPlan, family: ProjectFamily, bound: string, alias: string, external: ExternalDeclaration, dir: string): MigrationPlan {
  const boundDir = familyNode(family, bound)!.directory;
  // Step 5: the adoptee.
  const adoptee = configAt(dir);
  // Step 6: judge it.
  if (!adoptee && !hasSystemAt(dir)) {
    refuse(plan, 'not-a-project', dir, `${dir} holds no project: no .wai/project.yaml and no L0`);
    return plan;
  }
  const id = adoptee ? effectiveProjectId(adoptee) ?? undefined : undefined;
  const colliding = id !== undefined ? family.nodes.find((n) => n.id === id) : undefined;
  if (colliding) {
    refuse(plan, 'id-collision', colliding.namespace, `the project at ${dir} answers to "${id}", which ${label(colliding.namespace)} answers to as well`);
    return plan;
  }
  // Step 7: the edits.
  const key = id ?? alias;
  edit(plan, bound, 'pin', `pin ${alias} removed (the family supplies it now)`, { root: boundDir, call: 'unpin', args: [alias] });
  edit(plan, bound, 'external', `externals: ${alias} removed`, { root: boundDir, call: 'removeExternal', args: [alias] });
  const declaration = {
    path: posix(path.relative(boundDir, dir)),
    ...(external.description !== undefined ? { description: external.description } : {}),
    ...(external.use && external.use.length > 0 ? { use: external.use } : {}),
  };
  edit(plan, bound, 'member', `members: ${alias} → ${declaration.path}`, { root: boundDir, call: 'declareMember', args: [alias, declaration] });
  for (const n of family.nodes) {
    for (const [a, e] of Object.entries(configAt(n.directory)?.externals ?? {})) {
      if (n.namespace === bound && a === alias) continue;
      if (!e.source?.path || path.resolve(n.directory, e.source.path) !== path.resolve(dir)) continue;
      edit(plan, n.namespace, 'external', `externals: ${a} found through the family (its source.path ${e.source.path} removed)`, { root: n.directory, call: 'repointExternal', args: [a, e.project ?? null, null] });
      plan.notes.push(`${label(n.namespace)}'s external "${a}" named the adoptee by path; adopt removes it — detach-then-adopt is exact only when detach wrote that path`);
    }
  }
  for (const [a, e] of Object.entries(adoptee?.externals ?? {})) {
    if (!e.source?.path || !nodeAt(family, path.resolve(dir, e.source.path))) continue;
    edit(plan, key, 'external', `externals: ${a} found through the family (its source.path ${e.source.path} removed)`, { root: dir, call: 'repointExternal', args: [a, e.project ?? null, null] });
  }
  // Step 8.
  return plan;
}

// ── write ───────────────────────────────────────────────────────────────────

/** imembership_migration.write — make a confirmed plan's writes in the rehearsal roots, pins last. Idempotent. */
export function write(plan: MigrationPlan, rehearsal: Rehearsal): void {
  // Step 1: every hop below is a scoped binding, so the caller's binding is restored on every path.
  const planned = plan.edits.filter((e): e is PlannedEdit & { write: PlannedWrite } => e.write !== undefined);
  // Step 2: which verb — the calls are the plan's, in its order.
  switch (plan.request.verb) {
    case 'attach':
      // Steps 3-4: the attached project's id, then the member.
      for (const e of planned) writeOne(rehearsal, e.write);
      break;
    case 'detach':
      // Step 6: the member's widened exports first (--widen), through the gated seam.
      for (const e of planned.filter((x) => x.write.call === 'updateSpecGated')) writeOne(rehearsal, e.write);
      // Steps 7-9: the member removed, the external declared, the source paths given; step 10: the pin last.
      for (const e of planned.filter((x) => x.write.call !== 'pinExternals' && x.write.call !== 'updateSpecGated')) writeOne(rehearsal, e.write);
      for (const e of planned.filter((x) => x.write.call === 'pinExternals')) writeOne(rehearsal, e.write);
      break;
    case 'adopt':
      // Steps 11-14: the pin and the external removed, the member declared, the redundant source paths removed.
      for (const e of planned) writeOne(rehearsal, e.write);
      break;
    default:
      throw new Error(`membership_migration writes attach, detach and adopt, not "${plan.request.verb}"`);
  }
  // Step 15: the caller's binding is back.
}

/** One planned write, under its owner's rehearsal root. */
function writeOne(rehearsal: Rehearsal, w: PlannedWrite): void {
  const args = w.args as never[];
  runWithProjectRoot(rehearsalRoot(rehearsal, w.root), () => {
    switch (w.call) {
      case 'setId': return core.setId(args[0]);
      case 'declareMember': return core.declareMember(args[0], args[1]);
      case 'removeMember': return core.removeMember(args[0]);
      case 'declareExternal': return core.declareExternal(args[0], args[1]);
      case 'repointExternal': return core.repointExternal(args[0], args[1], args[2]);
      case 'removeExternal': return core.removeExternal(args[0]);
      case 'pinExternals': return surfaces.pinExternals(args[0]);
      case 'unpin': return surfaces.unpin(args[0]);
      case 'updateSpecGated': return authoring.updateSpecGated(args[0], args[1], args[2]);
      default: throw new Error(`membership_migration makes no "${w.call}" write`);
    }
  });
}
