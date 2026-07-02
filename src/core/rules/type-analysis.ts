// ---------------------------------------------------------------------------
// Type-reference analysis over free-form signature strings.
//
// Signatures are prose-ish ("save(key: string, data: Buffer): Promise<void>"),
// so extraction is heuristic. This module is the single home for that
// heuristic; structured `params` on method signatures will eventually replace
// most of it (see roadmap).
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
 * Builtins that clearly belong to ONE language family. When a subsystem
 * declares a targetLanguage, using another family's marker in a contract is
 * flagged (LANGUAGE_FOREIGN_BUILTIN) — e.g. `usize` in a TypeScript system.
 * Conservative on purpose: only unambiguous markers, no shared vocabulary.
 */
export const LANGUAGE_MARKERS: Record<string, ReadonlySet<string>> = {
  rust: new Set([
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
    'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'f32', 'f64', 'vec', 'box', 'arc', 'rc', 'refcell', 'cell', 'mutex', 'rwlock', 'str',
  ]),
  typescript: new Set(['any', 'unknown', 'never', 'undefined', 'promise', 'record']),
  javascript: new Set(['promise', 'undefined']),
  python: new Set(['dict', 'tuple']),
  csharp: new Set(['task']),
  go: new Set(['chan', 'rune']),
};

/** Normalize user-supplied language names onto LANGUAGE_MARKERS keys. */
export function normalizeLanguage(lang: string): string {
  const l = lang.toLowerCase().trim();
  if (l === 'ts' || l === 'typescript') return 'typescript';
  if (l === 'js' || l === 'javascript' || l === 'node' || l === 'nodejs') return 'javascript';
  if (l === 'rs' || l === 'rust') return 'rust';
  if (l === 'py' || l === 'python') return 'python';
  if (l === 'c#' || l === 'cs' || l === 'csharp' || l === 'dotnet') return 'csharp';
  if (l === 'golang' || l === 'go') return 'go';
  return l;
}

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

export function extractGenericTypeVariables(signature: string): Set<string> {
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

export function extractTypeGenerics(name: string): Set<string> {
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

export function extractTypesFromSignature(signature: string, returns: string): string[] {
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

function normalizePart(part: string): string {
  return part.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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
