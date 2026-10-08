// ---------------------------------------------------------------------------
// identifier — the one grammar every id and name of the design is judged by.
//
// A spec id, a project id, a member or external alias, and a method, parameter
// or field name all share one portability floor: not empty, at most 64
// characters, no control, NUL or zero-width character, never starting with
// "-" (no command line could name it), never "__proto__" (JavaScript's
// prototype accessor, which the YAML and JSON readers drop as a key). Each kind
// adds its own character grammar; the kinds that become a path segment or a
// file name refuse the Windows device names; the kinds that are the first
// segment of `alias::name` refuse the reserved namespace keyword `super`; and
// a member name never starts with a digit.
//
// The target language's reserved words are a separate question
// (reservedWordProblem): only the tree's targetLanguage can answer it, and the
// zod schemas that refine ids with identifierProblem cannot see it.
import { ownGet } from '../utils/own.js';

// ---------------------------------------------------------------------------

/** identifier — one identifier as written: a spec id, a project id, an alias, or a method, parameter or field name. */
export type Identifier = string;

/** display_name — a spec's human-readable `name`: free text, never blank, no invisible character. */
export type DisplayName = string;

/** identifier_kind — what an identifier names, which decides the grammar it is judged by. */
export type IdentifierKind = 'spec-id' | 'project-id' | 'alias' | 'method' | 'param' | 'field';

/**
 * The longest identifier of any kind. A spec id is a folder and a file name
 * under `.wai/specs/`, and git for Windows refuses paths over 260 characters
 * by default; 64 keeps two nested ids plus a file name near 150. The same cap
 * holds for every kind (a DNS label stops at 63, a Postgres identifier at 63).
 */
export const MAX_IDENTIFIER_LENGTH = 64;

