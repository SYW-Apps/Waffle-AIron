import {
  ComponentSpecSchema,
  ImplementationSpecSchema,
  InterfaceSpecSchema,
  MethodImplementationSchema,
  MethodSignatureSchema,
  SubsystemSpecSchema,
  SystemSpecSchema,
  TypeMethodSchema,
  TypeSpecSchema,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type MethodImplementation,
  type SpecStatus,
  type SubsystemSpec,
  type SystemSpec,
  type TypeSpec,
} from '../models/specs.js';
import type { RulesConfig } from '../models/project.js';
import type { MethodMoveReport, SpecChangeReport, SpecWriteHooks, WritableSpecKind } from './specs.js';
// authoring_core_adapter and authoring_validator_adapter — every hop out of the
// seam lands on the adapter's own module, which re-exports the provider's
// portal by identity. The seam is a peer of sdd_core and sdd_validator, and a
// peer reaches another subsystem through what that subsystem publishes.
import {
  createChainedSubsystem,
  deleteSpec as coreDeleteSpec,
  loadImplementationSpecs,
  loadProjectConfig,
  loadSpec,
  moveMethods as coreMoveMethods,
  saveSpec,
  updateSpec,
} from './adapters/authoring-core.js';
import { validateComponentCandidate, findTestsReferencing } from './adapters/authoring-validator.js';
import type { TestsToRevisit } from './validation.js';
import { formatCandidateRefusal, type CandidateVerdict } from '../models/candidate.js';
import { resolveNarrativeLabels } from './narrative-labels.js';
import { getProjectRoot } from '../utils/fs.js';

// ---------------------------------------------------------------------------
// The AUTHORING seam — gated spec writes, shared by every access path.
//
// wairon is one backend behind four doors: the local CLI, the local stdio MCP
// server, the hosted web interface, and the hosted MCP/API. Which door you came
// through decides authentication and transport, never behaviour. So a rule about
// what may be written belongs HERE, above the store and above the rule engine,
// where every door reuses it — not in a transport handler, where the next door
// would have to reimplement it and would eventually reimplement it differently.
//
// Every write an AUTHOR makes enters here: a whole spec restated (writeSpec), a
// delta (updateSpecGated), a method move (moveMethods), a delete (deleteSpec).
// Only mechanical writes stay on the store — status promotion at lock, layout
// normalization, migrations, doctor repairs, renames and subproject relocation —
// because they change identity or bookkeeping, not what a spec says.
//
// Layering, and why it is this way round:
//
//   access paths (cli / mcp / hosted http)  ->  authoring  ->  specs + rules
//
// `core/specs.ts` stays a dumb store: core/validation.ts (the rule engine's
// entry point) already reads it, so a store that imported the rule engine
// back would close an import cycle. This module sits above both and owns the
// composition, injecting the gate through SpecWriteHooks. That also keeps
// MECHANICAL writes ungated by construction — status promotion, layout
// normalization, and migrations call the store directly and are unaffected,
// which is what lets a spec authored before a rule existed still load and
// still be repaired.
// ---------------------------------------------------------------------------

/** One spec of any level, as stored and as restated. */
type Spec = SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | ImplementationSpec | TypeSpec;

/**
 * sdd_authoring::SpecRestatement — a whole spec as a create tool states it,
 * together with WHICH fields the tool could state.
 *
 * A create is an upsert: on an existing id it re-authors in place, replacing
 * what the input expresses and carrying forward what it cannot express. The
 * write cannot be judged without knowing the difference between a field left
 * out and a field the door has no way to say — and only the door knows its own
 * input schema, so it passes that knowledge here.
 */
export interface SpecRestatement {
  /** system, subsystem, component, interface, implementation or type. */
  kind: WritableSpecKind;
  /** The spec as the caller stated it, before anything is carried into it. */
  spec: Spec;
  /** The spec-level fields this caller's input can express. */
  fields: string[];
  /** The per-method fields this caller's input can express (interface, implementation). */
  memberFields?: string[];
  /** The lifecycle status the caller stated; absent keeps the stored one, draft for a new spec. */
  status?: SpecStatus;
}

/** sdd_authoring::SpecParent — the spec a restatement cannot be written without. */
export interface SpecParent {
  /** system, subsystem, component or interface. */
  kind: WritableSpecKind;
  /** The parent's id as the child names it; "system" for the L0 singleton. */
  id: string;
}

/** sdd_authoring::SpecRestatementApplication — a restatement applied to the stored spec, before any judgement or write. */
export interface SpecRestatementApplication {
  /** The candidate: carried, createdAt kept, parent-derived fields set, status written. */
  spec: Spec;
  /** The status the candidate is written at; absent for a kind that carries none. */
  status?: SpecStatus;
  /** Set when nothing may be written, as the sentence that says why and how to proceed. */
  refusal?: string;
  /** True when a spec already held the id. */
  replacedExisting: boolean;
  /** What a re-authoring did beyond what the input says; empty for a new spec. */
  notices: string[];
  /** The methods the candidate changes or removes against the stored spec. */
  changedMethods: string[];
}

