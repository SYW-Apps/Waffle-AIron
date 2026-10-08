import {
  dialectOf,
  parseTypePosition,
  pathKey,
  type MethodParam,
  type ParameterFact,
  type ParameterKind,
  type TypeDialect,
  type TypeExpression,
} from '../../../models/index.js';
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
// Six decisions make that a reading rather than a flood, and a true one:
//
//  1. ORDER IS THE CORRESPONDENCE. A caller passes arguments in order, so a
//     contract parameter is realized by a code parameter at the same place in
//     the order, whatever either side calls it — matching on names instead
//     reads every rename as a dropped argument AND an undeclared one.
//
//  2. WIRING IS DECLARED, NEVER INFERRED. What a realization takes BEFORE the
//     contract's own parameters — a config object, a data root, the transport
//     handles a portal is handed — is declared as `injectedParams`, because an
//     inferred prefix cannot be told from a renamed first argument. Only a
//     LEADING run is dropped, and only names the implementation declared.
//
//  3. `_` MEANS UNUSED, AND IS BELIEVED ONLY WHERE IT IS TRUE. A parameter
//     the signature must take and never reads (the request a transport hands a
//     handler) is marked with a leading underscore — and set aside only where
//     the analysis PROVES it unused. An underscore is one character; a used
//     `_secret` is a credential like any other, and is judged like any other.
//
//  4. WHEN THE COUNTS DIFFER, THE BEST-AGREEING ORDER-KEEPING PAIRING WINS,
//     and on a tie the one aligned against the TAIL: the most names agreeing,
//     then the most declared types, then the most kinds of value. So an
//     inserted first argument is the one named undeclared — `planRoute(apiKey,
//     req)` for `planRoute(request)` names apiKey — never the declared one it
//     pushed along.
//
//  5. THE TYPE TELLS A RENAME FROM A SUBSTITUTION. A paired parameter whose
//     name differs is a rename where its type agrees (through the file's
//     dialect, or as the same primitive kind of value), and a DIFFERENT
//     ARGUMENT where its kind of value differs: the contract's is unrealized
//     and the code's undeclared. Where neither side settles a type, nothing
//     is said about the name — a guess about a signature is worse than
//     silence.
//
//  6. A NAME WITH SEVERAL BODIES IS JUDGED ON THEIR AGREEMENT, and a file
//     that only CALLS the function is left to `methodRealization`.
//
// All four codes are CARRYABLE: each measures this project's own code against
// its own spec at a site the finding names — the contract method — and the
// units are parameter names, so a signature cannot grow a seventh argument
// behind a register entry written for six.
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

/** One parameter a judgement reports: how a message and a register entry NAME it, and what the message SAYS about it. */
interface ParamFinding {
  unit: string;
  told: string;
}

/**
 * The readings of ONE candidate signature, each keyed by the whole fact it
 * states rather than by the parameter's name, so two candidates count as
 * agreeing only when they say the same thing about the same parameter.
 * `transport` holds the undeclared parameters standing ahead of every paired
 * one — how a transport handle arrives — for the green path a finding names.
 */
interface Judgement {
  unrealized: Map<string, ParamFinding>;
  undeclared: Map<string, ParamFinding>;
  renamed: Map<string, ParamFinding>;
  optionality: Map<string, ParamFinding>;
  transport: Map<string, ParamFinding>;
  /** The leading injected run actually present, by name. */
  wiring: string[];
}

/** A name read without the leading underscores that mark it unused: `_id` names the argument `id` does. */
function bare(name: string): string {
  return name.replace(/^_+/, '') || name;
}

/** The names a transport's handles go by — a request, its URL, a response, a context. */
const HANDLE_NAMES = new Set(['req', 'request', 'res', 'response', 'reply', 'url', 'ctx', 'context', 'next', 'event', 'socket']);

