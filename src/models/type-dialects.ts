import { readCodeAnnotation, type TypeExpression } from './type-grammar.js';

// ---------------------------------------------------------------------------
// Type dialects — one language's reading and writing of the neutral type
// grammar: the seam through which code conformance and implementer briefs meet
// a language without the design ever speaking it.
//
// A dialect is code shipped beside the analyzer that reads that language, never
// configuration. It is registered here under the analyzer's language key; a
// future language plugs in by adding one entry to DIALECTS and nothing else —
// param conformance, async conformance and the briefs reach it through
// typeDialectFor.
//
// The position markers that are not types — an omittable `x?:` and the `async`
// modifier — are what the code's POSITION says, so the analyzer reports them as
// facts of their own and they never pass through `read`.
// ---------------------------------------------------------------------------

/** type_dialect — one language's reading and writing of the neutral grammar. */
export interface TypeDialect {
  /** The language this dialect reads and writes, as the code analyzer names it. */
  language: string;
  /** The canonical expression a code annotation spells, or null when it has no canonical reading. */
  read(annotation: string): TypeExpression | null;
  /** Whether a code annotation and a canonical spec expression describe the same type. */
  agrees(annotation: string, expression: TypeExpression, codeNames: Map<string, string>): boolean;
  /** This language's idiomatic spelling of a canonical expression. */
  write(expression: TypeExpression): string;
  /** The write table as lines an implementer brief carries. */
  mappingLines(): string[];
}

/** The last segment of a qualified name (`billing::invoice` gives `invoice`). */
function lastSegment(name: string): string {
  return name.split(/::|\./).filter(Boolean).pop() ?? name;
}

/**
 * Whether a code reading and a spec expression are one type: equal form by
 * form; a named type agreeing through its code-level name; TypeScript's
 * `number` (the loose marker) agreeing with int and float alike; and a spec's
 * `result<T, E>` agreeing with a code T — TypeScript has no typed failure, so
 * the function returns T and throws E, and E is never compared.
 */
function sameType(code: TypeExpression, spec: TypeExpression, codeNames: Map<string, string>): boolean {
  if (spec.form === 'result' && code.form !== 'result') return sameType(code, spec.args[0], codeNames);
  if (code.form === 'primitive' && code.name === 'number') return spec.form === 'primitive' && (spec.name === 'int' || spec.name === 'float');
  if (code.form === 'named' && (spec.form === 'named' || spec.form === 'applied')) {
    if (spec.form === 'applied') return false;
    return namesAgree(code.name!, spec.name!, codeNames);
  }
  if (code.form !== spec.form) return false;
  if (code.form === 'primitive') return code.name === spec.name;
  if (code.form === 'applied' && !namesAgree(code.name!, spec.name!, codeNames)) return false;
  if (code.args.length !== spec.args.length) return false;
  return code.args.every((arg, i) => sameType(arg, spec.args[i], codeNames));
}

/** A code name and a spec reference name one type: equal, or the spec's id maps to the code name. */
export function namesAgree(codeName: string, specName: string, codeNames: Map<string, string>): boolean {
  if (codeName === specName) return true;
  const mapped = codeNames.get(specName) ?? codeNames.get(lastSegment(specName));
  return mapped === codeName || mapped === lastSegment(codeName);
}

/** TypeScript's spelling of one canonical expression. */
function writeTypeScript(expr: TypeExpression): string {
  switch (expr.form) {
    case 'primitive':
      return TS_PRIMITIVES[expr.name ?? ''] ?? expr.name ?? 'unknown';
    case 'named':
      return expr.name ?? 'unknown';
    case 'list': {
      const elem = writeTypeScript(expr.args[0]);
      return /[|\s]/.test(elem) ? `(${elem})[]` : `${elem}[]`;
    }
    case 'set':
      return `Set<${writeTypeScript(expr.args[0])}>`;
    case 'map':
      return `Record<${writeTypeScript(expr.args[0])}, ${writeTypeScript(expr.args[1])}>`;
    case 'optional':
      return `${writeTypeScript(expr.args[0])} | null`;
    case 'union':
      return expr.args.map(writeTypeScript).join(' | ');
    case 'async':
      return `Promise<${writeTypeScript(expr.args[0])}>`;
    case 'result':
      // The success type: the function throws its failure.
      return writeTypeScript(expr.args[0]);
    case 'applied':
      return `${expr.name}<${expr.args.map(writeTypeScript).join(', ')}>`;
  }
}

/** TypeScript's spelling of each primitive. */
const TS_PRIMITIVES: Record<string, string> = {
  string: 'string',
  int: 'number',
  float: 'number',
  bool: 'boolean',
  bytes: 'Uint8Array',
  date: 'string',
  datetime: 'string',
  duration: 'string',
  void: 'void',
  any: 'unknown',
};

