import { pathKey, type MethodParam, type ParameterFact } from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';

// ---------------------------------------------------------------------------
// Code↔spec for the SIGNATURE: does the code take the arguments the contract
// promises?
//
// The last of the three readings a spec-driven gate never made. The surface
// (`export-conformance`) and the data (`type-shape`) were read; the signature
// was not. A contract declares `params`, and nothing ever compared them to the
// parameters of the function realizing the method — so a contract could
// promise an argument the code does not take, take one the contract never
// mentions INCLUDING A SECRET, or call the same argument two different things,
// and the brief handed to an implementer would carry the contract's version.
//
// Five decisions make that a reading rather than a flood, and a true one:
//
//  1. POSITION IS THE CORRESPONDENCE, NOT NAME. A caller passes arguments in
//     order, so the first parameter the contract declares IS the first one
//     the code takes after its wiring, whatever either side calls it. Matching
//     on names instead reads every rename as a dropped argument AND an
//     undeclared one — two findings for one word.
//
//  2. WIRING IS DECLARED, NEVER INFERRED. What a realization takes BEFORE the
//     contract's own parameters — a config object, a data root, the transport
//     handles a portal is handed — is supplied by whatever wires the component
//     up and belongs to the realization, not to the contract: another
//     realization of the same contract may hold them as fields instead. It is
//     declared as `injectedParams` because an inferred prefix cannot be told
//     from a renamed first argument: `globalPath(target)` realized as
//     `globalGuideFilePath(targetType)` and `seed(config: HostConfig)` realized
//     as `bootstrapInstance(cfg: HostConfig)` are RENAMES, and any name-based
//     stripping eats the renamed parameter and then reports that the code
//     dropped an argument. Only a LEADING run is dropped, and only names the
//     implementation actually declared — one of those names appearing after
//     the contract's own parameters is not wiring, it is an argument in the
//     middle of the caller's list.
//
//  3. THE DECLARED TYPE IS WHAT TELLS A RENAME FROM A SUBSTITUTION. A name
//     that differs is worth saying only where the type agrees; where the code
//     annotates nothing, nothing is said about the name, because without it a
//     rename cannot be told from a different argument altogether and a guess
//     about somebody's signature is worse than silence.
//
//  4. A NAME WITH SEVERAL BODIES IS JUDGED ON THEIR AGREEMENT. A file holds a
//     class member and the module-level facade that forwards to it under one
//     name — `GitBackingRegistry.upsertBinding(binding)` beside
//     `upsertBinding(dataDir, binding)` — and which one a contract means is
//     not something this reader can decide. Every candidate is judged and only
//     what they ALL say is reported: a wider answer can only narrow what this
//     rule accuses, which is the stance the field-type facts already take when
//     one name carries several declarations. Reading the first body instead
//     hid every facade's leading argument behind the member's signature, which
//     is a silent false negative in exactly the class this rule exists for.
//
//  5. A FORWARDER IS LEFT TO `methodRealization`. A file that only CALLS the
//     function (`packs.listGlobalPacks(cfg, cred)` in a transport module)
//     holds no signature to read, and METHOD_BODY_NOT_FOUND already reports
//     that the body is not here — a second voice saying the parameters cannot
//     be read would make one absence look like two. No function with a body
//     found, or a file below exact grade, and this rule says nothing.
//
// All four codes are CARRYABLE: each measures this project's own code against
// its own spec at a site the finding names — the contract method — and paying
// one means changing the code or the spec. The units are parameter names, so
// a signature cannot grow a seventh argument behind a register entry written
// for six.
// ---------------------------------------------------------------------------

/** How a message spells one side of an optionality disagreement. */
function omittable(optional: boolean): string {
  return optional ? 'may be left out' : 'is required';
}

/**
 * The way a message and a register entry name one realized parameter. A
 * parameter bound by destructuring has no name to name it by, so it is named
 * by the position it occupies in the signature as written — wiring included,
 * because that is where a reader will find it.
 */
function unitOf(parameter: ParameterFact, position: number): string {
  return parameter.name ?? `#${position + 1}`;
}

