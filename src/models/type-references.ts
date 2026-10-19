import type { InterfaceSpec, TypeSpec } from './specs.js';
import { writtenTypeRefs } from './type-grammar.js';

// ---------------------------------------------------------------------------
// The type methods that read type references, and the lenient tokenizer prose
// still needs.
//
// A STRUCTURED type position (a param's type, a returns, a field's type, a
// signature type's params and returns) is read through the neutral type
// grammar (src/models/type-grammar.ts): its references are the named types of
// the parsed expression (type_expression.namedRefs). Primitives and the
// collection forms name nothing; an applied generic `Page<T>` names its head
// and its arguments' references. A position that does not parse names nothing
// (TYPE_EXPRESSION_INVALID reports it); one using a form the grammar leaves out
// still names the types it uses, so a reference never vanishes because its
// spelling is unsupported.
//
// A PROSE signature (a method without params) is explicitly the unstructured
// form and stays prose: it is TOKENIZED leniently, every identifier a
// reference candidate and the operators separators, with comments, trailing
// prose and string literals stripped. Callers filter wairon's own vocabulary
// out with isTypeVocabulary (the retired builtin set now lives in the
// grammar's tables).
// ---------------------------------------------------------------------------

/**
 * The type identifiers a type string names, with comments, trailing prose and
 * string literals stripped. Duplicates are kept, in order of appearance.
 */
