import * as path from 'path';
import * as core from './adapters/core.js';
import * as authoring from './adapters/authoring.js';
import * as surfaces from './adapters/surfaces.js';
import { getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { AI_PATHS } from '../config/paths.js';
import { ChainingMigrationRefusedError } from '../utils/errors.js';
// The stage-3 share — retiring position — is its own orchestrator; bound as a
// namespace so each call names the contract method it reaches.
import * as position from './position-migration.js';
import type { PlannedImport, PlannedMember, PlannedRewrite } from './position-migration.js';
import { EXTERNAL_ALIAS_RE, PROJECT_ID_RE } from '../models/project.js';
import { declares, familyNode, type CrossProjectReference, type ProjectFamily, type ProjectNode } from '../models/project-family.js';
import { exportTargetKey, type ResolvedExport, type ResolvedExportTable } from '../models/exports.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, SystemSpec, TypeSpec } from '../models/specs.js';
import { liveName, rehearsalRoot, type Rehearsal } from './types.js';

// ---------------------------------------------------------------------------
// chaining_migration_orchestrator — the stage-2c chaining migration of one
// project family, plan first.
//
// plan() reads what the project graph and the export usage already report and
// answers, per project, what it would write: the defaulted ids to declare, the
// L0 entries producers lack (re-exports, and the own `{ typeDef }` of a
// project-level type), the minimal L0 of a producer that has none, the
// externals consumers must declare, the aliases to pin once all of that is
// written (every declared family external never pinned among them) — and,
// through the position migration, the legacy mounts to move into `members`,
// the deprecated and self-prefixed references to rewrite and stage 4's
// positional `use` imports, with the exports and externals those need. Every
// consumer → producer edge it introduces is listed as a new dependency. It
// writes nothing. write(plan, rehearsal) writes exactly that, in a fixed order —
// ids, exports, externals, then position (members, imports, rewrites,
// superseded pins), and pins LAST, so every snapshot projects the final
// spelling — each under its project's REHEARSAL binding (the rehearsal's image
// of its directory), and locks nothing: every project whose approval the writes
// stale is named for its own human to re-lock. Since stage 6 the family
// transaction swaps the rehearsal's result in all-or-nothing, where a failure
// mid-apply once left a half-migrated family only idempotence could finish.
//
// It holds no state: the plan is a value its caller holds between the two. It
// lives in sdd_migrations (moved from sdd_cli in stage 6) because it composes
// three planes — the core's configuration writes, the gated authoring seam for
// the L0 entries (new design content, so it is judged like any authored
// write), and the surfaces plane for the pins — and only a layer above all
// three can, behind the family transaction. Every hop into another project's root
// is a runWithProjectRoot, so the caller's binding is restored on every path,
// a refusal included. The caller must gate on reach itself.
// ---------------------------------------------------------------------------

/** chaining_migration_finding — something the migration will not do for a person. */
export interface ChainingMigrationFinding {
  /**
   * id-ambiguous | id-locked | declaration-orphaned | target-unpublished |
   * target-missing | name-taken | narrowed | subsystem-reference |
   * alias-invalid | alias-taken | project-absent | member-absent |
   * family-partial | mount-field-conflict | mount-field-unhomed |
   * rewrite-unavailable | positional-ambiguous | import-shadowed |
   * import-collision
   */
  kind: string;
  /** The namespace of the project it concerns ('' is the family's top root). */
  project: string;
  /** What is wrong and what a person does about it. */
  detail: string;
  /** The reference concerned, for a finding about one. */
  reference?: CrossProjectReference;
  /** Whether apply refuses because of it. */
  blocking: boolean;
}

/** planned_export — one L0 entry the migration adds to a producer. */
export interface PlannedExport {
  /** The source subsystem's local id in the producer; absent for a project-level type, exported as the project's own. */
  from?: string;
  /** The re-exported component's local id, for a component reference. */
  component?: string;
  /** The L3 interface a carried mount entry narrows to. */
  interface?: string;
  /** The re-exported type's local id, for a type reference. */
  typeDef?: string;
  /** The public name the entry binds: the item's default. */
  publicName: string;
  /** Always project. */
  audience: string;
  /** The namespaces of the projects whose references the entry serves, sorted. */
  consumers: string[];
  /** The members the consumers reach through the entry, sorted. */
  members: string[];
  /** The transport kind a carried mount entry declared. */
  type?: string;
  /** The details a carried mount entry declared. */
  details?: string;
  /** reference | mount | positional */
  reason: string;
  /** A carried entry whose component its member subsystem does not publish yet: apply publishes it at L1 first. */
  publishAtL1?: boolean;
}

/** planned_external — one `externals` declaration the migration adds to a consumer. */
export interface PlannedExternal {
  /** The alias key: the producer's planned id. */
  alias: string;
  /** The producer's project id — equal to the alias. */
  project: string;
  /** The producer's namespace in the family graph. */
  producer: string;
  /** reference | legacy-pin | positional */
  reason: string;
}

/** project_migration — what the migration writes into one project of the family. */
export interface ProjectMigration {
  /** The project's namespace in the family graph ('' is the top root). */
  project: string;
  /** The project's root directory, absolute. */
  directory: string;
  /** The id the project answers to after apply. */
  id?: string;
  /** The id apply declares in its project.yaml. */
  idToWrite?: string;
  /** The re-export entries apply adds to its L0, in source-subsystem then item order. */
  exports: PlannedExport[];
  /** The externals apply declares, in alias order. */
  externals: PlannedExternal[];
  /** The aliases apply pins once every write is done. */
  pins: string[];
  /** The storage keys of its stage-1 family pins, deleted once the externals replacing them are pinned. */
  supersededPins: string[];
  /** Whether apply writes a minimal L0 first: the project gains entries and has no L0. */
  createsSystem: boolean;
  /** The legacy L1 mounts apply moves into this project's `members`, in declaration order. */
  members: PlannedMember[];
  /** Keys the stored L0 carries that its schema does not know, which the first gated L0 write drops. */
  droppedKeys: string[];
  /** The `use` entries apply adds (stage 4's positional step), in alias then name order. */
  imports: PlannedImport[];
}

/** chaining_migration_plan — the migration of one family, planned and not yet applied. */
export interface ChainingMigrationPlan {
  /** The directory of the highest root the climb reached. */
  familyRoot: string;
  /** Whether the climb reached the family's true top. */
  whole: boolean;
  /** The projects the plan writes, top root first, then members in walk order. */
  projects: ProjectMigration[];
  /** Every ambiguity reported and every reference the plan cannot migrate, in the order found. */
  findings: ChainingMigrationFinding[];
  /** Every reference apply rewrites out of a deprecated form: projects in walk order, then spec, then position. */
  rewrites: PlannedRewrite[];
  /** Every consumer → producer edge the plan introduces that no external and no pin had before, with its reference count. */
  newDependencies: string[];
}

/** chaining_migration_report — the answer of applying a plan. */
export interface ChainingMigrationReport {
  /** The plan applied, findings included. */
  plan: ChainingMigrationPlan;
  /** True when apply wrote. */
  applied: boolean;
  /** Every file apply changed, in write order. */
  written: string[];
  /** The directories of the projects whose lock the writes left stale. */
  relock: string[];
}

// ── chaining_migration_plan behaviour ───────────────────────────────────────

/** chaining_migration_plan.isEmpty — no project has anything to write and no reference is rewritten; findings do not count. */
export function isEmpty(migration: ChainingMigrationPlan): boolean {
  return migration.projects.every((p) => !hasWrites(p)) && migration.rewrites.length === 0;
}

/** chaining_migration_plan.blocked — a finding refuses apply. */
export function blocked(migration: ChainingMigrationPlan): boolean {
  return migration.findings.some((f) => f.blocking);
}

function hasWrites(p: ProjectMigration): boolean {
  return p.idToWrite !== undefined || p.createsSystem || p.exports.length > 0 || p.externals.length > 0 || p.pins.length > 0
    || p.members.length > 0 || p.supersededPins.length > 0 || p.imports.length > 0;
}

// ── plan ────────────────────────────────────────────────────────────────────

/** The working state of one plan() call — a local value, never held between calls. */
interface Planning {
  family: ProjectFamily;
  projects: Map<string, ProjectMigration>;
  findings: ChainingMigrationFinding[];
  /** The absent projects' findings, whose blocking is decided once the plan is known. */
  absent: Map<string, ChainingMigrationFinding>;
  /** The references rewritten out of a deprecated form, as the position migration planned them. */
  rewrites: PlannedRewrite[];
}

/**
 * ichaining_migration_orchestrator.plan — the migration of the bound project's
 * family, from the highest root in reach. Writes nothing.
 */
export function plan(): ChainingMigrationPlan {
  // Step 1: the bound root; every hop below is a scoped binding, so the
  // caller's binding is restored on every path.
  const bound = getProjectRoot();
  // Steps 1-3: climb the membership chain.
  const climbed = climb(bound);
  // Steps 4-25: plan the family from the highest root reached.
  return runWithProjectRoot(climbed.top, () => planFamily(climbed.top, climbed.whole));
}

/** Steps 1-3: the highest root in reach, and whether it is the family's true top. */
function climb(start: string): { top: string; whole: boolean } {
  let current = start;
  let parent: { parentRoot: string } | null;
  do {
    // Step 2: null for a top root — and for a hop the request may not read.
    parent = runWithProjectRoot(current, () => core.resolveChainingParent());
    // Step 3.
    if (parent) current = parent.parentRoot;
  } while (parent);
  return { top: current, whole: !parentWithheld() };
}

/** Whether the request's reach withholds what lies above its root — the one way a climb stops short. */
function parentWithheld(): boolean {
  const reach = getRequestParentReach();
  return reach !== null && !reach.parentReach;
}

function planFamily(top: string, whole: boolean): ChainingMigrationPlan {
  // Step 4: the project graph of the highest root reached.
  const ctx: Planning = { family: core.projectFamily(), projects: new Map(), findings: [], absent: new Map(), rewrites: [] };
  if (!whole) {
    ctx.findings.push({
      kind: 'family-partial', project: '', blocking: true,
      detail: 'the climb stopped at a hop out of reach, so a producer above it could need writes this plan cannot see — run the migration from the family\'s top root',
    });
  }
  // Steps 5-8: the ids.
  decideIds(ctx);
  // Steps 9-17: the crossings.
  planCrossings(ctx);
  // Steps 18-21: the stage-1 pins, and the declared externals never pinned.
  convertLegacyPins(ctx);
  // Step 22: the retirement of position, merged, and the new dependencies.
  mergePosition(ctx);
  // Steps 23-24: what the L0 writes would drop.
  findDroppedKeys(ctx);
  // Step 25: the projects with something to write, in walk order.
  return settle(ctx, top, whole);
}

/** The plan entry of a project, created on first use. */
function entryOf(ctx: Planning, node: ProjectNode): ProjectMigration {
  let entry = ctx.projects.get(node.namespace);
  if (!entry) {
    entry = {
      project: node.namespace, directory: node.directory, exports: [], externals: [], pins: [], supersededPins: [],
      createsSystem: false, members: [], droppedKeys: [], imports: [],
    };
    ctx.projects.set(node.namespace, entry);
  }
  return entry;
}

/** The id a project answers to after apply, or undefined when it has none. */
function idOf(ctx: Planning, namespace: string): string | undefined {
  return ctx.projects.get(namespace)?.id;
}

const label = (namespace: string): string => (namespace === '' ? 'the top root' : `"${namespace}"`);

// ── steps 5-8: ids ──────────────────────────────────────────────────────────

function decideIds(ctx: Planning): void {
  // Step 5.
  for (const node of ctx.family.nodes) {
    // Step 6: the id the node's own lock approved, if any.
    const approved = core.approvalRecord(node.directory)?.projectId;
    // Step 7.
    decideId(ctx, node, approved);
  }
  // Step 8.
  checkPlannedIds(ctx);
}

/** Step 7: the id one project answers to after apply, and whether apply writes it. */
function decideId(ctx: Planning, node: ProjectNode, approved: string | undefined): void {
  const entry = entryOf(ctx, node);
  const member = node.parent !== undefined;
  if (node.idSource === 'declared') {
    entry.id = node.id;
    return;
  }
  const planned = approved ?? (member ? node.mountAlias : node.id);
  if (node.name === undefined) absentProject(ctx, node);
  if (planned === undefined) {
    ctx.findings.push({ kind: 'id-ambiguous', project: node.namespace, blocking: false, detail: `${label(node.namespace)} declares no id and its name yields none — declare one in its project.yaml` });
    return;
  }
  entry.id = planned;
  entry.idToWrite = planned;
  if (approved !== undefined && member && approved !== node.mountAlias) {
    ctx.findings.push({
      kind: 'id-locked', project: node.namespace, blocking: false,
      detail: `${label(node.namespace)} keeps "${approved}", the id its lock approved, rather than its mount's subsystem id "${node.mountAlias}" — moving it is the rename migration`,
    });
  }
}

function absentProject(ctx: Planning, node: ProjectNode): void {
  const finding: ChainingMigrationFinding = {
    kind: 'project-absent', project: node.namespace, blocking: false,
    detail: `${label(node.namespace)} (${node.directory}) has no readable project.yaml — \`wairon doctor --fix\` writes one for a chained child first`,
  };
  ctx.findings.push(finding);
  ctx.absent.set(node.namespace, finding);
}

/** Step 8: a planned id outside the grammar or shared with another project is reported, never written. */
function checkPlannedIds(ctx: Planning): void {
  const holders = new Map<string, string[]>();
  for (const entry of ctx.projects.values()) {
    if (entry.id !== undefined) holders.set(entry.id, [...(holders.get(entry.id) ?? []), entry.project]);
  }
  for (const entry of ctx.projects.values()) {
    if (entry.idToWrite === undefined) continue;
    const others = (holders.get(entry.idToWrite) ?? []).filter((ns) => ns !== entry.project);
    const why = !PROJECT_ID_RE.test(entry.idToWrite) ? 'breaks the project-id grammar'
      : others.length > 0 ? `is also the id of ${others.map(label).join(', ')}` : undefined;
    if (why === undefined) continue;
    ctx.findings.push({ kind: 'id-ambiguous', project: entry.project, blocking: false, detail: `the id planned for ${label(entry.project)}, "${entry.idToWrite}", ${why} — declare one by hand` });
    delete entry.id;
    delete entry.idToWrite;
  }
  reportOrphanedDeclarations(ctx);
}

/** Step 8: an external that finds its producer by the id that producer is about to leave. */
function reportOrphanedDeclarations(ctx: Planning): void {
  for (const node of ctx.family.nodes) {
    for (const external of node.externals) {
      if (external.sourceKind !== 'family' || external.producer === undefined) continue;
      const next = ctx.projects.get(external.producer)?.idToWrite;
      if (next === undefined || next === external.project) continue;
      ctx.findings.push({
        kind: 'declaration-orphaned', project: node.namespace, blocking: false,
        detail: `the external "${external.alias}" finds ${label(external.producer)} by "${external.project}", which it leaves for "${next}" — re-point the declaration after the migration`,
      });
    }
  }
}

// ── steps 9-17: crossings ───────────────────────────────────────────────────

function planCrossings(ctx: Planning): void {
  // Step 9: each (consumer, producer) pair, in the order the graph found them.
  const pairs = new Map<string, { consumer: string; producer: string }>();
  for (const ref of ctx.family.references) pairs.set(`${ref.consumer}\u0000${ref.producer}`, { consumer: ref.consumer, producer: ref.producer });
  for (const { consumer, producer } of pairs.values()) planPair(ctx, consumer, producer);
}

function planPair(ctx: Planning, consumer: string, producer: string): void {
  const consumerNode = familyNode(ctx.family, consumer);
  const producerNode = familyNode(ctx.family, producer);
  if (!consumerNode || !producerNode) return;
  // Step 10: the references mapped onto the producer's public names.
  const usage = core.exportUsage(consumer, producer);
  // Step 11: the producer's current table.
  const table = core.resolveProjectExports(producer || undefined);
  // Steps 12-15.
  let entries = false;
  for (const ref of usage.unexported) entries = planEntry(ctx, producerNode, ref, table, 'reference') === 'planned' || entries;
  // Step 16.
  const alias = declares(ctx.family, consumer, producer)
    ? declaredAlias(consumerNode, producer)
    : planExternal(ctx, consumerNode, producer, 'reference');
  // Step 17.
  if (alias !== undefined && (entries || alias.planned)) addPin(ctx, consumerNode, alias.alias);
}

/** The alias an existing declaration reaches the producer under; none for a member, whose mount is its alias. */
function declaredAlias(consumer: ProjectNode, producer: string): { alias: string; planned: boolean } | undefined {
  const external = consumer.externals.find((e) => e.sourceKind === 'family' && e.producer === producer);
  return external ? { alias: external.alias, planned: false } : undefined;
}

function addPin(ctx: Planning, consumer: ProjectNode, alias: string): void {
  const entry = entryOf(ctx, consumer);
  if (!entry.pins.includes(alias)) entry.pins.push(alias);
}

/** What a reference names: the item and the subsystem that owns it. */
interface ReferenceTarget {
  kind: 'component' | 'type' | 'subsystem';
  /** The item's qualified id. */
  id: string;
  /** The qualified id of the subsystem that owns it; absent for a project-level type, which the project owns. */
  source?: string;
}

/** What planning a reference's entry came to: planned (or merged), present already, or refused with a finding. */
type EntryOutcome = 'planned' | 'present' | 'refused';

/** Steps 13-15 for one reference. */
function planEntry(ctx: Planning, producer: ProjectNode, ref: CrossProjectReference, table: ResolvedExportTable, reason: string): EntryOutcome {
  // Step 13: the spec the reference targets, for the subsystem that owns it.
  const target = targetOf(ref);
  if (!target) {
    return report(ctx, 'target-missing', ref, `${ref.specId} names "${ref.target}", but ${label(producer.namespace)} declares no component, subsystem-owned type or project-level type of that id — the reference is wrong`);
  }
  if (target.kind === 'subsystem') {
    return report(ctx, 'subsystem-reference', ref, `${ref.specId} re-exports ${label(producer.namespace)}'s subsystem "${target.id}" wholesale — no L0 entry short of exporting it expresses that; rewrite the reference to name the items it uses`);
  }
  // Steps 14-15: a project-level type needs no L1 publication; any other item follows its subsystem's table.
  if (target.source === undefined) return decideOwnType(ctx, producer, ref, target, table, reason);
  return decideEntry(ctx, producer, ref, target, table, core.resolveSubsystemExports(target.source), reason);
}

/** Step 13: the component, type or subsystem a reference names, or null. */
function targetOf(ref: CrossProjectReference): ReferenceTarget | null {
  const component = core.loadSpec('component', ref.target) as ComponentSpec | null;
  if (component) return { kind: 'component', id: component.id, source: component.subsystem };
  const last = ref.target.split('::').pop()!;
  for (const candidate of [ref.target, ref.producer ? `${ref.producer}::${last}` : last]) {
    const type = core.loadSpec('type', candidate) as TypeSpec | null;
    if (type) return { kind: 'type', id: type.id, ...(type.subsystem ? { source: type.subsystem } : {}) };
  }
  const subsystem = core.loadSpec('subsystem', ref.target) as SubsystemSpec | null;
  return subsystem ? { kind: 'subsystem', id: subsystem.id, source: subsystem.id } : null;
}

/** Step 15 for a project-level type: its own `{ typeDef }` entry, the crate-root `pub struct`. */
function decideOwnType(ctx: Planning, producer: ProjectNode, ref: CrossProjectReference, target: ReferenceTarget, table: ResolvedExportTable, reason: string): EntryOutcome {
  const key = targetKey(target);
  if (table.entries.some((e) => exportTargetKey(e) === key)) return 'present';
  const local = localIn(producer.namespace, target.id);
  const taken = table.entries.find((e) => e.publicName === local && exportTargetKey(e) !== key)
    ?? entryOf(ctx, producer).exports.find((e) => e.publicName === local && (e.component ?? e.typeDef) !== local);
  if (taken) {
    return report(ctx, 'name-taken', ref, `"${local}" already names another item in ${label(producer.namespace)} — export the type "${target.id}" under a name a person chooses`);
  }
  mergeEntry(entryOf(ctx, producer), target, undefined, local, local, ref, reason);
  return 'planned';
}

/** Step 15: plan or merge the producer's entry for the reference, or report why not. */
function decideEntry(
  ctx: Planning, producer: ProjectNode, ref: CrossProjectReference, target: ReferenceTarget,
  table: ResolvedExportTable, published: ResolvedExportTable, reason: string,
): EntryOutcome {
  const key = targetKey(target);
  const at = published.entries.filter((e) => exportTargetKey({ ...e, interface: undefined }) === key);
  if (at.length === 0) {
    return report(ctx, 'target-unpublished', ref, `"${target.id}" is not in its subsystem's L1 table, so no L0 re-export can follow it — publish it at L1 first, or the reference is wrong`);
  }
  // Exported already: a reference that only lacked its declaration needs no entry (its external is planned below).
  const exported = table.entries.filter((e) => exportTargetKey({ ...e, interface: undefined }) === key);
  if (exported.length > 0 && reachableThrough(exported, ref)) return 'present';
  if (exported.length > 0 || !reachableThrough(at, ref)) {
    return report(ctx, 'narrowed', ref, `"${target.id}" is exported under a narrowing that does not declare "${ref.member ?? 'what the reference reaches'}" — widen the narrowing or reach another member`);
  }
  const local = localIn(producer.namespace, target.id);
  const publicName = local.split('::').pop()!;
  const taken = table.entries.find((e) => e.publicName === publicName && exportTargetKey({ ...e, interface: undefined }) !== key)
    ?? entryOf(ctx, producer).exports.find((e) => e.publicName === publicName && (e.component ?? e.typeDef) !== local);
  if (taken) {
    return report(ctx, 'name-taken', ref, `"${publicName}" already names another item in ${label(producer.namespace)} — export "${target.id}" under a name a person chooses`);
  }
  mergeEntry(entryOf(ctx, producer), target, localIn(producer.namespace, target.source!), local, publicName, ref, reason);
  return 'planned';
}

/** Whether some L1 entry for the item would let the reference's member through. */
function reachableThrough(entries: ResolvedExport[], ref: CrossProjectReference): boolean {
  if (ref.member === undefined || ref.member.startsWith('capability:')) return true;
  return entries.some((e) => {
    if (e.kind !== 'component' || e.interface === undefined) return true;
    const narrowing = core.loadSpec('interface', e.interface) as InterfaceSpec | null;
    return narrowing?.methods.some((m) => m.name === ref.member) ?? false;
  });
}

const targetKey = (t: ReferenceTarget): string => (t.kind === 'type' ? `type:${t.id}` : `component:${t.id}`);

/** An id local to the project at `namespace`: its namespace prefix stripped. */
function localIn(namespace: string, id: string): string {
  return namespace && id.startsWith(`${namespace}::`) ? id.slice(namespace.length + 2) : id;
}

function mergeEntry(
  entry: ProjectMigration, target: ReferenceTarget, from: string | undefined, item: string, publicName: string,
  ref: CrossProjectReference, reason: string,
): void {
  let planned = entry.exports.find((e) => e.from === from && e.interface === undefined && (target.kind === 'type' ? e.typeDef : e.component) === item);
  if (!planned) {
    planned = {
      ...(from !== undefined ? { from } : {}), ...(target.kind === 'type' ? { typeDef: item } : { component: item }),
      publicName, audience: 'project', consumers: [], members: [], reason,
    };
    entry.exports.push(planned);
  }
  addSorted(planned.consumers, ref.consumer);
  const member = target.kind === 'type' ? 'type' : ref.member;
  if (member !== undefined) addSorted(planned.members, member);
}

function addSorted(list: string[], value: string): void {
  if (!list.includes(value)) {
    list.push(value);
    list.sort();
  }
}

function report(ctx: Planning, kind: string, ref: CrossProjectReference, detail: string): 'refused' {
  ctx.findings.push({ kind, project: ref.producer, detail, reference: ref, blocking: false });
  return 'refused';
}

/**
 * Step 16: the consumer's external for the producer, under the producer's
 * planned id. An existing declaration that names that id already is the
 * declaration: it starts resolving once the id is written.
 */
function planExternal(ctx: Planning, consumer: ProjectNode, producer: string, reason: string): { alias: string; planned: boolean } | undefined {
  const alias = idOf(ctx, producer);
  const refuse = (kind: string, detail: string): undefined => {
    ctx.findings.push({ kind, project: consumer.namespace, blocking: false, detail });
    return undefined;
  };
  if (alias === undefined) return refuse('alias-invalid', `${label(producer)} has no id to declare it under — declare its id first`);
  if (!EXTERNAL_ALIAS_RE.test(alias)) return refuse('alias-invalid', `"${alias}" is not an alias ([a-z0-9-_]+) — declare ${label(producer)} under an alias a person chooses`);
  const existing = consumer.externals.find((e) => e.alias === alias);
  if (existing && existing.project === alias) return { alias, planned: true };
  const mounted = consumer.members.some((m) => familyNode(ctx.family, m)?.mountAlias === alias);
  const entry = entryOf(ctx, consumer);
  const planned = entry.externals.find((e) => e.alias === alias);
  if (existing || mounted || (planned && planned.producer !== producer)) {
    return refuse('alias-taken', `${label(consumer.namespace)} already uses the alias "${alias}" for something else — declare ${label(producer)} under another`);
  }
  if (!planned) entry.externals.push({ alias, project: alias, producer, reason });
  return { alias, planned: true };
}

// ── steps 18-21: the stage-1 pins, and the externals never pinned ──────────

function convertLegacyPins(ctx: Planning): void {
  // Step 18: each node of the graph.
  for (const node of ctx.family.nodes) {
    if (node.parent !== undefined) {
      // Step 19: a chained member's vendored surfaces, with their family role.
      const pins = runWithProjectRoot(node.directory, () => surfaces.listFamilyPins());
      // Step 20: every family pin is superseded; the parent pin converts first.
      for (const pin of pins) {
        addSorted(entryOf(ctx, node).supersededPins, pin.key);
        if (pin.role === 'parent') convertParentPin(ctx, node, node.parent);
      }
    }
    // Step 21.
    pinNeverPinned(ctx, node);
  }
}

/** Step 20: the family pin becomes an external for the parent, unless the member declares it already. */
function convertParentPin(ctx: Planning, member: ProjectNode, parent: string): void {
  if (declares(ctx.family, member.namespace, parent)) return;
  if (entryOf(ctx, member).externals.some((e) => e.producer === parent)) return;
  const alias = planExternal(ctx, member, parent, 'legacy-pin');
  if (alias !== undefined) addPin(ctx, member, alias.alias);
}

/**
 * Step 21: a family external a project declared before the migration ran and
 * never pinned is pinned with the rest — its gate has nothing to judge the
 * references against until it is. A pinned one is left alone: re-pinning a
 * changed producer would hide the change the family run reports.
 */
function pinNeverPinned(ctx: Planning, node: ProjectNode): void {
  if (node.externals.every((e) => e.sourceKind !== 'family')) return;
  // Its declared externals and their lock entries, under its binding.
  const listed = runWithProjectRoot(node.directory, () => surfaces.listExternals());
  for (const external of listed) {
    if (external.sourceKind === 'family' && external.lock === undefined) addPin(ctx, node, external.alias);
  }
}

// ── step 22: the retirement of position ────────────────────────────────────

function mergePosition(ctx: Planning): void {
  const planned = position.plan(ctx.family);
  for (const member of planned.members) {
    const parent = familyNode(ctx.family, member.parent);
    const child = familyNode(ctx.family, member.member);
    if (!parent || !child) continue;
    entryOf(ctx, parent).members.push(member);
    for (const carried of member.carried) mergeCarried(entryOf(ctx, child), carried);
  }
  ctx.rewrites = planned.rewrites.map((r) => spelledWithPlannedAlias(ctx, r));
  // A project whose specs are rewritten is one apply writes into.
  for (const r of ctx.rewrites) {
    const node = familyNode(ctx.family, r.project);
    if (node) entryOf(ctx, node);
  }
  ctx.findings.push(...planned.findings);
  // Stage 4's positional imports, each with the export and the external it needs.
  for (const planned_ of planned.imports) mergeImport(ctx, planned_);
  // A producer that gains an entry and has no L0 gets a minimal one first.
  for (const node of ctx.family.nodes) {
    const entry = ctx.projects.get(node.namespace);
    if (entry && entry.exports.length > 0 && !node.hasSystem) entry.createsSystem = true;
  }
}

/**
 * One positional import: the export it names merged into the producer's
 * entries (reason positional, checked exactly as a reference's entry is), the
 * external planned when the consumer does not declare the producer (reason
 * positional) with a pin, and the import into the consumer's share. An import
 * whose export or external is refused is dropped: the refusal is the finding.
 */
function mergeImport(ctx: Planning, planned: PlannedImport): void {
  const consumer = familyNode(ctx.family, planned.consumer);
  const producer = familyNode(ctx.family, planned.producer);
  if (!consumer || !producer) return;
  const localId = planned.target.slice(planned.target.indexOf('::') + 2);
  if (planned.exportPlanned) {
    const [specId, position, ...authored] = planned.references[0].split(' ');
    const ref: CrossProjectReference = {
      specId, position, target: `${producer.namespace ? `${producer.namespace}::` : ''}${localId}`,
      consumer: consumer.namespace, producer: producer.namespace, authored: authored.join(' '),
    };
    if (planEntry(ctx, producer, ref, core.resolveProjectExports(producer.namespace || undefined), 'positional') === 'refused') return;
  }
  let alias = planned.alias;
  if (planned.declaresExternal) {
    const declared = planExternal(ctx, consumer, producer.namespace, 'positional');
    if (declared === undefined) return;
    alias = declared.alias;
  }
  if (planned.declaresExternal || consumer.externals.some((e) => e.alias === alias)) addPin(ctx, consumer, alias);
  entryOf(ctx, consumer).imports.push({ ...planned, alias });
}

/**
 * Step 22: every consumer → producer edge the plan introduces that no external
 * and no pin of the consumer had before, with its reference count — listed,
 * never blocking, no layering guessed. A stage-1 parent pin converted to an
 * external is no new edge: the pin was there.
 */
function newDependencies(ctx: Planning): string[] {
  const lines: string[] = [];
  const name = (ns: string): string => ctx.projects.get(ns)?.id ?? familyNode(ctx.family, ns)?.id ?? (ns || 'the top root');
  for (const entry of ctx.projects.values()) {
    for (const external of entry.externals) {
      if (external.reason === 'legacy-pin') continue;
      const references = new Set([
        ...ctx.family.references.filter((r) => r.consumer === entry.project && r.producer === external.producer).map((r) => `${r.specId} ${r.position} ${r.authored}`),
        ...entry.imports.filter((i) => i.producer === external.producer).flatMap((i) => i.references),
      ]).size;
      lines.push(`${name(entry.project)} now depends on ${name(external.producer)} (${references} reference${references === 1 ? '' : 's'})`);
    }
  }
  return lines;
}

/** A carried mount entry, unless an entry for the same item is planned already. */
function mergeCarried(entry: ProjectMigration, carried: PlannedExport): void {
  const same = (e: PlannedExport): boolean => e.from === carried.from && e.interface === carried.interface
    && e.component === carried.component && e.typeDef === carried.typeDef;
  if (!entry.exports.some(same)) entry.exports.push(carried);
}

/**
 * A rewrite into a producer its referrer does not declare yet names the
 * producer's current id; apply's re-save writes the alias this plan declares
 * for it, so the plan shows that spelling.
 */
function spelledWithPlannedAlias(ctx: Planning, rewrite: PlannedRewrite): PlannedRewrite {
  const ref = ctx.family.authoredReferences.find((r) => r.specId === rewrite.specId && r.position === rewrite.position && r.authored === rewrite.from);
  if (!ref || ref.binding !== 'undeclared' || ref.producer === undefined) return rewrite;
  const consumer = ctx.projects.get(rewrite.project);
  const alias = consumer?.externals.find((e) => e.producer === ref.producer)?.alias ?? ctx.projects.get(ref.producer)?.id;
  const rest = rewrite.to.slice(rewrite.to.indexOf('::'));
  return alias === undefined || !rewrite.to.includes('::') ? rewrite : { ...rewrite, to: `${alias}${rest}` };
}

// ── steps 23-24: what the L0 writes would drop ──────────────────────────────

function findDroppedKeys(ctx: Planning): void {
  // Step 23: each project that gains L0 entries and already has an L0.
  for (const node of ctx.family.nodes) {
    const entry = ctx.projects.get(node.namespace);
    if (!entry || entry.exports.length === 0 || !node.hasSystem) continue;
    // Step 24: the one L0 delta, dry-run through the gated seam under the project's binding.
    entry.droppedKeys = runWithProjectRoot(node.directory, () => dryRunStrippedKeys(entry));
  }
}

/** The keys the stored L0 file carries that its schema drops; none when the dry run is refused (apply's preflight names why). */
function dryRunStrippedKeys(entry: ProjectMigration): string[] {
  try {
    return authoring.updateSpecGated('system', 'system', exportDelta(entry), true).strippedKeys ?? [];
  } catch {
    return [];
  }
}

// ── step 25 ─────────────────────────────────────────────────────────────────

function settle(ctx: Planning, top: string, whole: boolean): ChainingMigrationPlan {
  const projects: ProjectMigration[] = [];
  const rewritten = new Set(ctx.rewrites.map((r) => r.project));
  for (const node of ctx.family.nodes) {
    const entry = ctx.projects.get(node.namespace);
    if (!entry || (!hasWrites(entry) && !rewritten.has(node.namespace))) continue;
    entry.exports.sort((a, b) => compare(a.from ?? '', b.from ?? '') || compare(a.component ?? a.typeDef ?? '', b.component ?? b.typeDef ?? ''));
    entry.externals.sort((a, b) => compare(a.alias, b.alias));
    entry.imports.sort((a, b) => compare(a.alias, b.alias) || compare(a.name, b.name));
    entry.pins.sort();
    projects.push(entry);
  }
  // An absent project blocks only when the plan must write it.
  for (const [namespace, finding] of ctx.absent) finding.blocking = projects.some((p) => p.project === namespace);
  // The rewrites, projects in walk order, then spec, then position.
  const rank = (ns: string): number => ctx.family.nodes.findIndex((n) => n.namespace === ns);
  const rewrites = [...ctx.rewrites].sort((a, b) => rank(a.project) - rank(b.project) || compare(a.specId, b.specId) || compare(a.position, b.position));
  return { familyRoot: top, whole, projects, findings: ctx.findings, rewrites, newDependencies: newDependencies(ctx) };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── write ───────────────────────────────────────────────────────────────────

/** The files written and the projects to re-lock, each once, in first-write order. */
class WriteLog {
  readonly written: string[] = [];
  readonly relock: string[] = [];

  constructor(private readonly rehearsal: Rehearsal) {}

  /** A file written, named by its live project. */
  file(file: string): void {
    const live = liveName(this.rehearsal, file);
    if (!this.written.includes(live)) this.written.push(live);
  }

  stale(directory: string): void {
    if (!this.relock.includes(directory)) this.relock.push(directory);
  }
}

/**
 * ichaining_migration_orchestrator.write — write what the plan names into the
 * rehearsal, ids first and pins last, each under its project's rehearsal
 * binding. Idempotent: what is already there changes nothing. Locks nothing.
 */
// `plan` shadows the module's plan() here: write never plans, it writes the value it is given.
export function write(plan: ChainingMigrationPlan, rehearsal: Rehearsal): ChainingMigrationReport {
  // Steps 1-2.
  if (isEmpty(plan)) return { plan, applied: false, written: [], relock: [] };
  // Steps 3-4.
  if (blocked(plan)) {
    throw new ChainingMigrationRefusedError(plan.findings.filter((f) => f.blocking).map((f) => `${f.kind} (${label(f.project)}): ${f.detail}`));
  }
  // Steps 5-10: check every project before writing any.
  const projects = plan.projects.filter(hasWrites);
  // Steps 6 / 12 / 18 / 22: each project is bound at its rehearsal root.
  const at = (p: ProjectMigration): string => rehearsalRoot(rehearsal, p.directory);
  for (const p of projects) runWithProjectRoot(at(p), () => preflight(p));
  const log = new WriteLog(rehearsal);
  // Steps 11-13.
  for (const p of projects.filter((q) => q.idToWrite !== undefined)) runWithProjectRoot(at(p), () => declareId(p, log));
  // Steps 14-16.
  for (const p of projects.filter((q) => q.exports.length > 0)) runWithProjectRoot(at(p), () => addEntries(p, mountDescription(plan, p.project), log));
  // Steps 17-19.
  for (const p of projects.filter((q) => q.externals.length > 0)) runWithProjectRoot(at(p), () => declareExternals(p, log));
  // Step 20: then retire position — members, imports, rewrites, the superseded family pins.
  const retired = position.write(plan, rehearsal);
  retired.written.forEach((w) => log.file(w));
  retired.relock.forEach((d) => log.stale(d));
  // Steps 21-23: pins LAST, projected from the final spelling.
  for (const p of projects.filter((q) => q.pins.length > 0)) runWithProjectRoot(at(p), () => pin(p, log));
  // Steps 24-25.
  return { plan, applied: true, written: log.written, relock: log.relock };
}

/** Steps 6-10 for one project, under its binding. */
function preflight(p: ProjectMigration): void {
  // Steps 7-9.
  if (!core.projectConfigExists()) {
    throw new ChainingMigrationRefusedError([`project-absent (${label(p.project)}): ${p.directory} has no project.yaml any more`]);
  }
  // Step 10: the L0 delta through the whole gated write, writing nothing; a
  // project with no L0 yet has its minimal one judged when it is written.
  if (p.exports.length > 0 && !p.createsSystem) authoring.updateSpecGated('system', 'system', exportDelta(p), true);
}

/** The one delta that adds a producer's planned entries to its L0. */
function exportDelta(p: ProjectMigration): { publicInterfaces: Record<string, string>[] } {
  return {
    publicInterfaces: p.exports.map((e) => ({
      ...(e.from !== undefined ? { from: e.from } : {}),
      ...(e.typeDef !== undefined ? { typeDef: e.typeDef } : { component: e.component! }),
      ...(e.interface !== undefined ? { interface: e.interface } : {}),
      ...(e.type !== undefined ? { type: e.type } : {}),
      ...(e.details !== undefined ? { details: e.details } : {}),
      audience: e.audience,
    })),
  };
}

/** Step 13. */
function declareId(p: ProjectMigration, log: WriteLog): void {
  if (core.setId(p.idToWrite!)) log.file(AI_PATHS.projectConfig());
}

/** Steps 15-16: the minimal L0 first where there is none, then one gated delta; entries already present change nothing. */
function addEntries(p: ProjectMigration, description: string | undefined, log: WriteLog): void {
  // Step 15.
  if (p.createsSystem && core.loadSpec('system', 'system') === null) createMinimalSystem(p, description, log);
  // Step 16: a carried entry its subsystem does not publish yet is published at L1 first.
  for (const e of p.exports.filter((x) => x.publishAtL1 && x.from !== undefined && x.component !== undefined)) {
    const l1 = authoring.updateSpecGated('subsystem', e.from!, { publicInterfaces: [{ component: e.component, type: e.type, details: e.details }] });
    if (l1.written) {
      log.file(`${AI_PATHS.specsDir()}: subsystem ${e.from}`);
      log.stale(p.directory);
    }
  }
  const change = authoring.updateSpecGated('system', 'system', exportDelta(p));
  if (!change.written) return;
  log.file(AI_PATHS.specsSystem());
  log.stale(p.directory);
}

/** The description a legacy mount gives the member at `project`, carried into its member entry. */
function mountDescription(migration: ChainingMigrationPlan, project: string): string | undefined {
  for (const p of migration.projects) {
    const member = p.members.find((m) => m.member === project);
    if (member) return member.description;
  }
  return undefined;
}

/** Step 15: the minimal L0 of a project that exports and has none — new content, so through the gated seam. */
function createMinimalSystem(p: ProjectMigration, description: string | undefined, log: WriteLog): void {
  const name = core.loadProjectConfig()?.name ?? p.id ?? p.project;
  const spec = {
    name,
    vision: description ?? `${name}: a project of its family that exports to the others.`,
    boundaries: [],
    globalRequirements: [],
  } as unknown as SystemSpec;
  authoring.writeSpec({ kind: 'system', spec, fields: ['name', 'vision', 'boundaries', 'globalRequirements'] });
  log.file(AI_PATHS.specsSystem());
  log.stale(p.directory);
}

/** Step 19. */
function declareExternals(p: ProjectMigration, log: WriteLog): void {
  for (const external of p.externals) {
    if (!core.declareExternal(external.alias, {})) continue;
    log.file(AI_PATHS.projectConfig());
    log.stale(p.directory);
  }
}

/** Step 23: an unchanged snapshot is not rewritten; an unreachable producer keeps its previous pin. */
function pin(p: ProjectMigration, log: WriteLog): void {
  for (const pinned of surfaces.pinExternals(p.pins)) {
    if (pinned.outcome !== 'pinned') continue;
    if (pinned.snapshot) log.file(path.resolve(p.directory, pinned.snapshot));
    log.file(path.join(p.directory, '.wai', 'externals.lock.yaml'));
    log.stale(p.directory);
  }
}
