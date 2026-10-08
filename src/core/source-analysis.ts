import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import {
  implementationSourceFiles,
  typeSourceFiles,
  pathKey,
  type CallSiteFact,
  type CallTargetFact,
  type CodeModel,
  type CrossProjectImportFact,
  type ExportAliasFact,
  type FunctionBodyFact,
  type ImplementationSpec,
  type ImportBindingFact,
  type MethodImplementation,
  type ParameterFact,
  type ParameterKind,
  type ModuleImports,
  type ResolvedCallFact,
  type RouteFact,
  type ShapeMemberFact,
  type SourceFileFacts,
  type TypeShapeFact,
  type TypeSpec,
  languageOfSourcePath,
} from '../models/index.js';

// ---------------------------------------------------------------------------
// Source Analysis Adapter — the validator subsystem's only source-code I/O.
//
// Resolves every distinct source path the implementations name (each L4
// sourcePath, each method's own sourcePath, each simPath) inside the project
// root, reads the files, and produces the pure CodeModel the
// Level 1 conformance rules consume. Analysis is tiered so wairon carries ZERO mandatory parser
// dependencies:
//   exact    — full AST via the TypeScript compiler, resolved dynamically from
//              the analyzed project's node_modules first and wairon's own
//              installation second (never bundled),
//   pattern  — declarative per-language declaration/import pattern tables,
//   generic  — word-boundary identifier scan, the universal floor.
// The grade is recorded per file and carried onto finding messages, so a
// weaker analysis is visible rather than silently over-trusted. A single
// file's failure degrades that file, never the run.
// ---------------------------------------------------------------------------

export function emptyCodeModel(): CodeModel {
  return { files: [], projectRoot: '', rootFiles: [] };
}

// ---------------------------------------------------------------------------
// Language detection + declarative pattern tables
// ---------------------------------------------------------------------------

interface LanguagePatterns {
  lineComments: string[];
  blockComments: [string, string][];
  /** Regexes whose FIRST capture group is a declared name (run with /g). */
  declarations: RegExp[];
  /** Regexes whose first non-empty capture group is an import module specifier. */
  imports: RegExp[];
  /** Line prefix that marks a declaration as exported (coarse). */
  exportMarkers: RegExp[];
}

const C_FAMILY_COMMENTS = { lineComments: ['//'], blockComments: [['/*', '*/']] as [string, string][] };

/**
 * One `import { … }` clause, captured as its comma-separated binding body.
 *
 * Shared by the pattern-table declaration scan (where a named import binding
 * is a declaration this file makes) and by the test search (where it is the
 * high-confidence half of "does this test encode that method"). One pattern,
 * because two would drift and the second would be the one nobody checked.
 */
const NAMED_IMPORT_BINDINGS_RE = /\bimport\s*\{([^}]*)\}/g;

const JS_PATTERNS: LanguagePatterns = {
  ...C_FAMILY_COMMENTS,
  declarations: [
    /\b(?:function|class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var|type)\s+([A-Za-z_$][\w$]*)/g,
    // property/arrow style: `name: (…) =>`, `name = function`, `name(…) {` members
    /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\()/g,
    /(?:^|\s)(?:public|private|protected|static|async|get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g,
    // named import bindings realize forwarding adapters
    NAMED_IMPORT_BINDINGS_RE,
  ],
  imports: [
    /\b(?:import|export)\b[^'"\n]*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  exportMarkers: [/^\s*export\b/],
};

const LANGUAGE_PATTERNS: Record<string, LanguagePatterns> = {
  typescript: JS_PATTERNS,
  javascript: JS_PATTERNS,
  python: {
    lineComments: ['#'], blockComments: [['"""', '"""'], ["'''", "'''"]],
    declarations: [/\b(?:def|class)\s+([A-Za-z_]\w*)/g, /^([A-Za-z_]\w*)\s*=/gm],
    imports: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
    exportMarkers: [],
  },
  rust: {
    ...C_FAMILY_COMMENTS,
    declarations: [/\b(?:fn|struct|enum|trait|mod|const|static|type)\s+([A-Za-z_]\w*)/g],
    imports: [/\buse\s+([\w:]+)/g],
    exportMarkers: [/^\s*pub\b/],
  },
  go: {
    ...C_FAMILY_COMMENTS,
    declarations: [/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g, /\b(?:type|var|const)\s+([A-Za-z_]\w*)/g],
    imports: [/\bimport\s+(?:\w+\s+)?"([^"]+)"/g, /^\s*(?:\w+\s+)?"([^"]+)"\s*$/gm],
    exportMarkers: [],
  },
  csharp: {
    ...C_FAMILY_COMMENTS,
    declarations: [
      /\b(?:class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/g,
      // separators are same-line only ([ \t], never \n) — an unbounded lazy
      // class containing \s here is verified quadratic on large generated files
      /\b(?:public|private|protected|internal|static|async|override|virtual)(?:[ \t]+[\w<>,[\]?]+)*[ \t]+([A-Za-z_]\w*)[ \t]*\(/g,
    ],
    imports: [/\busing\s+([\w.]+)\s*;/g],
    exportMarkers: [/^\s*public\b/],
  },
  java: {
    ...C_FAMILY_COMMENTS,
    declarations: [
      /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g,
      /\b(?:public|private|protected|static|final|synchronized)(?:[ \t]+[\w<>,[\]?]+)*[ \t]+([A-Za-z_]\w*)[ \t]*\(/g,
    ],
    imports: [/\bimport\s+([\w.]+)\s*;/g],
    exportMarkers: [/^\s*public\b/],
  },
  c: {
    ...C_FAMILY_COMMENTS,
    declarations: [/\b([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/g, /\b(?:struct|enum|union|typedef)\s+([A-Za-z_]\w*)/g],
    imports: [/#include\s*[<"]([^>"]+)[>"]/g],
    exportMarkers: [],
  },
  ruby: {
    lineComments: ['#'], blockComments: [['=begin', '=end']],
    declarations: [/\b(?:def|class|module)\s+([A-Za-z_]\w*[?!]?)/g],
    imports: [/\brequire(?:_relative)?\s+['"]([^'"]+)['"]/g],
    exportMarkers: [],
  },
  php: {
    lineComments: ['//', '#'], blockComments: [['/*', '*/']],
    declarations: [/\b(?:function|class|interface|trait)\s+([A-Za-z_]\w*)/g],
    imports: [/\b(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]/g, /\buse\s+([\w\\]+)/g],
    exportMarkers: [],
  },
  kotlin: {
    ...C_FAMILY_COMMENTS,
    declarations: [/\b(?:fun|class|interface|object|val|var)\s+([A-Za-z_]\w*)/g],
    imports: [/\bimport\s+([\w.]+)/g],
    exportMarkers: [],
  },
  swift: {
    ...C_FAMILY_COMMENTS,
    declarations: [/\b(?:func|class|struct|enum|protocol|let|var)\s+([A-Za-z_]\w*)/g],
    imports: [/\bimport\s+([\w.]+)/g],
    exportMarkers: [/^\s*public\b/],
  },
};

// C-family patterns cover the same declaration shapes (`cpp` mirrors `c`).
LANGUAGE_PATTERNS.cpp = LANGUAGE_PATTERNS.c;

/** Pattern tables are for human-authored sources; above this size (generated/
 *  minified) the linear generic scan takes over — regex worst cases stay bounded. */
const PATTERN_ANALYSIS_MAX_BYTES = 1_000_000;

const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;
const STRING_RE = /'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

function stripComments(text: string, patterns: LanguagePatterns): string {
  let out = text;
  for (const [open, close] of patterns.blockComments) {
    const re = new RegExp(`${escapeRe(open)}[\\s\\S]*?${escapeRe(close)}`, 'g');
    out = out.replace(re, ' ');
  }
  if (patterns.lineComments.length > 0) {
    const re = new RegExp(`(?:${patterns.lineComments.map(escapeRe).join('|')})[^\n]*`, 'g');
    out = out.replace(re, '');
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The identifiers one captured clause binds.
 *
 * A named-import body carries several, comma-separated, and a RENAMED one
 * (`save as put`) carries two names for one binding: the name the module
 * publishes and the name this file writes. `localOnly` keeps just the second —
 * what a declaration-tier anchor is, and what the pattern tables have always
 * recorded — while the test search keeps both, because either spelling is the
 * symbol somebody searched for. Every other pattern captures a single name,
 * for which this is the identity.
 */
function boundNames(captured: string, localOnly: boolean): string[] {
  const names: string[] = [];
  for (const piece of captured.split(',')) {
    const sides = piece.split(' as ');
    for (const side of localOnly ? sides.slice(-1) : sides) {
      const name = side.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
    }
  }
  return names;
}

function collectStrings(text: string): Set<string> {
  const anchors = new Set<string>();
  for (const m of text.matchAll(STRING_RE)) {
    const value = m[1] ?? m[2] ?? m[3];
    if (value) anchors.add(value);
  }
  return anchors;
}

// ---------------------------------------------------------------------------
// Pattern + generic analyzers
// ---------------------------------------------------------------------------

function analyzeWithPatterns(text: string, patterns: LanguagePatterns): Omit<SourceFileFacts, 'path' | 'status' | 'language'> {
  const stripped = stripComments(text, patterns);
  const declared = new Set<string>();
  const exported = new Set<string>();
  const imports = new Set<string>();

  for (const re of patterns.declarations) {
    for (const m of stripped.matchAll(re)) {
      const captured = m[1];
      if (!captured) continue;
      // A named-import capture ("a, b as c") carries multiple bindings.
      for (const name of boundNames(captured, true)) declared.add(name);
    }
  }
  for (const re of patterns.imports) {
    for (const m of stripped.matchAll(re)) {
      const spec = m.slice(1).find(g => g);
      if (spec) imports.add(spec);
    }
  }
  if (patterns.exportMarkers.length > 0) {
    for (const line of stripped.split('\n')) {
      if (!patterns.exportMarkers.some(re => re.test(line))) continue;
      for (const re of patterns.declarations) {
        re.lastIndex = 0;
        const m = re.exec(line);
        // Hand the pattern back the way it was found. These tables are shared
        // module state, and `matchAll` CLONES the regex together with its
        // lastIndex — so an offset left here by a successful exec silently
        // skips the head of the next file scanned with the same pattern.
        re.lastIndex = 0;
        if (m?.[1]) exported.add(m[1]);
      }
    }
  }

  // Weak anchors: string literals plus bare identifier occurrences — the
  // pattern grade cannot prove a declaration, so mentions count at the
  // anchored tier (grade honesty covers the leniency).
  const anchors = collectStrings(text);
  for (const m of stripped.matchAll(IDENTIFIER_RE)) anchors.add(m[0]);

  return {
    analysisGrade: 'pattern',
    declaredNames: [...declared],
    anchoredNames: [...anchors],
    exportedNames: [...exported],
    imports: [...imports],
    reexports: [],
  };
}

function analyzeGeneric(text: string): Omit<SourceFileFacts, 'path' | 'status' | 'language'> {
  // The universal floor: any word-boundary identifier counts at BOTH tiers —
  // with no grammar at all, "the name still appears in the file" is the only
  // honest check, and the generic grade on the finding says exactly that.
  const words = new Set<string>();
  for (const m of text.matchAll(IDENTIFIER_RE)) words.add(m[0]);
  const anchors = new Set(words);
  for (const s of collectStrings(text)) anchors.add(s);
  return {
    analysisGrade: 'generic',
    declaredNames: [...words],
    anchoredNames: [...anchors],
    exportedNames: [],
    imports: [],
    reexports: [],
  };
}

// ---------------------------------------------------------------------------
// Exact analyzer — TypeScript compiler API, resolved dynamically (never bundled)
// ---------------------------------------------------------------------------

type TsModule = typeof import('typescript');

/**
 * A compiler module loaded from one `typescript` package, remembered under
 * what it depends on: the resolved package.json, its version and its
 * modification time. A long-lived MCP or hosted process sees an install, an
 * upgrade or a removal on its next run — the key changes, and the module a
 * previous install left in Node's require cache is evicted before the new one
 * loads, which is how a server once kept answering from a TypeScript 7 module
 * after the project had installed TypeScript 5.
 */
const tsLoads = new Map<string, { key: string; ts: TsModule | null }>();

/** The `typescript` package one base resolves, or null when it resolves none or loads one without a usable JavaScript compiler API. */
function compilerFrom(base: string, requireBelow7: boolean): TsModule | null {
  let req: NodeRequire;
  let manifest: string;
  try {
    req = createRequire(base);
    manifest = req.resolve('typescript/package.json');
  } catch {
    return null; // absence is a supported state, not an error
  }
  let key: string;
  let major = Number.NaN;
  try {
    const stat = fs.statSync(manifest);
    const version = String((JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: unknown }).version ?? '');
    major = Number.parseInt(version, 10);
    key = `${version}|${stat.mtimeMs}|${stat.size}`;
  } catch {
    return null;
  }
  const cached = tsLoads.get(manifest);
  if (cached && cached.key === key) return cached.ts;
  // A different install under the same path: drop every module the previous
  // one left cached, so the require below reads the files now on disk.
  const dir = path.dirname(manifest) + path.sep;
  for (const loaded of Object.keys(req.cache ?? {})) {
    if (loaded.startsWith(dir)) delete req.cache[loaded];
  }
  let ts: TsModule | null = null;
  // TypeScript 7's native compiler ships no JavaScript compiler API: passed
  // over like an absent package, so the next candidate answers instead.
  if (!(requireBelow7 && Number.isFinite(major) && major >= 7)) {
    try {
      const candidate = req('typescript') as TsModule;
      if (typeof candidate?.createSourceFile === 'function' && typeof candidate?.createProgram === 'function') ts = candidate;
    } catch {
      ts = null;
    }
  }
  tsLoads.set(manifest, { key, ts });
  return ts;
}

/**
 * The TypeScript compiler the analysis reads a project with: the project's
 * own when it ships the JavaScript compiler API (TypeScript 5 or 6), else the
 * copy wairon itself depends on — so neither TypeScript 7 nor a project with
 * no TypeScript at all degrades a run. Re-resolved on every call (a resolve
 * and a stat), so nothing about a previous run's answer outlives the package
 * it came from.
 */
function resolveTypeScript(projectRoot: string): TsModule | null {
  return compilerFrom(path.join(projectRoot, 'package.json'), true) ?? compilerFrom(__filename, false);
}

/** compiler_identity — which compiler an exact-grade analysis reads a project with, and whose copy it is. */
export interface CompilerIdentity {
  version: string;
  source: 'project' | 'wairon';
}

/**
 * isource_analysis_adapter.compilerIdentity — which compiler an exact-grade
 * analysis of this project reads it with, resolved exactly as
 * resolveTypeScript resolves it: the project's own (one with the JavaScript
 * compiler API), else wairon's own copy; null when neither loads. What
 * `validate` names in its code-reading line.
 */
export function compilerIdentity(projectRoot: string): CompilerIdentity | null {
  // Step 1: the project's own.
  const own = compilerFrom(path.join(projectRoot, 'package.json'), true);
  if (own) return { version: String(own.version), source: 'project' };
  // Step 2: wairon's copy.
  const shipped = compilerFrom(__filename, false);
  return shipped ? { version: String(shipped.version), source: 'wairon' } : null;
}

// ---------------------------------------------------------------------------
// Routes — read off a router's guards, or off the route table it names.
//
// Shared by the syntactic walk (which settles a value through the constants
// of the file alone) and the type checker's pass (which settles one through
// any module's constants, and through a type the checker narrows to one
// string literal). Both read the same two idioms, so the checker only ever
// widens what settles — never what counts as a route.
// ---------------------------------------------------------------------------

type TsNode = import('typescript').Node;
type TsExpression = import('typescript').Expression;

/** Where a name's value is written: the initializer of the const it names, or of the property it reads. */
type InitializerOf = (node: import('typescript').Identifier | import('typescript').PropertyAccessExpression) => TsExpression | undefined;
/** The one string literal a checker types an expression as, where one was loaded. */
type LiteralOf = (node: TsExpression) => string | undefined;

const HTTP_VERBS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const METHOD_KEYS = new Set(['method', 'verb', 'httpMethod']);
const PATH_KEYS = new Set(['path', 'pattern', 'route', 'url', 'template']);
/** How deep a constant is followed through other constants: far past any honest table, and a stop for a cycle. */
const SETTLE_DEPTH = 8;
/** A path segment as a route states it literally. */
const LITERAL_SEGMENT = /^[\w.~@!$&'+,;=%-]+$/;

/** An expression with the wrappers that change no value taken off. */
function bareExpression(ts: TsModule, expression: TsExpression): TsExpression {
  let at = expression;
  while (ts.isParenthesizedExpression(at) || ts.isAsExpression(at) || ts.isSatisfiesExpression(at)
    || ts.isNonNullExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
  return at;
}

/**
 * The string an expression settles on, where the code spells it out: a
 * literal, a template literal or a concatenation of such, a const (or a
 * const object's property) holding one — followed through `initializerOf`
 * to a bounded depth — or, where a checker was loaded, an expression it types
 * as ONE string literal. Anything else settles on nothing: a guess about a
 * route would be read as a measurement.
 */
function settleString(
  ts: TsModule,
  expression: TsExpression,
  initializerOf: InitializerOf,
  literalOf?: LiteralOf,
  depth = 0,
): string | undefined {
  if (depth > SETTLE_DEPTH) return undefined;
  const at = bareExpression(ts, expression);
  if (ts.isStringLiteral(at) || ts.isNoSubstitutionTemplateLiteral(at) || ts.isNumericLiteral(at)) return at.text;
  if (ts.isTemplateExpression(at)) {
    let text = at.head.text;
    for (const span of at.templateSpans) {
      const part = settleString(ts, span.expression, initializerOf, literalOf, depth + 1);
      if (part === undefined) return undefined;
      text += part + span.literal.text;
    }
    return text;
  }
  if (ts.isBinaryExpression(at) && at.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = settleString(ts, at.left, initializerOf, literalOf, depth + 1);
    const right = left === undefined ? undefined : settleString(ts, at.right, initializerOf, literalOf, depth + 1);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (ts.isIdentifier(at) || ts.isPropertyAccessExpression(at)) {
    const initializer = initializerOf(at);
    if (initializer) {
      const settled = settleString(ts, initializer, initializerOf, literalOf, depth + 1);
      if (settled !== undefined) return settled;
    }
  }
  return literalOf?.(at);
}

/** The const declarations at a file's top level, by name — what a syntactic reading settles a name through. */
function topLevelConstants(ts: TsModule, sf: import('typescript').SourceFile): Map<string, TsExpression> {
  const out = new Map<string, TsExpression>();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && !out.has(declaration.name.text)) {
        out.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return out;
}

function propertyKeyText(ts: TsModule, name: import('typescript').PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return undefined;
}

/** The value a property of an object literal is written with, by key. */
function propertyInitializer(ts: TsModule, literal: TsExpression, key: string): TsExpression | undefined {
  const object = bareExpression(ts, literal);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyKeyText(ts, property.name) === key) return property.initializer;
  }
  return undefined;
}

/** The initializer a name or a `Const.property` read names, through the file's own top-level consts alone. */
function fileInitializer(ts: TsModule, constants: ReadonlyMap<string, TsExpression>): InitializerOf {
  return (node) => {
    if (ts.isIdentifier(node)) return constants.get(node.text);
    const holder = bareExpression(ts, node.expression);
    if (!ts.isIdentifier(holder)) return undefined;
    const literal = constants.get(holder.text);
    return literal ? propertyInitializer(ts, literal, node.name.text) : undefined;
  };
}

/**
 * The name under which a function-like gets its own entry: a declaration's own
 * name, or the named slot (variable / property) a function or arrow
 * initializer is bound to. An anonymous callback answers nothing — it belongs
 * to the enclosing named function.
 */
function namedFunctionNameOf(ts: TsModule, node: TsNode): string | undefined {
  if (ts.isFunctionDeclaration(node)) return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return propertyKeyText(ts, node.name);
  }
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
    const parent = node.parent;
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isIdentifier(parent.name)) return parent.name.text;
    if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) && parent.initializer === node) {
      return propertyKeyText(ts, parent.name);
    }
  }
  return undefined;
}

/** How a route is keyed: one entry per verb and path, a route open at its end marked so. */
function routeKey(route: RouteFact): string {
  return `${route.verb} /${route.segments.join('/')}${route.exactLength ? '' : '/…'}`;
}

/** A `/a/:b`, `/a/{b}` or `/a/*` path template as segments, `*` for each parameter; undefined for any other pattern syntax. */
function templateSegments(template: string): string[] | undefined {
  if (!template.startsWith('/')) return undefined;
  const segments: string[] = [];
  for (const segment of template.split('/').filter(Boolean)) {
    if (/^:[A-Za-z_$][\w$]*$/.test(segment) || /^\{[^{}/]+\}$/.test(segment) || segment === '*') segments.push('*');
    else if (LITERAL_SEGMENT.test(segment)) segments.push(segment);
    else return undefined;
  }
  return segments;
}

/**
 * A regular-expression literal as a route path: anchored with `^`, each
 * escaped-slash-separated piece a literal or one capture group (the
 * wildcard), a `$` pinning the segment count. Any other construct —
 * alternation, an optional piece, a dot — is a pattern this reading does not
 * state, and answers nothing.
 */
function regexRoute(literal: string): { segments: string[]; exactLength: boolean } | undefined {
  const close = literal.lastIndexOf('/');
  if (!literal.startsWith('/') || close <= 0) return undefined;
  let source = literal.slice(1, close);
  if (!source.startsWith('^')) return undefined;
  source = source.slice(1);
  let exactLength = false;
  if (source.endsWith('$') && !source.endsWith('\\$')) {
    exactLength = true;
    source = source.slice(0, -1);
  }
  if (source.endsWith('\\/?')) source = source.slice(0, -3);
  const pieces: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '\\' && i + 1 < source.length) {
      if (depth === 0 && source[i + 1] === '/') { pieces.push(current); current = ''; i++; continue; }
      current += c + source[i + 1];
      i++;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    current += c;
  }
  pieces.push(current);
  if (pieces[0] !== '') return undefined;
  const segments: string[] = [];
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === '' && i === pieces.length - 1) break;
    if (/^\((?:\?<[A-Za-z_]\w*>)?(?:\[[^\]]*\]|\\[dw]|[^()|?])[+*]\)$/.test(piece)) segments.push('*');
    else if (/^(?:[A-Za-z0-9_~%-]|\\[.\-_~])+$/.test(piece)) segments.push(piece.replace(/\\/g, ''));
    else return undefined;
  }
  return { segments, exactLength };
}

/** The path pattern a table entry's value is: a regular-expression literal, or a string path, followed through constants. */
function patternOf(
  ts: TsModule,
  value: TsExpression,
  initializerOf: InitializerOf,
  literalOf: LiteralOf | undefined,
  depth = 0,
): { segments: string[]; exactLength: boolean } | undefined {
  if (depth > SETTLE_DEPTH) return undefined;
  const at = bareExpression(ts, value);
  if (ts.isRegularExpressionLiteral(at)) return regexRoute(at.text);
  if (ts.isIdentifier(at) || ts.isPropertyAccessExpression(at)) {
    const initializer = initializerOf(at);
    if (initializer && ts.isRegularExpressionLiteral(bareExpression(ts, initializer))) {
      return patternOf(ts, initializer, initializerOf, literalOf, depth + 1);
    }
  }
  const text = settleString(ts, at, initializerOf, literalOf);
  if (text === undefined) return undefined;
  const segments = templateSegments(text);
  return segments ? { segments, exactLength: true } : undefined;
}

/** One route-table entry: the object literal's method and path, each by its key where one names it, else the one value that reads as such. */
function tableEntry(
  ts: TsModule,
  entry: import('typescript').ObjectLiteralExpression,
  initializerOf: InitializerOf,
  literalOf: LiteralOf | undefined,
): RouteFact | undefined {
  let keyedVerb: string | undefined;
  let keyedPath: { segments: string[]; exactLength: boolean } | undefined;
  const verbs: string[] = [];
  const paths: Array<{ segments: string[]; exactLength: boolean }> = [];
  for (const property of entry.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = propertyKeyText(ts, property.name);
    const value = property.initializer;
    const text = settleString(ts, value, initializerOf, literalOf);
    const verb = text !== undefined && HTTP_VERBS.has(text.toUpperCase()) ? text.toUpperCase() : undefined;
    if (verb) {
      if (key && METHOD_KEYS.has(key)) keyedVerb = verb;
      verbs.push(verb);
      continue;
    }
    const pattern = patternOf(ts, value, initializerOf, literalOf);
    if (pattern) {
      if (key && PATH_KEYS.has(key)) keyedPath = pattern;
      paths.push(pattern);
    }
  }
  const verb = keyedVerb ?? (verbs.length === 1 ? verbs[0] : undefined);
  const route = keyedPath ?? (paths.length === 1 ? paths[0] : undefined);
  return verb && route ? { verb, segments: route.segments, exactLength: route.exactLength, fullPath: true } : undefined;
}

/**
 * The routes a ROUTE TABLE states: an array of object literals each pairing a
 * method with a path pattern, or an object keyed `VERB /path`. Every entry
 * must settle, or the table answers nothing at all — a table read in part
 * would accuse the endpoints of the entries it skipped.
 */
function tableRoutes(ts: TsModule, value: TsExpression, initializerOf: InitializerOf, literalOf: LiteralOf | undefined): RouteFact[] {
  const at = bareExpression(ts, value);
  const out: RouteFact[] = [];
  if (ts.isArrayLiteralExpression(at)) {
    for (const element of at.elements) {
      const entry = bareExpression(ts, element);
      if (!ts.isObjectLiteralExpression(entry)) return [];
      const route = tableEntry(ts, entry, initializerOf, literalOf);
      if (!route) return [];
      out.push(route);
    }
    return out;
  }
  if (ts.isObjectLiteralExpression(at)) {
    for (const property of at.properties) {
      const key = property.name ? propertyKeyText(ts, property.name) : undefined;
      const match = key ? /^([A-Za-z]+)\s+(\/\S*)$/.exec(key) : null;
      if (!match || !HTTP_VERBS.has(match[1].toUpperCase())) return [];
      const segments = templateSegments(match[2]);
      if (!segments) return [];
      out.push({ verb: match[1].toUpperCase(), segments, exactLength: true, fullPath: true });
    }
  }
  return out;
}

/**
 * The prefix a router strips off the path before splitting it into `parts`
 * — `pathname.slice(BASE.length)`, `.substring(…)`, `.replace(BASE, '')` —
 * as segments, where every such strip settles on one prefix. Undefined when
 * there is none, or it does not settle: the leading segment then stays the
 * one the mount supplies.
 */
function strippedPrefix(
  ts: TsModule,
  body: TsNode,
  initializerOf: InitializerOf,
  literalOf: LiteralOf | undefined,
): string[] | undefined {
  const sources: TsExpression[] = [];
  const find = (node: TsNode): void => {
    if (namedFunctionNameOf(ts, node) !== undefined) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'parts' && node.initializer) sources.push(node.initializer);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left) && node.left.text === 'parts') sources.push(node.right);
    ts.forEachChild(node, find);
  };
  find(body);
  const UNSETTLED = '\u0000';
  const prefixes = new Set<string>();
  for (const source of sources) {
    const strip = (node: TsNode): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const beforeSplit = !/\bsplit\s*\(/.test(node.expression.expression.getText());
        const [first, second] = node.arguments;
        if (beforeSplit && (name === 'slice' || name === 'substring' || name === 'substr') && node.arguments.length === 1
          && first && ts.isPropertyAccessExpression(first) && first.name.text === 'length') {
          prefixes.add(settleString(ts, first.expression, initializerOf, literalOf) ?? UNSETTLED);
        } else if (beforeSplit && name === 'replace' && first && second && settleString(ts, second, initializerOf, literalOf) === '') {
          prefixes.add(settleString(ts, first, initializerOf, literalOf) ?? UNSETTLED);
        }
      }
      ts.forEachChild(node, strip);
    };
    strip(source);
  }
  if (prefixes.size !== 1) return undefined;
  const [prefix] = [...prefixes];
  if (!prefix.startsWith('/')) return undefined;
  const segments = prefix.split('/').filter(Boolean);
  return segments.every(segment => LITERAL_SEGMENT.test(segment)) ? segments : undefined;
}

