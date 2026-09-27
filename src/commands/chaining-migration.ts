import * as path from 'path';
import * as core from './adapters/core.js';
import * as authoring from './adapters/authoring.js';
import * as surfaces from './adapters/surfaces.js';
import { getProjectRoot, getRequestParentReach, runWithProjectRoot } from '../utils/fs.js';
import { AI_PATHS } from '../config/paths.js';
import { ChainingMigrationRefusedError } from '../utils/errors.js';
import { EXTERNAL_ALIAS_RE, PROJECT_ID_RE } from '../models/project.js';
import { declares, familyNode, type CrossProjectReference, type ProjectFamily, type ProjectNode } from '../models/project-family.js';
import { exportTargetKey, type ResolvedExport, type ResolvedExportTable } from '../models/exports.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec, TypeSpec } from '../models/specs.js';

// ---------------------------------------------------------------------------
// chaining_migration_orchestrator — the stage-2c chaining migration of one
// project family, plan first.
//
// plan() reads what the project graph and the export usage already report and
// answers, per project, what it would write: the defaulted ids to declare, the
// L0 re-export entries producers lack, the externals consumers must declare,
// and the aliases to pin once all of that is written. It writes nothing.
// apply(plan) writes exactly that, in a fixed order — ids, exports, externals,
// pins — each under its project's binding, and locks nothing: every project
// whose approval the writes staled is named for its own human to re-lock.
//
// It holds no state: the plan is a value its caller holds between the two. It
// lives in sdd_cli because it composes three planes — the core's configuration
// writes, the gated authoring seam for the L0 entries (new design content, so
// it is judged like any authored write), and the surfaces plane for the pins —
// and only a layer above all three can. Every hop into another project's root
// is a runWithProjectRoot, so the caller's binding is restored on every path,
// a refusal included. The caller must gate on reach itself.
// ---------------------------------------------------------------------------

