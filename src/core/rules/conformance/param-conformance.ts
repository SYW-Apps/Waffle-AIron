import {
  defaultConformanceTier,
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
  /** The trailing injected run actually present, by name. */
  trailing: string[];
  /** The declared parameters the code does not take but reads off an injected request handle. */
  carried: Map<string, ParamFinding>;
}

/** A name read without the leading underscores that mark it unused: `_id` names the argument `id` does. */
function bare(name: string): string {
  return name.replace(/^_+/, '') || name;
}

/** The names a transport's handles go by — a request, its URL, a response, a context. */
const HANDLE_NAMES = new Set(['req', 'request', 'res', 'response', 'reply', 'url', 'ctx', 'context', 'next', 'event', 'socket']);

/**
 * The names that, standing where a contract declares an argument of its own,
 * say the code takes a transport handle instead: a request, a response, a
 * context, the next handler, a reply. Unannotated code settles no kind, so
 * the name is all there is to read — and these are names nobody gives a
 * domain argument.
 */
const TRANSPORT_HANDLES = new Set(['req', 'res', 'ctx', 'request', 'response', 'next', 'reply']);

/** The injected handles a contract parameter can be read FROM: a request, a context, an event. */
const REQUEST_HANDLES = new Set(['req', 'request', 'ctx', 'context', 'event']);

/** The kinds a primitive kind of value can be renamed across: an object is too wide to say two are the same argument. */
const PRIMITIVE_KINDS = new Set<ParameterKind>(['string', 'number', 'boolean']);

/** The article a kind is told with. */
const aKind = (kind: ParameterKind): string => (kind === 'object' ? 'an object' : `a ${kind}`);

/**
 * What a contract parameter's type expects of the code: the kinds of value
 * that realize it (a date is an ISO string or a Date object, so two), the
 * fields of a record type, and how a message tells it.
 */
interface Expected {
  kinds?: Set<ParameterKind>;
  /** True for a temporal or binary primitive, which the code realizes as more than one kind, any of them a rename across. */
  loose?: boolean;
  /** A record type's field names. */
  fields?: string[];
  told: string;
}

/** A field name as a structural comparison reads it: case and separators set aside. */
const fieldKey = (name: string): string => name.toLowerCase().replace(/[_-]/g, '');

/**
 * How an object-kind code parameter stands to a record type's fields, by
 * name: sharing ALL of them, NONE of them, or some. Undefined where either
 * side has none to compare.
 */
