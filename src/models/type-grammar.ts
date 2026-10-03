import type { InterfaceSpec, MethodParam, StoredInterfaceSpec, StoredTypeSpec, TypeSpec } from './specs.js';

// ---------------------------------------------------------------------------
// The neutral type grammar — one language-neutral reading of every structured
// type position: a param's type, a method's returns, a field's type, a type
// method's params and returns, a signature type's params and returns.
//
//   type-position = [ "async" ] type ;          (* async only at the top of a returns *)
//   type          = member { "|" member } ;
//   member        = primary [ "?" ] ;
//   primary       = name [ "<" type { "," type } ">" ] | "(" type ")" ;
//   name          = ident { ( "::" | "." ) ident } ;
//
// The ten primitives are string, int, float, bool, bytes, date, datetime,
// duration, void and any; the collections list<T>, set<T> and map<K, V>; `T?`
// is T or no value; `A | B` is exactly one of the NAMED types; `async T` a call
// completing later with T. A user generic `Page<T>` is a named type applied to
// arguments.
//
// Today's spellings — TypeScript's, and the legacy builtin vocabulary existing
// trees can hold — are ALIASES the parser accepts and normalises (the table
// below is the one place that knows them, and the TypeScript dialect's reader
// is this same table). A position is read whole: anything left over is
// TYPE_EXPRESSION_INVALID. A form the grammar leaves out (inline object,
// inline function type, literal union, union mixing in a primitive or a
// collection, intersection, utility type, tuple) is TYPE_FORM_UNSUPPORTED; a
// name with no neutral meaning (`number`, `uuid`, ...) is TYPE_NOT_NEUTRAL and
// still answers a reading (`number` as float, the rest as any); a misplaced
// `void` or `async`, a non-scalar map key or `T??` is TYPE_POSITION_INVALID.
//
// Pure: a text and the position it stands in are the whole input. Prose
// signatures are not structured positions and are never read here.
// ---------------------------------------------------------------------------

/** primitive | named | list | set | map | optional | union | async | applied. */
export type TypeForm = 'primitive' | 'named' | 'list' | 'set' | 'map' | 'optional' | 'union' | 'async' | 'applied';

/** type_expression — a type position's value, parsed under the neutral grammar. */
export interface TypeExpression {
  form: TypeForm;
  /** The primitive's canonical name, the named type's reference as written, or an applied generic's head. */
  name?: string;
  /** Element (list, set), key then value (map), inner (optional, async), members (union) or arguments (applied). */
  args: TypeExpression[];
}

/** Where a type position stands — what the position rules judge. */
export type TypePosition =
  | 'param' | 'returns' | 'field'
  | 'type-method-param' | 'type-method-returns'
  | 'signature-param' | 'signature-returns';

/** The four codes a position that is not canonical is reported under. */
export type TypeProblemCode = 'TYPE_EXPRESSION_INVALID' | 'TYPE_POSITION_INVALID' | 'TYPE_FORM_UNSUPPORTED' | 'TYPE_NOT_NEUTRAL';

/** type_expression_problem — why one written type position is not canonical, and what replaces it. */
export interface TypeExpressionProblem {
  code: TypeProblemCode;
  /** The position's text as written. */
  written: string;
  /** What is wrong, in a sentence. */
  detail: string;
  /** What to write instead. */
  replacement?: string;
  /** The interface or type holding the position, once collected over a spec. */
  specId?: string;
  /** interface | type, once collected over a spec. */
  kind?: 'interface' | 'type';
  /** Where in the spec (methods.save.params.key, fields.createdAt, ...), once collected over a spec. */
  path?: string;
}

/** type_parse — what reading one written type position gave. */
export interface TypeParse {
  /** The canonical expression; null when the text does not parse, uses a form left out, or breaks a position rule. */
  expression: TypeExpression | null;
  /** The canonical text; the text as written when there is no expression. */
  canonical: string;
  /** Why the position is not canonical, when it is not. */
  problem: TypeExpressionProblem | null;
}

/** type_respelling — one position whose written text is an alias of its canonical spelling. */
export interface TypeRespelling {
  specId: string;
  kind: 'interface' | 'type';
  path: string;
  written: string;
  stored: string;
}

/** type_canonicalization — one spec with every structured type position read under the grammar. */
export interface TypeCanonicalization<S = InterfaceSpec | TypeSpec> {
  /** The spec with every canonicalisable position respelled; nothing else in it changes. */
  spec: S;
  respellings: TypeRespelling[];
  problems: TypeExpressionProblem[];
}

/** type_spelling_facts — what one scan's type canonicalisation recorded. */
export interface TypeSpellingFacts {
  respellings: TypeRespelling[];
  problems: TypeExpressionProblem[];
}

/** type_spelling_repair — one spec the doctor's type-spelling repair plans for. */
export interface TypeSpellingRepair {
  specId: string;
  kind: 'interface' | 'type';
  rewritten: TypeRespelling[];
  proposals: TypeRespelling[];
  authorNeeded: TypeExpressionProblem[];
}

// ---------------------------------------------------------------------------
// The vocabulary: primitives, aliases, and the legacy names with no neutral meaning
// ---------------------------------------------------------------------------

