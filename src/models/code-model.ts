import * as path from 'path';

// ---------------------------------------------------------------------------
// The source-code model the validator's code↔spec rules read: pure analysis
// facts per resolved source path, built once per validation run by the source
// analysis adapter (src/core/source-analysis.ts) and injected into the rule
// context. Keyed by resolved source path, so implementations and methods that
// legitimately share one file (N:1 realization) read the same facts.
// ---------------------------------------------------------------------------

export type AnalysisGrade = 'exact' | 'pattern' | 'generic';
export type SourceFileStatus = 'analyzed' | 'missing' | 'escaped' | 'unreadable';

/**
 * One runtime (value) import binding a file makes: the module specifier a
 * local name came from, and whether it was bound as a whole NAMESPACE.
 *
 * The namespace flag separates the two readings of `x.save()`. For a namespace
 * import (`import * as specs from './specs.js'`), `specs.save` IS that
 * module's own export, so the call site resolves to the module. For a named or
 * default binding, `db.save` is a property of a VALUE that module handed over,
 * and where that property's function was written is beyond a pure model — so
 * it resolves to nothing rather than to the module.
 *
 * Type-only imports are never recorded: a type binding cannot be a call origin.
 */
export interface ImportBindingFact {
  /** The module specifier the binding came from, exactly as written. */
  from: string;
  /** True for `import * as name from …` — the only binding whose property calls are that module's own exports. */
  namespace?: boolean;
  /** The name the module publishes it under, set only when the import renamed it (`import { save as store }`). */
  imported?: string;
}

/**
 * One call SITE SHAPE inside a named function-like: the invoked name together
 * with how the call was written. Shape is what a pure model can honestly say
 * about a call's ORIGIN — with no type checker, `save(x)`, `ledger.save(x)`,
 * `this.store.save(x)` and `new Ledger(db).save(x)` are four different
 * questions, and collapsing them onto the name "save" is what let a call into
 * an unrelated module count as realizing a narrative step.
 *
 * Sites are deduplicated per shape, never counted: the checks that read them
 * ask where a call could land, never how often it was written.
 */
export interface CallSiteFact {
  /** The invoked name: the identifier of a bare call, the property name of a member call. */
  name: string;
  /** True when the call was written as a member access (`receiver.name(…)`). */
  member: boolean;
  /**
   * The receiver identifier — set only when the receiver is a plain identifier
   * (`specs.save()` → "specs"). The one receiver that can be PROVEN, when the
   * name is a namespace import binding and its properties are that module's
   * own exports — and otherwise a receiver to follow past the value it holds,
   * through the type the file ANNOTATES the name with.
   */
  via?: string;
  /**
   * The instance FIELD the receiver is — set only when the call was written
   * `this.<field>.name(…)` (`this.store.save()` → "store"), and never together
   * with `via`. A receiver a pure model can follow past the value it holds,
   * because the class DECLARES what the field is; what that type resolves to
   * is a POSSIBLE origin, never a proven one, since the declared type says
   * what a collaborator is and not which class ships the body.
   */
  field?: string;
  /**
   * The CLASS the receiver was constructed from — set only when the call was
   * written `new Class(…).name(…)` (`new ApprovalRegistry(store).create()` →
   * "ApprovalRegistry"), and never together with `via` or `field`. Another
   * receiver a pure model can follow, because the code NAMES the class it
   * built. Like a declared field type it is a POSSIBLE origin and never a
   * proven one: a method the class INHERITS is written in its base's module,
   * not in the constructed class's.
   */
  constructed?: string;
  /**
   * The file this site was READ in, set only when it is not the file these
   * facts describe — a pure re-export barrel carries the sites of the function
   * it publishes. A carried site's bare names and receivers resolve in that
   * file's scope, never in the barrel's.
   */
  from?: string;
}

/**
 * One data member of a shape a file declares: its name, and whether the code
 * lets it be ABSENT.
 *
 * Absent-able is the only optionality worth recording, because it is the only
 * one a spec can be wrong about in a way a reader would notice — a field the
 * spec calls required that the code lets you omit is a promise the data does
 * not keep. A wrapper that FILLS a missing key is not absent-able: the value
 * the type finally holds always has it, which is the shape the spec describes.
 */
