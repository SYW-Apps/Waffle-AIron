import * as path from 'path';
import * as core from './adapters/core.js';
import * as surfaces from './adapters/surfaces.js';
// family_file_adapter: where a path lands and whether a project is there — a planner touches no file itself.
import * as files from './family-files.js';
import { getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { memberLocationOf, type InternalizeDestination, type ProjectConfig } from '../models/project.js';
import { familyNode, keyIn, type AuthoredReference, type ProjectFamily, type ProjectNode, type ReferenceEdit } from '../models/project-family.js';
import type { ComponentSpec, ImplementationSpec, InterfaceSpec, SubsystemSpec, SystemSpec } from '../models/specs.js';
import { rehearsalRoot, type MigrationPlan, type MigrationRequest, type PlannedEdit, type PlannedWrite, type Rehearsal } from './types.js';

// ---------------------------------------------------------------------------
// boundary_migration — internalize and externalize: specs crossing a project
// boundary, family-wide.
//
// The parent-scoped move is sdd_core's (internalizeMember, externalizeSubsystem);
// this adds the family's other projects around it. Internalize folds a member
// into the bound project — every subsystem, with its own metadata sent to an
// explicit destination — and re-points every other family project that
// consumed it at the bound project, completing the bound project's exports
// with every public name they use. Externalize turns a subsystem into a member
// and checks, without writing them, that every other family project's names
// still resolve (externalize-updates-siblings).
//
// Plans read the live family (the caller has bound its top root) and write
// nothing; each edit carries the one write that realizes it. A core refusal
// met when the plan is rehearsed propagates as the plan's refusal.
// ---------------------------------------------------------------------------

/** A plan with nothing in it yet, over the graph's top root; whole unless a hosted request's reach stops below the true top. */
function emptyPlan(family: ProjectFamily, request: MigrationRequest): MigrationPlan {
  const reach = getRequestParentReach();
  const whole = !(reach !== null && !reach.parentReach);
  return { request, familyRoot: familyNode(family, '')!.directory, whole, edits: [], refusals: [], changes: [], relock: [], notes: [] };
}

const posix = (p: string): string => p.split(path.sep).join('/');
const label = (key: string): string => (key === '' ? 'the top project' : `"${key}"`);
const refuse = (plan: MigrationPlan, code: string, project: string, detail: string): void => {
  plan.refusals.push({ code, project, detail });
};
const edit = (plan: MigrationPlan, project: string, kind: string, detail: string, write: PlannedWrite, reference?: ReferenceEdit): void => {
  plan.edits.push({ project, kind, detail, ...(reference ? { reference } : {}), write });
};

/** A project's configuration under its own binding; null when it has none or it fails its schema. */
function configAt(dir: string): ProjectConfig | null {
  return runWithProjectRoot(dir, () => {
    try {
      return core.loadProjectConfig();
    } catch {
      return null;
    }
  });
}

/** The positions a reference may stand at, by the kinds of spec that hold them. */
const KINDS_AT: Record<string, string[]> = {
  dependsOn: ['component'], owns: ['component'], dispatch: ['component'], mounts: ['component'],
  lifecycle: ['subsystem'], publicInterfaces: ['subsystem'], trustedLinks: ['subsystem'],
  contract: ['implementation', 'interface'], narrative: ['implementation'], calls: ['implementation'], auth: ['implementation'],
  subsystem: ['component', 'type'], group: ['type'], type: ['interface', 'type'],
};

/** The kind of the spec holding a reference, read off where it sits (under the top root's binding). */
function kindOf(ref: AuthoredReference): string {
  const kinds = KINDS_AT[ref.position] ?? ['component', 'interface', 'implementation', 'type', 'subsystem'];
  return kinds.find((k) => core.loadSpec(k as 'component', ref.specId) !== null) ?? kinds[0];
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

// ── internalize ─────────────────────────────────────────────────────────────

/** One family project that consumes the member, under the alias it names it by. */
interface Consumer {
  node: ProjectNode;
  alias: string;
}

/** iboundary_migration.planInternalize — plan folding a member into the bound project, family-wide. Writes nothing. */
export function planInternalize(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  // Stage 8: a part is a storage move only — its specs are already the project's own.
  const part = familyNode(family, bound)?.parts.find((p) => p.alias === alias);
  if (part) return planPartInternalize(plan, family, bound, alias, part);
  // Step 1.
  const member = memberUnder(family, bound, alias, plan);
  // Steps 2-3.
  if (!member) return plan;
  // Step 4: every other family project consuming the member, its own members included.
  const consumers = consumersOf(family, bound, member);
  if (!plan.whole) refuse(plan, 'family-partial', '', 'the family\'s top is out of this request\'s reach, and a consumer of the member could live there — run from the top project');
  if (plan.refusals.length > 0) return plan;
  // Steps 5-7: the destination's exports completed with every public name a consumer uses.
  const exports = completedExports(plan, family, bound, member, consumers);
  if (plan.refusals.length > 0) return plan;
  // Step 8: the externals the bound project carries (to pin there).
  const carried = carriedExternals(family, bound, member);
  // Step 9: the edits.
  const destination: InternalizeDestination = { ...(request.destination ?? { home: '' }), exports };
  internalizeEdits(plan, family, bound, member, alias, consumers, destination, carried);
  // Step 10.
  return plan;
}

/**
 * planInternalize for a PART (stage 8): the core's internalize moves its
 * subsystems in and removes the member entry and the part's .wai; no reference
 * changes and no other family project is touched.
 */
function planPartInternalize(plan: MigrationPlan, family: ProjectFamily, bound: string, alias: string, part: ProjectNode['parts'][number]): MigrationPlan {
  if (part.storage === 'git') refuse(plan, 'read-only', bound, `the part "${alias}" is fetched from git (${part.commit ?? 'its pinned commit'}): its files are the fetch cache's — internalize it in a checkout of its repository`);
  else if (part.directory === undefined) refuse(plan, 'member-absent', bound, `${label(bound)}'s part "${alias}" cannot be read: ${part.reason ?? 'its directory is absent'}`);
  else if (!insideFamily(plan, part.directory)) refuse(plan, 'not-contained', bound, `the part "${alias}" is stored outside the family root (${part.directory}), where one transaction cannot write it`);
  if (plan.refusals.length > 0) return plan;
  const node = familyNode(family, bound)!;
  edit(plan, bound, 'move', `internalize ${alias}: the part's subsystems (${part.subsystems.join(', ') || 'none'}) move into ${label(bound)}'s own specs folder — a storage move, no reference changes`,
    { root: node.directory, call: 'internalizeMember', args: [alias, { home: '' }] });
  plan.edits.push({ project: bound, kind: 'delete', detail: `what remains of ${alias}'s .wai (its PartOf, its pin of the parent): deleted, each listed` });
  return plan;
}

/** Every family project other than the bound one that names the member, by the alias it uses. */
function consumersOf(family: ProjectFamily, bound: string, member: ProjectNode): Consumer[] {
  const out: Consumer[] = [];
  for (const node of family.nodes) {
    if (node.namespace === bound || node.namespace === member.namespace) continue;
    for (const [alias, key] of node.aliases) if (key === member.namespace) out.push({ node, alias });
    for (const e of node.externals) {
      if (e.sourceKind !== 'path' || !e.directory || path.resolve(e.directory) !== path.resolve(member.directory)) continue;
      if (!out.some((c) => c.node === node && c.alias === e.alias)) out.push({ node, alias: e.alias });
    }
  }
  return out;
}

/** Steps 5-7: the names consumers use (and any a person adds), none colliding with a name the bound project exports for another target. */
function completedExports(plan: MigrationPlan, family: ProjectFamily, bound: string, member: ProjectNode, consumers: Consumer[]): string[] {
  const memberTable = core.resolveProjectExports(member.namespace || undefined);
  const boundTable = core.resolveProjectExports(bound || undefined);
  const consumerKeys = new Set(consumers.map((c) => c.node.namespace));
  const names = new Set(plan.request.destination?.exports ?? []);
  for (const ref of family.authoredReferences) {
    if (ref.producer === member.namespace && ref.publicName && consumerKeys.has(family.owners.get(ref.specId) ?? '')) names.add(ref.publicName);
  }
  for (const c of consumers) {
    for (const name of c.node.imports.find((i) => i.alias === c.alias)?.use ?? []) if (name !== '*') names.add(name);
  }
  for (const name of names) {
    if (!memberTable.entries.some((e) => e.publicName === name)) continue;
    const held = boundTable.entries.find((e) => e.publicName === name);
    const target = held?.component ?? held?.typeDef;
    if (held && target !== undefined && family.owners.get(target) !== member.namespace) {
      refuse(plan, 'name-collision', bound, `${label(bound)} already exports "${name}" for ${target}, and a family project uses the member's "${name}"`);
    }
  }
  return [...names].filter((n) => memberTable.entries.some((e) => e.publicName === n)).sort();
}

/** Step 8: the member's externals other than the bound project, that the bound project will declare and pin. */
function carriedExternals(family: ProjectFamily, bound: string, member: ProjectNode): string[] {
  const boundNode = familyNode(family, bound)!;
  const boundConfig = configAt(boundNode.directory);
  return Object.entries(configAt(member.directory)?.externals ?? {})
    .filter(([a, e]) => (e.project ?? a) !== boundNode.id && boundConfig?.members?.[a] === undefined)
    .map(([a]) => a);
}

/** Step 9: each consumer's edits, the core's internalize, and the pins. */
function internalizeEdits(
  plan: MigrationPlan, family: ProjectFamily, bound: string, member: ProjectNode, alias: string,
  consumers: Consumer[], destination: InternalizeDestination, carried: string[],
): void {
  const boundNode = familyNode(family, bound)!;
  const repinned: Consumer[] = [];
  for (const c of consumers) {
    const own = [...c.node.aliases].find(([, key]) => key === bound)?.[0];
    if (own !== undefined) respellConsumer(plan, family, c, own);
    else repinned.push(repointConsumer(plan, c, boundNode));
  }
  edit(plan, bound, 'move', `internalize ${alias}: its subsystems into ${label(bound)}${destination.home ? `, its L0 vision to ${destination.home}` : ''}${destination.exports?.length ? `, exporting ${destination.exports.join(', ')}` : ''}${destination.packs ? `, its packs ${destination.packs === 'adopt' ? 'adopted' : 'dropped'}` : ''}`,
    { root: boundNode.directory, call: 'internalizeMember', args: [alias, destination] });
  for (const c of repinned) {
    edit(plan, c.node.namespace, 'pin', `pin ${c.alias} taken again against ${boundNode.id ?? 'the top project'}`, { root: c.node.directory, call: 'pinExternals', args: [[c.alias]] });
  }
  if (carried.length > 0) edit(plan, bound, 'pin', `pin ${carried.join(', ')} (externals carried from ${alias})`, { root: boundNode.directory, call: 'pinExternals', args: [carried] });
  plan.edits.push({ project: member.namespace, kind: 'delete', detail: `${alias}'s lock, pins and derived outputs have no home: deleted, each listed` });
  plan.notes.push(`Consumers outside the family that name "${member.id ?? alias}" by path are not found: each must repoint its own external at ${boundNode.id ?? 'this project'}.`);
  if (member.id !== undefined && core.approvalRecord(member.directory)) plan.notes.push(`${label(member.namespace)}'s approval ends with it: its lock is deleted, and ${label(bound)} is re-locked instead.`);
}

/** A consumer that already names the bound project: its references respelled to that alias, the member's `use` merged, the member external and pin removed. */
function respellConsumer(plan: MigrationPlan, family: ProjectFamily, c: Consumer, own: string): void {
  const seen = new Set<string>();
  for (const ref of family.authoredReferences) {
    if (ref.form !== 'alias' || (family.owners.get(ref.specId) ?? '') !== c.node.namespace || !ref.authored.startsWith(`${c.alias}::`)) continue;
    const key = `${ref.specId}|${ref.position}|${ref.authored}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const reference: ReferenceEdit = { kind: kindOf(ref), specId: ref.specId, position: ref.position, from: ref.authored, to: `${own}${ref.authored.slice(c.alias.length)}` };
    edit(plan, c.node.namespace, 'reference', `${ref.specId} (${ref.position}): ${reference.from} → ${reference.to}`,
      { root: plan.familyRoot, call: 'rewriteReferences', args: [reference.kind, reference.specId, [reference]] }, reference);
  }
  const use = c.node.imports.find((i) => i.alias === c.alias)?.use ?? [];
  if (use.length > 0) edit(plan, c.node.namespace, 'external', `${own}.use gains ${use.join(', ')} (from ${c.alias})`, { root: c.node.directory, call: 'importNames', args: [own, use] });
  edit(plan, c.node.namespace, 'pin', `pin ${c.alias} removed`, { root: c.node.directory, call: 'unpin', args: [c.alias] });
  edit(plan, c.node.namespace, 'external', `externals: ${c.alias} removed (${own} supplies it now)`, { root: c.node.directory, call: 'removeExternal', args: [c.alias] });
}

/** Any other consumer: its external repointed at the bound project's id (a source path re-expressed), re-pinned last. */
function repointConsumer(plan: MigrationPlan, c: Consumer, boundNode: ProjectNode): Consumer {
  const declared = configAt(c.node.directory)?.externals?.[c.alias];
  const project = boundNode.id !== undefined && boundNode.id !== c.alias ? boundNode.id : null;
  const source = declared?.source ? { path: posix(path.relative(c.node.directory, boundNode.directory)) } : null;
  edit(plan, c.node.namespace, 'external', `externals: ${c.alias} names ${boundNode.id ?? 'the top project'}${source ? ` at ${source.path}` : ''}`, { root: c.node.directory, call: 'repointExternal', args: [c.alias, project, source] });
  plan.notes.push(`${label(c.node.namespace)}'s pin of "${c.alias}" is taken again against ${boundNode.id ?? 'the top project'}: the producer changed, so its lock reads drifted until it is re-locked.`);
  return c;
}

// ── externalize ─────────────────────────────────────────────────────────────

/** iboundary_migration.planExternalize — plan turning a subsystem into a member. Writes nothing. */
export function planExternalize(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const id = request.subsystem ?? '';
  const node = familyNode(family, bound)!;
  const subKey = keyIn(bound, id);
  // A completed externalize plans nothing: the id is a member at that path, and no subsystem of ours any more.
  const done = configAt(node.directory)?.members?.[id];
  const donePath = done === undefined ? undefined : memberLocationOf(done);
  const asProject = request.as === 'project';
  if (donePath !== undefined && request.path !== undefined && path.resolve(node.directory, donePath) === path.resolve(node.directory, request.path)) return plan;
  // Steps 1-2: where the path lands, and whether a project is already there.
  const dir = files.resolve(node.directory, request.path ?? '');
  const occupied = dir !== null && files.holdsProject(dir);
  // Step 3: judge the request.
  const sub = id.includes('::') ? null : core.loadSpec('subsystem', subKey) as SubsystemSpec | null;
  const inPart = node.parts.some((p) => p.subsystems.includes(subKey));
  if (!sub || sub.projectPath || (family.owners.get(subKey) ?? '') !== bound || inPart) refuse(plan, 'externalize-refused', bound, `${label(bound)} has no subsystem "${id}" to externalize (it is missing, already in a part, or a member)`);
  if (request.as !== undefined && request.as !== 'part' && request.as !== 'project') refuse(plan, 'externalize-refused', bound, `\`as: ${request.as}\` — a member is a part or a project`);
  if (dir === null) refuse(plan, 'not-contained', bound, `the path "${request.path ?? ''}" does not resolve strictly within ${label(bound)}`);
  else if (family.nodes.some((n) => path.resolve(n.directory) === dir) || occupied) {
    refuse(plan, 'not-contained', bound, `${dir} already holds a project`);
  }
  // An existing part at that directory is joined (stage 8): its alias is taken by it, rightly.
  const joined = dir === null ? undefined : node.parts.find((p) => p.directory !== undefined && path.resolve(p.directory) === dir);
  const config = configAt(node.directory);
  if (!joined && (config?.members?.[id] !== undefined || config?.externals?.[id] !== undefined)) refuse(plan, 'alias-taken', bound, `${label(bound)} already declares the alias "${id}"`);
  if (joined && asProject) refuse(plan, 'externalize-refused', bound, `externalize into the part "${joined.alias}" and promote the part, rather than externalize as a project into it`);
  const colliding = asProject ? family.nodes.find((n) => n.id === id) : undefined;
  if (colliding) refuse(plan, 'id-collision', colliding.namespace, `${label(colliding.namespace)} already answers to "${id}"`);
  // Steps 4-5.
  if (plan.refusals.length > 0) return plan;
  // As a part (the default): a storage move — nothing crosses, so nothing more is checked.
  if (!asProject) {
    edit(plan, bound, 'move', `externalize ${id}: its specs into ${joined ? `the part "${joined.alias}"` : `a part at ${posix(path.relative(node.directory, dir!))}, declared as "${id}"`} — a storage move; no reference, export or pin changes`,
      { root: node.directory, call: 'externalizeSubsystem', args: [id, posix(path.relative(node.directory, dir!))] });
    plan.notes.push('Source code is not moved: move the subsystem\'s code yourself if it should live beside its specs.');
    return plan;
  }
  // Step 6: the bound project's export table.
  const table = core.resolveProjectExports(bound || undefined);
  // Step 7: references of the moved subtree back into an unpublished component.
  crossingsBack(plan, family, bound, subKey);
  // Step 8: every other family project's names still resolve.
  checkSiblings(plan, family, bound, id, subKey, table);
  if (plan.refusals.length > 0) return plan;
  // Step 9: the core's externalize as a project, and the new member's pins.
  edit(plan, bound, 'move', `externalize ${id} as a project: its specs into a member at ${posix(path.relative(node.directory, dir!))}, declared as "${id}", then promoted`, { root: node.directory, call: 'externalizeSubsystem', args: [id, posix(path.relative(node.directory, dir!)), 'project'] });
  edit(plan, id, 'pin', `pin the new member's externals (its external for ${node.id ?? 'this project'}, when its specs reference it)`, { root: dir!, call: 'pinExternals', args: [[]] });
  plan.notes.push('Source code is not moved: move the subsystem\'s code into the member yourself.');
  // Step 10.
  return plan;
}

/** Step 5: every component of the moved subtree naming a component of the bound project that its subsystem does not publish, refused; whether any component reference crosses back. */
function crossingsBack(plan: MigrationPlan, family: ProjectFamily, bound: string, subKey: string): boolean {
  const owned = [...family.owners].filter(([, o]) => o === bound).map(([k]) => k);
  const components = owned.map((k) => core.loadSpec('component', k) as ComponentSpec | null).filter((c): c is ComponentSpec => c !== null);
  const moved = new Set(components.filter((c) => c.subsystem === subKey).map((c) => c.id));
  const targets = new Map<string, Set<string>>();
  const add = (from: string, to: string | undefined): void => {
    if (to) targets.set(from, new Set([...(targets.get(from) ?? []), to]));
  };
  for (const c of components.filter((x) => moved.has(x.id))) {
    for (const t of [...c.dependsOn, ...c.owns, ...(c.dispatch ?? []).map((b) => b.component)]) add(c.id, t);
  }
  for (const k of owned) {
    const impl = core.loadSpec('implementation', k) as ImplementationSpec | null;
    const contract = impl ? core.loadSpec('interface', impl.contract) as InterfaceSpec | null : null;
    if (!impl || !contract || !moved.has(contract.component)) continue;
    for (const m of impl.methods) for (const step of m.narrative) add(contract.component, step.targetComponent);
  }
  let crosses = false;
  for (const [from, tos] of targets) {
    for (const to of tos) {
      const target = components.find((c) => c.id === to);
      if (!target || moved.has(to)) continue;
      crosses = true;
      const published = core.resolveSubsystemExports(target.subsystem).entries.some((e) => e.kind === 'component' && e.component === to);
      if (!published) refuse(plan, 'externalize-refused', bound, `${from} names ${to}, which its subsystem ${target.subsystem} does not publish — publishing it is a design decision to make first`);
    }
  }
  return crosses;
}

/** Step 6: each public name another family project uses that the moved subsystem realizes must stay exported through a re-export the core re-points. */
function checkSiblings(plan: MigrationPlan, family: ProjectFamily, bound: string, id: string, subKey: string, table: ReturnType<typeof core.resolveProjectExports>): void {
  const system = runWithProjectRoot(familyNode(family, bound)!.directory, () => core.loadSpec('system', 'system')) as SystemSpec | null;
  const entries = (system?.publicInterfaces ?? []) as { from?: string; as?: string; component?: string; typeDef?: string }[];
  const used = new Set<string>();
  for (const ref of family.authoredReferences) {
    const owner = family.owners.get(ref.specId) ?? '';
    if (ref.producer === bound && owner !== bound && ref.publicName) used.add(ref.publicName);
  }
  for (const name of used) {
    const exported = table.entries.find((e) => e.publicName === name);
    if (!exported || exported.source !== subKey) continue;
    const entry = entries.find((e) => (e.as ?? e.component ?? e.typeDef) === name);
    if (entry?.from !== id) {
      refuse(plan, 'externalize-refused', bound, `a family project uses "${name}", which ${id} realizes and ${label(bound)}'s L0 does not re-export from "${id}" — after the move it would not resolve; re-export it with \`from: ${id}\` first`);
    }
  }
}

// ── stage 8: the one entry, promote and demote ─────────────────────────────

/** iboundary_migration.plan — the one entry for the four boundary and storage verbs, routed to that verb's planner. Writes nothing. */
export function plan(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  // Step 1: route by verb.
  switch (request.verb) {
    case 'internalize':
      // Step 2.
      return planInternalize(family, bound, request);
    case 'externalize':
      // Step 4.
      return planExternalize(family, bound, request);
    case 'promote':
      // Step 6.
      return planPromote(family, bound, request);
    case 'demote':
      // Step 8.
      return planDemote(family, bound, request);
    default:
      throw new Error(`boundary_migration plans no "${request.verb}": internalize | externalize | promote | demote`);
  }
}

/** A directory strictly inside the plan's family root, where a rehearsal can copy it. */
function insideFamily(plan: MigrationPlan, dir: string): boolean {
  const rel = path.relative(plan.familyRoot, dir);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * iboundary_migration.planPromote — plan `member promote <alias>`: the part
 * becomes an independent project IN PLACE. Writes nothing; the core's own
 * refusals (an unpublished component either side uses) surface when the plan
 * is rehearsed.
 */
export function planPromote(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  const newId = request.newId ?? alias;
  const node = familyNode(family, bound)!;
  // Step 1: the part — none is not-a-part; one fetched from git is read-only.
  const part = node.parts.find((p) => p.alias === alias);
  if (!part) {
    refuse(plan, 'not-a-part', bound, `${label(bound)} declares no part "${alias}"`);
    return plan;
  }
  if (part.storage === 'git') refuse(plan, 'read-only', bound, `the part "${alias}" is fetched from git (${part.commit ?? 'its pinned commit'}): promote it in a checkout of its repository — a cross-repository migration is not planned as one change`);
  else if (part.directory === undefined) refuse(plan, 'member-absent', bound, `the part "${alias}" cannot be read: ${part.reason ?? 'its directory is absent'}`);
  else if (!insideFamily(plan, part.directory)) refuse(plan, 'not-contained', bound, `the part "${alias}" is stored outside the family root (${part.directory}), where one transaction cannot write it — promote it from a root that contains both`);
  // Step 2: the bound project's export table, for what other family projects use of it.
  const table = core.resolveProjectExports(bound || undefined);
  // Step 3: what crosses the would-be boundary.
  const inPart = new Set(part.subsystems);
  const allSubs = runWithProjectRoot(node.directory, () => [...family.owners].filter(([, o]) => o === bound)
    .map(([k]) => core.loadSpec('subsystem', k) as SubsystemSpec | null).filter((s): s is SubsystemSpec => s !== null && !s.projectPath));
  for (const s of allSubs) {
    for (const link of s.trustedLinks ?? []) {
      if (inPart.has(s.id) === inPart.has(link.subsystem)) continue;
      refuse(plan, 'trusted-link-crosses', bound, `the trustedLink from "${s.id}" to "${link.subsystem}" would cross a project boundary — remove or replace it first`);
    }
  }
  const collision = family.nodes.find((n) => n.id === newId);
  if (collision) refuse(plan, 'id-collision', collision.namespace, `${label(collision.namespace)} already answers to "${newId}"`);
  const config = configAt(node.directory);
  if (newId !== alias && (config?.members?.[newId] !== undefined || config?.externals?.[newId] !== undefined)) {
    refuse(plan, 'alias-taken', bound, `${label(bound)} already declares the alias "${newId}"`);
  }
  // Every other family project's used names realized in the part must stay
  // exported: through an L0 entry re-exporting from a part subsystem, which the
  // promote re-points at the new project (externalize-updates-siblings).
  const partSpecs = new Set(part.specIds);
  const system = runWithProjectRoot(node.directory, () => core.loadSpec('system', 'system')) as SystemSpec | null;
  const entries = (system?.publicInterfaces ?? []) as { from?: string; as?: string; component?: string; typeDef?: string }[];
  for (const ref of family.authoredReferences) {
    const owner = family.owners.get(ref.specId) ?? '';
    if (ref.producer !== bound || owner === bound || !ref.publicName) continue;
    const exported = table.entries.find((e) => e.publicName === ref.publicName);
    const target = exported?.component ?? exported?.typeDef;
    if (target === undefined || !partSpecs.has(target)) continue;
    const entry = entries.find((e) => (e.as ?? e.component ?? e.typeDef) === ref.publicName || (e.from !== undefined && e.component === undefined && e.typeDef === undefined));
    if (entry?.from === undefined || !inPart.has(entry.from)) {
      refuse(plan, 'externalize-updates-siblings', owner, `${label(owner)} uses "${ref.publicName}", which the part "${alias}" realizes and ${label(bound)}'s L0 does not re-export from one of its subsystems — after the promote it would not resolve; re-export it with \`from: <its subsystem>\` first`);
    }
  }
  // Steps 4-5.
  if (plan.refusals.length > 0) return plan;
  // Step 6: the core's promote, then the pins on both sides.
  edit(plan, bound, 'promote', `promote ${alias}: its project content created in place (id ${newId}, an L0 exporting what ${label(bound)} uses of it), references across the new boundary respelled`,
    { root: node.directory, call: 'promoteMember', args: [alias, newId] });
  edit(plan, newId, 'pin', `pin the new project's external for ${node.id ?? 'this project'} (when its specs reference it)`, { root: part.directory!, call: 'pinExternals', args: [[]] });
  if (part.storage !== 'contained') edit(plan, bound, 'pin', `pin ${alias} (a project stored outside ${label(bound)} is judged against its pin)`, { root: node.directory, call: 'pinExternals', args: [[alias]] });
  plan.notes.push(`"${newId}" has no lock yet: lock it at its own root (\`wairon lock\`) once it validates.`);
  // Step 7.
  return plan;
}

/**
 * iboundary_migration.planDemote — plan `member demote <alias>`: the project
 * member becomes a part of the bound project IN PLACE, promote's inverse.
 * Writes nothing; the core's internalize refusals surface on rehearsal.
 */
export function planDemote(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  const node = familyNode(family, bound)!;
  // Step 1: the project member — none is not-a-member, a part is one already, git is read-only.
  const member = family.nodes.find((n) => n.parent === bound && n.mountAlias === alias);
  const referenced = node.externals.find((e) => e.role === 'member' && e.alias === alias);
  if (node.parts.some((p) => p.alias === alias)) {
    refuse(plan, 'not-a-member', bound, `"${alias}" is already a part of ${label(bound)}`);
    return plan;
  }
  if (!member && !referenced) {
    refuse(plan, 'not-a-member', bound, `${label(bound)} declares no project member "${alias}"`);
    return plan;
  }
  if (referenced?.sourceKind === 'git') refuse(plan, 'read-only', bound, `the member "${alias}" is fetched from git: demote it in a checkout of its repository`);
  if (referenced?.sourceKind === 'hosted') refuse(plan, 'read-only', bound, `the member "${alias}" is a hosted record: a part lives in its parent's tree`);
  const dir = member?.directory ?? referenced?.directory;
  if (!member && referenced?.sourceKind === 'path' && dir !== undefined && !insideFamily(plan, dir)) {
    refuse(plan, 'not-contained', bound, `the member "${alias}" is stored outside the family root (${dir}), where one transaction cannot write it — demote it from a root that contains both`);
  }
  // Step 2: every family project OTHER than the bound one that consumes it — a part has no exports.
  if (member) {
    const users = new Map<string, Set<string>>();
    for (const ref of family.references) {
      if (ref.producer !== member.namespace || ref.consumer === bound || ref.consumer === member.namespace) continue;
      users.set(ref.consumer, new Set([...(users.get(ref.consumer) ?? []), ref.publicName ?? ref.target]));
    }
    for (const [consumer, names] of users) {
      refuse(plan, 'consumed-elsewhere', consumer, `${label(consumer)} uses ${[...names].map((n) => `"${n}"`).join(', ')} of "${alias}" — a part has no exports; repoint it at ${label(bound)}'s exports first, or keep the boundary`);
    }
  }
  if (!plan.whole) refuse(plan, 'family-partial', '', 'the family\'s top is out of this request\'s reach, and a consumer of the member could live there — run from the top project');
  // Step 3: its configuration, for what the destination must place.
  void (dir !== undefined ? configAt(dir) : null);
  // Steps 4-5.
  if (plan.refusals.length > 0) return plan;
  // Step 6: the core's demote, and the bound project's pin of it removed.
  const destination: InternalizeDestination = request.destination ?? { home: '' };
  edit(plan, bound, 'demote', `demote ${alias}: its project content removed in place${destination.home ? `, its L0 vision to ${destination.home}` : ''}${destination.packs ? `, its packs ${destination.packs === 'adopt' ? 'adopted' : 'dropped'}` : ''}; references across the old boundary become local ids`,
    { root: node.directory, call: 'demoteMember', args: [alias, destination] });
  edit(plan, bound, 'pin', `pin ${alias} removed (a part is not pinned: its specs are ${label(bound)}'s own)`, { root: node.directory, call: 'unpin', args: [alias] });
  plan.edits.push({ project: member?.namespace ?? alias, kind: 'delete', detail: `${alias}'s L0, lock, pins and derived outputs end with its boundary: deleted, each listed` });
  if (dir !== undefined && core.approvalRecord(dir)) plan.notes.push(`"${alias}"'s own approval ends with it: its lock is deleted, and ${label(bound)} is re-locked instead.`);
  // Step 7.
  return plan;
}

// ── write ───────────────────────────────────────────────────────────────────

/** iboundary_migration.write — make a confirmed internalize, externalize, promote or demote plan's writes in the rehearsal roots. */
export function write(plan: MigrationPlan, rehearsal: Rehearsal): void {
  const planned = plan.edits.filter((e): e is PlannedEdit & { write: PlannedWrite } => e.write !== undefined);
  // Steps 1-2: every hop below is a scoped binding; which verb?
  if (plan.request.verb === 'internalize') {
    // Step 3: the consumers' references first, from the top root, while the member's keys still exist.
    for (const [spec, edits] of referencesBySpec(planned)) {
      const [kind, id] = spec.split('\n');
      runWithProjectRoot(rehearsalRoot(rehearsal, plan.familyRoot), () => core.rewriteReferences(kind, id, edits));
    }
    // Step 4: the core's internalize — a core refusal propagates.
    for (const e of planned.filter((x) => x.write.call === 'internalizeMember')) writeOne(rehearsal, e.write);
    // Steps 5-7: each consumer that names the bound project — `use` merged, pin and external removed.
    for (const e of planned.filter((x) => ['importNames', 'unpin', 'removeExternal'].includes(x.write.call))) writeOne(rehearsal, e.write);
    // Step 8: each other consumer repointed.
    for (const e of planned.filter((x) => x.write.call === 'repointExternal')) writeOne(rehearsal, e.write);
    // Step 9: last, the pins.
    for (const e of planned.filter((x) => x.write.call === 'pinExternals')) writeOne(rehearsal, e.write);
    // Step 10.
    return;
  }
  // Step 11: externalize, or a composition verb?
  if (plan.request.verb === 'externalize') {
    // Step 12: the core's externalize — into a part, or as a project; a core refusal propagates.
    for (const e of planned.filter((x) => x.write.call === 'externalizeSubsystem')) writeOne(rehearsal, e.write);
    // Step 13: the new project's pin (a part needs none).
    for (const e of planned.filter((x) => x.write.call === 'pinExternals')) writeOne(rehearsal, e.write);
    // Step 14.
    return;
  }
  // Step 15: promote or demote?
  if (plan.request.verb === 'promote') {
    // Step 16: the core's promote — a core refusal propagates.
    for (const e of planned.filter((x) => x.write.call === 'promoteMember')) writeOne(rehearsal, e.write);
    // Step 17: the pins LAST, on both sides.
    for (const e of planned.filter((x) => x.write.call === 'pinExternals')) writeOne(rehearsal, e.write);
    // Step 18.
    return;
  }
  // Step 19: the core's demote — a core refusal propagates.
  for (const e of planned.filter((x) => x.write.call === 'demoteMember')) writeOne(rehearsal, e.write);
  // Step 20: the bound project's pin of the member removed.
  for (const e of planned.filter((x) => x.write.call === 'unpin')) writeOne(rehearsal, e.write);
  // Step 21: the caller's binding is back.
}

/** The planned reference edits grouped per spec, in plan order. */
function referencesBySpec(planned: (PlannedEdit & { write: PlannedWrite })[]): Map<string, ReferenceEdit[]> {
  const out = new Map<string, ReferenceEdit[]>();
  for (const e of planned.filter((x) => x.write.call === 'rewriteReferences')) {
    const [kind, id, edits] = e.write.args as [string, string, ReferenceEdit[]];
    out.set(`${kind}\n${id}`, [...(out.get(`${kind}\n${id}`) ?? []), ...edits]);
  }
  return out;
}

/** One planned write under its owner's rehearsal root. */
function writeOne(rehearsal: Rehearsal, w: PlannedWrite): void {
  const args = w.args as never[];
  runWithProjectRoot(rehearsalRoot(rehearsal, w.root), () => {
    switch (w.call) {
      case 'internalizeMember': return core.internalizeMember(args[0], args[1]);
      case 'externalizeSubsystem': return core.externalizeSubsystem(args[0], args[1], args[2]);
      case 'promoteMember': return core.promoteMember(args[0], args[1]);
      case 'demoteMember': return core.demoteMember(args[0], args[1]);
      case 'importNames': return core.importNames(args[0], args[1]);
      case 'unpin': return surfaces.unpin(args[0]);
      case 'removeExternal': return core.removeExternal(args[0]);
      case 'repointExternal': return core.repointExternal(args[0], args[1], args[2]);
      case 'pinExternals': return surfaces.pinExternals((args[0] as string[]).length > 0 ? args[0] : undefined);
      default: throw new Error(`boundary_migration makes no "${w.call}" write`);
    }
  });
}
