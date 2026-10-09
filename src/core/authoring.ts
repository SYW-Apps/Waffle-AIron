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
  deriveMethodSignature,
  storedMethodSignature,
  storedTypeMethod,
  type StoredInterfaceSpec,
  type StoredTypeSpec,
  type ComponentSpec,
  type ImplementationSpec,
  type InterfaceSpec,
  type MethodImplementation,
  type SpecStatus,
  type SubsystemSpec,
  type SystemSpec,
  type TypeSpec,
  specIndexRetiredBy,
  specIndexReferencesTo,
  specIndexSubtreeOf,
  specIndexMethodReferences,
  type SpecRef,
  type SpecReference,
} from '../models/specs.js';
import {
  interfaceCanonicalTypes,
  typeCanonicalTypes,
  type TypeCanonicalization,
  type TypeExpressionProblem,
  type TypeRespelling,
} from '../models/type-grammar.js';
import { fitsMethodCasing, methodCasingFor, type RulesConfig } from '../models/project.js';
import { identifierProblem, reservedWordProblem } from '../models/identifiers.js';
import type { MethodMoveReport, SpecChangeReport, SpecIndex, SpecWriteHooks, WritableSpecKind } from './specs.js';
import type { SpecMove } from './provision.js';
import type { ExportUse } from '../models/exports.js';
import type { ExternalConsumer } from '../models/project-family.js';
import { qualifiedTypeId } from '../models/type-references.js';
// authoring_core_adapter and authoring_validator_adapter — every hop out of the
// seam lands on the adapter's own module, which re-exports the provider's
// portal by identity. The seam is a peer of sdd_core and sdd_validator, and a
// peer reaches another subsystem through what that subsystem publishes.
import {
  crossProjectWriteRefusal,
  deleteSpec as coreDeleteSpec,
  loadComponentSpecs,
  loadImplementationSpecs,
  loadProjectConfig,
  loadSpec,
  moveMethods as coreMoveMethods,
  moveSpec as coreMoveSpec,
  publishedUsesOf,
  saveSpec,
  scanAllSpecs,
  updateSpec,
} from './adapters/authoring-core.js';
import { validateComponentCandidate, introducedFindings, findTestsReferencing, implementsProblem } from './adapters/authoring-validator.js';
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
  /** Answer what the write would do — refused exactly as the write would be — and write nothing. */
  dryRun?: boolean;
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
  /** Each type position of the candidate whose written text was an alias, now holding its canonical spelling. */
  respellings: TypeRespelling[];
}

