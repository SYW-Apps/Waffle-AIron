import { defaultConformanceTier, importBindingOf, pathKey, resolveImport, routerLinkage, type ClassMemberFact, type FunctionBodyFact, type SourceFileFacts } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

/** The bodies a file holds under a name, each with the class or object literal it is a member of. */
function ownBodies(facts: SourceFileFacts, name: string): FunctionBodyFact[] {
  return facts.functionBodies && Object.prototype.hasOwnProperty.call(facts.functionBodies, name) ? facts.functionBodies[name] : [];
}

// ---------------------------------------------------------------------------
// Code↔spec for the SURFACE: what does a file publish that nobody promised?
//
// Every other conformance rule reads contract→code — it takes a spec and asks
// whether the code holds what the spec claims. Read only that way, a file may
// export whatever it likes under a component's name and nothing looks: the
// contract is satisfied by the methods it named, and the rest of the module's
// published surface is invisible to the gate. This rule reads the other way,
// over one relation — a name a file PUBLISHES that no contract of the
// components it realizes ever declared, and a file realizing a DIFFERENT
// component that IMPORTS it FROM HERE.
//
// Five decisions make that a finding rather than a flood, and a true one:
//
//  1. CANDIDATES ARE NOT FINDINGS. An undeclared export that only its own
//     file's components use is that module's private factoring — a helper, a
//     constant, a type guard — and none of the design's business. Reporting
//     every one of them names ~304 exports in wairon's own tree, most of them
//     internal. A finding needs a TAKER FROM OUTSIDE; that is the whole
//     difference between a surface and a module's own shape.
//
//  2. THE TAKER MUST NAME THIS FILE. Each import binding is kept only when
//     its OWN module specifier resolves to the accused file. Matching the
//     word alone was the cheaper reading, and it accused a module because
//     somebody elsewhere in the tree happened to bind the same name from
//     somewhere else — 30 of 195 crossings in this tree rested on nothing but
//     a collision. An accusation that cannot name the import it rests on is
//     not one. This is also what settles the BARREL: a re-export is surface
//     republication, not a runtime import, so a barrel is accused only for the
//     names a consumer genuinely takes from the barrel, and a name taken from
//     the deeper module is that module's finding.
//
//  3. OVERLAP, NOT SUBSET. A file realizes every component whose
//     implementations name it, and a consumer has crossed a boundary only
//     when it realizes NONE of them. Asking instead that every owner match
//     reports a crossing wherever two files merely differ in HOW MUCH they
//     hold — a file realizing eleven components shares each of them with a
//     different neighbour — and two files realizing the same component are
//     that component's own implementation spread over two files, which the
//     source-path model has always allowed.
//
//     The `owns` relation draws that fence one hop wider. A pattern
//     CONSTRUCTS the blocks it owns — a Repository builds its Store, Registry
//     and Index — so the owner's file importing a member's class is the owns
//     relation made real, and so is one member of a pattern reaching for a
//     sibling member's. Neither is a surface reached from outside.
//
//  4. EXACT GRADE ONLY, at both ends. Below it nothing separates an export
//     from a mention, and no binding records which LOCAL NAME a module
//     specifier bound — so a weaker grade could neither name the surface nor
//     name who took it. Both ends are read from the same closed set of files
//     the implementations name, because a file no spec points at realizes no
//     component and so can cross no boundary.
//
//  5. ONE FILE, ONE FINDING. Crossings are reported per FILE with every
//     crossed name in `covers`, so the debt register carries each crossing
//     rather than the sentence that happens to list them. A file has no spec
//     of its own, so the finding lands on an implementation that NAMES it —
//     the first by sorted id when several do, which keeps one crossing one
//     finding instead of one per owner. Carryable, because this measures
//     code-to-spec drift — a surface that grew past its contract — and not a
//     design that is illegal as written.
//
// A method may also DECLARE the export a consumer imports to REACH it:
// `exportedVia`, which `symbol` cannot say because `symbol` names the
// function INSIDE. Every rule module in this tree is that shape — the file
// publishes `callConformanceRule` and the contract method is the `check` in
// it — and without the handle each of them publishes a name no contract
// mentions, leaving a suppression as the only true answer, which is how a
// rule teaches its users to suppress. The declaration is not a waiver: a
// handle the file does not actually export is REPORTED and allows nothing,
// because a route nobody can import cannot be why a name is promised, and a
// field that allowed one would be a free-text way to go quiet.
//
// A Portal implementation's `router` is the same kind of declaration from the
// other side: it names the router entry whatever serves the Portal calls to
// hand it its requests (`handleWebRequest`, which the host's router imports
// from the web portal's file). Unmodelled, every such entry was a crossing no
// contract described and had to be carried as debt; declared, it is promised
// surface of the Portal's own files, held to the same honesty — an entry none
// of them exports is reported against the implementation that named it.
//
// The data model is not re-litigated here. A type's own declaration and its
// pure methods are surface the design DID promise from those same files;
// whether the file actually publishes them is `typeRealization`'s question,
// and this rule only needs to stop reporting its answers a second time. A
// barrel that re-exports a type's pure method publishes that same promised
// name — a method travels with its type — so the republication is promised too.
//
// A namespace import (`import * as webadmin from …`) binds the whole module,
// and the BINDING names no export of it. The CALL does: `webadmin.setSecret(…)`
// names the export `setSecret` exactly as `import { setSecret }` would, and the
// analyzer records the receiver of every member call, so a namespace import
// takes each name the file calls through it. A namespace bound and never
// called through takes nothing, because nothing names what it reaches — it is
// read as taking what it provably names rather than everything or nothing.
// Reading the binding alone once kept this rule blind to the whole of
// `web.ts`, which reaches all four of its orchestrators through namespace
// imports; `webadmin.setSecret` was declared by no contract at either layer
// and nothing fired.
// ---------------------------------------------------------------------------

