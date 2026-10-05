import * as path from 'path';
import type { WritableSpecKind } from '../core/specs.js';
import * as core from './adapters/core.js';
import * as surfaces from './adapters/surfaces.js';
import { getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { EXTERNAL_ALIAS_RE, PROJECT_ID_RE, type ProjectConfig } from '../models/project.js';
import { familyNode, type AuthoredReference, type ProjectFamily, type ProjectNode, type ReferenceEdit } from '../models/project-family.js';
import { rehearsalRoot, type MigrationPlan, type MigrationRequest, type PlannedEdit, type PlannedEditKind, type PlannedWrite, type Rehearsal } from './types.js';

// ---------------------------------------------------------------------------
// identity_migration — a project's id, or one alias of the bound project,
// renamed family-wide.
//
// A project rename moves the id (the old one kept in previousIds) and every
// reference to it: each alias that WAS the old id follows it, with the
// references written through that alias respelled at their parsed positions
// (never by a text search), and every external naming the old id is
// repointed; pins are carried to their new key without re-pinning. An alias
// rename changes the bound project alone. Neither ever locks: a rename lists
// every project it writes to re-lock, the renamed one first.
//
// Plans read the live family (the caller has bound its top root) and write
// nothing; each edit carries the one write that realizes it. write makes those
// calls in their phases — references first, while every spec key is still the
// planned one, then the alias tables and ids, then the pins — each under its
// owner's rehearsal binding, so the caller's binding is restored on every path.
// ---------------------------------------------------------------------------

/** A plan with nothing in it yet, over the graph's top root; whole unless a hosted request's reach stops below the true top. */
function emptyPlan(family: ProjectFamily, request: MigrationRequest): MigrationPlan {
  const reach = getRequestParentReach();
  const whole = !(reach !== null && !reach.parentReach);
  return { request, familyRoot: familyNode(family, '')!.directory, whole, edits: [], refusals: [], changes: [], relock: [], notes: [] };
}

const label = (key: string): string => (key === '' ? 'the top project' : `"${key}"`);
const refuse = (plan: MigrationPlan, code: string, project: string, detail: string): void => {
  plan.refusals.push({ code, project, detail });
};
const edit = (plan: MigrationPlan, project: string, kind: PlannedEditKind, detail: string, write: PlannedWrite, reference?: ReferenceEdit): void => {
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
const KINDS_AT: Record<string, WritableSpecKind[]> = {
  dependsOn: ['component'], owns: ['component'], dispatch: ['component'], mounts: ['component'],
  lifecycle: ['subsystem'], publicInterfaces: ['subsystem'], trustedLinks: ['subsystem'],
  contract: ['implementation', 'interface'], narrative: ['implementation'], calls: ['implementation'], auth: ['implementation'],
  subsystem: ['component', 'type'], group: ['type'], type: ['interface', 'type'],
};

/** The kind of the spec holding a reference, read off where it sits (under the top root's binding). */
function kindOf(ref: AuthoredReference): WritableSpecKind {
  const kinds: WritableSpecKind[] = KINDS_AT[ref.position] ?? ['component', 'interface', 'implementation', 'type', 'subsystem'];
  return kinds.find((k) => core.loadSpec(k as 'component', ref.specId) !== null) ?? kinds[0];
}

/** The first alias segment of a reference in the alias or leading form, with the rest; null otherwise. */
function throughAlias(ref: AuthoredReference): { alias: string; rest: string; lead: string } | null {
  if (ref.form !== 'alias' && ref.form !== 'leading') return null;
  const lead = ref.form === 'leading' ? '::' : '';
  const body = ref.authored.slice(lead.length);
  const at = body.indexOf('::');
  return at <= 0 ? null : { alias: body.slice(0, at), rest: body.slice(at), lead };
}

/**
 * Plan each reference that goes through `alias` in the project keyed `owner`
 * (a leading `::` form, anchored at the top, when the owner is the top),
 * respelled with `next` as its first segment — once per spec, position and text.
 */
function respellThrough(plan: MigrationPlan, family: ProjectFamily, owner: string, alias: string, next: string, producer?: string): void {
  const seen = new Set<string>();
  for (const ref of family.authoredReferences) {
    const through = throughAlias(ref);
    if (!through || through.alias !== alias || (producer !== undefined && ref.producer !== producer)) continue;
    const mine = through.lead === '' ? (family.owners.get(ref.specId) ?? '') === owner : owner === '';
    if (!mine || seen.has(`${ref.specId}|${ref.position}|${ref.authored}`)) continue;
    seen.add(`${ref.specId}|${ref.position}|${ref.authored}`);
    const reference: ReferenceEdit = { kind: kindOf(ref), specId: ref.specId, position: ref.position, from: ref.authored, to: `${through.lead}${next}${through.rest}` };
    edit(plan, family.owners.get(ref.specId) ?? '', 'reference', `${ref.specId} (${ref.position}): ${reference.from} → ${reference.to}`,
      { root: plan.familyRoot, call: 'rewriteReferences', args: [reference.kind, reference.specId, [reference]] }, reference);
  }
}

/** Plan the L0 re-exports of the project keyed `owner` that name `alias`, respelled `next`. */
function respellReExports(plan: MigrationPlan, node: ProjectNode, alias: string, next: string): void {
  const system = runWithProjectRoot(node.directory, () => core.loadSpec('system', 'system')) as { publicInterfaces?: { from?: string }[] } | null;
  if (!(system?.publicInterfaces ?? []).some((e) => e.from === alias)) return;
  const specId = node.namespace === '' ? 'system' : node.namespace;
  const reference: ReferenceEdit = { kind: 'system', specId, position: 'publicInterfaces', from: alias, to: next };
  edit(plan, node.namespace, 'reference', `${label(node.namespace)}'s L0 re-exports: from ${alias} → from ${next}`,
    { root: plan.familyRoot, call: 'rewriteReferences', args: ['system', specId, [reference]] }, reference);
}

// ── project rename ──────────────────────────────────────────────────────────

/** The project a member alias path from the bound project names (the bound project when empty), or the refusal that says why none. */
function targetOf(family: ProjectFamily, bound: string, aliasPath: string | undefined, plan: MigrationPlan): ProjectNode | null {
  let node = familyNode(family, bound)!;
  for (const segment of (aliasPath ?? '').split('/').filter((s) => s !== '')) {
    const next = family.nodes.find((n) => n.parent === node.namespace && n.mountAlias === segment);
    if (!next) {
      const absent = family.problems.find((p) => p.kind === 'member-absent' && p.id === segment && p.projects.includes(node.namespace));
      if (absent) refuse(plan, 'member-absent', node.namespace, `${label(node.namespace)}'s member "${segment}" is absent: ${absent.detail}`);
      else refuse(plan, 'not-a-member', node.namespace, `${label(node.namespace)} declares no member "${segment}"`);
      return null;
    }
    node = next;
  }
  return node;
}

/** iidentity_migration.planRename — plan moving a project's id and every reference to it. Writes nothing. */
export function planRename(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const newId = request.newId ?? '';
  // Step 1: the target, the family's reach and the new id.
  const target = targetOf(family, bound, request.project, plan);
  // A completed rename plans nothing.
  if (target && target.id === newId) return plan;
  if (!plan.whole) refuse(plan, 'family-partial', '', 'the family\'s top is out of this request\'s reach, and a rename must reach every consumer — run it from the top project');
  if (!PROJECT_ID_RE.test(newId)) refuse(plan, 'id-collision', '', `"${newId}" is no project id: [a-z0-9-_.], starting and ending alphanumeric`);
  const taken = family.nodes.find((n) => n.id === newId || (n.namespace !== '' && n.namespace === newId));
  if (taken) refuse(plan, 'id-collision', taken.namespace, `${label(taken.namespace)} already answers to "${newId}"`);
  if (target && target.id === undefined) refuse(plan, 'id-moved', target.namespace, `${label(target.namespace)} has no id to move — declare one first`);
  // Steps 2-3.
  if (plan.refusals.length > 0 || !target) return plan;
  // Step 4: the id its lock approved.
  const approved = core.approvalRecord(target.directory)?.projectId;
  // Steps 5-6: every holder of the old id, and its edits.
  const oldId = target.id!;
  const holders = holdersOf(family, target);
  for (const h of holders) planHolder(plan, family, h, oldId, newId);
  // A reference that names the old id through no alias of its own binds by id: it follows too.
  for (const n of family.nodes) if (!n.aliases.has(oldId) && n.namespace !== target.namespace) respellThrough(plan, family, n.namespace, oldId, newId, target.namespace);
  // Step 7: the target's own id, and the notes.
  edit(plan, target.namespace, 'id', `id: ${oldId} → ${newId} (${oldId} kept in previousIds)`, { root: target.directory, call: 'renameId', args: [oldId, newId] });
  for (const h of holders.filter((x) => x.external)) planPin(plan, h, oldId, newId);
  plan.notes.push(`Consumers outside the family that name "${oldId}" by path are not found by a rename: each must rewrite its own external (its next gate reports the id change).`);
  if (approved !== undefined && target.mountAlias === newId) {
    plan.notes.push(`${label(target.namespace)} kept "${oldId}" where its alias is "${newId}" because its lock approved "${approved}" (id-locked): the rename resolves it — PROJECT_ID_RENAMED until the re-lock approves "${newId}".`);
  }
  // Step 8: every project written is re-locked, the renamed one first (the orchestrator lists them).
  return plan;
}

/** One holder of a project's id: a family project whose alias table names it, under an alias. */
interface Holder {
  node: ProjectNode;
  alias: string;
  external: boolean;
}

/** Every family project whose alias table names the target: its parent's member entry, and every external binding it. */
function holdersOf(family: ProjectFamily, target: ProjectNode): Holder[] {
  const out: Holder[] = [];
  for (const node of family.nodes) {
    const config = configAt(node.directory);
    for (const [alias, key] of node.aliases) {
      if (key !== target.namespace) continue;
      out.push({ node, alias, external: config?.externals?.[alias] !== undefined });
    }
    for (const e of node.externals) {
      if (node.aliases.get(e.alias) === target.namespace || e.sourceKind !== 'path') continue;
      if (e.directory && path.resolve(e.directory) === path.resolve(target.directory)) out.push({ node, alias: e.alias, external: true });
    }
  }
  return out;
}

/** Step 6 for one holder: the alias follows the id when it was the id, its references with it; an external's producer id repointed. */
function planHolder(plan: MigrationPlan, family: ProjectFamily, h: Holder, oldId: string, newId: string): void {
  const follows = h.alias === oldId && EXTERNAL_ALIAS_RE.test(newId);
  const after = follows ? newId : h.alias;
  if (follows) {
    // A deprecated member path read from the top root passes through the top's alias: no parsed
    // position spells it in a form the writer can respell — `wairon doctor --fix` rewrites it first.
    if (h.node.namespace === '') {
      for (const ref of family.authoredReferences.filter((r) => r.form === 'path' && r.authored.split('::')[0] === h.alias)) {
        refuse(plan, 'reference-unwritable', family.owners.get(ref.specId) ?? '', `${ref.specId} (${ref.position}) writes "${ref.authored}", a deprecated member path through "${h.alias}" — run \`wairon doctor --fix\` from the top project first, which rewrites it as \`alias::name\``);
      }
    }
    respellThrough(plan, family, h.node.namespace, h.alias, after);
    respellReExports(plan, h.node, h.alias, after);
    edit(plan, h.node.namespace, h.external ? 'external' : 'member', `${h.external ? 'externals' : 'members'}: ${h.alias} → ${after}`, { root: h.node.directory, call: 'renameAlias', args: [h.alias, after] });
  }
  if (!h.external) return;
  const declared = configAt(h.node.directory)?.externals?.[h.alias];
  const wanted = after === newId ? null : newId;
  if ((declared?.project ?? null) === wanted) return;
  edit(plan, h.node.namespace, 'external', `externals: ${after} names ${newId}`, { root: h.node.directory, call: 'repointExternal', args: [after, wanted, declared?.source ?? null] });
}

/** Last: a holder's pin under the alias, carried to its new key and producer id, digest unchanged. */
function planPin(plan: MigrationPlan, h: Holder, oldId: string, newId: string): void {
  const pinned = runWithProjectRoot(h.node.directory, () => surfaces.listExternals()).find((l) => l.alias === h.alias)?.lock;
  if (!pinned) return;
  const after = h.alias === oldId && EXTERNAL_ALIAS_RE.test(newId) ? newId : h.alias;
  edit(plan, h.node.namespace, 'pin', `pin ${h.alias} carried to ${after} (producer ${newId}, digest kept)`, { root: h.node.directory, call: 'renamePin', args: [h.alias, after, newId] });
}

// ── alias rename ────────────────────────────────────────────────────────────

/** iidentity_migration.planAliasRename — plan renaming one alias of the bound project. Writes nothing. */
export function planAliasRename(family: ProjectFamily, bound: string, request: MigrationRequest): MigrationPlan {
  const plan = emptyPlan(family, request);
  const alias = request.alias ?? '';
  const next = request.newAlias ?? '';
  const node = familyNode(family, bound)!;
  const config = configAt(node.directory) ?? ({} as ProjectConfig);
  const declared = (a: string): boolean => config.members?.[a] !== undefined || config.externals?.[a] !== undefined;
  // A completed alias rename plans nothing.
  if (!declared(alias) && declared(next)) return plan;
  // Step 1.
  if (!declared(alias)) refuse(plan, 'not-a-member', bound, `${label(bound)} declares no member or external "${alias}"`);
  if (!EXTERNAL_ALIAS_RE.test(next)) refuse(plan, 'alias-taken', bound, `"${next}" is no alias: an alias must fit [a-z0-9-_]+`);
  else if (declared(next)) refuse(plan, 'alias-taken', bound, `${label(bound)} already declares "${next}"`);
  // Steps 2-3.
  if (plan.refusals.length > 0) return plan;
  // Step 4: the bound project's edits only.
  respellThrough(plan, family, bound, alias, next);
  respellReExports(plan, node, alias, next);
  const external = config.externals?.[alias];
  edit(plan, bound, external ? 'external' : 'member', `${external ? 'externals' : 'members'}: ${alias} → ${next}`, { root: node.directory, call: 'renameAlias', args: [alias, next] });
  // An external whose alias WAS its producer id keeps naming that producer, now explicitly.
  if (external && external.project === undefined) {
    edit(plan, bound, 'external', `externals: ${next} names ${alias} (the producer it named)`, { root: node.directory, call: 'repointExternal', args: [next, alias, external.source ?? null] });
  }
  const pinned = runWithProjectRoot(node.directory, () => surfaces.listExternals()).find((l) => l.alias === alias)?.lock;
  if (external !== undefined && pinned) edit(plan, bound, 'pin', `pin ${alias} carried to ${next} (digest kept)`, { root: node.directory, call: 'renamePin', args: [alias, next, pinned.project] });
  if ([...family.owners].some(([key, owner]) => owner === bound && key.split('::').pop() === next)) {
    plan.notes.push(`${label(bound)} has a spec whose id is "${next}" — a local id equal to an alias (LOCAL_ID_SHADOWS_PROJECT reports it)`);
  }
  // Step 5.
  return plan;
}

// ── write ───────────────────────────────────────────────────────────────────

/** The order the writes run in: references, then the alias tables, then the producer ids, then the id, then the pins. */
const PHASES = ['rewriteReferences', 'renameAlias', 'repointExternal', 'renameId', 'renamePin'];

/** iidentity_migration.write — make a confirmed rename or alias-rename plan's writes in the rehearsal roots. Idempotent. */
export function write(plan: MigrationPlan, rehearsal: Rehearsal): void {
  const planned = plan.edits.filter((e): e is PlannedEdit & { write: PlannedWrite } => e.write !== undefined);
  const unknown = planned.find((x) => !PHASES.includes(x.write.call));
  if (unknown) throw new Error(`identity_migration makes no "${unknown.write.call}" write`);
  // Steps 1-2: with the top root bound, each spec's reference edits in one call, before any alias moves.
  for (const [spec, edits] of referencesBySpec(planned)) {
    const [kind, id] = spec.split('\n') as [WritableSpecKind, string];
    runWithProjectRoot(rehearsalRoot(rehearsal, plan.familyRoot), () => core.rewriteReferences(kind, id, edits));
  }
  // Steps 3-4: each holder's aliases rekeyed and externals repointed.
  for (const e of planned.filter((x) => x.write.call === 'renameAlias')) writeOne(rehearsal, e.write);
  for (const e of planned.filter((x) => x.write.call === 'repointExternal')) writeOne(rehearsal, e.write);
  // Steps 5-6: a project rename moves the id.
  if (plan.request.verb === 'rename') {
    for (const e of planned.filter((x) => x.write.call === 'renameId')) writeOne(rehearsal, e.write);
  }
  // Step 7: last, the pins carried.
  for (const e of planned.filter((x) => x.write.call === 'renamePin')) writeOne(rehearsal, e.write);
  // Step 8: every hop was a scoped binding; the caller's is back.
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
      case 'renameAlias': return core.renameAlias(args[0], args[1]);
      case 'repointExternal': return core.repointExternal(args[0], args[1], args[2]);
      case 'renameId': return core.renameId(args[0], args[1]);
      case 'renamePin': return surfaces.renamePin(args[0], args[1], args[2]);
      default: throw new Error(`identity_migration makes no "${w.call}" write`);
    }
  });
}