/** The ten primitives, in their canonical spelling. */
export const PRIMITIVE_TYPES: readonly string[] = ['string', 'int', 'float', 'bool', 'bytes', 'date', 'datetime', 'duration', 'void', 'any'];
const PRIMITIVES = new Set(PRIMITIVE_TYPES);

/**
 * Bare aliases of a primitive, matched EXACTLY first (so `Date` is datetime and
 * `date` stays date), then ignoring case over the legacy vocabulary existing
 * trees could hold.
 */
const PRIMITIVE_ALIASES: ReadonlyMap<string, string> = new Map([
  ['boolean', 'bool'],
  ['integer', 'int'], ['long', 'int'],
  ['i8', 'int'], ['i16', 'int'], ['i32', 'int'], ['i64', 'int'], ['i128', 'int'], ['isize', 'int'],
  ['u8', 'int'], ['u16', 'int'], ['u32', 'int'], ['u64', 'int'], ['u128', 'int'], ['usize', 'int'],
  ['double', 'float'], ['f32', 'float'], ['f64', 'float'],
  ['Buffer', 'bytes'], ['Uint8Array', 'bytes'],
  ['Date', 'datetime'], ['timestamp', 'datetime'],
  ['object', 'any'], ['unknown', 'any'], ['json', 'any'], ['Json', 'any'],
  ['str', 'string'],
]);

/** Generic aliases of a collection, the optional marker and async: head → canonical form and arity. */
const GENERIC_ALIASES: ReadonlyMap<string, { form: 'list' | 'set' | 'map' | 'optional' | 'async'; arity: number }> = new Map([
  ['list', { form: 'list', arity: 1 }], ['Array', { form: 'list', arity: 1 }], ['ReadonlyArray', { form: 'list', arity: 1 }],
  ['List', { form: 'list', arity: 1 }], ['vec', { form: 'list', arity: 1 }], ['vector', { form: 'list', arity: 1 }],
  ['set', { form: 'set', arity: 1 }], ['Set', { form: 'set', arity: 1 }], ['ReadonlySet', { form: 'set', arity: 1 }],
  ['map', { form: 'map', arity: 2 }], ['Map', { form: 'map', arity: 2 }], ['Record', { form: 'map', arity: 2 }],
  ['ReadonlyMap', { form: 'map', arity: 2 }], ['dict', { form: 'map', arity: 2 }], ['dictionary', { form: 'map', arity: 2 }],
  ['HashMap', { form: 'map', arity: 2 }],
  ['Option', { form: 'optional', arity: 1 }], ['Optional', { form: 'optional', arity: 1 }],
  ['Promise', { form: 'async', arity: 1 }],
]);

/** Legacy builtins with no neutral meaning (TYPE_NOT_NEUTRAL), each with its replacement. Read as any. */
const NOT_NEUTRAL: ReadonlyMap<string, string> = new Map([
  ['uuid', 'a named value-object holding a string (e.g. order_id)'],
  ['decimal', 'a named value-object (e.g. money), or float'],
  ['char', 'string'],
  ['byte', 'int, or bytes for binary data'],
  ['time', 'datetime for an instant, or duration for an elapsed time'],
  ['tuple', 'a named value-object'],
  ['result', 'the success type as the returns (failures as findings or throws), or a named value-object'],
  ['error', 'a named value-object'],
  ['never', 'void'],
  ['box', 'the inner type (ownership is an implementation detail)'],
  ['arc', 'the inner type (ownership is an implementation detail)'],
  ['rc', 'the inner type (ownership is an implementation detail)'],
  ['ref', 'the inner type (ownership is an implementation detail)'],
  ['cell', 'the inner type (ownership is an implementation detail)'],
  ['refcell', 'the inner type (ownership is an implementation detail)'],
  ['mutex', 'the inner type (synchronisation is an implementation detail)'],
  ['rwlock', 'the inner type (synchronisation is an implementation detail)'],
  ['std', 'a named type'],
  ['mcpserver', 'a named type'],
]);

/** TypeScript's type algebra: utility types the grammar leaves out (TYPE_FORM_UNSUPPORTED). */
const UTILITY_TYPES = new Set([
  'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude', 'Extract', 'NonNullable',
  'ReturnType', 'Parameters', 'InstanceType', 'Awaited', 'ConstructorParameters', 'ThisType', 'Uppercase', 'Lowercase',
]);

/** The two spellings of "no value". */
const NONES = new Set(['null', 'undefined']);

/** The ignoring-case view of the legacy vocabulary: primitives, primitive aliases and generic heads. */
const LOWER_PRIMITIVE = new Map<string, string>([
  ...PRIMITIVE_TYPES.map((p) => [p, p] as const),
  ...[...PRIMITIVE_ALIASES].map(([k, v]) => [k.toLowerCase(), v] as const),
]);
const LOWER_GENERIC = new Map([...GENERIC_ALIASES].map(([k, v]) => [k.toLowerCase(), v] as const));

/**
 * Whether a bare name is wairon's own vocabulary rather than a reference to a
 * named type: a primitive, an alias, a legacy builtin, a none, a boolean
 * literal — compared ignoring case, as the retired builtin vocabulary was. What
 * a lenient (prose) tokenization filters out before resolving references.
 */