/** chaining_migration_finding — something the migration will not do for a person. */
export interface ChainingMigrationFinding {
  /**
   * id-ambiguous | id-locked | declaration-orphaned | target-unpublished |
   * name-taken | narrowed | subsystem-reference | alias-invalid | alias-taken |
   * project-absent | family-partial
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

/** planned_export — one L0 re-export entry the migration adds to a producer. */
export interface PlannedExport {
  /** The source subsystem's local id in the producer. */
  from: string;
  /** The re-exported component's local id, for a component reference. */
  component?: string;
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
}

/** planned_external — one `externals` declaration the migration adds to a consumer. */
export interface PlannedExternal {
  /** The alias key: the producer's planned id. */
  alias: string;
  /** The producer's project id — equal to the alias. */
  project: string;
  /** The producer's namespace in the family graph. */
  producer: string;
  /** reference | legacy-pin */
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
  /** The storage keys of its stage-1 sibling pins, left on disk until stage 3. */
  supersededPins: string[];
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

/** chaining_migration_plan.isEmpty — no project has anything to write; findings do not count. */
export function isEmpty(migration: ChainingMigrationPlan): boolean {
  return migration.projects.every((p) => !hasWrites(p));
}

/** chaining_migration_plan.blocked — a finding refuses apply. */
export function blocked(migration: ChainingMigrationPlan): boolean {
  return migration.findings.some((f) => f.blocking);
}

function hasWrites(p: ProjectMigration): boolean {
  return p.idToWrite !== undefined || p.exports.length > 0 || p.externals.length > 0 || p.pins.length > 0;
}

// ── plan ────────────────────────────────────────────────────────────────────

/** The working state of one plan() call — a local value, never held between calls. */
interface Planning {
  family: ProjectFamily;
  projects: Map<string, ProjectMigration>;
  findings: ChainingMigrationFinding[];
  /** The absent projects' findings, whose blocking is decided once the plan is known. */
  absent: Map<string, ChainingMigrationFinding>;
}

/**
 * ichaining_migration_orchestrator.plan — the migration of the bound project's
 * family, from the highest root in reach. Writes nothing.
 */
export function plan(): ChainingMigrationPlan {
  // Step 1: the bound root; every hop below is a scoped binding, so the
  // caller's binding is restored on every path.
  const bound = getProjectRoot();
  // Steps 2-4: climb the mount chain.
  const climbed = climb(bound);
  // Steps 5-25: plan the family from the highest root reached.
  return runWithProjectRoot(climbed.top, () => planFamily(climbed.top, climbed.whole));
}

/** Steps 2-4: the highest root in reach, and whether it is the family's true top. */
function climb(start: string): { top: string; whole: boolean } {
  let current = start;
  let parent: { parentRoot: string } | null;
  do {
    // Step 3: null for a top root — and for a hop the request may not read.
    parent = runWithProjectRoot(current, () => core.resolveChainingParent());
    // Step 4.
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
  // Step 5: the project graph of the highest root reached.
  const ctx: Planning = { family: core.projectFamily(), projects: new Map(), findings: [], absent: new Map() };
  if (!whole) {
    ctx.findings.push({
      kind: 'family-partial', project: '', blocking: true,
      detail: 'the climb stopped at a hop out of reach, so a producer above it could need writes this plan cannot see — run the migration from the family\'s top root',
    });
  }
  // Steps 6-9: the ids.
  decideIds(ctx);
  // Steps 10-19: the crossings.
  planCrossings(ctx);
  // Steps 20-23: the stage-1 pins.
  convertLegacyPins(ctx);
  // Steps 24-25: the projects with something to write, in walk order.
  return settle(ctx, top, whole);
}

/** The plan entry of a project, created on first use. */
function entryOf(ctx: Planning, node: ProjectNode): ProjectMigration {
  let entry = ctx.projects.get(node.namespace);
  if (!entry) {
    entry = { project: node.namespace, directory: node.directory, exports: [], externals: [], pins: [], supersededPins: [] };
    ctx.projects.set(node.namespace, entry);
  }
  return entry;
}

/** The id a project answers to after apply, or undefined when it has none. */
function idOf(ctx: Planning, namespace: string): string | undefined {
  return ctx.projects.get(namespace)?.id;
}

const label = (namespace: string): string => (namespace === '' ? 'the top root' : `"${namespace}"`);

// ── steps 6-9: ids ──────────────────────────────────────────────────────────

function decideIds(ctx: Planning): void {
  // Step 6.
  for (const node of ctx.family.nodes) {
    // Step 7: the id the node's own lock approved, if any.
    const approved = core.approvalRecord(node.directory)?.projectId;
    // Step 8.
    decideId(ctx, node, approved);
  }
  // Step 9.
  checkPlannedIds(ctx);
}

/** Step 8: the id one project answers to after apply, and whether apply writes it. */
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

/** Step 9: a planned id outside the grammar or shared with another project is reported, never written. */
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

/** Step 9: an external that finds its producer by the id that producer is about to leave. */
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

// ── steps 10-19: crossings ──────────────────────────────────────────────────

function planCrossings(ctx: Planning): void {
  // Step 10: each (consumer, producer) pair, in the order the graph found them.
  const pairs = new Map<string, { consumer: string; producer: string }>();
  for (const ref of ctx.family.references) pairs.set(`${ref.consumer}\u0000${ref.producer}`, { consumer: ref.consumer, producer: ref.producer });
  for (const { consumer, producer } of pairs.values()) planPair(ctx, consumer, producer);
}

function planPair(ctx: Planning, consumer: string, producer: string): void {
  const consumerNode = familyNode(ctx.family, consumer);
  const producerNode = familyNode(ctx.family, producer);
  if (!consumerNode || !producerNode) return;
  // Step 11: the references mapped onto the producer's public names.
  const usage = core.exportUsage(consumer, producer);
  // Step 12: the producer's current table.
  const table = core.resolveProjectExports(producer || undefined);
  // Steps 13-16.
  let entries = false;
  for (const ref of usage.unexported) entries = planEntry(ctx, producerNode, ref, table) || entries;
  // Steps 17-18.
  const alias = declares(ctx.family, consumer, producer)
    ? declaredAlias(consumerNode, producer)
    : planExternal(ctx, consumerNode, producer, 'reference');
  // Step 19.
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
  /** The qualified id of the subsystem that owns it. */
  source: string;
}

/** Steps 13-16 for one reference; true when an entry was planned or merged. */
function planEntry(ctx: Planning, producer: ProjectNode, ref: CrossProjectReference, table: ResolvedExportTable): boolean {
  // Step 14: the spec the reference targets, for the subsystem that owns it.
  const target = targetOf(ref);
  if (!target) return report(ctx, 'target-unpublished', ref, `${ref.specId} names "${ref.target}", which ${label(producer.namespace)} does not hold`);
  if (target.kind === 'subsystem') {
    return report(ctx, 'subsystem-reference', ref, `${ref.specId} re-exports ${label(producer.namespace)}'s subsystem "${target.id}" wholesale — no L0 entry short of exporting it expresses that; stage 3 rewrites the reference`);
  }
  // Step 15: the source subsystem's L1 table.
  const published = core.resolveSubsystemExports(target.source);
  // Step 16.
  return decideEntry(ctx, producer, ref, target, table, published);
}

/** Step 14: the component, type or subsystem a reference names, or null. */
function targetOf(ref: CrossProjectReference): ReferenceTarget | null {
  const component = core.loadSpec('component', ref.target) as ComponentSpec | null;
  if (component) return { kind: 'component', id: component.id, source: component.subsystem };
  const last = ref.target.split('::').pop()!;
  for (const candidate of [ref.target, ref.producer ? `${ref.producer}::${last}` : last]) {
    const type = core.loadSpec('type', candidate) as TypeSpec | null;
    if (type) return type.subsystem ? { kind: 'type', id: type.id, source: type.subsystem } : null;
  }
  const subsystem = core.loadSpec('subsystem', ref.target) as SubsystemSpec | null;
  return subsystem ? { kind: 'subsystem', id: subsystem.id, source: subsystem.id } : null;
}

/** Step 16: plan or merge the producer's entry for the reference, or report why not. */
function decideEntry(
  ctx: Planning, producer: ProjectNode, ref: CrossProjectReference, target: ReferenceTarget,
  table: ResolvedExportTable, published: ResolvedExportTable,
): boolean {
  const key = targetKey(target);
  const at = published.entries.filter((e) => exportTargetKey({ ...e, interface: undefined }) === key);
  if (at.length === 0) {
    return report(ctx, 'target-unpublished', ref, `"${target.id}" is not in its subsystem's L1 table, so no L0 re-export can follow it — publish it at L1 first, or the reference is wrong`);
  }
  if (table.entries.some((e) => exportTargetKey({ ...e, interface: undefined }) === key) || !reachableThrough(at, ref)) {
    return report(ctx, 'narrowed', ref, `"${target.id}" is exported under a narrowing that does not declare "${ref.member ?? 'what the reference reaches'}" — widen the narrowing or reach another member`);
  }
  const local = localIn(producer.namespace, target.id);
  const publicName = local.split('::').pop()!;
  const taken = table.entries.find((e) => e.publicName === publicName && exportTargetKey({ ...e, interface: undefined }) !== key)
    ?? entryOf(ctx, producer).exports.find((e) => e.publicName === publicName && (e.component ?? e.typeDef) !== local);
  if (taken) {
    return report(ctx, 'name-taken', ref, `"${publicName}" already names another item in ${label(producer.namespace)} — export "${target.id}" under a name a person chooses`);
  }
  mergeEntry(entryOf(ctx, producer), target, localIn(producer.namespace, target.source), local, publicName, ref);
  return true;
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

function mergeEntry(entry: ProjectMigration, target: ReferenceTarget, from: string, item: string, publicName: string, ref: CrossProjectReference): void {
  let planned = entry.exports.find((e) => e.from === from && (target.kind === 'type' ? e.typeDef : e.component) === item);
  if (!planned) {
    planned = { from, ...(target.kind === 'type' ? { typeDef: item } : { component: item }), publicName, audience: 'project', consumers: [], members: [] };
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

function report(ctx: Planning, kind: string, ref: CrossProjectReference, detail: string): false {
  ctx.findings.push({ kind, project: ref.producer, detail, reference: ref, blocking: false });
  return false;
}

/**
 * Step 18: the consumer's external for the producer, under the producer's
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

// ── steps 20-23: the stage-1 pins ───────────────────────────────────────────

function convertLegacyPins(ctx: Planning): void {
  // Step 20: each chained member.
  for (const node of ctx.family.nodes) {
    if (node.parent === undefined) continue;
    // Steps 21-22: the member's vendored surfaces, with their family role.
    const pins = runWithProjectRoot(node.directory, () => surfaces.listFamilyPins());
    // Step 23.
    for (const pin of pins) {
      if (pin.role === 'sibling') addSorted(entryOf(ctx, node).supersededPins, pin.key);
      else convertParentPin(ctx, node, node.parent);
    }
  }
}

/** Step 23: the family pin becomes an external for the parent, unless the member declares it already. */
function convertParentPin(ctx: Planning, member: ProjectNode, parent: string): void {
  if (declares(ctx.family, member.namespace, parent)) return;
  if (entryOf(ctx, member).externals.some((e) => e.producer === parent)) return;
  const alias = planExternal(ctx, member, parent, 'legacy-pin');
  if (alias !== undefined) addPin(ctx, member, alias.alias);
}

// ── step 24 ─────────────────────────────────────────────────────────────────

function settle(ctx: Planning, top: string, whole: boolean): ChainingMigrationPlan {
  const projects: ProjectMigration[] = [];
  for (const node of ctx.family.nodes) {
    const entry = ctx.projects.get(node.namespace);
    if (!entry || !hasWrites(entry)) continue;
    entry.exports.sort((a, b) => compare(a.from, b.from) || compare(a.component ?? a.typeDef ?? '', b.component ?? b.typeDef ?? ''));
    entry.externals.sort((a, b) => compare(a.alias, b.alias));
    entry.pins.sort();
    projects.push(entry);
  }
  // An absent project blocks only when the plan must write it.
  for (const [namespace, finding] of ctx.absent) finding.blocking = projects.some((p) => p.project === namespace);
  return { familyRoot: top, whole, projects, findings: ctx.findings };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ── apply ───────────────────────────────────────────────────────────────────

/** The files written and the projects to re-lock, each once, in first-write order. */
class WriteLog {
  readonly written: string[] = [];
  readonly relock: string[] = [];

  file(file: string): void {
    if (!this.written.includes(file)) this.written.push(file);
  }

  stale(directory: string): void {
    if (!this.relock.includes(directory)) this.relock.push(directory);
  }
}

/**
 * ichaining_migration_orchestrator.apply — write what the plan names, ids
 * first and pins last, each under its project's binding. Idempotent: what is
 * already there changes nothing. Locks nothing.
 */
// `plan` shadows the module's plan() here: apply never plans, it applies the value it is given.
export function apply(plan: ChainingMigrationPlan): ChainingMigrationReport {
  // Steps 1-2.
  if (isEmpty(plan)) return { plan, applied: false, written: [], relock: [] };
  // Steps 3-4.
  if (blocked(plan)) {
    throw new ChainingMigrationRefusedError(plan.findings.filter((f) => f.blocking).map((f) => `${f.kind} (${label(f.project)}): ${f.detail}`));
  }
  // Steps 5-10: check every project before writing any.
  const projects = plan.projects.filter(hasWrites);
  for (const p of projects) runWithProjectRoot(p.directory, () => preflight(p));
  const log = new WriteLog();
  // Steps 11-13.
  for (const p of projects.filter((q) => q.idToWrite !== undefined)) runWithProjectRoot(p.directory, () => declareId(p, log));
  // Steps 14-16.
  for (const p of projects.filter((q) => q.exports.length > 0)) runWithProjectRoot(p.directory, () => addEntries(p, log));
  // Steps 17-19.
  for (const p of projects.filter((q) => q.externals.length > 0)) runWithProjectRoot(p.directory, () => declareExternals(p, log));
  // Steps 20-22.
  for (const p of projects.filter((q) => q.pins.length > 0)) runWithProjectRoot(p.directory, () => pin(p, log));
  // Steps 23-24.
  return { plan, applied: true, written: log.written, relock: log.relock };
}

/** Steps 6-10 for one project, under its binding. */
function preflight(p: ProjectMigration): void {
  // Steps 7-9.
  if (!core.projectConfigExists()) {
    throw new ChainingMigrationRefusedError([`project-absent (${label(p.project)}): ${p.directory} has no project.yaml any more`]);
  }
  // Step 10: the L0 delta through the whole gated write, writing nothing.
  if (p.exports.length > 0) authoring.updateSpecGated('system', 'system', exportDelta(p), true);
}

/** The one delta that adds a producer's planned entries to its L0. */
function exportDelta(p: ProjectMigration): { publicInterfaces: Record<string, string>[] } {
  return {
    publicInterfaces: p.exports.map((e) => ({
      from: e.from,
      ...(e.typeDef !== undefined ? { typeDef: e.typeDef } : { component: e.component! }),
      audience: e.audience,
    })),
  };
}

/** Step 13. */
function declareId(p: ProjectMigration, log: WriteLog): void {
  if (core.setProjectId(p.idToWrite!)) log.file(AI_PATHS.projectConfig());
}

/** Step 16: one gated delta; entries already present change nothing. */
function addEntries(p: ProjectMigration, log: WriteLog): void {
  const change = authoring.updateSpecGated('system', 'system', exportDelta(p));
  if (!change.written) return;
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

/** Step 22: an unchanged snapshot is not rewritten; an unreachable producer keeps its previous pin. */
function pin(p: ProjectMigration, log: WriteLog): void {
  for (const pinned of surfaces.pinExternals(p.pins)) {
    if (pinned.outcome !== 'pinned') continue;
    if (pinned.snapshot) log.file(path.resolve(p.directory, pinned.snapshot));
    log.file(path.join(p.directory, '.wai', 'externals.lock.yaml'));
    log.stale(p.directory);
  }
}
