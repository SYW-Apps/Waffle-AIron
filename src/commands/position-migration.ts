import * as path from 'path';
import * as core from './adapters/core.js';
import * as surfaces from './adapters/surfaces.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { declaredMembers } from '../models/project.js';
import { familyNode, keyIn, type AuthoredReference, type ProjectFamily, type ProjectNode } from '../models/project-family.js';
import { exportTargetKey, type ResolvedExportTable } from '../models/exports.js';
import type { ComponentSpec, PublicInterface, SubsystemSpec, TypeSpec } from '../models/specs.js';
import type { ChainingMigrationFinding, ChainingMigrationPlan, PlannedExport, ProjectMigration } from './chaining-migration.js';

// ---------------------------------------------------------------------------
// position_migration_orchestrator — the stage-3 share of a family's chaining
// migration: retiring position.
//
// plan(family) reads the project graph the chaining migration already read and
// answers what removing the positional forms takes: each legacy L1 mount moved
// into its parent's `members` with what it carries (its description into the
// member entry, its published entries into the member's L0) and every field
// that has no home reported, and each reference written in a deprecated form
// (a leading `::`, `super::`, a member path) rewritten to the scan's canonical
// text. It writes nothing.
//
// apply(plan) runs after the chaining migration's ids, exports, externals and
// pins are written: members first (under each parent's binding), then the
// rewrites (from the family's top root, where the deprecated forms still
// bind), then the deletion of the stage-1 family pins nothing reads any more.
// Every hop into a root is a runWithProjectRoot, so the caller's binding is
// restored on every path. It holds no state and never locks. The caller must
// gate on reach itself.
// ---------------------------------------------------------------------------

/** planned_member — one legacy L1 mount moved into its parent's `members`, with what it carries. */
export interface PlannedMember {
  /** The key of the project that declares the mount ('' is the top root). */
  parent: string;
  /** The mount's local id: the `members` key. */
  alias: string;
  /** The mount's projectPath as written, relative to the parent's root. */
  path: string;
  /** The mount's description, carried into the member entry's long form. */
  description?: string;
  /** The key of the member project. */
  member: string;
  /** The member's new L0 entries, one per published entry of the mount. */
  carried: PlannedExport[];
  /** Mount fields that retire with the mount, each as `field: value`. */
  retired: string[];
}

/** planned_rewrite — one reference rewritten from a deprecated form to its canonical text. */
export interface PlannedRewrite {
  /** The key of the project whose file holds the reference. */
  project: string;
  /** subsystem, component, interface, implementation or type. */
  kind: string;
  /** The spec's in-memory key from the family's top root. */
  specId: string;
  /** Where in the spec (as AuthoredReference.position). */
  position: string;
  /** The reference as written. */
  from: string;
  /** What apply writes instead. */
  to: string;
  /** leading | super | path. */
  form: string;
}

/** position_migration_plan — the stage-3 share of a chaining migration, planned and not yet applied. */
export interface PositionMigrationPlan {
  /** The mounts to move, parents in walk order, each parent's mounts in declaration order. */
  members: PlannedMember[];
  /** The references to rewrite, projects in walk order, then spec, then position. */
  rewrites: PlannedRewrite[];
  /** Every mount field that stops the move, every reference with no rewrite, every absent member. */
  findings: ChainingMigrationFinding[];
}

/** position_migration_result — what applying the stage-3 share wrote. */
export interface PositionMigrationResult {
  /** Every write, in write order. */
  written: string[];
  /** The directories of the projects whose lock the writes left stale. */
  relock: string[];
}

const label = (namespace: string): string => (namespace === '' ? 'the top root' : `"${namespace}"`);

/** An id local to the project at `namespace`: its key prefix stripped. */
function localIn(namespace: string, id: string): string {
  return namespace && id.startsWith(`${namespace}::`) ? id.slice(namespace.length + 2) : id;
}

// ── plan ────────────────────────────────────────────────────────────────────

/**
 * iposition_migration_orchestrator.plan — the mounts to move, the references
 * to rewrite and the findings, from the family's graph. Writes nothing.
 */
export function plan(family: ProjectFamily): PositionMigrationPlan {
  const out: PositionMigrationPlan = { members: [], rewrites: [], findings: [] };
  // Steps 1-9: each legacy mount, parents in walk order.
  for (const node of family.nodes) {
    if (node.mountForm === 'mount' && node.legacyMount && node.parent !== undefined) planMount(family, node, out);
  }
  // Step 10: an absent member blocks.
  reportAbsentMembers(family, out);
  // Steps 11-12: each deprecated reference.
  const seen = new Set<string>();
  for (const ref of family.authoredReferences) planRewrite(family, ref, seen, out);
  // Step 13: a spec the re-save would refuse keeps its rewrites back.
  holdBack(family, out);
  // Step 14.
  return out;
}