export function extractTypeIdentifiers(typeStr: string): string[] {
  // 1. Strip comments, and the grammar's `async` returns prefix (a keyword, never a type)
  let cleaned = typeStr
    .replace(/^\s*async\s+(?=\S)/, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/#.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 2. Strip trailing parenthesized descriptions: e.g. "Result<T> (or eof)" -> "Result<T>"
  // We only strip it if it is preceded by non-whitespace, to avoid stripping a top-level tuple like "(string, number)"
  cleaned = cleaned.replace(/(?<=\S)\s*\([^)]*\)\s*$/, '');

  // 3. Strip trailing prose after a dash, em-dash, or colon: e.g. "Result<T> - returns eof" -> "Result<T>"
  cleaned = cleaned.replace(/(?<=\S)\s+[-—:]\s+[a-z\s_-]+$/, '');

  // 4. Strip string literals (both single quotes, double quotes, and backticks)
  cleaned = cleaned.replace(/(["'`])(?:\\.|[^\\])*?\1/g, ' ');

  // 5. Extract identifiers (allowing dashes, underscores, and qualified namespace resolution)
  const matches = cleaned.match(/[a-zA-Z0-9_-]+(?:::[a-zA-Z0-9_-]+|\.[a-zA-Z0-9_-]+)*/g) || [];

  // 6. Filter out pure numbers, standalone punctuation/dashes, and ensure the token represents a valid type reference
  return matches.filter(t => {
    if (!/[a-zA-Z0-9]/.test(t)) return false;
    if (/^\d+$/.test(t)) return false;
    return true;
  });
}

/** The generic parameters declared before a prose signature's parameter list. */
function extractGenericTypeVariables(signature: string): Set<string> {
  const vars = new Set<string>();
  const openParen = signature.indexOf('(');
  const beforeParen = openParen !== -1 ? signature.slice(0, openParen) : signature;

  const openBracket = beforeParen.indexOf('<');
  const closeBracket = beforeParen.lastIndexOf('>');
  if (openBracket !== -1 && closeBracket !== -1 && closeBracket > openBracket) {
    const varsStr = beforeParen.slice(openBracket + 1, closeBracket);
    const parsedVars = varsStr.split(',').map(v => v.trim().split(/\s+extends\s+/i)[0].split('=')[0].trim());
    for (const v of parsedVars) {
      if (v) vars.add(v);
    }
  }
  return vars;
}

/** The generic parameters declared in a name (Page<T> gives T). */
function extractTypeGenerics(name: string): Set<string> {
  const vars = new Set<string>();
  const openBracket = name.indexOf('<');
  const closeBracket = name.lastIndexOf('>');
  if (openBracket !== -1 && closeBracket !== -1 && closeBracket > openBracket) {
    const varsStr = name.slice(openBracket + 1, closeBracket);
    const parsedVars = varsStr.split(',').map(v => v.trim().split(/\s+extends\s+/i)[0].split('=')[0].trim());
    for (const v of parsedVars) {
      if (v) vars.add(v);
    }
  }
  return vars;
}

function extractTypesFromSignature(signature: string, returns: string): string[] {
  const types: string[] = [];

  // Clean comments and trailing prose/parentheses first
  let sigCleaned = signature.replace(/\/\/.*$/gm, '').replace(/#.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  sigCleaned = sigCleaned.replace(/(?<=\S)\s*\([^)]*\)\s*$/, '');
  sigCleaned = sigCleaned.replace(/(?<=\S)\s+[-—:]\s+[a-z\s_-]+$/, '');

  const returnsCleaned = returns.replace(/\/\/.*$/gm, '').replace(/#.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
                                .replace(/(?<![:\w-])[a-zA-Z0-9_-]+\s*\??\s*:(?!:)/g, '');

  types.push(...extractTypeIdentifiers(returnsCleaned));

  const openParen = sigCleaned.indexOf('(');
  const closeParen = sigCleaned.lastIndexOf(')');
  if (openParen !== -1 && closeParen !== -1 && closeParen > openParen) {
    const paramsStr = sigCleaned.slice(openParen + 1, closeParen);

    let bracketDepth = 0;
    let braceDepth = 0;
    let parenDepth = 0;
    let paramStart = 0;
    const params: string[] = [];

    for (let i = 0; i < paramsStr.length; i++) {
      const char = paramsStr[i];
      if (char === '<') bracketDepth++;
      else if (char === '>') bracketDepth--;
      else if (char === '{') braceDepth++;
      else if (char === '}') braceDepth--;
      else if (char === '(') parenDepth++;
      else if (char === ')') parenDepth--;
      else if (char === ',' && bracketDepth === 0 && braceDepth === 0 && parenDepth === 0) {
        params.push(paramsStr.slice(paramStart, i).trim());
        paramStart = i + 1;
      }
    }
    if (paramStart < paramsStr.length) {
      params.push(paramsStr.slice(paramStart).trim());
    }

    for (const param of params) {
      const colonIndex = param.indexOf(':');
      if (colonIndex !== -1) {
        const paramType = param.slice(colonIndex + 1).trim();
        const paramTypeCleaned = paramType.replace(/(?<![:\w-])[a-zA-Z0-9_-]+\s*\??\s*:(?!:)/g, '');
        types.push(...extractTypeIdentifiers(paramTypeCleaned));
      }
    }
  }

  return Array.from(new Set(types));
}

/**
 * The method shape the type references are read from: a contract method or a
 * type method (whose params feed its references exactly as a contract
 * method's do). The text and returns may be absent while a method is still in
 * its stored form — a sourced method states neither, and a params-bearing one
 * need not store its text — and an absent one names nothing.
 */
export interface MethodLike {
  signature?: string;
  returns?: string;
  params?: { name: string; type: string }[];
}

/**
 * method_signature.typeRefs — the named types a method references. Structured
 * `params` are authoritative when present (no prose parsing): the named
 * references of every param type and of the returns, each parsed under the
 * grammar. Otherwise the prose signature and the returns are tokenized
 * leniently, as the unstructured form always was.
 */
export function methodTypeRefs(m: MethodLike): string[] {
  if (m.params && m.params.length > 0) {
    const refs: string[] = [];
    for (const p of m.params) {
      refs.push(...writtenTypeRefs(p.type, 'param'));
    }
    if (m.returns !== undefined) refs.push(...writtenTypeRefs(m.returns, 'returns'));
    return Array.from(new Set(refs));
  }
  return extractTypesFromSignature(m.signature ?? '', m.returns ?? '');
}

/**
 * type_spec.signatureTypeRefs — the named types a signature type references:
 * every param type, then its returns, each parsed under the grammar — the
 * references a signature carries in place of fields. None for any other kind,
 * whose references are its fields'.
 */
export function signatureTypeRefs(type: Pick<TypeSpec, 'kind' | 'params' | 'returns'>): string[] {
  if (type.kind !== 'signature') return [];
  const refs = [
    ...(type.params ?? []).flatMap((p) => writtenTypeRefs(p.type, 'signature-param')),
    ...(type.returns !== undefined ? writtenTypeRefs(type.returns, 'signature-returns') : []),
  ];
  return Array.from(new Set(refs));
}

/**
 * method_signature.genericParameters — the generic parameters declared before
 * the parameter list of the method's prose signature (find<T>(id: string)
 * gives T).
 */
export function methodGenericParameters(method: { signature?: string }): Set<string> {
  return extractGenericTypeVariables(method.signature ?? '');
}

function normalizePart(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * reference_resolution.nameKey — the one key a bare name is compared by,
 * locally and through imports alike: lower-cased, every character outside
 * [a-z0-9] removed, so `SharedError`, `shared-error` and `shared_error` are
 * one name. It is normalizePart, the per-segment normalization
 * type_spec.matchesRef already applies.
 */
export function nameKey(name: string): string {
  return normalizePart(name);
}

/**
 * Whether a written type reference names a type id: the reference's `::` or
 * `.` segments are a suffix of the id's, compared ignoring case and
 * punctuation.
 */
export function matchTypeRef(ref: string, typeId: string): boolean {
  const refParts = ref.split(/::|\./).map(normalizePart).filter(Boolean);
  const typeParts = typeId.split(/::|\./).map(normalizePart).filter(Boolean);

  if (refParts.length === 0 || typeParts.length === 0) return false;
  if (refParts.length > typeParts.length) return false;

  for (let i = 1; i <= refParts.length; i++) {
    if (refParts[refParts.length - i] !== typeParts[typeParts.length - i]) {
      return false;
    }
  }
  return true;
}

/**
 * type_spec.qualifiedId — the type's id qualified by its owning subsystem, when
 * the id is not already qualified.
 */
export function qualifiedTypeId(type: Pick<TypeSpec, 'id' | 'subsystem'>): string {
  return type.subsystem && !type.id.startsWith(`${type.subsystem}::`)
    ? `${type.subsystem}::${type.id}`
    : type.id;
}

/**
 * type_spec.matchesRef — whether a written type reference names this type: the
 * reference's `::` or `.` segments are a suffix of the qualified id, compared
 * ignoring case and punctuation.
 */
export function typeMatchesRef(type: Pick<TypeSpec, 'id' | 'subsystem'>, ref: string): boolean {
  return matchTypeRef(ref, qualifiedTypeId(type));
}

/** type_ref_outcome — how one written type reference resolved. */
export type TypeRefOutcome = 'resolved' | 'ambiguous' | 'none';

/** type_ref_resolution — how one written type reference resolved, the referrer's subsystem first. */
export interface TypeRefResolution {
  /** The id of the one type the reference resolves to. */
  type?: string;
  /** The ids (qualified form) of every type the reference matches. */
  candidates: string[];
  outcome: TypeRefOutcome;
  /** Another type named like the ref that sits at least as close to the referrer as the bound one. */
  shadowedBy?: string;
}

/** type_ref_site — one place a written type reference sits in the bound tree, and how it resolves from there. */
export interface TypeRefSite {
  /** The id of the spec that writes the reference. */
  spec: string;
  /** The spec's file, relative to the project root. */
  file: string;
  /** Where in the spec the token is written (`method <name> param <param>`, `field <name>`, `export entry <as>`, ...). */
  position: string;
  /** The type reference as written there. */
  token: string;
  /** The id, in qualified form, of the type the token resolves to; for an ambiguous site, its first candidate. */
  boundTo: string;
  /** Present for a shadowed site: the type that carries the token's name and sits at least as close. */
  shadowedBy?: string;
  /** Present for an ambiguous site: every type the token matches. */
  candidates?: string[];
}

/**
 * type_ref_resolution.resolve — resolve a written type reference, the
 * referrer's subsystem first. Candidates are the types matchesRef holds for;
 * when some belong to `from` only those count. A reference that resolved to
 * another subsystem's type while `from` holds a non-candidate type of the
 * same display name is still resolved, with shadowedBy set. Pure.
 */
export function resolveTypeRef(
  ref: string,
  from: string | undefined,
  types: readonly Pick<TypeSpec, 'id' | 'name' | 'subsystem'>[],
): TypeRefResolution {
  const candidates = types.filter((t) => typeMatchesRef(t, ref));
  const ids = candidates.map((t) => qualifiedTypeId(t));
  if (candidates.length === 0) return { candidates: ids, outcome: 'none' };
  const own = from !== undefined ? candidates.filter((t) => t.subsystem === from) : [];
  const pool = own.length > 0 ? own : candidates;
  if (pool.length > 1) return { candidates: ids, outcome: 'ambiguous' };
  const hit = pool[0];
  const result: TypeRefResolution = { type: hit.id, candidates: ids, outcome: 'resolved' };
  // Shadowing: another non-candidate type carrying the reference's name that sits at
  // least as close to the referrer (near: its subsystem; middle: none; far: another).
  // A reference that already says which type it means is never shadowed.
  if (!ref.includes('::') && ref !== hit.id) {
    const segments = ref.split(/::|\./).filter(Boolean);
    const key = nameKey(segments[segments.length - 1] ?? '');
    const closeness = (t: Pick<TypeSpec, 'subsystem'>): number =>
      from !== undefined && t.subsystem === from ? 0 : t.subsystem === undefined ? 1 : 2;
    const bound = closeness(hit);
    let shadow: (typeof types)[number] | undefined;
    if (key !== '') {
      for (const t of types) {
        if (candidates.includes(t) || nameKey(t.name.split('<')[0]) !== key || closeness(t) > bound) continue;
        if (shadow === undefined || closeness(t) < closeness(shadow)) shadow = t;
      }
    }
    if (shadow) result.shadowedBy = shadow.id;
  }


  return result;
}

/** type_spec.genericParameters — the generic parameters declared in the type's name (Page<T> gives T). */
export function typeGenericParameters(type: Pick<TypeSpec, 'name'>): Set<string> {
  return extractTypeGenerics(type.name);
}

/**
 * type_spec.fieldTypeRefs — the named types one of this type's field types
 * references (type_expression.namedRefs of the field's parsed type), with the
 * type's own generic parameters left out (compared ignoring case). A field
 * type that does not parse names nothing: its problem is
 * TYPE_EXPRESSION_INVALID's to report. It takes the field's type rather than
 * its name, because nothing makes field names unique within a type.
 */
export function fieldTypeRefs(type: Pick<TypeSpec, 'name'>, fieldType: string): string[] {
  const generics = new Set(Array.from(typeGenericParameters(type)).map(g => g.toLowerCase()));
  return writtenTypeRefs(fieldType, 'field').filter(ref => !generics.has(ref.toLowerCase()));
}

/** interface_spec.genericParameters — the generic parameters declared in the interface's name. */
export function interfaceGenericParameters(intf: Pick<InterfaceSpec, 'name'>): Set<string> {
  return extractTypeGenerics(intf.name);
}