/** The invisible characters (a control character — C0, DEL, C1 — a soft hyphen, a zero-width or bidi-control character, or a BOM) as a regular-expression character-class body (for a schema's negated class). */
export const INVISIBLE_CHARACTERS = '\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff';
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CHARACTERS}]`);

/** The names Windows reserves for devices, in any case, with any extension-like suffix. */
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

/** Each kind's own character grammar, and how a refusal names it. */
const GRAMMAR: Record<IdentifierKind, { re: RegExp; words: string }> = {
  'spec-id': { re: /^[a-z0-9_-]+$/, words: 'must be lowercase alphanumeric with dashes or underscores' },
  'project-id': { re: /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/, words: 'is no project id: [a-z0-9-_.], starting and ending alphanumeric' },
  alias: { re: /^[a-z0-9_-]+$/, words: 'breaks [a-z0-9-_]+ (the alias grammar)' },
  method: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, words: 'is not an identifier (a letter or underscore, then letters, digits or underscores)' },
  param: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, words: 'is not an identifier (a letter or underscore, then letters, digits or underscores)' },
  field: { re: /^[A-Za-z_][A-Za-z0-9_]*$/, words: 'is not an identifier (a letter or underscore, then letters, digits or underscores)' },
};

/** What each kind is called in a sentence. */
const NOUN: Record<IdentifierKind, string> = {
  'spec-id': 'an id',
  'project-id': 'a project id',
  alias: 'an alias',
  method: 'a method name',
  param: 'a parameter name',
  field: 'a field name',
};

/** The first invisible character of a text, as `U+XXXX`, or undefined. */
function invisibleCharacter(text: string): string | undefined {
  const hit = INVISIBLE_RE.exec(text);
  return hit ? `U+${hit[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : undefined;
}

/**
 * identifier.problemAs — why `text` is no identifier of this kind, as one
 * sentence a refusal can carry (it starts with the quoted text), or null when
 * it is one. Pure.
 */
export function identifierProblem(text: string, kind: IdentifierKind): string | null {
  const noun = NOUN[kind];
  if (typeof text !== 'string' || text.length === 0) return `${noun} is empty: it needs at least one character`;
  const shown = JSON.stringify(text.length > 80 ? `${text.slice(0, 40)}…` : text);
  const hidden = invisibleCharacter(text);
  if (hidden) return `${shown} holds an invisible character (${hidden}: a control, NUL or zero-width character), which no view shows and some tools cut the text at — retype it`;
  if (text.length > MAX_IDENTIFIER_LENGTH) {
    return `${shown} is longer than ${MAX_IDENTIFIER_LENGTH} characters (${text.length}): ${kind === 'spec-id' || kind === 'project-id' || kind === 'alias' ? 'it becomes a folder or a file name, and a longer one breaks the path limits of a Windows checkout' : 'every kind of id and name stops at 64, as a DNS label or a database identifier does'} — choose a shorter one`;
  }
  if (text.startsWith('-')) return `${shown} starts with "-", which every command line reads as an option, so no CLI command could name it — start it with a letter or a digit`;
  if (text === '__proto__') return `${shown} is the name JavaScript reserves for an object's prototype: the YAML and JSON readers drop a key of that name, so nothing keyed on it could be found — choose another`;
  const grammar = GRAMMAR[kind];
  if ((kind === 'method' || kind === 'param' || kind === 'field') && /^[0-9]/.test(text)) {
    return `${shown} starts with a digit, which no programming language accepts at the start of an identifier — start it with a letter`;
  }
  if (!grammar.re.test(text)) return `${shown} ${grammar.words}`;
  if ((kind === 'spec-id' || kind === 'project-id' || kind === 'alias') && WINDOWS_DEVICE_RE.test(text)) {
    return `${shown} is a name Windows reserves for a device (con, prn, aux, nul, com0-9, lpt0-9): no Windows checkout could hold a file of that name, and \`git add\` fails for the whole repository — choose another (e.g. "${text}_store")`;
  }
  if ((kind === 'project-id' || kind === 'alias') && text === 'super') {
    return `${shown} is the keyword the :: reference grammar reserves for a namespace hop, so \`super::name\` could never reach it — choose another`;
  }
  return null;
}

/**
 * display_name.problem — why `text` is no display name: empty or blank, or
 * holding an invisible character. Null when it is one. Pure.
 */
export function displayNameProblem(text: string): string | null {
  if (typeof text !== 'string' || text.trim() === '') return 'a name is empty: give it a readable name';
  const hidden = invisibleCharacter(text);
  if (hidden) return `the name ${JSON.stringify(text)} holds an invisible character (${hidden}: a control, NUL or zero-width character), which no view shows, some tools cut the text at, and turns a diagram into a binary file — retype it`;
  return null;
}

// ── Target-language reserved words ──────────────────────────────────────────

const words = (list: string): ReadonlySet<string> => new Set(list.split(/\s+/).filter(Boolean));

const JS_KEYWORDS = words(`break case catch class const continue debugger default delete do else enum export extends
  false finally for function if import in instanceof new null return super switch this throw true try typeof var void
  while with yield let static implements interface package private protected public await arguments eval`);
const RUST_KEYWORDS = words(`as break const continue crate else enum extern false fn for if impl in let loop match mod
  move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn abstract
  become box do final macro override priv typeof unsized virtual yield try gen`);
const PYTHON_KEYWORDS = words(`False None True and as assert async await break class continue def del elif else except
  finally for from global if import in is lambda nonlocal not or pass raise return try while with yield`);
const GO_KEYWORDS = words(`break case chan const continue default defer else fallthrough for func go goto if import
  interface map package range return select struct switch type var`);
const JAVA_KEYWORDS = words(`abstract assert boolean break byte case catch char class const continue default do double
  else enum extends final finally float for goto if implements import instanceof int interface long native new package
  private protected public return short static strictfp super switch synchronized this throw throws transient try void
  volatile while true false null _`);
const CSHARP_KEYWORDS = words(`abstract as base bool break byte case catch char checked class const continue decimal
  default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in
  int interface internal is lock long namespace new null object operator out override params private protected public
  readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint
  ulong unchecked unsafe ushort using virtual void volatile while`);
const C_KEYWORDS = words(`auto break case char const continue default do double else enum extern float for goto if
  inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void
  volatile while bool true false nullptr alignas alignof constexpr static_assert thread_local typeof`);
const KOTLIN_KEYWORDS = words(`as break class continue do else false for fun if in interface is null object package
  return super this throw true try typealias typeof val var when while`);
const RUBY_KEYWORDS = words(`alias and begin break case class def defined? do else elsif end ensure false for if in
  module next nil not or redo rescue retry return self super then true undef unless until when while yield
  BEGIN END __ENCODING__ __LINE__ __FILE__`);

/** One language's table: what it reserves, and for which kinds of identifier. */
interface LanguageWords {
  label: string;
  reserved: ReadonlySet<string>;
  /** The kinds the reserved words are refused as; a kind not listed may be any of them. */
  kinds: ReadonlySet<'method' | 'param' | 'field'>;
  /** Extra words refused for one kind only (TypeScript: constructor as a method). */
  extra?: Partial<Record<'method' | 'param' | 'field', ReadonlySet<string>>>;
}

const EVERY = new Set<'method' | 'param' | 'field'>(['method', 'param', 'field']);
const PARAMS_ONLY = new Set<'method' | 'param' | 'field'>(['param']);

/**
 * The small per-language tables, by lowercased targetLanguage. TypeScript and
 * JavaScript allow a keyword as a method or a property name (`obj.delete()`),
 * never as a parameter, and a class method can never be named `constructor`;
 * Ruby allows a keyword as a method name only after an explicit receiver and
 * never as a parameter. Rust, Python, Go, Java, C#, C and Kotlin refuse their
 * keywords as every kind of identifier.
 */
const LANGUAGES: Readonly<Record<string, LanguageWords>> = {
  typescript: { label: 'TypeScript', reserved: JS_KEYWORDS, kinds: PARAMS_ONLY, extra: { method: words('constructor') } },
  javascript: { label: 'JavaScript', reserved: JS_KEYWORDS, kinds: PARAMS_ONLY, extra: { method: words('constructor') } },
  rust: { label: 'Rust', reserved: RUST_KEYWORDS, kinds: EVERY },
  python: { label: 'Python', reserved: PYTHON_KEYWORDS, kinds: EVERY },
  go: { label: 'Go', reserved: GO_KEYWORDS, kinds: EVERY },
  java: { label: 'Java', reserved: JAVA_KEYWORDS, kinds: EVERY },
  csharp: { label: 'C#', reserved: CSHARP_KEYWORDS, kinds: EVERY },
  'c#': { label: 'C#', reserved: CSHARP_KEYWORDS, kinds: EVERY },
  c: { label: 'C', reserved: C_KEYWORDS, kinds: EVERY },
  kotlin: { label: 'Kotlin', reserved: KOTLIN_KEYWORDS, kinds: EVERY },
  ruby: { label: 'Ruby', reserved: RUBY_KEYWORDS, kinds: PARAMS_ONLY },
};

/** A few reserved words with a natural replacement. */
const SYNONYMS: Readonly<Record<string, string>> = {
  type: 'kind', class: 'kind', fn: 'func', function: 'func', match: 'matches', async: 'is_async', await: 'awaited',
  self: 'target', super: 'parent', new: 'create', delete: 'remove', default: 'fallback', in: 'input', constructor: 'create',
  import: 'imported', export: 'exported', package: 'pkg', interface: 'contract', static: 'fixed', ref: 'reference',
  mod: 'module_name', move: 'shift', crate: 'package_name', impl: 'implementation', trait: 'capability', use: 'usage',
  loop: 'cycle', return: 'result', yield: 'produce', let: 'binding', var: 'variable', const: 'constant', enum: 'choice',
};

/** An alternative to a reserved word that fits the casing. */
function alternative(text: string, casing: string | undefined): string {
  const base = ownGet(SYNONYMS, text) ?? ownGet(SYNONYMS, text.toLowerCase()) ?? `${text}_value`;
  const parts = base.split('_');
  if (casing === 'camelCase') return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (casing === 'PascalCase') return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (casing === 'UPPER_CASE') return base.toUpperCase();
  return base;
}

/**
 * identifier.reservedIn — why the target language cannot use `text` as this
 * kind of identifier, naming the language and offering an alternative that
 * fits the casing; null when it can, when the kind is not a member name, or
 * when the language has no table. Pure.
 */
export function reservedWordProblem(text: string, kind: IdentifierKind, targetLanguage?: string, casing?: string): string | null {
  if (kind !== 'method' && kind !== 'param' && kind !== 'field') return null;
  // No targetLanguage: judged as TypeScript — the convention whose camelCase
  // the tree is already judged by (methodCasingFor), so the two never disagree.
  const declared = targetLanguage?.trim() ? targetLanguage.trim().toLowerCase() : undefined;
  const table = ownGet(LANGUAGES, declared ?? 'typescript');
  if (!table) return null;
  const reserved = (table.kinds.has(kind) && table.reserved.has(text)) || (table.extra?.[kind]?.has(text) ?? false);
  if (!reserved) return null;
  const what = kind === 'param' ? 'parameter' : kind;
  const why = kind === 'method' && text === 'constructor'
    ? `in ${table.label} a class method named "constructor" is the class's constructor, so no ${what} can be named so`
    : `"${text}" is a word ${table.label} reserves, so no ${table.label} ${what} can be named so`;
  const language = declared !== undefined
    ? `targetLanguage ${declared}`
    : 'no targetLanguage is declared, so the tree is judged as TypeScript, the convention its camelCase method casing follows';
  return `"${text}": ${why} (${language}) — choose another, e.g. "${alternative(text, kind === 'method' ? casing : undefined)}"`;
}