/** Steps 2-9 for one legacy mount. */
function planMount(family: ProjectFamily, node: ProjectNode, out: PositionMigrationPlan): void {
  const mount = node.legacyMount!;
  const parent = familyNode(family, node.parent!)!;
  const planned: PlannedMember = {
    parent: parent.namespace,
    alias: node.mountAlias!,
    path: mount.projectPath!.replace(/\\/g, '/'),
    ...(mount.description ? { description: mount.description } : {}),
    member: node.namespace,
    carried: [],
    retired: [],
  };
  // Step 2: the parent's `members` as declared.
  const config = runWithProjectRoot(parent.directory, () => core.loadProjectConfig());
  // Step 3: an equal declaration leaves only the L1 document; a different one blocks.
  const declared = config ? declaredMembers(config).find((m) => m.alias === planned.alias) : undefined;
  if (declared && (declared.path !== planned.path || declared.description !== planned.description)) {
    block(out, 'mount-field-conflict', parent.namespace, `${label(parent.namespace)} declares the member "${planned.alias}" as { path: ${declared.path} } already, and its legacy mount says { path: ${planned.path} } — keep one declaration by hand`);
  }
  // Step 4: the member's current L0 table.
  const table = core.resolveProjectExports(node.namespace || undefined);
  // Steps 5-8: each published entry of the mount.
  mount.publicInterfaces.forEach((entry) => carryEntry(node, planned, entry, table, out));
  // Step 9: every other field.
  sortFields(mount, planned, out);
  out.members.push(planned);
}

function block(out: PositionMigrationPlan, kind: string, project: string, detail: string): void {
  out.findings.push({ kind, project, detail, blocking: true });
}

/** Steps 6-8: carry one published entry of the mount into the member's L0, or say why not. */
function carryEntry(node: ProjectNode, planned: PlannedMember, entry: PublicInterface, table: ResolvedExportTable, out: PositionMigrationPlan): void {
  if (entry.consumers?.length) planned.retired.push(`publicInterfaces consumers: ${entry.consumers.join(', ')}`);
  const where = `the mount "${planned.alias}" of ${label(planned.parent)}`;
  const itemId = entry.component ?? entry.typeDef;
  if (itemId === undefined) {
    planned.retired.push(`publicInterfaces: ${entry.type ?? 'entry'} "${entry.details ?? ''}" (names no component — nothing to export)`);
    return;
  }
  const local = localIn(planned.alias, itemId);
  const key = keyIn(node.namespace, local);
  // Step 6: the item, for the member subsystem that owns it.
  const item = (entry.component !== undefined ? core.loadSpec('component', key) : core.loadSpec('type', key)) as ComponentSpec | TypeSpec | null;
  if (!item) {
    block(out, 'mount-field-unhomed', node.namespace, `${where} publishes "${local}", which the member does not hold — fix or drop the entry by hand`);
    return;
  }
  const source = item.subsystem;
  const iface = entry.interface !== undefined ? localIn(planned.alias, entry.interface) : undefined;
  const target = entry.component !== undefined
    ? exportTargetKey({ kind: 'component', component: key, ...(iface ? { interface: keyIn(node.namespace, iface) } : {}) })
    : exportTargetKey({ kind: 'type', typeDef: key });
  // Step 7: an L0 re-export follows only what the subsystem publishes; what it does not publish yet is published first.
  const publishes = (e: { kind: string; component?: string; typeDef?: string }): boolean => (entry.component !== undefined ? e.component === key : e.typeDef === key);
  const publishAtL1 = source !== undefined && !core.resolveSubsystemExports(source).entries.some(publishes);
  if (publishAtL1 && (entry.component === undefined || entry.type === undefined || entry.details === undefined)) {
    block(out, 'mount-field-unhomed', node.namespace, `${where} publishes "${local}", which its member subsystem "${localIn(node.namespace, source!)}" does not publish at L1, and the entry has no transport kind and details to publish it with — publish it there by hand`);
    return;
  }
  // Step 8: already exported, taken, or carried.
  const publicName = iface ?? local;
  if (table.entries.some((e) => exportTargetKey(e) === target)) {
    planned.retired.push(`publicInterfaces: ${local} (the member's L0 exports it already)`);
    return;
  }
  if (table.entries.some((e) => e.publicName === publicName)) {
    block(out, 'mount-field-conflict', node.namespace, `${where} publishes "${local}" as "${publicName}", a name the member's L0 already binds to another target — export it under a name a person chooses`);
    return;
  }
  planned.carried.push({
    ...(source !== undefined ? { from: localIn(node.namespace, source) } : {}),
    ...(entry.component !== undefined ? { component: local } : { typeDef: local }),
    ...(iface ? { interface: iface } : {}),
    publicName,
    audience: 'project',
    consumers: [],
    members: [],
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    ...(entry.details !== undefined ? { details: entry.details } : {}),
    reason: 'mount',
    ...(publishAtL1 ? { publishAtL1: true } : {}),
  });
}