export function isTypeVocabulary(name: string): boolean {
  const lower = name.toLowerCase();
  return LOWER_PRIMITIVE.has(lower) || LOWER_GENERIC.has(lower) || NOT_NEUTRAL.has(lower)
    || NONES.has(lower) || lower === 'true' || lower === 'false' || lower === 'number';
}

/** The canonical primitive a bare name spells, exactly first and then ignoring case; undefined for anything else. */
function primitiveOf(name: string): string | undefined {
  if (PRIMITIVES.has(name)) return name;
  const exact = PRIMITIVE_ALIASES.get(name);
  if (exact) return exact;
  return LOWER_PRIMITIVE.get(name.toLowerCase());
}

/** The generic alias a head spells, exactly first and then ignoring case. */
function genericOf(name: string): { form: 'list' | 'set' | 'map' | 'optional' | 'async'; arity: number } | undefined {
  return GENERIC_ALIASES.get(name) ?? LOWER_GENERIC.get(name.toLowerCase());
}

// ---------------------------------------------------------------------------
// Tokens and the raw (TypeScript-superset) syntax tree
// ---------------------------------------------------------------------------

type Token =
  | { t: 'id'; v: string }
  | { t: 'str'; v: string }
  | { t: 'num'; v: string }
  | { t: 'p'; v: string };

/** The raw tree: every shape a written position may take, before normalisation judges it. */
type Raw =
  | { k: 'name'; name: string; args?: Raw[] }
  | { k: 'array'; elem: Raw }
  | { k: 'union'; members: Raw[] }
  | { k: 'opt'; inner: Raw }
  | { k: 'paren'; inner: Raw }
  | { k: 'async'; inner: Raw }
  | { k: 'literal'; text: string }
  | { k: 'object'; members: Raw[] }
  | { k: 'function'; params: Raw[]; ret: Raw }
  | { k: 'intersection'; members: Raw[] }
  | { k: 'tuple'; elems: Raw[] }
  | { k: 'operator'; op: string; inner: Raw };

/** A text that does not parse: the detail names the offending part. */
class TypeSyntaxError extends Error {}

const PUNCTUATION = ['...', '::', '=>', '<', '>', ',', '|', '?', '(', ')', '[', ']', '{', '}', ':', '&', ';', '.'];