export interface ShapeMemberFact {
  /** The member's name, as the code spells it. */
  name: string;
  /** Whether the code lets the member be absent from a value of this shape. */
  optional: boolean;
}

/**
 * The members of one named shape a file declares — what a data type IS, read
 * off the code so a type spec's claim about it can be checked.
 *
 * Two origins answer, and the difference is recorded rather than smoothed
 * away. A DECLARED shape lists its own members, so the file is the whole
 * answer. A DERIVED one names a VALUE instead — an alias resolved one hop to
 * the object literal its schema is built from, where the keys are the members
 * — so the answer is as good as that hop and no better, and a hop that lands
 * on nothing readable records no shape at all. Silence, not a guess: a wrong
 * member list is worse than none, because nothing downstream would correct it.
 *
 * Methods are kept apart from fields because a spec models them on a different
 * axis — the one `typeRealization` already judges. Counting a behavioural
 * interface's method signatures as data would accuse every one of them of
 * carrying undeclared state.
 */
export interface TypeShapeFact {
  /** How the members were read: the shape listed them itself, or an alias was followed one hop to the value its shape comes from. */
  origin: 'declared' | 'derived';
  /** The data members, each with whether the code lets it be absent. */
  fields: ShapeMemberFact[];
  /** The method-style members, kept on the axis a spec models them on. */
  methods: string[];
  /**
   * True when the shape EXTENDS another, so members it does not list exist
   * but are not in this file to count. Presence and absence are therefore
   * different questions for it: what it shows can be judged, what it omits
   * cannot.
   */
  inherited?: boolean;
}