/**
 * Every route one named function-like serves, read two ways. Its GUARDS: a
 * branch serves a route when the conjunction of its own `&&`-conjuncts and
 * those of every enclosing `if` on the path taken includes a comparison of
 * `<x>.method` with a string. Routers NEST — an outer guard on the first
 * segment, inner ones on the rest — so a then-branch inherits its guard's
 * conjuncts and an else-branch does not: the else of `a && b` is `!(a &&
 * b)`, which fixes no segment at all. Within that conjunction `parts.length
 * === N` pins the segment count and `parts[i] === <value>` fixes segment i,
 * each value settled through the constants; any other conjunct is one the
 * route model cannot state, so it neither narrows nor widens the route. A
 * prefix the function strips before splitting is folded in front. And the
 * ROUTE TABLES it names (tableRoutes). Nested NAMED functions are skipped
 * (they carry their own entries); anonymous callbacks count into the
 * enclosing one.
 */
function readRoutes(
  ts: TsModule,
  fn: TsNode & { body?: TsNode },
  initializerOf: InitializerOf,
  literalOf?: LiteralOf,
): Map<string, RouteFact> {
  const routes = new Map<string, RouteFact>();
  if (!fn.body) return routes;
  const settle = (expression: TsExpression): string | undefined => settleString(ts, expression, initializerOf, literalOf);
  const conjunctsOf = (expression: TsExpression, out: TsExpression[] = []): TsExpression[] => {
    if (ts.isParenthesizedExpression(expression)) return conjunctsOf(expression.expression, out);
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      conjunctsOf(expression.left, out);
      conjunctsOf(expression.right, out);
      return out;
    }
    out.push(expression);
    return out;
  };
  const isPartsRef = (expression: TsExpression): boolean =>
    (ts.isIdentifier(expression) && expression.text === 'parts')
    || (ts.isPropertyAccessExpression(expression) && expression.name.text === 'parts');
  type RouteConstraint = { verb: string } | { length: number } | { index: number; literal: string };
  const constraintOf = (conjunct: TsExpression): RouteConstraint | undefined => {
    if (!ts.isBinaryExpression(conjunct) || conjunct.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined;
    const sides: Array<[TsExpression, TsExpression]> = [[conjunct.left, conjunct.right], [conjunct.right, conjunct.left]];
    for (const [left, right] of sides) {
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'method') {
        const verb = settle(right);
        if (verb !== undefined) return { verb };
      }
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'length' && isPartsRef(left.expression) && ts.isNumericLiteral(right)) {
        return { length: Number(right.text) };
      }
      if (ts.isElementAccessExpression(left) && isPartsRef(left.expression) && ts.isNumericLiteral(left.argumentExpression)) {
        const literal = settle(right);
        if (literal !== undefined) return { index: Number(left.argumentExpression.text), literal };
      }
    }
    return undefined;
  };
  const prefix = strippedPrefix(ts, fn.body, initializerOf, literalOf);
  const routeOf = (conjuncts: TsExpression[]): RouteFact | undefined => {
    let verb: string | undefined;
    let length: number | undefined;
    const fixed = new Map<number, string>();
    for (const conjunct of conjuncts) {
      const constraint = constraintOf(conjunct);
      if (!constraint) continue;
      if ('verb' in constraint) verb = constraint.verb;
      else if ('length' in constraint) length = constraint.length;
      else fixed.set(constraint.index, constraint.literal);
    }
    if (verb === undefined) return undefined;
    // Without a pinned count the route is as long as the furthest segment it
    // fixes — and may continue past it, which `exactLength: false` says.
    const count = length ?? (fixed.size > 0 ? Math.max(...fixed.keys()) + 1 : 0);
    const segments: string[] = [];
    for (let index = 0; index < count; index++) segments.push(fixed.get(index) ?? '*');
    return prefix
      ? { verb, segments: [...prefix, ...segments], exactLength: length !== undefined, fullPath: true }
      : { verb, segments, exactLength: length !== undefined };
  };
  const walk = (node: TsNode, enclosing: TsExpression[]): void => {
    if (namedFunctionNameOf(ts, node) !== undefined) return;
    if (ts.isIfStatement(node)) {
      const guarded = [...enclosing, ...conjunctsOf(node.expression)];
      const route = routeOf(guarded);
      if (route) routes.set(routeKey(route), route);
      walk(node.thenStatement, guarded);
      if (node.elseStatement) walk(node.elseStatement, enclosing);
      return;
    }
    ts.forEachChild(node, child => walk(child, enclosing));
  };
  walk(fn.body, []);
  // The route tables the body names: each constant a name in it reads, once.
  const read = new Set<TsNode>();
  const names = (node: TsNode): void => {
    if (namedFunctionNameOf(ts, node) !== undefined) return;
    if (ts.isIdentifier(node) && !(node.parent && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const initializer = initializerOf(node);
      if (initializer && !read.has(initializer)) {
        read.add(initializer);
        for (const route of tableRoutes(ts, initializer, initializerOf, literalOf)) routes.set(routeKey(route), route);
      }
    }
    ts.forEachChild(node, names);
  };
  names(fn.body);
  return routes;
}

/** One parameter list as the walk read it, at the position of the function declaring it. */
interface ParameterSite {
  pos: number;
  params: ParameterFact[];
}

interface ExactFacts {
  declared: Set<string>;
  anchors: Set<string>;
  exported: Set<string>;
  imports: Set<string>;
  /** All export-from specifiers (named and star). */
  reexports: Set<string>;
  /** Relative export-* specifiers to chase for barrel re-exports. */
  starExports: string[];
  /**
   * Named re-exports (export { a as b } from './x.js'), each carrying the
   * name it is published UNDER and the name it is published FROM. A barrel
   * republishes these exactly as it republishes a star export, so the chase
   * carries their bodies too: the two forms differ in spelling, never in what
   * the barrel publishes.
   */
  namedReexports: { exported: string; local: string; from: string }[];
  /**
   * The forwarding bindings the file publishes with no specifier of its own
   * (see SourceFileFacts.exportAliases): runtime export specifiers, and the
   * identifier-valued properties of exported top-level object literals. The
   * barrel chase carries each one's body onto the published name where the
   * local name settles on exactly one.
   */
  exportAliases: ExportAliasFact[];
  /**
   * The type each named function-like returns, where the code settles it
   * (see SourceFileFacts.returnTypes); `null` marks a name whose same-named
   * bodies disagree, which records nothing.
   */
  returnTypes: Map<string, string | null>;
  /** Cyclomatic complexity per named function-like (max across same-named). */
  complexity: Map<string, number>;
  /**
   * Direct call SITES per named function-like, keyed by their shape signature
   * (union across same-named), so `save(x)` and `ledger.save(x)` stay two
   * facts. A function-like with a body always gets a map, empty when it calls
   * nothing — see SourceFileFacts.functionCallSites.
   */
  calls: Map<string, Map<string, CallSiteFact>>;
  /**
   * The same sites body by body, each with where the body is bound — see
   * SourceFileFacts.functionBodies: what keeps a facade `save` and the
   * class member `save` it forwards to from being read as one function.
   */
  bodies: Map<string, FunctionBodyFact[]>;
  /** Runtime (value) import bindings by local name. */
  importBindings: Map<string, ImportBindingFact>;
  /** Module specifier of each TYPE-ONLY import binding, by local name. */
  typeOnlyBindings: Map<string, string>;
  /**
   * The type names each instance FIELD is declared with — a class property's
   * annotation, or a constructor parameter property's. Same-named fields of
   * different classes union, because the file cannot say which class a
   * `this` was.
   */
  fieldTypes: Map<string, Set<string>>;
  /**
   * The type names each locally BOUND name is declared with — a parameter's
   * annotation, and an annotated variable declaration's. Same-named bindings
   * union, because the file cannot say which function a call site sits in,
   * and a receiver is as often a parameter of an ENCLOSING function as of the
   * one that calls it.
   */
  localTypes: Map<string, Set<string>>;
  /** The type names each property of a named shape is declared with, keyed `<shape>.<property>` — read as fieldTypes reads a field. */
  memberTypes: Map<string, Set<string>>;
  /** The one type each type alias names outright, by alias name. */
  aliasTargets: Map<string, string>;
  /** The interface names each named class's `implements` clause writes, by class name. */
  implementsClauses: Map<string, string[]>;
  /**
   * The members of each named shape the file declares, by declaration name
   * — an interface's, a class's, a type literal alias's, and a derived
   * alias's after the one hop to the schema value it names.
   */
  typeShapes: Map<string, TypeShapeFact>;
  /**
   * The parameters each named function-like DECLARES, by name — the signature
   * a caller of that name reaches. Only a function-like with a BODY records
   * one, which is what settles overloads: the overload signatures are not what
   * a caller lands on, and a name with no body here has no signature to read
   * at all. Same-named bodies keep EVERY candidate, the way the field-type
   * facts do: a file routinely holds a class member and the module-level
   * facade forwarding to it under one name, with different parameters, and
   * picking one would silently drop the other's leading argument from view.
   * Which one a contract means is not this model's to decide.
   */
  functionParams: Map<string, ParameterFact[][]>;
  /**
   * Each parameter list read, with the position of its function in the file:
   * what the kinds the type checker settles are joined on, since its program
   * parses the same text into nodes at the same positions.
   */
  paramSites: ParameterSite[];
  /**
   * The routes each named function-like handles, by name, deduplicated by
   * route. A name gets an entry only when at least one branch of one of its
   * bodies reads as a route — see SourceFileFacts.functionRoutes for why an
   * empty entry is never written.
   */
  functionRoutes: Map<string, Map<string, RouteFact>>;
  /**
   * One entry per BODY that completes later — declared `async`, or annotated
   * to return a Promise — under its function's name, in the order the bodies
   * are met: the same per-body count `functionParams` keeps, so a reader can
   * tell every body of a name from some of them.
   */
  asyncFunctions: string[];
  /**
   * The values of each enum-like declaration, by declaration name, in
   * declared order: a string-literal union alias, a `z.enum([...])` constant
   * (and an alias inferring from it, one hop), a string enum.
   */
  enumValues: Map<string, string[]>;
  /**
   * The right side of each type alias whose right side is not an object
   * shape, as written, by alias name: what a named scalar's holds is compared
   * with through the file's dialect.
   */
  aliasTypes: Map<string, string>;
  /** Module-scope mutable (`let`/`var`) binding names. */
  mutableBindings: Set<string>;
  /**
   * The file declares nothing of its own: every top-level statement is an
   * export-from, so it only republishes other modules. Read off the statement
   * list rather than off `declared`, which by then holds the imported and
   * re-exported names too — and which the barrel chase is about to fill with
   * everything the barrel publishes.
   */
  reexportOnly: boolean;
}