/** The kinds a primitive kind of value can be renamed across: an object is too wide to say two are the same argument. */
const PRIMITIVE_KINDS = new Set<ParameterKind>(['string', 'number', 'boolean']);

/** The article a kind is told with. */
const aKind = (kind: ParameterKind): string => (kind === 'object' ? 'an object' : `a ${kind}`);

/** How many order-keeping pairings are weighed before the tail alignment is taken as it stands. */
const PAIRING_BUDGET = 5000;

/** The k-element index subsets of [0, n), in lexicographic order. */
function* subsets(n: number, k: number): Generator<number[]> {
  const pick: number[] = [];
  function* grow(from: number): Generator<number[]> {
    if (pick.length === k) { yield [...pick]; return; }
    for (let i = from; i <= n - (k - pick.length); i++) {
      pick.push(i);
      yield* grow(i + 1);
      pick.pop();
    }
  }
  yield* grow(0);
}

function binomial(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

/**
 * The order-keeping pairing of the declared parameters with the realized
 * ones, as many pairs as the shorter side holds: the one where the most names
 * agree, then the most declared types, then the most kinds of value — and, on
 * a tie, the one aligned against the TAIL (what is left unpaired standing
 * first). Answers [declaredIndex, realizedIndex] pairs.
 */
function pairUp(
  declared: MethodParam[],
  realized: ParameterFact[],
  score: (d: MethodParam, r: ParameterFact) => number,
): Array<[number, number]> {
  const k = Math.min(declared.length, realized.length);
  const longerIsDeclared = declared.length > realized.length;
  const n = Math.max(declared.length, realized.length);
  const align = (chosen: number[]): Array<[number, number]> =>
    chosen.map((index, i) => (longerIsDeclared ? [index, i] : [i, index]));
  // The tail alignment: the last k of the longer side.
  const tail = Array.from({ length: k }, (_, i) => n - k + i);
  if (n === k || binomial(n, k) > PAIRING_BUDGET) return align(tail);
  let best = tail;
  let bestScore = align(tail).reduce((sum, [d, r]) => sum + score(declared[d], realized[r]), 0);
  for (const chosen of subsets(n, k)) {
    const total = align(chosen).reduce((sum, [d, r]) => sum + score(declared[d], realized[r]), 0);
    // Lexicographic order runs from the FRONT alignment to the tail one, so a
    // tie keeps the later — the tail-most — choice.
    if (total >= bestScore) {
      bestScore = total;
      best = chosen;
    }
  }
  return align(best);
}

/** Every reading of one candidate body. */
function judge(
  declared: MethodParam[],
  realized: ParameterFact[],
  injected: ReadonlySet<string>,
  typeAgrees: (declared: MethodParam, realized: ParameterFact) => boolean,
  kindOf: (declared: MethodParam) => ParameterKind | undefined,
): Judgement {
  // ---- 3. align: drop the leading run the implementation declares ----
  let wiring = 0;
  while (wiring < realized.length && realized[wiring].name !== undefined
    && injected.has(realized[wiring].name as string)) wiring++;
  let taken = realized.map((param, at) => ({ param, at })).slice(wiring);

  // ---- 3a. what the signature must take but PROVABLY does not use ----
  // A leading underscore means unused, and is believed only where the
  // analysis proves it: never one whose bare name is the contract's own.
  const declaredNames = new Set(declared.map(param => bare(param.name)));
  taken = taken.filter(({ param }) => !(param.name !== undefined && param.name.startsWith('_')
    && param.unused === true && !declaredNames.has(bare(param.name))));

  // ---- 4. pair in order, the best-agreeing pairing winning ----
  const score = (d: MethodParam, r: ParameterFact): number => {
    let total = 0;
    if (r.name !== undefined && bare(r.name) === bare(d.name)) total += 4;
    if (typeAgrees(d, r)) total += 2;
    const want = kindOf(d);
    if (want && r.type && r.kind) total += want === r.kind ? 1 : -2;
    return total;
  };
  const pairs = pairUp(declared, taken.map(entry => entry.param), score);

  const found: Judgement = {
    unrealized: new Map(), undeclared: new Map(), renamed: new Map(), optionality: new Map(), transport: new Map(),
    wiring: realized.slice(0, wiring).map(param => param.name as string),
  };
  const pairedDeclared = new Set(pairs.map(([d]) => d));
  const pairedTaken = new Set(pairs.map(([, r]) => r));
  const substituted = new Set<number>();

  for (const [d, r] of pairs) {
    const param = declared[d];
    const { param: at, at: position } = taken[r];
    const sameName = at.name !== undefined && bare(at.name) === bare(param.name);
    const want = kindOf(param);
    // ---- 5. a different argument in the declared one's place ----
    if (!sameName && want && at.type && at.kind && want !== at.kind && !typeAgrees(param, at)) {
      substituted.add(r);
      found.unrealized.set(param.name, {
        unit: param.name,
        told: `"${param.name}" (the code takes ${at.name ? `"${at.name}"` : `parameter #${position + 1}`}, ${aKind(at.kind)}, where the contract declares ${aKind(want)})`,
      });
      const unit = unitOf(at, position);
      found.undeclared.set(unit, { unit, told: `"${unit}" (${aKind(at.kind)} in the place of the contract's "${param.name}", ${aKind(want)})` });
      continue;
    }
    // ---- 7. a name that differs where the declared type agrees ----
    if (at.name !== undefined && !sameName
      && (typeAgrees(param, at) || (!!want && !!at.type && want === at.kind && PRIMITIVE_KINDS.has(want)))) {
      found.renamed.set(`${param.name}→${at.name}`, {
        unit: param.name,
        told: `"${param.name}" (the code calls it "${at.name}")`,
      });
    }
    // ---- 8. a paired position the two sides read differently ----
    if (!!param.optional !== at.optional) {
      found.optionality.set(`${param.name}:${at.optional}`, {
        unit: param.name,
        told: `"${param.name}" (the contract says it ${omittable(!!param.optional)}, the code says it `
          + `${omittable(at.optional)})`,
      });
    }
  }

  // ---- 5 / 6. the surplus, on whichever side has it ----
  declared.forEach((param, d) => {
    if (!pairedDeclared.has(d)) found.unrealized.set(param.name, { unit: param.name, told: `"${param.name}"` });
  });
  const firstPaired = Math.min(...pairs.filter(([, r]) => !substituted.has(r)).map(([, r]) => r), taken.length);
  taken.forEach(({ param, at }, r) => {
    if (pairedTaken.has(r)) return;
    const unit = unitOf(param, at);
    found.undeclared.set(unit, { unit, told: `"${unit}"` });
  });
  // The handles a transport passes ahead of the arguments: the parameters
  // standing before every kept pair — undeclared, or substituted for a
  // declared one — that carry the names transports give them. Only a
  // suggestion for the green path a finding names: what is undeclared was
  // settled above, by the pairing alone.
  taken.forEach(({ param, at }, r) => {
    if (r >= firstPaired || param.name === undefined) return;
    if (pairedTaken.has(r) && !substituted.has(r)) return;
    if (HANDLE_NAMES.has(bare(param.name).toLowerCase())) found.transport.set(param.name, { unit: unitOf(param, at), told: param.name });
  });
  // Told in the order the signature writes them.
  const position = new Map(taken.map(({ param, at }) => [unitOf(param, at), at] as const));
  found.undeclared = new Map([...found.undeclared].sort(([a], [b]) => (position.get(a) ?? 0) - (position.get(b) ?? 0)));
  return found;
}

/**
 * What every candidate agrees on, in the order the first one states it. A
 * wider answer can only NARROW what this rule accuses.
 */
function agreed(judgements: Judgement[], reading: Exclude<keyof Judgement, 'wiring'>): ParamFinding[] {
  const [first, ...rest] = judgements;
  return [...first[reading]]
    .filter(([fact]) => rest.every(other => other[reading].has(fact)))
    .map(([, finding]) => finding);
}

/**
 * The signatures a contract method means, among the bodies its name has in
 * the file: every body but a member of a PRIVATE table — an object literal the file
 * neither exports nor declares as a shape, like a router's dispatch table
 * keyed by the same verb names (`DISPATCH.planRoute`), which is the router's
 * code, not the realization. What is left is judged on what it all agrees on.
 */
function publishedBodies(
  signatures: ParameterFact[][],
  bodies: ReadonlyArray<{ container?: string; nested?: boolean }> | undefined,
  exported: ReadonlySet<string>,
  shapes: ReadonlySet<string>,
): ParameterFact[][] {
  if (!bodies || bodies.length !== signatures.length || signatures.length < 2) return signatures;
  const tableOnly = (i: number): boolean => {
    const container = bodies[i].container;
    return !bodies[i].nested && container !== undefined && !exported.has(container) && !shapes.has(container);
  };
  const kept = signatures.filter((_, i) => !tableOnly(i));
  return kept.length > 0 ? kept : signatures;
}

/** The kind of value a canonical type expression is, where it settles one; `named` answers a named type's. */
function expressionKind(expression: TypeExpression | null | undefined, named: (name: string) => ParameterKind | undefined): ParameterKind | undefined {
  if (!expression) return undefined;
  switch (expression.form) {
    case 'primitive':
      return expression.name === 'string' ? 'string'
        : expression.name === 'int' || expression.name === 'float' ? 'number'
          : expression.name === 'bool' ? 'boolean' : undefined;
    case 'list':
      return 'list';
    case 'set':
    case 'map':
      return 'object';
    case 'optional':
      return expressionKind(expression.args[0], named);
    case 'result':
      return expressionKind(expression.args[0], named);
    case 'named':
      return expression.name ? named(expression.name) : undefined;
    default:
      return undefined;
  }
}

/** A type as the kind of value it is: an enum a string, a named scalar what it holds, a signature a function, a record an object. */
function typeKind(type: { kind?: string; holds?: string; fields?: unknown[] } | undefined): ParameterKind | undefined {
  if (!type) return undefined;
  if (type.kind === 'enum') return 'string';
  if (type.kind === 'signature') return 'function';
  if (type.holds) return expressionKind(parseTypePosition(type.holds, 'field').expression, () => undefined);
  if (type.kind === 'entity' || type.kind === 'value-object') return 'object';
  return undefined;
}

export const paramConformanceRule: SddRule = {
  name: 'param-conformance',
  judges: 'code',
  description: 'Code-to-contract for the SIGNATURE, the last of the three readings a spec-driven gate never made: a contract declares `params`, and nothing ever compared them to the parameters of the function that realizes the method. A contract could promise an argument the code does not take, take one the contract never mentions — including a secret — or name the same argument two different things, and the brief handed to an implementer would carry the contract\'s version. What a realization takes BEFORE the contract\'s own parameters is wiring, declared on the implementation as `injectedParams` rather than inferred, because an inferred prefix cannot be told from a renamed first argument; only a leading run of the names it declares is dropped. A parameter whose name starts with an underscore means UNUSED, and it is set aside only where the analysis proves it is — named, with no identifier of that name in the body or in another parameter\'s default value and no read of `arguments`, as the request and URL a transport hands a handler that never reads them: a used `_secret` is judged like any parameter, and a name compared for a rename is read without its leading underscores. The rest are PAIRED in order, since a caller passes arguments in order: among the order-keeping pairings, the one where the most names agree, then the most declared types, then the most kinds of value, and on a tie the one aligned against the TAIL of the realization\'s list — so an inserted first argument is the one named undeclared, never the declared one it pushed along. The declared type is what tells a rename from a substitution. Types agree when the code\'s annotation, read through the dialect of the language the file was analyzed as (type_dialect.agrees), is the contract\'s canonical type — so `string[]` agrees with `list<string>`, TypeScript\'s `number` with int and float alike, and an annotation the dialect cannot read agrees with nothing; a named type agrees through its code-level name, an EXTERNAL one (`alias::name`) through the name its pinned snapshot gives it, else its public name\'s last segment in the code\'s type casing. Where a type checker read the file, each parameter the code annotates also carries the KIND of value it takes (string, number, boolean, list, object or function; a platform class the checker\'s fixed library leaves out — a URL, a Request, node:http\'s IncomingMessage — is an object), compared with the kind the contract\'s type is (a primitive\'s, a list, a map or set as an object, an enum as a string, a named scalar as what it holds, a record type as an object, a signature as a function; a date, bytes and anything unsettled compare with nothing). A paired parameter whose name differs and whose type agrees — or whose kind is the same primitive — is a rename; one whose name differs and whose kind of value differs is a SUBSTITUTION, a different argument in the declared one\'s place, so the declared parameter is unrealized and the code\'s undeclared: `getRoute(params: Record<string, string>)` realizing `getRoute(id: string)` is never a silent pairing. Where neither side settles a type, nothing is said about the name. A parameter standing ahead of every kept pair under a name transports give their handles (req, request, res, response, reply, url, ctx, context, next, event, socket) is how a transport handle arrives, and the finding names the one green path for it: the handle in `injectedParams`, the contract\'s own parameters after it in order, the router unpacking the request into them. A name with several bodies is judged on what they all agree on, and a method the named file only CALLS is left to `methodRealization`, which already reports that the body is not here.',
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
    // may write it in: its own id, and the id qualified by its subsystem.
    const codeNameOf = new Map<string, string>();
    /** The type each spelling names, for the kind of value it is. */
    const typeNamed = new Map<string, { kind?: string; holds?: string; fields?: unknown[] }>();
    for (const type of ctx.types) {
      const named = type.symbol ?? type.name;
      codeNameOf.set(type.id, named);
      typeNamed.set(type.id, type);
      if (type.subsystem) {
        codeNameOf.set(`${type.subsystem}.${type.id}`, named);
        typeNamed.set(`${type.subsystem}.${type.id}`, type);
      }
    }
    // An EXTERNAL type answers to the name its producer gives it — the
    // pinned snapshot's, under the public name a consumer writes.
    for (const pin of ctx.pinnedExternals) {
      const snapshot = pin.snapshot;
      if (!snapshot) continue;
      const byId = new Map(snapshot.types.map(type => [type.id, type] as const));
      for (const type of snapshot.types) {
        codeNameOf.set(`${pin.alias}::${type.id}`, type.name);
        typeNamed.set(`${pin.alias}::${type.id}`, type as { kind?: string; holds?: string; fields?: unknown[] });
      }
      for (const exported of snapshot.exportedTypes ?? []) {
        const type = byId.get(exported.type);
        if (!type) continue;
        codeNameOf.set(`${pin.alias}::${exported.id}`, type.name);
        typeNamed.set(`${pin.alias}::${exported.id}`, type as { kind?: string; holds?: string; fields?: unknown[] });
      }
    }
    /** The code name an external type no pin names answers to: its public name's last segment in the code's type casing. */
    const externalCodeName = (ref: string): string =>
      (ref.split('::').pop() ?? ref).split(/[_\-\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    /** Whether the two sides describe the same type, read through the file's dialect; no annotation, no dialect or no reading is never agreement. */
    const typeAgreesIn = (dialect: TypeDialect | null) => (declared: MethodParam, realized: ParameterFact): boolean => {
      if (!realized.type || !dialect) return false;
      const stated = parseTypePosition(declared.type, 'param', !!declared.optional);
      if (!stated.expression) return false;
      const names = new Map(codeNameOf);
      for (const ref of declared.type.match(/[A-Za-z0-9_-]+::[A-Za-z0-9_:.-]+/g) ?? []) {
        if (!names.has(ref)) names.set(ref, externalCodeName(ref));
      }
      return dialect.agrees(realized.type, stated.expression, names);
    };
    /** The kind of value a contract parameter's type is, where it settles one. */
    const kindOf = (declared: MethodParam): ParameterKind | undefined =>
      expressionKind(parseTypePosition(declared.type, 'param', !!declared.optional).expression, name => typeKind(typeNamed.get(name)));

    for (const { implementation, method, sourceFile, draftContext } of ctx.implementationMethods()) {
      // ---- 1. gather: the contract's parameters, and the code's ----
      const contract = ctx.interfaceMap.get(implementation.contract);
      const declared = contract?.methods.find(m => m.name === method.name)?.params ?? [];
      if (declared.length === 0 || !sourceFile) continue;
      const file = pathKey(sourceFile);
      const facts = code.factsAt(file);

      // ---- 2 / 9. silent unless at least one signature is there to read ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const symbol = method.symbol ?? method.name;
      const signatures = facts.functionParams;
      if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol)) continue;
      const candidates = publishedBodies(signatures[symbol], facts.functionBodies?.[symbol], new Set(facts.exportedNames), new Set(Object.keys(facts.typeShapes ?? {})));
      if (candidates.length === 0) continue;

      // ---- 3 / 4. judge every candidate, and keep what they ALL say ----
      const injected = new Set(implementation.injectedParams ?? []);
      const typeAgrees = typeAgreesIn(dialectOf(facts));
      const judgements = candidates.map(realized => judge(declared, realized, injected, typeAgrees, kindOf));
      const subject = candidates.length > 1
        ? `every function called "${symbol}" in "${file}"`
        : `the function "${symbol}" in "${file}"`;
      const opening = subject.charAt(0).toUpperCase() + subject.slice(1);
      // The one green path a transport handle has, named with this method's
      // own names: the handle injected, the contract's parameters after it.
      const transport = agreed(judgements, 'transport').map(found => found.told);
      const wiring = judgements[0].wiring;
      const greenPath = transport.length > 0
        ? ` If ${transport.map(name => `"${name}"`).join(' and ')} ${transport.length === 1 ? 'is a handle' : 'are handles'} whatever serves this method hands it (a request, a URL, a response) rather than an argument of the contract's caller, the one green path is: name ${transport.length === 1 ? 'it' : 'them'} in the implementation's \`injectedParams\` — [${[...wiring, ...transport].join(', ')}] — and take the contract's own parameters after ${transport.length === 1 ? 'it' : 'them'}, in order: ${symbol}(${[...wiring, ...transport, ...declared.map(param => `${param.name}${param.optional ? '?' : ''}`)].join(', ')}), the router unpacking the path, query and body into them. A handle the function never reads may carry a leading underscore instead.`
        : '';

      // ---- 5 / 6. the surplus, on whichever side has it ----
      const unrealized = agreed(judgements, 'unrealized');
      if (unrealized.length > 0) {
        ctx.addIssue(
          'warning',
          'UNREALIZED_PARAM',
          `Method "${method.name}" of contract "${implementation.contract}" declares ${unrealized.length} `
          + `parameter(s) ${subject} does not take — ${unrealized.map(found => found.told).join(', ')}. The `
          + 'contract is promising an argument that would go nowhere, and nothing breaks at a call site to '
          + `correct it: every brief and every caller built from the contract passes one. Take the parameter in `
          + `the code, or drop it from the contract.${greenPath}`,
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
          + 'whatever wires this component up supplies it (a LEADING run only), or take it out of the signature.'
          + greenPath,
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

      // ---- 8. a paired position the two sides read differently ----
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