export interface SourceFileFacts {
  /** Project-relative resolved source path (many implementations may share it, N:1). */
  path: string;
  status: SourceFileStatus;
  /** Effective language the file was analyzed as. */
  language?: string;
  analysisGrade?: AnalysisGrade;
  /**
   * Declaration-tier anchors: named declarations at any nesting depth,
   * destructuring bindings, object-literal keys, import bindings, and export
   * specifiers (export-* barrels chased through relative specifiers).
   */
  declaredNames: string[];
  /** Weaker anchors: exact string-literal occurrences (tool/route registrations). */
  anchoredNames: string[];
  /** Exported bindings (Level 2 dependency-conformance and UNDECLARED_EXPORT fuel). */
  exportedNames: string[];
  /**
   * Runtime import/require module specifiers (dependency-conformance fuel).
   * Type-only imports and export-from specifiers are excluded — type coupling
   * is allowed by default, and re-exporting is surface republication, not
   * collaboration.
   */
  imports: string[];
  /** Module specifiers of export-from declarations (surface republication). */
  reexports: string[];
  /**
   * Cyclomatic complexity per named function-like (function/method/accessor
   * declarations, and function/arrow initializers of named slots). EXACT grade
   * only — lower grades omit the map rather than guess. Same-named functions
   * in one file record their maximum. Fuel for the detail-sufficiency lint.
   */
  functionComplexity?: Record<string, number>;
  /**
   * Direct call sites per named function-like: every call written inside the
   * function body, with its shape (see CallSiteFact) — nested NAMED functions
   * excluded (they carry their own entries), anonymous callbacks included.
   * EXACT grade only. Same-named functions union their sites.
   *
   * A function-like WITH A BODY always gets an entry, empty when it calls
   * nothing; a name with NO entry has no body in this file to read — a bare
   * declaration, an overload signature, an ambient declaration, an interface
   * member, a plain value binding or an imported name. That difference is the
   * whole of hasFunctionBody, which is why an empty entry is never dropped.
   *
   * Fuel for the call-step realization checks (Level 3).
   */
  functionCallSites?: Record<string, CallSiteFact[]>;
  /**
   * Runtime (value) import bindings by local name (see ImportBindingFact).
   * EXACT grade only — a weaker grade sees module specifiers but never which
   * local name they bound.
   */
  importBindings?: Record<string, ImportBindingFact>;
  /**
   * The type names an instance FIELD is DECLARED with, by field name — read
   * off class property declarations and constructor parameter properties,
   * which is where a constructor-injected collaborator says what it is.
   * EXACT grade only.
   *
   * Same-named fields of different classes in one file keep EVERY declared
   * type: the file cannot say which class a call site's `this` was, and a
   * wider answer only ever widens what a call may have reached. A field with
   * no annotation records nothing — what an initializer INFERS is not what
   * the code declares, and a guess is not a fact.
   */
  fieldTypes?: Record<string, string[]>;
  /**
   * The type names a LOCALLY BOUND name is DECLARED with, by name — read off
   * function and method parameters and off variable declarations that carry
   * an annotation, which is where a module that wires its collaborators as
   * closures writes down what each one is. EXACT grade only.
   *
   * Keyed by name across the WHOLE file, as `fieldTypes` is: the facts cannot
   * say which function a call site sits in, and a receiver is as often a
   * parameter of an ENCLOSING function as of the one that calls it — a
   * closure captures it, which is the shape this records at all. Same-named
   * bindings therefore keep EVERY declared type, and a wider answer only ever
   * widens what a call may have reached. A binding the file annotates with
   * nothing records nothing, and so does one annotated with anything but a
   * plain type reference: what an initializer INFERS is not what the code
   * declares, and a guess is not a fact.
   */
  localTypes?: Record<string, string[]>;
  /**
   * The module specifier each TYPE-ONLY import binding came from, by local
   * name. EXACT grade only.
   *
   * The half of the import list `importBindings` deliberately leaves out,
   * because a type binding can never be a call ORIGIN — and exactly what a
   * declared field type is resolved through, which is why it is kept apart
   * rather than folded in.
   */
  typeOnlyBindings?: Record<string, string>;
  /**
   * The members of each named shape the file declares, by declaration name
   * (see TypeShapeFact). EXACT grade only — below it a member list cannot be
   * told from a mention, and a guess about somebody's data model is worse
   * than silence.
   *
   * What lets a type spec's `fields` be CHECKED rather than read as truth by
   * the ERD, the briefs and every implementer. A wrong method signature
   * eventually breaks at a call site; a type spec that lies about its data is
   * only ever read by humans and agents, so nothing corrects it until
   * somebody measures it against the code.
   */
  typeShapes?: Record<string, TypeShapeFact>;
  /**
   * Module-scope mutable bindings (`let`/`var` at the top level of the file).
   * EXACT grade only. The static approximation of held state a logic
   * component may be hiding — fuel for the HIDDEN_STATE lint. (Mutation of
   * const-bound containers is invisible to this collection; the lint says so.)
   */
  topLevelMutableBindings?: string[];
  /**
   * True when the file declared nothing of its own and only re-exported —
   * a pure re-export barrel, which has no code to claim. Measured BEFORE the
   * barrel chase folds the republished names into `declaredNames`, since
   * after it a barrel is indistinguishable from the files it publishes.
   * EXACT grade only: a weaker grade cannot tell a barrel from a file it
   * failed to parse, so it leaves this unset rather than guess.
   */
  reexportOnly?: boolean;
}

export interface CodeModel {
  /** One facts entry per distinct resolved sourcePath (missing/escaped/unreadable included). */
  files: SourceFileFacts[];
  /** The root every sourcePath was resolved and containment-checked against. */
  projectRoot: string;
  /**
   * Every source file the declared source-root walk found, as canonical keys
   * in walk order — the domain the unclaimed-source rule judges. Empty when
   * the project declares no source roots, which is what keeps that rule
   * opt-in. Facts for these files live in `files`, like any other path.
   */
  rootFiles: string[];
}

/**
 * code_model.pathKey — the canonical key form of a source path in the model:
 * forward slashes, no leading `./`. Every facts entry is stored under it, and
 * every lookup or path comparison uses it.
 */