function walkExact(ts: TsModule, sourceText: string, fileName: string): ExactFacts {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const declared = new Set<string>();
  const anchors = new Set<string>();
  const exported = new Set<string>();
  const imports = new Set<string>();
  const reexports = new Set<string>();
  const starExports: string[] = [];
  const namedReexports: { exported: string; local: string; from: string }[] = [];
  const exportAliases: ExportAliasFact[] = [];
  /** Property aliases of top-level object literals, kept until the walk knows which objects are exported. */
  const propertyAliases: ExportAliasFact[] = [];
  const returnTypes = new Map<string, string | null>();
  const complexity = new Map<string, number>();
  const calls = new Map<string, Map<string, CallSiteFact>>();
  const bodies = new Map<string, FunctionBodyFact[]>();
  const importBindings = new Map<string, ImportBindingFact>();
  /**
   * The names a destructured lazy load binds — `const { f } = require('m')`,
   * `const { f: g } = await import('m')` — each with where it came from, or
   * null once two of them disagree. Joined into importBindings after the walk,
   * and only where the name is unambiguous.
   */
  const lazyBindings = new Map<string, ImportBindingFact | null>();
  const typeOnlyBindings = new Map<string, string>();
  const fieldTypes = new Map<string, Set<string>>();
  const localTypes = new Map<string, Set<string>>();
  const memberTypes = new Map<string, Set<string>>();
  const aliasTargets = new Map<string, string>();
  const implementsClauses = new Map<string, string[]>();
  const typeShapes = new Map<string, TypeShapeFact>();
  const functionParams = new Map<string, ParameterFact[][]>();
  const functionRoutes = new Map<string, Map<string, RouteFact>>();
  /** The named function-likes with a body, read for routes once the walk is over. */
  const routeBodies: { name: string; node: import('typescript').Node }[] = [];
  const paramSites: ParameterSite[] = [];
  const asyncFunctions: string[] = [];
  const enumValues = new Map<string, string[]>();
  const aliasTypes = new Map<string, string>();
  const mutableBindings = new Set<string>();
  /**
   * The two halves of the DERIVED hop, collected as the walk meets them and
   * joined after it: an alias routinely names a schema const the file
   * declares further down, so neither half can answer in one pass.
   */
  const schemaConstants = new Map<string, import('typescript').Expression>();
  const derivedAliases: { name: string; constant: string }[] = [];

  /**
   * The dedup key of a call site: its shape, not its number of occurrences.
   * The receiver is part of the shape, so `this.store.save()`,
   * `new Store().save()` and `getStore().save()` stay the three different
   * questions they are.
   */
  const receiverKey = (site: CallSiteFact): string =>
    site.via ?? (site.field ? `this.${site.field}`
      : site.constructed ? `new ${site.constructed}`
        : site.returnedBy ? `${site.returnedBy}()`
          : site.enclosingClass ? `this:${site.enclosingClass}`
            : site.receiverPath ? site.receiverPath.join('.') : '');
  const siteKey = (site: CallSiteFact): string =>
    `${site.member ? 'm' : 'b'}:${receiverKey(site)}:${site.name}`;

  const addBindingNames = (name: import('typescript').BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingNames(el.name);
      }
    }
  };

  /**
   * A destructured lazy load: `const { a, b: c } = require('m')` or
   * `= await import('m')`, through any `as`/`satisfies`/parentheses/`!`.
   * Each plain element binds its local name to the module's export, as a
   * static named import would; a rest element, a nested pattern or a computed
   * key binds nothing it could name.
   */
  const recordLazyBindings = (decl: import('typescript').VariableDeclaration): void => {
    if (!ts.isObjectBindingPattern(decl.name) || !decl.initializer) return;
    let init: import('typescript').Expression = decl.initializer;
    for (;;) {
      if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)
        || ts.isNonNullExpression(init) || ts.isAwaitExpression(init) || ts.isTypeAssertionExpression(init)) {
        init = init.expression;
      } else break;
    }
    if (!ts.isCallExpression(init) || init.arguments.length === 0 || !ts.isStringLiteral(init.arguments[0])) return;
    const callee = init.expression;
    const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
    if (!isRequire && callee.kind !== ts.SyntaxKind.ImportKeyword) return;
    const from = (init.arguments[0] as import('typescript').StringLiteral).text;
    for (const el of decl.name.elements) {
      if (el.dotDotDotToken || !ts.isIdentifier(el.name)) continue;
      let imported: string | undefined;
      if (el.propertyName) {
        if (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)) imported = el.propertyName.text;
        else continue;
      }
      const local = el.name.text;
      const fact: ImportBindingFact = { from };
      if (imported && imported !== local) fact.imported = imported;
      if (!lazyBindings.has(local)) lazyBindings.set(local, fact);
      else {
        const seen = lazyBindings.get(local);
        if (!seen || seen.from !== fact.from || seen.imported !== fact.imported) lazyBindings.set(local, null);
      }
    }
  };

  const propertyNameText = (name: import('typescript').PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isPrivateIdentifier(name)) return name.text;
    return undefined;
  };

  // A declared type, read only where the declaration NAMES one: a plain type
  // reference (`store: SpecStore`), or a member-preserving utility around one
  // (`Pick<HabitRepository, 'find'>`, `Readonly<Store>`), which names the type
  // it wraps — its members ARE that type's members by the language's own
  // definition, so reading the wrapped name infers nothing. Any other
  // generic, a literal, a union or an intersection resolves to nothing rather
  // than to one arbitrary member of itself — what a field could then be is a
  // question this model does not ask.
  const MEMBER_PRESERVING = new Set(['Pick', 'Omit', 'Partial', 'Required', 'Readonly']);
  const typeReferenceName = (type: import('typescript').TypeNode | undefined): string | undefined => {
    let at = type;
    for (let depth = 0; at && depth < 4; depth++) {
      // `T | null`, `T | undefined` and `(T)` declare a T that may be absent:
      // the collaborator is still a T wherever a call reaches it.
      while (at && ts.isParenthesizedTypeNode(at)) at = at.type;
      if (at && ts.isUnionTypeNode(at)) {
        const present = at.types.filter((t) => !(
          t.kind === ts.SyntaxKind.UndefinedKeyword || t.kind === ts.SyntaxKind.NullKeyword
          || (ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)));
        if (present.length !== 1) return undefined;
        at = present[0];
      }
      if (!at || !ts.isTypeReferenceNode(at) || !ts.isIdentifier(at.typeName)) return undefined;
      const name = at.typeName.text;
      if (!MEMBER_PRESERVING.has(name) || !at.typeArguments?.length) return name;
      at = at.typeArguments[0];
    }
    return undefined;
  };

  // What a named shape's PROPERTY is declared as: the link a receiver chain
  // (`this.deps.tracker.save()`) is followed through. Read exactly as a field
  // is, keyed by the shape that declares it.
  const recordMemberType = (
    shape: string | undefined,
    name: import('typescript').PropertyName | import('typescript').BindingName,
    type: import('typescript').TypeNode | undefined,
  ): void => {
    if (!shape) return;
    const typeName = typeReferenceName(type);
    if (!typeName) return;
    const property = propertyNameText(name as import('typescript').PropertyName);
    if (!property) return;
    const key = `${shape}.${property}`;
    const named = memberTypes.get(key) ?? new Set<string>();
    named.add(typeName);
    memberTypes.set(key, named);
  };
  /** The named shape a property node is declared in: its class, its interface, or the alias of the type literal holding it. */
  const shapeNameOf = (holder: import('typescript').Node | undefined): string | undefined => {
    if (!holder) return undefined;
    if ((ts.isClassDeclaration(holder) || ts.isInterfaceDeclaration(holder)) && holder.name) return holder.name.text;
    if (ts.isTypeLiteralNode(holder) && holder.parent && ts.isTypeAliasDeclaration(holder.parent)) return holder.parent.name.text;
    return undefined;
  };

  // The one modifier set that turns a constructor parameter into a FIELD.
  // A decorator is a modifier too, so the check is by keyword, not by count.
  const isParameterProperty = (node: import('typescript').ParameterDeclaration): boolean =>
    !!node.modifiers?.some(m =>
      m.kind === ts.SyntaxKind.PublicKeyword || m.kind === ts.SyntaxKind.PrivateKeyword
      || m.kind === ts.SyntaxKind.ProtectedKeyword || m.kind === ts.SyntaxKind.ReadonlyKeyword);

  const recordFieldType = (
    name: import('typescript').PropertyName | import('typescript').BindingName,
    type: import('typescript').TypeNode | undefined,
  ): void => {
    const typeName = typeReferenceName(type);
    if (!typeName) return;
    const field = propertyNameText(name as import('typescript').PropertyName);
    if (!field) return;
    const named = fieldTypes.get(field) ?? new Set<string>();
    named.add(typeName);
    fieldTypes.set(field, named);
  };

  // What the code DECLARES a locally bound name to be: a parameter's
  // annotation, and an annotated variable declaration's. Only a plainly named
  // binding is recorded — a destructured one binds the type's PROPERTIES and
  // not the type — and only where the annotation names a type outright, the
  // same reading recordFieldType takes.
  const recordLocalType = (
    name: import('typescript').BindingName,
    type: import('typescript').TypeNode | undefined,
  ): void => {
    const typeName = typeReferenceName(type);
    if (!typeName || !ts.isIdentifier(name)) return;
    const named = localTypes.get(name.text) ?? new Set<string>();
    named.add(typeName);
    localTypes.set(name.text, named);
  };

  // What a named shape's MEMBERS are. Property-style members are the DATA;
  // method-style ones are behaviour, which the spec models on the axis
  // `typeRealization` judges — `structure?(text: string): string` is a method
  // signature, and counting it as a field would accuse every behavioural
  // interface in a tree of carrying undeclared state.
  const recordDeclaredShape = (
    name: string,
    members: readonly (import('typescript').ClassElement | import('typescript').TypeElement)[],
    inherited: boolean,
  ): void => {
    const fields: ShapeMemberFact[] = [];
    const methods: string[] = [];
    // A PRIVATE field a getter of the same class reads is backing storage:
    // the getter is the member the type's data is read through, and the
    // field behind it is implementation (`private readonly a` behind
    // `get amountMinor()`). A private field nothing exposes stays data.
    const backing = new Set<string>();
    for (const member of members) {
      if (!ts.isGetAccessorDeclaration(member) || !member.body) continue;
      const read = (node: import('typescript').Node): void => {
        if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) backing.add(node.name.text);
        ts.forEachChild(node, read);
      };
      read(member.body);
    }
    const isPrivate = (node: import('typescript').ClassElement | import('typescript').TypeElement | import('typescript').ParameterDeclaration): boolean =>
      (!!node.name && ts.isPrivateIdentifier(node.name))
      || !!ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.PrivateKeyword);
    const isBacking = (node: import('typescript').ClassElement | import('typescript').TypeElement | import('typescript').ParameterDeclaration, name: string): boolean =>
      isPrivate(node) && backing.has(name);
    for (const member of members) {
      // A constructor names no member of its own, but each of its parameter
      // PROPERTIES (`constructor(public readonly amount: number)`) declares a
      // field exactly as a property declaration would — the language's own
      // shorthand for one. Absent-able only when marked optional: a default
      // fills it, so the value always carries it.
      if (ts.isConstructorDeclaration(member)) {
        for (const param of member.parameters) {
          if (!isParameterProperty(param) || !ts.isIdentifier(param.name)) continue;
          if (isBacking(param, param.name.text)) continue;
          fields.push({ name: param.name.text, optional: !!param.questionToken });
        }
        continue;
      }
      // An index signature and a call signature name no member.
      const memberName = member.name ? propertyNameText(member.name) : undefined;
      if (!memberName) continue;
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
        methods.push(memberName);
      } else if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
        if (isBacking(member, memberName)) continue;
        fields.push({ name: memberName, optional: !!member.questionToken });
      }
    }
    const shape: TypeShapeFact = { origin: 'declared', fields, methods };
    if (inherited) shape.inherited = true;
    typeShapes.set(name, shape);
  };

  // The schema const a `type X = z.infer<typeof XSchema>` alias names: the ONE
  // hop a derived shape is allowed. Anything else — a union, an intersection,
  // a second alias, a qualified `typeof ns.XSchema` — resolves to nothing,
  // because a shape this model cannot follow is one it must not guess at.
  const inferredSchemaConstant = (type: import('typescript').TypeNode): string | undefined => {
    if (!ts.isTypeReferenceNode(type)) return undefined;
    const reference = ts.isIdentifier(type.typeName) ? type.typeName.text
      : ts.isQualifiedName(type.typeName) ? type.typeName.right.text : undefined;
    if (reference !== 'infer') return undefined;
    const [argument] = type.typeArguments ?? [];
    if (!argument || !ts.isTypeQueryNode(argument) || !ts.isIdentifier(argument.exprName)) return undefined;
    return argument.exprName.text;
  };

  // The combinators applied to ONE schema expression, read off its own call
  // chain and never off its text: a `.default()` nested inside a record's
  // value says nothing about whether the outer key may be absent.
  const chainedCombinators = (expression: import('typescript').Expression): Set<string> => {
    const applied = new Set<string>();
    let node: import('typescript').Node | undefined = expression;
    const walked = new Set<import('typescript').Node>();
    while (node && !walked.has(node)) {
      walked.add(node);
      if (ts.isCallExpression(node)) {
        const callee: import('typescript').Expression = node.expression;
        if (ts.isPropertyAccessExpression(callee)) applied.add(callee.name.text);
        node = callee;
      } else if (ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      } else break;
    }
    return applied;
  };

  // The members of a schema object literal. `.optional()` and `.nullish()`
  // are what let a key be ABSENT; `.default(x)` FILLS a missing one, so the
  // value the type finally holds always has it — which makes the field
  // REQUIRED in what the alias yields, `.optional().default(x)` included.
  const schemaMembers = (literal: import('typescript').ObjectLiteralExpression): ShapeMemberFact[] => {
    const fields: ShapeMemberFact[] = [];
    for (const property of literal.properties) {
      const memberName = property.name ? propertyNameText(property.name) : undefined;
      if (!memberName) continue;
      if (ts.isShorthandPropertyAssignment(property)) {
        fields.push({ name: memberName, optional: false });
      } else if (ts.isPropertyAssignment(property)) {
        const applied = chainedCombinators(property.initializer);
        const optional = (applied.has('optional') || applied.has('nullish')) && !applied.has('default');
        fields.push({ name: memberName, optional });
      }
    }
    return fields;
  };

  const hasExportModifier = (node: import('typescript').Node): boolean => {
    const mods = (node as { modifiers?: readonly import('typescript').ModifierLike[] }).modifiers;
    return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  // The name under which a function-like gets its own complexity entry: a
  // declaration's own name, or the named slot (variable / property) a
  // function/arrow initializer is bound to. Anonymous inline callbacks return
  // undefined — their branching belongs to the enclosing named function.
  const namedFunctionName = (node: import('typescript').Node): string | undefined => {
    if (ts.isFunctionDeclaration(node)) {
      return node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
    }
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return propertyNameText(node.name);
    }
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      const p = node.parent;
      if (p && ts.isVariableDeclaration(p) && p.initializer === node && ts.isIdentifier(p.name)) return p.name.text;
      if (p && (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p)) && p.initializer === node) {
        return propertyNameText(p.name);
      }
    }
    return undefined;
  };

  // The top-level named class a `this` written at `node` IS: walk out through
  // arrow functions (which keep `this`) to the first construct that binds it.
  // A method, accessor, constructor or property initializer of a top-level
  // named class answers that class; a function expression or declaration, an
  // object-literal method, a class expression or a nested class rebinds
  // `this` to something this model does not name, and answers nothing.
  const enclosingClassOf = (node: import('typescript').Node): string | undefined => {
    let at: import('typescript').Node | undefined = node.parent;
    while (at) {
      if (ts.isFunctionExpression(at) || ts.isFunctionDeclaration(at) || ts.isClassExpression(at)) return undefined;
      if ((ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at))
        && at.parent && ts.isObjectLiteralExpression(at.parent)) return undefined;
      if (ts.isClassDeclaration(at)) {
        return at.name && at.parent && ts.isSourceFile(at.parent) ? at.name.text : undefined;
      }
      at = at.parent;
    }
    return undefined;
  };

  // What a function-like RETURNS, where the code settles it: a return
  // annotation that names a type outright (a Promise of one unwrapped, since
  // the receiver of an awaited call is what it resolves to), else — only when
  // nothing is annotated — the class its ONE return statement constructs. A
  // generic, union or literal annotation, several returns, and a return of
  // anything but `new Class(…)` settle nothing: what an initializer or a
  // returned variable infers is not what the code declares.
  const returnedTypeOf = (fn: import('typescript').Node & { body?: import('typescript').Node }): string | undefined => {
    const annotated = (fn as import('typescript').SignatureDeclarationBase).type;
    if (annotated) {
      if (!ts.isTypeReferenceNode(annotated)) return undefined;
      if (ts.isIdentifier(annotated.typeName) && annotated.typeName.text === 'Promise'
        && annotated.typeArguments?.length === 1) {
        const inner = annotated.typeArguments[0];
        return ts.isTypeReferenceNode(inner) && !inner.typeArguments ? typeReferenceName(inner) : undefined;
      }
      return annotated.typeArguments ? undefined : typeReferenceName(annotated);
    }
    const constructedClass = (expression: import('typescript').Expression | undefined): string | undefined => {
      let node = expression;
      while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
      return node && ts.isNewExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : undefined;
    };
    if (!fn.body) return undefined;
    if (!ts.isBlock(fn.body)) return constructedClass(fn.body as import('typescript').Expression);
    const returns: import('typescript').ReturnStatement[] = [];
    const collect = (node: import('typescript').Node): void => {
      // A nested function's returns are its own.
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node);
      ts.forEachChild(node, collect);
    };
    ts.forEachChild(fn.body, collect);
    return returns.length === 1 ? constructedClass(returns[0].expression) : undefined;
  };

  // WHERE a named function-like's body is bound — the identity that tells
  // same-named bodies in one file apart (see FunctionBodyFact). Module scope
  // is a top-level function declaration or a top-level variable's function
  // initializer; a member is a member of a top-level named class, or a
  // property of an object literal a top-level variable is bound to (through
  // `as` / `satisfies` / parentheses, which change no binding). Anything
  // else is nested: bound somewhere this model does not name.
  const isTopLevelVariable = (decl: import('typescript').Node): decl is import('typescript').VariableDeclaration =>
    ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)
    && !!decl.parent && ts.isVariableDeclarationList(decl.parent)
    && !!decl.parent.parent && ts.isVariableStatement(decl.parent.parent)
    && !!decl.parent.parent.parent && ts.isSourceFile(decl.parent.parent.parent);
  const containerOf = (owner: import('typescript').Node | undefined): string | undefined => {
    if (!owner) return undefined;
    if (ts.isClassDeclaration(owner)) {
      return owner.name && owner.parent && ts.isSourceFile(owner.parent) ? owner.name.text : undefined;
    }
    if (!ts.isObjectLiteralExpression(owner)) return undefined;
    let slot: import('typescript').Node | undefined = owner.parent;
    while (slot && (ts.isAsExpression(slot) || ts.isSatisfiesExpression(slot) || ts.isParenthesizedExpression(slot))) {
      slot = slot.parent;
    }
    return slot && isTopLevelVariable(slot) ? (slot.name as import('typescript').Identifier).text : undefined;
  };
  const bindingOf = (node: import('typescript').Node): Pick<FunctionBodyFact, 'container' | 'nested'> => {
    const nested = { nested: true } as const;
    if (ts.isFunctionDeclaration(node)) return node.parent && ts.isSourceFile(node.parent) ? {} : nested;
    let owner: import('typescript').Node | undefined;
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      owner = node.parent;
    } else {
      const slot = node.parent;
      if (slot && ts.isVariableDeclaration(slot)) return isTopLevelVariable(slot) ? {} : nested;
      if (slot && (ts.isPropertyAssignment(slot) || ts.isPropertyDeclaration(slot))) owner = slot.parent;
    }
    const container = containerOf(owner);
    return container !== undefined ? { container } : nested;
  };

  // What a function-like DECLARES it takes, in order — the other half of the
  // signature a contract's `params` are read against. A parameter bound by
  // DESTRUCTURING records no name: there is none for a contract's to be
  // compared with, and inventing one would be a guess about somebody's
  // signature. Absent-able is the caller's question, so all three spellings
  // answer it — a question mark, a default value, and a rest parameter, which
  // a caller may leave out exactly as it may leave out an optional one.
  //
  // And whether each named one is PROVABLY unused: no identifier of its name
  // anywhere in the body or in another parameter's default value, and no read
  // of `arguments`. Every occurrence counts as a use but a member name read off
  // a value, so a shadowing local keeps the parameter judged — the only safe
  // way for this reading to be wrong.
  const declaredParameters = (fn: import('typescript').Node): ParameterFact[] => {
    const parameters = (fn as import('typescript').SignatureDeclarationBase).parameters ?? [];
    const used = new Set<string>();
    const mentions = (node: import('typescript').Node): void => {
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const memberName = !!parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
          || (ts.isPropertyAssignment(parent) && parent.name === node)
          || (ts.isQualifiedName(parent) && parent.right === node));
        if (!memberName) used.add(node.text);
      }
      ts.forEachChild(node, mentions);
    };
    const body = (fn as { body?: import('typescript').Node }).body;
    if (body) mentions(body);
    for (const parameter of parameters) if (parameter.initializer) mentions(parameter.initializer);
    return parameters.map((parameter) => {
      const fact: ParameterFact = {
        optional: !!parameter.questionToken || !!parameter.initializer || !!parameter.dotDotDotToken,
      };
      if (ts.isIdentifier(parameter.name)) {
        fact.name = parameter.name.text;
        if (!used.has(fact.name) && !used.has('arguments')) fact.unused = true;
      }
      // The annotation as WRITTEN, whitespace-normalized so a signature broken
      // over lines reads as the one type it is. An unannotated parameter
      // records none — what an initializer infers is not what the code
      // declares, the same silence a field with no annotation keeps.
      if (parameter.type) fact.type = parameter.type.getText(sf).replace(/\s+/g, ' ').trim();
      return fact;
    });
  };

  // One pass per named function's body collecting classic cyclomatic
  // complexity (decision points + 1) AND direct callee names. Nested NAMED
  // function-likes are excluded — they get their own entries — while
  // anonymous callbacks count into the enclosing function.
  const collectFunctionFacts = (fn: import('typescript').Node & { body?: import('typescript').Node }): { score: number; callees: Map<string, CallSiteFact> } => {
    let score = 1;
    const callees = new Map<string, CallSiteFact>();
    const addSite = (site: CallSiteFact): void => { callees.set(siteKey(site), site); };
    // A receiver is read through what only the type checker cares about — a
    // non-null assertion, parentheses, `satisfies`, a cast to a NAMED type —
    // so `this.store!.save()` is the same call as `this.store.save()`, never a
    // receiver nobody can follow. A cast to `any` or `unknown` (or to an
    // inline shape) says nothing about the value, and is not see-through: such
    // a receiver stays one the analysis cannot follow, and says so.
    const namedCast = (type: import('typescript').TypeNode): boolean =>
      ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName);
    const unwrapped = (expression: import('typescript').Expression): import('typescript').Expression => {
      let at = expression;
      while (
        ts.isNonNullExpression(at) || ts.isParenthesizedExpression(at)
        || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(at))
        || ((ts.isAsExpression(at) || ts.isTypeAssertionExpression(at)) && namedCast(at.type))
      ) at = at.expression;
      return at;
    };
    // The names this body binds to one of the instance's FIELDS — `const s =
    // this.store`, `const { store } = this`, `const { store: s } = this` — so
    // a call through the local alias is the call through the field it holds.
    const fieldAliases = new Map<string, string>();
    const collectAliases = (node: import('typescript').Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = unwrapped(node.initializer);
        if (ts.isIdentifier(node.name) && ts.isPropertyAccessExpression(init)
          && unwrapped(init.expression).kind === ts.SyntaxKind.ThisKeyword && ts.isIdentifier(init.name)) {
          fieldAliases.set(node.name.text, init.name.text);
        } else if (ts.isObjectBindingPattern(node.name) && init.kind === ts.SyntaxKind.ThisKeyword) {
          for (const element of node.name.elements) {
            if (element.dotDotDotToken || !ts.isIdentifier(element.name)) continue;
            const property = element.propertyName
              ? propertyNameText(element.propertyName)
              : element.name.text;
            if (property) fieldAliases.set(element.name.text, property);
          }
        }
      }
      ts.forEachChild(node, collectAliases);
    };
    if (fn.body) collectAliases(fn.body);
    const count = (node: import('typescript').Node): void => {
      if (namedFunctionName(node) !== undefined) return;
      if (ts.isIfStatement(node) || ts.isConditionalExpression(node)
        || ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)
        || ts.isWhileStatement(node) || ts.isDoStatement(node)
        || ts.isCaseClause(node) || ts.isCatchClause(node)) {
        score++;
      } else if (ts.isBinaryExpression(node)) {
        const k = node.operatorToken.kind;
        if (k === ts.SyntaxKind.AmpersandAmpersandToken || k === ts.SyntaxKind.BarBarToken
          || k === ts.SyntaxKind.QuestionQuestionToken) {
          score++;
        }
      } else if (ts.isCallExpression(node)) {
        // The call's SHAPE is the whole of what a pure model can say about
        // where it lands: a bare identifier resolves in this file's scope, a
        // member access through a plain identifier resolves through that
        // binding, or else through the type the file annotates that name
        // with, a member access through `this.<field>` resolves through the
        // type the class declares that field with, a member access on a
        // freshly CONSTRUCTED value resolves through the class name the code
        // names right there, and a member access through anything else
        // (`getStore().x()`) resolves nowhere without a type checker.
        const callee = node.expression;
        if (ts.isIdentifier(callee)) addSite({ name: callee.text, member: false });
        else if (ts.isPropertyAccessExpression(callee)) {
          const receiver = unwrapped(callee.expression);
          const name = callee.name.text;
          if (ts.isIdentifier(receiver) && fieldAliases.has(receiver.text)) {
            // A local alias of a field: the call through the field it holds.
            addSite({ name, member: true, field: fieldAliases.get(receiver.text)! });
          } else if (ts.isIdentifier(receiver)) addSite({ name, member: true, via: receiver.text });
          else if (ts.isPropertyAccessExpression(receiver) && unwrapped(receiver.expression).kind === ts.SyntaxKind.ThisKeyword) {
            addSite({ name, member: true, field: receiver.name.text });
          } else if (ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
            // `new ApprovalRegistry(store).create()` — only a plainly named
            // class, since `new ns.Registry()` is a property of a value again.
            addSite({ name, member: true, constructed: receiver.expression.text });
          } else if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
            // `current().updateSpec()` — the RESULT of a plainly named
            // function, followed through what the code says that function
            // returns. `ns.make().x()` is a property of a value again.
            addSite({ name, member: true, returnedBy: receiver.expression.text });
          } else if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
            // `this.loadSpec()` inside a class's own method: the class the
            // file declares, when `this` provably is one.
            const owner = enclosingClassOf(node);
            addSite(owner !== undefined ? { name, member: true, enclosingClass: owner } : { name, member: true });
          } else {
            // `this.deps.tracker.save()` / `deps.tracker.save()` — a chain of
            // plain property accesses rooted in `this` or a plain identifier:
            // the shape collaborators take when they arrive as one bag. Each
            // link is a name the code declares a type for; anything else in
            // the chain (a call, an index, `?.`) is a value again.
            const chain: string[] = [];
            let at: import('typescript').Expression = receiver;
            while (ts.isPropertyAccessExpression(at) && !at.questionDotToken && ts.isIdentifier(at.name)) {
              chain.unshift(at.name.text);
              at = unwrapped(at.expression);
            }
            if (ts.isIdentifier(at)) chain.unshift(at.text);
            else if (at.kind === ts.SyntaxKind.ThisKeyword) chain.unshift('this');
            else chain.length = 0;
            addSite(chain.length >= 2 ? { name, member: true, receiverPath: chain } : { name, member: true });
          }
        }
      }
      ts.forEachChild(node, count);
    };
    // count() on the body node itself (not just children): an arrow's
    // expression body may BE the decision point (`x => x ? a : b`). A body is
    // never itself a named function, so the skip guard cannot short-circuit it.
    if (fn.body) count(fn.body);
    return { score, callees };
  };

  // Whether a function-like completes LATER: declared `async`, or annotated
  // to return a Promise. What it returns unannotated is inferred, not
  // declared, and counts as completing now.
  const completesLater = (fn: import('typescript').Node): boolean => {
    const mods = (fn as { modifiers?: readonly import('typescript').ModifierLike[] }).modifiers;
    if (mods?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
    const returned = (fn as import('typescript').SignatureDeclarationBase).type;
    return !!returned && ts.isTypeReferenceNode(returned) && ts.isIdentifier(returned.typeName)
      && returned.typeName.text === 'Promise';
  };

  // The values of a union of string literals, in written order; undefined
  // when any member is something else.
  const stringLiteralUnion = (type: import('typescript').TypeNode): string[] | undefined => {
    const members = ts.isUnionTypeNode(type) ? [...type.types] : [type];
    const values: string[] = [];
    for (const member of members) {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return undefined;
      values.push(member.literal.text);
    }
    return values;
  };

  // The strings a `z.enum([...])` schema holds, read off its own call chain
  // (`z.enum([...]).default('a')` included): the array literal it is handed,
  // or a const array this file declares, `as const` or not. Undefined when
  // the chain holds no enum call or the array is not all string literals.
  const zodEnumValues = (expression: import('typescript').Expression): string[] | undefined => {
    const strings = (array: import('typescript').Expression | undefined, hops: number): string[] | undefined => {
      let node = array;
      while (node && (ts.isAsExpression(node) || ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
      if (node && ts.isIdentifier(node) && hops > 0) return strings(schemaConstants.get(node.text), hops - 1);
      if (!node || !ts.isArrayLiteralExpression(node) || node.elements.length === 0) return undefined;
      const values: string[] = [];
      for (const element of node.elements) {
        if (!ts.isStringLiteral(element) && !ts.isNoSubstitutionTemplateLiteral(element)) return undefined;
        values.push(element.text);
      }
      return values;
    };
    let node: import('typescript').Node | undefined = expression;
    const walked = new Set<import('typescript').Node>();
    while (node && !walked.has(node)) {
      walked.add(node);
      if (ts.isCallExpression(node)) {
        const callee: import('typescript').Expression = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'enum') return strings(node.arguments[0], 1);
        node = callee;
      } else if (ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      } else break;
    }
    return undefined;
  };

  const visit = (node: import('typescript').Node): void => {
    const fnName = namedFunctionName(node);
    if (fnName && (node as { body?: import('typescript').Node }).body) {
      const facts = collectFunctionFacts(node as { body?: import('typescript').Node } & import('typescript').Node);
      complexity.set(fnName, Math.max(complexity.get(fnName) ?? 0, facts.score));
      const sites = calls.get(fnName) ?? new Map<string, CallSiteFact>();
      for (const [key, site] of facts.callees) sites.set(key, site);
      calls.set(fnName, sites);
      // And this body's own sites, under where it is bound, so a reader can
      // tell it from the other bodies of its name.
      const named = bodies.get(fnName) ?? [];
      named.push({ ...bindingOf(node), sites: [...facts.callees.values()] });
      bodies.set(fnName, named);
      // The signature a caller reaches, recorded inside the WITH-A-BODY guard
      // this block already is: an overload's signatures have no body, so the
      // implementation signature is the only one collected. EVERY body under
      // the name is kept — a class member and the module-level facade that
      // forwards to it are two different signatures, and which one a contract
      // means is the reader's question, not this walk's.
      const signatures = functionParams.get(fnName) ?? [];
      const declaredHere = declaredParameters(node);
      signatures.push(declaredHere);
      paramSites.push({ pos: node.pos, params: declaredHere });
      functionParams.set(fnName, signatures);
      // Whether THIS body completes later: declared `async`, or annotated to
      // return a Promise. One entry per body, beside the one signature per
      // body above, so a name's bodies are judged on what they all say.
      if (completesLater(node)) asyncFunctions.push(fnName);
      // What THIS body returns, where the code settles it. Same-named bodies
      // that disagree — or one that settles nothing beside one that does —
      // leave the name unsettled, so the fact records nothing for it.
      const returned = returnedTypeOf(node as { body?: import('typescript').Node } & import('typescript').Node) ?? null;
      returnTypes.set(fnName, returnTypes.has(fnName) && returnTypes.get(fnName) !== returned ? null : returned);
      // The routes the body's guards serve. Only a name with at least one
      // gets an entry: "no entry" is how a reader tells a router it could not
      // read from one it read, so an empty map is never written.
      // Read once the walk is over: a route table or a prefix constant is as
      // often declared below the router as above it.
      routeBodies.push({ name: fnName, node });
    }
    // What the code DECLARES an instance field to be: a class property's own
    // annotation, and a constructor parameter property's — the shape that
    // writes down what a constructor-injected collaborator is. Read outside
    // the chain below, which is an else-if over the same node kinds.
    if (ts.isPropertyDeclaration(node)) {
      recordFieldType(node.name, node.type);
      recordMemberType(shapeNameOf(node.parent), node.name, node.type);
    } else if (ts.isParameter(node) && node.parent && ts.isConstructorDeclaration(node.parent) && isParameterProperty(node)) {
      recordFieldType(node.name, node.type);
      recordMemberType(shapeNameOf(node.parent.parent), node.name, node.type);
    } else if (ts.isPropertySignature(node)) {
      recordMemberType(shapeNameOf(node.parent), node.name, node.type);
    }
    // And what it declares a locally BOUND name to be: the receiver shape a
    // module that wires its collaborators as closures is written in. A
    // constructor parameter property is both, and is recorded as both — inside
    // the constructor body the same name IS the parameter.
    if (ts.isParameter(node) || ts.isVariableDeclaration(node)) recordLocalType(node.name, node.type);
    // And what a named SHAPE holds, which is the data model's own claim: an
    // interface or class lists its members, and a type alias either lists them
    // (a type literal) or names the value they come from — the derived hop,
    // resolved after the walk. Read outside the chain below, which is an
    // else-if over these same node kinds.
    if (ts.isInterfaceDeclaration(node)) {
      recordDeclaredShape(node.name.text, node.members, (node.heritageClauses?.length ?? 0) > 0);
    } else if (ts.isClassDeclaration(node) && node.name) {
      // Only an `extends` clause brings members with it. A class that
      // `implements` an interface still lists its whole shape, so reading that
      // as inherited would exempt it from the presence checks for nothing.
      const extendsOther = (node.heritageClauses ?? []).some(
        (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
      );
      recordDeclaredShape(node.name.text, node.members, extendsOther);
      // What the class says it IMPLEMENTS: the names its implements clause
      // writes, each read as a field's declared type is. The step from an
      // interface in a shared contracts file to the class that realizes it.
      const implemented = (node.heritageClauses ?? [])
        .filter((clause) => clause.token === ts.SyntaxKind.ImplementsKeyword)
        .flatMap((clause) => clause.types.map((t) => (ts.isIdentifier(t.expression) ? t.expression.text : undefined)))
        .filter((name): name is string => name !== undefined);
      if (implemented.length > 0 && !implementsClauses.has(node.name.text)) implementsClauses.set(node.name.text, implemented);
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (ts.isTypeLiteralNode(node.type)) recordDeclaredShape(node.name.text, node.type.members, false);
      else {
        // The alias's right side as written: a named scalar's realization
        // (`type PackPath = string`) is judged on it through the dialect.
        // First declaration wins, as for every other per-name fact.
        if (!aliasTypes.has(node.name.text)) aliasTypes.set(node.name.text, node.type.getText(sf));
        // The one type the alias NAMES outright, read as a field's type is.
        const named = typeReferenceName(node.type);
        if (named !== undefined && named !== node.name.text && !aliasTargets.has(node.name.text)) {
          aliasTargets.set(node.name.text, named);
        }
        const constant = inferredSchemaConstant(node.type);
        if (constant) derivedAliases.push({ name: node.name.text, constant });
        // An alias that IS a closed set of strings: the enum-like declaration
        // TypeScript writes most often. A union mixing anything else in is
        // not one, and records nothing.
        const literals = stringLiteralUnion(node.type);
        if (literals) enumValues.set(node.name.text, literals);
      }
    }
    // A string enum: every member initialised with a string literal. A
    // numeric or computed member makes it something else, and nothing is
    // recorded rather than a part of it.
    if (ts.isEnumDeclaration(node)) {
      const values = node.members.map((member) =>
        member.initializer && (ts.isStringLiteral(member.initializer) || ts.isNoSubstitutionTemplateLiteral(member.initializer))
          ? member.initializer.text : undefined);
      if (values.length > 0 && values.every((v): v is string => v !== undefined)) enumValues.set(node.name.text, values);
    }
    // The value half of that hop, kept as the walk meets it. First binding
    // wins: a name rebound later is a different value, and the shape a spec
    // claims is the one the file introduces under the name.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && !schemaConstants.has(node.name.text)) {
      schemaConstants.set(node.name.text, node.initializer);
    }
    // The forwards an adapter OBJECT is assembled from: each property of a
    // top-level object literal whose value is a plain name of this file's
    // scope — `{ publish: publishRepo }` or the shorthand `{ publish }`. Kept
    // until the walk knows which objects the file exports; a property whose
    // value is a function carries its own body already.
    if (isTopLevelVariable(node) && node.initializer) {
      let literal: import('typescript').Expression = node.initializer;
      while (ts.isAsExpression(literal) || ts.isSatisfiesExpression(literal) || ts.isParenthesizedExpression(literal)) {
        literal = literal.expression;
      }
      if (ts.isObjectLiteralExpression(literal)) {
        const container = (node.name as import('typescript').Identifier).text;
        for (const property of literal.properties) {
          if (ts.isShorthandPropertyAssignment(property)) {
            propertyAliases.push({ exported: property.name.text, local: property.name.text, container });
          } else if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.initializer)) {
            const key = propertyNameText(property.name);
            if (key) propertyAliases.push({ exported: key, local: property.initializer.text, container });
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (name) {
        declared.add(name);
        if (hasExportModifier(node)) exported.add(name);
      }
    } else if (ts.isVariableStatement(node)) {
      const isExported = hasExportModifier(node);
      const isMutable = (node.declarationList.flags & ts.NodeFlags.Const) === 0;
      const atModuleScope = node.parent === sf;
      for (const decl of node.declarationList.declarations) {
        addBindingNames(decl.name);
        if (isExported && ts.isIdentifier(decl.name)) exported.add(decl.name.text);
        if (isMutable && atModuleScope && ts.isIdentifier(decl.name)) mutableBindings.add(decl.name.text);
      }
    } else if (ts.isVariableDeclaration(node)) {
      // nested declarations (inside functions) — parameters are deliberately excluded
      addBindingNames(node.name);
      recordLazyBindings(node);
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node)
      || ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
      || ts.isPropertyAssignment(node)) {
      const name = propertyNameText(node.name);
      if (name) declared.add(name);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      declared.add(node.name.text);
    } else if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      // Type-only imports never form a dependency edge (type coupling is
      // allowed by default) — but their bindings still anchor declarations.
      const typeOnly = clause?.isTypeOnly ?? false;
      const spec = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (!typeOnly && spec) imports.add(spec);
      // A binding records where the name came from as a call ORIGIN only when
      // the import is a RUNTIME one: a type binding can never be one. A
      // per-element `type` marker excludes that element alone. The type-only
      // half is kept too, apart — it is never an origin, but it is what a
      // declared field type is resolved through.
      const bind = (name: string, namespace: boolean, imported?: string, elementTypeOnly = false): void => {
        declared.add(name);
        if (!spec) return;
        if (typeOnly || elementTypeOnly) { typeOnlyBindings.set(name, spec); return; }
        const fact: ImportBindingFact = { from: spec };
        if (namespace) fact.namespace = true;
        if (imported && imported !== name) fact.imported = imported;
        importBindings.set(name, fact);
      };
      if (clause?.name) bind(clause.name.text, false);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name.text, true);
        else for (const el of clause.namedBindings.elements) bind(el.name.text, false, el.propertyName?.text, el.isTypeOnly);
      }
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (spec) reexports.add(spec);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          declared.add(el.name.text);
          exported.add(el.name.text);
          if (node.isTypeOnly || el.isTypeOnly) continue;
          const local = (el.propertyName ?? el.name).text;
          if (spec) namedReexports.push({ exported: el.name.text, local, from: spec });
          // No specifier: the file publishes a name of its OWN scope under
          // this one — `export { bootstrapInstance as init }` — which the
          // chase follows to the body the local name settles on.
          else exportAliases.push({ exported: el.name.text, local });
        }
      } else if (!node.exportClause && spec) {
        starExports.push(spec);
      }
    } else if (ts.isExportAssignment(node)) {
      exported.add('default');
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const isRequire = ts.isIdentifier(expr) && expr.text === 'require';
      const isDynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && node.arguments.length > 0 && ts.isStringLiteral(node.arguments[0])) {
        imports.add((node.arguments[0] as import('typescript').StringLiteral).text);
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      anchors.add(node.text);
    } else if (ts.isPropertyAccessExpression(node)) {
      // `specs.loadComponentSpecs()` — a property-access reference is a weak
      // anchor: real usage of the name (forwarding adapters, namespace
      // dispatch) without a local declaration.
      anchors.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // The routes each named function-like serves, read now that every
  // top-level constant of the file has been met: a route table or the prefix
  // a router strips is as often declared below it as above. Only a name with
  // at least one route gets an entry: "no entry" is how a reader tells a
  // router it could not read from one it read, so an empty map is never
  // written.
  const fileValues = fileInitializer(ts, topLevelConstants(ts, sf));
  for (const { name, node } of routeBodies) {
    const routes = readRoutes(ts, node as import('typescript').Node & { body?: import('typescript').Node }, fileValues);
    if (routes.size === 0) continue;
    const known = functionRoutes.get(name) ?? new Map<string, RouteFact>();
    for (const [key, route] of routes) known.set(key, route);
    functionRoutes.set(name, known);
  }

  // The members a schema expression composes, read off this file alone: the
  // base `.object({…})` call's keys, or — when the chain is built on another
  // schema constant THIS FILE declares (`Base.extend({…})`,
  // `Base.superRefine(…)`) — that constant's members, with each `.extend`
  // literal's keys laid over them, the outermost last. Every part of the
  // composition is written in this file, so following it guesses nothing; a
  // base the file does not declare, or a cycle, ends in NO answer. Only the
  // `.object` and `.extend` literals are taken: `z.object({…}).refine(fn,
  // { message })` hands the REFINE OPTIONS to whoever takes the first object
  // literal it meets, and the shape would then read as one field `message`.
  const composedMembers = (
    expression: import('typescript').Expression,
    seen: Set<string>,
  ): ShapeMemberFact[] | undefined => {
    const extensions: import('typescript').ObjectLiteralExpression[] = [];
    /** The base's members with every extension laid over them, innermost first. */
    const compose = (members: ShapeMemberFact[]): ShapeMemberFact[] => {
      const byName = new Map(members.map(member => [member.name, member]));
      for (const extension of [...extensions].reverse()) {
        for (const member of schemaMembers(extension)) byName.set(member.name, member);
      }
      return [...byName.values()];
    };
    let node: import('typescript').Node | undefined = expression;
    const walked = new Set<import('typescript').Node>();
    while (node && !walked.has(node)) {
      walked.add(node);
      if (ts.isCallExpression(node)) {
        const callee: import('typescript').Expression = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'object') {
          // The base literal — never the options object a refinement takes.
          const literal = node.arguments.find(argument => ts.isObjectLiteralExpression(argument));
          if (literal) return compose(schemaMembers(literal as import('typescript').ObjectLiteralExpression));
        } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'extend') {
          const extension = node.arguments.find(argument => ts.isObjectLiteralExpression(argument));
          if (!extension) return undefined;
          extensions.push(extension as import('typescript').ObjectLiteralExpression);
        }
        node = callee;
      } else if (ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      } else if (ts.isIdentifier(node)) {
        const base = schemaConstants.get(node.text);
        if (!base || seen.has(node.text)) return undefined;
        const members = composedMembers(base, new Set([...seen, node.text]));
        return members ? compose(members) : undefined;
      } else break;
    }
    return undefined;
  };

  // The derived hop, now that both halves have been seen. ONE hop from the
  // alias to the value, then only along a composition this file writes out
  // (composedMembers): an alias whose schema const this file does not
  // declare, or whose chain never reaches an object literal, records NO
  // shape. Silence is the honest answer — the type still has to be DECLARED
  // somewhere, which is `typeRealization`'s question, and a guessed member
  // list would be read as measurement by everything downstream.
  for (const alias of derivedAliases) {
    if (typeShapes.has(alias.name)) continue;
    const initializer = schemaConstants.get(alias.constant);
    if (!initializer) continue;
    const fields = composedMembers(initializer, new Set([alias.constant]));
    if (!fields) continue;
    typeShapes.set(alias.name, { origin: 'derived', fields, methods: [] });
  }

  // The `z.enum([...])` constants the file declares, and the aliases that
  // infer from one — the same ONE hop a derived shape takes. A constant whose
  // array is not all string literals (or not written here) records nothing.
  for (const [name, initializer] of schemaConstants) {
    const values = zodEnumValues(initializer);
    if (values) enumValues.set(name, values);
  }
  for (const alias of derivedAliases) {
    if (enumValues.has(alias.name)) continue;
    const values = enumValues.get(alias.constant);
    if (values && schemaConstants.has(alias.constant)) enumValues.set(alias.name, values);
  }

  // A pure re-export barrel, stated as what it IS: a file whose every
  // top-level statement re-exports another module. Nothing is declared here,
  // so there is nothing for a spec to claim.
  const reexportOnly = sf.statements.length > 0
    && sf.statements.every(st => ts.isExportDeclaration(st) && !!st.moduleSpecifier);

  // A lazily loaded name joins the import bindings only where it is
  // unambiguous: no two lazy loads disagree on it, no static import binds it,
  // and the file declares no body of that name a bare call could also mean.
  // Anything else stays silent — unresolved, as it was.
  for (const [name, fact] of lazyBindings) {
    if (!fact || importBindings.has(name) || typeOnlyBindings.has(name) || bodies.has(name)) continue;
    importBindings.set(name, fact);
  }

  // Only an EXPORTED object is an adapter a consumer reaches through: its
  // property aliases join the specifier aliases.
  for (const alias of propertyAliases) if (exported.has(alias.container!)) exportAliases.push(alias);

  return { declared, anchors, exported, imports, reexports, starExports, namedReexports, exportAliases, returnTypes, complexity, calls, bodies, importBindings, typeOnlyBindings, fieldTypes, localTypes, memberTypes, aliasTargets, implementsClauses, typeShapes, functionParams, paramSites, functionRoutes, asyncFunctions, enumValues, aliasTypes, mutableBindings, reexportOnly };
}

