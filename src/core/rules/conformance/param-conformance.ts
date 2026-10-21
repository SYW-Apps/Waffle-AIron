import {
  defaultConformanceTier,
  dialectOf,
  namesAgree,
  readCodeAnnotation,
  parseTypePosition,
  pathKey,
  typeDialectFor,
  type MethodParam,
  type ParameterFact,
  type ParameterKind,
  type TypeDialect,
  type TypeExpression,
  type TypeSpec,
} from '../../../models/index.js';
import { RuleContext, SddRule } from '../types.js';
import type { ComponentSpec, ImplementationSpec } from '../../../models/index.js';

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
//  7. A RECORD FAILS CLOSED, AS A RECEIVER DOES. Where the contract declares
//     a record, a parameter whose type names no field (any, unknown, an index
//     signature, no annotation in TypeScript) or holds another set of fields
//     is PARAM_TYPE_MISMATCH: it is taken — under its own name, often — so it
//     is not unrealized, and what fails is the one thing the record promised.
//     And where the declared type lives never decides whether it is compared:
//     a member project's types are read live, and a transport handle's name is
//     a substitution however the handle is typed. A SCALAR fails closed the
//     same way once the code reads it as an object under an opaque type
//     (`args: any` read as `args.habitId` where a string is declared).
//
// The warnings are CARRYABLE: each measures this project's own code against
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
  /** A name that differs where nothing decided between a rename and another argument. */
  undecided?: boolean;
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
  /** The declared record parameters whose realizing parameter's type cannot hold the record. */
  mismatched: Map<string, ParamFinding>;
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

/** The injected handles a result can be written THROUGH: a response, a reply, a context. */
const RESPONSE_HANDLES = new Set(['res', 'response', 'reply', 'ctx', 'context']);

/** The injected handles a contract parameter can be read FROM: a request, a context, an event, a URL. */
const REQUEST_HANDLES = new Set(['req', 'request', 'ctx', 'context', 'event', 'url']);

/** The kinds a primitive kind of value can be renamed across: an object is too wide to say two are the same argument. */
const PRIMITIVE_KINDS = new Set<ParameterKind>(['string', 'number', 'boolean']);

/** The members a value built on these prototypes has, an object's included. */
const membersOf = (...prototypes: object[]): Set<string> =>
  new Set([...prototypes, Object.prototype].flatMap(proto => Object.getOwnPropertyNames(proto)));

/**
 * The members a value of each scalar a contract declares has: what a body
 * may read off it without reading it as an object (`date.length`,
 * `id.toString()`, `day.getTime()` on a date written as a Date).
 */