/** The answer for a file whose components promised nothing at all. */
const NOTHING_PROMISED: ReadonlySet<string> = new Set<string>();

/**
 * Member names a framework or the language calls on an instance by
 * convention — lifecycle hooks and protocol methods. A class declares them
 * because something other than a caller of the design invokes them, so they
 * are no verb a contract could declare.
 */
const IMPOSED_MEMBERS = new Set([
  // the language's own protocols
  'toString', 'toJSON', 'valueOf', 'toLocaleString', 'then', 'catch', 'finally', 'inspect', 'dispose', 'asyncDispose',
  // web components and Lit
  'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback', 'adoptedCallback', 'render', 'firstUpdated', 'updated', 'willUpdate', 'shouldUpdate',
  // React class components
  'componentDidMount', 'componentDidUpdate', 'componentWillUnmount', 'shouldComponentUpdate', 'getSnapshotBeforeUpdate', 'componentDidCatch',
  // Angular
  'ngOnInit', 'ngOnDestroy', 'ngOnChanges', 'ngDoCheck', 'ngAfterContentInit', 'ngAfterContentChecked', 'ngAfterViewInit', 'ngAfterViewChecked',
  // NestJS
  'onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown', 'beforeApplicationShutdown',
]);

/** A test file: what a project ships to check its code, never a component's surface. */
const TEST_FILE = /(?:^|\/)(?:__tests__|tests?|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]*\.py$|_test\.py$|(?:^|\/)conftest\.py$/;

/** Whether a member is surface a contract could declare: public, an instance verb, named, and no convention's. */
function isPublicVerb(member: ClassMemberFact): boolean {
  return member.kind === 'method' && member.access === 'public' && !member.static && !member.override && !member.computed
    && !member.name.startsWith('_') && !IMPOSED_MEMBERS.has(member.name);
}