/**
 * The local packages of the analyzed repository, by specifier, as ABSOLUTE
 * source paths (see readLocalPackages) — what the barrel chase resolves a
 * package specifier through. Empty resolves no package at all, which is the
 * old relative-only behaviour.
 */
type LocalPackages = ReadonlyMap<string, string>;
const NO_PACKAGES: LocalPackages = new Map<string, string>();

/**
 * Resolve an import specifier to a real file: a relative one by .js → .ts
 * mapping and index files, a package one through the repository's own
 * packages. A third-party package resolves to nothing.
 */
function resolveModule(fromFile: string, specifier: string, packages: LocalPackages): string | null {
  if (!specifier.startsWith('.')) return packages.get(specifier) ?? null;
  return resolveRelativeModule(fromFile, specifier);
}

/** Resolve a relative export-* specifier to a real file (.js → .ts mapping, index files). */
function resolveRelativeModule(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'),
    `${base}.ts`, `${base}.tsx`, `${base}.js`,
    path.join(base, 'index.ts'), path.join(base, 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* not this candidate */ }
  }
  return null;
}

/**
 * The facts of one relative re-export target, chased and cached — or null when
 * the specifier does not resolve, escapes the project, or cannot be read.
 */
function reexportTarget(
  ts: TsModule,
  filePath: string,
  specifier: string,
  projectRoot: string,
  visited: Set<string>,
  exactCache: Map<string, ExactFacts | null>,
  packages: LocalPackages,
): { path: string; facts: ExactFacts } | null {
  const target = resolveModule(filePath, specifier, packages);
  // containment: never chase outside the analyzed project
  if (!target || path.relative(projectRoot, target).startsWith('..')) return null;
  let targetFacts = exactCache.get(target);
  if (targetFacts === undefined) {
    try {
      targetFacts = walkExact(ts, fs.readFileSync(target, 'utf8'), target);
    } catch {
      targetFacts = null;
    }
    exactCache.set(target, targetFacts);
  }
  if (!targetFacts) return null;
  if (!visited.has(target)) {
    visited.add(target);
    chaseReexports(ts, targetFacts, target, projectRoot, visited, exactCache, packages);
  }
  return { path: target, facts: targetFacts };
}

