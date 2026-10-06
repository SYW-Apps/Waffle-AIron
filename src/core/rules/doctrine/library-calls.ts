import { SddRule, type DependencyEdge, type RuleContext } from '../types.js';
import { parseDeclaredCall, type MethodEffect } from '../../../models/index.js';

/**
 * Library calls: an edge from any component to an exported InProcess Portal of
 * another project (reach library). Libraries are libraries — no client Adapter
 * is asked for — so two honest checks stand where the Adapter requirement
 * would: purity (pure or read logic may reach only the effects its class
 * allows) and the language bridge (a native API is callable only from its own
 * language, unless it declares an abi). Within one project nothing changes: a
 * sibling subsystem's InProcess Portal is still a boundary hop, judged by
 * subsystem-boundary-dependencies.
 */
export const libraryCallsRule: SddRule = {
  name: 'library-calls',
  judges: 'design',
  description:
    "Judges every library call: an edge from any component to an exported InProcess Portal of another project (reach library), and each call step, register step or declared `calls` entry that reaches one of its verbs. No Adapter is required; two honest checks replace it. Purity: a component whose dependencyClass is pure may call only library verbs whose effect is none, and one whose class is read only verbs whose effect is none or read; a verb whose effect is io, write or lifecycle, or undeclared, is out of their reach (a workflow, with no dependencyClass, may call anything). The language bridge: a Portal with no abi is a native API in its producer's targetLanguage, so a caller in a project of another targetLanguage needs a binding (declare abi on the producer, or put a network Portal in front). Within one project nothing changes: a sibling subsystem's InProcess Portal is reached through a client Adapter or a trustedLink, as subsystem-boundary-dependencies judges. Wrapping a volatile third-party API in an Adapter stays a recommended pattern, never reported.",
  codes: [
    { code: 'LIBRARY_CALL_IMPURE', defaultSeverity: 'error', summary: 'Pure or read logic calls a library verb whose declared effect it may not reach (io, write, lifecycle, or undeclared)' },
    { code: 'LANGUAGE_BRIDGE_MISSING', defaultSeverity: 'error', summary: 'A native-ABI InProcess library (no abi) is called from a project of another targetLanguage' },
  ],
  check(ctx) {
    // Step 1: each library edge.
    for (const edge of ctx.dependencyEdges().all) {
      if (edge.reach !== 'library') continue;
      const comp = edge.from;
      // Step 2: the entry the edge resolved to.
      const library = libraryOf(ctx, edge);
      if (!library) continue;

      // Steps 3-4: a native-ABI library called across languages needs a binding.
      const callerLanguage = normalizeLanguage(ctx.targetLanguageFor(comp.subsystem));
      const producerLanguage = normalizeLanguage(library.targetLanguage);
      if (library.abi === undefined && producerLanguage !== undefined && callerLanguage !== undefined && producerLanguage !== callerLanguage) {
        ctx.addIssue(
          'error',
          'LANGUAGE_BRIDGE_MISSING',
          `Component "${comp.id}" (${callerLanguage}) calls the library "${edge.ref}", a native ${producerLanguage} API with no abi: a ${callerLanguage} caller cannot link it. Declare abi on the producer's Portal (c for a C-ABI shared library, DLL or FFI; wasm for a WebAssembly component), or put a network Portal in front of it.`,
          comp.id,
          edge.draftContext,
          edge.resolution,
        );
      }

      // Step 5: only pure or read logic has a purity bound.
      const dependencyClass = comp.componentType === 'Orchestrator' ? comp.dependencyClass : undefined;
      if (dependencyClass !== 'pure' && dependencyClass !== 'read') continue;

      // Steps 6-8: each call of the caller's implementations into the library's verbs.
      for (const call of callsInto(ctx, edge)) {
        const effect = library.effectOf(call.verb);
        const reachable = effect === 'none' || (dependencyClass === 'read' && effect === 'read');
        if (reachable) continue;
        ctx.addIssue(
          'error',
          'LIBRARY_CALL_IMPURE',
          `${dependencyClass === 'pure' ? 'Pure' : 'Read'} logic "${comp.id}" calls the library verb "${edge.ref}.${call.verb}" (${call.site}), whose effect is ${effect === undefined ? 'not declared' : `"${effect}"`}: ${dependencyClass === 'pure' ? 'pure logic may call only verbs whose effect is none' : 'read logic may call only verbs whose effect is none or read'}. Declare the verb's effect on the library when it is effect-free, or narrow "${comp.id}"'s dependencyClass.`,
          call.implementation,
          edge.draftContext,
          edge.resolution,
          { at: call.site },
        );
      }
    }
  },
};