export const exportConformanceRule: SddRule = {
  name: 'export-conformance',
  judges: 'code',
  description:
    "Code-to-contract for the SURFACE: does this file publish anything the components it realizes never promised, that another component then takes? The rest of the conformance set reads contract-to-code (it asks whether the code holds what a spec claims), so a file could export whatever it liked under a component's name and nothing looked. That is one half of the same hole as a contract promising a parameter it never passes. A method's `exportedVia` names the export a consumer imports to REACH it: the value that composes it, which `symbol` cannot name because `symbol` names the function inside. A Portal implementation's `router` names the entry whatever serves the Portal calls to hand it its requests — in the Portal's own files, or, written `<module>#<name>`, in the module it names, which must export that name (a module named alone must be on disk); an entry that is a class's method is written `Class.method` (`<module>#Class.method` in another module), and the class is then the export, which must hold the method. Both are declared publication, and a declared handle the file does not actually export is itself a finding, so naming one can never become a free-text suppression. Both questions are asked only of a file read at exact grade, and a taker counts only when its own import specifier resolves to the file it is accused of taking from: below that nothing separates an export from a mention, or a shared word from a shared module. A taker inside the owns fence is no crossing: a pattern constructs the blocks it owns, so the owner's file, or another member of the same pattern, importing a member's class is the owns relation made real. Nor is a declared dependent taking a class that realizes the component it depends on (a class holding one of its modelled methods): constructing it, or receiving it injected under its class (a decorator-metadata token), is the dependsOn edge made real. Taken by a component with no such dependency it still crosses, an owned member\'s class above all. And the surface no taker reveals: a public method of a component's REALIZING class — a class holding one of its modelled methods — or a function its realizing file exports, that no contract of the components the file realizes declares (nor a `symbol`, `exportedVia`, `router` or type of it) and that NOTHING in the project uses — no call or reference in its own file, no name another analyzed file writes, no identifier in a project file the run did not analyze (its tests, a composition root), no star re-export publishing the module on — is UNDECLARED_PUBLIC_MEMBER: a verb the code added that no design, brief or caller explains. Used, it is the module's factoring (a helper the class calls, a facade forwarding to it, a function its tests import), or, taken by another component, UNDECLARED_EXPORT. Exempt: constructors, accessors and fields, static, private, protected, #private and underscore-prefixed members, an `override`, a computed name, a language protocol or framework lifecycle hook (toString, toJSON, then, render, connectedCallback, componentDidMount, ngOnInit, onModuleInit and their kin), a Python dunder, test files, and an implementation whose conformance dial is off. Read at exact grade, or by a reader that reads class members (Python, where a leading underscore is private). An exported CLASS is judged the same way: a top-level class the realizing file exports beside the classes realizing a component, that no contract or type declares and that nothing uses — its own file naming it nowhere outside its own declaration (constructed, extended, annotated with, tested by instanceof or isinstance, passed on: source_file_facts.classReferences), no other analyzed file naming it, no identifier of a file the run did not analyze, no star re-export publishing the module on — is UNDECLARED_PUBLIC_MEMBER too; its own methods naming it (a static factory) are no use. The finding names the files that took each name as well as the one publishing it: an import that no declared relation justifies is UNDECLARED_DEPENDENCY on the importer besides, a different fact — who reached across, where this is what crossed.",
  codes: [
    {
      code: 'UNDECLARED_PUBLIC_MEMBER',
      defaultSeverity: 'warning',
      summary: "A component's realizing class has a public method, or its realizing module an exported function or class, that no contract of the components it realizes declares and nothing in the project uses — a verb the code added that the design never promised",
      carryable: true,
    },
    {
      code: 'UNDECLARED_EXPORT',
      defaultSeverity: 'warning',
      summary: 'A file realizing a component exports a name no contract of that component declares, and a file realizing a DIFFERENT component imports it — a surface reached across a boundary that the design never promised',
      // Measured code-to-spec drift at a site the finding names, so the
      // debt register may carry it — which is why it hands over `parts`.
      carryable: true,
    },
    {
      code: 'UNREALIZED_EXPORT_HANDLE',
      defaultSeverity: 'warning',
      summary: "A declared publication handle (a method's `exportedVia`, or a Portal implementation's `router`) names an export its own source file does not have: the spec names a route to the code that nobody can import",
      // Deliberately NOT carryable, and so it hands over no `parts`: a wrong
      // handle is one string to correct, and a parking space for it could
      // only ever be a parking space for a lie.
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();
    const ownership = ctx.ownershipIndex();

    // ---- 1. what the components a file realizes legitimately answer to ----
    // A file may realize several components — wairon's own MCP server file
    // realizes eleven — so what they answer to UNIONS rather than competes.
    const promised = new Map<string, Set<string>>();
    const promise = (file: string, name: string | undefined): void => {
      if (!name) return;
      const key = pathKey(file);
      let names = promised.get(key);
      if (!names) promised.set(key, (names = new Set<string>()));
      names.add(name);
    };

    for (const file of realization.paths) {
      for (const component of realization.componentsAt(file)) {
        // The contracts: every method the design declares on this component.
        for (const method of ctx.interfaceMethodsOf(component.id)) promise(file, method.name);
        // The implementations: each method's own name, and the per-method
        // `symbol` that binds a code-level name onto the contract name.
        for (const impl of realization.implementationsOf(component.id)) {
          for (const method of impl.methods ?? []) {
            promise(file, method.name);
            promise(file, method.symbol);
          }
        }
      }
    }

    // ---- 2. the handles the design declares, and the ones nothing exports ----
    // A handle is the export a consumer imports to REACH a method, which
    // `symbol` cannot name because `symbol` names the function inside it. A
    // handle the file does not actually export is reported instead of
    // allowed: a route nobody can import cannot be the reason a name is
    // promised, and allowing it anyway would make the field a free-text way
    // to silence the rule. Below exact grade nothing tells an export from a
    // mention, so neither half can be read honestly — and such a file is
    // never reported on (step 5), so nothing turns on allowing it there.
    for (const { implementation, method, sourceFile, draftContext } of ctx.implementationMethods()) {
      const handle = method.exportedVia;
      if (!handle || !sourceFile) continue;
      const file = pathKey(sourceFile);
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      if (facts.exportedNames.includes(handle)) {
        promise(file, handle);
        continue;
      }
      ctx.addIssue(
        'warning',
        'UNREALIZED_EXPORT_HANDLE',
        `Method "${method.name}" in implementation "${implementation.id}" declares exportedVia "${handle}", but `
        + `"${file}" exports no such name. A handle names the export a consumer imports to REACH the method — the `
        + 'value that composes it, which `symbol` cannot name because `symbol` names the function inside — so one '
        + 'the file does not publish promises a route nobody can import. It allows nothing either: every export '
        + 'of this file is still read against the contracts. Name the binding the file actually exports, export '
        + 'it, or drop the handle.',
        implementation.id,
        draftContext,
      );
    }

    // The other handle kind: a Portal implementation's `router`, the entry
    // whatever serves the Portal calls to hand it its requests. It is
    // published by the Portal's own files — the composition root only imports
    // it — so it is promised there, and reported against the implementation
    // that declares it. A portal may be realized across several files and any
    // one of them may hold the entry, so a verdict of "nobody exports it"
    // needs every one of them read at exact grade: a file below that, or never
    // read, might be the one, and a finding resting on it could not be backed.
    for (const implementation of ctx.implementations) {
      const handle = implementation.router;
      if (!handle) continue;
      const contract = ctx.interfaceMap.get(implementation.contract);
      const portal = contract ? ctx.componentMap.get(contract.component) : undefined;
      if (!portal || portal.componentType !== 'Portal' || ctx.isInChainedSubproject(portal.subsystem)) continue;
      // A linkage naming a module of its own (`routes.ts#ROUTES`, or the
      // module alone) is published by THAT module: the name must be one of its
      // exports, and a module named alone must be there to read.
      const linkage = routerLinkage(handle);
      // A class's method (`Class.method`) is reached through the class it is
      // a member of: the class is the export, and it must hold the method.
      const exported = linkage.owner ?? linkage.name;
      const publishes = (facts: SourceFileFacts): boolean => exported !== undefined && facts.exportedNames.includes(exported)
        && (linkage.owner === undefined || ownBodies(facts, linkage.name as string).some(body => body.container === linkage.owner));
      const entryTold = linkage.owner !== undefined ? `a class "${linkage.owner}" with a method "${linkage.name}"` : `"${linkage.name}"`;
      if (linkage.file) {
        const file = pathKey(linkage.file);
        const facts = code.factsAt(file);
        const missing = !facts || facts.status === 'missing';
        const exactHere = !!facts && facts.status === 'analyzed' && facts.analysisGrade === 'exact';
        if (!missing && (!exactHere || linkage.name === undefined || publishes(facts!))) continue;
        ctx.addIssue(
          'warning',
          'UNREALIZED_EXPORT_HANDLE',
          `Portal "${portal.id}" names its router "${handle}" (implementation "${implementation.id}"), but `
          + (missing ? `"${file}" is not on disk.` : `"${file}" exports no ${entryTold}.`)
          + (missing && /^[A-Z][A-Za-z0-9_$]*$/.test(file) && linkage.name !== undefined && linkage.owner === undefined
            ? ` A class's method is written with a dot, not a \`#\`: \`${file}.${linkage.name}\` (and \`<module>#${file}.${linkage.name}\` in another module).`
            : '')
          + ' A `router` names the entry or the route table whatever serves the Portal hands its requests to, so one '
          + 'nobody can import promises a route nobody can reach, and it allows nothing either. Name an export the '
          + 'module actually has, or drop `router` if the Portal is served method by method.',
          implementation.id,
          ctx.isImplementationDraft(implementation) || ctx.isComponentDraft(portal.id),
        );
        continue;
      }
      const files = realization.filesOf(portal.id).map(pathKey);
      const exact = files.filter(file => {
        const facts = code.factsAt(file);
        return !!facts && facts.status === 'analyzed' && facts.analysisGrade === 'exact';
      });
      const exporters = exact.filter(file => publishes(code.factsAt(file)!));
      for (const file of exporters) {
        promise(file, exported);
        if (linkage.owner !== undefined) promise(file, linkage.name);
      }
      if (exporters.length > 0 || exact.length === 0 || exact.length < files.length) continue;
      // What the name IS in those files, where it is there at all: a method
      // of an exported class (named `Class.method`), or a declaration no
      // export publishes (export it first).
      const plain = linkage.owner === undefined ? linkage.name as string : undefined;
      const classes = plain === undefined ? [] : [...new Set(exact.flatMap(file => ownBodies(code.factsAt(file)!, plain)
        .flatMap(body => (body.container !== undefined && !body.nested && code.factsAt(file)!.exportedNames.includes(body.container) ? [`${body.container}.${plain}`] : []))))].sort();
      const declaredHere = plain !== undefined && classes.length === 0 && exact.some(file => code.declarationsAt(file).has(plain));
      const hint = classes.length > 0
        ? ` "${plain}" is a method of an exported class there: name it ${classes.map(spelling => `\`${spelling}\``).join(' or ')}.`
        : declaredHere ? ` "${plain}" is declared there but not exported: export it to name it.` : '';
      ctx.addIssue(
        'warning',
        'UNREALIZED_EXPORT_HANDLE',
        `Portal "${portal.id}" names its router "${handle}" (implementation "${implementation.id}"), but `
        + `${files.map(f => `"${f}"`).join(', ')} — the file(s) realizing "${portal.id}" — export no ${linkage.owner !== undefined ? entryTold : 'such name'}.${hint} A `
        + '`router` names the entry whatever serves the Portal calls to hand it its requests, published by the '
        + 'portal\'s own files, so one they do not publish promises a route nobody can import. It allows nothing '
        + 'either: every export of those files is still read against the contracts. Name the entry the portal\'s '
        + 'file actually exports (a class\'s method as `Class.method`), export it, or drop `router` if the Portal is served method by method.',
        implementation.id,
        ctx.isImplementationDraft(implementation) || ctx.isComponentDraft(portal.id),
      );
    }

    // ---- 3. what the data model publishes from those same files ----
    const typeMethodsAt = new Map<string, Set<string>>();
    for (const type of ctx.types) {
      if (!type.sourcePath) continue;
      promise(type.sourcePath, type.symbol ?? type.name);
      for (const method of type.methods ?? []) {
        const at = pathKey(method.sourcePath ?? type.sourcePath);
        const name = method.symbol ?? method.name;
        promise(at, name);
        let names = typeMethodsAt.get(at);
        if (!names) typeMethodsAt.set(at, (names = new Set<string>()));
        names.add(name);
      }
    }

    // A barrel that re-exports a modelled type's pure method republishes the
    // same promised name: a method travels with its type, so a module that
    // hands out the value may hand out its arithmetic beside it. Only the
    // TYPE's methods travel this way — a contract method re-exported from a
    // sibling component's file is that component's surface, not this one's,
    // and stays a crossing. Read at exact grade, from the re-export bindings
    // the analyzer records (a star republishes every method of the module).
    for (const file of realization.paths) {
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      for (const binding of facts.reexportBindings ?? []) {
        const target = resolveImport(file, binding.from, code.paths, code.packages);
        const methods = target ? typeMethodsAt.get(target) : undefined;
        if (!methods) continue;
        if (binding.local === '*') {
          for (const name of methods) promise(file, name);
        } else if (methods.has(binding.local)) {
          promise(file, binding.exported);
        }
      }
    }

    // ---- 6. who takes a published name, and FROM WHICH FILE ----
    // Built once over every analysed realizing file, because the walk is the
    // same whatever the candidate: each binding's own module specifier is
    // resolved against the closed set of analysed paths, and the binding is
    // filed under the file it LANDS in. A name is not taken from here merely
    // because somebody elsewhere binds the same word.
    //
    // Both spellings of a kept binding count: the LOCAL name it introduced,
    // and `imported` — the name the module published it under when the import
    // renamed it — because a rename hides the published name behind the local
    // one and either way the same file reached for the same surface.
    //
    // A namespace binding takes nothing by itself — it names no export — but
    // each call written THROUGH it names one: `webadmin.setSecret(…)` against
    // `import * as webadmin` takes `setSecret` exactly as a named import would.
    // A namespace bound and never called through therefore takes nothing.
    //
    // A site a re-export barrel CARRIES (`from` set) was written in another
    // file, and its receiver is a binding of THAT file's scope, never the
    // barrel's — so it is resolved there, against the imports and the
    // directory of the file that wrote it, and skipped when that file's facts
    // are not in hand. It is still taken BY the barrel: the barrel publishes
    // the body as its own, so the components it realizes are the ones that
    // reached through the namespace.
    const takenFrom = new Map<string, Map<string, Set<string>>>();
    const take = (consumer: string, writtenIn: string, specifier: string, names: (string | undefined)[]): void => {
      const target = resolveImport(writtenIn, specifier, code.paths, code.packages);
      if (!target) return;
      let byName = takenFrom.get(target);
      if (!byName) takenFrom.set(target, (byName = new Map<string, Set<string>>()));
      for (const name of names) {
        if (!name) continue;
        let takers = byName.get(name);
        if (!takers) byName.set(name, (takers = new Set<string>()));
        takers.add(consumer);
      }
    };
    for (const consumer of realization.paths) {
      if (!code.exactPaths.has(consumer)) continue;
      const facts = code.factsAt(consumer);
      if (!facts) continue;
      const typeUsedOnly = new Set(facts.typePositionOnlyBindings ?? []);
      for (const [local, binding] of Object.entries(facts.importBindings ?? {})) {
        if (binding.namespace) continue;
        // A value import used only where a type goes (constructor injection
        // annotated with the class) is erased: a type import, taking nothing.
        if (typeUsedOnly.has(local)) continue;
        take(consumer, consumer, binding.from, [local, binding.imported]);
      }
      for (const sites of Object.values(facts.functionCallSites ?? {})) {
        for (const site of sites) {
          if (!site.member || !site.via) continue;
          const writtenIn = site.from ? pathKey(site.from) : consumer;
          const scope = site.from ? code.factsAt(writtenIn) : facts;
          if (!scope) continue;
          const binding = importBindingOf(scope, site.via);
          if (binding?.namespace) take(consumer, writtenIn, binding.from, [site.name]);
        }
      }
    }

    // ---- 13. the public surface no contract declares, and nothing uses ----
    // A component's REALIZING class — the class holding one of its modelled
    // methods — answers to its contracts for every public instance method it
    // has, and its REALIZING module — one holding a modelled method's body —
    // for every function it exports. One no contract
    // declares that something DOES use is the module's own factoring (a
    // helper the class calls, a facade forwarding to it, a function its tests
    // or its wiring import) — none of the design's business, the stance step 1
    // takes — or, taken by another component, the crossing reported above. One
    // that nothing uses at all is a verb the code added that no design, brief
    // or caller explains. Used means named anywhere but its own declaration: a
    // call or a property read in its own file, any name another analyzed file
    // writes, any identifier of a project file the run did not analyze (its
    // tests, a composition root) — a reading that may only ever exempt.
    // Exempt besides: constructors, accessors and fields, static, private,
    // protected, #private and underscore-prefixed members, an `override`, a
    // computed name, a language protocol or framework lifecycle hook, a Python
    // dunder, every name a contract, `symbol`, `exportedVia`, `router` or a
    // type declares, test files, and an implementation whose conformance dial
    // is off. Read at exact grade, or by a reader that reads class members.
    const outside = new Set(ctx.codeModel.outsideNames ?? []);
    /** The names each analyzed file writes, its own declarations included. */
    const writtenIn = new Map<string, Set<string>>();
    const namesWritten = (facts: SourceFileFacts): Set<string> => {
      const key = pathKey(facts.path);
      let names = writtenIn.get(key);
      if (names) return names;
      names = new Set<string>([...facts.declaredNames, ...facts.anchoredNames]);
      for (const sites of Object.values(facts.functionCallSites ?? {})) for (const site of sites) names.add(site.name);
      for (const [local, binding] of Object.entries(facts.importBindings ?? {})) { names.add(local); if (binding.imported) names.add(binding.imported); }
      for (const binding of facts.reexportBindings ?? []) names.add(binding.local);
      for (const call of facts.resolvedCalls ?? []) names.add(call.name);
      writtenIn.set(key, names);
      return names;
    };
    /** The names a file USES of its own: its call sites, property reads and references — never its declarations. */
    const usedHere = (facts: SourceFileFacts, candidate: string, cls: string | undefined): boolean => {
      for (const [fn, bodies] of Object.entries(facts.functionBodies ?? {})) {
        for (const body of bodies) {
          // The candidate's own body calling itself is no use.
          if (fn === candidate && body.container === cls) continue;
          if (body.sites.some(site => site.name === candidate)) return true;
        }
      }
      if (facts.analysisGrade === 'exact' && facts.anchoredNames.includes(candidate)) return true;
      return (facts.resolvedCalls ?? []).some(call => call.name === candidate && !(call.enclosing === candidate && call.enclosingContainer === cls));
    };
    /** The modules a star re-export republishes whole: every export of theirs is published on, a library's surface. */
    const starRepublished = new Set<string>();
    for (const facts of ctx.codeModel.files) {
      for (const binding of facts.reexportBindings ?? []) {
        if (binding.local !== '*') continue;
        const target = resolveImport(pathKey(facts.path), binding.from, code.paths, code.packages);
        if (target) starRepublished.add(target);
      }
    }
    const usedAnywhere = (file: string, facts: SourceFileFacts, candidate: string, cls: string | undefined): boolean => {
      if (outside.has(candidate) || usedHere(facts, candidate, cls)) return true;
      if (cls === undefined && starRepublished.has(file)) return true;
      return ctx.codeModel.files.some(other => other.status === 'analyzed' && pathKey(other.path) !== file && namesWritten(other).has(candidate));
    };
    /**
     * Whether anything but the class itself uses an exported class: as
     * usedAnywhere reads a function, except that the class's own methods
     * naming it (a static factory, a clone) are the class talking about
     * itself, never a use.
     */
    const classUsed = (file: string, facts: SourceFileFacts, cls: string): boolean => {
      if (outside.has(cls) || starRepublished.has(file)) return true;
      for (const bodies of Object.values(facts.functionBodies ?? {})) {
        for (const body of bodies) {
          if (body.container === cls) continue;
          if (body.sites.some(site => site.name === cls)) return true;
        }
      }
      if (facts.analysisGrade === 'exact' && facts.anchoredNames.includes(cls)) return true;
      if ((facts.resolvedCalls ?? []).some(call => call.name === cls && call.enclosingContainer !== cls && call.enclosing !== cls)) return true;
      return ctx.codeModel.files.some(other => other.status === 'analyzed' && pathKey(other.path) !== file && namesWritten(other).has(cls));
    };
    for (const file of realization.paths) {
      if (TEST_FILE.test(file)) continue;
      const facts = code.factsAt(file);
      if (!facts || facts.status !== 'analyzed' || !(facts.analysisGrade === 'exact' || facts.reads?.includes('members'))) continue;
      const components = realization.componentsAt(file).filter(c => !ctx.isInChainedSubproject(c.subsystem));
      if (components.length === 0) continue;
      // The modelled methods realized here, by their code names, from implementations whose dial is on.
      const modelled = new Set<string>();
      let judged = false;
      for (const component of components) {
        for (const impl of realization.implementationsOf(component.id)) {
          if (!impl.sourcePath && !impl.methods.some(m => m.sourcePath)) continue;
          const tier = impl.conformance ?? defaultConformanceTier(component);
          if (tier === 'off') continue;
          judged = true;
          for (const m of impl.methods) {
            if (m.conformance === 'off') continue;
            modelled.add(m.symbol ?? m.name);
          }
        }
        for (const m of ctx.interfaceMethodsOf(component.id)) modelled.add(m.name);
      }
      if (!judged) continue;
      const declared = promised.get(file) ?? NOTHING_PROMISED;
      const bodies = facts.functionBodies ?? {};
      const bodiesOf = (name: string): FunctionBodyFact[] => (Object.prototype.hasOwnProperty.call(bodies, name) ? bodies[name] : []);
      const undeclared: string[] = [];
      const unusedClasses = new Set<string>();
      // The realizing classes, and their public verbs.
      const realizing = new Set<string>();
      for (const name of modelled) for (const body of bodiesOf(name)) if (body.container !== undefined && !body.nested) realizing.add(body.container);
      for (const cls of [...realizing].sort()) {
        const members = facts.classMembers && Object.prototype.hasOwnProperty.call(facts.classMembers, cls) ? facts.classMembers[cls] : undefined;
        if (!members) continue;
        for (const member of members) {
          if (!isPublicVerb(member) || /^__\w+__$/.test(member.name)) continue;
          if (declared.has(member.name) || modelled.has(member.name)) continue;
          if (usedAnywhere(file, facts, member.name, cls)) continue;
          undeclared.push(`${cls}.${member.name}`);
        }
      }
      // The realizing module — the file holding a modelled method's body, as a
      // module function or inside its class — and the functions it exports.
      const realizesHere = [...modelled].some(name => bodiesOf(name).length > 0);
      if (realizesHere) {
        for (const name of [...new Set(facts.exportedNames)].sort()) {
          if (name.startsWith('_') || declared.has(name) || modelled.has(name)) continue;
          if (!bodiesOf(name).some(body => body.container === undefined && !body.nested)) continue;
          if (usedAnywhere(file, facts, name, undefined)) continue;
          undeclared.push(name);
        }
        // And the classes it exports beside the realizing ones: a class no
        // contract declares and nothing uses — not named by its own file
        // outside its own declaration, nor by any other — is surface the same
        // way an unused exported function is. Judged only where the reader
        // recorded the file's own class references; silence otherwise.
        const referenced = facts.classReferences ? new Set(facts.classReferences) : undefined;
        const classes = facts.classMembers ?? {};
        for (const name of referenced ? [...new Set(facts.exportedNames)].sort() : []) {
          if (!Object.prototype.hasOwnProperty.call(classes, name) || realizing.has(name)) continue;
          if (name.startsWith('_') || declared.has(name) || modelled.has(name)) continue;
          if (referenced!.has(name) || classUsed(file, facts, name)) continue;
          undeclared.push(name);
          unusedClasses.add(name);
        }
      }
      if (undeclared.length === 0) continue;
      const [owner] = realization.implementationsAt(file).map(impl => impl.id).sort();
      ctx.addIssue(
        'warning',
        'UNDECLARED_PUBLIC_MEMBER',
        `Source file "${file}" realizes ${components.map(c => `"${c.id}"`).join(', ')} and publishes ${undeclared.length} ${unusedClasses.size > 0 ? 'name(s)' : 'verb(s)'} `
        + `no contract of ${components.length === 1 ? 'it' : 'them'} declares — ${undeclared.map(n => `"${n}"${unusedClasses.has(n) ? ' (an exported class)' : ''}`).join(', ')}. `
        + 'Nothing in the project uses them — no call or reference in their own file, no other file naming them, not its tests — '
        + 'so they are no factoring of the realization: each is surface any caller can reach that no brief, review or rule has read, '
        + `${unusedClasses.size > 0 ? 'a verb or a class' : 'a verb'} added in the code alone. Declare it as a contract method (sdd_define_interface, a design change)${unusedClasses.size > 0 ? ' or a type (sdd_add_type)' : ''}, make it private `
        + `(a leading underscore in Python${unusedClasses.size > 0 ? ', no export in TypeScript' : ''}), or take it out.`,
        owner,
        realization.implementationsAt(file).some(impl => ctx.isImplementationDraft(impl)),
        undefined,
        { at: file, covers: undeclared },
      );
    }

    for (const file of realization.paths) {
      const facts = code.factsAt(file);
      // ---- 5. only exact analysis tells an export from a mention ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      const declared = promised.get(file) ?? NOTHING_PROMISED;
      const taken = takenFrom.get(file);
      const owners = new Set(realization.componentsAt(file).map(c => c.id));
      // The fence: the file's own components, the patterns that own any of
      // them, and the other members of those patterns.
      const fence = new Set(owners);
      for (const id of owners) {
        const pattern = ownership.ownerOf(id);
        if (pattern === undefined) continue;
        fence.add(pattern);
        for (const member of ownership.ownedMembers) if (ownership.ownerOf(member) === pattern) fence.add(member);
      }
      // The classes realizing each of the file's components — a class holding
      // one of its modelled methods — are the component itself in code: its
      // declared dependent constructs it, or receives it injected under its
      // class (a decorator-metadata token), which is the dependsOn edge made
      // real, not a surface reached across. Taken by anyone else it still
      // crosses, an owned member's class above all.
      const realizedBy = new Map<string, Set<string>>();
      const bodies = facts.functionBodies ?? {};
      for (const id of owners) {
        const modelled = new Set(ctx.interfaceMethodsOf(id).map(m => m.name));
        for (const impl of realization.implementationsOf(id)) for (const m of impl.methods ?? []) modelled.add(m.symbol ?? m.name);
        for (const name of modelled) {
          if (!Object.prototype.hasOwnProperty.call(bodies, name)) continue;
          for (const body of bodies[name]) {
            if (body.container === undefined || body.nested) continue;
            let ids = realizedBy.get(body.container);
            if (!ids) realizedBy.set(body.container, (ids = new Set<string>()));
            ids.add(id);
          }
        }
      }
      /** Whether a component of the taker declares a dependency on a component the class realizes. */
      const dependentTakes = (taker: string, name: string): boolean => {
        const realized = realizedBy.get(name);
        if (!realized) return false;
        return realization.componentsAt(taker).some(c => (ctx.componentMap.get(c.id)?.dependsOn ?? []).some(dep => realized.has(dep)));
      };
      const crossed: string[] = [];
      // Who took them, so the finding names the importing files as well as
      // the one that publishes: the import is half of what crossed.
      const takersOf = new Set<string>();

      // Sorted and deduplicated, so what the register carries is the SET of
      // crossings and not the order the file happened to declare them in.
      for (const name of [...new Set(facts.exportedNames)].sort()) {
        // ---- 4. a candidate: published, and no contract covers it ----
        if (declared.has(name)) continue;
        // ---- 6/7/8. a crossing needs a taker, from HERE, sharing no component ----
        const takers = taken?.get(name);
        if (!takers) continue;
        const crossing = [...takers].filter(
          taker => taker !== file && !realization.componentsAt(taker).some(c => fence.has(c.id)) && !dependentTakes(taker, name),
        );
        if (crossing.length === 0) continue;
        crossed.push(name);
        for (const taker of crossing) takersOf.add(taker);
      }

      // ---- 10/12. a file whose surface is all promised or all private ----
      if (crossed.length === 0) continue;

      // ---- 11. one file, one finding, on an owner of record ----
      // `paths` is built FROM the implementations that name those files, so
      // every file here has at least one; sorting picks the same one every
      // run, which is what keeps one crossing one finding.
      const [owner] = realization.implementationsAt(file).map(impl => impl.id).sort();
      ctx.addIssue(
        'warning',
        'UNDECLARED_EXPORT',
        `Source file "${file}" publishes ${crossed.length} name(s) that no contract of the component(s) it realizes `
        + `(${[...owners].sort().map(id => `"${id}"`).join(', ')}) declares, and a file realizing NONE of those `
        + `components imports each one FROM HERE — ${crossed.map(n => `"${n}"`).join(', ')} (imported by `
        + `${[...takersOf].sort().map(t => `"${t}"`).join(', ')}). An export only this `
        + 'file\'s own components use is the module\'s private factoring and no concern of the design; one another '
        + 'component reaches for is a surface the design never promised. Declare it as a contract method, stop '
        + 'exporting it, or move it to the component that owns the name.',
        owner,
        undefined,
        undefined,
        // The crossings themselves, named the way the message names them, so
        // a register entry written for today's set cannot carry tomorrow's.
        { at: file, covers: crossed },
      );
    }
  },
};