/**
 * Carry one republished name's measured BODY — its complexity and its call
 * sites — from the module that wrote it onto the barrel that publishes it, so
 * the detail dial and the call-realization checks see through the hop. The
 * sites keep the file they were READ in: their bare names and receivers
 * resolve in the real module's scope, never in the barrel's.
 */
function carryBody(
  facts: ExactFacts,
  target: ExactFacts,
  targetPath: string,
  local: string,
  exported: string,
  projectRoot: string,
): void {
  const score = target.complexity.get(local);
  if (score !== undefined) facts.complexity.set(exported, Math.max(facts.complexity.get(exported) ?? 0, score));
  const targetCalls = target.calls.get(local);
  if (!targetCalls) return;
  const carriedFrom = pathKey(path.relative(projectRoot, targetPath));
  const sites = facts.calls.get(exported) ?? new Map<string, CallSiteFact>();
  for (const [key, site] of targetCalls) sites.set(carriedFrom + '|' + key, { ...site, from: site.from ?? carriedFrom });
  facts.calls.set(exported, sites);
  // The barrel publishes the target's MODULE binding of the name — never a
  // member, which no export names — so that is the body it carries. A
  // target holding none (or a nested one beside it) leaves the name to the
  // union, exactly as the target itself would answer.
  const targetBodies = target.bodies.get(local) ?? [];
  if (targetBodies.some(b => b.nested)) return;
  const moduleScope = targetBodies.filter(b => b.container === undefined);
  if (!moduleScope.length) return;
  const carried = facts.bodies.get(exported) ?? [];
  for (const body of moduleScope) {
    carried.push({ sites: body.sites.map(site => ({ ...site, from: site.from ?? carriedFrom })) });
  }
  facts.bodies.set(exported, carried);
}

/**
 * Carry the ONE body an export alias's local name settles on onto the name it
 * publishes — under its object as a member for a property alias, at module
 * scope for an export specifier. `from` is set only when the body was read
 * in another file, whose scope its sites resolve in.
 *
 * A local name settles only on module-scope bodies with no nested same-named
 * body beside them: a nested one could be the binding the name means where it
 * sits, and a member is never what a bare name binds. Anything else carries
 * nothing, and the published name stays bodiless rather than guessed.
 */
function carryAliasBody(
  facts: ExactFacts,
  source: ExactFacts,
  from: string | undefined,
  local: string,
  alias: ExportAliasFact,
): void {
  const sourceBodies = source.bodies.get(local) ?? [];
  if (!sourceBodies.length || sourceBodies.some(b => b.nested)) return;
  const moduleScope = sourceBodies.filter(b => b.container === undefined);
  if (!moduleScope.length) return;
  const score = source.complexity.get(local);
  if (score !== undefined) {
    facts.complexity.set(alias.exported, Math.max(facts.complexity.get(alias.exported) ?? 0, score));
  }
  const relocate = (site: CallSiteFact): CallSiteFact => (from !== undefined ? { ...site, from: site.from ?? from } : site);
  const sites = facts.calls.get(alias.exported) ?? new Map<string, CallSiteFact>();
  const carried = facts.bodies.get(alias.exported) ?? [];
  for (const body of moduleScope) {
    const moved = body.sites.map(relocate);
    for (const site of moved) sites.set(`${from ?? ''}|${alias.container ?? ''}|${JSON.stringify(site)}`, site);
    carried.push(alias.container !== undefined ? { container: alias.container, sites: moved } : { sites: moved });
  }
  facts.calls.set(alias.exported, sites);
  facts.bodies.set(alias.exported, carried);
}

/**
 * Chase re-export barrels: merge the (transitive) exported names of every
 * relative star-export target into the facts, and carry the measured body of
 * every name a barrel republishes — star or named alike — so a pure re-export
 * barrel like core_portal's index.ts realizes the names it publishes. The two
 * spellings republish the same way, so they are chased the same way.
 */
function chaseReexports(
  ts: TsModule,
  facts: ExactFacts,
  filePath: string,
  projectRoot: string,
  visited: Set<string>,
  exactCache: Map<string, ExactFacts | null>,
  packages: LocalPackages = NO_PACKAGES,
): void {
  for (const re of facts.namedReexports) {
    const target = reexportTarget(ts, filePath, re.from, projectRoot, visited, exactCache, packages);
    if (target) carryBody(facts, target.facts, target.path, re.local, re.exported, projectRoot);
  }
  for (const spec of facts.starExports) {
    const target = reexportTarget(ts, filePath, spec, projectRoot, visited, exactCache, packages);
    if (!target) continue;
    for (const name of target.facts.exported) {
      facts.exported.add(name);
      facts.declared.add(name);
      carryBody(facts, target.facts, target.path, name, name, projectRoot);
    }
  }
  // The forwards written with no specifier: the name a local alias binds is
  // either an import — the body lives in the module it came from, under the
  // name it was imported by — or this file's own declaration. An unrenamed
  // export specifier of the file's own function already has its body here.
  for (const alias of facts.exportAliases) {
    const binding = facts.importBindings.get(alias.local);
    if (binding) {
      if (binding.namespace) continue;
      const target = reexportTarget(ts, filePath, binding.from, projectRoot, visited, exactCache, packages);
      if (!target) continue;
      const from = pathKey(path.relative(projectRoot, target.path));
      carryAliasBody(facts, target.facts, from, binding.imported ?? alias.local, alias);
    } else if (alias.container !== undefined || alias.local !== alias.exported) {
      carryAliasBody(facts, facts, undefined, alias.local, alias);
    }
  }
}

// ---------------------------------------------------------------------------
// The repository's own packages
// ---------------------------------------------------------------------------

/** The build-output extensions an entry point is written in, longest first. */
const BUILD_EXTENSIONS = ['.d.mts', '.d.cts', '.d.ts', '.mjs', '.cjs', '.jsx', '.js'];
/** The source extensions a build entry can have been compiled from, in preference order. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
/** The export conditions read for an entry, in order; any other condition is read after them. */
const ENTRY_CONDITIONS = ['types', 'import', 'require', 'default'];

/** A file inside the project that no dependency installation wrote. */
function isOwnFile(projectRoot: string, absolute: string): boolean {
  const rel = path.relative(projectRoot, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !pathKey(rel).split('/').includes('node_modules');
}

function isFile(absolute: string): boolean {
  try {
    return fs.statSync(absolute).isFile();
  } catch {
    return false;
  }
}

/** A JSON file's value, or undefined when it cannot be read or parsed — a tsconfig through the compiler's own reader when it resolves, since tsconfig allows comments. */
function readJsonFile(file: string, ts: TsModule | null): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    if (!ts) return undefined;
    const parsed = ts.parseConfigFileTextToJson(file, text);
    return parsed.error ? undefined : parsed.config;
  }
}

/** Every string target an export condition object names, in condition order (nested conditions flattened). */
function conditionTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const keys = [...ENTRY_CONDITIONS.filter(k => k in record), ...Object.keys(record).filter(k => !ENTRY_CONDITIONS.includes(k))];
  return keys.flatMap(k => conditionTargets(record[k]));
}

/**
 * A package's entry points by subpath (`.` for the main one), each with the
 * targets to try in order: its `exports` — a string, a condition object, or
 * a subpath map whose plain (wildcard-free) keys are read — else its module,
 * main and types fields for the main entry.
 */
function packageEntries(pkg: Record<string, unknown>): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  const exportsField = pkg.exports;
  if (exportsField !== undefined && exportsField !== null) {
    const isSubpathMap = typeof exportsField === 'object' && !Array.isArray(exportsField)
      && Object.keys(exportsField as object).some(k => k.startsWith('.'));
    if (isSubpathMap) {
      for (const [subpath, value] of Object.entries(exportsField as Record<string, unknown>)) {
        if (!subpath.startsWith('.') || subpath.includes('*')) continue;
        const targets = conditionTargets(value);
        if (targets.length) entries.set(subpath, targets);
      }
    } else {
      const targets = conditionTargets(exportsField);
      if (targets.length) entries.set('.', targets);
    }
    return entries;
  }
  const fallbacks = ['module', 'main', 'types'].map(k => pkg[k]).filter((v): v is string => typeof v === 'string');
  if (fallbacks.length) entries.set('.', fallbacks);
  return entries;
}

/**
 * The source file an entry target was built from: the target itself when it
 * is a source file the analyzer reads (a declaration file never is), else —
 * under the package tsconfig's outDir — the same relative path under its
 * rootDir, the build extension swapped for a source one. Null when neither
 * exists inside the project.
 */
function entrySource(
  packageDir: string,
  target: string,
  compiler: { outDir?: string; rootDir?: string },
  projectRoot: string,
): string | null {
  const absolute = path.resolve(packageDir, target);
  if (!isOwnFile(projectRoot, absolute)) return null;
  const isDeclaration = /\.d\.[cm]?ts$/.test(absolute);
  if (!isDeclaration && languageOfSourcePath(absolute) && isFile(absolute)
    && !(compiler.outDir && !path.relative(compiler.outDir, absolute).startsWith('..'))) {
    return absolute;
  }
  if (!compiler.outDir || !compiler.rootDir) return null;
  const inOut = path.relative(compiler.outDir, absolute);
  if (inOut.startsWith('..') || path.isAbsolute(inOut)) return null;
  const extension = BUILD_EXTENSIONS.find(ext => inOut.endsWith(ext));
  const stem = extension ? inOut.slice(0, -extension.length) : inOut;
  for (const ext of SOURCE_EXTENSIONS) {
    const candidate = path.join(compiler.rootDir, stem + ext);
    if (isOwnFile(projectRoot, candidate) && isFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The packages of THIS repository, by the specifier that names them, each
 * mapped to the ABSOLUTE source file it resolves to: the root package and
 * every workspace the root package.json declares — a plain directory, or one
 * trailing `/*` level — that stays inside the project and outside
 * node_modules. A package or entry that cannot be read or mapped records
 * nothing, so its imports stay unresolved exactly as a third-party one's do.
 * Deterministic: the first package to claim a specifier keeps it.
 */
function readLocalPackages(projectRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const ts = resolveTypeScript(projectRoot);
  const root = readJsonFile(path.join(projectRoot, 'package.json'), null);
  if (!root || typeof root !== 'object' || Array.isArray(root)) return out;
  const rootPkg = root as Record<string, unknown>;
  const declared = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces
    : rootPkg.workspaces && typeof rootPkg.workspaces === 'object'
      && Array.isArray((rootPkg.workspaces as Record<string, unknown>).packages)
      ? (rootPkg.workspaces as { packages: unknown[] }).packages : [];
  const dirs: string[] = [projectRoot];
  for (const entry of declared) {
    if (typeof entry !== 'string') continue;
    const key = pathKey(entry).replace(/\/+$/, '');
    if (!key || path.isAbsolute(key)) continue;
    if (key.endsWith('/*')) {
      const base = path.resolve(projectRoot, key.slice(0, -2));
      if (base.includes('*') || !isOwnFile(projectRoot, base)) continue;
      let children: fs.Dirent[];
      try {
        children = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        if (child.isDirectory() && child.name !== 'node_modules' && !child.name.startsWith('.')) {
          dirs.push(path.join(base, child.name));
        }
      }
    } else if (!key.includes('*')) {
      const dir = path.resolve(projectRoot, key);
      if (isOwnFile(projectRoot, dir)) dirs.push(dir);
    }
  }
  for (const dir of dirs) {
    const pkg = dir === projectRoot ? rootPkg : readJsonFile(path.join(dir, 'package.json'), null);
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) continue;
    const name = (pkg as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name) continue;
    const tsconfig = readJsonFile(path.join(dir, 'tsconfig.json'), ts) as { compilerOptions?: Record<string, unknown> } | undefined;
    const options = tsconfig?.compilerOptions ?? {};
    const compiler = {
      outDir: typeof options.outDir === 'string' ? path.resolve(dir, options.outDir) : undefined,
      rootDir: typeof options.rootDir === 'string' ? path.resolve(dir, options.rootDir) : undefined,
    };
    for (const [subpath, targets] of packageEntries(pkg as Record<string, unknown>)) {
      const specifier = subpath === '.' ? name : `${name}/${subpath.replace(/^\.\//, '')}`;
      if (out.has(specifier)) continue;
      for (const target of targets) {
        const source = entrySource(dir, target, compiler, projectRoot);
        if (source) {
          out.set(specifier, source);
          break;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter entry point
// ---------------------------------------------------------------------------

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096));
  return probe.includes(0);
}

/**
 * Every file under a declared set of roots, as canonical project-relative keys
 * in walk order.
 *
 * ONE walk serves both root lists this adapter reads. For `sourceRoots` the
 * answer is the files no spec need name, which is the unclaimed-source rule's
 * whole subject; for `testRoots` it is the suite a write searches for the
 * tests it just invalidated. The containment terms are the same on purpose,
 * and a second walker would have been the one that eventually stopped agreeing
 * about what a root may reach.
 *
 * Each root is resolved and containment-checked within projectRoot (an
 * absolute or parent-escaping root is skipped, never walked), a directory is
 * walked recursively and a file stands for itself, and a file counts when its
 * extension names a language the analyzer knows. Directories named
 * `node_modules` and directories whose name begins with a dot are never
 * descended into, so a broad root cannot turn the walk pathological. A path
 * at, or under, any `exclude` entry is left out entirely — vendored or
 * generated code is neither analyzed nor carried as debt.
 *
 * Declaring no roots yields no files, which is what keeps both readers of this
 * walk opt-in.
 */
function walkDeclaredRoots(
  roots: readonly string[],
  exclude: readonly string[],
  projectRoot: string,
): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const excluded = exclude.map(pathKey);
  const isExcluded = (key: string): boolean =>
    excluded.some(e => key === e || key.startsWith(`${e}/`));

  const record = (absolute: string): void => {
    const key = pathKey(path.relative(projectRoot, absolute));
    if (seen.has(key) || isExcluded(key)) return;
    if (!languageOfSourcePath(key)) return;
    seen.add(key);
    found.push(key);
  };

  const descend = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable directory contributes nothing, and never aborts the run
    }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (isExcluded(pathKey(path.relative(projectRoot, child)))) continue;
        descend(child);
      } else if (entry.isFile()) {
        record(child);
      }
    }
  };

  for (const root of roots) {
    const key = pathKey(root);
    if (path.isAbsolute(key) || path.normalize(key).split(path.sep)[0] === '..') continue;
    const absolute = path.resolve(projectRoot, key);
    if (path.relative(projectRoot, absolute).startsWith('..')) continue;
    if (isExcluded(key)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      continue; // a root that does not exist walks nothing
    }
    if (stat.isDirectory()) descend(absolute);
    else if (stat.isFile()) record(absolute);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Call resolution through the type checker (source_file_facts.resolvedCalls)
//
// The shape facts above follow the receiver spellings a pure model knows, and
// every spelling they do not know was a way past the Portal write check: an
// element access, a destructured method, a field of a dependency bag, an alias
// of the type, a port declared in a contracts module. The checker keeps no list
// of spellings — it resolves the callee to the DECLARATION it is — so each
// call is recorded with where that declaration lives, and, for a declaration
// in an interface or type shape, with the project classes that realize it.
// ---------------------------------------------------------------------------

/**
 * Parsed source files reused across runs, keyed on what a parse depends on:
 * the compiler module, the options it was parsed under and the file's exact
 * text. A long-lived process never answers from a stale parse — a changed
 * file, or a different compiler, misses — and a run over an unchanged tree
 * parses nothing twice (the language library alone is most of the cost).
 */
const parsedSources = new Map<string, { ts: TsModule; settings: string; text: string; sf: import('typescript').SourceFile }>();
const PARSED_SOURCES_MAX = 4000;

/** The compiler options the program is built under: the project's tsconfig module resolution, with emit, ambient types and the DOM library left out. */
function checkerOptions(ts: TsModule, projectRoot: string): import('typescript').CompilerOptions {
  let options: import('typescript').CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
  };
  const configFile = path.join(projectRoot, 'tsconfig.json');
  if (isFile(configFile)) {
    try {
      const read = ts.readConfigFile(configFile, ts.sys.readFile);
      if (!read.error && read.config) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, projectRoot, undefined, configFile);
        options = { ...parsed.options };
      }
    } catch {
      // an unreadable tsconfig falls back to the defaults above
    }
  }
  return {
    ...options,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    types: [],
    lib: ['lib.es2022.d.ts'],
    noLib: false,
    declaration: false,
    declarationMap: false,
    composite: false,
    incremental: false,
    tsBuildInfoFile: undefined,
    maxNodeModuleJsDepth: 0,
  };
}

