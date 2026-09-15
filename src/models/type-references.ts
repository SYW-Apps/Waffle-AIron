import type { InterfaceSpec, MethodSignature, TypeSpec } from './specs.js';

// ---------------------------------------------------------------------------
// The type-reference grammar over free-form type strings and signatures, and
// the type methods that read type references through it.
//
// Signatures are prose-ish ("save(key: string, data: Buffer): Promise<void>"),
// so extraction is heuristic. This module is the single home for that
// heuristic — the validator's rules, the canvas and the surface projector all
// read type references through it. Structured `params` on method signatures
// replace the prose parsing wherever they are authored.
// ---------------------------------------------------------------------------

/** Language-agnostic builtin/primitive vocabulary accepted everywhere. */
export const BUILTIN_TYPES = new Set([
  'string', 'str', 'number', 'boolean', 'bool', 'float', 'double', 'int', 'integer',
  'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
  'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
  'f32', 'f64', 'char', 'byte', 'bytes',
  'any', 'void', 'null', 'undefined', 'object',
  'date', 'datetime', 'time', 'timestamp', 'duration',
  'uuid', 'decimal', 'json', 'true', 'false',
  'list', 'vector', 'vec', 'array', 'map', 'set', 'dict', 'dictionary', 'hashmap', 'tuple',
  'result', 'option', 'box', 'arc', 'rc', 'ref', 'cell', 'refcell', 'mutex', 'rwlock', 'std',
  'promise', 'record', 'json', 'unknown', 'never', 'error', 'mcpserver',
]);

/**
 * The type identifiers a type string names, with comments, trailing prose and
 * string literals stripped. Duplicates are kept, in order of appearance.
 */
export function extractTypeIdentifiers(typeStr: string): string[] {
  // 1. Strip comments
  let cleaned = typeStr
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
                                .replace(/[a-zA-Z0-9_-]+\s*\??\s*:/g, '');

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
        const paramTypeCleaned = paramType.replace(/[a-zA-Z0-9_-]+\s*\??\s*:/g, '');
        types.push(...extractTypeIdentifiers(paramTypeCleaned));
      }
    }
  }

  return Array.from(new Set(types));
}

/** The method shape the type references are read from. */
export interface MethodLike {
  signature: string;
  returns: string;
  params?: { name: string; type: string }[];
}

/**
 * method_signature.typeRefs — the type identifiers a method names. Structured
 * `params` are authoritative when present (no prose parsing): the identifiers
 * of every param type and of the returns. Otherwise the free-form signature and
 * returns are tokenized.
 */
export function methodTypeRefs(m: MethodLike): string[] {
  if (m.params && m.params.length > 0) {
    const refs: string[] = [];
    for (const p of m.params) {
      refs.push(...extractTypeIdentifiers(p.type));
    }
    refs.push(...extractTypeIdentifiers(m.returns));
    return Array.from(new Set(refs));
  }
  return extractTypesFromSignature(m.signature, m.returns);
}

/**
 * method_signature.genericParameters — the generic parameters declared before
 * the parameter list of the method's prose signature (find<T>(id: string)
 * gives T).
 */
export function methodGenericParameters(method: Pick<MethodSignature, 'signature'>): Set<string> {
  return extractGenericTypeVariables(method.signature);
}

function normalizePart(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]/g, '');
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

/** type_spec.genericParameters — the generic parameters declared in the type's name (Page<T> gives T). */
export function typeGenericParameters(type: Pick<TypeSpec, 'name'>): Set<string> {
  return extractTypeGenerics(type.name);
}

/**
 * type_spec.fieldTypeRefs — the type identifiers one of this type's field types
 * names, with comments, trailing prose and string literals stripped and the
 * type's own generic parameters left out (compared ignoring case). It takes the
 * field's type rather than its name, because nothing makes field names unique
 * within a type.
 */
export function fieldTypeRefs(type: Pick<TypeSpec, 'name'>, fieldType: string): string[] {
  const generics = new Set(Array.from(typeGenericParameters(type)).map(g => g.toLowerCase()));
  return extractTypeIdentifiers(fieldType).filter(ref => !generics.has(ref.toLowerCase()));
}

/** interface_spec.genericParameters — the generic parameters declared in the interface's name. */
export function interfaceGenericParameters(intf: Pick<InterfaceSpec, 'name'>): Set<string> {
  return extractTypeGenerics(intf.name);
}