export function pathKey(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * code_model.factsFor — the facts entry for a source path, looked up by its
 * canonical key; undefined when the run analyzed no such path. The model holds
 * one entry per key; were it to hold two, the later one answers, as it does in
 * the keyed indexes the rules build over the same files.
 */
export function factsFor(model: CodeModel, sourcePath: string): SourceFileFacts | undefined {
  const key = pathKey(sourcePath);
  for (let i = model.files.length - 1; i >= 0; i--) {
    if (pathKey(model.files[i].path) === key) return model.files[i];
  }
  return undefined;
}

/**
 * Own-property record lookup. Callee, function and binding names include
 * things like "toString" and "constructor", which a bare index would resolve
 * to Object.prototype members (functions — not arrays, not records), so every
 * read of a name-keyed facts record goes through this.
 */
function ownEntry<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

/**
 * source_file_facts.importBindingOf — the runtime import binding a file makes
 * under a local name, or undefined when the name is not an import of this
 * file (it is local, global, or bound type-only).
 */
export function importBindingOf(facts: SourceFileFacts, name: string): ImportBindingFact | undefined {
  return ownEntry(facts.importBindings, name);
}

/** The empty answer a name the file annotates with nothing gives. */
const NO_DECLARED_TYPES: string[] = [];

/**
 * source_file_facts.fieldTypesOf — the type names an instance field is
 * DECLARED with, or EMPTY when the file declares no such field, annotates it
 * with nothing, or was analyzed below exact grade. The empty answer is what
 * keeps an unresolvable field from becoming a guess.
 */
export function fieldTypesOf(facts: SourceFileFacts, field: string): string[] {
  return ownEntry(facts.fieldTypes, field) ?? NO_DECLARED_TYPES;
}

/**
 * source_file_facts.localTypesOf — the type names a locally bound name is
 * DECLARED with, or EMPTY when the file binds no such name, annotates it with
 * nothing, or was analyzed below exact grade. The empty answer is what keeps
 * an unannotated receiver from becoming a guess, exactly as it does for a
 * field.
 */
export function localTypesOf(facts: SourceFileFacts, name: string): string[] {
  return ownEntry(facts.localTypes, name) ?? NO_DECLARED_TYPES;
}

/**
 * source_file_facts.typeBindingOf — the module specifier a NAME was imported
 * from, whether the import was type-only or a runtime one, since a declared
 * type may be spelled either way. Undefined when the file imports no such
 * name, which leaves the name local, global or ambient.
 */
export function typeBindingOf(facts: SourceFileFacts, name: string): string | undefined {
  return ownEntry(facts.typeOnlyBindings, name) ?? ownEntry(facts.importBindings, name)?.from;
}

/**
 * source_file_facts.callSitesOf — the call sites written inside one named
 * function-like, or undefined when the file holds no BODY under that name.
 * The two answers are different findings and must never be collapsed: an
 * empty array is a body that calls nothing, undefined is nothing to read.
 */
export function callSitesOf(facts: SourceFileFacts, fn: string): CallSiteFact[] | undefined {
  return ownEntry(facts.functionCallSites, fn);
}

/**
 * source_file_facts.hasFunctionBody — whether the file holds a function-like
 * BODY under a name, as the model measured it: a function, method or accessor
 * declaration, or a function/arrow initializer bound to a named slot. A name
 * the file declares WITHOUT one — an overload signature, an ambient
 * declaration, an interface or type member, a plain value binding, an import
 * binding, a re-export specifier — answers false, because there is no body
 * there to read.
 *
 * Only exact grade measures bodies at all, so a file analyzed below it always
 * answers false; a caller that would ACCUSE on the answer must check the grade
 * itself rather than read "no body" into "not measured".
 */
export function hasFunctionBody(facts: SourceFileFacts, symbol: string): boolean {
  return callSitesOf(facts, symbol) !== undefined;
}

/**
 * source_file_facts.resolveImport — resolve one of a file's relative import
 * specifiers against a set of known source paths, purely (no I/O): join it with
 * the importing file's directory, then try the joined path, `.js` swapped for
 * `.ts` or `.tsx`, the `.ts`, `.tsx` and `.js` extensions, and an index file.
 * Undefined for a bare package specifier or when nothing matches.
 */
export function resolveImport(fromFile: string, specifier: string, knownPaths: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = pathKey(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  const candidates = [
    joined,
    joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx'),
    `${joined}.ts`, `${joined}.tsx`, `${joined}.js`,
    `${joined}/index.ts`, `${joined}/index.js`,
  ];
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  return undefined;
}