/** A class of the project, as implementor resolution reads it. */
interface ProjectClass {
  node: import('typescript').ClassDeclaration;
  path: string;
  name: string;
  members: Set<string>;
}

/**
 * Every call of each given file, resolved. `files` maps each absolute path to
 * its canonical key; the answer is keyed the same way. A program the compiler
 * cannot build answers nothing, and the rules fall back to the shape facts.
 */
function resolveCalls(
  ts: TsModule,
  files: Map<string, string>,
  projectRoot: string,
): CheckerReading {
  const out = new Map<string, ResolvedCallFact[]>();
  if (files.size === 0) return { calls: out, imports: new Map(), kinds: new Map(), routes: new Map(), crossProjectImports: new Map() };
  const options = checkerOptions(ts, projectRoot);
  const settings = JSON.stringify(options);
  const host = ts.createCompilerHost(options, true);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreate) => {
    const text = host.readFile(fileName);
    if (text === undefined) return readSource(fileName, languageVersionOrOptions, onError, shouldCreate);
    const key = `${fileName}|${JSON.stringify(languageVersionOrOptions)}`;
    const cached = parsedSources.get(key);
    if (cached && cached.ts === ts && cached.settings === settings && cached.text === text) return cached.sf;
    const sf = ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    if (parsedSources.size >= PARSED_SOURCES_MAX) parsedSources.clear();
    parsedSources.set(key, { ts, settings, text, sf });
    return sf;
  };
  let program: import('typescript').Program;
  try {
    program = ts.createProgram({ rootNames: [...files.keys()], options, host });
  } catch {
    return { calls: out, imports: new Map(), kinds: new Map(), routes: new Map(), crossProjectImports: new Map() };
  }
  const checker = program.getTypeChecker();
  const assignable = (checker as unknown as {
    isTypeAssignableTo?: (a: import('typescript').Type, b: import('typescript').Type) => boolean;
  }).isTypeAssignableTo;

  const ownKey = (sf: import('typescript').SourceFile): string | undefined => {
    if (program.isSourceFileDefaultLibrary(sf) || program.isSourceFileFromExternalLibrary(sf)) return undefined;
    const absolute = path.resolve(sf.fileName);
    if (!isOwnFile(projectRoot, absolute)) return undefined;
    return pathKey(path.relative(projectRoot, absolute));
  };

  // ---- the project's classes, read once: what an interface lands on ----
  let classes: ProjectClass[] | undefined;
  const projectClasses = (): ProjectClass[] => {
    if (classes) return classes;
    const found: ProjectClass[] = [];
    for (const sf of program.getSourceFiles()) {
      const key = ownKey(sf);
      if (!key || sf.isDeclarationFile) continue;
      const visit = (node: import('typescript').Node): void => {
        if (ts.isClassDeclaration(node) && node.name) {
          const members = new Set<string>();
          for (const member of node.members) {
            if (ts.isConstructorDeclaration(member)) {
              for (const p of member.parameters) if (ts.isIdentifier(p.name)) members.add(p.name.text);
              continue;
            }
            const name = nameText(member.name);
            if (name) members.add(name);
          }
          found.push({ node, path: key, name: node.name.text, members });
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    classes = found;
    return found;
  };

  const symbolOf = (node: import('typescript').Node): import('typescript').Symbol | undefined => {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      try {
        symbol = checker.getAliasedSymbol(symbol);
      } catch {
        // keep the alias itself
      }
    }
    return symbol;
  };

  function nameText(name: import('typescript').Node | undefined): string | undefined {
    if (!name) return undefined;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    return undefined;
  }

  /**
   * The project classes realizing a shape: the ones whose implements clause
   * names it when any does — the code then says who realizes it — else every
   * class declaring all its members that the checker finds assignable to it.
   */
  const implementorCache = new Map<import('typescript').Node, ProjectClass[]>();
  const implementorsOf = (shape: import('typescript').InterfaceDeclaration | import('typescript').TypeLiteralNode): ProjectClass[] => {
    const cached = implementorCache.get(shape);
    if (cached) return cached;
    const shapeSymbol = ts.isInterfaceDeclaration(shape) ? symbolOf(shape.name) : undefined;
    let found = shapeSymbol
      ? projectClasses().filter(c => (c.node.heritageClauses ?? []).some(clause =>
        clause.token === ts.SyntaxKind.ImplementsKeyword && clause.types.some(t => symbolOf(t.expression) === shapeSymbol)))
      : [];
    if (found.length === 0) {
      const shapeType = ts.isInterfaceDeclaration(shape) && shapeSymbol
        ? checker.getDeclaredTypeOfSymbol(shapeSymbol) : checker.getTypeAtLocation(shape);
      const wanted = checker.getPropertiesOfType(shapeType).map(p => p.getName());
      const generic = ts.isInterfaceDeclaration(shape) && (shape.typeParameters?.length ?? 0) > 0;
      found = projectClasses().filter(c => {
        if (!wanted.every(name => c.members.has(name))) return false;
        if (generic || !assignable) return true;
        const classSymbol = c.node.name ? symbolOf(c.node.name) : undefined;
        if (!classSymbol) return false;
        try {
          return assignable.call(checker, checker.getDeclaredTypeOfSymbol(classSymbol), shapeType);
        } catch {
          return true;
        }
      });
    }
    implementorCache.set(shape, found);
    return found;
  };

  /** The class, interface, shape or object a member declaration belongs to, by name. */
  const containerOf = (decl: import('typescript').Node): string | undefined => {
    const holder = decl.parent;
    if (!holder) return undefined;
    if ((ts.isClassLike(holder) || ts.isInterfaceDeclaration(holder)) && holder.name) return holder.name.text;
    if (ts.isTypeLiteralNode(holder) && holder.parent && ts.isTypeAliasDeclaration(holder.parent)) return holder.parent.name.text;
    if (ts.isObjectLiteralExpression(holder) && holder.parent && ts.isVariableDeclaration(holder.parent)) return nameText(holder.parent.name);
    return undefined;
  };

  const MEMBER_KINDS = new Set<number>([
    ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.PropertyDeclaration,
    ts.SyntaxKind.PropertySignature, ts.SyntaxKind.FunctionDeclaration, ts.SyntaxKind.PropertyAssignment,
    ts.SyntaxKind.ShorthandPropertyAssignment, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.FunctionExpression,
    ts.SyntaxKind.ArrowFunction,
  ]);

  const targetsOf = (decls: Iterable<import('typescript').Declaration>): CallTargetFact[] => {
    const targets: CallTargetFact[] = [];
    const seen = new Set<string>();
    const add = (target: CallTargetFact): void => {
      const id = `${target.path}|${target.container ?? ''}|${target.member}`;
      if (seen.has(id)) return;
      seen.add(id);
      targets.push(target);
    };
    for (const declared of decls) {
      let decl: import('typescript').Node = declared;
      // A function or arrow expression is named by the slot that holds it.
      if ((ts.isFunctionExpression(decl) || ts.isArrowFunction(decl)) && decl.parent
        && (ts.isPropertyAssignment(decl.parent) || ts.isPropertyDeclaration(decl.parent) || ts.isVariableDeclaration(decl.parent))) {
        decl = decl.parent;
      }
      const key = ownKey(decl.getSourceFile());
      if (!key) continue;
      const member = nameText(ts.getNameOfDeclaration(decl as import('typescript').Declaration));
      if (!member) continue;
      const container = containerOf(decl);
      add({ path: key, ...(container ? { container } : {}), member, via: 'declaration' });
      const holder = decl.parent;
      if (holder && (ts.isInterfaceDeclaration(holder) || ts.isTypeLiteralNode(holder))) {
        for (const c of implementorsOf(holder)) {
          if (c.members.has(member)) add({ path: c.path, container: c.name, member, via: 'implementor' });
        }
      }
    }
    return targets;
  };

  /**
   * The argument of `await (x)` written where `await` is no keyword — outside
   * an async function the parser reads it as a call to a name nothing
   * declares, spelled `await`. What the code means is x, and the receiver is
   * read as x: a broken await must never be what hides a receiver.
   */
  const awaited = (expr: import('typescript').Expression): import('typescript').Expression | undefined => {
    if (!ts.isCallExpression(expr) || expr.arguments.length !== 1) return undefined;
    const callee = expr.expression;
    if (!ts.isIdentifier(callee) || callee.text !== 'await' || checker.getSymbolAtLocation(callee)) return undefined;
    return expr.arguments[0];
  };

  const unwrap = (expr: import('typescript').Expression): import('typescript').Expression => {
    let at = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isAsExpression(at)
        || ts.isSatisfiesExpression(at) || ts.isTypeAssertionExpression(at)) at = at.expression;
      else {
        const inner = awaited(at);
        if (!inner) return at;
        at = inner;
      }
    }
  };

  /** The expression with what changes no type taken off — parentheses, `!`, `satisfies`, a broken await — and every cast kept. */
  const seeThrough = (expr: import('typescript').Expression): import('typescript').Expression => {
    let at = expr;
    for (;;) {
      if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at)) at = at.expression;
      else {
        const inner = awaited(at);
        if (!inner) return at;
        at = inner;
      }
    }
  };

  // A type the CODE made opaque — `any`, `unknown`, a cast to either, an
  // unannotated parameter. Not the checker's own error type: that is what a
  // name from a package this run has no typings for reads as (a response
  // object of an HTTP library, say), which says nothing about the receiver
  // being one of this project's components.
  const isOpaque = (type: import('typescript').Type | undefined): boolean =>
    !!type && (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
    && (type as unknown as { intrinsicName?: string }).intrinsicName !== 'error';

  const isLibraryDecl = (decl: import('typescript').Node | undefined): boolean =>
    !!decl && program.isSourceFileDefaultLibrary(decl.getSourceFile());

  /** The innermost NAMED function-like a node sits in, and the top-level class or object literal it is a member of. */
  const enclosingOf = (node: import('typescript').Node): { name?: string; container?: string } => {
    for (let at: import('typescript').Node | undefined = node.parent; at; at = at.parent) {
      let name: string | undefined;
      let holder: import('typescript').Node | undefined = at.parent;
      if (ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isGetAccessorDeclaration(at) || ts.isSetAccessorDeclaration(at)) {
        name = nameText(at.name);
      } else if (ts.isConstructorDeclaration(at)) {
        name = 'constructor';
      } else if ((ts.isFunctionExpression(at) || ts.isArrowFunction(at)) && at.parent
        && (ts.isVariableDeclaration(at.parent) || ts.isPropertyAssignment(at.parent) || ts.isPropertyDeclaration(at.parent))) {
        name = nameText(at.parent.name);
        holder = at.parent.parent;
      }
      if (name === undefined) continue;
      let container: string | undefined;
      if (holder && ts.isClassLike(holder) && holder.name) container = holder.name.text;
      else if (holder && ts.isObjectLiteralExpression(holder) && holder.parent && ts.isVariableDeclaration(holder.parent)) container = nameText(holder.parent.name);
      return { name, ...(container ? { container } : {}) };
    }
    return {};
  };

  const resolveOne = (call: import('typescript').CallExpression): ResolvedCallFact | undefined => {
    let callee = unwrap(call.expression);
    // `f.call(t, …)`, `f.apply(t, …)` and `f.bind(t)(…)` invoke f itself.
    let viaFunctionMethod = false;
    if (ts.isCallExpression(callee)) {
      const inner = unwrap(callee.expression);
      if (ts.isPropertyAccessExpression(inner) && inner.name.text === 'bind'
        && isLibraryDecl(checker.getResolvedSignature(callee)?.declaration)) {
        callee = unwrap(inner.expression);
        viaFunctionMethod = true;
      }
    }
    if (!viaFunctionMethod && ts.isPropertyAccessExpression(callee) && (callee.name.text === 'call' || callee.name.text === 'apply')
      && isLibraryDecl(checker.getResolvedSignature(call)?.declaration)) {
      callee = unwrap(callee.expression);
      viaFunctionMethod = true;
    }
    let nameNode: import('typescript').Node | undefined;
    let receiver: import('typescript').Expression | undefined;
    if (ts.isPropertyAccessExpression(callee)) {
      nameNode = callee.name;
      receiver = callee.expression;
    } else if (ts.isElementAccessExpression(callee)) {
      nameNode = callee.argumentExpression;
      receiver = callee.expression;
    } else if (ts.isIdentifier(callee)) {
      nameNode = callee;
    } else if (callee.kind === ts.SyntaxKind.SuperKeyword || callee.kind === ts.SyntaxKind.ImportKeyword) {
      return undefined;
    }

    const decls = new Set<import('typescript').Declaration>();
    if (viaFunctionMethod) {
      for (const signature of checker.getTypeAtLocation(callee).getCallSignatures()) {
        if (signature.declaration && !ts.isJSDocSignature(signature.declaration)) decls.add(signature.declaration);
      }
    } else {
      const signature = checker.getResolvedSignature(call);
      if (signature?.declaration && !ts.isJSDocSignature(signature.declaration)) decls.add(signature.declaration);
    }
    const symbol = nameNode ? symbolOf(nameNode) : undefined;
    for (const decl of symbol?.declarations ?? []) if (MEMBER_KINDS.has(decl.kind)) decls.add(decl);

    const targets = targetsOf(decls);
    // A computed key that names no single member — a template, a
    // concatenation, a string-typed variable, a `keyof T` union — and a member
    // read off a type the code CAST to an index signature both leave the call
    // landing on no single declaration of this project, and the cast or the
    // key is what made it so. A key the checker types as ONE literal names
    // its member by that literal's value, never by the variable's own name.
    const elementKey = ts.isElementAccessExpression(callee) ? keyName(callee.argumentExpression) : undefined;
    const computedKey = ts.isElementAccessExpression(callee) && elementKey === undefined && !symbolKey(callee.argumentExpression);
    const indexCast = receiver !== undefined && castToIndex(receiver);
    const fact: ResolvedCallFact = {
      name: targets.find(t => t.via === 'declaration')?.member
        ?? (ts.isElementAccessExpression(callee) ? (elementKey ?? '') : nameText(nameNode)) ?? '',
      written: callee.getText().replace(/\s+/g, ' ').slice(0, 80),
      targets,
    };
    const where = enclosingOf(call);
    if (where.name !== undefined) fact.enclosing = where.name;
    if (where.container !== undefined) fact.enclosingContainer = where.container;
    const opaque = decls.size === 0
      && (isOpaque(checker.getTypeAtLocation(callee))
        || (receiver !== undefined && (isOpaque(checker.getTypeAtLocation(receiver)) || rootOpaque(receiver))));
    // A member read off a receiver TYPED by an index signature that names no
    // property of that name lands on no declaration — the table the code
    // built is a value this analysis cannot name, exactly as a cast to one is.
    const indexed = receiver !== undefined && targets.length === 0 && readsIndexOnly(receiver, fact.name);
    // Where the receiver was one of this project's classes before any cast,
    // a computed key on it is unresolved whatever the checker made of the
    // call: a key that names no single member names none of its writes
    // either, so neither a landing nor its absence clears it.
    const original = receiver !== undefined && (opaque || computedKey || indexCast || indexed) ? receiversOf(receiver, fact.name) : [];
    if (opaque || (targets.length === 0 && (computedKey || indexCast || indexed)) || (computedKey && original.length > 0)) {
      fact.unresolved = true;
      if (original.length > 0) fact.receivers = original;
    }
    // Every landing a member of a shape no project class realizes: a port
    // nothing written implements — what its landings name is the port alone.
    if (!fact.unresolved && targets.length > 0 && targets.every(t => t.via === 'declaration')) {
      const own = [...decls].filter(d => ownKey(d.getSourceFile()) !== undefined);
      if (own.length > 0 && own.every(d => !!d.parent && (ts.isInterfaceDeclaration(d.parent) || ts.isTypeLiteralNode(d.parent)))) fact.port = true;
    }
    return fact;
  };

  /**
   * Whether a receiver chain is opaque at any link, read the way the code
   * means it: `(this as any).store` is any because `this as any` is, which
   * the checker says itself — except where a broken await stands in the
   * chain and the checker answers its own error type for everything past it.
   */
  function rootOpaque(receiver: import('typescript').Expression): boolean {
    for (let at: import('typescript').Expression = receiver, depth = 0; depth < 16; depth++) {
      const plain = seeThrough(at);
      if (isOpaque(checker.getTypeAtLocation(plain))) return true;
      if (ts.isPropertyAccessExpression(plain) || ts.isElementAccessExpression(plain)) at = plain.expression;
      else return false;
    }
    return false;
  }

  /** Whether a receiver's type, nullability aside, answers a member only through an index signature: no property of that name, and an index to read it through. */
  function readsIndexOnly(receiver: import('typescript').Expression, name: string): boolean {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    if (checker.getIndexInfosOfType(type).length === 0) return false;
    return name === '' || !checker.getPropertyOfType(type, name);
  }

  /**
   * Where a receiver's ORIGINAL type lands (classesOf over the receiver with
   * every cast taken off), and, when that lands nowhere and the receiver is a
   * name bound once by a const declaration, where its initializer lands — so
   * `const s: Record<…> = store as any; s[k]()` is read as the store it was.
   */
  function receiversOf(receiver: import('typescript').Expression, member: string, depth = 0): CallTargetFact[] {
    const at = unwrap(receiver);
    const found = classesOf(at, member);
    if (found.length > 0 || depth >= 4 || !ts.isIdentifier(at)) return found;
    const declaration = symbolOf(at)?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer
      || (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) === 0) return found;
    return receiversOf(declaration.initializer, member, depth + 1);
  }

  /**
   * The one member an element-access key names: a string or number literal's
   * text, or the value of the ONE literal the checker types the key
   * expression as (`const name = 'record'; o[name]`). Undefined for a key
   * that names no single member — a template, a concatenation, a
   * string-typed variable, a union of keys.
   */
  function keyName(key: import('typescript').Expression): string | undefined {
    if (ts.isStringLiteralLike(key) || ts.isNumericLiteral(key)) return key.text;
    const type = checker.getTypeAtLocation(key);
    if (type.isStringLiteral() || type.isNumberLiteral()) return String(type.value);
    return undefined;
  }

  /** Whether an element-access key is one unique symbol (`o[Symbol.iterator]`): one member, though it has no name to give. */
  function symbolKey(key: import('typescript').Expression): boolean {
    return (checker.getTypeAtLocation(key).flags & ts.TypeFlags.UniqueESSymbol) !== 0;
  }

  /**
   * A member read by element access in a VALUE position — taken, not
   * invoked on the spot (the callee of a call is resolveOne's) — on a
   * receiver whose ORIGINAL type, every cast taken off, is one of this
   * project's classes or a shape they realize, when what the access reads is
   * no declaration the checker can name: its key names no single member
   * (`this.store[k]` with k a `keyof` union, a template, a concatenation),
   * or a literal key is read off a receiver cast to any, unknown or an index
   * signature. Recorded unresolved, under the literal's name or none, with
   * the classes the receiver was — so a rule fails it closed against that
   * class's writes however the value is invoked later (`f.call(store, …)`).
   */
  const computedAccessOf = (node: import('typescript').ElementAccessExpression): ResolvedCallFact | undefined => {
    let at: import('typescript').Node = node;
    while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isNonNullExpression(at.parent)
      || ts.isSatisfiesExpression(at.parent) || ts.isTypeAssertionExpression(at.parent))) at = at.parent;
    if (at.parent && ts.isCallExpression(at.parent) && at.parent.expression === at) return undefined;
    if (symbolKey(node.argumentExpression)) return undefined;
    const name = keyName(node.argumentExpression);
    const where = enclosingOf(node);
    const placed = (fact: ResolvedCallFact): ResolvedCallFact => {
      if (where.name !== undefined) fact.enclosing = where.name;
      if (where.container !== undefined) fact.enclosingContainer = where.container;
      return fact;
    };
    if (name !== undefined) {
      // A literal key names its member on the receiver as written: a method
      // taken that way is a plain reference (a `const` key variable is no
      // member of its own, so referenceOf could not name it), and a data
      // field is no use of a function at all.
      const member = checker.getPropertyOfType(checker.getTypeAtLocation(node.expression), name);
      if (member) {
        const targets = targetsOf((member.declarations ?? []).filter(d => FUNCTION_DECLS.has(d.kind) && !ts.isVariableDeclaration(d)));
        if (targets.length === 0 || !isValuePosition(node)) return undefined;
        return placed({ name: targets.find(t => t.via === 'declaration')?.member ?? name, written: node.getText().replace(/\s+/g, ' ').slice(0, 80), targets, reference: true });
      }
    }
    const receiver = unwrap(node.expression);
    // A receiver with no member of its own (an index-signature table, an
    // empty shape) was never a component: every class would "realize" it.
    if (checker.getPropertiesOfType(checker.getNonNullableType(checker.getTypeAtLocation(receiver))).length === 0) return undefined;
    const receivers = receiversOf(receiver, name ?? '');
    if (receivers.length === 0) return undefined;
    return placed({
      name: name ?? '',
      written: node.getText().replace(/\s+/g, ' ').slice(0, 80),
      targets: [],
      reference: true,
      unresolved: true,
      receivers,
    });
  };

  /** Whether an expression, as written, is cast (as, an assertion) to a type with an index signature, any or unknown. */
  function castToIndex(expr: import('typescript').Expression): boolean {
    for (let at = expr; ;) {
      if (ts.isAsExpression(at) || ts.isTypeAssertionExpression(at)) {
        const type = checker.getTypeAtLocation(at);
        if (isOpaque(type) || checker.getIndexInfosOfType(type).length > 0) return true;
        at = at.expression;
      } else if (ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at) || ts.isSatisfiesExpression(at)) {
        at = at.expression;
      } else {
        const inner = awaited(at);
        if (!inner) return false;
        at = inner;
      }
    }
  }

  /** The project classes an expression's type is, or that realize the interface or shape it is — each as a target under `member`. */
  function classesOf(expr: import('typescript').Expression, member: string): CallTargetFact[] {
    const out: CallTargetFact[] = [];
    const seen = new Set<string>();
    const add = (target: CallTargetFact): void => {
      const id = `${target.path}|${target.container ?? ''}`;
      if (!seen.has(id)) { seen.add(id); out.push(target); }
    };
    // Nullability set aside: an optional field holds the class it is typed by.
    const type = checker.getNonNullableType(checker.getTypeAtLocation(expr));
    for (const part of type.isUnionOrIntersection() ? type.types : [type]) {
      const symbol = part.getSymbol() ?? part.aliasSymbol;
      for (const decl of symbol?.declarations ?? []) {
        const key = ownKey(decl.getSourceFile());
        if (!key) continue;
        if (ts.isClassLike(decl) && decl.name) add({ path: key, container: decl.name.text, member, via: 'declaration' });
        else if (ts.isInterfaceDeclaration(decl) || ts.isTypeLiteralNode(decl)) {
          const realizing = implementorsOf(decl);
          for (const c of realizing) add({ path: c.path, container: c.name, member, via: 'implementor' });
          // A shape no class realizes — the type of a component a factory
          // builds — is the shape itself, in the file that declares it: where
          // a call through it lands, and so where its receiver was.
          const shapeName = ts.isInterfaceDeclaration(decl) ? decl.name.text
            : decl.parent && ts.isTypeAliasDeclaration(decl.parent) ? decl.parent.name.text : undefined;
          if (realizing.length === 0 && shapeName && checker.getPropertiesOfType(part).length > 0) {
            add({ path: key, container: shapeName, member, via: 'declaration' });
          }
        }
      }
    }
    return out;
  }

  const FUNCTION_DECLS = new Set<number>([
    ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.MethodSignature, ts.SyntaxKind.FunctionDeclaration,
    ts.SyntaxKind.PropertyDeclaration, ts.SyntaxKind.PropertySignature, ts.SyntaxKind.PropertyAssignment,
    ts.SyntaxKind.VariableDeclaration, ts.SyntaxKind.GetAccessor,
  ]);

  /**
   * Whether an expression sits where the code takes its VALUE rather than
   * invoking it: an argument, an initializer, an assigned or returned value,
   * an array element, the receiver of `.bind`, or of `.call`/`.apply` that
   * is not invoked on the spot (an invoked one is a call resolveOne reads).
   */
  const isValuePosition = (node: import('typescript').Node): boolean => {
    let at = node;
    while (at.parent && (ts.isParenthesizedExpression(at.parent) || ts.isAsExpression(at.parent) || ts.isNonNullExpression(at.parent)
      || ts.isSatisfiesExpression(at.parent) || ts.isTypeAssertionExpression(at.parent))) at = at.parent;
    const parent = at.parent;
    if (!parent) return false;
    if ((ts.isCallExpression(parent) || ts.isNewExpression(parent)) && parent.expression !== at) return true;
    if (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return parent.initializer === at;
    if (ts.isArrayLiteralExpression(parent) || ts.isReturnStatement(parent) || ts.isSpreadElement(parent)) return true;
    if (ts.isArrowFunction(parent)) return parent.body === at;
    if (ts.isBinaryExpression(parent)) return parent.right === at && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === at) {
      const via = parent.name.text;
      if (via === 'bind') return true;
      if (via === 'call' || via === 'apply') return !(parent.parent && ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
    }
    return false;
  };

  /** A function or method of this project the code takes as a value here, recorded as a reference; undefined for anything else. */
  const referenceOf = (node: import('typescript').Expression): ResolvedCallFact | undefined => {
    if (!isValuePosition(node)) return undefined;
    const nameNode = ts.isPropertyAccessExpression(node) ? node.name
      : ts.isElementAccessExpression(node) ? node.argumentExpression : node;
    const symbol = symbolOf(nameNode);
    const decls = (symbol?.declarations ?? []).filter(d => FUNCTION_DECLS.has(d.kind));
    if (decls.length === 0) return undefined;
    // Only a callable value: a field holding data is no reference to a function.
    if (checker.getTypeAtLocation(node).getCallSignatures().length === 0) return undefined;
    const callable = decls.map(d => (ts.isVariableDeclaration(d) && d.initializer
      && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) ? d.initializer : d));
    const targets = targetsOf(callable.filter(d => !ts.isVariableDeclaration(d)) as import('typescript').Declaration[]);
    if (targets.length === 0) return undefined;
    const fact: ResolvedCallFact = {
      name: targets.find(t => t.via === 'declaration')?.member ?? nameText(nameNode) ?? '',
      written: node.getText().replace(/\s+/g, ' ').slice(0, 80),
      targets,
      reference: true,
    };
    const where = enclosingOf(node);
    if (where.name !== undefined) fact.enclosing = where.name;
    if (where.container !== undefined) fact.enclosingContainer = where.container;
    return fact;
  };

  const resolveFile = (sf: import('typescript').SourceFile): ResolvedCallFact[] => {
    const calls: ResolvedCallFact[] = [];
    const visit = (node: import('typescript').Node): void => {
      try {
        if (ts.isCallExpression(node)) {
          const fact = resolveOne(node);
          if (fact) calls.push(fact);
        } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isIdentifier(node)) {
          const fact = referenceOf(node) ?? (ts.isElementAccessExpression(node) ? computedAccessOf(node) : undefined);
          if (fact) calls.push(fact);
        }
      } catch {
        // one call the checker cannot answer never costs the file its others
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return calls;
  };

  for (const [absolute, key] of files) {
    const sf = program.getSourceFile(absolute);
    if (!sf) continue;
    out.set(key, resolveFile(sf));
  }

  // The project's own files the resolved calls reach that are no root of the
  // run — a helper module no spec names — resolved too, transitively, so a
  // rule can read unowned code as part of whoever calls into it.
  const pending = [...out.values()];
  while (pending.length) {
    for (const call of pending.pop()!) {
      for (const target of call.targets) {
        if (out.has(target.path)) continue;
        const sf = program.getSourceFile(path.resolve(projectRoot, target.path));
        if (!sf || sf.isDeclarationFile || !ownKey(sf)) { out.set(target.path, []); continue; }
        const calls = resolveFile(sf);
        out.set(target.path, calls);
        pending.push(calls);
      }
    }
  }

  // What every own file of the program imports — the roots and every project
  // file they pull in, a helper module no spec names included: the project
  // files each import resolves to, and the bare package specifiers it names.
  // What lets a rule read an unowned module's imports as its importer's.
  const imports = new Map<string, ModuleImports>();
  const cache = ts.createModuleResolutionCache(projectRoot, f => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), options);
  for (const sf of program.getSourceFiles()) {
    const key = ownKey(sf);
    if (!key || sf.isDeclarationFile) continue;
    const specifiers: string[] = [];
    const visit = (node: import('typescript').Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
        && ts.isStringLiteralLike(node.moduleReference.expression)) {
        specifiers.push(node.moduleReference.expression.text);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])
        && ((ts.isIdentifier(node.expression) && node.expression.text === 'require') || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
        specifiers.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    const entry: ModuleImports = { packages: [], files: [] };
    for (const specifier of new Set(specifiers)) {
      let resolved: string | undefined;
      try {
        const answer = ts.resolveModuleName(specifier, sf.fileName, options, host, cache).resolvedModule;
        if (answer && !answer.isExternalLibraryImport && !/\.d\.[cm]?ts$/.test(answer.resolvedFileName)) {
          const absolute = path.resolve(answer.resolvedFileName);
          if (isOwnFile(projectRoot, absolute)) resolved = pathKey(path.relative(projectRoot, absolute));
        }
      } catch {
        // an unresolvable specifier is simply not a project file
      }
      if (resolved !== undefined) {
        if (!entry.files.includes(resolved)) entry.files.push(resolved);
      } else if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) {
        entry.packages.push(specifier);
      }
    }
    imports.set(key, entry);
  }

  // ---- what the checker settles beyond the calls, for each root file ----
  const kinds = new Map<string, Array<Array<ParameterKind | undefined>>>();
  const routes = new Map<string, Map<string, RouteFact[]>>();
  const crossProjectImports = new Map<string, CrossProjectImportFact[]>();
  const literalOf: LiteralOf = (node) => {
    const type = checker.getTypeAtLocation(node);
    return type.isStringLiteral() ? type.value : undefined;
  };
  const initializerOf: InitializerOf = (node) => {
    const declaration = symbolOf(ts.isPropertyAccessExpression(node) ? node.name : node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
      && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) return declaration.initializer;
    if (declaration && ts.isPropertyAssignment(declaration)) return declaration.initializer;
    return undefined;
  };
  const root = path.resolve(projectRoot);
  const homes = new Map<string, string | null>();
  /** The nearest folder at or above `dir` holding a .wai/project.yaml — the project a file belongs to. */
  const homeOf = (dir: string): string | null => {
    const known = homes.get(dir);
    if (known !== undefined) return known;
    let home: string | null;
    if (isFile(path.join(dir, '.wai', 'project.yaml'))) home = dir;
    else {
      const parent = path.dirname(dir);
      home = parent === dir ? null : homeOf(parent);
    }
    homes.set(dir, home);
    return home;
  };
  for (const [absolute, key] of files) {
    const sf = program.getSourceFile(absolute);
    if (!sf) continue;
    const fileKinds: Array<Array<ParameterKind | undefined>> = [];
    const fileRoutes = new Map<string, Map<string, RouteFact>>();
    const visit = (node: import('typescript').Node): void => {
      const name = namedFunctionNameOf(ts, node);
      const body = (node as { body?: import('typescript').Node }).body;
      if (name !== undefined && body) {
        fileKinds.push(((node as import('typescript').SignatureDeclarationBase).parameters ?? []).map((parameter) => {
          try {
            return kindOf(checker.getTypeAtLocation(parameter)) ?? platformKind(parameter.type);
          } catch {
            return undefined;
          }
        }));
        // Both idioms compare a request's method — a guard `<request>.method`,
        // a table entry's `method` / `verb` key matched against it — so a
        // function that never says so is no router, and is not re-read.
        if (/method|verb/i.test(body.getText(sf))) try {
          const read = readRoutes(ts, node as import('typescript').Node & { body?: import('typescript').Node }, initializerOf, literalOf);
          if (read.size > 0) {
            const known = fileRoutes.get(name) ?? new Map<string, RouteFact>();
            for (const [routeKeyText, route] of read) known.set(routeKeyText, route);
            fileRoutes.set(name, known);
          }
        } catch {
          // a router the checker cannot settle keeps the syntactic reading
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    kinds.set(key, fileKinds);
    routes.set(key, new Map([...fileRoutes].map(([name, read]) => [name, [...read.values()]])));

    // An import from ANOTHER project's source that resolves to nothing.
    const broken: CrossProjectImportFact[] = [];
    for (const statement of sf.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      let resolved: string | undefined;
      try {
        resolved = ts.resolveModuleName(specifier, sf.fileName, options, host, cache).resolvedModule?.resolvedFileName;
      } catch {
        resolved = undefined;
      }
      const target = resolved !== undefined ? path.resolve(resolved)
        : specifier.startsWith('.') ? path.resolve(path.dirname(sf.fileName), specifier) : undefined;
      if (target === undefined || target.split(path.sep).includes('node_modules')) continue;
      const home = homeOf(path.dirname(target));
      if (home === null || home === root) continue;
      const project = pathKey(path.relative(root, home)) || '.';
      const line = sf.getLineAndCharacterOfPosition(statement.getStart(sf)).line + 1;
      const clause = statement.importClause;
      if (resolved === undefined) {
        broken.push({ specifier, project, line, typeOnly: clause?.isTypeOnly ?? false });
        continue;
      }
      const unresolvedName = (node: import('typescript').Identifier): boolean => {
        try {
          const symbol = checker.getSymbolAtLocation(node);
          const aliased = symbol && (symbol.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(symbol) : symbol;
          return !aliased || !aliased.declarations || aliased.declarations.length === 0;
        } catch {
          return false;
        }
      };
      if (clause?.name && unresolvedName(clause.name)) {
        broken.push({ specifier, name: 'default', project, line, typeOnly: clause.isTypeOnly });
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          if (!unresolvedName(element.name)) continue;
          broken.push({ specifier, name: (element.propertyName ?? element.name).text, project, line, typeOnly: clause.isTypeOnly || element.isTypeOnly });
        }
      }
    }
    if (broken.length > 0) crossProjectImports.set(key, broken);
  }
  return { calls: out, imports, kinds, routes, crossProjectImports };

  /**
   * The kind of a parameter annotated with a platform class the run's fixed
   * ES library leaves out (a URL, a fetch Request, node:http's
   * IncomingMessage…), where the checker could not resolve it: an object,
   * whatever environment defines it. Only an annotation naming such a class
   * outright, and only where nothing in the program declares that name.
   */
  function platformKind(annotation: import('typescript').TypeNode | undefined): ParameterKind | undefined {
    if (!annotation || !ts.isTypeReferenceNode(annotation)) return undefined;
    const name = ts.isIdentifier(annotation.typeName) ? annotation.typeName.text : annotation.typeName.right.text;
    if (!PLATFORM_OBJECT_TYPES.has(name)) return undefined;
    const type = checker.getTypeAtLocation(annotation);
    return (type as unknown as { intrinsicName?: string }).intrinsicName === 'error' ? 'object' : undefined;
  }

  /**
   * The kind of value a type is, nullability set aside: string, number,
   * boolean, list, object or function — undefined where no one kind settles
   * (any, unknown, the checker's error type, a union of kinds).
   */
  function kindOf(type: import('typescript').Type): ParameterKind | undefined {
    const at = checker.getNonNullableType(type);
    if ((at.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Void)) !== 0) return undefined;
    if ((at.flags & ts.TypeFlags.BooleanLike) !== 0) return 'boolean';
    if (at.isUnion()) {
      const settled = new Set(at.types.map(kindOf));
      return settled.size === 1 ? [...settled][0] : undefined;
    }
    if (at.isIntersection()) {
      const primitive = new Set(at.types.map(kindOf).filter(k => k !== undefined && k !== 'object'));
      return primitive.size === 1 ? [...primitive][0] : primitive.size === 0 ? 'object' : undefined;
    }
    if ((at.flags & ts.TypeFlags.StringLike) !== 0) return 'string';
    if ((at.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.BigIntLike)) !== 0) return 'number';
    if ((at.flags & (ts.TypeFlags.Object | ts.TypeFlags.NonPrimitive)) !== 0) {
      const lists = checker as unknown as { isArrayType?: (t: import('typescript').Type) => boolean; isTupleType?: (t: import('typescript').Type) => boolean };
      if (lists.isArrayType?.(at) || lists.isTupleType?.(at)) return 'list';
      if (at.getCallSignatures().length > 0 && at.getProperties().length === 0) return 'function';
      return 'object';
    }
    return undefined;
  }
}