/**
 * One parameter a judgement reports: the way a message and a register entry
 * NAME it, and the clause the message SAYS about it where the name alone is
 * not the whole of the fact.
 */
interface ParamFinding {
  unit: string;
  told: string;
}

/**
 * The four readings of ONE candidate signature, each keyed by the whole fact
 * it states rather than by the parameter's name — a rename carries the word
 * the code answers to, an optionality disagreement carries which side may be
 * left out — so two candidates count as agreeing only when they are saying the
 * same thing about the same parameter.
 */
interface Judgement {
  unrealized: Map<string, ParamFinding>;
  undeclared: Map<string, ParamFinding>;
  renamed: Map<string, ParamFinding>;
  optionality: Map<string, ParamFinding>;
}

/** Steps 3 through 8 against one candidate body. */
function judge(
  declared: MethodParam[],
  realized: ParameterFact[],
  injected: ReadonlySet<string>,
  typeAgrees: (declared: MethodParam, realized: ParameterFact) => boolean,
): Judgement {
  // ---- 3. align: drop the leading run the implementation declares ----
  // Only a LEADING run, and only names it actually declared: an injected name
  // appearing after the contract's own parameters is an argument in the middle
  // of the caller's list, not wiring. A destructured parameter has no name to
  // match against the list, so it ends the run.
  let wiring = 0;
  while (wiring < realized.length && realized[wiring].name !== undefined
    && injected.has(realized[wiring].name as string)) wiring++;
  const taken = realized.slice(wiring);

  // ---- 4. match what remains against the declared list, FROM THE FRONT ----
  // A caller passes arguments in order, so the first remaining parameter IS
  // the first declared one. A leading parameter no injection accounts for
  // therefore shows up as a shift and is reported by the COUNT below, never
  // blamed on one name: aligning from the back would accuse the wrong argument
  // and rename-report every position after it.
  const matched = Math.min(declared.length, taken.length);
  const found: Judgement = {
    unrealized: new Map(), undeclared: new Map(), renamed: new Map(), optionality: new Map(),
  };

  // ---- 5 / 6. the surplus, on whichever side has it ----
  // A declared parameter with no position to occupy is one the code would
  // never receive; a realized parameter past the last declared one is an
  // argument a caller must supply that the design never mentions.
  for (const param of declared.slice(matched)) {
    found.unrealized.set(param.name, { unit: param.name, told: `"${param.name}"` });
  }
  taken.slice(matched).forEach((param, index) => {
    const unit = unitOf(param, wiring + matched + index);
    found.undeclared.set(unit, { unit, told: `"${unit}"` });
  });

  for (let position = 0; position < matched; position++) {
    const param = declared[position];
    const at = taken[position];
    // ---- 7. a name that differs where the declared type agrees ----
    // The type agreeing is what makes this a rename rather than a different
    // argument. Where the code annotates no type, nothing is said about the
    // name at all.
    if (at.name !== undefined && at.name !== param.name && typeAgrees(param, at)) {
      found.renamed.set(`${param.name}→${at.name}`, {
        unit: param.name,
        told: `"${param.name}" (the code calls it "${at.name}")`,
      });
    }
    // ---- 8. a matched position the two sides read differently ----
    // A default value or a rest parameter makes an argument omittable just as
    // a question mark does: what a caller may leave out is the thing the
    // contract is describing.
    if (!!param.optional !== at.optional) {
      found.optionality.set(`${param.name}:${at.optional}`, {
        unit: param.name,
        told: `"${param.name}" (the contract says it ${omittable(!!param.optional)}, the code says it `
          + `${omittable(at.optional)})`,
      });
    }
  }
  return found;
}

/**
 * What every candidate agrees on, in the order the first one states it.
 *
 * A wider answer can only NARROW what this rule accuses: where one body would
 * report a parameter and another would not, the rule stays quiet — the same
 * stance the field-type facts take when one name carries several declarations,
 * and the only honest one when the file cannot say which body a contract means.
 */