/** sdd_authoring::SpecDeletion — what a delete answers with, as data. */
export interface SpecDeletion {
  kind: WritableSpecKind;
  id: string;
  /** True when the spec and its subtree were removed; false on a dry run and when no spec held the id. */
  deleted: boolean;
  /** True when the caller asked only for the plan: nothing was removed. */
  dryRun: boolean;
  /** Every spec the deletion removes (or would), innermost first and the addressed spec last. */
  removed: SpecRef[];
  /** Every reference a spec outside the removed set holds to it: what a forced deletion leaves dangling. */
  references: SpecReference[];
  /** The tests that encode a method this deletion removed. */
  testsToRevisit: TestsToRevisit[];
  /**
   * Every public name of the bound project's export tables a consumer reaches
   * what the deletion removes through, read before anything goes. Empty when
   * nothing removed is published.
   */
  published: ExportUse[];
  /** The consumers whose specs reach a published name on a member it carries. Filled by the door that read them. */
  breaks?: ExternalConsumer[];
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
  /**
   * Each type position the write normalised: what the input wrote against the
   * canonical spelling stored. Aliases are accepted, never refused; this list
   * is how an author learns the canonical form. Empty when every position was
   * already canonical.
   */
  respellings: TypeRespelling[];
  /** The tests that encode a method this write changed or removed. */
  testsToRevisit: TestsToRevisit[];
  /** True when the caller asked what the write would do: every judgement ran and nothing was written. */
  dryRun?: boolean;
  /** Each implementation method entry a contract restatement removed with a method it dropped, as `<implementation>.<method>`. */
  cascaded?: string[];
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

/**
 * Intrinsic warnings and notices, as the notice strings the authoring surfaces
 * already return. A notice-severity finding says so, so it is never read as a
 * warning.
 */
function noticesFrom(verdict: CandidateVerdict): string[] {
  return [
    ...verdict.warnings.map(w => `${w.code}: ${w.message}`),
    ...verdict.notices.map(n => `${n.code} (notice): ${n.message}`),
  ];
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
  stored?: Spec | null,
): SpecWriteHooks {
  return {
    gate: (kind, merged) => {
      refuseUnknownOwner(kind, merged as { subsystem?: string }, storedOwner);
      // The merge is over the spec as STORED, so a sourced method carries only
      // its source: params or returns beside it are ones the delta stated.
      const restated = kind === 'interface' ? restatedSources((merged as { methods?: unknown }).methods) : [];
      if (restated.length) throw new Error(`${restatedSourceRefusal(String((merged as { id?: string }).id), restated)} Nothing was written.`);
      // A type position the delta WROTE that is not canonical is refused; one
      // the stored spec already held is not judged, so it stays repairable.
      const written = deltaWrittenTypeProblems(kind, merged, stored ?? null);
      if (written.length) throw new Error(`${typeProblemRefusal(kind, String((merged as { id?: string }).id), written)} Nothing was written.`);
      // A method, parameter or field name the delta introduced, judged as writeSpec judges one.
      const names = introducedNameProblems(kind, merged, stored ?? null);
      if (names.length) throw new Error(nameRefusal(kind, String((merged as { id?: string }).id), names));
      if (kind !== 'component' && kind !== 'interface') return;
      const notices: string[] = [];
      if (kind === 'component') {
        const verdict = validateComponentCandidate(merged as ComponentSpec, options);
        if (verdict.errors.length) throw new Error(formatCandidateRefusal(verdict));
        notices.push(...noticesFrom(verdict));
      }
      // The doctrine edges and route collisions the merged spec introduces in its tree.
      return [...notices, ...judgeInTree(kind, merged as ComponentSpec | InterfaceSpec, options)];
    },
  };
}

/** A method as the name check reads it: its name and its parameters' names. */
interface NamedMethod { name?: unknown; params?: { name?: unknown }[] }

/**
 * writeSpec steps 13-16 and the update hook: every method, parameter and field
 * name an interface or a type candidate INTRODUCES — one the stored spec does
 * not already hold, so a spec carrying an older name can still be edited —
 * judged by the identifier grammar (identifier.problemAs), the target
 * language's reserved words (identifier.reservedIn), uniqueness in its place,
 * and, for a new contract method of a contract that implements no other
 * project's extension point, the tree's method casing — exactly what the
 * rename tools refuse, so define and rename accept the same names. Answers one
 * sentence per problem; empty when every name is acceptable.
 */
function introducedNameProblems(kind: WritableSpecKind, candidate: unknown, stored: Spec | null): string[] {
  if ((kind !== 'interface' && kind !== 'type') || !candidate || typeof candidate !== 'object') return [];
  const spec = candidate as { component?: string; subsystem?: string; implements?: string; methods?: NamedMethod[]; fields?: { name?: unknown }[] };
  const held = stored as { methods?: NamedMethod[]; fields?: { name?: unknown }[] } | null;
  // Step 14: the effective target language and the method casing of the tree.
  const owner = kind === 'interface' ? (spec.component ? (loadSpec('component', spec.component) as ComponentSpec | null)?.subsystem : undefined) : spec.subsystem;
  const language = ((owner ? (loadSpec('subsystem', owner) as SubsystemSpec | null)?.targetLanguage : undefined)
    ?? (loadSpec('system', 'system') as SystemSpec | null)?.targetLanguage)?.trim().toLowerCase() || undefined;
  const casing = methodCasingFor(loadProjectConfig()?.rules?.naming, language);
  const problems: string[] = [];
  const judge = (name: unknown, what: 'method' | 'param' | 'field', where: string, isNew: boolean): void => {
    if (typeof name !== 'string' || !isNew) return;
    const problem = identifierProblem(name, what) ?? reservedWordProblem(name, what, language, casing);
    if (problem) problems.push(`${where}: ${problem}`);
  };
  const duplicates = (names: unknown[], where: string): void => {
    const seen = new Set<string>();
    for (const n of names) {
      if (typeof n !== 'string') continue;
      if (seen.has(n)) problems.push(`${where}: "${n}" is declared twice — a lookup by name would bind one of them at random`);
      seen.add(n);
    }
  };
  // Step 15: methods (with their parameters) and fields, each against the stored one of its name.
  const methods = Array.isArray(spec.methods) ? spec.methods : [];
  duplicates(methods.map((m) => m?.name), `${kind} "${(candidate as { id?: string }).id}"`);
  for (const m of methods) {
    const before = held?.methods?.find((h) => h?.name === m?.name);
    judge(m?.name, 'method', `method "${String(m?.name)}"`, !before);
    if (kind === 'interface' && !before && spec.implements === undefined && typeof m?.name === 'string'
      && identifierProblem(m.name, 'method') === null && !fitsMethodCasing(m.name, casing)) {
      problems.push(`method "${m.name}": not an identifier in this tree's method casing (${casing}) — sdd_rename_method refuses it the same way`);
    }
    const params = Array.isArray(m?.params) ? m.params : [];
    duplicates(params.map((p) => p?.name), `the parameters of method "${String(m?.name)}"`);
    for (const p of params) judge(p?.name, 'param', `parameter "${String(p?.name)}" of method "${String(m?.name)}"`, !before?.params?.some((h) => h?.name === p?.name));
  }
  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  duplicates(fields.map((f) => f?.name), `the fields of type "${(candidate as { id?: string }).id}"`);
  for (const f of fields) judge(f?.name, 'field', `field "${String(f?.name)}"`, !held?.fields?.some((h) => h?.name === f?.name));
  return problems;
}

/** The sentence a name problem is refused with (invalid-name). */
function nameRefusal(kind: WritableSpecKind, id: string, problems: string[]): string {
  return `invalid-name: ${kind} "${id}" introduces ${problems.length === 1 ? 'a name' : 'names'} the tree cannot hold — ${problems.join('; ')}. Nothing was written.`;
}

/** An interface's or a type's type positions read under the grammar; null for any other kind. */
function canonicalTypesOf(kind: WritableSpecKind, spec: unknown): TypeCanonicalization<unknown> | null {
  if (!spec || typeof spec !== 'object') return null;
  if (kind === 'interface') return interfaceCanonicalTypes(spec as StoredInterfaceSpec);
  if (kind === 'type') return typeCanonicalTypes(spec as StoredTypeSpec);
  return null;
}

/**
 * The type positions of a merged spec that are not canonical and that the
 * delta wrote: every problem the merged spec holds that the stored spec does
 * not hold at the same path with the same text.
 */
function deltaWrittenTypeProblems(kind: WritableSpecKind, merged: unknown, stored: Spec | null): TypeExpressionProblem[] {
  const now = canonicalTypesOf(kind, merged)?.problems ?? [];
  if (now.length === 0) return [];
  const before = new Set((canonicalTypesOf(kind, stored)?.problems ?? []).map((p) => `${p.path}|${p.written}`));
  return now.filter((p) => !before.has(`${p.path}|${p.written}`));
}

/**
 * The sentence a non-canonical type position is refused with: each position,
 * its code, what is wrong and what to write instead. Aliases are never here:
 * they are respelled and reported, not refused.
 */
function typeProblemRefusal(kind: WritableSpecKind, id: string, problems: TypeExpressionProblem[]): string {
  const lines = problems.map((p) => `${p.code} at ${p.path}: ${p.detail}${p.replacement ? ` — write ${p.replacement} instead` : ''}.`);
  return `Refusing to write ${kind} "${id}": ${problems.length === 1 ? 'a type position is' : `${problems.length} type positions are`} not in the `
    + `neutral type grammar. ${lines.join(' ')} Aliases (string[], T | null, boolean, Promise<T>, ...) are accepted and `
    + 'respelled; these forms have no canonical spelling.';
}

/** A stated method as the signature checks read it. */
type StatedMethod = { name?: unknown; signatureFrom?: unknown; params?: unknown; returns?: unknown; signature?: unknown };

/**
 * The interface methods that name a signatureFrom and ALSO state params or
 * returns (SIGNATURE_SOURCE_RESTATED): the source supplies both, so stating
 * them beside it says the contract twice. Judged on each method alone.
 */
function restatedSources(methods: unknown): string[] {
  if (!Array.isArray(methods)) return [];
  return (methods as StatedMethod[])
    .filter((m) => m && typeof m === 'object' && m.signatureFrom !== undefined && (m.params !== undefined || m.returns !== undefined))
    .map((m) => String(m.name));
}

/** The sentence a restated source is refused with — what is wrong and both ways out. */
function restatedSourceRefusal(id: string, methods: string[]): string {
  return `SIGNATURE_SOURCE_RESTATED: interface "${id}" — ${methods.map((n) => `"${n}"`).join(', ')} `
    + `${methods.length === 1 ? 'names' : 'name'} a signatureFrom and also ${methods.length === 1 ? 'states' : 'state'} params or returns. `
    + 'The source supplies them: state the signatureFrom alone, or the params and returns alone. To adopt a source on a '
    + 'method that states its own, unset its params and returns in the same delta.';
}

/** The methods that state neither params, a signatureFrom nor a prose signature — nothing says what they take. */
function unsignedMethods(methods: unknown): string[] {
  if (!Array.isArray(methods)) return [];
  return (methods as StatedMethod[])
    .filter((m) => m && typeof m === 'object' && m.signatureFrom === undefined && m.params === undefined
      && (typeof m.signature !== 'string' || m.signature.trim() === ''))
    .map((m) => String(m.name));
}

/**
 * Every params-bearing, unsourced method of the candidate given the text its
 * params derive, IN PLACE — the door's text is never taken. Answers a notice
 * naming each stated text that differed from the derived one.
 */
function deriveStatedTexts(kind: WritableSpecKind, candidate: Record<string, any>): string[] {
  if ((kind !== 'interface' && kind !== 'type') || !Array.isArray(candidate.methods)) return [];
  const differed: string[] = [];
  candidate.methods = candidate.methods.map((m: Record<string, any>) => {
    if (!m || typeof m !== 'object' || m.signatureFrom !== undefined || !Array.isArray(m.params)) return m;
    const derived = deriveMethodSignature(m as { name: string; params: [] });
    if (derived === undefined) return m;
    if (typeof m.signature === 'string' && m.signature !== derived) differed.push(`"${m.name}": stated "${m.signature}", written "${derived}"`);
    return { ...m, signature: derived };
  });
  return differed.length === 0 ? [] : [
    `Signature text derived from params, not taken as stated — ${differed.join('; ')}. A method with params shows the text its params derive.`,
  ];
}

/**
 * A stored spec in the form its file holds — what a restatement carries from
 * and is compared with: a sourced method keeps only its source, a params-bearing
 * method its derived text. The loader resolves sources into what it answers, and
 * carrying those resolved params into a restatement would state them twice.
 */
function storedForm(kind: WritableSpecKind, spec: Spec | null): Spec | null {
  if (!spec) return spec;
  if (kind === 'interface') {
    const intf = spec as InterfaceSpec;
    return { ...intf, methods: intf.methods.map((m) => storedMethodSignature(m)) } as Spec;
  }
  if (kind === 'type') {
    const type = spec as TypeSpec;
    return { ...type, methods: type.methods.map((m) => storedTypeMethod(m)) } as Spec;
  }
  return spec;
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

/** The kinds whose specs keep a rename trace (previousIds). */
const TRACED_KINDS: ReadonlySet<WritableSpecKind> = new Set(['component', 'interface', 'implementation', 'type']);

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
  loaded: Spec | null,
  parent: SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | null,
): SpecRestatementApplication {
  // The stored spec as its file holds it: a sourced method carries only its source.
  const existing = storedForm(restatement.kind, loaded);
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

  // A new method may not take a name its own contract retired (name-retired).
  if (restatement.kind === 'interface') {
    const retired = retiredMethodNames(existing, candidate);
    if (retired) return refused(restatement, replacedExisting, `${retired} Nothing was written.`);
  }

  // A source stated beside params or returns, and a method stating nothing it
  // takes, are refused; a params-bearing method's text is derived, not taken.
  if (restatement.kind === 'interface') {
    const restated = restatedSources(candidate.methods);
    if (restated.length) return refused(restatement, replacedExisting, `${restatedSourceRefusal(String(candidate.id), restated)} Nothing was written.`);
  }
  const unsigned = restatement.kind === 'interface' || restatement.kind === 'type' ? unsignedMethods(candidate.methods) : [];
  if (unsigned.length) {
    return refused(restatement, replacedExisting,
      `Refusing to write ${restatement.kind} "${String(candidate.id)}": ${unsigned.map((n) => `"${n}"`).join(', ')} `
      + `${unsigned.length === 1 ? 'states' : 'state'} neither params${restatement.kind === 'interface' ? ', a signatureFrom' : ''} nor a prose signature, `
      + 'so nothing says what the method takes. Nothing was written.');
  }
  // Every type position read under the grammar: an alias is respelled and
  // reported, a position with no canonical spelling refused with its replacement.
  const types = canonicalTypesOf(restatement.kind, candidate);
  if (types && types.problems.length) {
    return refused(restatement, replacedExisting, `${typeProblemRefusal(restatement.kind, String(candidate.id), types.problems)} Nothing was written.`);
  }
  if (types) Object.assign(candidate, types.spec);
  const derivedNotices = deriveStatedTexts(restatement.kind, candidate);

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
    notices: [...(existing ? rewriteNotices(restatement.kind, existing, candidate, carried, cleared) : []), ...derivedNotices],
    changedMethods: changedMethodsOf(restatement.kind, existing, candidate),
    respellings: types?.respellings ?? [],
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
  return { spec: restatement.spec, refusal, replacedExisting, notices: [], changedMethods: [], respellings: [] };
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
  // A method's rename trace is carried whatever the door expresses: a
  // re-authoring that states the method again never drops the names it retired.
  if (restatement.kind === 'interface' && !restatement.memberFields && Array.isArray(candidate.methods)) {
    const stored: Record<string, unknown>[] = (existing as { methods?: Record<string, unknown>[] }).methods ?? [];
    for (const method of candidate.methods as Record<string, unknown>[]) {
      const prev = stored.find((p) => p.name === method.name);
      if (prev?.previousNames === undefined || method.previousNames !== undefined) continue;
      method.previousNames = prev.previousNames;
      carried.push(`previousNames (${String(method.name)})`);
    }
    // And each parameter's, on a method stated again under its name: a
    // parameter stated under its current name keeps the names it retired.
    for (const method of candidate.methods as Record<string, unknown>[]) {
      const prev = stored.find((p) => p.name === method.name);
      const prevParams = Array.isArray(prev?.params) ? (prev!.params as Record<string, unknown>[]) : [];
      for (const param of Array.isArray(method.params) ? (method.params as Record<string, unknown>[]) : []) {
        const before = prevParams.find((p) => p.name === param.name);
        if (before?.previousNames === undefined || param.previousNames !== undefined) continue;
        param.previousNames = before.previousNames;
        carried.push(`previousNames (param ${String(method.name)}.${String(param.name)})`);
      }
    }
  }
  // A field's rename trace likewise: re-defining a type states its fields
  // again, and a field stated under its current name keeps the names it retired.
  if (restatement.kind === 'type' && Array.isArray(candidate.fields)) {
    const stored: Record<string, unknown>[] = (existing as { fields?: Record<string, unknown>[] }).fields ?? [];
    for (const field of candidate.fields as Record<string, unknown>[]) {
      const prev = stored.find((p) => p.name === field.name);
      if (prev?.previousNames === undefined || field.previousNames !== undefined) continue;
      field.previousNames = prev.previousNames;
      carried.push(`previousNames (field ${String(field.name)})`);
    }
  }
  // createdAt is kept by stampLifecycle and named first above, never carried as data.
  carried.push(...carryUnexpressed(existing as Record<string, unknown>, candidate, [...restatement.fields, 'createdAt']));
  return carried;
}

/**
 * The refusal for an interface restatement that states a NEW method under a
 * name one of its own methods retired — `<interface>.<name>` in that method's
 * previousNames — or undefined. A consumer holding the old key would read the
 * new method as the renamed one; unsetting the holder's previousNames releases
 * the name.
 */
function retiredMethodNames(existing: Spec | null, candidate: Record<string, any>): string | undefined {
  const id = String(candidate.id);
  const storedNames = new Set(((existing as { methods?: { name: string }[] } | null)?.methods ?? []).map((m) => m.name));
  const methods = (Array.isArray(candidate.methods) ? candidate.methods : []) as { name: string; previousNames?: string[] }[];
  const holders = [...methods, ...((existing as { methods?: { name: string; previousNames?: string[] }[] } | null)?.methods ?? [])];
  for (const method of methods) {
    if (storedNames.has(method.name)) continue;
    const holder = holders.find((m) => m !== method && (m.previousNames ?? []).includes(`${id}.${method.name}`));
    if (holder) {
      return `Refusing to write interface "${id}": name-retired — the new method "${method.name}" takes a name this contract retired `
        + `("${holder.name}" lists "${id}.${method.name}" in its previousNames). Unsetting that previousNames releases the name.`;
    }
  }
  return undefined;
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
  const id = restatement.kind === 'system' ? 'system' : (restatement.spec as { id: string }).id;
  const parentRef = restatementParent(restatement);
  // Steps 2-4: a spec, or a parent, of another project is that project's to write.
  const foreign = crossProjectWriteRefusal(
    [{ kind: restatement.kind, id }, ...(parentRef && typeof parentRef.id === 'string' ? [{ kind: parentRef.kind, id: parentRef.id }] : [])],
    CREATE_TOOL[restatement.kind],
  );
  if (foreign !== undefined) throw new Error(foreign);
  // Step 5: the parent the restatement cannot be written without.
  const parent = parentRef ? loadSpec(parentRef.kind, parentRef.id) : null;
  // Step 6: the spec this restatement re-authors, if one holds the id.
  const existing = loadSpec(restatement.kind, id);
  // Steps 7-9: an id given to a NEW spec must not be one a renamed spec of
  // its kind retired (spec_index.retiredBy; a type within its owner).
  if (!existing && TRACED_KINDS.has(restatement.kind)) {
    const spec = restatement.spec as { id: string; subsystem?: string };
    const key = restatement.kind === 'type' ? qualifiedTypeId(spec) : spec.id;
    const holder = specIndexRetiredBy(scanAllSpecs({ memberDepth: 0 }), restatement.kind, key);
    if (holder) {
      throw new Error(
        `id-retired: ${restatement.kind} "${spec.id}" is listed in the previousIds of "${holder}", which was renamed from it. `
        + 'Left alone, a consumer holding the old key would read the new spec as the renamed one. Unsetting the holder\'s previousIds '
        + '(sdd_update_spec with {"unset": ["previousIds"]}) releases the id, at the cost that such a consumer reads a delete and an add. Nothing was written.',
      );
    }
  }
  // Step 10: what the restatement becomes over it.
  const application = applyRestatement(restatement, existing, parent as SystemSpec | SubsystemSpec | ComponentSpec | InterfaceSpec | null);
  // Steps 11-12: a refusal stops the write before anything reaches disk.
  if (application.refusal !== undefined) throw new Error(application.refusal);
  // Steps 10-12: the method, parameter and field names the candidate introduces.
  const names = introducedNameProblems(restatement.kind, application.spec, existing);
  if (names.length) throw new Error(nameRefusal(restatement.kind, id, names));
  // ...and the legacy mount form, before anything is judged or written.
  refuseMountForm(restatement.kind, application.spec);
  // Steps 13-14: the intrinsic judgement, for the one kind judged at the boundary.
  const gateNotices = restatement.kind === 'component' ? judgeComponent(application.spec as ComponentSpec, bound) : [];
  // Step 14: the doctrine edges, boundary edges and route collisions it introduces in its tree.
  gateNotices.push(...judgeInTree(restatement.kind, application.spec as ComponentSpec | InterfaceSpec, bound));
  // Steps 15-17: a re-authored contract dropping methods takes their
  // implementation entries with it, and is refused while others name one.
  let cascade: MethodCascade[] = [];
  if (restatement.kind === 'interface' && existing) {
    const dropped = removedByName((existing as InterfaceSpec).methods, (application.spec as InterfaceSpec).methods);
    if (dropped.length > 0) {
      const removal = methodRemoval(scanAllSpecs({ memberDepth: 0 }), id, (application.spec as InterfaceSpec).component, dropped);
      if (removal.references.length > 0) throw new Error(methodReferencedRefusal(id, removal.referenced, removal.references));
      cascade = removal.cascade;
    }
  }
  // Steps 18-19: the tests this write invalidates, each placed in its file.
  const testsToRevisit = testsInvalidatedBy(restatement.kind, id, application.changedMethods, [existing, application.spec], bound);
  const cascaded = cascade.map((c) => `${c.implementation}.${c.method}`);
  const name = (application.spec as { name: string }).name;
  const status = application.status ? { status: application.status } : {};
  // Steps 20-21: a dry run answers the receipt the write would give.
  if (restatement.dryRun) {
    return {
      kind: restatement.kind, id, name, replacedExisting: application.replacedExisting, ...status,
      notices: [...gateNotices, ...application.notices, ...cascadeNotices(cascade, true)],
      respellings: application.respellings, testsToRevisit, ...(cascaded.length > 0 ? { cascaded } : {}), dryRun: true,
    };
  }
  // Step 22: to disk.
  const persisted = persistCandidate(restatement.kind, application.spec);
  // Step 23: the dropped methods' implementation entries go with them.
  for (const [implementation, methods] of groupCascade(cascade)) {
    updateSpec('implementation', implementation, { methods: methods.map((m) => ({ name: m, action: 'delete' })) });
  }
  // Step 24: the receipt.
  return {
    kind: restatement.kind, id, name, replacedExisting: application.replacedExisting, ...status,
    notices: [...gateNotices, ...persisted.notices, ...application.notices, ...cascadeNotices(cascade, false)],
    respellings: application.respellings, testsToRevisit, ...(cascaded.length > 0 ? { cascaded } : {}),
  };
}

/** The create tool each kind is written by: the call a project-boundary refusal names. */
const CREATE_TOOL: Record<WritableSpecKind, string> = {
  system: 'sdd_initialize_system',
  subsystem: 'sdd_add_subsystem',
  component: 'sdd_add_component',
  interface: 'sdd_define_interface',
  implementation: 'sdd_write_narrative',
  type: 'sdd_add_type',
};

/** One implementation method entry a contract method's removal takes with it. */
interface MethodCascade {
  implementation: string;
  method: string;
}

/** What removing contract methods takes with it, and what still names them. */
interface MethodRemoval {
  /** The removed methods no other contract of the component still declares: what references and exports lose. */
  referenced: string[];
  /** Every reference a spec that stays holds to one of them (spec_index.methodReferencesTo). */
  references: SpecReference[];
  /** The implementation entries realizing a removed method on this contract: they go with it. */
  cascade: MethodCascade[];
}

/**
 * The removal of `removed` from contract `contract` of `component`, read in
 * the index: the implementation entries realizing them go with them (a
 * narrative means nothing without its contract method), so a reference from
 * inside one of those entries is no reference left behind; a method another
 * contract of the component still declares is no removal to its callers.
 */
function methodRemoval(index: SpecIndex, contract: string, component: string, removed: string[]): MethodRemoval {
  const realizing = index.implementations.filter((impl) => impl.contract === contract);
  const stillDeclared = (m: string): boolean => index.interfaces.some((i) => i.component === component && i.id !== contract && i.methods.some((x) => x.name === m));
  const referenced = removed.filter((m) => !stillDeclared(m));
  const inside = (r: SpecReference): boolean => r.kind === 'implementation' && realizing.some((impl) => impl.id === r.id)
    && removed.some((m) => r.position === `methods.${m}` || r.position.startsWith(`methods.${m}.`));
  const references = referenced.length === 0 ? [] : specIndexMethodReferences(index, component, referenced).filter((r) => !inside(r));
  const cascade = realizing.flatMap((impl) => removed
    .filter((m) => impl.methods.some((x) => x.name === m))
    .map((m) => ({ implementation: impl.id, method: m })));
  return { referenced, references, cascade };
}

/** The refusal of a method removal that would leave references dangling: every one, and the way on. */
function methodReferencedRefusal(contract: string, removed: string[], references: SpecReference[]): string {
  return `Refusing to remove ${removed.length === 1 ? 'method' : 'methods'} ${removed.map((m) => `"${m}"`).join(', ')} from contract "${contract}": `
    + `specs that stay still hold ${references.length === 1 ? 'a reference' : `${references.length} references`} to ${removed.length === 1 ? 'it' : 'them'} — the invalid method references validate would report:\n`
    + `${references.map((r) => `- ${r.kind} "${r.id}" (${r.position}) -> ${r.target.kind} "${r.target.id}"`).join('\n')}\n`
    + 'Edit those specs first — retarget or remove each call. Nothing was written.';
}

/** The cascade grouped by implementation, in the order it was planned. */
function groupCascade(cascade: MethodCascade[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of cascade) out.set(c.implementation, [...(out.get(c.implementation) ?? []), c.method]);
  return out;
}

/** One notice naming what a contract method's removal took (or, on a dry run, would take) with it. */
function cascadeNotices(cascade: MethodCascade[], dryRun: boolean): string[] {
  if (cascade.length === 0) return [];
  return [`Cascaded: ${dryRun ? 'would remove' : 'removed'} the implementation ${cascade.length === 1 ? 'entry' : 'entries'} ${cascade.map((c) => `"${c.implementation}.${c.method}"`).join(', ')} with ${cascade.length === 1 ? 'its' : 'their'} contract method — a narrative realizes its contract method and means nothing without it.`];
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

/**
 * The in-tree judgement of a component or contract about to be written: the
 * doctrine edges and route collisions it would introduce. An error refuses
 * the write — the same codes and messages validate gives, before anything
 * reaches disk, exactly as an intrinsic error is refused — and a code the
 * project tuned down comes back as notices. Any other kind is not judged.
 */
function judgeInTree(kind: WritableSpecKind, candidate: ComponentSpec | InterfaceSpec, options: { rules?: RulesConfig; projectType?: string }): string[] {
  const verdict = introducedFindings(kind, candidate, options);
  if (verdict.errors.length) {
    throw new Error(
      `Refused: writing ${kind} "${candidate.id}" would introduce ${verdict.errors.length === 1 ? 'an error' : `${verdict.errors.length} errors`} validate reports — `
      + 'an edge whose two blocks forbid it, or a route another method already binds:\n'
      + `${verdict.errors.map((e) => `- ${e.code}: ${e.message}`).join('\n')}\n\n`
      + 'Nothing was written. Route the dependency the way the message names, or bind the method to a route of its own.',
    );
  }
  return noticesFrom(verdict);
}

/**
 * Persist the candidate through the store — refusing, before anything reaches
 * disk, a subsystem that names a projectPath: that is the legacy mount form,
 * and a member is declared in project.yaml `members` instead.
 */
function persistCandidate(kind: WritableSpecKind, spec: Spec): { notices: string[] } {
  refuseMountForm(kind, spec);
  // Step 15: the store's write, collecting its placement notices.
  return { notices: saveSpec(kind, spec) };
}

/** Refuse, before anything reaches disk, a subsystem that names a projectPath: the legacy mount form. */
function refuseMountForm(kind: WritableSpecKind, spec: Spec): void {
  // Step 13: a subsystem naming a projectPath is a member declaration, not a subsystem.
  const projectPath = kind === 'subsystem' ? (spec as SubsystemSpec).projectPath : undefined;
  if (projectPath !== undefined && projectPath.trim() !== '') {
    // Step 14: refuse, naming the subsystem and the replacement.
    const id = (spec as SubsystemSpec).id;
    throw new Error(
      `mount form refused: subsystem "${id}" names a projectPath ("${projectPath}"), which is the legacy L1 mount form — `
      + 'wairon never writes it. A member project is declared in project.yaml `members`: use sdd_add_member '
      + `(or \`wairon member add ${id} ${projectPath}\`), which scaffolds the member project and declares it.`,
    );
  }
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
 * Delete one spec of the named kind together with everything it contains, and
 * report what went (authoring_orchestrator.deleteSpec; the portal method is
 * this same function).
 *
 * Deleting only the addressed document left a subsystem's components, a
 * component's contract, implementation and owned members, orphaned under a
 * container that no longer existed, and answered "Successfully deleted". A
 * container's content means nothing without it, so the deletion takes its
 * subtree (spec_index.subtreeOf). A spec OUTSIDE that set still referencing
 * it is an invalid reference the deletion itself would introduce — an error
 * validate reports — so the deletion is refused, naming each one, exactly as
 * the gate refuses every other write that introduces an error; `force`
 * deletes anyway and answers the references it left, for a staged teardown.
 * `dryRun` answers the same plan and removes nothing. The tests a removed
 * method encodes are found first, while the implementations placing them
 * still exist. The L0 cannot be deleted.
 */
export function deleteSpec(kind: WritableSpecKind, id: string, dryRun?: boolean, force?: boolean): SpecDeletion {
  // Steps 1-3: a spec of another project is deleted from that project's own
  // root — refused for a dry run exactly as for the deletion.
  const foreign = crossProjectWriteRefusal([{ kind, id }], 'sdd_delete_spec');
  if (foreign !== undefined) throw new Error(foreign);
  // Steps 2-3: the L0 is the root every other spec hangs from.
  if (kind === 'system') {
    throw new Error('Refusing to delete the L0 System spec: it is the root every other spec hangs from, and is never deleted. Nothing was deleted.');
  }
  // Steps 4-6: a spec of a legacy L1 mount read through this tree keeps the
  // single-document delete it always had: its subtree is not this project's to plan.
  if (kind !== 'type' && id.includes('::')) {
    const deleted = dryRun ? loadSpec(kind, id) !== null : coreDeleteSpec(kind, id);
    if (!deleted && loadSpec(kind, id) === null) throw new Error(`spec-missing: no ${kind} has the id "${id}" — nothing was deleted.`);
    return { kind, id, deleted: deleted && !dryRun, dryRun: dryRun === true, removed: [{ kind, id }], references: [], testsToRevisit: [], published: [] };
  }
  // Step 7: the test roots the report searches.
  const bound = candidateOptions();
  // Steps 8-9: the bound tree's own specs, and the L0 whose export table may name them.
  const index = scanAllSpecs({ memberDepth: 0 });
  const system = loadSpec('system', 'system') as SystemSpec | null;
  // Steps 10-12: what the deletion takes; an id nothing holds is refused with what it might have meant.
  const removed = specIndexSubtreeOf(index, kind, id);
  if (removed.length === 0) throw new Error(missingRefusal(kind, id, index));
  // Step 13: what stays behind still naming it.
  const references = specIndexReferencesTo(index, removed, system);
  // Step 14: every public name a consumer reaches what goes through, read before anything goes.
  const published = publishedUsesOf(removed, []);
  // Steps 15-17: the tests the removed methods encode, found while their realizations still exist.
  const testsToRevisit = removed.flatMap((ref) => {
    const spec = specOf(index, ref);
    const methods = ((spec as { methods?: { name: string }[] } | null)?.methods ?? []).map((m) => m.name);
    return ref.kind === 'interface' || ref.kind === 'implementation' || ref.kind === 'type'
      ? testsInvalidatedBy(ref.kind, ref.id, methods, [spec as Spec | null], bound)
      : [];
  });
  // Steps 18-19: the plan alone.
  if (dryRun) return { kind, id, deleted: false, dryRun: true, removed, references, testsToRevisit, published };
  // Steps 20-21: references a deletion would leave dangling refuse it, unless forced.
  if (references.length > 0 && !force) throw new Error(referencedRefusal(kind, id, references));
  // Steps 22-23: innermost first, so a container goes after its content.
  for (const ref of removed) coreDeleteSpec(ref.kind as WritableSpecKind, ref.id);
  // Step 24.
  return { kind, id, deleted: true, dryRun: false, removed, references, testsToRevisit, published };
}

/**
 * The refusal of a deletion whose id no spec of the kind holds, with what the
 * id might have meant: the kind of spec that does hold it, the subsystem::id
 * form of a type written with a dot, and the ids the kind does hold.
 */
function missingRefusal(kind: WritableSpecKind, id: string, index: SpecIndex): string {
  const pools: Record<string, ReadonlyArray<{ id: string; subsystem?: string }>> = {
    subsystem: index.subsystems, component: index.components, interface: index.interfaces,
    implementation: index.implementations, type: index.types,
  };
  const hints: string[] = [];
  const elsewhere = Object.keys(pools).filter((k) => k !== kind && pools[k].some((s) => s.id === id));
  if (elsewhere.length > 0) hints.push(`"${id}" is ${elsewhere.map((k) => `a ${k}`).join(' and ')} — pass kind "${elsewhere[0]}"`);
  const dot = id.lastIndexOf('.');
  if (kind === 'type' && dot > 0 && index.types.some((t) => t.id === id.slice(dot + 1))) {
    hints.push(`a type is addressed by its bare id, or as <subsystem>::<id> — "${id.slice(dot + 1)}" or "${id.slice(0, dot)}::${id.slice(dot + 1)}"`);
  }
  const known = pools[kind].map((s) => (kind === 'type' ? qualifiedTypeId(s as TypeSpec) : s.id)).sort();
  const listed = known.length === 0 ? `This project has no ${kind} at all.`
    : `Its ${kind}s: ${known.slice(0, 12).join(', ')}${known.length > 12 ? `, … (${known.length} in all)` : ''}.`;
  return `spec-missing: no ${kind} has the id "${id}" — nothing was deleted.${hints.length > 0 ? ` ${hints.join('; ')}.` : ''} ${listed}`;
}

/** The stored spec a SpecRef names in the index; null when none does. */
function specOf(index: SpecIndex, ref: SpecRef): Spec | null {
  const pool: ReadonlyArray<{ id: string }> = ref.kind === 'subsystem' ? index.subsystems
    : ref.kind === 'component' ? index.components
      : ref.kind === 'interface' ? index.interfaces
        : ref.kind === 'implementation' ? index.implementations
          : ref.kind === 'type' ? index.types : [];
  return (pool.find((s) => s.id === ref.id) as Spec | undefined) ?? null;
}

/** The refusal of a deletion that would leave references dangling: every one, and the two ways on. */
function referencedRefusal(kind: WritableSpecKind, id: string, references: SpecReference[]): string {
  return `Refusing to delete ${kind} "${id}": ${references.length === 1 ? 'a spec that stays still references' : `specs that stay still hold ${references.length} references to`} what the deletion removes — `
    + 'the invalid references validate would report:\n'
    + `${references.map((r) => `- ${r.kind} "${r.id}" (${r.position}) -> ${r.target.kind} "${r.target.id}"`).join('\n')}\n`
    + 'Edit those specs first, or pass force: true to delete anyway and leave them dangling. Nothing was deleted; dryRun lists the whole plan.';
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
  // Steps 2-4: a spec of another project is updated from that project's own root.
  const foreign = crossProjectWriteRefusal([{ kind, id }], 'sdd_update_spec');
  if (foreign !== undefined) throw new Error(foreign);
  // Step 5: the spec as it stands — the owner the judgement compares against,
  // the contract methods a delta may remove, and, when a test search may
  // follow, a method the delta deletes placed in its file and named by its
  // code name, which only the version that still held it can answer.
  const testRoots = bound.rules?.conformance?.testRoots ?? [];
  const stored = loadSpec(kind, id);
  // Steps 6-11: a delta removing contract methods takes their implementation
  // entries with it, and is refused while other specs still name one.
  const removedMethods = kind === 'interface' ? methodsDeltaRemoves(stored as InterfaceSpec | null, delta) : [];
  let cascade: MethodCascade[] = [];
  let published: ExportUse[] = [];
  if (removedMethods.length > 0) {
    const removal = methodRemoval(scanAllSpecs({ memberDepth: 0 }), id, (stored as InterfaceSpec).component, removedMethods);
    if (removal.references.length > 0) throw new Error(methodReferencedRefusal(id, removal.referenced, removal.references));
    cascade = removal.cascade;
    published = publishedUsesOf([], removal.referenced.map((m) => `${id}.${m}`));
  }
  // Step 12: the judgement as a write hook over those same settings.
  const gate = componentCandidateGate(bound, (stored as { subsystem?: string } | null)?.subsystem, stored as Spec | null);
  // Step 13: apply the delta with the hook injected, so the judgement runs on
  // the merged spec at the last point before anything reaches disk.
  const report = updateSpec(kind, id, delta, gate, dryRun);

  // Steps 14-15: the removed methods' implementation entries go in the same
  // write — a dry run says which would.
  if (cascade.length > 0 && report.changes.length > 0) {
    for (const [implementation, methods] of groupCascade(cascade)) {
      updateSpec('implementation', implementation, { methods: methods.map((m) => ({ name: m, action: 'delete' })) }, undefined, dryRun);
    }
    report.cascaded = cascade.map((c) => `${c.implementation}.${c.method}`);
    report.notices.push(...cascadeNotices(cascade, dryRun === true));
  }
  if (published.length > 0 && report.changes.length > 0) report.published = published;

  // Step 16: a Portal's transport change names its impact on the Adapters that
  // call it — in a dry run too, before anything is written.
  if (kind === 'component' && typeof delta?.transport === 'string' && report.changes.some((c) => c.path === 'transport')) {
    report.notices.push(...adapterTransportImpact(id, delta.transport));
  }

  // Step 17: a contract's `implements` the delta writes — a dry run included,
  // before anything is written — says what validate will say of it.
  if (kind === 'interface' && typeof delta?.implements === 'string') {
    const problem = implementsProblem(delta.implements);
    if (problem) report.notices.push(`${problem} (validate reports it once this is written)`);
  }

  // Step 18: did this write invalidate any test?
  const changed = changedMethods(report);
  if (changed.length > 0 && testRoots.length > 0) {
    // Steps 19-20: search them by the code name and the file realizing each.
    const written: Record<string, any>[] = Array.isArray(delta?.methods) ? delta.methods : [];
    report.testsToRevisit = testsInvalidatedBy(kind, id, changed, [stored], bound, written);
  }

  // Step 21.
  return report;
}

/**
 * The contract methods a delta removes from the stored contract: an element
 * naming one with a delete marker, or the method list emptied (`[]`, or an
 * unset of `methods`). A marker naming a method the contract does not hold
 * removes nothing — the store refuses it, naming the methods it does.
 */
function methodsDeltaRemoves(stored: InterfaceSpec | null, delta: Record<string, any>): string[] {
  const held = (stored?.methods ?? []).map((m) => m.name);
  if (held.length === 0 || !delta || typeof delta !== 'object') return [];
  const methods = delta.methods;
  if ((Array.isArray(methods) && methods.length === 0) || (Array.isArray(delta.unset) && delta.unset.includes('methods'))) return held;
  if (!Array.isArray(methods)) return [];
  return methods
    .filter((m: any) => m && typeof m === 'object' && (m.action === 'delete' || m.remove === true) && held.includes(m.name))
    .map((m: any) => String(m.name));
}

/**
 * Step 16 of updateSpecGated: each Adapter that states a transport other than
 * the Portal's new one and calls it (dependsOn, or a call, register or
 * dispatch step of its implementation) — the ADAPTER_TRANSPORT_MISMATCH the
 * change raises there, with the way out.
 */
function adapterTransportImpact(portal: string, transport: string): string[] {
  const components = loadComponentSpecs();
  if (components.find((c) => c.id === portal)?.componentType !== 'Portal') return [];
  const names = (ref: string | undefined): boolean => ref === portal || (ref !== undefined && ref.endsWith(`::${portal}`));
  const calledByStep = new Set<string>();
  for (const impl of loadImplementationSpecs()) {
    const owner = (loadSpec('interface', impl.contract) as { component?: string } | null)?.component;
    if (owner === undefined) continue;
    const steps = impl.methods.flatMap((m) => m.narrative ?? []);
    if (steps.some((s) => (s.type === 'call' || s.type === 'register' || s.type === 'dispatch') && names(s.targetComponent))) calledByStep.add(owner);
  }
  return components
    .filter((c) => c.componentType === 'Adapter' && c.transport !== undefined && c.transport !== transport)
    .filter((c) => (c.dependsOn ?? []).some(names) || calledByStep.has(c.id))
    .map((c) => `ADAPTER_TRANSPORT_MISMATCH would follow: Adapter "${c.id}" states transport "${c.transport}" and calls "${portal}", whose transport becomes "${transport}" — state "${transport}" on "${c.id}", or unset its transport so it follows the Portal.`);
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
  // Steps 1-3: a component of another project is that project's to change.
  const foreign = crossProjectWriteRefusal([{ kind: 'component', id: from }, { kind: 'component', id: to }], 'sdd_move_methods');
  if (foreign !== undefined) throw new Error(foreign);
  // Steps 4-7: the judgement as a hook, the move through the core adapter.
  return coreMoveMethods(from, to, methods, methodMoveGate(from), dryRun);
}

/**
 * Move a component or a type to another subsystem as ONE gated write
 * (authoring_orchestrator.moveSpec; the portal method is this same function).
 *
 * A move is a placement change, not a rename: every id stays, so references
 * by id stay too, while what names the old subsystem follows — the core does
 * that. What only this seam can do is judge it: a component moved away from
 * its collaborators turns every edge to them into a cross-subsystem edge, and
 * one into a non-Portal is an error no later write can cure. So the moved
 * components are judged in their tree WITH their new subsystem, together, and
 * the move is refused with the rule's own words before anything is written; a
 * curable boundary finding rides along as a notice. A type carries no edges
 * and is moved without judgement.
 */
export function moveSpec(kind: WritableSpecKind, id: string, subsystem?: string, dryRun?: boolean): SpecMove {
  // Steps 1-3: the spec, and the subsystem it moves to, are the bound project's own.
  const foreign = crossProjectWriteRefusal(
    [{ kind, id }, ...(subsystem ? [{ kind: 'subsystem' as const, id: subsystem }] : [])],
    'sdd_move_spec',
  );
  if (foreign !== undefined) throw new Error(foreign);
  // Step 4: a type carries no edges.
  if (kind !== 'component') return coreMoveSpec(kind, id, subsystem, dryRun);
  // Step 5: the settings the move is judged with.
  const bound = candidateOptions();
  // Step 6: what moves, refused exactly as the move would be.
  const plan = coreMoveSpec(kind, id, subsystem, true);
  // Step 7: each moved component as stored, with its new subsystem.
  const moving = plan.moved
    .filter((ref) => ref.kind === 'component')
    .map((ref) => loadSpec('component', ref.id) as ComponentSpec | null)
    .filter((spec): spec is ComponentSpec => spec !== null)
    .map((spec) => ({ ...spec, subsystem: plan.to }));
  // Steps 8-10: the design findings the move introduces, the moved components together.
  const [first, ...rest] = moving;
  const verdict = first ? introducedFindings('component', first, bound, rest) : { errors: [], warnings: [], notices: [] };
  if (verdict.errors.length > 0) {
    throw new Error(
      `Refused: moving component "${id}" to subsystem "${plan.to}" would introduce ${verdict.errors.length === 1 ? 'an error' : `${verdict.errors.length} errors`} validate reports — `
      + 'a forbidden edge between two blocks, or an edge into another subsystem whose target is not a Portal:\n'
      + `${verdict.errors.map((e) => `- ${e.code}: ${e.message}`).join('\n')}\n\n`
      + 'Nothing was written. Route each such dependency through a client Adapter calling the other subsystem\'s Portal, or move its collaborators with it.',
    );
  }
  // Step 11: a curable boundary finding rides along.
  const notices = noticesFrom(verdict);
  // Steps 12-13: the move itself (or, on a dry run, the plan), with the gate's notices.
  const report = dryRun ? plan : coreMoveSpec(kind, id, subsystem, false);
  return { ...report, notices: [...report.notices, ...notices] };
}