/** sdd_authoring::SpecDeletion — what a delete answers with, as data. */
export interface SpecDeletion {
  kind: WritableSpecKind;
  id: string;
  /** False when no spec held the id: nothing was removed. */
  deleted: boolean;
  /** The tests that encode a method this deletion removed. */
  testsToRevisit: TestsToRevisit[];
}

/**
 * sdd_authoring::SpecWriteReceipt — what a whole-spec write answers with.
 *
 * A create is an UPSERT, so "added" and "re-authored in place" are two outcomes
 * of the same call; this says which in a field, because a caller that has to
 * read English to find out is a caller that eventually stops checking.
 */
export interface SpecWriteReceipt {
  kind: WritableSpecKind;
  /** The id the spec is stored under; "system" for the L0 singleton. */
  id: string;
  name: string;
  replacedExisting: boolean;
  /** The lifecycle status written; absent for the L0 and a type, which carry none. */
  status?: SpecStatus;
  /** Carried, removed and cleared fields, gate warnings and placement notices — one per entry. */
  notices: string[];
  /** The child project directory a chained subsystem's create scaffolded. */
  scaffoldedProjectPath?: string;
  /** The tests that encode a method this write changed or removed. */
  testsToRevisit: TestsToRevisit[];
}

/**
 * The project's configuration, as the settings a write is judged and reported
 * with: the severity overrides (so `sddRuleSeverity` disarms a gate exactly as
 * it disarms validate), the project type, and — through `rules.conformance` —
 * the test roots a change report searches.
 */
function candidateOptions(): { rules?: RulesConfig; projectType?: string } {
  // The adapter answers null for an uninitialized or unreadable project, so the
  // gate judges at the default severities rather than failing the write closed.
  const config = loadProjectConfig();
  return config ? { rules: config.rules, projectType: config.projectType } : {};
}

/** Intrinsic warnings, as the notice strings the authoring surfaces already return. */
function noticesFrom(verdict: CandidateVerdict): string[] {
  return verdict.warnings.map(w => `${w.code}: ${w.message}`);
}

/**
 * The write-boundary gate for components, as an injectable hook.
 *
 * Judges the MERGED spec, because that is the only form in which the spec the
 * caller will actually get exists — a delta on its own cannot tell you the
 * resulting componentType, and it is the resulting componentType that decides
 * whether a field belongs.
 */
export function componentCandidateGate(
  options: { rules?: RulesConfig; projectType?: string } = candidateOptions(),
  storedOwner?: string,
): SpecWriteHooks {
  return {
    gate: (kind, merged) => {
      refuseUnknownOwner(kind, merged as { subsystem?: string }, storedOwner);
      if (kind !== 'component') return;
      const verdict = validateComponentCandidate(merged as ComponentSpec, options);
      if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
      return noticesFrom(verdict);
    },
  };
}

/**
 * Refuse a component or a type whose owning subsystem a delta CHANGED to one the
 * tree does not have — the same refusal a create gets for an unknown parent. An
 * owner the delta leaves alone is not judged: a spec already pointing at a
 * missing subsystem must still be repairable by the update that fixes it.
 */
function refuseUnknownOwner(kind: WritableSpecKind, merged: { subsystem?: string }, storedOwner?: string): void {
  if (kind !== 'component' && kind !== 'type') return;
  const owner = merged.subsystem;
  if (!owner || owner === storedOwner) return;
  if (loadSpec('subsystem', owner)) return;
  const sentence = MISSING_PARENT[kind]!(owner);
  throw new Error(`${sentence} Nothing was written.`);
}

// ---------------------------------------------------------------------------
// Re-authoring semantics: REPLACE what the input expresses, CARRY what it cannot
//
// Every create tool is an UPSERT: calling it with an id that already exists
// rewrites that spec. Each tool's input is a hand-maintained SUBSET of the
// canonical schema (src/models/specs.ts), so any field the input cannot express
// — lint.allow, ext, a Portal's auth, variant, patterns, externalLinks, the
// system's databases, a method's endpoint — would be erased by a restatement
// that never mentioned it. That loss is silent: the tool answers "Successfully
// added", and a suppressed warning coming back days later is the only tell.
//
// So the write carries forward everything the input does not express, and says
// so. The complementary half matters just as much: for fields the input DOES
// express, replace stays the contract — an author who restates a spec means the
// restatement. But a restatement that empties something is REPORTED, because
// "the array I forgot to repeat is now gone" is precisely the accident this seam
// exists to catch.
//
// The store cannot make this call: it receives a whole spec object and cannot
// distinguish "the caller cleared this" from "the caller never mentioned it".
// Only the door, where an argument is observably absent, can tell those apart —
// so the door states its field list (SpecRestatement.fields) and the rules that
// read it live here, once, for every door.
//
// tests/mcp/schema-field-coverage.test.ts holds the invariant that no canonical
// field escapes this seam: every one is expressed, carried, or store-managed.
// ---------------------------------------------------------------------------

/** Fields the STORE decides on every write — never carried here, never reported. */
const STORE_MANAGED_FIELDS = new Set(['status', 'updatedAt']);