function agreed(judgements: Judgement[], reading: keyof Judgement): ParamFinding[] {
  const [first, ...rest] = judgements;
  return [...first[reading]]
    .filter(([fact]) => rest.every(other => other[reading].has(fact)))
    .map(([, finding]) => finding);
}

export const paramConformanceRule: SddRule = {
  name: 'param-conformance',
  description: 'Code-to-contract for the SIGNATURE, the last of the three readings a spec-driven gate never made: a contract declares `params`, and nothing ever compared them to the parameters of the function that realizes the method. A contract could promise an argument the code does not take, take one the contract never mentions — including a secret — or name the same argument two different things, and the brief handed to an implementer would carry the contract\'s version. Parameters are matched by POSITION against the tail of the realization\'s list, and the declared type is what tells a rename from a dropped argument: `seed(config: HostConfig)` realized as `bootstrapInstance(cfg: HostConfig)` is one parameter under two names, which anything matching on names alone reads as a parameter the code lost. What a realization takes BEFORE the contract\'s own parameters is wiring, and it is declared on the implementation as `injectedParams` rather than inferred, because an inferred prefix cannot be told from a renamed first argument. A method the named file only CALLS is left to `methodRealization`, which already reports that the body is not here.',
  codes: [
    {
      code: 'UNREALIZED_PARAM',
      defaultSeverity: 'warning',
      summary: 'A contract declares a parameter the function realizing the method does not take — the contract promises an argument that would go nowhere, and every brief and caller built from it passes one',
      // Measured code↔spec drift, parameter by parameter, at a site the
      // finding names — which is why every one of them hands over `parts`.
      carryable: true,
    },
    {
      code: 'UNDECLARED_PARAM',
      defaultSeverity: 'warning',
      summary: 'The realizing function takes a parameter no contract parameter names and no declared injection accounts for — an argument a caller must supply that the design never mentions',
      carryable: true,
    },
    {
      code: 'PARAM_NAME_MISMATCH',
      defaultSeverity: 'warning',
      summary: 'A contract parameter and the one realizing it agree on position and type but not on name — the contract, the ERD and every brief say one word while the code says another',
      carryable: true,
    },
    {
      code: 'PARAM_OPTIONALITY',
      defaultSeverity: 'warning',
      summary: 'A contract and its realization disagree about whether a parameter may be left out — one of them is telling a caller an argument is required when it is not, or the reverse',
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    // The code name a declared type answers to, by the spelling a contract
    // may write it in: its own id, and the id qualified by its subsystem. A
    // param's `type` is a type id as often as it is the code's own word for
    // it (`remote_target` where the file says `RemoteTarget`), and the two
    // spellings are one type — which is the whole of what step 7 asks.
    const codeNameOf = new Map<string, string>();
    for (const type of ctx.types) {
      const named = type.symbol ?? type.name;
      codeNameOf.set(type.id, named);
      if (type.subsystem) codeNameOf.set(`${type.subsystem}.${type.id}`, named);
    }
    const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
    /**
     * Whether the two sides are describing the same type. An annotation the
     * code does not write is never agreement: it is the absence step 7 stays
     * silent on.
     */
    const typeAgrees = (declared: MethodParam, realized: ParameterFact): boolean => {
      if (!realized.type) return false;
      const stated = normalize(declared.type);
      return stated === realized.type || codeNameOf.get(stated) === realized.type;
    };

    for (const { implementation, method, sourceFile, draftContext } of ctx.implementationMethods()) {
      // ---- 1. gather: the contract's parameters, and the code's ----
      // A contract method declaring none makes no claim a signature could
      // contradict, and a method whose contract does not resolve is another
      // rule's finding.
      const contract = ctx.interfaceMap.get(implementation.contract);
      const declared = contract?.methods.find(m => m.name === method.name)?.params ?? [];
      if (declared.length === 0 || !sourceFile) continue;
      const file = pathKey(sourceFile);
      const facts = code.factsAt(file);

      // ---- 2 / 9. silent unless at least one signature is there to read ----
      // Below exact grade a parameter list cannot be told from a call; and a
      // symbol with no entry has no BODY in this file — the file only calls
      // the function, which is `methodRealization`'s finding and not a second
      // absence. Own-property lookup, because a method may legitimately be
      // called "constructor" or "toString".
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const symbol = method.symbol ?? method.name;
      const signatures = facts.functionParams;
      if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol)) continue;
      const candidates = signatures[symbol];
      if (candidates.length === 0) continue;

      // ---- 3 / 4. judge every candidate, and keep what they ALL say ----
      // A file may hold two bodies under one name — a class member and the
      // module-level facade that forwards to it — and which one the contract
      // means is not something this reader can decide. So each is judged and
      // only their agreement is reported; the messages then speak of every
      // function of that name, because that is what was read.
      const injected = new Set(implementation.injectedParams ?? []);
      const judgements = candidates.map(realized => judge(declared, realized, injected, typeAgrees));
      const subject = candidates.length > 1
        ? `every function called "${symbol}" in "${file}"`
        : `the function "${symbol}" in "${file}"`;
      const opening = subject.charAt(0).toUpperCase() + subject.slice(1);

      // ---- 5 / 6. the surplus, on whichever side has it ----
      const unrealized = agreed(judgements, 'unrealized');
      if (unrealized.length > 0) {
        ctx.addIssue(
          'warning',
          'UNREALIZED_PARAM',
          `Method "${method.name}" of contract "${implementation.contract}" declares ${unrealized.length} `
          + `parameter(s) ${subject} does not take — ${unrealized.map(found => found.told).join(', ')}. The `
          + 'contract is promising an argument that would go nowhere, and nothing breaks at a call site to '
          + 'correct it: every brief and every caller built from the contract passes one. Take the parameter in '
          + 'the code, or drop it from the contract.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name, covers: unrealized.map(found => found.unit) },
        );
      }

      const undeclared = agreed(judgements, 'undeclared');
      if (undeclared.length > 0) {
        ctx.addIssue(
          'warning',
          'UNDECLARED_PARAM',
          `${opening} realizing method "${method.name}" of contract "${implementation.contract}" takes `
          + `${undeclared.length} parameter(s) the contract does not declare and no declared injection accounts `
          + `for — ${undeclared.map(found => found.told).join(', ')}. An argument a caller must supply that the `
          + 'design never mentions is how a credential ends up in a signature nobody has read against its '
          + 'contract. Declare it on the contract, name it in the implementation\'s `injectedParams` when '
          + 'whatever wires this component up supplies it (a LEADING run only), or take it out of the signature.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name, covers: undeclared.map(found => found.unit) },
        );
      }

      // ---- 7. a name that differs where the declared type agrees ----
      const renamed = agreed(judgements, 'renamed');
      if (renamed.length > 0) {
        ctx.addIssue(
          'warning',
          'PARAM_NAME_MISMATCH',
          `Method "${method.name}" of contract "${implementation.contract}" and ${subject} agree on position and `
          + `type but not on name for ${renamed.length} parameter(s) — ${renamed.map(f => f.told).join('; ')}. `
          + 'The contract, the ERD and every brief carry one word and the code answers to another, which is a '
          + 'rename nobody recorded rather than a different argument — the declared type agreeing is what says '
          + 'so. Rename one side to the other.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name, covers: renamed.map(found => found.unit) },
        );
      }

      // ---- 8. a matched position the two sides read differently ----
      const disagreed = agreed(judgements, 'optionality');
      if (disagreed.length > 0) {
        ctx.addIssue(
          'warning',
          'PARAM_OPTIONALITY',
          `Method "${method.name}" of contract "${implementation.contract}" and ${subject} disagree about whether `
          + `${disagreed.length} parameter(s) may be left out — ${disagreed.map(f => f.told).join('; ')}. One of `
          + 'them is telling a caller an argument is required when it is not, or the reverse. Omittable is the '
          + 'code\'s word for it: a default value and a rest parameter make an argument omittable exactly as a '
          + 'question mark does.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name, covers: disagreed.map(found => found.unit) },
        );
      }
    }
  },
};