/** The TypeScript dialect: its reader is the grammar's alias table, plus the loose readings only code needs. */
const typescriptDialect: TypeDialect = {
  language: 'typescript',
  read(annotation: string): TypeExpression | null {
    return readCodeAnnotation(annotation, false);
  },
  agrees(annotation: string, expression: TypeExpression, codeNames: Map<string, string>): boolean {
    const code = readCodeAnnotation(annotation, true);
    return code !== null && sameType(code, expression, codeNames);
  },
  write(expression: TypeExpression): string {
    return writeTypeScript(expression);
  },
  mappingLines(): string[] {
    return [
      'string → string',
      'int, float → number',
      'bool → boolean',
      'bytes → Uint8Array',
      'date, datetime, duration → string (ISO 8601)',
      'any → unknown',
      'list<T> → T[]',
      'set<T> → Set<T>',
      'map<K, V> → Record<K, V>',
      'T? → T | null',
      'A | B → A | B',
      'async T → Promise<T>',
      'result<T, E> → T, throwing E on failure (result<void, E> → void)',
      "an enum E → type E = 'a' | 'b' (a string-literal union alias)",
      'a named scalar E holding P → type E = P (an alias of the primitive)',
    ];
  },
};

// ---------------------------------------------------------------------------
// Python — read off the annotations the Python reader records (a `def`'s
// parameter and return annotations, as written). typing's spellings and the
// builtin generics read alike: `list[T]` and `List[T]`, `T | None` and
// `Optional[T]`. A name the table does not know is a named type, compared
// through its code-level name; a generic it does not know is applied.
// ---------------------------------------------------------------------------

/** Python's builtin and typing names for each primitive. */
const PY_PRIMITIVES: Record<string, string> = {
  str: 'string', int: 'int', float: 'float', bool: 'bool',
  bytes: 'bytes', bytearray: 'bytes', memoryview: 'bytes',
  None: 'void', NoneType: 'void', Any: 'any', object: 'any',
  date: 'date', datetime: 'datetime', timedelta: 'duration',
};
const PY_LISTS = new Set(['list', 'List', 'Sequence', 'MutableSequence', 'Iterable', 'Collection']);
const PY_SETS = new Set(['set', 'Set', 'frozenset', 'FrozenSet', 'AbstractSet', 'MutableSet']);
const PY_MAPS = new Set(['dict', 'Dict', 'Mapping', 'MutableMapping']);
const PY_ASYNC = new Set(['Awaitable', 'Coroutine']);