/** The text cut into tokens; a character no type spelling uses does not parse. */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_$-]/.test(text[j])) j++;
      // A trailing dash belongs to no identifier.
      while (text[j - 1] === '-') j--;
      out.push({ t: 'id', v: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      out.push({ t: 'num', v: text.slice(i, j) });
      i = j;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      if (j >= text.length) throw new TypeSyntaxError(`an unterminated string literal at "${text.slice(i)}"`);
      out.push({ t: 'str', v: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    const punct = PUNCTUATION.find((p) => text.startsWith(p, i));
    if (!punct) throw new TypeSyntaxError(`"${c}" is not part of any type spelling`);
    out.push({ t: 'p', v: punct });
    i += punct.length;
  }
  return out;
}

/** A recursive-descent reader of the raw tree over one position's tokens. */
class RawParser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  /** type-position: an optional `async` prefix, one type, and nothing after it. */
  position(): Raw {
    if (this.tokens.length === 0) throw new TypeSyntaxError('the position is empty');
    const node = this.isAsyncPrefix() ? (this.at++, { k: 'async' as const, inner: this.type() }) : this.type();
    if (this.at < this.tokens.length) throw new TypeSyntaxError(`"${this.rest()}" is left over after the type`);
    return node;
  }

  private isAsyncPrefix(): boolean {
    const first = this.tokens[0];
    const next = this.tokens[1];
    if (!first || first.t !== 'id' || first.v !== 'async' || !next) return false;
    return next.t !== 'p' || ['(', '{', '[', '::'].includes(next.v);
  }

  private rest(): string {
    return this.tokens.slice(this.at).map((t) => t.v).join(' ');
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.at + offset];
  }

  private isP(v: string, offset = 0): boolean {
    const t = this.peek(offset);
    return !!t && t.t === 'p' && t.v === v;
  }

  private expect(v: string): void {
    if (!this.isP(v)) {
      const got = this.peek();
      throw new TypeSyntaxError(got ? `expected "${v}" but found "${got.v}"` : `expected "${v}" but the text ended`);
    }
    this.at++;
  }

  type(): Raw {
    if (this.isP('|')) this.at++;
    const members = [this.intersection()];
    while (this.isP('|')) {
      this.at++;
      members.push(this.intersection());
    }
    return members.length === 1 ? members[0] : { k: 'union', members };
  }

  private intersection(): Raw {
    const members = [this.postfix()];
    while (this.isP('&')) {
      this.at++;
      members.push(this.postfix());
    }
    return members.length === 1 ? members[0] : { k: 'intersection', members };
  }

  private postfix(): Raw {
    let node = this.primary();
    for (;;) {
      if (this.isP('[') && this.isP(']', 1)) {
        this.at += 2;
        node = { k: 'array', elem: node };
      } else if (this.isP('?')) {
        this.at++;
        node = { k: 'opt', inner: node };
      } else {
        return node;
      }
    }
  }

  private primary(): Raw {
    const tok = this.peek();
    if (!tok) throw new TypeSyntaxError('a type was expected but the text ended');
    if (tok.t === 'str' || tok.t === 'num') {
      this.at++;
      return { k: 'literal', text: tok.v };
    }
    if (tok.t === 'id' && (tok.v === 'keyof' || tok.v === 'typeof' || tok.v === 'unique') && this.peek(1)?.t === 'id') {
      this.at++;
      return { k: 'operator', op: tok.v, inner: this.postfix() };
    }
    const next = this.peek(1);
    if (tok.t === 'id' && tok.v === 'readonly' && next && (next.t === 'id' || (next.t === 'p' && (next.v === '(' || next.v === '[')))) {
      this.at++;
      return this.postfix();
    }
    if (tok.t === 'id' || (tok.t === 'p' && tok.v === '::')) return this.named();
    if (tok.t === 'p' && tok.v === '(') return this.parenOrFunction();
    if (tok.t === 'p' && tok.v === '{') return this.objectShape();
    if (tok.t === 'p' && tok.v === '[') return this.tuple();
    throw new TypeSyntaxError(`"${tok.v}" cannot start a type`);
  }

  private ident(): string {
    const tok = this.peek();
    if (!tok || tok.t !== 'id') throw new TypeSyntaxError(tok ? `expected a name but found "${tok.v}"` : 'expected a name but the text ended');
    this.at++;
    return tok.v;
  }

  private named(): Raw {
    let name = '';
    if (this.isP('::')) {
      this.at++;
      name = '::';
    }
    name += this.ident();
    while (this.isP('::') || this.isP('.')) {
      const sep = this.peek()!.v;
      this.at++;
      name += sep + this.ident();
    }
    if (!this.isP('<')) return { k: 'name', name };
    this.at++;
    const args = [this.type()];
    while (this.isP(',')) {
      this.at++;
      args.push(this.type());
    }
    this.expect('>');
    return { k: 'name', name, args };
  }

  /** The index of the `)` closing the `(` at the cursor, or -1. */
  private closingParen(): number {
    let depth = 0;
    for (let i = this.at; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (t.t !== 'p') continue;
      if (t.v === '(') depth++;
      else if (t.v === ')' && --depth === 0) return i;
    }
    return -1;
  }

  private parenOrFunction(): Raw {
    const close = this.closingParen();
    const after = close === -1 ? undefined : this.tokens[close + 1];
    if (!after || after.t !== 'p' || after.v !== '=>') {
      this.expect('(');
      const inner = this.type();
      this.expect(')');
      return { k: 'paren', inner };
    }
    this.expect('(');
    const params: Raw[] = [];
    while (!this.isP(')')) {
      if (this.isP('...')) this.at++;
      this.ident();
      if (this.isP('?')) this.at++;
      if (this.isP(':')) {
        this.at++;
        params.push(this.type());
      }
      if (!this.isP(',')) break;
      this.at++;
    }
    this.expect(')');
    this.expect('=>');
    return { k: 'function', params, ret: this.type() };
  }

  private objectShape(): Raw {
    this.expect('{');
    const members: Raw[] = [];
    while (!this.isP('}')) {
      if (this.isP('[')) {
        // An index signature: [key: K]: V.
        this.at++;
        this.ident();
        this.expect(':');
        members.push(this.type());
        this.expect(']');
      } else {
        if (this.peek()?.t === 'id' && this.peek()!.v === 'readonly' && this.peek(1)?.t === 'id') this.at++;
        const key = this.peek();
        if (!key || (key.t !== 'id' && key.t !== 'str' && key.t !== 'num')) throw new TypeSyntaxError('an inline object member has no name');
        this.at++;
        if (this.isP('?')) this.at++;
        if (this.isP('(')) {
          members.push(this.parenOrFunctionMember());
          this.skipSeparator();
          continue;
        }
      }
      this.expect(':');
      members.push(this.type());
      this.skipSeparator();
    }
    this.expect('}');
    return { k: 'object', members };
  }

  /** A method member of an inline object: (params): returns. */
  private parenOrFunctionMember(): Raw {
    this.expect('(');
    const params: Raw[] = [];
    while (!this.isP(')')) {
      if (this.isP('...')) this.at++;
      this.ident();
      if (this.isP('?')) this.at++;
      if (this.isP(':')) {
        this.at++;
        params.push(this.type());
      }
      if (!this.isP(',')) break;
      this.at++;
    }
    this.expect(')');
    this.expect(':');
    return { k: 'function', params, ret: this.type() };
  }

  private skipSeparator(): void {
    if (this.isP(';') || this.isP(',')) this.at++;
  }

  private tuple(): Raw {
    this.expect('[');
    const elems: Raw[] = [];
    while (!this.isP(']')) {
      elems.push(this.type());
      if (!this.isP(',')) break;
      this.at++;
    }
    this.expect(']');
    return { k: 'tuple', elems };
  }
}

/** The raw tree of one written text; throws TypeSyntaxError when it does not parse. */
function readRaw(text: string): Raw {
  return new RawParser(tokenize(text)).position();
}

// ---------------------------------------------------------------------------
// Normalisation: the raw tree judged and turned into the canonical expression
// ---------------------------------------------------------------------------

/** A problem that ends the reading: there is no canonical expression. */
class TypeProblemError extends Error {
  constructor(readonly code: Exclude<TypeProblemCode, 'TYPE_NOT_NEUTRAL'>, readonly detail: string, readonly replacement?: string) {
    super(detail);
  }
}