const SCALAR_MEMBERS: Readonly<Record<string, Set<string>>> = {
  string: membersOf(String.prototype),
  number: membersOf(Number.prototype),
  boolean: membersOf(Boolean.prototype),
  date: membersOf(String.prototype, Date.prototype),
  datetime: membersOf(String.prototype, Date.prototype),
  duration: membersOf(Number.prototype, String.prototype),
};

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
  /** For a scalar (a string, a number, a boolean, a date, a datetime, a duration), the members a value of it has. */
  scalarMembers?: Set<string>;
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
  typescript: boolean,
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
  // Where each taken parameter stands in the signature as written, before
  // anything is set apart: what the findings are told in the order of.
  const writtenAt = new Map(taken.map(({ param, at }) => [unitOf(param, at), at] as const));

  // ---- 3b. an object BUNDLING the contract's own parameters ----
  // An object whose properties name two or more of the declared parameters —
  // its type agreeing with none of them and holding no declared record whole —
  // takes them all inside it: set apart before the pairing, so neither half
  // is paired with it by position.
  let bundle: { entry: { param: ParameterFact; at: number }; covers: Set<number> } | undefined;
  for (const entry of taken) {
    const fields = entry.param.fields;
    if (entry.param.kind !== 'object' || !fields || fields.length === 0) continue;
    if (declared.some(d => typeAgrees(d, entry.param) || structural(expected(d)?.fields, entry.param) === 'all')) continue;
    const keys = new Set(fields.map(fieldKey));
    // A declared parameter some other parameter takes by its own name is
    // taken there, whatever the object also carries.
    const takenElsewhere = new Set(taken.filter(other => other !== entry && other.param.name !== undefined)
      .map(other => fieldKey(bare(other.param.name as string))));
    const covers = new Set(declared.flatMap((d, index) => {
      const key = fieldKey(bare(d.name));
      return keys.has(key) && !takenElsewhere.has(key) ? [index] : [];
    }));
    if (covers.size >= 2) {
      bundle = { entry, covers };
      break;
    }
  }
  if (bundle) taken = taken.filter(entry => entry !== bundle?.entry);
  const pairable = declared.flatMap((param, index) => (bundle?.covers.has(index) ? [] : [{ param, index }]));

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
  const pairs = pairUp(pairable.map(entry => entry.param), taken.map(entry => entry.param), score)
    .map(([d, r]): [number, number] => [pairable[d].index, r]);

  const wiringParams = [...realized.slice(0, lead), ...realized.slice(end)];
  const found: Judgement = {
    unrealized: new Map(), undeclared: new Map(), renamed: new Map(), optionality: new Map(), transport: new Map(),
    wiring: realized.slice(0, lead).map(param => param.name as string),
    trailing: realized.slice(end).map(param => param.name as string),
    carried: new Map(),
    mismatched: new Map(),
  };
  if (bundle) {
    const { param: object, at } = bundle.entry;
    const bundled = declared.filter((_, index) => bundle?.covers.has(index)).map(param => param.name);
    const label = object.name ? `"${object.name}"` : `parameter #${at + 1}`;
    for (const name of bundled) {
      found.unrealized.set(name, { unit: name, told: `"${name}" (the code takes it inside the object ${label}, where the contract declares it as a parameter of its own)` });
    }
    const unit = unitOf(object, at);
    found.undeclared.set(unit, { unit, told: `"${unit}" (an object bundling the contract's own parameters ${bundled.join(', ')})` });
  }
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
    // Agreement short of the declared type: the same primitive kind (or one of
    // the kinds a date or bytes is written as).
    const sameKind = !!want?.kinds && !!at.type && !!at.kind && want.kinds.has(at.kind)
      && (PRIMITIVE_KINDS.has(at.kind) || !!want.loose);
    // ---- 5. a different argument in the declared one's place ----
    // A different kind of value; a transport class where a record is
    // declared; an object sharing none of the record's fields; or a
    // transport handle's name, however the handle is typed — whatever either
    // side calls it, the code takes something else.
    let instead: string | undefined;
    if (!agrees) {
      if (!sameName && want?.kinds && at.type && at.kind && !want.kinds.has(at.kind)) instead = aKind(at.kind);
      else if (at.transport && want?.fields) instead = 'a transport handle';
      else if (shape === 'none') instead = `an object sharing none of its fields (${(want?.fields ?? []).join(', ')})`;
      else if (handleName && shape !== 'all' && !sameKind) instead = 'a transport handle';
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
    // ---- 6b. a record the code's type cannot hold: fail closed ----
    // An opaque type names no field to compare; an object holding only some
    // of the record's fields, or fields of its own beside them, is another
    // shape — either way what a caller hands over is never the record.
    if (!agrees && want?.fields) {
      // Unannotated JavaScript wrote no type to judge; a TypeScript parameter
      // with none is implicitly any, as opaque as one written so.
      const opaque = (at.type !== undefined && at.opaque === true) || (at.type === undefined && typescript);
      let shapeTold: string | undefined;
      if (opaque) {
        shapeTold = `${at.type !== undefined ? `typed "${at.type}"` : 'with no annotation'}, a type that admits any value and names none of its fields (${want.fields.join(', ')})`;
      } else if (at.kind === 'object' && at.fields && at.fields.length > 0) {
        const has = new Set(at.fields.map(fieldKey));
        const declaredKeys = new Set(want.fields.map(fieldKey));
        const missing = want.fields.filter(field => !has.has(fieldKey(field)));
        const added = at.fields.filter(field => !declaredKeys.has(fieldKey(field)));
        if ((missing.length > 0 && missing.length < want.fields.length) || (missing.length === 0 && added.length > 0)) {
          shapeTold = `an object ${[
            ...(missing.length > 0 ? [`missing ${missing.map(field => `"${field}"`).join(', ')}`] : []),
            ...(added.length > 0 ? [`adding ${added.map(field => `"${field}"`).join(', ')}`] : []),
          ].join(' and ')}`;
        }
      }
      if (shapeTold !== undefined) {
        found.mismatched.set(param.name, {
          unit: param.name,
          told: `"${param.name}" (the code takes ${at.name ? `"${at.name}"` : `parameter #${position + 1}`} ${shapeTold}, where the contract declares ${want.told})`,
        });
      }
    }
    // ---- 6c. a scalar the code takes as an object it types as anything ----
    // An opaque type in a scalar's place says nothing by itself — `id: any`
    // read as the string it is passes — but one the body reads members off
    // that no value of the declared kind has (`args.habitId` where the
    // contract declares the string `date`) is an object in the scalar's
    // place, and the opaque type is all that hid it: it fails closed as a
    // record does.
    if (!agrees && want?.scalarMembers) {
      const opaque = (at.type !== undefined && at.opaque === true) || (at.type === undefined && typescript);
      const ownMembers = want.scalarMembers;
      const asObject = (at.members ?? []).filter(member => !ownMembers.has(member));
      if (opaque && asObject.length > 0) {
        found.mismatched.set(param.name, {
          unit: param.name,
          told: `"${param.name}" (the code takes ${at.name ? `"${at.name}"` : `parameter #${position + 1}`} `
            + `${at.type !== undefined ? `typed "${at.type}"` : 'with no annotation'}, a type that admits any value, and reads it as an object `
            + `(${asObject.map(member => `.${member}`).join(', ')}), where the contract declares ${want.told})`,
        });
      }
    }
    // ---- 7. a name that differs where the declared type agrees ----
    // Agreement is the declared type, the same primitive kind (or one of
    // the kinds a date or bytes is written as), or an object holding every
    // field of the declared record.
    // Where nothing decides between a rename and another argument (the types
    // cannot be compared, and no kind or field speaks), the name still
    // differs from the contract's either way: it is said as a rename, with
    // the comparison that could not be made.
    if (at.name !== undefined && !sameName && !found.mismatched.has(param.name)) {
      const former = (param.previousNames ?? []).some(name => bare(name) === bare(at.name as string));
      const decided = agrees || sameKind || shape === 'all';
      const undecided = decided ? '' : `; ${at.type !== undefined ? `its type "${at.type}"` : 'it is unannotated, and its type'} cannot be compared with what the contract declares${want?.told ? ` (${want.told})` : ''}, so it may also be a different argument`;
      found.renamed.set(`${param.name}→${at.name}`, {
        unit: param.name,
        told: `"${param.name}" (the code calls it "${at.name}"${former ? ', the name the contract retired' : ''}${undecided})`,
        ...(decided ? {} : { undecided: true }),
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
  // it, never an argument gone missing. The one RECORD left over is carried
  // by the request's body read whole (`req.body`): the body IS that record.
  // The body is read whole off `req.body`, or — where the framework has no
  // such field, as plain node:http has not — by handing the request to a
  // function whose result the handler binds and uses whole
  // (`const cart = await readJsonBody(req)`): either way that result IS the
  // record, and nothing else the handler holds could be.
  const requestHandles = wiringParams.filter(param => param.name !== undefined && REQUEST_HANDLES.has(bare(param.name).toLowerCase()));
  const requestReads = new Set(requestHandles.flatMap(param => (param.reads ?? []).map(bare)));
  const bodyWhole = requestReads.has('body') || requestHandles.some(param => param.handedWhole === true);
  const left = declared.filter((param, d) => !pairedDeclared.has(d) && !bundle?.covers.has(d) && !requestReads.has(bare(param.name)));
  const records = left.filter(param => (expected(param)?.fields?.length ?? 0) > 0);
  const bodyRecord = bodyWhole && records.length === 1 ? records[0].name : undefined;
  declared.forEach((param, d) => {
    if (pairedDeclared.has(d) || bundle?.covers.has(d)) return;
    if (requestReads.has(bare(param.name)) || param.name === bodyRecord) {
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
  found.undeclared = new Map([...found.undeclared].sort(([a], [b]) => (writtenAt.get(a) ?? 0) - (writtenAt.get(b) ?? 0)));
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
 * the file, by index: every body but a member of a PRIVATE table — an object literal the file
 * neither exports nor declares as a shape, like a router's dispatch table
 * keyed by the same verb names (`DISPATCH.planRoute`), which is the router's
 * code, not the realization. What is left is judged on what it all agrees on.
 */
function publishedIndexes(
  signatures: ParameterFact[][],
  bodies: ReadonlyArray<{ container?: string; nested?: boolean }> | undefined,
  exported: ReadonlySet<string>,
  shapes: ReadonlySet<string>,
): number[] {
  const all = signatures.map((_, i) => i);
  if (!bodies || bodies.length !== signatures.length || signatures.length < 2) return all;
  const tableOnly = (i: number): boolean => {
    const container = bodies[i].container;
    return !bodies[i].nested && container !== undefined && !exported.has(container) && !shapes.has(container);
  };
  const kept = all.filter(i => !tableOnly(i));
  return kept.length > 0 ? kept : all;
}

/** A parameter name with its case and inner separators set aside (leading underscores kept): `documentId` and `document_id` read alike. */
function casingKey(name: string): string {
  const lead = /^_*/.exec(name)![0];
  return lead + name.slice(lead.length).replace(/_/g, '').toLowerCase();
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

/** How a declared type is read against code: its code name by every spelling, the type it is, and the code name an external one answers to. */
interface TypeReading {
  codeNameOf: Map<string, string>;
  typeOf(name: string): { kind?: string; holds?: string; fields?: unknown[] } | undefined;
  externalCodeName(ref: string): string;
}

const typeReadings = new WeakMap<RuleContext, TypeReading>();

/** The run's type reading (TypeReading), built once per rule context. */
function typeReading(ctx: RuleContext): TypeReading {
  const memo = typeReadings.get(ctx);
  if (memo) return memo;
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
  // A MEMBER's type answers to its own type spec, read live from the family
  // the run composed: where a parameter's type lives — this project, a
  // pinned external, a member — never decides whether it is compared.
  const family = ctx.projectFamily?.nodes ?? [];
  const root = family.find(node => node.namespace === '');
  const memberTypes = new Map<string, TypeSpec | null>();
  const lastOf = (id: string): string => id.split(/::|\./).pop() ?? id;
  const memberType = (ref: string): TypeSpec | undefined => {
    const cut = ref.indexOf('::');
    if (cut <= 0) return undefined;
    if (memberTypes.has(ref)) return memberTypes.get(ref) ?? undefined;
    const segment = ref.slice(0, cut);
    const local = lastOf(ref.slice(cut + 2));
    const key = root?.aliases.get(segment) ?? family.find(node => node.aliases.has(segment))?.aliases.get(segment) ?? segment;
    const node = family.find(n => n.namespace !== '' && (n.namespace === key || n.mountAlias === segment || n.id === segment));
    const found = node
      ? ctx.types.find(t => t.id === `${node.namespace}::${local}`)
        ?? ctx.types.find(t => t.id.startsWith(`${node.namespace}::`) && lastOf(t.id) === local)
      : undefined;
    memberTypes.set(ref, found ?? null);
    return found;
  };
  /** The type a spelling names: this project's, a pinned external's, else a member's. */
  const typeOf = (name: string): { kind?: string; holds?: string; fields?: unknown[] } | undefined => typeNamed.get(name) ?? memberType(name);
  /** The code name an external type no pin names answers to: a member's own, else its public name's last segment in the code's type casing. */
  const externalCodeName = (ref: string): string => {
    const member = memberType(ref);
    if (member) return member.symbol ?? member.name;
    return (ref.split('::').pop() ?? ref).split(/[_\-\s]+/).filter(Boolean).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  };

  const reading: TypeReading = { codeNameOf, typeOf, externalCodeName };
  typeReadings.set(ctx, reading);
  return reading;
}

/** One contract method whose realizing function is annotated to return another type than its `returns` (RETURN_TYPE_MISMATCH). */
export interface ReturnDrift {
  implementation: ImplementationSpec;
  component: ComponentSpec | undefined;
  method: string;
  symbol: string;
  file: string;
  declared: string;
  /** The annotations as written, deduplicated. */
  written: string[];
  /** How many bodies under the symbol were judged. */
  bodies: number;
  draftContext: boolean;
}

const returnDriftMemo = new WeakMap<RuleContext, ReturnDrift[]>();

/**
 * Every contract method whose realizing function is annotated to return a
 * type its contract's `returns` does not describe — read at exact grade, or
 * by a reader that read the signatures (Python). Shared: the finding is
 * RETURN_TYPE_MISMATCH's, and a caller's dependency finding names it as the
 * cause, since a port typed after the contract no longer matches the class.
 * Built once per rule context.
 */
export function returnDrifts(ctx: RuleContext): ReturnDrift[] {
  const memo = returnDriftMemo.get(ctx);
  if (memo) return memo;
  const code = ctx.codeIndex();
  const { codeNameOf, typeOf, externalCodeName } = typeReading(ctx);
  /**
   * Whether a return annotation describes the contract's `returns`: true,
   * false, or undefined where the code names a type the design does not
   * know or either side does not read — only a false accuses. Completing
   * later is ASYNC_MISMATCH's subject, so both sides are read past it; a
   * named scalar agrees with what it holds and an enum with a string, the
   * way the code may spell them.
   */
  const returnAgrees = (language: string | undefined, annotation: string, declaredText: string): boolean | undefined => {
    const dialect = language ? typeDialectFor(language) : null;
    if (!dialect) return undefined;
    let code = language === 'python' ? dialect.read(annotation) : readCodeAnnotation(annotation, true);
    let spec = parseTypePosition(declaredText, 'returns').expression;
    if (!code || !spec) return undefined;
    if (code.form === 'async') code = code.args[0];
    if (spec.form === 'async') spec = spec.args[0];
    const names = new Map(codeNameOf);
    for (const ref of declaredText.match(/[A-Za-z0-9_-]+::[A-Za-z0-9_:.-]+/g) ?? []) {
      if (!names.has(ref)) names.set(ref, externalCodeName(ref));
    }
    const known = new Set(names.values());
    const holdsOf = (name: string): TypeExpression | undefined => {
      const type = typeOf(name);
      if (type?.kind === 'enum') return { form: 'primitive', name: 'string', args: [] };
      return type?.holds ? parseTypePosition(type.holds, 'field').expression ?? undefined : undefined;
    };
    const codeHolds = (name: string): TypeExpression | undefined => {
      for (const [ref, codeName] of names) if (codeName === name) return holdsOf(ref);
      return undefined;
    };
    /** A name with case and separators set aside, last segment only: the neutral `coordinate` and the code's `Coordinate` read alike. */
    const loose = (name: string): string => (name.split(/::|\./).pop() ?? name).replace(/[_-]/g, '').toLowerCase();
    /** Whether the design can say what a declared name is: a type it knows, under any spelling. */
    const resolvable = (name: string): boolean => names.has(name) || typeOf(name) !== undefined
      || [...known].some(codeName => loose(codeName) === loose(name));
    /** The kinds of value a temporal primitive is written as in code: an ISO string, or a Date (a duration a number). */
    const TEMPORAL = new Set(['date', 'datetime', 'duration']);
    const agree = (c: TypeExpression, d: TypeExpression): boolean | undefined => {
      if (d.form === 'result' && c.form !== 'result') return agree(c, d.args[0]);
      if ((c.form === 'primitive' && c.name === 'any') || (d.form === 'primitive' && d.name === 'any')) return undefined;
      if (d.form === 'primitive' && TEMPORAL.has(d.name as string)) {
        if (c.form === 'primitive' && (c.name === d.name || c.name === 'string' || (d.name === 'duration' && (c.name === 'number' || c.name === 'int' || c.name === 'float')))) return true;
        if (c.form === 'named') return undefined;
      }
      if (c.form === 'named') {
        if (!known.has(c.name as string)) return undefined;
        if (d.form === 'named' && (namesAgree(c.name as string, d.name as string, names) || loose(c.name as string) === loose(d.name as string))) return true;
        const held = codeHolds(c.name as string);
        if (held) return agree(held, d);
        if (d.form === 'named') {
          if (!resolvable(d.name as string)) return undefined;
          const declaredHolds = holdsOf(d.name as string);
          return declaredHolds ? agree(c, declaredHolds) : false;
        }
        return false;
      }
      if (d.form === 'named') {
        if (!resolvable(d.name as string)) return undefined;
        const held = holdsOf(d.name as string);
        return held ? agree(c, held) : false;
      }
      if (c.form === 'applied' && !known.has(c.name as string)) return undefined;
      if (c.form === 'primitive' && c.name === 'number') return d.form === 'primitive' && (d.name === 'int' || d.name === 'float');
      if (c.form !== d.form) return false;
      if (c.form === 'primitive') return c.name === d.name;
      if (c.form === 'applied' && !namesAgree(c.name as string, d.name as string, names) && loose(c.name as string) !== loose(d.name as string)) return false;
      if (c.args.length !== d.args.length) return false;
      let verdict: boolean | undefined = true;
      c.args.forEach((arg, i) => {
        const one = agree(arg, d.args[i]);
        if (one === false) verdict = false;
        else if (one === undefined && verdict !== false) verdict = undefined;
      });
      return verdict;
    };
    return agree(code, spec);
  };

  const out: ReturnDrift[] = [];
  for (const { implementation, method, component, sourceFile, draftContext } of ctx.implementationMethods()) {
    const tier = method.conformance ?? implementation.conformance ?? defaultConformanceTier(component);
    if (tier === 'off' || !sourceFile) continue;
    const contract = ctx.interfaceMap.get(implementation.contract);
    const contractReturns = contract?.methods.find(m => m.name === method.name)?.returns;
    if (!contractReturns) continue;
    const file = pathKey(sourceFile);
    const facts = code.factsAt(file);
    if (!facts || facts.status !== 'analyzed' || !(facts.analysisGrade === 'exact' || facts.reads?.includes('returns'))) continue;
    const symbol = method.symbol ?? method.name;
    const signatures = facts.functionParams;
    const returnsBy = facts.functionReturns && Object.prototype.hasOwnProperty.call(facts.functionReturns, symbol)
      ? facts.functionReturns[symbol] : undefined;
    if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol) || !returnsBy) continue;
    const kept = publishedIndexes(signatures[symbol], facts.functionBodies?.[symbol], new Set(facts.exportedNames), new Set(Object.keys(facts.typeShapes ?? {})));
    const annotated = kept.map(index => returnsBy[index] ?? null);
    // Three shapes deliver a result the annotation does not carry, and are
    // not compared: a contract returning void (whatever the code hands back
    // beside it, no caller built from the contract reads); a function that
    // REGISTERS the method's handler (a narrative `register` step), whose
    // result is the handler's; and a void function handed a response handle
    // (`injectedParams`), which writes its result through the handle. An
    // unannotated body, and a type either side does not read or the design
    // does not know, are never compared either.
    if (/^(?:async\s+)?void$/.test(contractReturns.trim())) continue;
    if (method.narrative.some(step => step.type === 'register')) continue;
    if ((implementation.injectedParams ?? []).some(name => RESPONSE_HANDLES.has(bare(name).toLowerCase()))
      && annotated.every(a => a !== null && /^(?:Promise<\s*void\s*>|void|None)$/.test(a))) continue;
    if (annotated.length === 0 || !annotated.every((a): a is string => typeof a === 'string')) continue;
    if (!annotated.every(annotation => returnAgrees(facts.language, annotation, contractReturns) === false)) continue;
    out.push({
      implementation, component, method: method.name, symbol, file, declared: contractReturns,
      written: [...new Set(annotated)], bodies: kept.length, draftContext,
    });
  }
  returnDriftMemo.set(ctx, out);
  return out;
}

export const paramConformanceRule: SddRule = {
  name: 'param-conformance',
  judges: 'code',
  description: "Code-to-contract for the SIGNATURE, the last of the three readings a spec-driven gate never made: a contract declares `params`, and nothing ever compared them to the parameters of the function that realizes the method. A contract could promise an argument the code does not take, take one the contract never mentions — including a secret — or name the same argument two different things, and the brief handed to an implementer would carry the contract's version. What a realization takes besides the contract's own parameters, at either end of its list, is wiring, declared on the implementation as `injectedParams` rather than inferred, because an inferred prefix cannot be told from a renamed first argument; a leading run and a trailing run of the names it declares are dropped, each name matching with or without its leading underscore, and a trailing one only where the contract declares no parameter of that name. A parameter whose name starts with an underscore means UNUSED, and it is set aside only where the analysis proves it is — named, with no identifier of that name in the body or in another parameter's default value and no read of `arguments`, as the request and URL a transport hands a handler that never reads them: a used `_secret` is judged like any parameter, and a name compared for a rename is read without its leading underscores. An OBJECT whose properties name two or more of the contract's own parameters BUNDLES them and is set apart first: each parameter it bundles is unrealized (the code takes it inside the object) and the object undeclared, so `cancelOrder(input: { orderId, customerId })` realizing `cancelOrder(orderId, customerId)` names both, never one half by position. The rest are PAIRED in order, since a caller passes arguments in order: among the order-keeping pairings, the one where the most names agree, then the most declared types, then the most kinds of value, and on a tie the one aligned against the TAIL of the realization's list — so an inserted first argument is the one named undeclared, never the declared one it pushed along. The declared type is what tells a rename from a substitution. Types agree when the code's annotation, read through the dialect of the language the file was analyzed as (type_dialect.agrees), is the contract's canonical type — so `string[]` agrees with `list<string>`, TypeScript's `number` with int and float alike, and an annotation the dialect cannot read agrees with nothing; a named type agrees through its code-level name, an EXTERNAL one (`alias::name`) through the name its pinned snapshot gives it, a MEMBER's through the name its own type spec gives it, read live from the family with its kind and fields — so where a parameter's type lives never decides whether it is compared — else its public name's last segment in the code's type casing. Where a type checker read the file, each parameter the code annotates also carries the KIND of value it takes (string, number, boolean, list, object or function; a platform class the checker's fixed library leaves out — a URL, a Request, node:http's IncomingMessage — is an object), compared with the kind the contract's type is (a primitive's, a list, a map or set as an object, an enum as a string, a named scalar as what it holds, a record type as an object, a signature as a function; a date or a datetime as a string or an object, a duration as a number or a string, bytes as an object, a list or a string; anything unsettled compares with nothing). A paired parameter whose name differs and whose type agrees — or whose kind is the same primitive, or one of the kinds a date or bytes is written as — is a rename, said with the contract's former name when the code still uses it; one whose name differs and whose kind of value differs is a SUBSTITUTION, a different argument in the declared one's place, so the declared parameter is unrealized and the code's undeclared: `getRoute(params: Record<string, string>)` realizing `getRoute(id: string)` is never a silent pairing. Where the contract's type is a record, an object is compared STRUCTURALLY, by the data property names the checker gives its type: one holding every field of the record is a rename, one sharing none of them a substitution whatever either side calls it, and a platform transport class (node:http's IncomingMessage, a fetch Request or Response, a URL, a socket) where a record is declared is a substitution too — so `planRoute(req: IncomingMessage)` and `planRoute(session: { user: string })` realizing `planRoute(request: plan_request)` are never silent pairings. A paired parameter named as a transport handle (req, res, ctx, request, response, next, reply) standing where the contract declares an argument of its own is a substitution unless its type agrees with the declared one or holds every field of the declared record — however the handle is typed, a hand-written `type Req = { params: … }` included: `cancelOrder(req, res)` realizing `cancelOrder(orderId, customerId)` is a handler's shape, not the contract's. Where the contract's type is a record, a paired parameter whose type cannot hold it fails closed, as an opaque receiver does (PARAM_TYPE_MISMATCH): an OPAQUE type — any, unknown, object, {}, an index signature alone (`Record<string, unknown>`), or no annotation at all in a TypeScript file — names no field the analysis could compare, and an object sharing some of the record's fields but not all of them, or adding fields the record does not declare, is another shape; the finding names the fields missing and the fields added, so `planRoute(request: any)` and `planRoute(request: { stops: unknown[]; secret: string })` realizing `planRoute(request: plan_request)` are never silent pairings. Where the contract's type is a scalar (a string, a number, a boolean — an enum or a named scalar as what it holds — or a date, a datetime or a duration, each as any value it is written as), a paired parameter whose type admits any value — opaque as above — and whose body reads a member off it directly that no such value has (`args.habitId`, where the contract declares the date `date`) is an object in the scalar's place, PARAM_TYPE_MISMATCH too; one read only as the scalar it is (`date.length`, `day.getTime()`) is not. Where nothing decides between a rename and another argument (the types cannot be compared, no kind or field speaks, and no handle name does), the name still differs from the contract\'s either way, so it is PARAM_NAME_MISMATCH, said with the comparison that could not be made: a Python `quote_order(order_items: list[dict])` realizing `quote_order(items: list<order_item>)` is never silent. A parameter standing ahead of every kept pair under a name transports give their handles (req, request, res, response, reply, url, ctx, context, next, event, socket) is how a transport handle arrives, and the finding names the one green path for it: the handle in `injectedParams`, the contract's own parameters after it in order, the router unpacking the request into them — or, where the framework hands the function the handles alone, the contract's parameters read off the injected request by their own names: a contract parameter the code does not take but reads off an injected request handle (req, request, ctx, context, event, url) by its own name is realized through that handle — `req.params.code`, `req.query.limit`, `req.body.code`, `url.searchParams.get('limit')`, a destructuring at any depth, a local the handle's value flows into (`const url = new URL(req.url, base)`), and what a helper the handle is passed to reads off it or its result yields, where the helper is written in the same file or in a file no implementation claims (`const { orderId } = pathParams(req)`) — and the one RECORD parameter left unpaired is realized by the request's body read whole: `req.body`, or the request handed as the first argument to a function — any function, an imported one included, but a collaborator's method (a callee reached through `this.<field>` or through another of the handler's parameters) — whose result the handler binds to a local and then uses whole, passing it on, returning it, placing it into an object or a list, or assigning it (`const cart = await readJsonBody(req)`); a result only destructured or only read for members is a set of named reads, never the body. A parameter left unrealized because the implementation injects its own name is said so: the injection set the code's parameter of that name aside as wiring. An injected name none of the implementation's realizing functions read in this run takes is said as a NOTICE (UNUSED_INJECTED_PARAM): an injection is code linkage outside the approval, and one nothing takes hides nothing, since no function takes a parameter it could set aside — so it never fails a gate. A name with several bodies is judged on what they all agree on, and a method the named file only CALLS is left to `methodRealization`, which already reports that the body is not here; a method whose conformance dial is off (its own, else its implementation's) is not judged. The signature's other half is its RETURN: a realizing function annotated to return a type its contract's `returns` does not describe is RETURN_TYPE_MISMATCH, naming the method, the contract's type and the code's — whatever every body of the name agrees on, read through the file's dialect. Completing later is ASYNC_MISMATCH's subject, so both sides are read past `async`; a named scalar agrees with what it holds, an enum with a string, a date, a datetime or a duration with the string (or Date, or number) the code writes it as, and a name differing only in case and separators with itself. Not compared: a contract returning void (whatever the code hands back beside it, no caller built from the contract reads), a function that registers the method's handler (a narrative `register` step), whose result is the handler's, a void function handed a response handle (`injectedParams`: res, response, reply, ctx, context), which writes its result through the handle, an unannotated body, and a type either side does not read or the design does not know — never accused. A caller whose port no longer matches the drifted class is not reported again on its own: its call to the drifted component that no longer resolves (CALL_ORIGIN_UNRESOLVED) and its declared edge to it that no longer shows (UNREALIZED_DEPENDENCY) are held under RETURN_TYPE_MISMATCH and judged again once it is fixed. Python is read without a type checker by the analyzer's signature reader (source_file_facts.reads): its `def` parameter names — compared in the language's snake_case, so the contract's `documentId` is the code's `document_id` — their annotations and return annotations, the receiver (`self`, `cls`) set aside, judged like any other signature; an unannotated Python parameter is never read as opaque.",
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
      summary: 'A contract parameter and the one realizing it agree on position (and type, where the two can be compared) but not on name — the contract, the ERD and every brief say one word while the code says another',
      carryable: true,
    },
    {
      code: 'UNUSED_INJECTED_PARAM',
      defaultSeverity: 'notice',
      summary: "An implementation declares an injected parameter that none of its realizing functions takes — stale code linkage, said so it can be dropped; nothing takes it, so it hides nothing and never fails a gate",
      carryable: true,
    },
    {
      code: 'PARAM_TYPE_MISMATCH',
      defaultSeverity: 'warning',
      summary: "A contract parameter is realized by a parameter whose type cannot hold it — a record under an opaque type (any, unknown, an index signature) or an object missing the record's fields or adding its own, or a scalar under an opaque type the body reads as an object — so what a caller hands over is never compared with what the design declares",
      carryable: true,
    },
    {
      code: 'PARAM_OPTIONALITY',
      defaultSeverity: 'warning',
      summary: 'A contract and its realization disagree about whether a parameter may be left out — one of them is telling a caller an argument is required when it is not, or the reverse',
      carryable: true,
    },
    {
      code: 'RETURN_TYPE_MISMATCH',
      defaultSeverity: 'warning',
      summary: "The function realizing a contract method is annotated to return a type the contract's `returns` does not describe — every caller built from the contract expects the other one",
      carryable: true,
    },
  ],

  check(ctx: RuleContext): void {
    const code = ctx.codeIndex();

    // ---- 11. the return type the code annotates, against the contract's `returns` ----
    for (const drift of returnDrifts(ctx)) {
      ctx.addIssue(
        'warning',
        'RETURN_TYPE_MISMATCH',
        `Method "${drift.method}" of contract "${drift.implementation.contract}" returns \`${drift.declared}\`, but `
        + `${drift.bodies > 1 ? `every function called "${drift.symbol}"` : `the function "${drift.symbol}"`} in "${drift.file}" is annotated to return `
        + `${drift.written.map(w => `\`${w}\``).join(' / ')}. Every caller built from the contract — every brief, every port typed after it — `
        + "expects the contract's type, so the drift surfaces far from here: on a caller whose port no longer matches this class, "
        + "as a dependency that looks stale. Those consequences are not reported again on their own: a caller's call to this "
        + 'component that no longer resolves, and a declared edge to it that no longer shows, are held under this finding and '
        + "judged again once it is fixed. Change the code back to the contract's type, or change the contract's `returns` "
        + '(a design change, re-approved with `wairon lock`, and every port typed after it with it).',
        drift.implementation.id,
        drift.draftContext,
        undefined,
        { at: drift.method, covers: ['returns'] },
      );
    }

    const { codeNameOf, typeOf, externalCodeName } = typeReading(ctx);
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
        if (expression.name && loose[expression.name]) {
          return { kinds: new Set(loose[expression.name]), loose: true, told: `a ${expression.name}`, ...(SCALAR_MEMBERS[expression.name] ? { scalarMembers: SCALAR_MEMBERS[expression.name] } : {}) };
        }
      }
      const kind = expressionKind(expression, name => typeKind(typeOf(name)));
      if (expression.form === 'named' && expression.name) {
        const type = typeOf(expression.name);
        const fields = (type?.fields ?? [])
          .map(field => (field && typeof field === 'object' ? (field as { name?: unknown }).name : undefined))
          .filter((name): name is string => typeof name === 'string');
        if (fields.length > 0 && kind === 'object') return { kinds: new Set(['object']), fields, told: `the record "${expression.name}"` };
      }
      if (!kind) return undefined;
      return { kinds: new Set([kind]), told: aKind(kind), ...(PRIMITIVE_KINDS.has(kind) ? { scalarMembers: SCALAR_MEMBERS[kind] } : {}) };
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
      // Read at exact grade, or by a reader that read this language's
      // signatures without a type checker (the Python reader says so in `reads`).
      if (!facts || facts.status !== 'analyzed' || !(facts.analysisGrade === 'exact' || facts.reads?.includes('params'))) continue;
      const symbol = method.symbol ?? method.name;
      const signatures = facts.functionParams;
      if (!signatures || !Object.prototype.hasOwnProperty.call(signatures, symbol)) continue;
      const kept = publishedIndexes(signatures[symbol], facts.functionBodies?.[symbol], new Set(facts.exportedNames), new Set(Object.keys(facts.typeShapes ?? {})));
      // A language whose parameters are named in snake_case (Python) names the
      // contract's `documentId` `document_id`: the same parameter, spelled the
      // language's way — read under the contract's name before anything is compared.
      const snake = facts.language === 'python';
      const contractNamed = new Map(declared.map(param => [casingKey(param.name), param.name] as const));
      const candidates = kept.map(index => signatures[symbol][index].map(param => (snake && param.name !== undefined && contractNamed.has(casingKey(param.name))
        ? { ...param, name: contractNamed.get(casingKey(param.name)) as string } : param)));
      if (candidates.length === 0) continue;

      const taken = takenBy.get(implementation.id) ?? new Set<string>();
      for (const candidate of candidates) for (const param of candidate) if (param.name !== undefined) taken.add(bare(param.name));
      takenBy.set(implementation.id, taken);
      if (declared.length === 0) continue;

      // ---- 3 / 4. judge every candidate, and keep what they ALL say ----
      const injected = new Set((implementation.injectedParams ?? []).map(bare));
      const typeAgrees = typeAgreesIn(dialectOf(facts));
      const typescript = facts.language === 'typescript';
      const judgements = candidates.map(realized => judge(declared, realized, injected, typeAgrees, expected, typescript));
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
        // Through an injected request handle, the two ways a parameter is
        // read off it — told with this method's own names.
        const handle = [...wiring, ...trailing].find(name => REQUEST_HANDLES.has(bare(name).toLowerCase()));
        const record = declared.find(param => (expected(param)?.fields?.length ?? 0) > 0)?.name ?? 'record';
        const scalar = declared.find(param => !(expected(param)?.fields?.length))?.name ?? 'id';
        const throughHandle = handle !== undefined
          ? ` Through the injected request "${handle}", a parameter is realized by reading it off the handle by its own name (\`${handle}.params.${scalar}\`, or a helper's result: \`const { ${scalar} } = pathParams(${handle})\`), and the one record parameter by the body read whole: \`${handle}.body\`, or a function handed the request whose result the handler binds and uses whole (\`const ${record} = await readJsonBody(${handle})\`, then passes \`${record}\` on).`
          : '';
        // An injection naming the contract's own parameter sets the code's
        // parameter of that name aside as wiring — said, since nothing else
        // says why the contract's is left with nothing.
        const injectedOwn = unrealized.filter(found => injected.has(bare(found.unit))).map(found => `"${found.unit}"`);
        const injectionTold = injectedOwn.length > 0
          ? ` The implementation's \`injectedParams\` names ${injectedOwn.join(', ')} — the contract's own parameter(s): an injected name is set aside as wiring, so the code's parameter of that name no longer realizes the contract's. Drop ${injectedOwn.length === 1 ? 'it' : 'them'} from \`injectedParams\` (sdd_update_spec, no re-lock).`
          : '';
        ctx.addIssue(
          'warning',
          'UNREALIZED_PARAM',
          `Method "${method.name}" of contract "${implementation.contract}" declares ${unrealized.length} `
          + `parameter(s) ${subject} does not take — ${unrealized.map(found => found.told).join(', ')}. The `
          + 'contract is promising an argument that would go nowhere, and nothing breaks at a call site to '
          + `correct it: every brief and every caller built from the contract passes one. Take the parameter in `
          + `the code, or drop it from the contract.${injectionTold}${throughHandle}${greenPath}`,
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

      // ---- 6b / 6c. a record, or a scalar, the code's type cannot hold ----
      const mismatched = agreed(judgements, 'mismatched');
      if (mismatched.length > 0) {
        ctx.addIssue(
          'warning',
          'PARAM_TYPE_MISMATCH',
          `Method "${method.name}" of contract "${implementation.contract}" declares ${mismatched.length} `
          + `parameter(s) ${subject} takes under a type that cannot hold what it declares — ${mismatched.map(found => found.told).join('; ')}. `
          + 'Whatever a caller hands over there is never compared with what the design declares — an opaque type names no '
          + 'field to compare, an object missing the record\'s fields or adding its own is another shape, the one a '
          + 'credential rides in unread, and an opaque value read as an object where the contract declares a scalar is '
          + 'an object in its place — so the check fails closed on it, as it does on an opaque receiver. Type the '
          + 'parameter as the contract declares it (a record by its code name), or declare on the contract the shape the code really takes.',
          implementation.id,
          draftContext,
          undefined,
          { at: method.name, covers: mismatched.map(found => found.unit) },
        );
      }

      // ---- 7. a name that differs where the declared type agrees ----
      const renamed = agreed(judgements, 'renamed');
      if (renamed.length > 0) {
        ctx.addIssue(
          'warning',
          'PARAM_NAME_MISMATCH',
          (renamed.every(f => !f.undecided)
            ? `Method "${method.name}" of contract "${implementation.contract}" and ${subject} agree on position and `
              + `type but not on name for ${renamed.length} parameter(s) — ${renamed.map(f => f.told).join('; ')}. `
              + 'The contract, the ERD and every brief carry one word and the code answers to another, which is a '
              + 'rename nobody recorded rather than a different argument — the declared type agreeing is what says '
              + 'so. Rename one side to the other.'
            : `Method "${method.name}" of contract "${implementation.contract}" and ${subject} agree on position `
              + `but not on name for ${renamed.length} parameter(s) — ${renamed.map(f => f.told).join('; ')}. `
              + 'The contract, the ERD and every brief carry one word and the code answers to another: a rename nobody '
              + 'recorded, or, where the types cannot be compared, possibly a different argument. Rename one side to '
              + 'the other, or annotate the parameter with the contract\'s type so the two are compared.'),
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
        'notice',
        'UNUSED_INJECTED_PARAM',
        `Implementation "${implementation.id}" declares ${stale.length} injected parameter(s) none of its realizing functions takes — ${stale.map(name => `"${name}"`).join(', ')}. `
        + 'An injection is code linkage, outside the approval, and one no function takes hides nothing: there is no '
        + 'parameter of that name for it to set aside, so it never fails a gate. It is stale linkage all the same — drop it '
        + 'from injectedParams (sdd_update_spec, no re-lock), or take it in the handler that is handed it.',
        implementation.id,
        ctx.isImplementationDraft(implementation),
        undefined,
        { at: 'injectedParams', covers: stale },
      );
    }
  },
};
