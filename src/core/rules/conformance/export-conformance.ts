import { importBindingOf, pathKey, resolveImport } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

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
// The data model is not re-litigated here. A type's own declaration and its
// pure methods are surface the design DID promise from those same files;
// whether the file actually publishes them is `typeRealization`'s question,
// and this rule only needs to stop reporting its answers a second time.
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

export const exportConformanceRule: SddRule = {
  name: 'export-conformance',
  description:
    'Code-to-contract for the SURFACE: does this file publish anything the components it realizes never promised, that another component then takes? The rest of the conformance set reads contract-to-code — it asks whether the code holds what a spec claims — so a file could export whatever it liked under a component\'s name and nothing looked. That is one half of the same hole as a contract promising a parameter it never passes. A method\'s `exportedVia` names the export a consumer imports to REACH it — the value that composes it, which `symbol` cannot name because `symbol` names the function inside — and a declared handle the file does not actually export is itself a finding, so naming one can never become a free-text suppression. Both questions are asked only of a file read at exact grade, and a taker counts only when its own import specifier resolves to the file it is accused of taking from: below that nothing separates an export from a mention, or a shared word from a shared module.',
  codes: [
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
      summary: 'An implementation method declares an `exportedVia` handle its own source file does not export — the spec names a published route to the method that nobody can import',
      // Deliberately NOT carryable, and so it hands over no `parts`: a wrong
      // handle is one string to correct, and a parking space for it could
      // only ever be a parking space for a lie.
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();
    const realization = ctx.realizationIndex();

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

    // ---- 3. what the data model publishes from those same files ----
    for (const type of ctx.types) {
      if (!type.sourcePath) continue;
      promise(type.sourcePath, type.symbol ?? type.name);
      for (const method of type.methods ?? []) {
        promise(method.sourcePath ?? type.sourcePath, method.symbol ?? method.name);
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
      const target = resolveImport(writtenIn, specifier, code.paths);
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
      for (const [local, binding] of Object.entries(facts.importBindings ?? {})) {
        if (binding.namespace) continue;
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

    for (const file of realization.paths) {
      const facts = code.factsAt(file);
      // ---- 5. only exact analysis tells an export from a mention ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;

      const declared = promised.get(file) ?? NOTHING_PROMISED;
      const taken = takenFrom.get(file);
      const owners = new Set(realization.componentsAt(file).map(c => c.id));
      const crossed: string[] = [];

      // Sorted and deduplicated, so what the register carries is the SET of
      // crossings and not the order the file happened to declare them in.
      for (const name of [...new Set(facts.exportedNames)].sort()) {
        // ---- 4. a candidate: published, and no contract covers it ----
        if (declared.has(name)) continue;
        // ---- 6/7/8. a crossing needs a taker, from HERE, sharing no component ----
        const takers = taken?.get(name);
        if (!takers) continue;
        const crossing = [...takers].some(
          taker => taker !== file && !realization.componentsAt(taker).some(c => owners.has(c.id)),
        );
        if (crossing) crossed.push(name);
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
        + `components imports each one FROM HERE — ${crossed.map(n => `"${n}"`).join(', ')}. An export only this `
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