/** How one node is read: what its place in the position allows. */
interface ReadContext {
  /** The whole position's kind. */
  position: TypePosition;
  /** At the top of the position (through parentheses only). */
  top: boolean;
  /** `void` may stand here: the whole of a returns, or directly under its async. */
  voidAllowed: boolean;
  /** The position's optional flag is set: `T | undefined` reads as T. */
  omittable: boolean;
  /** Reading code rather than a spec: `number` reads as the loose number marker. */
  looseNumber: boolean;
}

/** What a reading collected besides the expression: the first non-neutral name, which does not end it. */
interface ReadNotes {
  notNeutral?: { detail: string; replacement: string };
}

const RETURNS_POSITIONS: ReadonlySet<TypePosition> = new Set(['returns', 'type-method-returns', 'signature-returns']);

/** The internal marker a code reading gives TypeScript's `number`: int and float alike. */
const LOOSE_NUMBER = 'number';

function primitive(name: string): TypeExpression {
  return { form: 'primitive', name, args: [] };
}

/** The member a `?` (or a none in a union) makes optional; `any?` is any, and T?? and void? are refused. */
function optionalOf(inner: TypeExpression): TypeExpression {
  if (inner.form === 'primitive' && inner.name === 'any') return inner;
  if (inner.form === 'optional') throw new TypeProblemError('TYPE_POSITION_INVALID', 'a type is made optional twice (T??)', 'T?');
  if (inner.form === 'primitive' && inner.name === 'void') throw new TypeProblemError('TYPE_POSITION_INVALID', 'void cannot be optional (void?)', 'void');
  return { form: 'optional', args: [inner] };
}

/** A context one level down: no longer at the top, so neither async nor a bare void stands there. */
function inner(ctx: ReadContext): ReadContext {
  return { ...ctx, top: false, voidAllowed: false, omittable: false };
}