/** Split at top-level occurrences of one separator character. */
function splitTop(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

/** A Python annotation as a canonical expression; null when it has no canonical reading. */
function readPythonAnnotation(annotation: string): TypeExpression | null {
  const text = annotation.trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  if (!text) return null;
  const members = splitTop(text, '|');
  if (members.length > 1) {
    const read = members.map(readPythonAnnotation);
    if (read.some(m => m === null)) return null;
    const some = (read as TypeExpression[]).filter(m => !(m.form === 'primitive' && m.name === 'void'));
    if (some.length === 0) return { form: 'primitive', name: 'void', args: [] };
    const inner: TypeExpression = some.length === 1 ? some[0] : { form: 'union', args: some };
    return some.length < read.length ? { form: 'optional', args: [inner] } : inner;
  }
  const generic = /^([A-Za-z_][\w.]*)\s*\[([\s\S]*)\]$/.exec(text);
  const head = (generic ? generic[1] : text).split('.').pop() ?? '';
  if (!/^[A-Za-z_]\w*$/.test(head)) return null;
  if (!generic) {
    const primitive = Object.prototype.hasOwnProperty.call(PY_PRIMITIVES, head) ? PY_PRIMITIVES[head] : undefined;
    return primitive ? { form: 'primitive', name: primitive, args: [] } : { form: 'named', name: head, args: [] };
  }
  const written = splitTop(generic[2], ',');
  if (head === 'Union') return readPythonAnnotation(written.join(' | '));
  const args = written.map(readPythonAnnotation);
  if (args.some(a => a === null)) return null;
  const read = args as TypeExpression[];
  if (head === 'Optional' && read.length === 1) return { form: 'optional', args: read };
  if (PY_LISTS.has(head) && read.length === 1) return { form: 'list', args: read };
  if (PY_SETS.has(head) && read.length === 1) return { form: 'set', args: read };
  if (PY_MAPS.has(head) && read.length === 2) return { form: 'map', args: read };
  if (PY_ASYNC.has(head) && read.length >= 1) return { form: 'async', args: [read[read.length - 1]] };
  return { form: 'applied', name: head, args: read };
}

/** Python's spelling of each primitive. */
const PY_WRITTEN: Record<string, string> = {
  string: 'str', int: 'int', float: 'float', bool: 'bool', bytes: 'bytes',
  date: 'datetime.date', datetime: 'datetime.datetime', duration: 'datetime.timedelta',
  void: 'None', any: 'typing.Any',
};

/** Python's spelling of one canonical expression. */
function writePython(expr: TypeExpression): string {
  switch (expr.form) {
    case 'primitive':
      return PY_WRITTEN[expr.name ?? ''] ?? expr.name ?? 'typing.Any';
    case 'named':
      return expr.name ?? 'typing.Any';
    case 'list':
      return `list[${writePython(expr.args[0])}]`;
    case 'set':
      return `set[${writePython(expr.args[0])}]`;
    case 'map':
      return `dict[${writePython(expr.args[0])}, ${writePython(expr.args[1])}]`;
    case 'optional':
      return `${writePython(expr.args[0])} | None`;
    case 'union':
      return expr.args.map(writePython).join(' | ');
    case 'async':
      // An `async def` returning T: the coroutine is the def's, not the annotation's.
      return writePython(expr.args[0]);
    case 'result':
      return writePython(expr.args[0]);
    case 'applied':
      return `${expr.name}[${expr.args.map(writePython).join(', ')}]`;
  }
}

/** The Python dialect: reads what the Python reader records, writes the idiomatic spelling. */
const pythonDialect: TypeDialect = {
  language: 'python',
  read(annotation: string): TypeExpression | null {
    return readPythonAnnotation(annotation);
  },
  agrees(annotation: string, expression: TypeExpression, codeNames: Map<string, string>): boolean {
    const code = readPythonAnnotation(annotation);
    return code !== null && sameType(code, expression, codeNames);
  },
  write(expression: TypeExpression): string {
    return writePython(expression);
  },
  mappingLines(): string[] {
    return [
      'string → str',
      'int → int',
      'float → float',
      'bool → bool',
      'bytes → bytes',
      'date → datetime.date, datetime → datetime.datetime, duration → datetime.timedelta',
      'any → typing.Any',
      'list<T> → list[T]',
      'set<T> → set[T]',
      'map<K, V> → dict[K, V]',
      'T? → T | None (Optional[T])',
      'A | B → A | B',
      'async T → async def returning T',
      'result<T, E> → T, raising E on failure (result<void, E> → None)',
      'an enum E → class E(enum.Enum)',
      'a named scalar E holding P → E = NewType("E", P)',
      'a contract (interface) → a typing.Protocol; an entity or value-object → a @dataclass',
      'a parameter is named in snake_case: the contract\'s documentId is document_id in the code',
    ];
  },
};

/** The shipped dialects, by the analyzer's language key. */
const DIALECTS: ReadonlyMap<string, TypeDialect> = new Map([
  ['typescript', typescriptDialect],
  ['javascript', typescriptDialect],
  ['python', pythonDialect],
]);

/** type_dialect.forLanguage — the dialect shipped for a language, or null when none reads it yet. */
export function typeDialectFor(language: string): TypeDialect | null {
  return DIALECTS.get(language.toLowerCase()) ?? null;
}

/**
 * The line every mapping-only table ends with: it spells types for the
 * implementer, and nothing reads the code back.
 */
const MAPPING_ONLY = (language: string): string =>
  `(mapping only: wairon's code analyzer does not read ${language} annotations yet, so code conformance does not compare these types — follow the table by hand)`;

/**
 * Write tables shipped for languages no dialect reads yet: a brief can tell
 * an implementer how the neutral grammar is spelled there, which is the whole
 * of what a brief needs — reading the code back is a dialect's job, and these
 * languages have none.
 */
const MAPPING_ONLY_TABLES: ReadonlyMap<string, readonly string[]> = new Map([
  ['rust', [
    'string → String (&str for a borrowed parameter)',
    'int → i64 (a narrower iN/uN where the contract says so in its description)',
    'float → f64',
    'bool → bool',
    'bytes → Vec<u8> (&[u8] for a borrowed parameter)',
    'date → chrono::NaiveDate, datetime → chrono::DateTime<Utc>, duration → std::time::Duration',
    'any → serde_json::Value',
    'list<T> → Vec<T>',
    'set<T> → HashSet<T> (BTreeSet<T> where order matters)',
    'map<K, V> → HashMap<K, V> (BTreeMap<K, V> where order matters)',
    'T? → Option<T>',
    'A | B → an enum with one variant per named type',
    'async T → async fn returning T',
    'result<T, E> → Result<T, E> (result<void, E> → Result<(), E>)',
    'an enum E → enum E { A, B } (unit variants)',
    'a named scalar E holding P → a newtype struct E(P)',
    'a contract (interface) → a trait; a type method → an impl method on the struct',
  ]],
]);

/**
 * type_dialect.mappingFor — the write table an implementer brief carries for
 * a language: a shipped dialect's mappingLines, else a MAPPING-ONLY table for
 * a language no dialect reads yet (Rust), whose last line says that
 * code conformance does not compare its types. Null for a language with
 * neither.
 */
export function typeMappingFor(language: string): string[] | null {
  const dialect = typeDialectFor(language);
  if (dialect) return dialect.mappingLines();
  const key = language.toLowerCase();
  const table = MAPPING_ONLY_TABLES.get(key);
  return table ? [...table, MAPPING_ONLY(language)] : null;
}