/**
 * Fields carried whenever the input omits them, EVEN THOUGH the input could have
 * expressed them. `ext` is opaque pack/tool data the authoring agent does not own
 * and has no way to know it must restate — the schema promises it is "preserved
 * verbatim", and replace semantics would break that promise on every re-author.
 */
const ALWAYS_CARRIED_FIELDS = new Set(['ext']);

/** The lifecycle statuses, weakest first. */
const STATUS_ORDER: readonly SpecStatus[] = ['draft', 'design', 'complete'];

/** The kinds that carry a lifecycle status; the L0 and a type have none. */
const STATUSED_KINDS: ReadonlySet<WritableSpecKind> = new Set(['subsystem', 'component', 'interface', 'implementation']);

/** The sentence a restatement is refused with when its parent is absent. */
const MISSING_PARENT: Partial<Record<WritableSpecKind, (parentId: string) => string>> = {
  subsystem: () => 'System spec must be initialized (sdd_initialize_system) first.',
  component: (id) => `Parent subsystem "${id}" does not exist.`,
  interface: (id) => `Component "${id}" does not exist.`,
  implementation: (id) => `Interface contract "${id}" does not exist.`,
  type: (id) => `Owning subsystem "${id}" does not exist — name a subsystem the tree has, or omit subsystem for a system-level value object.`,
};

/** How a re-authoring notice names the spec, and what a removed member drags with it. */
const REWRITE_LABEL: Record<WritableSpecKind, string> = {
  system: 'System spec',
  subsystem: 'Subsystem',
  component: 'Component',
  interface: 'Interface',
  implementation: 'Implementation',
  type: 'Type',
};

/**
 * spec_restatement.parent — the spec this one cannot be written without: the
 * L0 for a subsystem, the subsystem a component names, the component an
 * interface names, the contract an implementation names, and the subsystem a
 * type names as its owner. None for the L0 itself and for a type that names no
 * subsystem — a system-level value object belongs to no subsystem, so there is
 * nothing to refuse it for. A type's subsystem is an ownership label rather
 * than a container, but a label naming a subsystem the tree does not have owns
 * the type to nothing, which is the same mistake a component under an unknown
 * subsystem is.
 */
export function restatementParent(restatement: SpecRestatement): SpecParent | null {
  const spec = restatement.spec as Record<string, any>;
  switch (restatement.kind) {
    case 'subsystem':      return { kind: 'system', id: 'system' };
    case 'component':      return { kind: 'subsystem', id: spec.subsystem };
    case 'interface':      return { kind: 'component', id: spec.component };
    case 'implementation': return { kind: 'interface', id: spec.contract };
    case 'type':           return typeof spec.subsystem === 'string' && spec.subsystem !== '' ? { kind: 'subsystem', id: spec.subsystem } : null;
    default:               return null;
  }
}

/**
 * spec_restatement.applyTo — what this restatement becomes over the stored
 * spec, computed without touching disk: the status, the candidate with every
 * unexpressed field carried and createdAt kept, the fields derived from the
 * parent, every narrative *Label resolved, and the notices naming what was
 * carried, removed and cleared. It REFUSES instead when the parent is absent,
 * when the stated status would lower the stored one, or when a label does not
 * resolve. A new spec carries nothing and raises no notices.
 */
export function applyRestatement(
  restatement: SpecRestatement,
  existing: Spec | null,
  parent: SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | null,
): SpecRestatementApplication {
  const replacedExisting = existing !== null;
  const parentRef = restatementParent(restatement);
  if (parentRef && !parent) return refused(restatement, replacedExisting, MISSING_PARENT[restatement.kind]!(parentRef.id));
  const status = statusForCreate(restatement, existing);
  if ('refusal' in status) return refused(restatement, replacedExisting, status.refusal);

  const candidate = JSON.parse(JSON.stringify(restatement.spec)) as Record<string, any>;
  if (restatement.kind === 'subsystem') candidate.parentSystem = (parent as SystemSpec).name;
  const carried = carryInto(restatement, existing, candidate);
  const cleared = clearedByOmission(existing, candidate, restatement.fields);
  stampLifecycle(candidate, existing, status.status);

  const labelErrors = resolveLabelsOf(restatement.kind, candidate);
  if (labelErrors.length) {
    return refused(restatement, replacedExisting, `Unresolved narrative label references — nothing was saved:\n- ${labelErrors.join('\n- ')}`);
  }
  const parsed = parseCandidate(restatement.kind, candidate);
  if ('refusal' in parsed) return refused(restatement, replacedExisting, parsed.refusal);
  return {
    spec: parsed.spec,
    ...(status.status ? { status: status.status } : {}),
    replacedExisting,
    notices: existing ? rewriteNotices(restatement.kind, existing, candidate, carried, cleared) : [],
    changedMethods: changedMethodsOf(restatement.kind, existing, candidate),
  };
}