/** What a library edge resolved to: its abi, its producer's language, and each verb's declared effect. */
interface Library {
  abi?: string;
  targetLanguage?: string;
  effectOf(verb: string): MethodEffect | undefined;
}

/** The library a library edge lands on: a contained member's Portal, or a pinned or foreign contract entry. */
function libraryOf(ctx: RuleContext, edge: DependencyEdge): Library | undefined {
  if (edge.to) {
    const to = edge.to;
    return {
      ...(to.abi !== undefined ? { abi: to.abi } : {}),
      ...(ctx.projectLanguages?.get(ctx.projectOf(to.id)) !== undefined ? { targetLanguage: ctx.projectLanguages.get(ctx.projectOf(to.id)) } : {}),
      effectOf: (verb) => ctx.interfaceMethodsOf(to.id).find((m) => m.name === verb)?.effect,
    };
  }
  if (edge.surface?.kind === 'resolved') {
    const { entry, snapshot } = edge.surface;
    return {
      ...(entry.abi !== undefined ? { abi: entry.abi } : {}),
      ...(snapshot.targetLanguage !== undefined ? { targetLanguage: snapshot.targetLanguage } : {}),
      effectOf: (verb) => entry.methods.find((m) => m.name === verb)?.effect,
    };
  }
  return undefined;
}

/** One call of the caller's implementations into a library edge's target. */
interface LibraryCall {
  implementation: string;
  verb: string;
  /** `<method>#<step>`, or `<method>` for a declared `calls` entry. */
  site: string;
}

/** Every call step, register step and declared `calls` entry of the edge's source that lands on its target. */
function callsInto(ctx: RuleContext, edge: DependencyEdge): LibraryCall[] {
  const targets = new Set([edge.ref, ...(edge.to ? [edge.to.id] : [])]);
  const out: LibraryCall[] = [];
  for (const intf of ctx.interfacesByComponent.get(edge.from.id) ?? []) {
    for (const impl of ctx.implementationsByContract.get(intf.id) ?? []) {
      for (const method of impl.methods) {
        for (const step of method.narrative) {
          if ((step.type === 'call' || step.type === 'register') && step.targetComponent && step.targetMethod && targets.has(step.targetComponent)) {
            out.push({ implementation: impl.id, verb: step.targetMethod, site: `${method.name}#${step.stepNumber}` });
          }
        }
        for (const entry of method.calls ?? []) {
          const call = parseDeclaredCall(entry);
          if (call && targets.has(call.compId)) out.push({ implementation: impl.id, verb: call.methodName, site: method.name });
        }
      }
    }
  }
  return out;
}

/** A language name on the language-table key (ts → typescript, rs → rust, …), lowercased; undefined for none. */
function normalizeLanguage(language: string | undefined): string | undefined {
  const l = language?.trim().toLowerCase();
  if (!l) return undefined;
  const aliases: Record<string, string> = {
    ts: 'typescript', js: 'javascript', node: 'javascript', nodejs: 'javascript', rs: 'rust', py: 'python',
    'c#': 'csharp', cs: 'csharp', dotnet: 'csharp', golang: 'go',
  };
  return aliases[l] ?? l;
}