/** Read one raw node into its canonical expression under the context, or throw the problem. */
function normalise(node: Raw, ctx: ReadContext, notes: ReadNotes): TypeExpression {
  switch (node.k) {
    case 'paren':
      return normalise(node.inner, ctx, notes);
    case 'async':
      return asyncOf(node.inner, ctx, notes, 'async');
    case 'array':
      return { form: 'list', args: [normalise(node.elem, inner(ctx), notes)] };
    case 'opt':
      return optionalOf(normalise(node.inner, inner(ctx), notes));
    case 'union':
      return unionOf(node.members, ctx, notes);
    case 'name':
      return node.args === undefined ? bareName(node.name, ctx, notes) : appliedName(node.name, node.args, ctx, notes);
    case 'literal':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', `${node.text} is a literal value, not a type — a literal union is not in the grammar`, 'an enum type naming the values');
    case 'object':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'an inline object shape is not in the grammar', 'a named value-object');
    case 'function':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'an inline function type is not in the grammar', 'a signature type');
    case 'intersection':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'an intersection (A & B) is not in the grammar', 'a named type');
    case 'tuple':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'a tuple is not in the grammar', 'a named value-object');
    case 'operator':
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', `"${node.op}" is TypeScript's type algebra, not in the grammar`, 'a named type');
  }
}

/** `async T` / `Promise<T>`: only at the top of a returns; void may stand directly under it. */
function asyncOf(innerNode: Raw, ctx: ReadContext, notes: ReadNotes, spelled: string): TypeExpression {
  if (!ctx.top || !RETURNS_POSITIONS.has(ctx.position)) {
    throw new TypeProblemError('TYPE_POSITION_INVALID', `${spelled} may stand only at the top of a returns, not in a ${ctx.position}`);
  }
  const read = normalise(innerNode, { ...inner(ctx), voidAllowed: true }, notes);
  return { form: 'async', args: [read] };
}

/** A bare name: a primitive, an alias, a legacy name, a none, or a named type. */
function bareName(name: string, ctx: ReadContext, notes: ReadNotes): TypeExpression {
  const lower = name.toLowerCase();
  if (NONES.has(name)) {
    throw new TypeProblemError('TYPE_EXPRESSION_INVALID', `"${name}" on its own names no type — "no value" joins a type as T?`, 'T?, or void for a returns that answers nothing');
  }
  if (lower === 'true' || lower === 'false') {
    throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', `${name} is a literal value, not a type`, 'bool, or an enum type naming the values');
  }
  if (name === 'number' || lower === 'number') {
    if (ctx.looseNumber) return primitive(LOOSE_NUMBER);
    notes.notNeutral ??= { detail: '"number" does not say whether it holds an integer — int or float?', replacement: 'int or float' };
    return primitive('float');
  }
  const prim = primitiveOf(name);
  if (prim !== undefined) {
    if (prim === 'void' && !ctx.voidAllowed) {
      throw new TypeProblemError('TYPE_POSITION_INVALID', `void may stand only as a whole returns (or async void), not in a ${ctx.top ? ctx.position : 'collection, union or argument'}`);
    }
    return primitive(prim);
  }
  if (genericOf(name) !== undefined) {
    throw new TypeProblemError('TYPE_EXPRESSION_INVALID', `"${name}" needs its type arguments`, `${genericOf(name)?.form ?? 'list'}<...>`);
  }
  const legacy = NOT_NEUTRAL.get(lower);
  if (legacy !== undefined) {
    notes.notNeutral ??= { detail: `"${name}" has no neutral meaning`, replacement: legacy };
    return primitive('any');
  }
  return { form: 'named', name, args: [] };
}

/** A name applied to arguments: a collection alias, the optional marker, async, a legacy generic, or a user generic. */
function appliedName(name: string, args: Raw[], ctx: ReadContext, notes: ReadNotes): TypeExpression {
  const alias = genericOf(name);
  if (alias !== undefined) {
    if (args.length !== alias.arity) {
      throw new TypeProblemError('TYPE_EXPRESSION_INVALID', `"${name}" takes ${alias.arity} type argument${alias.arity === 1 ? '' : 's'}, ${args.length} given`);
    }
    if (alias.form === 'async') return asyncOf(args[0], ctx, notes, `${name}<...>`);
    if (alias.form === 'optional') return optionalOf(normalise(args[0], inner(ctx), notes));
    const read = args.map((a) => normalise(a, inner(ctx), notes));
    if (alias.form === 'map') assertMapKey(read[0], args[0]);
    return { form: alias.form, args: read };
  }
  if (UTILITY_TYPES.has(name)) {
    throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', `"${name}<...>" is a TypeScript utility type, not in the grammar`, 'a named type');
  }
  if (primitiveOf(name) !== undefined || NONES.has(name)) {
    throw new TypeProblemError('TYPE_EXPRESSION_INVALID', `"${name}" takes no type arguments`);
  }
  const legacy = NOT_NEUTRAL.get(name.toLowerCase());
  if (legacy !== undefined) {
    // Read through so the reading stays checkable, then reported as not neutral.
    args.forEach((a) => normalise(a, { ...inner(ctx), voidAllowed: true }, notes));
    notes.notNeutral ??= { detail: `"${name}<...>" has no neutral meaning`, replacement: legacy };
    return primitive('any');
  }
  return { form: 'applied', name, args: args.map((a) => normalise(a, inner(ctx), notes)) };
}

/** A map key is string, int or an enum (any named type: whether it is an enum is the tree's to say). */
function assertMapKey(key: TypeExpression, written: Raw): void {
  if (key.form === 'named') return;
  if (key.form === 'primitive' && (key.name === 'string' || key.name === 'int' || key.name === LOOSE_NUMBER)) return;
  // `number` read as float keeps its own problem (int or float?) rather than a second one.
  if (key.form === 'primitive' && key.name === 'float' && written.k === 'name' && written.name.toLowerCase() === 'number') return;
  throw new TypeProblemError('TYPE_POSITION_INVALID', 'a map key must be string, int or an enum', 'map<string, V>');
}

/** A union: nones fold into `?`; the rest must be named types (M3), or a single member of any form. */
function unionOf(members: Raw[], ctx: ReadContext, notes: ReadNotes): TypeExpression {
  const nones = members.filter((m) => m.k === 'name' && m.args === undefined && NONES.has(m.name)) as { k: 'name'; name: string }[];
  const rest = members.filter((m) => !(m.k === 'name' && m.args === undefined && NONES.has(m.name)));
  if (rest.length === 0) throw new TypeProblemError('TYPE_EXPRESSION_INVALID', 'a union of nones names no type');
  if (rest.some((m) => m.k === 'literal' || (m.k === 'name' && m.args === undefined && /^(true|false)$/i.test(m.name)))) {
    throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'a union of literal values is not in the grammar', 'an enum type naming the values');
  }
  // Every member is read below the top: neither async nor void joins a union,
  // whatever the nones beside it.
  const memberCtx = inner(ctx);
  let hasNone = nones.length > 0;
  const read = rest.map((m) => {
    const e = normalise(m, memberCtx, notes);
    if (e.form !== 'optional') return e;
    hasNone = true;
    return e.args[0];
  });
  let base: TypeExpression;
  if (read.length === 1) {
    base = read[0];
  } else {
    const loose = read.find((e) => e.form !== 'named' && e.form !== 'applied');
    if (loose) {
      throw new TypeProblemError('TYPE_FORM_UNSUPPORTED', 'a union may hold only named types — this one mixes in a primitive or a collection', 'a named type (an entity, value-object or enum), or two params');
    }
    base = { form: 'union', args: read };
  }
  if (!hasNone) return base;
  // On an omittable position at the top, TypeScript's `undefined` IS "left out": the flag says it.
  const onlyUndefined = nones.length > 0 && nones.every((n) => n.name === 'undefined') && read.length === rest.length
    && !rest.some((m) => m.k === 'opt');
  if (ctx.omittable && ctx.top && onlyUndefined) return base;
  return optionalOf(base);
}

// ---------------------------------------------------------------------------
// type_expression's methods
// ---------------------------------------------------------------------------

/** The text of one expression at union-member depth: an optional union wears its parentheses. */
export function canonicalTypeText(expr: TypeExpression): string {
  switch (expr.form) {
    case 'primitive':
    case 'named':
      return expr.name ?? '';
    case 'list':
    case 'set':
      return `${expr.form}<${canonicalTypeText(expr.args[0])}>`;
    case 'map':
      return `map<${canonicalTypeText(expr.args[0])}, ${canonicalTypeText(expr.args[1])}>`;
    case 'optional': {
      const innerText = canonicalTypeText(expr.args[0]);
      return expr.args[0].form === 'union' ? `(${innerText})?` : `${innerText}?`;
    }
    case 'union':
      return expr.args.map(canonicalTypeText).join(' | ');
    case 'async':
      return `async ${canonicalTypeText(expr.args[0])}`;
    case 'applied':
      return `${expr.name}<${expr.args.map(canonicalTypeText).join(', ')}>`;
  }
}

/** type_expression.namedRefs — every named type referenced, in order of appearance, duplicates kept. */
export function typeNamedRefs(expr: TypeExpression): string[] {
  if (expr.form === 'named') return [expr.name!];
  const own = expr.form === 'applied' ? [expr.name!] : [];
  return [...own, ...expr.args.flatMap(typeNamedRefs)];
}

/** type_expression.isMany — a list, set or map at the top, under `?` or under async. */
export function typeIsMany(expr: TypeExpression): boolean {
  if (expr.form === 'list' || expr.form === 'set' || expr.form === 'map') return true;
  if (expr.form === 'optional' || expr.form === 'async') return typeIsMany(expr.args[0]);
  return false;
}

/** The context one position is read in. */
function contextFor(position: TypePosition, omittable: boolean, looseNumber = false): ReadContext {
  return { position, top: true, voidAllowed: RETURNS_POSITIONS.has(position), omittable, looseNumber };
}

/**
 * Read one position, with the position's optional flag: on an omittable
 * position TypeScript's `T | undefined` reads as T, since the flag already says
 * "may be left out". type_expression.parse is this with no flag.
 */
export function parseTypePosition(text: string, position: TypePosition, omittable = false): TypeParse {
  let raw: Raw;
  try {
    raw = readRaw(text);
  } catch (e) {
    if (!(e instanceof TypeSyntaxError)) throw e;
    return { expression: null, canonical: text, problem: { code: 'TYPE_EXPRESSION_INVALID', written: text, detail: `"${text}" does not parse as a type: ${e.message}` } };
  }
  const notes: ReadNotes = {};
  try {
    const expression = normalise(raw, contextFor(position, omittable), notes);
    const problem: TypeExpressionProblem | null = notes.notNeutral
      ? { code: 'TYPE_NOT_NEUTRAL', written: text, detail: notes.notNeutral.detail, replacement: notes.notNeutral.replacement }
      : null;
    return { expression, canonical: canonicalTypeText(expression), problem };
  } catch (e) {
    if (!(e instanceof TypeProblemError)) throw e;
    return {
      expression: null,
      canonical: text,
      problem: { code: e.code, written: text, detail: `"${text}": ${e.detail}`, ...(e.replacement ? { replacement: e.replacement } : {}) },
    };
  }
}

/**
 * type_expression.parse — read one written type position under the grammar,
 * normalising every alias, and judge it for the position it stands in.
 */
export function parseTypeExpression(text: string, position: TypePosition): TypeParse {
  return parseTypePosition(text, position);
}

/**
 * A code annotation read the way a dialect reads it: as a returns may stand
 * (async and void allowed at the top), `T | undefined` as `T?`, and `number`
 * as the loose number marker when asked. Null when it has no canonical
 * reading. The TypeScript dialect's reader — the alias table above, once.
 */
export function readCodeAnnotation(annotation: string, looseNumber: boolean): TypeExpression | null {
  let raw: Raw;
  try {
    raw = readRaw(annotation);
  } catch (e) {
    if (e instanceof TypeSyntaxError) return null;
    throw e;
  }
  try {
    return normalise(raw, contextFor('returns', false, looseNumber), {});
  } catch (e) {
    if (e instanceof TypeProblemError) return null;
    throw e;
  }
}

/**
 * The named types a written position references, whatever its problem: the
 * canonical expression's when it reads cleanly, else every name the raw text
 * holds outside wairon's own vocabulary (an unsupported form still names the
 * types it uses). A text that does not parse names nothing.
 */
export function writtenTypeRefs(text: string, position: TypePosition): string[] {
  const parse = parseTypePosition(text, position);
  if (parse.expression && !parse.problem) return typeNamedRefs(parse.expression);
  try {
    return rawRefs(readRaw(text));
  } catch (e) {
    if (e instanceof TypeSyntaxError) return [];
    throw e;
  }
}

/** Every name a raw tree holds outside the vocabulary, in order. */
function rawRefs(node: Raw): string[] {
  switch (node.k) {
    case 'name': {
      const own = isTypeVocabulary(node.name) || UTILITY_TYPES.has(node.name) ? [] : [node.name];
      return [...own, ...(node.args ?? []).flatMap(rawRefs)];
    }
    case 'array': return rawRefs(node.elem);
    case 'opt':
    case 'paren':
    case 'async':
    case 'operator': return rawRefs(node.inner);
    case 'union':
    case 'intersection':
    case 'object': return node.members.flatMap(rawRefs);
    case 'tuple': return node.elems.flatMap(rawRefs);
    case 'function': return [...node.params.flatMap(rawRefs), ...rawRefs(node.ret)];
    case 'literal': return [];
  }
}

// ---------------------------------------------------------------------------
// interface_spec.canonicalTypes and type_spec.canonicalTypes
// ---------------------------------------------------------------------------

/** One spec's reading under way: who it is, and what the positions read so far gave. */
class Canonicalizer {
  readonly respellings: TypeRespelling[] = [];
  readonly problems: TypeExpressionProblem[] = [];
  constructor(private readonly specId: string, private readonly kind: 'interface' | 'type') {}

  /** One position: its canonical text when it has one, else the text as written, recorded either way. */
  read(text: string, position: TypePosition, path: string, omittable = false): string {
    const parse = parseTypePosition(text, position, omittable);
    if (parse.problem) {
      this.problems.push({ ...parse.problem, specId: this.specId, kind: this.kind, path });
      return text;
    }
    if (parse.canonical !== text) this.respellings.push({ specId: this.specId, kind: this.kind, path, written: text, stored: parse.canonical });
    return parse.canonical;
  }

  params<P extends Pick<MethodParam, 'name' | 'type' | 'optional'>>(params: P[], position: TypePosition, prefix: string): P[] {
    return params.map((p) => ({ ...p, type: this.read(p.type, position, `${prefix}.${p.name}`, !!p.optional) }));
  }
}

type AnyInterface = InterfaceSpec | StoredInterfaceSpec;
type AnyType = TypeSpec | StoredTypeSpec;

/**
 * interface_spec.canonicalTypes — this contract with every structured type
 * position read under the grammar: each canonicalisable position respelled,
 * every alias recorded as a respelling, every position that is not canonical
 * recorded as a located problem and left as written. A method without params
 * keeps its prose and only its returns is read; a sourced method has none to
 * read. Pure: the spec handed in is never mutated.
 */
export function interfaceCanonicalTypes<S extends AnyInterface>(intf: S): TypeCanonicalization<S> {
  const reader = new Canonicalizer(intf.id, 'interface');
  const methods = (intf.methods ?? []).map((m) => {
    if (m.signatureFrom !== undefined) return m;
    const out = { ...m };
    if (m.params !== undefined) out.params = reader.params(m.params, 'param', `methods.${m.name}.params`);
    if (typeof m.returns === 'string') out.returns = reader.read(m.returns, 'returns', `methods.${m.name}.returns`);
    return out;
  });
  return { spec: { ...intf, methods } as S, respellings: reader.respellings, problems: reader.problems };
}

/**
 * type_spec.canonicalTypes — this type with every type position read under the
 * grammar: its fields, its methods' params and returns, and a signature's
 * params and returns, each with the position it stands in. A type method
 * without params keeps its prose; only its returns is read. Pure.
 */
export function typeCanonicalTypes<S extends AnyType>(type: S): TypeCanonicalization<S> {
  const reader = new Canonicalizer(type.id, 'type');
  const out: Record<string, unknown> = { ...type };
  if (Array.isArray(type.fields)) {
    out.fields = type.fields.map((f) => ({ ...f, type: reader.read(f.type, 'field', `fields.${f.name}`, !!f.optional) }));
  }
  if (Array.isArray(type.methods)) {
    out.methods = type.methods.map((m) => {
      const method = { ...m };
      if (m.params !== undefined) method.params = reader.params(m.params, 'type-method-param', `methods.${m.name}.params`);
      if (typeof m.returns === 'string') method.returns = reader.read(m.returns, 'type-method-returns', `methods.${m.name}.returns`);
      return method;
    });
  }
  if (type.params !== undefined) out.params = reader.params(type.params, 'signature-param', 'params');
  if (typeof type.returns === 'string') out.returns = reader.read(type.returns, 'signature-returns', 'returns');
  return { spec: out as S, respellings: reader.respellings, problems: reader.problems };
}

/**
 * The words that plainly say a position holds a whole number: a count, a
 * size, a length, a limit, a port, a step, an index, a depth, a level, a unit
 * of time or of storage, a version. Fractional names (x, y, w, h, a score, a
 * ratio) are deliberately absent.
 */
const INTEGER_WORDS = new Set([
  'count', 'counts', 'size', 'sizes', 'length', 'len', 'limit', 'limits', 'port', 'step', 'steps', 'index', 'idx',
  'depth', 'level', 'levels', 'days', 'day', 'hours', 'minutes', 'seconds', 'ms', 'millis', 'milliseconds', 'bytes',
  'version', 'total', 'offset', 'page', 'pages', 'retries', 'attempts', 'number', 'num', 'line', 'lines',
  'column', 'columns', 'max', 'min', 'width', 'height',
]);

/**
 * Whether a position's NAME plainly says it holds an integer (a `count`, a
 * `maxDepth`, a `stepNumber`, a `ttl_days`) — the one case in which the
 * doctor's type-spelling repair PROPOSES int for a `number`, and the
 * type-expressions rule says so. Read word by word over camelCase, snake_case
 * and kebab-case; a proposal is never applied, an author confirms it.
 */
export function namesAnInteger(name: string): boolean {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s_\-.]+/).filter(Boolean);
  return words.some((word) => INTEGER_WORDS.has(word));
}

/** No facts at all: what a scan starts from. */
export function emptyTypeSpellingFacts(): TypeSpellingFacts {
  return { respellings: [], problems: [] };
}
