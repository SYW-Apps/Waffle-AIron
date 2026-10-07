import * as path from 'path';
import { typeDialectFor, type TypeDialect } from './type-dialects.js';

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
/**
 * One name a file republishes from another module (source_file_facts
 * reexportBindings): `export { local as exported } from 'from'`, or a star
 * re-export, which republishes every name its module exports under that same
 * name and is written with `*` on both sides.
 */
export interface ReexportBindingFact {
  /** The name this file publishes it under; `*` for a star re-export. */
  exported: string;
  /** The name the module it comes from publishes it under; `*` for a star re-export. */
  local: string;
  /** The module specifier, exactly as written. */
  from: string;
}

/**
 * One name a file publishes BOUND to another name of its own scope, with no
 * module specifier of its own (source_file_facts exportAliases): an export
 * specifier `export { local as exported }`, renamed or not, or an
 * identifier-valued property of an exported top-level object literal —
 * `{ exported: local }` or the shorthand `{ exported }` — which then carries
 * the object's binding name as its `container`. The local name is this file's
 * own declaration, or an import binding that leads on to the module it came
 * from: either way the forwarding is written down, one hop away.
 */
export interface ExportAliasFact {
  /** The name this file publishes: the export specifier's exported name, or the object property's key. */
  exported: string;
  /** The name of this file's own scope it is bound to: a local declaration, or an import binding. */
  local: string;
  /** The exported object literal's binding name, set only for a property alias — what an `exportedVia` handle names. */
  container?: string;
}

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
   * The function whose RESULT the receiver is — set only when the call was
   * written `fn(…).name(…)` with `fn` a plain identifier
   * (`current().updateSpec()` → "current"), and never together with `via`,
   * `field` or `constructed`. Followed through what the code writes down
   * about fn's result (SourceFileFacts.returnTypes): a POSSIBLE origin and
   * never a proven one, and only where the module that type leads to holds a
   * body under the invoked name.
   */
  returnedBy?: string;
  /**
   * The top-level named class whose own method the call sits in — set only
   * when the call was written `this.name(…)` directly inside a method,
   * accessor or constructor of that class (an arrow function keeps `this`; a
   * nested function expression rebinds it and records nothing). A POSSIBLE
   * origin and never a proven one, since a subclass may override the method,
   * and only where the class holds a body under the invoked name.
   */
  enclosingClass?: string;
  /**
   * The receiver written as a CHAIN of property accesses — set only when the
   * call was written `this.<field>.<property>….name(…)`
   * (`this.c.tracker.checkIn()` → ["this", "c", "tracker"]) or
   * `<name>.<property>….name(…)` (`deps.tracker.checkIn()` → ["deps",
   * "tracker"]), and never together with `via`, `field`, `constructed`,
   * `returnedBy` or `enclosingClass`. The shape constructor-injected
   * collaborators take when they arrive as ONE bag object. Followed link by
   * link through what the code DECLARES each link to be — the root's field
   * or annotated type, then each property's declared type on the shape that
   * declares it — and, like every receiver past an import binding, a
   * POSSIBLE origin and never a proven one.
   */
  receiverPath?: string[];
  /**
   * The file this site was READ in, set only when it is not the file these
   * facts describe — a pure re-export barrel carries the sites of the function
   * it publishes. A carried site's bare names and receivers resolve in that
   * file's scope, never in the barrel's.
   */
  from?: string;
}

/**
 * One function-like BODY under its name, with where it is bound — the
 * identity that tells same-named functions in one file apart.
 *
 *   module     (no `container`, no `nested`) a top-level function declaration,
 *              or a function/arrow initializer of a top-level variable: what
 *              the bare name means anywhere in the module's scope.
 *   member     `container` set: a member of a top-level named class, or a
 *              property of an object literal a top-level variable is bound to
 *              (`const store = { save() {} }` → container "store"). Reachable
 *              only through that container, never by the bare name.
 *   nested     `nested` set: any other binding — a function inside a
 *              function, a member of a class or object literal the model
 *              cannot name. A nested body can shadow the bare name in the
 *              scope it sits in, so where one exists the name stays ambiguous.
 */