/** The platform classes the run's fixed ES library leaves out, each an object wherever it is defined. */
const PLATFORM_OBJECT_TYPES = new Set([
  'URL', 'URLSearchParams', 'Request', 'Response', 'Headers', 'FormData', 'Blob', 'ReadableStream', 'WritableStream',
  'AbortSignal', 'IncomingMessage', 'ServerResponse', 'Http2ServerRequest', 'Http2ServerResponse', 'Socket', 'Buffer',
]);

/** What the type checker settles over the run's files beyond their calls. */
interface CheckerReading {
  calls: Map<string, ResolvedCallFact[]>;
  imports: Map<string, ModuleImports>;
  /** Per root file, the parameter kinds of each named function-like with a body, in the order the walk meets them. */
  kinds: Map<string, Array<Array<ParameterKind | undefined>>>;
  /** Per root file, the routes each named function-like serves, read with the checker settling every value. */
  routes: Map<string, Map<string, RouteFact[]>>;
  /** Per root file, its imports from another project's source that resolve to nothing. */
  crossProjectImports: Map<string, CrossProjectImportFact[]>;
}

/**
 * Build the pure source-code model for a validation run: one SourceFileFacts
 * per distinct source path across the given implementations — each
 * implementation's sourcePath, each method's own sourcePath, and each simPath
 * — then each type's own and per-method sourcePath, then every file the
 * source-root walk found; each resolved and containment-checked within
 * projectRoot and analyzed at the best available grade. Deterministic over
 * file contents; a single file's analysis failure degrades that file to the
 * generic scan, never aborts the run.
 */
