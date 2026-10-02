import * as path from 'path';
import * as core from './adapters/core.js';
import * as surfaces from './adapters/surfaces.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { declaredMembers } from '../models/project.js';
import { familyNode, keyIn, type AuthoredReference, type ProjectFamily, type ProjectNode } from '../models/project-family.js';
import { nameKey } from '../models/type-references.js';
// position_reader: stage 4's positional match — the same one the upgrade report explains.
import * as positionReader from './position-reader.js';
import type { PositionalMatch } from './position-reader.js';
import { exportTargetKey, type ResolvedExportTable } from '../models/exports.js';
import type { ComponentSpec, PublicInterface, SubsystemSpec, TypeSpec } from '../models/specs.js';
import type { ChainingMigrationFinding, ChainingMigrationPlan, PlannedExport, ProjectMigration } from './chaining-migration.js';
import { rehearsalRoot, type Rehearsal } from './types.js';

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
// text. Stage 4 adds its positional step: every bare name the owner's scope no
// longer resolves, matched by position (position_reader) and planned as a
// named `use` import — with the export and the external it needs — and every
// self-prefixed reference (`registry.x`, `registry::x` in the project called
// registry) rewritten to its bare local id. What no rule decides (an ambiguous
// name, a named import a local spec would shadow, two imports supplying one
// name) is reported for a person, never guessed. It writes nothing.
//
// write(plan, rehearsal) runs after the chaining migration's ids, exports and
// externals are written and before its pins, into the chaining migration's
// rehearsal: members first (under each parent's rehearsal binding), then the
// imports (under each consumer's), then the rewrites (from the rehearsal's top
// root, where the deprecated forms still bind), then the deletion of the
// stage-1 family pins nothing reads any more. The family transaction then
// swaps the result in all-or-nothing (stage 6). It moved from sdd_cli to
// sdd_migrations with the chaining migration.
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
  /** leading | super | path | self-prefix. */
  form: string;
}

/** planned_import — one `use` entry the positional step adds to a consumer. */
export interface PlannedImport {
  /** The key of the project whose `use` gains the name. */
  consumer: string;
  /** The consumer's alias for the producer: an existing external or member alias, else the producer's id. */
  alias: string;
  /** The producer's key in the family's graph. */
  producer: string;
  /** The public name imported — an existing one, or the default name of the export planned for it. */
  name: string;
  /** The canonical target `<producer id>::<local id>` the name binds. */
  target: string;
  /** The bare references it resolves, each `<spec id> <position> <as written>`. */
  references: string[];
  /** Whether the producer gains the export this import names. */
  exportPlanned: boolean;
  /** Whether the consumer must first declare the producer as an external. */
  declaresExternal: boolean;
  /** Why the producer was chosen: only-match | declared-producer | already-exported. */
  reason: string;
}

/** position_migration_plan — the stage-3 share of a chaining migration, planned and not yet applied. */
export interface PositionMigrationPlan {
  /** The mounts to move, parents in walk order, each parent's mounts in declaration order. */
  members: PlannedMember[];
  /** The references to rewrite, projects in walk order, then spec, then position. */
  rewrites: PlannedRewrite[];
  /** Every mount field that stops the move, every reference with no rewrite, every absent member. */
  findings: ChainingMigrationFinding[];
  /** Stage 4's positional imports, one per (consumer, alias, public name). */
  imports: PlannedImport[];
  /**
   * Stage 8's one doctor step: every member declared with the deprecated
   * long-form `path`, as `<declaring project key>/<alias>`, whose entry is
   * rewritten to the one location key — meaning unchanged; projects in walk order.
   */
  locations: string[];
}

/** position_migration_result — what writing the stage-3 share wrote. */
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
  const out: PositionMigrationPlan = { members: [], rewrites: [], findings: [], imports: [], locations: [] };
  // Steps 1-9: each legacy mount, parents in walk order.
  for (const node of family.nodes) {
    if (node.mountForm === 'mount' && node.legacyMount && node.parent !== undefined) planMount(family, node, out);
  }
  // Step 10 (stage 8): every member declared with the deprecated long-form `path`.
  for (const node of family.nodes) planLocations(node, out);
  // Step 11: an absent member blocks.
  reportAbsentMembers(family, out);
  // Steps 12-13: each deprecated reference.
  const seen = new Set<string>();
  for (const ref of family.authoredReferences) planRewrite(family, ref, seen, out);
  // Steps 14-17: stage 4's positional step.
  planPositional(family, out);
  // Step 18: a spec the re-save would refuse keeps its rewrites back.
  holdBack(family, out);
  // Step 19.
  return out;
}