export interface FunctionBodyFact {
  /** The named class or top-level object literal the body is a member of. */
  container?: string;
  /** True when the body is bound somewhere the model cannot name. */
  nested?: boolean;
  /** The call sites written inside this body alone. */
  sites: CallSiteFact[];
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
 * One parameter of a function as the code declares it: what it is called, what
 * it is annotated with, and whether a caller may leave it out.
 *
 * The TYPE is what makes a RENAME tellable from a dropped parameter —
 * `seed(config: HostConfig)` realized as `bootstrapInstance(cfg: HostConfig)`
 * is one parameter under two names, and matching on names alone reads it as a
 * parameter the code lost. A parameter bound by destructuring has no name to
 * compare, so it records none rather than inventing one: a guess about
 * somebody's signature is worse than silence, exactly as it is for a field.
 */
export interface ParameterFact {
  /** The parameter's name, absent when it is bound by a destructuring pattern instead. */
  name?: string;
  /** The type it is annotated with, exactly as written and whitespace-normalized; absent when the code annotates nothing. */
  type?: string;
  /** Whether a caller may leave it out — marked optional, given a default, or a rest parameter. */
  optional: boolean;
}

/**
 * One route a router function handles, rebuilt from the conditions that guard
 * the branch serving it — the branch's own AND every enclosing one on the path
 * taken, because routers nest: an outer check on the first segment, an inner
 * one on the rest. Reading only the innermost guard would turn every route
 * into `/*` followed by whatever the inner branch happened to check.
 *
 * A segment is the literal the code compares it to, or `*` where nothing
 * constrains it. A leading `*` is usually the segment the listener's mount
 * already guarantees, which the router never re-checks — so it is left open
 * here and completed by whoever knows the mount.
 *
 * Only one idiom is read: a method comparison together with comparisons on the
 * path's split segments and their count. A router written another way yields
 * nothing, and the reader reports that as unread rather than passing it — a
 * check that cannot see a router must say so rather than stay quiet.
 */
export interface RouteFact {
  /** The HTTP method the branch requires. */
  verb: string;
  /** The path's segments in order: the literal compared against, or `*` where nothing constrains it. */
  segments: string[];
  /**
   * Whether the branch pins the number of segments. When it does not, the path
   * may continue past the last one read, so the route covers any longer path
   * with the same leading segments.
   */
  exactLength: boolean;
}

/** How a type shape's members were read: listed by the shape itself, or followed one hop from an alias to the value its shape comes from. */
export type ShapeOrigin = 'declared' | 'derived';

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
  /** How the members were read. */
  origin: ShapeOrigin;
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
   * What each export-from declaration republishes, name by name: a named one
   * with both sides of its rename (`export { a as b } from 'm'` publishes `b`
   * as m's `a`), a star with `*` on both sides. Runtime re-exports only — a
   * type-only one republishes no function. EXACT grade only: it is what lets a
   * reader follow a republished name to the module that wrote it, and a
   * weaker grade leaves it unset rather than guess.
   */
  reexportBindings?: ReexportBindingFact[];
  /**
   * The forwarding bindings the file publishes with no module specifier of
   * its own (see ExportAliasFact): each runtime `export { local as exported }`
   * specifier, renamed or not, and each identifier-valued property of an
   * exported top-level object literal, under that object's binding name.
   * EXACT grade only. The analyzer carries the local name's body onto the
   * published one when the local name settles on exactly one — a module-scope
   * body of this file with no nested same-named one, or an import binding
   * whose module holds one — and leaves the published name bodiless otherwise.
   */
  exportAliases?: ExportAliasFact[];
  /**
   * The type name each named function-like RETURNS, by function name,
   * recorded only where the code settles it: a return annotation naming a
   * type outright (`Promise<T>` unwrapped), else, unannotated, a body whose
   * ONE return statement constructs a plainly named class. Same-named
   * functions that disagree, a generic, union or literal annotation, and
   * several returns record nothing. EXACT grade only. What a `fn().method()`
   * receiver is followed through.
   */
  returnTypes?: Record<string, string>;
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
   * The same call sites, BODY by body, under each function-like's name: one
   * entry per body, carrying WHERE that body is bound (see FunctionBodyFact).
   * EXACT grade only. Where functionCallSites unions every same-named body,
   * this keeps them apart, so an exported facade `save` and the class member
   * `Workspace.save` it forwards to are read as the two functions they are.
   * Which body a NAME means is bodySitesOf's question, and it answers only
   * where the code itself settles it.
   */
  functionBodies?: Record<string, FunctionBodyFact[]>;
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
   * plain type reference or a member-preserving utility (`Pick`, `Omit`,
   * `Partial`, `Required`, `Readonly`) around one, which names the type it
   * wraps: what an initializer INFERS is not what the code
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
   * The type names each PROPERTY of a named shape the file declares is
   * DECLARED with, keyed `<shape>.<property>` — an interface's or a type
   * literal alias's property signatures, and a class's property declarations
   * and constructor parameter properties. EXACT grade only.
   *
   * What a receiver CHAIN (`CallSiteFact.receiverPath`) is followed through:
   * a bag of collaborators handed to a constructor names each one's type
   * exactly here. Read the way `fieldTypes` is, and a property annotated with
   * anything else records nothing.
   */
  memberTypes?: Record<string, string[]>;
  /**
   * The ONE type each type alias NAMES outright, by alias name —
   * `type Contract = Pick<HabitRepository, 'find'>` names HabitRepository,
   * `type Store = SpecStore` names SpecStore. EXACT grade only. Read the way
   * `fieldTypes` is, so a union, an intersection, a literal or any other
   * generic names nothing. The one hop a declared type is followed through
   * when it is an alias of this file.
   */
  aliasTargets?: Record<string, string>;
  /**
   * The interface names each named class's `implements` clause writes, by
   * class name; exact grade only. What lets a receiver whose declared type is
   * an interface written in a shared contracts file be followed to the class
   * that implements it, wherever that class lives — a possible origin, never
   * a proven one, like every declared type.
   */
  implementsClauses?: Record<string, string[]>;
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
   * The parameter lists of each named function-like in the file, by name (see
   * ParameterFact) — what lets a contract's declared `params` be checked
   * against the signature that realizes them, the last of the three
   * code-to-spec readings nothing had ever made. EXACT grade only: below it a
   * parameter list cannot be told from a call.
   *
   * EVERY body under a name is kept, not the first: a file routinely holds a
   * class member and the module-level facade that forwards to it under one
   * name, with different parameters, and picking one silently drops the
   * other's leading argument from view. Same-named bodies therefore keep every
   * candidate, exactly as the field-type facts do, and a reader accuses only
   * what all of them agree on.
   *
   * Overloads record the IMPLEMENTATION signature, the one with a body,
   * because that is the one a caller actually reaches — and a name with no
   * entry at all has no signature here to read, which is the silence a
   * forwarding file owes: that the body is not here is already
   * `methodRealization`'s finding.
   */
  functionParams?: Record<string, ParameterFact[][]>;
  /**
   * The routes each named function-like in the file handles, by name (see
   * RouteFact) — what lets a listener's mount be read against the contract
   * endpoints of the portal it serves, so a route the router answers that no
   * contract declares cannot go unnoticed again. EXACT grade only: reading a
   * guard as a route needs the conditions as expressions, not as text.
   *
   * A function with no recognisable route records NO entry rather than an
   * empty one — an empty guess would read as "a router with no routes", and
   * the reader needs to tell a router it could not read from one it read.
   * Same-named bodies union their routes; nested NAMED functions carry their
   * own entries, while anonymous callbacks count into the enclosing one.
   */
  functionRoutes?: Record<string, RouteFact[]>;
  /**
   * The named function-likes in the file that complete LATER — declared
   * `async`, or annotated to return a Promise — listed once per such BODY, in
   * the order the bodies are met, exactly as `functionParams` keeps one
   * signature per body. A name with several bodies (a class member and the
   * module-level facade forwarding to it) is therefore judged on what they ALL
   * say: as many entries as signatures is every body, none is no body. What
   * ASYNC_MISMATCH compares a contract method's `async` returns with. EXACT
   * grade only: below it a body cannot be told from a call.
   */
  asyncFunctions?: string[];
  /**
   * The values of each ENUM-LIKE declaration in the file, by declaration name,
   * in declared order: a string-literal union alias (`type E = 'a' | 'b'`),
   * the string array a `z.enum([...])` constant holds — an alias
   * `z.infer<typeof X>` followed one hop, as a derived shape is — or a string
   * enum's member values. What UNREALIZED_ENUM_VALUE and UNDECLARED_ENUM_VALUE
   * read. EXACT grade only; a union mixing in anything but string literals is
   * not enum-like and is left out.
   */
  enumValues?: Record<string, string[]>;
  /**
   * The right side of each TYPE ALIAS the file declares, as written, by alias
   * name — every alias whose right side is not an object shape
   * (`type PackPath = string`). What a named scalar's holds is compared with
   * through the file's dialect (TYPE_HOLDS_MISMATCH). EXACT grade only.
   */
  aliasTypes?: Record<string, string>;
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
  /**
   * Every call expression of the file as the TypeScript type checker resolved
   * it (see ResolvedCallFact), in source order. EXACT grade only, and only
   * where a compiler with a type checker was loaded. What the Portal
   * write-shortcut twin and the unnarrated-write check read first: the
   * checker follows every spelling of a receiver to the declaration, where
   * the shape facts follow the spellings they know.
   */
  resolvedCalls?: ResolvedCallFact[];
}

/**
 * One place a call the type checker resolved can land in THIS project's code:
 * the file holding the declaration (or an implementor of it), the class,
 * interface or shape it is a member of, and the member's name. A declaration
 * in a dependency's typings or the language's own library is no target — it
 * is nobody's component.
 */
export interface CallTargetFact {
  /** Canonical project-relative path of the file holding the declaration or implementor. */
  path: string;
  /** The class, interface or named shape the member belongs to; absent for a module-level function. */
  container?: string;
  /** The declared name of the method or function the call reaches. */
  member: string;
  /**
   * `declaration` when the checker named this declaration itself;
   * `implementor` when the declaration sits in an interface or type shape and
   * this is a class of the project that realizes it.
   */
  via: 'declaration' | 'implementor';
}

/**
 * One call expression of a file as the TypeScript type checker resolved it:
 * what was invoked, how it was written, which body it sits in, and every
 * place in this project it can land. Where CallSiteFact records the SHAPE a
 * pure model can follow, this records the checker's answer — so a receiver
 * reached through an alias, a field chain, an element access, a destructured
 * method, a factory's result, a barrel or a port interface lands where the
 * checker says it lands, whatever its spelling.
 */
export interface ResolvedCallFact {
  /** The invoked name: the declared member a target names, else the name as written. */
  name: string;
  /** The callee as written, whitespace-collapsed and shortened — what a finding quotes. */
  written: string;
  /** The innermost named function-like the call sits in; absent at module scope. */
  enclosing?: string;
  /** The top-level class or object literal whose member that function-like is, when it is one. */
  enclosingContainer?: string;
  /** Every place in this project's own code the call can land; empty for a call into a dependency or the language library. */
  targets: CallTargetFact[];
  /**
   * True when the checker resolved the callee to no declaration at all
   * because its receiver (or the callee itself) is typed any, unknown or not
   * at all — neither a landing nor its absence means anything.
   */
  unresolved?: boolean;
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
  /**
   * The package specifiers that name a package of THIS repository, each
   * mapped to the canonical source file it resolves to: the root package and
   * every workspace package the root package.json declares (never
   * node_modules), `name` for the main entry and `name/sub` for each plain
   * subpath export, build entries mapped back to their source through the
   * package's tsconfig outDir/rootDir. What lets a package import resolve like
   * a relative one; a third-party specifier is in no entry and resolves to
   * nothing. Absent or empty when the repository declares no packages.
   */
  packages?: Record<string, string>;
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
 * source_file_facts.memberTypesOf — the type names a property of a named
 * shape this file declares is DECLARED with, or EMPTY when the file declares
 * no such shape or property, annotates it with nothing, or was analyzed below
 * exact grade. The empty answer keeps an unresolvable link of a receiver
 * chain from becoming a guess.
 */
export function memberTypesOf(facts: SourceFileFacts, shape: string, property: string): string[] {
  return ownEntry(facts.memberTypes, `${shape}.${property}`) ?? NO_DECLARED_TYPES;
}

/**
 * source_file_facts.aliasTargetOf — the type a type alias this file declares
 * names outright, or undefined when the name is no such alias or its right
 * side names no single type.
 */
export function aliasTargetOf(facts: SourceFileFacts, name: string): string | undefined {
  return ownEntry(facts.aliasTargets, name);
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

/** The bodies one name resolved to, and an identity a walk can de-duplicate on. */
export interface ResolvedBody {
  /** `<container>.<name>` for a member, `<name>` for the module binding, `*<name>` for the union. */
  key: string;
  sites: CallSiteFact[];
}

/**
 * source_file_facts.bodySitesOf — the call sites of the ONE body a name
 * means, told apart from its same-named neighbours by where each is bound;
 * undefined when the file holds no body under the name.
 *
 * `container` and `member` are what the reference says about its owner:
 * `container` is an anchor's `exportedVia` handle or a call's plain-identifier
 * receiver, and `member` says the reference was written through a receiver at
 * all. Only the code
 * settles which body a name means, and where it does not this answers what
 * the name-keyed union always answered — never a guess:
 *
 *   - with a container the file binds bodies of this name under, those bodies;
 *   - else a BARE reference (an anchor's symbol, a bare call) means the
 *     module-scope bodies, when the name has some and NO nested one: a bare
 *     name in the module's scope binds the top-level declaration, a member is
 *     reachable only through its container, and a nested body could shadow
 *     the name where it sits;
 *   - else every body under the name, unioned, as callSitesOf answers — a
 *     receiver the file binds no container to holds a value the model cannot
 *     follow, so which body it reaches is not this model's to say.
 */
export function bodySitesOf(
  facts: SourceFileFacts,
  fn: string,
  container?: string,
  member = false,
): ResolvedBody | undefined {
  const union = callSitesOf(facts, fn);
  if (!union) return undefined;
  const bodies = ownEntry(facts.functionBodies, fn);
  if (!bodies?.length) return { key: `*${fn}`, sites: union };
  const sitesOf = (picked: FunctionBodyFact[]): CallSiteFact[] => picked.flatMap(b => b.sites);
  if (container !== undefined) {
    const members = bodies.filter(b => b.container === container);
    if (members.length) return { key: `${container}.${fn}`, sites: sitesOf(members) };
  }
  if (!member) {
    const moduleScope = bodies.filter(b => b.container === undefined && !b.nested);
    if (moduleScope.length && !bodies.some(b => b.nested)) return { key: fn, sites: sitesOf(moduleScope) };
  }
  return { key: `*${fn}`, sites: union };
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

/** The language each source extension is analyzed as — the analyzer's language keys. */
const EXTENSION_LANGUAGE: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.cs': 'csharp', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift',
};

/**
 * The language a source file is analyzed as, read from its extension; undefined
 * for a file no analyzer reads. The one table the analyzer and the implementer
 * briefs share, so a brief's type mapping is the dialect its code is judged by.
 */
export function languageOfSourcePath(sourcePath: string): string | undefined {
  return EXTENSION_LANGUAGE[path.extname(sourcePath).toLowerCase()];
}

/**
 * source_file_facts.dialect — the type dialect shipped for the language this
 * file was analyzed as (type_dialect.forLanguage of its effective language),
 * or null when the file has no language or no dialect reads it yet. What a
 * conformance rule reads this file's type annotations through; a null answer
 * is silence, never a finding.
 */
export function dialectOf(facts: SourceFileFacts): TypeDialect | null {
  return facts.language ? typeDialectFor(facts.language) : null;
}

/**
 * The type name a named function-like returns, where the code settles it
 * (SourceFileFacts.returnTypes); undefined otherwise — the silence a
 * `fn().method()` receiver keeps when the code does not say what fn returns.
 */
export function returnTypeOf(facts: SourceFileFacts, fn: string): string | undefined {
  return ownEntry(facts.returnTypes, fn);
}

/**
 * source_file_facts.resolveImport — resolve one of a file's import specifiers
 * against a set of known source paths, purely (no I/O). A relative one: join
 * it with the importing file's directory, then try the joined path, `.js`
 * swapped for `.ts` or `.tsx`, the `.ts`, `.tsx` and `.js` extensions, and an
 * index file. A package specifier: the source file `packages` (the code
 * model's local-package map) names for it, when that file is known.
 * Undefined for a package the map does not name — a third-party one — or
 * when nothing matches.
 */
export function resolveImport(
  fromFile: string,
  specifier: string,
  knownPaths: Set<string>,
  packages?: Readonly<Record<string, string>>,
): string | undefined {
  if (!specifier.startsWith('.')) {
    const mapped = ownEntry(packages, specifier);
    return mapped !== undefined && knownPaths.has(mapped) ? mapped : undefined;
  }
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