/** The mount fields no member can hold, and where the member would hold each instead. */
const UNHOMED: [keyof SubsystemSpec, string][] = [
  ['lifecycle', "on the member subsystem that owns those components"],
  ['profile', "on the member's own subsystems"],
  ['targetLanguage', "on the member's L0 or its subsystems"],
  ['designDepth', "on the member's own subsystems"],
  ['ext', "on the member's L0, or the specs the data is about"],
];

/** Step 9: retire what nothing needs, block on what the member must hold itself. */
function sortFields(mount: SubsystemSpec, planned: PlannedMember, out: PositionMigrationPlan): void {
  const where = `the mount "${planned.alias}" of ${label(planned.parent)}`;
  if (mount.publicInterfaces.length === 0) planned.retired.push('publicInterfaces: []');
  if (mount.trustedLinks.length === 0) planned.retired.push('trustedLinks: []');
  else {
    const links = mount.trustedLinks.map((l) => l.subsystem).join(', ');
    block(out, 'mount-field-unhomed', planned.member, `${where} carries trustedLinks (${links}): a fast lane cannot cross a project — move each onto the member subsystem it concerns, or drop it`);
  }
  for (const allow of mount.lint?.allow ?? []) planned.retired.push(`lint.allow: ${allow.code}${allow.at ? ` at ${allow.at}` : ''}`);
  for (const [field, home] of UNHOMED) {
    const value = mount[field];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    block(out, 'mount-field-unhomed', planned.member, `${where} carries ${field} (${JSON.stringify(value)}), which the member must hold itself ${home} — move it there, or drop it`);
  }
}

/** Step 10. */
function reportAbsentMembers(family: ProjectFamily, out: PositionMigrationPlan): void {
  for (const problem of family.problems) {
    if (problem.kind !== 'member-absent') continue;
    block(out, 'member-absent', problem.projects[0] ?? '', `${problem.detail} — references into it cannot be rewritten, and its declaration cannot be moved; restore its directory or remove the declaration`);
  }
}

/** Where each reference position can sit, first match wins. */
const KINDS_AT: Record<string, string[]> = {
  dependsOn: ['component'], owns: ['component'], dispatch: ['component'], mounts: ['component'],
  lifecycle: ['subsystem'], publicInterfaces: ['subsystem'], trustedLinks: ['subsystem'],
  contract: ['implementation', 'interface'], narrative: ['implementation'], calls: ['implementation'], auth: ['implementation'],
  subsystem: ['component', 'type'], group: ['type'], type: ['interface', 'type'],
};

/** The kind of the spec holding a reference, read off where it sits. */
function kindOf(ref: AuthoredReference): string {
  const kinds = KINDS_AT[ref.position] ?? ['component', 'interface', 'implementation', 'type', 'subsystem'];
  return kinds.find((k) => core.loadSpec(k as 'component', ref.specId) !== null) ?? kinds[0];
}

/** Steps 11-12 for one authored reference. */
function planRewrite(family: ProjectFamily, ref: AuthoredReference, seen: Set<string>, out: PositionMigrationPlan): void {
  if (ref.form === 'alias' || ref.rewrite === ref.authored) return;
  const key = `${ref.specId}|${ref.position}|${ref.authored}`;
  if (seen.has(key)) return;
  seen.add(key);
  const project = family.owners.get(ref.specId) ?? '';
  if (ref.rewrite === undefined) {
    out.findings.push({ kind: 'rewrite-unavailable', project, blocking: false, detail: `${ref.specId} (${ref.position}) writes "${ref.authored}", which has no canonical text: ${whyNone(ref)} — fix the reference by hand` });
    return;
  }
  out.rewrites.push({ project, kind: kindOf(ref), specId: ref.specId, position: ref.position, from: ref.authored, to: ref.rewrite, form: ref.form });
}