/** The canonical schema each writable kind is stored through. */
const SPEC_SCHEMA = {
  system: SystemSpecSchema,
  subsystem: SubsystemSpecSchema,
  component: ComponentSpecSchema,
  interface: InterfaceSpecSchema,
  implementation: ImplementationSpecSchema,
  type: TypeSpecSchema,
} as const;

/**
 * The candidate parsed through its kind's canonical schema, so a NEW spec
 * arrives with the defaults for every list and flag the door did not state —
 * a door that states only the fields it owns gets the same spec as one that
 * states everything — or the refusal naming what does not parse.
 *
 * The candidate is in LOAD form: an id reference inside a chained subproject
 * is namespace-qualified (`billing::invoice_portal`), which the writer schema
 * refuses because the store relativizes it on the way to disk. So every string
 * carrying `::` is masked with a token the id schema accepts for the parse and
 * restored afterwards: the parse judges the shape and fills the defaults, and
 * never rewrites a reference the store still has to relativize.
 */
function parseCandidate(kind: WritableSpecKind, candidate: Record<string, unknown>): { spec: Spec } | { refusal: string } {
  const masked = new Map<string, string>();
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (!value.includes('::')) return value;
      const token = `nsref_${masked.size}_masked`;
      masked.set(token, value);
      return token;
    }
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v)]));
    return value;
  };
  const restore = (value: unknown): unknown => {
    if (typeof value === 'string') return masked.get(value) ?? value;
    if (Array.isArray(value)) return value.map(restore);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]));
    return value;
  };
  const result = SPEC_SCHEMA[kind].safeParse(mask(candidate));
  if (result.success) return { spec: restore(result.data) as Spec };
  const id = kind === 'system' ? 'system' : String(candidate.id);
  const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
  return {
    refusal: `Refusing to write ${kind} "${id}": the spec it would become does not parse — ${issues}. `
      + 'Nothing was written. State the missing or malformed field and call again.',
  };
}

/** An application that may not be written, carrying the sentence that says why. */
function refused(restatement: SpecRestatement, replacedExisting: boolean, refusal: string): SpecRestatementApplication {
  return { spec: restatement.spec, refusal, replacedExisting, notices: [], changedMethods: [] };
}

/**
 * The status the restatement WRITES — the one the spec will actually hold — or
 * the refusal that stops it.
 *
 * `status` absent answers the status already stored, or 'draft' for a spec that
 * does not exist yet: a new spec is born draft and a re-authored one keeps what
 * it had. A stated status is written as stated, unless it would take the spec
 * backwards, which is refused by name rather than applied or silently ignored —
 * the store cannot tell a stated 'draft' from a default one, so only this seam
 * can hold that a restatement never reopens a frozen spec. A kind without a
 * lifecycle status answers none.
 */
function statusForCreate(
  restatement: SpecRestatement,
  existing: Spec | null,
): { status?: SpecStatus } | { refusal: string } {
  if (!STATUSED_KINDS.has(restatement.kind)) return {};
  const stated = restatement.status;
  // A stored status the lifecycle does not know (a legacy value) is no status
  // to keep and none to be lowered from: it reads as "nothing held".
  const stored = (existing as { status?: SpecStatus } | null)?.status;
  const held = stored !== undefined && STATUS_ORDER.includes(stored) ? stored : undefined;
  if (stated === undefined) return { status: held ?? 'draft' };
  if (held === undefined || STATUS_ORDER.indexOf(stated) >= STATUS_ORDER.indexOf(held)) return { status: stated };
  const label = `${restatement.kind} "${(restatement.spec as { id: string }).id}"`;
  return {
    refusal:
      `Refusing to re-author ${label} at status "${stated}": it is stored at "${held}", and a create tool `
      + 'never lowers a spec\'s status — a restatement that reopened a frozen spec would undo a lock without '
      + `saying so. Nothing was written. To reopen it deliberately, use sdd_update_spec with `
      + `{"status": "${stated}"}; to keep the level it has, leave status out.`,
  };
}

/**
 * Carry every unexpressed field from the stored spec into the candidate — per
 * method first, keyed by name, when the door states its member fields — and
 * answer with the carried names in the order a reader wants them: createdAt,
 * then each method's, then the spec's own.
 */
function carryInto(restatement: SpecRestatement, existing: Spec | null, candidate: Record<string, any>): string[] {
  if (!existing) return [];
  const carried: string[] = ['createdAt'];
  if (restatement.memberFields && Array.isArray(candidate.methods)) {
    const stored: Record<string, unknown>[] = (existing as { methods?: Record<string, unknown>[] }).methods ?? [];
    for (const method of candidate.methods as Record<string, unknown>[]) {
      const prev = stored.find((p) => p.name === method.name);
      for (const field of carryUnexpressed(prev, method, restatement.memberFields)) carried.push(`${field} (${String(method.name)})`);
    }
  }
  // createdAt is kept by stampLifecycle and named first above, never carried as data.
  carried.push(...carryUnexpressed(existing as Record<string, unknown>, candidate, [...restatement.fields, 'createdAt']));
  return carried;
}

/**
 * Copy every field the input cannot express from the previous version onto the
 * spec about to be written. MUTATES `next`; returns the carried field names.
 * Driven by the door's own field list, so a field added to a tool starts being
 * replaced, and a field added only to the canonical schema starts being carried.
 */