function structural(fields: string[] | undefined, realized: ParameterFact): 'all' | 'none' | 'some' | undefined {
  if (!fields || fields.length === 0 || realized.kind !== 'object' || !realized.fields || realized.fields.length === 0) return undefined;
  const has = new Set(realized.fields.map(fieldKey));
  const present = fields.filter(f => has.has(fieldKey(f))).length;
  return present === 0 ? 'none' : present === fields.length ? 'all' : 'some';
}

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
  expected: (declared: MethodParam) => Expected | undefined,
): Judgement {
  // ---- 3. align: drop the leading and trailing runs the implementation declares ----
  // An injected name matches with or without its leading underscore, so a
  // handle that becomes used keeps its declaration; a trailing one is wiring
  // only where the contract declares no parameter of that name.
  const declaredNames = new Set(declared.map(param => bare(param.name)));
  const isInjected = (param: ParameterFact): boolean => param.name !== undefined && injected.has(bare(param.name));
  let lead = 0;
  while (lead < realized.length && isInjected(realized[lead])) lead++;
  let end = realized.length;
  while (end > lead && isInjected(realized[end - 1]) && !declaredNames.has(bare(realized[end - 1].name as string))) end--;
  let taken = realized.map((param, at) => ({ param, at })).slice(lead, end);

  // ---- 3a. what the signature must take but PROVABLY does not use ----
  // A leading underscore means unused, and is believed only where the
  // analysis proves it: never one whose bare name is the contract's own.
  taken = taken.filter(({ param }) => !(param.name !== undefined && param.name.startsWith('_')
    && param.unused === true && !declaredNames.has(bare(param.name))));

  // ---- 4. pair in order, the best-agreeing pairing winning ----
  const score = (d: MethodParam, r: ParameterFact): number => {
    let total = 0;
    if (r.name !== undefined && bare(r.name) === bare(d.name)) total += 4;
    if (typeAgrees(d, r)) total += 2;
    const want = expected(d);
    if (want?.kinds && r.type && r.kind) total += want.kinds.has(r.kind) ? 1 : -2;
    const shape = structural(want?.fields, r);
    if (shape === 'all') total += 2;
    else if (shape === 'none') total -= 2;
    return total;
  };
  const pairs = pairUp(declared, taken.map(entry => entry.param), score);

  const wiringParams = [...realized.slice(0, lead), ...realized.slice(end)];
  const found: Judgement = {
    unrealized: new Map(), undeclared: new Map(), renamed: new Map(), optionality: new Map(), transport: new Map(),
    wiring: realized.slice(0, lead).map(param => param.name as string),
    trailing: realized.slice(end).map(param => param.name as string),
    carried: new Map(),
  };
  const pairedDeclared = new Set(pairs.map(([d]) => d));
  const pairedTaken = new Set(pairs.map(([, r]) => r));
  const substituted = new Set<number>();

  for (const [d, r] of pairs) {
    const param = declared[d];
    const { param: at, at: position } = taken[r];
    const sameName = at.name !== undefined && bare(at.name) === bare(param.name);
    const want = expected(param);
    const agrees = typeAgrees(param, at);
    const shape = structural(want?.fields, at);
    const handleName = at.name !== undefined && TRANSPORT_HANDLES.has(bare(at.name).toLowerCase())
      && !TRANSPORT_HANDLES.has(bare(param.name).toLowerCase());
    // ---- 5. a different argument in the declared one's place ----
    // A different kind of value; a transport class where a record is
    // declared; an object sharing none of the record's fields; or a
    // transport handle's name where the code settles no kind — whatever
    // either side calls it, the code takes something else.
    let instead: string | undefined;
    if (!agrees) {
      if (!sameName && want?.kinds && at.type && at.kind && !want.kinds.has(at.kind)) instead = aKind(at.kind);
      else if (at.transport && want?.fields) instead = 'a transport handle';
      else if (shape === 'none') instead = `an object sharing none of its fields (${(want?.fields ?? []).join(', ')})`;
      else if (handleName && (!at.kind || at.transport)) instead = 'a transport handle';
    }
    if (instead !== undefined) {
      substituted.add(r);
      const declares = want?.told ?? 'an argument of its own';
      found.unrealized.set(param.name, {
        unit: param.name,
        told: `"${param.name}" (the code takes ${at.name ? `"${at.name}"` : `parameter #${position + 1}`}, ${instead}, where the contract declares ${declares})`,
      });
      const unit = unitOf(at, position);
      found.undeclared.set(unit, { unit, told: `"${unit}" (${instead} in the place of the contract's "${param.name}", ${declares})` });
      continue;
    }
    // ---- 7. a name that differs where the declared type agrees ----
    // Agreement is the declared type, the same primitive kind (or one of
    // the kinds a date or bytes is written as), or an object holding every
    // field of the declared record.
    const sameKind = !!want?.kinds && !!at.type && !!at.kind && want.kinds.has(at.kind)
      && (PRIMITIVE_KINDS.has(at.kind) || !!want.loose);
    if (at.name !== undefined && !sameName && (agrees || sameKind || shape === 'all')) {
      const former = (param.previousNames ?? []).some(name => bare(name) === bare(at.name as string));
      found.renamed.set(`${param.name}→${at.name}`, {
        unit: param.name,
        told: `"${param.name}" (the code calls it "${at.name}"${former ? ', the name the contract retired' : ''})`,
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
  // A declared parameter the code does not take, read off an injected
  // request handle by its own name (`req.params.code`), is carried by that
  // handle: realized, through the request whatever serves the method hands
  // it, never an argument gone missing.
  const requestReads = new Set(wiringParams
    .filter(param => param.name !== undefined && REQUEST_HANDLES.has(bare(param.name).toLowerCase()))
    .flatMap(param => (param.reads ?? []).map(bare)));
  declared.forEach((param, d) => {
    if (pairedDeclared.has(d)) return;
    if (requestReads.has(bare(param.name))) {
      found.carried.set(param.name, { unit: param.name, told: param.name });
      return;
    }
    found.unrealized.set(param.name, { unit: param.name, told: `"${param.name}"` });
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
function agreed(judgements: Judgement[], reading: Exclude<keyof Judgement, 'wiring' | 'trailing'>): ParamFinding[] {
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
  description: 'Code-to-contract for the SIGNATURE, the last of the three readings a spec-driven gate never made: a contract declares `params`, and nothing ever compared them to the parameters of the function that realizes the method. A contract could promise an argument the code does not take, take one the contract never mentions — including a secret — or name the same argument two different things, and the brief handed to an implementer would carry the contract\'s version. What a realization takes besides the contract\'s own parameters, at either end of its list, is wiring, declared on the implementation as `injectedParams` rather than inferred, because an inferred prefix cannot be told from a renamed first argument; a leading run and a trailing run of the names it declares are dropped, each name matching with or without its leading underscore, and a trailing one only where the contract declares no parameter of that name. A parameter whose name starts with an underscore means UNUSED, and it is set aside only where the analysis proves it is — named, with no identifier of that name in the body or in another parameter\'s default value and no read of `arguments`, as the request and URL a transport hands a handler that never reads them: a used `_secret` is judged like any parameter, and a name compared for a rename is read without its leading underscores. The rest are PAIRED in order, since a caller passes arguments in order: among the order-keeping pairings, the one where the most names agree, then the most declared types, then the most kinds of value, and on a tie the one aligned against the TAIL of the realization\'s list — so an inserted first argument is the one named undeclared, never the declared one it pushed along. The declared type is what tells a rename from a substitution. Types agree when the code\'s annotation, read through the dialect of the language the file was analyzed as (type_dialect.agrees), is the contract\'s canonical type — so `string[]` agrees with `list<string>`, TypeScript\'s `number` with int and float alike, and an annotation the dialect cannot read agrees with nothing; a named type agrees through its code-level name, an EXTERNAL one (`alias::name`) through the name its pinned snapshot gives it, else its public name\'s last segment in the code\'s type casing. Where a type checker read the file, each parameter the code annotates also carries the KIND of value it takes (string, number, boolean, list, object or function; a platform class the checker\'s fixed library leaves out — a URL, a Request, node:http\'s IncomingMessage — is an object), compared with the kind the contract\'s type is (a primitive\'s, a list, a map or set as an object, an enum as a string, a named scalar as what it holds, a record type as an object, a signature as a function; a date or a datetime as a string or an object, a duration as a number or a string, bytes as an object, a list or a string; anything unsettled compares with nothing). A paired parameter whose name differs and whose type agrees — or whose kind is the same primitive, or one of the kinds a date or bytes is written as — is a rename, said with the contract\'s former name when the code still uses it; one whose name differs and whose kind of value differs is a SUBSTITUTION, a different argument in the declared one\'s place, so the declared parameter is unrealized and the code\'s undeclared: `getRoute(params: Record<string, string>)` realizing `getRoute(id: string)` is never a silent pairing. Where the contract\'s type is a record, an object is compared STRUCTURALLY, by the property names the checker gives its type: one holding every field of the record is a rename, one sharing none of them a substitution whatever either side calls it, and a platform transport class (node:http\'s IncomingMessage, a fetch Request or Response, a URL, a socket) where a record is declared is a substitution too — so `planRoute(req: IncomingMessage)` and `planRoute(session: { user: string })` realizing `planRoute(request: plan_request)` are never silent pairings. Where the code settles no kind — unannotated JavaScript, a parameter typed any — a paired parameter named as a transport handle (req, res, ctx, request, response, next, reply) standing where the contract declares an argument of its own is a substitution: `cancelOrder(req, res)` realizing `cancelOrder(orderId, customerId)` is a handler\'s shape, not the contract\'s. Where neither side settles a type and no handle name speaks, nothing is said about the name. A parameter standing ahead of every kept pair under a name transports give their handles (req, request, res, response, reply, url, ctx, context, next, event, socket) is how a transport handle arrives, and the finding names the one green path for it: the handle in `injectedParams`, the contract\'s own parameters after it in order, the router unpacking the request into them — or, where the framework hands the function the handles alone, the contract\'s parameters read off the injected request by their own names: a contract parameter the code does not take but reads off an injected request handle (req, request, ctx, context, event) by its own name — `req.params.code`, `req.query[\'limit\']`, a destructuring of such a read — is realized through that handle. An injected name none of the implementation\'s realizing functions read in this run takes is stale linkage (UNUSED_INJECTED_PARAM): it would wave through the next parameter of that name unread. A name with several bodies is judged on what they all agree on, and a method the named file only CALLS is left to `methodRealization`, which already reports that the body is not here; a method whose conformance dial is off (its own, else its implementation\'s) is not judged.',
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
      code: 'UNUSED_INJECTED_PARAM',
      defaultSeverity: 'warning',
      summary: 'An implementation declares an injected parameter that none of its realizing functions takes — stale linkage that would wave through the next parameter of that name, wherever it appears',
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
    /**
     * What a contract parameter's type expects of the code, where it settles
     * anything: the kinds of value realizing it (a date or a datetime as an
     * ISO string or a Date object, a duration as a number or a string, bytes
     * as a buffer, a list or a string), and a record type's fields.
     */
    const expected = (declared: MethodParam): Expected | undefined => {
      let expression = parseTypePosition(declared.type, 'param', !!declared.optional).expression;
      while (expression && (expression.form === 'optional' || expression.form === 'result')) expression = expression.args[0];
      if (!expression) return undefined;
      if (expression.form === 'primitive') {
        const loose: Record<string, ParameterKind[]> = {
          date: ['string', 'object'], datetime: ['string', 'object'], duration: ['number', 'string'], bytes: ['object', 'list', 'string'],
        };
        if (expression.name && loose[expression.name]) return { kinds: new Set(loose[expression.name]), loose: true, told: `a ${expression.name}` };
      }
      const kind = expressionKind(expression, name => typeKind(typeNamed.get(name)));
      if (expression.form === 'named' && expression.name) {
        const type = typeNamed.get(expression.name);
        const fields = (type?.fields ?? [])
          .map(field => (field && typeof field === 'object' ? (field as { name?: unknown }).name : undefined))
          .filter((name): name is string => typeof name === 'string');
        if (fields.length > 0 && kind === 'object') return { kinds: new Set(['object']), fields, told: `the record "${expression.name}"` };
      }
      return kind ? { kinds: new Set([kind]), told: aKind(kind) } : undefined;
    };

    // Every name each implementation's realizing functions take, bare — what
    // a declared injection is checked against — and whether any function of
    // it was read at all, which is what lets silence about one mean anything.
    const takenBy = new Map<string, Set<string>>();

    for (const { implementation, method, component, sourceFile, draftContext } of ctx.implementationMethods()) {
      // ---- 0. the conformance dial: off is no realization check at all ----
      const tier = method.conformance ?? implementation.conformance ?? defaultConformanceTier(component);
      if (tier === 'off') continue;
      // ---- 1. gather: the contract's parameters, and the code's ----
      const contract = ctx.interfaceMap.get(implementation.contract);
      if (!sourceFile) continue;
      const declared = contract?.methods.find(m => m.name === method.name)?.params ?? [];
      const file = pathKey(sourceFile);
      const facts = code.factsAt(file);

      // ---- 2 / 9. silent unless at least one signature is there to read ----
      if (!facts || facts.status !== 'analyzed' || facts.analysisGrade !== 'exact') continue;
      const symbol = method.symbol ?? method.name;
      const signatures = facts.functionParams;
      if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol)) continue;
      const candidates = publishedBodies(signatures[symbol], facts.functionBodies?.[symbol], new Set(facts.exportedNames), new Set(Object.keys(facts.typeShapes ?? {})));
      if (candidates.length === 0) continue;
      const taken = takenBy.get(implementation.id) ?? new Set<string>();
      for (const candidate of candidates) for (const param of candidate) if (param.name !== undefined) taken.add(bare(param.name));
      takenBy.set(implementation.id, taken);
      if (declared.length === 0) continue;

      // ---- 3 / 4. judge every candidate, and keep what they ALL say ----
      const injected = new Set((implementation.injectedParams ?? []).map(bare));
      const typeAgrees = typeAgreesIn(dialectOf(facts));
      const judgements = candidates.map(realized => judge(declared, realized, injected, typeAgrees, expected));
      const subject = candidates.length > 1
        ? `every function called "${symbol}" in "${file}"`
        : `the function "${symbol}" in "${file}"`;
      const opening = subject.charAt(0).toUpperCase() + subject.slice(1);
      // The one green path a transport handle has, named with this method's
      // own names: the handle injected, the contract's parameters after it.
      const transport = agreed(judgements, 'transport').map(found => found.told);
      const wiring = judgements[0].wiring;
      const trailing = judgements[0].trailing;
      const greenPath = transport.length > 0
        ? ` If ${transport.map(name => `"${name}"`).join(' and ')} ${transport.length === 1 ? 'is a handle' : 'are handles'} whatever serves this method hands it (a request, a URL, a response) rather than an argument of the contract's caller, the one green path is: name ${transport.length === 1 ? 'it' : 'them'} in the implementation's \`injectedParams\` — [${[...wiring, ...transport].join(', ')}] — and take the contract's own parameters after ${transport.length === 1 ? 'it' : 'them'}, in order: ${symbol}(${[...wiring, ...transport, ...declared.map(param => `${param.name}${param.optional ? '?' : ''}`), ...trailing].join(', ')}), the router unpacking the path, query and body into them — or, where the framework hands the function the handles alone, read each of the contract's parameters off the injected request by its own name (\`${transport[0]}.params.${declared[0]?.name ?? 'id'}\`), which realizes it through the handle. An injected name matches with or without its leading underscore, and a handle the function never reads may carry one instead.`
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
          + 'whatever wires this component up supplies it (a leading or trailing run, with or without its underscore), or take it out of the signature.'
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

    // ---- 10. a declared injection nothing takes ----
    // Judged per implementation, over every realizing function this run read:
    // an injection is wiring for the handlers that take it, so one any of them
    // takes is used. Silent where none was read — nothing then says it is not.
    for (const implementation of ctx.implementations) {
      const injected = implementation.injectedParams ?? [];
      const taken = takenBy.get(implementation.id);
      if (injected.length === 0 || !taken) continue;
      const stale = injected.filter(name => !taken.has(bare(name)));
      if (stale.length === 0) continue;
      ctx.addIssue(
        'warning',
        'UNUSED_INJECTED_PARAM',
        `Implementation "${implementation.id}" declares ${stale.length} injected parameter(s) none of its realizing functions takes — ${stale.map(name => `"${name}"`).join(', ')}. `
        + 'An injection is wiring the parameter check sets aside wherever it stands at either end of a signature, so one '
        + 'that no function takes waves through the next parameter of that name unread — a credential included. Drop it '
        + 'from injectedParams, or take it in the handler that is handed it.',
        implementation.id,
        ctx.isImplementationDraft(implementation),
        undefined,
        { at: 'injectedParams', covers: stale },
      );
    }
  },
};