function whyNone(ref: AuthoredReference): string {
  if (ref.binding === 'outside') return 'its target lies outside the family the scan read';
  if (ref.binding === 'unresolved') return 'nothing names its first segment';
  return `the project it lands in has no id to write it under`;
}

/** The positions the loader binds — the ones the re-save refuses a spec over. */
const BOUND = new Set(['publicInterfaces', 'lifecycle', 'subsystem', 'owns', 'dependsOn', 'dispatch', 'mounts', 'contract', 'narrative', 'group']);

/** Step 13: a spec holding a bound deprecated reference with no canonical text keeps every rewrite back. */
function holdBack(family: ProjectFamily, out: PositionMigrationPlan): void {
  const stuck = new Set(family.authoredReferences
    .filter((r) => r.form !== 'alias' && BOUND.has(r.position) && (r.binding === 'outside' || r.binding === 'unresolved'))
    .map((r) => r.specId));
  for (const specId of stuck) {
    const waiting = out.rewrites.filter((r) => r.specId === specId);
    if (waiting.length === 0) continue;
    out.rewrites = out.rewrites.filter((r) => r.specId !== specId);
    out.findings.push({
      kind: 'rewrite-unavailable', project: family.owners.get(specId) ?? '', blocking: false,
      detail: `${specId}'s ${waiting.length} other rewrite(s) wait with it: the re-save writes a spec whole, and refuses one holding a reference with no canonical text`,
    });
  }
}

// ── apply ───────────────────────────────────────────────────────────────────

class WriteLog implements PositionMigrationResult {
  readonly written: string[] = [];
  readonly relock: string[] = [];

  wrote(item: string, directory: string): void {
    if (!this.written.includes(item)) this.written.push(item);
    if (!this.relock.includes(directory)) this.relock.push(directory);
  }
}

const specsAt = (directory: string): string => path.join(directory, '.wai', 'specs');

/**
 * iposition_migration_orchestrator.apply — move the planned mounts, rewrite
 * the planned references and delete the superseded family pins, after the
 * chaining migration's stage-2 writes. Idempotent; locks nothing.
 */
// `plan` shadows the module's plan() here: apply never plans, it applies the value it is given.
export function apply(plan: ChainingMigrationPlan): PositionMigrationResult {
  const log = new WriteLog();
  // Steps 1-2: members, under each parent's binding.
  for (const p of plan.projects) {
    for (const member of p.members) runWithProjectRoot(p.directory, () => moveMount(p, member, log));
  }
  // Steps 3-5: the rewrites, from the family's top root.
  runWithProjectRoot(plan.familyRoot, () => rewriteAll(plan, log));
  // Steps 6-7: the superseded family pins, under each member's binding.
  for (const p of plan.projects) {
    for (const key of p.supersededPins) runWithProjectRoot(p.directory, () => unpin(p, key, log));
  }
  // Steps 8-9.
  return { written: log.written, relock: log.relock };
}

/** Step 2. */
function moveMount(p: ProjectMigration, member: PlannedMember, log: WriteLog): void {
  if (!core.moveMountToMembers(member.alias)) return;
  log.wrote(path.join(p.directory, '.wai', 'project.yaml'), p.directory);
  log.wrote(`${specsAt(p.directory)}: subsystem ${member.alias}`, p.directory);
}

/** Steps 3-5: one re-save per spec, each addressed by the key it answers to now. */
function rewriteAll(migration: ChainingMigrationPlan, log: WriteLog): void {
  const specs = new Map<string, PlannedRewrite>();
  for (const r of migration.rewrites) if (!specs.has(r.specId)) specs.set(r.specId, r);
  for (const r of specs.values()) {
    const owner = migration.projects.find((p) => p.project === r.project);
    const namespace = owner?.idToWrite ?? r.project;
    const local = localIn(r.project, r.specId);
    // Step 5.
    if (!core.normalizeReferences(r.kind, keyIn(namespace, local))) continue;
    if (owner) log.wrote(`${specsAt(owner.directory)}: ${r.kind} ${local}`, owner.directory);
  }
}

/** Step 7. */
function unpin(p: ProjectMigration, key: string, log: WriteLog): void {
  if (surfaces.removeSnapshot(key)) log.wrote(`${path.join(p.directory, '.wai', 'surfaces')}: ${key}`, p.directory);
}