export function buildCodeModel(
  implementations: ImplementationSpec[],
  types: TypeSpec[],
  projectRoot: string,
  sourceRoots: readonly string[] = [],
  exclude: readonly string[] = [],
): CodeModel {
  const files: SourceFileFacts[] = [];
  const seen = new Set<string>();
  const exactCache = new Map<string, ExactFacts | null>();
  // One compiler for the whole run, resolved fresh: what it depends on may
  // have changed since the last run of a long-lived process.
  const ts = resolveTypeScript(projectRoot);
  /** The files read at exact grade, by absolute path: the type checker's roots. */
  const checkerRoots = new Map<string, string>();
  /** Each exact-grade file's parameter lists in walk order: what the checker's kinds are joined onto. */
  const paramSitesAt = new Map<string, ParameterSite[]>();
  const rootFiles = walkDeclaredRoots(sourceRoots, exclude, projectRoot);
  // The repository's own packages, read once: what lets a package specifier
  // naming one of them resolve like a relative import.
  const localPackages = readLocalPackages(projectRoot);
  const packages: Record<string, string> = {};
  for (const [specifier, absolute] of localPackages) packages[specifier] = pathKey(path.relative(projectRoot, absolute));

  // Every source file an implementation names (its own path, then each
  // method's), plus the simPath: the integration-conformance rule needs sim
  // import graphs to prove the harness wires the real modules. Then every file
  // a TYPE names, which claims code on the same terms. Then the walked root
  // files, which no spec names yet and which the unclaimed-source rule judges
  // — analyzed like any other file, since proving one a re-export barrel means
  // reading it. Same containment, same tiers, same dedup (N:1).
  const declaredPaths: string[] = [];
  for (const impl of implementations) {
    declaredPaths.push(...implementationSourceFiles(impl));
    if (impl.simPath) declaredPaths.push(impl.simPath);
  }
  for (const type of types) declaredPaths.push(...typeSourceFiles(type));
  declaredPaths.push(...rootFiles);
  for (const declared of declaredPaths) {
    const sourcePath = pathKey(declared);
    if (seen.has(sourcePath)) continue;
    seen.add(sourcePath);

    const empty = { declaredNames: [], anchoredNames: [], exportedNames: [], imports: [], reexports: [] };

    // Containment: sourcePaths are project-relative — absolute paths and
    // parent-directory escapes never touch the filesystem (mirrors the
    // projectPath chaining containment rule).
    if (path.isAbsolute(sourcePath) || path.normalize(sourcePath).split(path.sep)[0] === '..') {
      files.push({ path: sourcePath, status: 'escaped', ...empty });
      continue;
    }

    const absolute = path.resolve(projectRoot, sourcePath);
    if (path.relative(projectRoot, absolute).startsWith('..')) {
      files.push({ path: sourcePath, status: 'escaped', ...empty });
      continue;
    }

    let buffer: Buffer;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile()) {
        files.push({ path: sourcePath, status: 'missing', ...empty });
        continue;
      }
      buffer = fs.readFileSync(absolute);
    } catch {
      files.push({ path: sourcePath, status: 'missing', ...empty });
      continue;
    }

    if (looksBinary(buffer)) {
      files.push({ path: sourcePath, status: 'unreadable', ...empty });
      continue;
    }

    const text = buffer.toString('utf8');
    const language = languageOfSourcePath(sourcePath);

    let analyzed: Omit<SourceFileFacts, 'path' | 'status' | 'language'>;
    if (language === 'typescript' || language === 'javascript') {
      if (ts) {
        try {
          const facts = walkExact(ts, text, absolute);
          chaseReexports(ts, facts, absolute, projectRoot, new Set([absolute]), exactCache, localPackages);
          analyzed = {
            analysisGrade: 'exact',
            declaredNames: [...facts.declared],
            anchoredNames: [...facts.anchors],
            exportedNames: [...facts.exported],
            imports: [...facts.imports],
            reexports: [...facts.reexports],
            reexportBindings: [
              ...facts.namedReexports.map(({ exported, local, from }) => ({ exported, local, from })),
              ...facts.starExports.map((from) => ({ exported: '*', local: '*', from })),
            ],
            exportAliases: facts.exportAliases.map(alias => ({ ...alias })),
            returnTypes: Object.fromEntries(
              [...facts.returnTypes].filter((entry): entry is [string, string] => entry[1] !== null),
            ),
            functionComplexity: Object.fromEntries(facts.complexity),
            functionCallSites: Object.fromEntries([...facts.calls].map(([k, v]) => [k, [...v.values()]])),
            functionBodies: Object.fromEntries(facts.bodies),
            importBindings: Object.fromEntries(facts.importBindings),
            typeOnlyBindings: Object.fromEntries(facts.typeOnlyBindings),
            fieldTypes: Object.fromEntries([...facts.fieldTypes].map(([k, v]) => [k, [...v]])),
            localTypes: Object.fromEntries([...facts.localTypes].map(([k, v]) => [k, [...v]])),
            memberTypes: Object.fromEntries([...facts.memberTypes].map(([k, v]) => [k, [...v]])),
            aliasTargets: Object.fromEntries(facts.aliasTargets),
            ...(facts.implementsClauses.size > 0 ? { implementsClauses: Object.fromEntries(facts.implementsClauses) } : {}),
            typeShapes: Object.fromEntries(facts.typeShapes),
            functionParams: Object.fromEntries(facts.functionParams),
            functionRoutes: Object.fromEntries([...facts.functionRoutes].map(([k, v]) => [k, [...v.values()]])),
            asyncFunctions: [...facts.asyncFunctions],
            enumValues: Object.fromEntries(facts.enumValues),
            aliasTypes: Object.fromEntries(facts.aliasTypes),
            topLevelMutableBindings: [...facts.mutableBindings],
            reexportOnly: facts.reexportOnly,
          };
          checkerRoots.set(absolute, sourcePath);
          paramSitesAt.set(sourcePath, facts.paramSites);
        } catch {
          analyzed = analyzeGeneric(text);
        }
      } else {
        analyzed = analyzeWithPatterns(text, LANGUAGE_PATTERNS[language]);
      }
    } else if (language && LANGUAGE_PATTERNS[language] && text.length <= PATTERN_ANALYSIS_MAX_BYTES) {
      analyzed = analyzeWithPatterns(text, LANGUAGE_PATTERNS[language]);
    } else {
      // unknown language, or a file too large for regex tables (generated/
      // minified) — the linear word scan is the safe floor either way
      analyzed = analyzeGeneric(text);
    }

    files.push({ path: sourcePath, status: 'analyzed', language, ...analyzed });
  }

  // Every call of every exact-grade file, resolved by the type checker. A
  // program that cannot be built leaves the facts without resolved calls, and
  // the rules read the shape facts as they always have.
  if (ts && checkerRoots.size > 0) {
    let resolved = new Map<string, ResolvedCallFact[]>();
    let imports = new Map<string, ModuleImports>();
    let reading: CheckerReading | undefined;
    try {
      reading = resolveCalls(ts, checkerRoots, projectRoot);
      ({ calls: resolved, imports } = reading);
    } catch {
      resolved = new Map();
      imports = new Map();
    }
    const held = new Set<string>();
    for (const facts of files) {
      const calls = resolved.get(facts.path);
      if (calls) {
        facts.resolvedCalls = calls;
        held.add(facts.path);
      }
      if (!reading) continue;
      // The kinds the checker settles, joined onto the parameter lists the
      // walk read in the same order — and only where both read the same
      // functions, the same number of parameters each.
      const sites = paramSitesAt.get(facts.path);
      const settled = reading.kinds.get(facts.path);
      if (sites && settled && sites.length === settled.length) {
        sites.forEach((site, index) => {
          if (settled[index].length !== site.params.length) return;
          site.params.forEach((param, at) => { const kind = settled[index][at]; if (kind) param.kind = kind; });
        });
      }
      // The routes re-read with the checker settling every compared value.
      const read = reading.routes.get(facts.path);
      if (read && read.size > 0) facts.functionRoutes = { ...(facts.functionRoutes ?? {}), ...Object.fromEntries(read) };
      const broken = reading.crossProjectImports.get(facts.path);
      if (broken) facts.crossProjectImports = broken;
    }
    const reached: Record<string, ResolvedCallFact[]> = {};
    for (const [key, calls] of resolved) if (!held.has(key) && !seen.has(key)) reached[key] = calls;
    const model: CodeModel = { files, projectRoot, rootFiles, packages };
    if (Object.keys(reached).length > 0) model.reachedCalls = reached;
    if (imports.size > 0) model.reachedImports = Object.fromEntries(imports);
    return model;
  }

  return { files, projectRoot, rootFiles, packages };
}

// ---------------------------------------------------------------------------
// The tests a write just invalidated (isource_analysis_adapter.findTestsReferencing)
//
// Measured on this tree before it was designed, over 264 test files and 695
// distinct method symbols, because "search by symbol" is a claim about an
// instrument and it was worth checking which one:
//
//   imported symbol   0 hits: 382   1-3: 265   11+: 18   worst 111
//   bare name         0 hits: 262   1-3: 317   11+: 59   worst 187
//
// An import is a BINDING, not a coincidence, and its worst cases are functions
// genuinely used everywhere. But it misses 382 methods outright, because a test
// driving a method through a portal never imports it. The bare name finds those
// and then drowns: `project` matched 187 of 264 files, `status` 122, `read` 112.
//
// So two lists, labelled, never one merged — and a name that matches more than
// a tenth of the suite has its mention list WITHHELD with a reason, because
// saying the name is too common is an answer and printing 187 paths is not.
//
// And a binding binds ONE module (F75). Removing eleven thin adapter methods
// named like core's functions once listed ~250 test files, every one of them
// importing CORE's function of that name — and not one tested the adapter. So
// when the method's realizing file is known, an import counts only when its
// specifier resolves to that file, or to a module that re-exports the name
// from there (aliased or not, through any chain of re-exports). A test that
// binds the name to another module is talking about that module's function:
// it is neither an import of this method nor a mention of it.
// ---------------------------------------------------------------------------

/**
 * The tests that encode one method a write just changed or deleted
 * (tests_to_revisit).
 *
 * Two lists rather than one because the two ways of finding them fail in
 * OPPOSITE directions, and merging them would hide which is which — see the
 * measurement above.
 */
export interface TestsToRevisit {
  /** The contract method the write changed or deleted. */
  method: string;
  /** The code-level name searched for: the method's `symbol` when it declares one, else its name. */
  symbol: string;
  /**
   * Test files that IMPORT that symbol — from the method's own source file, or
   * from a module re-exporting it from there, when that file is known. The
   * high-confidence list.
   */
  imported: string[];
  /**
   * Test files that name the symbol without importing it — usually a test
   * driving the method through a portal or a helper. A file that binds the
   * name to ANOTHER module is not here: the name in it is that module's.
   * Empty when `indiscriminate` is true.
   */
  mentioned: string[];
  /**
   * True when the bare name matched more than a tenth of the walked test files,
   * so mentioning it carries no signal and `mentioned` was withheld.
   */
  indiscriminate: boolean;
}

/** One name a test file binds by importing it: what the module publishes, what the file writes, and where from. */
interface ImportedBinding {
  /** The name the module publishes; `*` for a namespace import, `default` for a default one. */
  exported: string;
  /** The name this file writes. */
  local: string;
  /** The module specifier, as written. */
  specifier: string;
}

/** What one walked test file says about the names a search is looking for. */
interface TestFileNames {
  /** Canonical project-relative path, as the answer names it. */
  path: string;
  /** Names bound by a named-import clause — both sides of a rename. */
  imports: Set<string>;
  /** Every import binding with the module it came from, for the module-resolved search. */
  bindings: ImportedBinding[];
  /** Every word-boundary identifier in the file: the universal floor, exactly as the generic grade reads one. */
  words: Set<string>;
}

/**
 * Static import statements (`import … from 'm'`) and destructured dynamic ones
 * (`const { a } = await import('m')`), each captured as its binding clause and
 * its specifier. A side-effect import binds nothing and matches neither. A
 * static import opens a statement — at the start of a line or after a `;` —
 * so a fixture's source text quoted inside a test is not read as one of the
 * test's own imports.
 */
const IMPORT_FROM_RE = /(?:^|;)[ \t]*import\s+(?!\()([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\{([^{}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/g;
const IDENTIFIER_ONLY_RE = /^[A-Za-z_$][\w$]*$/;

/** The bindings one import clause makes: its default, its namespace, and each named element with both sides of a rename. */
function clauseBindings(clause: string, specifier: string): ImportedBinding[] {
  const out: ImportedBinding[] = [];
  const body = clause.replace(/^\s*type\s+/, '');
  const named = /\{([^}]*)\}/.exec(body);
  if (named) {
    for (const piece of named[1].split(',')) {
      const sides = piece.replace(/^\s*type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
      const exported = sides[0];
      const local = sides[1] ?? exported;
      if (IDENTIFIER_ONLY_RE.test(exported) && IDENTIFIER_ONLY_RE.test(local)) out.push({ exported, local, specifier });
    }
  }
  const namespace = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(body);
  if (namespace) out.push({ exported: '*', local: namespace[1], specifier });
  const head = body.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+[A-Za-z_$][\w$]*/, '');
  const defaulted = /^\s*([A-Za-z_$][\w$]*)/.exec(head);
  if (defaulted) out.push({ exported: 'default', local: defaulted[1], specifier });
  return out;
}

/**
 * The declared test roots, walked and read. An unreadable or binary file is
 * SKIPPED rather than fatal: naming the tests must never be the thing that
 * fails a write.
 */
function readTestFiles(testRoots: readonly string[], projectRoot: string): TestFileNames[] {
  const scanned: TestFileNames[] = [];
  for (const key of walkDeclaredRoots(testRoots, [], projectRoot)) {
    let text: string;
    try {
      const buffer = fs.readFileSync(path.resolve(projectRoot, key));
      if (looksBinary(buffer)) continue;
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    const imports = new Set<string>();
    for (const m of text.matchAll(NAMED_IMPORT_BINDINGS_RE)) {
      for (const name of boundNames(m[1] ?? '', false)) imports.add(name);
    }
    const code = stripComments(text, JS_PATTERNS);
    const bindings: ImportedBinding[] = [];
    for (const m of code.matchAll(IMPORT_FROM_RE)) bindings.push(...clauseBindings(m[1], m[2]));
    // A destructuring renames with a colon where an import clause says `as`.
    for (const m of code.matchAll(DYNAMIC_IMPORT_RE)) bindings.push(...clauseBindings(`{${m[1].replace(/:/g, ' as ')}}`, m[2]));
    const words = new Set<string>();
    for (const m of text.matchAll(IDENTIFIER_RE)) words.add(m[0]);
    scanned.push({ path: key, imports, bindings, words });
  }
  return scanned;
}

/** The re-exports one module makes: each named one with both sides of a rename, and each star. */
interface ModuleReexports {
  named: { exported: string; local: string; specifier: string }[];
  stars: string[];
}

const NAMED_REEXPORT_RE = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const STAR_REEXPORT_RE = /\bexport\s+\*\s+from\s*['"]([^'"]+)['"]/g;

/** A module's re-exports, read once per search and never fatal: a module that cannot be read re-exports nothing. */
function reexportReader(): (file: string) => ModuleReexports {
  const cache = new Map<string, ModuleReexports>();
  return (file) => {
    const cached = cache.get(file);
    if (cached) return cached;
    const found: ModuleReexports = { named: [], stars: [] };
    try {
      const code = stripComments(fs.readFileSync(file, 'utf8'), JS_PATTERNS);
      for (const m of code.matchAll(NAMED_REEXPORT_RE)) {
        for (const piece of m[1].split(',')) {
          const sides = piece.replace(/^\s*type\s+/, '').split(/\s+as\s+/).map((s) => s.trim());
          if (!IDENTIFIER_ONLY_RE.test(sides[0] ?? '')) continue;
          found.named.push({ local: sides[0], exported: sides[1] ?? sides[0], specifier: m[2] });
        }
      }
      for (const m of code.matchAll(STAR_REEXPORT_RE)) found.stars.push(m[1]);
    } catch {
      // unreadable: re-exports nothing
    }
    cache.set(file, found);
    return found;
  };
}

/**
 * Whether the name a test imports from `module` IS the method realized in
 * `target` under `symbol`: the module is that file and the name is the symbol,
 * or the module re-exports the name — named, aliased or not, or through a star
 * — from a module for which the same holds. Relative specifiers only: a package
 * specifier names no file of this project. A cycle ends the walk.
 */
function publishesFrom(
  module: string,
  name: string,
  target: string,
  symbol: string,
  readReexports: (file: string) => ModuleReexports,
  visited: Set<string> = new Set(),
): boolean {
  if (path.resolve(module) === target && name === symbol) return true;
  const key = `${module}#${name}`;
  if (visited.has(key)) return false;
  visited.add(key);
  const reexports = readReexports(module);
  for (const re of reexports.named) {
    if (re.exported !== name) continue;
    const next = resolveRelativeModule(module, re.specifier);
    if (next && publishesFrom(next, re.local, target, symbol, readReexports, visited)) return true;
  }
  // A star re-export never republishes a module's default.
  if (name === 'default') return false;
  for (const specifier of reexports.stars) {
    const next = resolveRelativeModule(module, specifier);
    if (next && publishesFrom(next, name, target, symbol, readReexports, visited)) return true;
  }
  return false;
}

/** One method's search: the name looked for, and the absolute files realizing it when a spec names them. */
interface MethodSearch {
  method: string;
  symbol: string;
  /** Empty when no spec names a realizing file, which falls back to the name alone. */
  files: string[];
}

/**
 * Find the tests that encode a given set of methods.
 *
 * Walks the declared test roots on the SOURCE walk's own containment terms —
 * an absolute or parent-escaping root is refused rather than walked,
 * node_modules and dot-directories are skipped — and searches each method's
 * `symbol`, or its name when it declares none.
 *
 * A method that carries its realizing `sourcePath` (resolved by the caller: the
 * method's own, else its implementation's) is searched by MODULE. A file is
 * `imported` only when one of its bindings comes from that file under the
 * symbol, or from a module that re-exports it from there — aliased or not,
 * through any chain of re-exports, so a test importing it under a republished
 * alias counts though it never spells the symbol — or when it imports such a
 * module as a namespace and names the symbol. A file that binds the name to any OTHER module is dropped
 * altogether: the name in it is that module's function. A method that carries
 * no sourcePath is searched by name alone, as it always was. A method given
 * more than once (a contract realized in several files) is one entry, imported
 * from any of them.
 *
 * A file that merely names the symbol is `mentioned`, unless the name matched
 * more than a tenth of the walked files, in which case the mention list is
 * withheld and `indiscriminate` says why.
 *
 * Declaring no test roots walks nothing and answers empty, which is what keeps
 * this opt-in. A method nothing references contributes no entry: the answer is
 * the tests to revisit, and an entry naming none is not one.
 */
export function findTestsReferencing(
  methods: ReadonlyArray<Pick<MethodImplementation, 'name' | 'symbol' | 'sourcePath'>>,
  projectRoot: string,
  testRoots: readonly string[],
): TestsToRevisit[] {
  // Steps 1-2: resolve and walk the declared roots, and read what they hold.
  const scanned = readTestFiles(testRoots, projectRoot);
  if (scanned.length === 0) return [];

  // A tenth of the WALKED suite, so the threshold scales with the project
  // rather than with a number somebody once picked for theirs.
  const indiscriminateAbove = scanned.length / 10;

  // Step 3: the name to search for, and the files realizing it — one search
  // per method, however many realizations named it.
  const searches: MethodSearch[] = [];
  for (const method of methods) {
    const symbol = method.symbol ?? method.name;
    let search = searches.find((s) => s.method === method.name && s.symbol === symbol);
    if (!search) {
      search = { method: method.name, symbol, files: [] };
      searches.push(search);
    }
    const file = method.sourcePath ? path.resolve(projectRoot, method.sourcePath) : undefined;
    if (file && !search.files.includes(file)) search.files.push(file);
  }

  const readReexports = reexportReader();
  const found: TestsToRevisit[] = [];
  for (const { method, symbol, files } of searches) {
    // Step 4: the binding and the bare mention, kept apart — and a binding
    // counted only when it comes from the method's own module.
    const imported: string[] = [];
    const mentioned: string[] = [];
    for (const test of scanned) {
      if (files.length === 0) {
        if (test.imports.has(symbol)) imported.push(test.path);
        else if (test.words.has(symbol)) mentioned.push(test.path);
        continue;
      }
      const testFile = path.resolve(projectRoot, test.path);
      const fromMethod = (binding: ImportedBinding, name: string): boolean => {
        const module = resolveRelativeModule(testFile, binding.specifier);
        return module !== null && files.some((target) => publishesFrom(module, name, target, symbol, readReexports));
      };
      // Any binding whose module publishes the method under the name it
      // imports — so a test that imports it through an ALIASING re-export
      // counts even though it never spells the symbol.
      const naming = test.bindings.filter((b) => b.exported === symbol || b.local === symbol);
      if (test.bindings.some((b) => b.exported !== '*' && fromMethod(b, b.exported))
        || (test.words.has(symbol) && test.bindings.some((b) => b.exported === '*' && fromMethod(b, symbol)))) {
        imported.push(test.path);
      } else if (naming.length === 0 && test.words.has(symbol)) {
        // A file binding the name to another module is dropped: it is that
        // module's function, never a mention of this method.
        mentioned.push(test.path);
      }
    }
    // Steps 5-6: a name like `project` or `status` matches most of the suite,
    // and a list that long is not an answer.
    const indiscriminate = mentioned.length > indiscriminateAbove;
    if (imported.length === 0 && mentioned.length === 0) continue;
    // Step 7.
    found.push({
      method,
      symbol,
      imported,
      mentioned: indiscriminate ? [] : mentioned,
      indiscriminate,
    });
  }
  return found;
}