function carryUnexpressed(
  existing: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
  expressed: readonly string[],
): string[] {
  if (!existing) return [];
  const carried: string[] = [];
  for (const [field, value] of Object.entries(existing)) {
    if (value === undefined) continue;
    if (STORE_MANAGED_FIELDS.has(field)) continue;
    if (expressed.includes(field) && !ALWAYS_CARRIED_FIELDS.has(field)) continue;
    if (next[field] !== undefined) continue;
    next[field] = value;
    carried.push(field);
  }
  return carried;
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * Expressed fields this restatement emptied. Never rewrites anything — replace
 * is the contract for what the input CAN say; this only makes the loss visible.
 */
function clearedByOmission(
  existing: Spec | null,
  next: Record<string, unknown>,
  expressed: readonly string[],
): string[] {
  if (!existing) return [];
  const stored = existing as Record<string, unknown>;
  const cleared: string[] = [];
  for (const field of expressed) {
    const before = stored[field];
    if (STORE_MANAGED_FIELDS.has(field) || ALWAYS_CARRIED_FIELDS.has(field)) continue;
    if (isEmptyValue(before) || !isEmptyValue(next[field])) continue;
    cleared.push(Array.isArray(before) ? `${field} (had ${before.length})` : field);
  }
  return cleared;
}

/** createdAt kept from the stored spec, updatedAt now, and the resolved status written. */
function stampLifecycle(candidate: Record<string, any>, existing: Spec | null, status: SpecStatus | undefined): void {
  const now = new Date().toISOString();
  candidate.createdAt = existing?.createdAt ?? now;
  candidate.updatedAt = now;
  if (status) candidate.status = status;
  else delete candidate.status;
}

/**
 * method_implementation.resolveLabels over every method of an implementation:
 * symbolic *Label references resolve to step numbers IN PLACE before the spec
 * is saved, and whatever does not resolve is answered so the whole write can
 * be refused.
 */
function resolveLabelsOf(kind: WritableSpecKind, candidate: Record<string, any>): string[] {
  if (kind !== 'implementation') return [];
  const methods = (candidate.methods ?? []) as { name: string; narrative?: Record<string, any>[] }[];
  return methods.flatMap((m) => resolveNarrativeLabels(m.name, m.narrative ?? []));
}

/** Named members present before and absent now — methods dropped by a restatement. */
function removedByName(
  before: ReadonlyArray<{ name: string }> | undefined,
  after: ReadonlyArray<{ name: string }> | undefined,
): string[] {
  if (!before?.length) return [];
  const kept = new Set((after ?? []).map((m) => m.name));
  return before.map((m) => m.name).filter((n) => !kept.has(n));
}

/**
 * The re-authoring notices, in the order a reader wants them: what happened,
 * what survived, what was deleted, what was emptied.
 */
function rewriteNotices(
  kind: WritableSpecKind,
  existing: Spec,
  candidate: Record<string, any>,
  carried: string[],
  cleared: string[],
): string[] {
  const named = kind === 'system' ? (existing as SystemSpec).name : String(candidate.id);
  const notices = [`${REWRITE_LABEL[kind]} "${named}" already existed — re-authored in place; this input REPLACES what it expresses.`];
  if (carried.length) notices.push(`Carried forward (not expressible through this tool): ${carried.join(', ')}.`);
  const removal = removalNotice(kind, existing, candidate);
  if (removal) notices.push(removal);
  if (cleared.length) {
    notices.push(
      `CLEARED by omission: ${cleared.join(', ')} — the argument was not repeated, so the previous value is gone. `
      + 'Use sdd_update_spec if you meant to leave it untouched.',
    );
  }
  return notices;
}

/** The members a restatement removed, as the one notice that names them — or none. */
function removalNotice(kind: WritableSpecKind, existing: Spec, candidate: Record<string, any>): string | undefined {
  const before = existing as { methods?: { name: string }[]; fields?: { name: string }[] };
  let removed: string[] = [];
  let noun = 'method';
  let suffix = '';
  if (kind === 'interface' || kind === 'implementation') {
    removed = removedByName(before.methods, candidate.methods);
    suffix = kind === 'interface' ? ' (endpoint bindings included)' : ' (L5 narratives included)';
  } else if (kind === 'type') {
    removed = [
      ...removedByName(before.fields, candidate.fields).map((n) => `field ${n}`),
      ...removedByName(before.methods, candidate.methods).map((n) => `method ${n}`),
    ];
    noun = 'member';
  }
  if (!removed.length) return undefined;
  return `REMOVED by this restatement: ${removed.length === 1 ? noun : `${noun}s`} ${removed.map((n) => `"${n}"`).join(', ')}`
    + `${suffix} — absent from the input, so no longer in the spec. `
    + 'Restate them to keep them, or use sdd_update_spec to edit one member at a time.';
}

/** The canonical schema a method of each kind is stored through — what "unchanged" is judged in. */
const METHOD_SCHEMA = {
  interface: MethodSignatureSchema,
  implementation: MethodImplementationSchema,
  type: TypeMethodSchema,
} as const;

/**
 * The methods the candidate changes or removes against the stored spec — the
 * subject of the tests-to-revisit search. A candidate method is read through the
 * same schema the stored one was, so a restatement that says the same thing in
 * a different shape (a key left undefined, a default spelled out) is no change.
 */
function changedMethodsOf(kind: WritableSpecKind, existing: Spec | null, candidate: Record<string, any>): string[] {
  if (!existing || !(kind in METHOD_SCHEMA)) return [];
  const schema = METHOD_SCHEMA[kind as keyof typeof METHOD_SCHEMA];
  const stored = ((existing as { methods?: { name: string }[] }).methods ?? []);
  const next = (candidate.methods ?? []) as { name: string }[];
  return stored
    .filter((method) => {
      const restated = next.find((m) => m.name === method.name);
      if (!restated) return true;
      const parsed = schema.safeParse(restated);
      return !parsed.success || canonical(parsed.data) !== canonical(method);
    })
    .map((method) => method.name);
}

/** A value as a key-sorted string with undefined dropped — equality that ignores spelling. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/**
 * Write a whole spec as a create tool states it, at any level, through the gate
 * (authoring_orchestrator.writeSpec; the portal method is this same function).
 *
 * On an existing id it re-authors in place: what the input expresses is
 * replaced, what it cannot express is carried and named, what an omission
 * cleared and a restatement removed is named, and the stored status is never
 * lowered. A refused status, a missing parent, an unresolved label or an
 * intrinsic error throws before anything touches disk. The receipt carries the
 * tests a changed or removed method invalidated — a contract redefined through
 * a create invalidates its tests exactly as the same change through a delta.
 */
export function writeSpec(restatement: SpecRestatement): SpecWriteReceipt {
  // Step 1: the settings a component is judged with, and the test roots.
  const bound = candidateOptions();
  // Steps 2-4: the parent the restatement cannot be written without.
  const parentRef = restatementParent(restatement);
  const parent = parentRef ? loadSpec(parentRef.kind, parentRef.id) : null;
  // Step 5: the spec this restatement re-authors, if one holds the id.
  const id = restatement.kind === 'system' ? 'system' : (restatement.spec as { id: string }).id;
  const existing = loadSpec(restatement.kind, id);
  // Step 6: what the restatement becomes over it.
  const application = applyRestatement(restatement, existing, parent as SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | null);
  // Steps 7-8: a refusal stops the write before anything reaches disk.
  if (application.refusal !== undefined) throw new Error(application.refusal);
  // Steps 9-12: the intrinsic judgement, for the one kind judged at the boundary.
  const gateNotices = restatement.kind === 'component' ? judgeComponent(application.spec as ComponentSpec, bound) : [];
  // Steps 13-16: to disk — scaffolding a chained subsystem's child project.
  const persisted = persistCandidate(restatement.kind, application.spec);
  // Steps 17-19: the tests this write invalidated, each placed in its file.
  const testsToRevisit = testsInvalidatedBy(restatement.kind, id, application.changedMethods, [existing, application.spec], bound);
  // Step 20: the receipt.
  return {
    kind: restatement.kind,
    id,
    name: (application.spec as { name: string }).name,
    replacedExisting: application.replacedExisting,
    ...(application.status ? { status: application.status } : {}),
    notices: [...gateNotices, ...persisted.notices, ...application.notices],
    ...(persisted.scaffoldedProjectPath ? { scaffoldedProjectPath: persisted.scaffoldedProjectPath } : {}),
    testsToRevisit,
  };
}

/**
 * Judge a component candidate — the spec that will actually be written, carried
 * fields included, so retyping a Portal carries its auth into the judgement
 * instead of letting it vanish unseen. Throws the formatted refusal on an error;
 * answers the warnings as notices.
 */
function judgeComponent(candidate: ComponentSpec, options: { rules?: RulesConfig; projectType?: string }): string[] {
  const verdict = validateComponentCandidate(candidate, options);
  if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
  return noticesFrom(verdict);
}

/** Persist the candidate: a chained subsystem with its child project, anything else through the store. */
function persistCandidate(kind: WritableSpecKind, spec: Spec): { notices: string[]; scaffoldedProjectPath?: string } {
  const projectPath = kind === 'subsystem' ? (spec as SubsystemSpec).projectPath : undefined;
  if (projectPath && projectPath.trim() !== '') {
    createChainedSubsystem(spec as SubsystemSpec, (spec as SubsystemSpec).name);
    return { notices: [], scaffoldedProjectPath: projectPath };
  }
  return { notices: saveSpec(kind, spec) };
}

/**
 * The tests that encode the named methods, when the project declares test roots.
 * Each method is searched by the code name and in the file that realize it
 * (searchedMethods), so a test importing a same-named function from another
 * module is not one of its tests (F75).
 */
function testsInvalidatedBy(
  kind: WritableSpecKind,
  id: string,
  methods: string[],
  specs: (Spec | null)[],
  options: { rules?: RulesConfig },
  written: Record<string, any>[] = [],
): TestsToRevisit[] {
  const testRoots = options.rules?.conformance?.testRoots ?? [];
  if (methods.length === 0 || testRoots.length === 0) return [];
  return findTestsReferencing(searchedMethods(kind, id, methods, specs, written), getProjectRoot(), testRoots);
}

/** A spec's methods as the search reads them — every kind that has any names them the same way. */
type SearchedMethod = Pick<MethodImplementation, 'name' | 'symbol' | 'sourcePath'>;

/**
 * Each method as the test search needs it: the code name it is realized under
 * and the file realizing it. For an implementation or a type, the method's own
 * entry in the given specs — the stored one before the restated one — its
 * `symbol`, and its own sourcePath, else the spec's. For a contract, every
 * implementation realizing it that carries the method, each with the symbol
 * and file it realizes the method under, since a contract method's tests
 * import the realization. A code name the write itself states (a delta's
 * `symbol`) wins. A method no spec places in a file is searched by name alone,
 * exactly as every method was before the search learned modules.
 */
function searchedMethods(
  kind: WritableSpecKind,
  id: string,
  names: string[],
  specs: (Spec | null)[],
  written: Record<string, any>[],
): SearchedMethod[] {
  const stated = (name: string): string | undefined => written.find((m) => m?.name === name)?.symbol;
  if (kind === 'interface') {
    const realizations = loadImplementationSpecs().filter((impl) => impl.contract === id);
    return names.flatMap((name) => {
      const found: SearchedMethod[] = realizations.flatMap((impl) => impl.methods
        .filter((m) => m.name === name)
        .map((m) => ({ name, symbol: stated(name) ?? m.symbol, sourcePath: m.sourcePath ?? impl.sourcePath })));
      return found.length > 0 ? found : [{ name, symbol: stated(name) }];
    });
  }
  return names.map((name) => {
    const holders = specs
      .map((spec) => {
        const holder = spec as { sourcePath?: string; methods?: { name: string; symbol?: string; sourcePath?: string }[] } | null;
        const method = holder?.methods?.find((m) => m.name === name);
        return method ? { method, file: method.sourcePath ?? holder?.sourcePath } : null;
      })
      .filter((h): h is NonNullable<typeof h> => h !== null);
    const symbol = stated(name) ?? holders.map((h) => h.method.symbol).find((s) => s !== undefined);
    // A method no given spec holds yet (a delta adding it) is realized in the
    // spec's own default file, when the spec names one.
    const sourcePath = holders.map((h) => h.file).find((f) => f !== undefined)
      ?? specs.map((spec) => (spec as { sourcePath?: string } | null)?.sourcePath).find((f) => f !== undefined);
    return { name, symbol, sourcePath };
  });
}

/**
 * Delete one spec of the named kind and report the tests that encode a method
 * the deletion took away (authoring_orchestrator.deleteSpec; the portal method
 * is this same function). Deleting a contract or an implementation removes
 * every method it held, which invalidates their tests exactly as removing one
 * method by delta does. The L0 cannot be deleted.
 */
export function deleteSpec(kind: WritableSpecKind, id: string): SpecDeletion {
  // Step 1: the test roots the report searches.
  const bound = candidateOptions();
  // Step 2: the spec about to be removed, for the methods it takes with it.
  const stored = loadSpec(kind, id);
  // Step 3: the delete itself.
  const deleted = coreDeleteSpec(kind, id);
  // Steps 4-6: the tests the removed methods invalidated, each placed in its file.
  const methods = deleted ? ((stored as { methods?: { name: string }[] } | null)?.methods ?? []).map((m) => m.name) : [];
  const testsToRevisit = testsInvalidatedBy(kind, id, methods, [stored], bound);
  // Step 7.
  return { kind, id, deleted, testsToRevisit };
}

/**
 * Patch an existing spec through the same gate. An update can introduce a
 * misplaced field just as easily as a create can — and unlike a create, it can
 * also change the componentType out from under fields that were legal before.
 *
 * Answers with a SpecChangeReport: exactly what changed, which of the delta's
 * paths changed nothing, or that nothing did and nothing was written. A caller
 * that cannot tell those apart eventually ships an edit it never made.
 *
 * `dryRun` runs the whole write, this gate included, and answers with the report
 * it would have produced without touching disk — so "what will this delta do to
 * a 200-step narrative" is a question that can be asked before it is answered
 * by the file.
 *
 * A write that changed or deleted a METHOD also names the tests that encode it,
 * when the project declares test roots. The change that creates the collision
 * is the one that reports it: a spec pass that rewrites a contract and says
 * nothing is how a brief comes to promise green tests it has already broken.
 */
export function updateSpecGated(
  kind: WritableSpecKind,
  id: string,
  delta: Record<string, any>,
  dryRun?: boolean,
): SpecChangeReport {
  // Step 1: the bound project's configuration — the severities and project
  // type the judgement uses, and the test roots the report searches. A project
  // that has none is judged on the defaults and searches nothing.
  const bound = candidateOptions();
  // Step 2: the spec as it stands — the owner the judgement compares against,
  // and, when a test search may follow, a method the delta deletes placed in
  // its file and named by its code name, which only the version that still
  // held it can answer.
  const testRoots = bound.rules?.conformance?.testRoots ?? [];
  const stored = loadSpec(kind, id);
  // Step 3: the judgement as a write hook over those same settings.
  const gate = componentCandidateGate(bound, (stored as { subsystem?: string } | null)?.subsystem);
  // Step 4: apply the delta with the hook injected, so the judgement runs on
  // the merged spec at the last point before anything reaches disk.
  const report = updateSpec(kind, id, delta, gate, dryRun);

  // Step 5: did this write invalidate any test?
  const changed = changedMethods(report);
  if (changed.length > 0 && testRoots.length > 0) {
    // Steps 6-7: search them by the code name and the file realizing each.
    const written: Record<string, any>[] = Array.isArray(delta?.methods) ? delta.methods : [];
    report.testsToRevisit = testsInvalidatedBy(kind, id, changed, [stored], bound, written);
  }

  // Step 8.
  return report;
}

/**
 * The methods this write changed or deleted — the search's subject.
 *
 * The change report addresses them by PATH (`methods.<name>`, and everything
 * under it), which is the one place both a rewritten method and a deleted one
 * appear. Their code name and file come from the spec as it stood and from
 * what the delta states (searchedMethods).
 */
function changedMethods(report: SpecChangeReport): string[] {
  const named = new Set<string>();
  for (const change of report.changes) {
    const [field, name] = change.path.split('.');
    if (field === 'methods' && name) named.add(name);
  }
  return [...named];
}

/**
 * The write-boundary judgement for a METHOD MOVE, with both halves.
 *
 * `gate` refuses the resulting components at the write boundary exactly as the
 * candidate gate does. `assess` answers the same question about a candidate
 * home WITHOUT throwing, so the store — which holds the tree and can enumerate
 * the candidates — can rank them instead of driving a search on caught
 * exceptions.
 *
 * Beyond the intrinsic rules it reads the project's dependency ceiling, because
 * that is the rule a move actually trips: a method moves with the collaborators
 * its narrative calls, and the natural home is regularly the component that
 * cannot afford them. The SOURCE is exempt from the ceiling — a component that
 * already exceeds it must still be able to give methods away, and refusing that
 * would lock exactly the component this feature exists to relieve.
 */
export function methodMoveGate(source: string): SpecWriteHooks {
  // The config read sits HERE, in the builder's own body, so the orchestrator's
  // step 1 (authoring_core_adapter.loadProjectConfig) is a call this file's
  // reader can actually see. Hiding it inside the returned closures — the shape
  // componentCandidateGate uses, which claims no config read — would leave that
  // step claiming a call nothing realizes.
  const bound = candidateOptions();
  return {
    gate: (kind, merged) => {
      if (kind !== 'component') return;
      const { codes, verdict, ceiling } = judgeMoveHome(merged as ComponentSpec, source, bound);
      if (codes.length === 0) return noticesFrom(verdict);
      throw new Error(
        `${codes.join(', ')} refuses "${(merged as ComponentSpec).id}" as the home for these methods. `
        + (verdict.errors.length
          ? formatCandidateRefusal(verdict)
          : `It would reach ${(merged as ComponentSpec).dependsOn?.length ?? 0} dependencies against a ceiling of ${ceiling}.`),
      );
    },
    assess: (kind, merged) => (kind === 'component' ? judgeMoveHome(merged as ComponentSpec, source, bound).codes : []),
  };
}

/**
 * The rule codes that refuse one component as a home for the moved methods,
 * with the verdict they came from — the one judgement both halves of the hook
 * answer with, so `gate` and `assess` can never disagree about the same spec.
 */
function judgeMoveHome(
  component: ComponentSpec,
  source: string,
  options: { rules?: RulesConfig; projectType?: string },
): { codes: string[]; verdict: CandidateVerdict; ceiling?: number } {
  const ceiling = options.rules?.complexity?.maxComponentDependencies;
  const verdict = validateComponentCandidate(component, options);
  const codes = verdict.errors.map((e) => e.code);
  if (component.id !== source && ceiling !== undefined && (component.dependsOn?.length ?? 0) > ceiling) {
    codes.push('EXCESSIVE_DEPENDENCIES');
  }
  return { codes: [...new Set(codes)], verdict, ceiling };
}

/**
 * Move methods from one component to another as ONE gated write.
 *
 * The judgement is the point. A rename changes identity and can stay
 * mechanical; a move changes which component owns behaviour, which is exactly
 * what the stereotype and dependency rules judge. On a refusal nothing is
 * written and the report names the rule plus where the methods could live
 * instead — because a refusal that only names the rule leaves the caller to
 * search for a legal home by hand, which is the hand labour this replaces.
 */
export function moveMethods(
  from: string,
  to: string,
  methods: string[],
  dryRun?: boolean,
): MethodMoveReport {
  return coreMoveMethods(from, to, methods, methodMoveGate(from), dryRun);
}