/**
 * Step 10 at one project: each member it declares with the deprecated
 * long-form `path` key, rewritten to the one location key — the shorthand when
 * the entry holds nothing else, else the long form's `source`. What a member
 * is follows from its content, so no kind is ever written.
 */
function planLocations(node: ProjectNode, out: PositionMigrationPlan): void {
  const config = runWithProjectRoot(node.directory, () => core.loadProjectConfig());
  for (const member of config ? declaredMembers(config) : []) {
    if (member.deprecatedPath && !member.problem) out.locations.push(`${node.namespace}/${member.alias}`);
  }
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
  // A bare name is no deprecated form: one the owner's scope leaves unresolved is the positional step's.
  if (ref.form === 'alias' || ref.form === 'import' || ref.rewrite === ref.authored) return;
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

/**
 * Step 17: a spec holding a bound reference with no canonical text keeps every
 * rewrite back — a deprecated form bound outside or unresolved, or a bare name
 * no planned import will make resolve.
 */
function holdBack(family: ProjectFamily, out: PositionMigrationPlan): void {
  const imported = new Set(out.imports.flatMap((i) => i.references));
  const stuck = new Set(family.authoredReferences
    .filter((r) => r.form !== 'alias' && BOUND.has(r.position) && (r.binding === 'outside' || r.binding === 'unresolved'))
    .filter((r) => r.form !== 'import' || !imported.has(referenceLine(r)))
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

// ── steps 13-16: stage 4's positional step ─────────────────────────────────

/** A reference as a planned import lists it: `<spec id> <position> <as written>`. */
function referenceLine(ref: { specId: string; position: string; authored: string }): string {
  return `${ref.specId} ${ref.position} ${ref.authored}`;
}

/** A self-prefixed reference the scan recorded: the project's own id as the first segment, bound to its own spec. */
function isSelfPrefix(ref: AuthoredReference, owner: string | undefined): boolean {
  return ref.binding === 'local' && ref.form === 'path' && ref.producer === owner
    && ref.rewrite !== undefined && !ref.rewrite.includes('::') && ref.authored !== ref.rewrite;
}

/** Steps 13-16: the positional imports and self-prefix rewrites, and every finding no rule decides. */
function planPositional(family: ProjectFamily, out: PositionMigrationPlan): void {
  const seen = new Set<string>();
  const candidates = family.authoredReferences.filter((r) => {
    const positional = (r.form === 'import' && r.binding === 'unresolved') || isSelfPrefix(r, family.owners.get(r.specId));
    const key = referenceLine(r);
    if (!positional || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (candidates.length === 0) return;
  // Step 13: every type of the family as the top's scan sees them.
  const types = core.loadTypeSpecs();
  // Step 14: every project's L0 table.
  const tables = family.nodes.map((n) => core.resolveProjectExports(n.namespace || undefined));
  // Step 15: the positional match — the same one the upgrade report explains,
  // deciding in rounds what a re-run after apply would decide.
  const matches = positionReader.match(candidates, family, tables, types);
  // Step 16: plan from each match.
  const imports = new Map<string, PlannedImport>();
  const ambiguous = new Map<string, PositionalMatch[]>();
  for (const m of matches) {
    if (m.kind === 'self-prefix') planSelfPrefix(family, m, out);
    else if (m.kind === 'import') addImport(family, m, imports);
    else if (m.kind === 'ambiguous') {
      const key = `${m.consumer}\u0000${nameKey(m.authored.split(/::|\./).pop()!)}`;
      ambiguous.set(key, [...(ambiguous.get(key) ?? []), m]);
    }
  }
  for (const group of ambiguous.values()) reportAmbiguous(group, out);
  out.imports = settleImports(family, [...imports.values()], out);
}

/** A self-prefixed reference rewritten to its bare local id — marked on the rewrite the scan already planned, else planned here. */
function planSelfPrefix(family: ProjectFamily, m: PositionalMatch, out: PositionMigrationPlan): void {
  const planned = out.rewrites.find((r) => r.specId === m.specId && r.position === m.position && r.from === m.authored);
  if (planned) {
    planned.form = 'self-prefix';
    planned.to = m.target!;
    return;
  }
  const ref = family.authoredReferences.find((r) => r.specId === m.specId && r.position === m.position && r.authored === m.authored)!;
  out.rewrites.push({ project: m.consumer, kind: kindOf(ref), specId: m.specId, position: m.position, from: m.authored, to: m.target!, form: 'self-prefix' });
}

/** One import match, merged into the (consumer, alias, public name) it plans. */
function addImport(family: ProjectFamily, m: PositionalMatch, imports: Map<string, PlannedImport>): void {
  const consumer = familyNode(family, m.consumer);
  const producer = m.producer !== undefined ? familyNode(family, m.producer) : null;
  if (!consumer || !producer || m.target === undefined) return;
  const localId = m.target.slice(m.target.indexOf('::') + 2);
  const name = m.publicName ?? localId.split('::').pop()!;
  const declared = [...consumer.aliases].find(([, key]) => key === producer.namespace)?.[0];
  const alias = declared ?? producer.id ?? producer.namespace;
  const key = `${consumer.namespace}\u0000${alias}\u0000${name}`;
  const planned = imports.get(key) ?? {
    consumer: consumer.namespace, alias, producer: producer.namespace, name, target: m.target, references: [],
    exportPlanned: m.publicName === undefined, declaresExternal: declared === undefined, reason: m.reason ?? 'only-match',
  };
  const line = referenceLine(m);
  if (!planned.references.includes(line)) planned.references.push(line);
  imports.set(key, planned);
}

/** Step 16: one name no tie-break rule decides, with every candidate and every spec writing it — a person picks. */
function reportAmbiguous(group: PositionalMatch[], out: PositionMigrationPlan): void {
  const first = group[0];
  const candidates = [...new Set(group.flatMap((m) => m.candidates ?? []))].sort();
  const specs = [...new Set(group.map((m) => m.specId))];
  out.findings.push({
    kind: 'positional-ambiguous', project: first.consumer, blocking: false,
    detail: `${label(first.consumer)} writes "${first.authored}" ${group.length} time(s) (in ${specs.join(', ')}), and the name matches ${candidates.join(' and ')} by position: ${first.reason} — `
      + 'write `<alias>::<name>` where each is meant, or add the one intended to a `use` by hand',
  });
}

/**
 * Step 16: drop and report every import that would not take effect as
 * planned — one a local spec of the consumer shadows (import-shadowed), and
 * every one of two or more that would supply one bare name to one consumer
 * (import-collision) — then order the rest: consumers in walk order, then
 * alias, then name.
 */
function settleImports(family: ProjectFamily, planned: PlannedImport[], out: PositionMigrationPlan): PlannedImport[] {
  const kept = planned.filter((i) => {
    const local = shadowingSpec(family, i.consumer, i.name);
    if (local === undefined) return true;
    out.findings.push({
      kind: 'import-shadowed', project: i.consumer, blocking: false,
      detail: `${label(i.consumer)} would import "${i.name}" from "${i.alias}", but its own spec "${local}" shares that name, so the import could never take effect — its ${i.references.length} reference(s) are left as written: write \`${i.alias}::${i.name}\` where the other project's name is meant, or rename one`,
    });
    return false;
  });
  const byName = new Map<string, PlannedImport[]>();
  for (const i of kept) {
    const key = `${i.consumer}\u0000${nameKey(i.name)}`;
    byName.set(key, [...(byName.get(key) ?? []), i]);
  }
  const settled: PlannedImport[] = [];
  for (const group of byName.values()) {
    const held = heldElsewhere(family, group[0]);
    if (group.length === 1 && held === undefined) {
      settled.push(group[0]);
      continue;
    }
    const sources = [...group.map((i) => `"${i.name}" from "${i.alias}"`), ...(held ? [`${held} (imported already)`] : [])];
    out.findings.push({
      kind: 'import-collision', project: group[0].consumer, blocking: false,
      detail: `${label(group[0].consumer)} would get one bare name from ${sources.join(' and ')} — none of the planned imports is written; write \`<alias>::<name>\` where each is meant`,
    });
  }
  const rank = (ns: string): number => family.nodes.findIndex((n) => n.namespace === ns);
  return settled.sort((a, b) => rank(a.consumer) - rank(b.consumer) || compare(a.alias, b.alias) || compare(a.name, b.name));
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A component, contract or type of the consumer whose name shares the import's key: the local spec wins every bare reference. */
function shadowingSpec(family: ProjectFamily, consumer: string, name: string): string | undefined {
  const key = nameKey(name);
  for (const [specId, owner] of family.owners) {
    if (owner !== consumer || nameKey(specId.split('::').pop()!) !== key) continue;
    if (core.loadSpec('component', specId) || core.loadSpec('interface', specId) || core.loadSpec('type', specId)) return localIn(consumer, specId);
  }
  return undefined;
}

/** A named `use` of ANOTHER alias of the consumer that already imports a name sharing the import's key. */
function heldElsewhere(family: ProjectFamily, planned: PlannedImport): string | undefined {
  const node = familyNode(family, planned.consumer);
  const key = nameKey(planned.name);
  for (const imported of node?.imports ?? []) {
    if (imported.alias === planned.alias) continue;
    const name = imported.use.find((u) => u !== '*' && nameKey(u) === key);
    if (name !== undefined) return `"${name}" from "${imported.alias}"`;
  }
  return undefined;
}

// ── write ───────────────────────────────────────────────────────────────────

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
 * iposition_migration_orchestrator.write — move the planned mounts, add the
 * positional imports, rewrite the planned references and delete the
 * superseded family pins in the rehearsal, after the chaining migration's ids,
 * exports and externals and before its pins. Idempotent; locks nothing. Every
 * write is logged by its live project.
 */
// `plan` shadows the module's plan() here: write never plans, it writes the value it is given.
export function write(plan: ChainingMigrationPlan, rehearsal: Rehearsal): PositionMigrationResult {
  const log = new WriteLog();
  const at = (directory: string): string => rehearsalRoot(rehearsal, directory);
  // Steps 1-2: members, under each parent's rehearsal binding.
  for (const p of plan.projects) {
    for (const member of p.members) runWithProjectRoot(at(p.directory), () => moveMount(p, member, log));
  }
  // Steps 3-4 (stage 8): the location rewrites, once every member is declared under `members`.
  for (const p of plan.projects) {
    for (const alias of p.locations) runWithProjectRoot(at(p.directory), () => relocate(p, alias, log));
  }
  // Steps 5-7: the positional imports, under each consumer's rehearsal binding —
  // after the moves, so an import on a legacy mount's alias finds it under `members`.
  for (const p of plan.projects.filter((q) => q.imports.length > 0)) runWithProjectRoot(at(p.directory), () => importAll(p, log));
  // Steps 8-10: the rewrites, from the rehearsal's top root.
  runWithProjectRoot(at(plan.familyRoot), () => rewriteAll(plan, log));
  // Steps 11-12: the superseded family pins, under each member's rehearsal binding.
  for (const p of plan.projects) {
    for (const key of p.supersededPins) runWithProjectRoot(at(p.directory), () => unpin(p, key, log));
  }
  // Steps 13-14.
  return { written: log.written, relock: log.relock };
}

/** Step 4: one entry's deprecated `path` rewritten to `source` (or the shorthand); an entry already in the one key writes nothing. */
function relocate(p: ProjectMigration, alias: string, log: WriteLog): void {
  if (core.updateMember(alias, {})) log.wrote(path.join(p.directory, '.wai', 'project.yaml'), p.directory);
}

/** Steps 4-5: each alias's planned names added to its `use`, in the order the plan gives; names imported already write nothing. */
function importAll(p: ProjectMigration, log: WriteLog): void {
  const byAlias = new Map<string, string[]>();
  for (const i of p.imports) byAlias.set(i.alias, [...(byAlias.get(i.alias) ?? []), i.name]);
  for (const [alias, names] of byAlias) {
    if (core.importNames(alias, names)) log.wrote(path.join(p.directory, '.wai', 'project.yaml'), p.directory);
  }
}

/** Step 2. */
function moveMount(p: ProjectMigration, member: PlannedMember, log: WriteLog): void {
  if (!core.moveMountToMembers(member.alias)) return;
  log.wrote(path.join(p.directory, '.wai', 'project.yaml'), p.directory);
  log.wrote(`${specsAt(p.directory)}: subsystem ${member.alias}`, p.directory);
}

/** Steps 6-8: one re-save per spec, each addressed by the key it answers to now. */
function rewriteAll(migration: ChainingMigrationPlan, log: WriteLog): void {
  const specs = new Map<string, PlannedRewrite>();
  for (const r of migration.rewrites) if (!specs.has(r.specId)) specs.set(r.specId, r);
  for (const r of specs.values()) {
    const owner = migration.projects.find((p) => p.project === r.project);
    const namespace = owner?.idToWrite ?? r.project;
    const local = localIn(r.project, r.specId);
    // Step 8.
    if (!core.normalizeReferences(r.kind, keyIn(namespace, local))) continue;
    if (owner) log.wrote(`${specsAt(owner.directory)}: ${r.kind} ${local}`, owner.directory);
  }
}

/** Step 10. */
function unpin(p: ProjectMigration, key: string, log: WriteLog): void {
  if (surfaces.removeSnapshot(key)) log.wrote(`${path.join(p.directory, '.wai', 'surfaces')}: ${key}`, p.directory);
}
