import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import {
  implementationSourceFiles,
  routerLinkage,
  typeSourceFiles,
  pathKey,
  type CallSiteFact,
  type CallTargetFact,
  type ClassMemberFact,
  type CodeReading,
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
  resolveImport,
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
/**
 * Text a router's body cannot be without: a request's `method` or a table's
 * `verb` compared, or an HTTP verb written out (an object keyed `VERB /path`).
 * A body that holds none is no router, and is not read as one.
 */
const ROUTER_TEXT = /[Mm][Ee][Tt][Hh][Oo][Dd]|[Vv][Ee][Rr][Bb]|\b(?:GET|POST|PUT|PATCH|DELETE)\b/;
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
  return verb && route ? { verb, segments: route.segments, exactLength: route.exactLength, fullPath: true, table: true } : undefined;
}

/**
 * The routes a ROUTE TABLE states: an array of object literals each pairing a
 * method with a path pattern, or an object keyed `VERB /path`. Every entry
 * must settle, or the table answers nothing at all — a table read in part
 * would accuse the endpoints of the entries it skipped.
 */
function tableRoutes(ts: TsModule, value: TsExpression, initializerOf: InitializerOf, literalOf: LiteralOf | undefined, depth = 0): RouteFact[] {
  if (depth > SETTLE_DEPTH) return [];
  const at = bareExpression(ts, value);
  const out: RouteFact[] = [];
  // A spread entry is the table it names, followed through the constants (and,
  // with a checker, any module's): `[...ingestRoutes, ...statsRoutes]` is one
  // table. One that settles on no table leaves the whole table unread.
  const spread = (expression: TsExpression): RouteFact[] | undefined => {
    const named = bareExpression(ts, expression);
    if (!ts.isIdentifier(named) && !ts.isPropertyAccessExpression(named)) return undefined;
    const initializer = initializerOf(named);
    if (!initializer) return undefined;
    const inner = tableRoutes(ts, initializer, initializerOf, literalOf, depth + 1);
    return inner.length > 0 ? inner : undefined;
  };
  if (ts.isArrayLiteralExpression(at)) {
    for (const element of at.elements) {
      if (ts.isSpreadElement(element)) {
        const routes = spread(element.expression);
        if (!routes) return [];
        out.push(...routes);
        continue;
      }
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
      if (ts.isSpreadAssignment(property)) {
        const routes = spread(property.expression);
        if (!routes) return [];
        out.push(...routes);
        continue;
      }
      // A key written as a template literal or a concatenation over the
      // file's constants (`[\`POST ${PREFIX}/orders\`]`) settles like any
      // other compared value.
      const key = !property.name ? undefined
        : ts.isComputedPropertyName(property.name) ? settleString(ts, property.name.expression, initializerOf, literalOf)
          : propertyKeyText(ts, property.name);
      const match = key ? /^([A-Za-z]+)\s+(\/\S*)$/.exec(key) : null;
      if (!match || !HTTP_VERBS.has(match[1].toUpperCase())) return [];
      const segments = templateSegments(match[2]);
      if (!segments) return [];
      out.push({ verb: match[1].toUpperCase(), segments, exactLength: true, fullPath: true, table: true });
    }
  }
  return out;
}

/**
 * The ONE prefix a function strips off a path anywhere in its body —
 * `path.slice(BASE.length)`, `.substring(…)`, `.substr(…)`, `.replace(BASE,
 * '')` — as the text it settles on, starting with `/`. Undefined where it
 * strips none, or several, or one that does not settle. What a route table
 * read beside it, written under the prefix, is read below.
 */
function strippedAnywhere(
  ts: TsModule,
  body: TsNode,
  initializerOf: InitializerOf,
  literalOf: LiteralOf | undefined,
): string | undefined {
  const UNSETTLED = '\u0000';
  const prefixes = new Set<string>();
  const strip = (node: TsNode): void => {
    if (namedFunctionNameOf(ts, node) !== undefined && node !== body) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const [first, second] = node.arguments;
      if ((name === 'slice' || name === 'substring' || name === 'substr') && node.arguments.length === 1
        && first && ts.isPropertyAccessExpression(first) && first.name.text === 'length') {
        prefixes.add(settleString(ts, first.expression, initializerOf, literalOf) ?? UNSETTLED);
      } else if (name === 'replace' && first && second && !ts.isRegularExpressionLiteral(first)
        && settleString(ts, second, initializerOf, literalOf) === '') {
        prefixes.add(settleString(ts, first, initializerOf, literalOf) ?? UNSETTLED);
      }
    }
    ts.forEachChild(node, strip);
  };
  strip(body);
  if (prefixes.size !== 1) return undefined;
  const [prefix] = [...prefixes];
  if (!prefix.startsWith('/') || prefix.length < 2) return undefined;
  return prefix.split('/').filter(Boolean).every(segment => LITERAL_SEGMENT.test(segment)) ? prefix : undefined;
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
  type RoutePattern = { segments: string[]; exactLength: boolean };
  type RouteConstraint = { verb: string } | { length: number } | { index: number; literal: string } | { pattern: RoutePattern };
  const isPathRef = (expression: TsExpression): boolean => {
    const at = bareExpression(ts, expression);
    const name = ts.isIdentifier(at) ? at.text : ts.isPropertyAccessExpression(at) ? at.name.text : undefined;
    return name === 'path' || name === 'pathname';
  };
  // The regular expression a guard tests the path with: a literal, or a const holding one.
  const regexOf = (expression: TsExpression): RoutePattern | undefined => {
    let at = bareExpression(ts, expression);
    if ((ts.isIdentifier(at) || ts.isPropertyAccessExpression(at))) {
      const initializer = initializerOf(at);
      if (initializer) at = bareExpression(ts, initializer);
    }
    return ts.isRegularExpressionLiteral(at) ? regexRoute(at.text) : undefined;
  };
  // A whole-path match: `/re/.test(path)`, `/re/.exec(path)` or `path.match(/re/)`.
  const matchOf = (expression: TsExpression): RoutePattern | undefined => {
    const at = bareExpression(ts, expression);
    if (!ts.isCallExpression(at) || !ts.isPropertyAccessExpression(at.expression) || at.arguments.length !== 1) return undefined;
    const name = at.expression.name.text;
    const [argument] = at.arguments;
    if ((name === 'test' || name === 'exec') && isPathRef(argument)) return regexOf(at.expression.expression);
    if (name === 'match' && isPathRef(at.expression.expression)) return regexOf(argument);
    return undefined;
  };
  const isNothing = (expression: TsExpression): boolean => {
    const at = bareExpression(ts, expression);
    return at.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(at) && at.text === 'undefined');
  };
  const constraintsOf = (conjunct: TsExpression, depth = 0): RouteConstraint[] => {
    const at = bareExpression(ts, conjunct);
    const matched = matchOf(at);
    if (matched) return [{ pattern: matched }];
    // A match held in a const and tested after (`const m = … ? /re/.exec(path) : null; if (m)`):
    // the const's own conditions guard it too.
    if (ts.isIdentifier(at) && depth < SETTLE_DEPTH) {
      const initializer = initializerOf(at);
      if (!initializer) return [];
      const held = bareExpression(ts, initializer);
      if (ts.isConditionalExpression(held) && isNothing(held.whenFalse)) {
        const inner = constraintsOf(held.whenTrue, depth + 1);
        return inner.some(constraint => 'pattern' in constraint)
          ? [...conjunctsOf(held.condition).flatMap(condition => constraintsOf(condition, depth + 1)), ...inner]
          : [];
      }
      return constraintsOf(held, depth + 1);
    }
    if (ts.isBinaryExpression(at) && (at.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || at.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken)) {
      if (isNothing(at.right)) return constraintsOf(at.left, depth + 1);
      if (isNothing(at.left)) return constraintsOf(at.right, depth + 1);
      return [];
    }
    if (!ts.isBinaryExpression(at) || at.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return [];
    const sides: Array<[TsExpression, TsExpression]> = [[at.left, at.right], [at.right, at.left]];
    for (const [left, right] of sides) {
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'method') {
        const verb = settle(right);
        if (verb !== undefined) return [{ verb }];
      }
      if (ts.isPropertyAccessExpression(left) && left.name.text === 'length' && isPartsRef(left.expression) && ts.isNumericLiteral(right)) {
        return [{ length: Number(right.text) }];
      }
      if (ts.isElementAccessExpression(left) && isPartsRef(left.expression) && ts.isNumericLiteral(left.argumentExpression)) {
        const literal = settle(right);
        if (literal !== undefined) return [{ index: Number(left.argumentExpression.text), literal }];
      }
      if (isPathRef(left)) {
        const text = settle(right);
        const segments = text !== undefined ? templateSegments(text) : undefined;
        if (segments) return [{ pattern: { segments, exactLength: true } }];
      }
    }
    return [];
  };
  const prefix = strippedPrefix(ts, fn.body, initializerOf, literalOf);
  // A whole path is compared after whatever prefix the body strips off it, folded in front.
  const pathPrefix = (strippedAnywhere(ts, fn.body, initializerOf, literalOf) ?? '').split('/').filter(Boolean);
  const routeOf = (conjuncts: TsExpression[]): RouteFact | undefined => {
    let verb: string | undefined;
    let length: number | undefined;
    let pattern: RoutePattern | undefined;
    const fixed = new Map<number, string>();
    for (const conjunct of conjuncts) {
      for (const constraint of constraintsOf(conjunct)) {
        if ('verb' in constraint) verb = constraint.verb;
        else if ('length' in constraint) length = constraint.length;
        else if ('pattern' in constraint) pattern = constraint.pattern;
        else fixed.set(constraint.index, constraint.literal);
      }
    }
    if (verb === undefined) return undefined;
    if (pattern) {
      const already = pathPrefix.length > 0 && pathPrefix.every((segment, index) => pattern.segments[index] === segment);
      const segments = already ? pattern.segments : [...pathPrefix, ...pattern.segments];
      return { verb, segments, exactLength: pattern.exactLength, fullPath: true };
    }
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
  // And the tables it states in place, bound to no name: a returned array or
  // object literal (`return [ … ]`), or an arrow's expression body.
  const inPlace = (value: TsExpression): void => {
    for (const route of tableRoutes(ts, value, initializerOf, literalOf)) routes.set(routeKey(route), route);
  };
  if (!ts.isBlock(fn.body)) inPlace(fn.body as TsExpression);
  const returns = (node: TsNode): void => {
    if (namedFunctionNameOf(ts, node) !== undefined) return;
    if (ts.isReturnStatement(node) && node.expression) inPlace(node.expression);
    ts.forEachChild(node, returns);
  };
  returns(fn.body);
  return routes;
}

// ---------------------------------------------------------------------------
// What a body reads off a handle (parameter_fact.reads).
//
// A framework handler realizes a contract parameter by reading it off the
// request it is handed, and real handlers do that in more than one spelling:
// `req.params.id`, `url.searchParams.get('limit')`, `const { id } =
// pathParams(req)`, the body read whole. Every one of them is the same fact —
// the parameter's NAME is read off what the handle carries — so one walk
// follows the handle's value wherever it flows unchanged in what it names: a
// member chain, a destructuring at any depth, a local it is copied into, a
// URL or a parsed body built from it, and a helper it is handed to (whose own
// reads off it count, and whose result carries what the handle did). Only
// helpers a resolver hands back are entered: the syntactic walk knows the
// functions of its own file; the type checker any project file no
// implementation claims — another component's code is that component's.
// ---------------------------------------------------------------------------

/** Where a helper the handle is passed to takes it: the helper's body, and the name (or the destructured keys) it binds the argument to. */
interface HelperParam {
  body: TsNode;
  name?: string;
  keys?: string[];
}

/** The helper a call hands the handle to at an argument index, where it is one to enter. */
type HelperOf = (call: import('typescript').CallExpression, index: number) => HelperParam | undefined;

/** How many names one parameter's reads may hold — a bound, not a measurement. */
const READS_CAP = 64;
/** How many locals and helpers deep a handle's value is followed. */
const READS_DEPTH = 3;
/** The constructors and parsers a handle's value passes through keeping the names it carries: a URL, its query, a parsed body. */
const FLOW_CALLS = new Set(['URL', 'URLSearchParams', 'parse']);

/** The property names an object destructuring binds, at every depth. */
function bindingKeys(ts: TsModule, pattern: import('typescript').BindingName, out: Set<string>): void {
  if (!ts.isObjectBindingPattern(pattern)) return;
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) out.add(key.text);
    if (!ts.isIdentifier(element.name)) bindingKeys(ts, element.name, out);
  }
}

/** The name a callee is called by: `URL` in `new URL(…)`, `parse` in `JSON.parse(…)`. */
function calleeName(ts: TsModule, expression: TsExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

/** A parameter of a helper, as the walk binds the argument it is handed: its name, or the keys its destructuring takes. */
function helperParam(ts: TsModule, fn: TsNode, index: number): HelperParam | undefined {
  const body = (fn as { body?: TsNode }).body;
  const parameter = ((fn as import('typescript').SignatureDeclarationBase).parameters ?? [])[index];
  if (!body || !parameter || parameter.dotDotDotToken) return undefined;
  if (ts.isIdentifier(parameter.name)) return { body, name: parameter.name.text };
  const keys = new Set<string>();
  bindingKeys(ts, parameter.name, keys);
  return keys.size > 0 ? { body, keys: [...keys] } : undefined;
}

/**
 * The names a body reads off `name` (see the section above), added to `out`:
 * the member names and literal keys of every chain off it, the literal a
 * method of the chain is called with, the keys a destructuring binds, and the
 * same off a local its value flows into or a helper it is handed to.
 */
function handleReads(
  ts: TsModule,
  body: TsNode,
  name: string,
  helperOf: HelperOf | undefined,
  out: Set<string> = new Set<string>(),
  depth = 0,
  seen: Set<string> = new Set<string>(),
): Set<string> {
  const visitKey = `${body.getSourceFile().fileName}:${body.pos}:${body.end}:${name}`;
  if (seen.has(visitKey)) return out;
  seen.add(visitKey);
  const deeper = (scope: TsNode, local: string): void => {
    if (depth < READS_DEPTH) handleReads(ts, scope, local, helperOf, out, depth + 1, seen);
  };
  const follow = (node: TsNode): void => {
    let at: TsNode = node;
    for (;;) {
      const up = at.parent;
      if (!up || out.size >= READS_CAP) return;
      if (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up) || ts.isAsExpression(up)
        || ts.isTypeAssertionExpression(up) || ts.isAwaitExpression(up)
        || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(up))) { at = up; continue; }
      if (ts.isBinaryExpression(up) && (up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || up.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { at = up; continue; }
      if (ts.isPropertyAccessExpression(up) && up.expression === at) { out.add(up.name.text); at = up; continue; }
      if (ts.isElementAccessExpression(up) && up.expression === at) {
        if (!ts.isStringLiteralLike(up.argumentExpression)) return;
        out.add(up.argumentExpression.text);
        at = up;
        continue;
      }
      // A method of the chain: the key it is asked for (`.get('limit')`), or —
      // asked for nothing — what it answers carries what the chain did
      // (`await request.json()`).
      if (ts.isCallExpression(up) && up.expression === at) {
        const [first] = up.arguments;
        if (first && ts.isStringLiteralLike(first)) { out.add(first.text); return; }
        if (up.arguments.length > 0) return;
        at = up;
        continue;
      }
      // Handed on as an argument: into a helper the resolver knows, or through
      // a constructor or parser that keeps the names (`new URL(req.url, base)`).
      if ((ts.isCallExpression(up) || ts.isNewExpression(up)) && up.expression !== at) {
        const args: readonly TsExpression[] = up.arguments ?? [];
        const index = args.indexOf(at as TsExpression);
        if (index < 0) return;
        const helper = ts.isCallExpression(up) && depth < READS_DEPTH ? helperOf?.(up, index) : undefined;
        if (helper) {
          for (const key of helper.keys ?? []) out.add(key);
          if (helper.name) deeper(helper.body, helper.name);
          at = up;
          continue;
        }
        const callee = calleeName(ts, up.expression);
        if (callee !== undefined && FLOW_CALLS.has(callee)) { at = up; continue; }
        return;
      }
      if (ts.isVariableDeclaration(up) && up.initializer === at) {
        if (ts.isIdentifier(up.name)) {
          if (up.name.text !== name) deeper(body, up.name.text);
        } else {
          bindingKeys(ts, up.name, out);
        }
      }
      return;
    }
  };
  const visit = (node: TsNode): void => {
    if (out.size >= READS_CAP) return;
    if (ts.isIdentifier(node) && node.text === name) {
      const parent = node.parent;
      const declares = !!parent && (
        (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isPropertyAssignment(parent) && parent.name === node)
        || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node));
      if (!declares) follow(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

/**
 * The helpers a file's own code may hand a handle to, by the name a call
 * spells: its top-level functions (a declaration, or a const bound to a
 * function), and a class's own methods called on `this`.
 */
function sameFileHelpers(ts: TsModule, sf: import('typescript').SourceFile): HelperOf {
  const functions = new Map<string, TsNode>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) functions.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer && bareExpression(ts, declaration.initializer);
        if (ts.isIdentifier(declaration.name) && initializer && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))) {
          functions.set(declaration.name.text, initializer);
        }
      }
    }
  }
  return (call, index) => {
    const callee = call.expression;
    if (ts.isIdentifier(callee)) {
      const fn = functions.get(callee.text);
      return fn ? helperParam(ts, fn, index) : undefined;
    }
    if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
      let owner: TsNode | undefined = call.parent;
      while (owner && !ts.isClassLike(owner)) owner = owner.parent;
      const member = owner && ts.isClassLike(owner)
        ? owner.members.find(m => ts.isMethodDeclaration(m) && m.name && propertyKeyText(ts, m.name) === callee.name.text)
        : undefined;
      return member ? helperParam(ts, member, index) : undefined;
    }
    return undefined;
  };
}

/** The handle names a request is handed by — the parameters whose reads realize a contract's parameters, and the only ones the checker re-reads. */
const REQUEST_HANDLE_NAMES = new Set(['req', 'request', 'ctx', 'context', 'event', 'url']);

// ---------------------------------------------------------------------------
// A request handed WHOLE to a function (parameter_fact.handedWhole).
//
// Plain node:http has no `req.body`: a handler reads the body through a
// helper of its own — `const cart = await readJsonBody(req)` — and the record
// the contract declares IS that result. What is read is a fact of the code
// alone, never of the helper: the request goes in as the call's first
// argument, the result is bound to a local, and the local is then used WHOLE
// — passed on, returned, placed into an object or a list, assigned — rather
// than only picked apart. Any function counts, an imported one included, since
// a body parser is as often a package's as the file's own; what does not count
// is a call into a COLLABORATOR (`this.orders.place(req)`, `deps.parse(req)`):
// handing the request to the domain is not reading its body. The result only
// destructured (`const { id } = pathParams(req)`) or only read for members
// (`params.id`) is a bag of named reads, which `reads` already says, never the
// body whole.
// ---------------------------------------------------------------------------

/** What a value stands as once parentheses, casts, a non-null assertion, `satisfies` and `await` are seen through — and a `??` / `||` fallback it is the left side of. */
function valueSite(ts: TsModule, node: TsNode): TsNode {
  let at = node;
  for (;;) {
    const up = at.parent;
    if (up && (ts.isParenthesizedExpression(up) || ts.isNonNullExpression(up) || ts.isAsExpression(up)
      || ts.isTypeAssertionExpression(up) || ts.isAwaitExpression(up)
      || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(up)))) { at = up; continue; }
    if (up && ts.isBinaryExpression(up) && up.left === at && (up.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || up.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { at = up; continue; }
    return at;
  }
}

/** Whether an identifier occurrence names a binding or a member rather than reading the value it holds. */
function namesNotReads(ts: TsModule, node: import('typescript').Identifier): boolean {
  const parent = node.parent;
  return !!parent && (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || ((ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent)) && parent.name === node)
    || (ts.isBindingElement(parent) && parent.propertyName === node));
}

/**
 * Whether the local `name` is used WHOLE somewhere in `scope`: passed as an
 * argument, returned, placed into an object or a list (or spread there),
 * assigned, or copied into another local that is — never a use that only
 * picks it apart (`local.items`) or tests it (`if (!local)`).
 */
function usedWhole(ts: TsModule, scope: TsNode, name: string, depth = 0): boolean {
  let whole = false;
  const visit = (node: TsNode): void => {
    if (whole) return;
    if (ts.isIdentifier(node) && node.text === name && !namesNotReads(ts, node)) {
      const at = valueSite(ts, node);
      const up = at.parent;
      if (up && (ts.isCallExpression(up) || ts.isNewExpression(up)) && up.expression !== at
        && ((up.arguments ?? []) as readonly TsNode[]).includes(at)) whole = true;
      else if (up && (ts.isReturnStatement(up) || (ts.isArrowFunction(up) && up.body === at)
        || ts.isShorthandPropertyAssignment(up) || (ts.isPropertyAssignment(up) && up.initializer === at)
        || ts.isArrayLiteralExpression(up) || ts.isSpreadElement(up) || ts.isSpreadAssignment(up))) whole = true;
      else if (up && ts.isBinaryExpression(up) && up.right === at && up.operatorToken.kind === ts.SyntaxKind.EqualsToken) whole = true;
      else if (up && ts.isVariableDeclaration(up) && up.initializer === at && ts.isIdentifier(up.name)
        && up.name.text !== name && depth < READS_DEPTH && usedWhole(ts, scope, up.name.text, depth + 1)) whole = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return whole;
}

/**
 * Whether a function's body hands its parameter `name` WHOLE to a function —
 * as the call's first argument — whose result it binds to a local and then
 * uses whole (see the section above). A collaborator's method (a callee
 * reached through `this.<field>` or through another of the function's own
 * parameters) never counts, nor a callee that is itself one of them.
 */
function handsWhole(ts: TsModule, fn: TsNode, body: TsNode, name: string): boolean {
  const own = new Set(((fn as import('typescript').SignatureDeclarationBase).parameters ?? [])
    .flatMap(parameter => (ts.isIdentifier(parameter.name) ? [parameter.name.text] : [])));
  const helper = (callee: TsExpression): boolean => {
    if (ts.isIdentifier(callee)) return !own.has(callee.text);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const target = callee.expression;
    return target.kind === ts.SyntaxKind.ThisKeyword || (ts.isIdentifier(target) && !own.has(target.text));
  };
  let found = false;
  const visit = (node: TsNode): void => {
    if (found) return;
    if (ts.isIdentifier(node) && node.text === name && !namesNotReads(ts, node)) {
      const at = valueSite(ts, node);
      const call = at.parent;
      if (call && ts.isCallExpression(call) && call.expression !== at && call.arguments[0] === at && helper(call.expression)) {
        const result = valueSite(ts, call);
        const bound = result.parent;
        if (bound && ts.isVariableDeclaration(bound) && bound.initializer === result && ts.isIdentifier(bound.name)
          && usedWhole(ts, body, bound.name.text)) found = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return found;
}

/**
 * The member names a body reads DIRECTLY off each of the named parameters —
 * `args.habitId` reads habitId, `args['date']` reads date: the first link of
 * every chain, no flow followed — by parameter name, one walk for them all.
 */
function directMembers(ts: TsModule, body: TsNode, names: ReadonlySet<string>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (name: string, member: string): void => {
    const held = out.get(name) ?? new Set<string>();
    if (held.size < READS_CAP) held.add(member);
    out.set(name, held);
  };
  const visit = (node: TsNode): void => {
    if (ts.isIdentifier(node) && names.has(node.text) && !namesNotReads(ts, node)) {
      const at = valueSite(ts, node);
      const up = at.parent;
      if (up && ts.isPropertyAccessExpression(up) && up.expression === at) add(node.text, up.name.text);
      else if (up && ts.isElementAccessExpression(up) && up.expression === at && ts.isStringLiteralLike(up.argumentExpression)) add(node.text, up.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
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
  /** Runtime `export * as name from` specifiers: a module's whole namespace republished under one name. */
  namespaceReexports: string[];
  /** The `export type * from` specifiers among starExports: they republish types, never code. */
  typeOnlyStars: Set<string>;
  /** The runtime `export * from` specifiers: a specifier written both ways still republishes code. */
  runtimeStars: Set<string>;
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
  /** Value import bindings every reference to which sits in a type position (see SourceFileFacts.typePositionOnlyBindings). */
  typePositionOnlyBindings: Set<string>;
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
  /** The one prefix each named function strips off a path, by name (see SourceFileFacts.routePrefixes). */
  routePrefixes: Map<string, string>;
  /** The names each top-level table spreads, by table name (see SourceFileFacts.tableSpreads). */
  tableSpreads: Map<string, string[]>;
  /**
   * One entry per BODY that completes later — declared `async`, or annotated
   * to return a Promise — under its function's name, in the order the bodies
   * are met: the same per-body count `functionParams` keeps, so a reader can
   * tell every body of a name from some of them.
   */
  asyncFunctions: string[];
  /** The return annotation each body writes, by name, one entry per body (see SourceFileFacts.functionReturns). */
  functionReturns: Map<string, (string | null)[]>;
  /** The members of each top-level named class (see SourceFileFacts.classMembers). */
  classMembers: Map<string, ClassMemberFact[]>;
  /** The top-level named classes the file names outside their own declaration (see SourceFileFacts.classReferences). */
  classReferences: Set<string>;
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

function walkExact(ts: TsModule, sourceText: string, fileName: string, decoratorMetadata = true): ExactFacts {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const declared = new Set<string>();
  const anchors = new Set<string>();
  const exported = new Set<string>();
  const imports = new Set<string>();
  const reexports = new Set<string>();
  const starExports: string[] = [];
  const namedReexports: { exported: string; local: string; from: string }[] = [];
  const namespaceReexports: string[] = [];
  const typeOnlyStars = new Set<string>();
  const runtimeStars = new Set<string>();
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
  const functionReturns = new Map<string, (string | null)[]>();
  const classMembers = new Map<string, ClassMemberFact[]>();
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
  /**
   * What a body reads off one name (handleReads): every chain off it, the
   * keys a destructuring binds, a local or a helper of this file its value
   * flows into — `req.params.code`, `url.searchParams.get('limit')`,
   * `const { code } = pathParams(req)`. Bounded, sorted, deduplicated.
   */
  const helpersHere = sameFileHelpers(ts, sf);
  const readsOff = (body: import('typescript').Node, name: string): string[] =>
    [...handleReads(ts, body, name, helpersHere)].sort();

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
    const named = new Set(parameters.flatMap(parameter => (ts.isIdentifier(parameter.name) && used.has(parameter.name.text) ? [parameter.name.text] : [])));
    const membersOf = body && named.size > 0 ? directMembers(ts, body, named) : new Map<string, Set<string>>();
    return parameters.map((parameter) => {
      const fact: ParameterFact = {
        optional: !!parameter.questionToken || !!parameter.initializer || !!parameter.dotDotDotToken,
      };
      if (ts.isIdentifier(parameter.name)) {
        fact.name = parameter.name.text;
        if (!used.has(fact.name) && !used.has('arguments')) fact.unused = true;
        else if (body) {
          const read = readsOff(body, fact.name);
          if (read.length > 0) fact.reads = read;
          const members = membersOf.get(fact.name);
          if (members && members.size > 0) fact.members = [...members].sort();
          if (REQUEST_HANDLE_NAMES.has(fact.name.replace(/^_+/, '').toLowerCase()) && handsWhole(ts, fn, body, fact.name)) fact.handedWhole = true;
        }
      }
      // A platform transport class named outright — resolved or not — is a
      // handle whatever serves the method hands it, never a domain record.
      if (parameter.type && ts.isTypeReferenceNode(parameter.type)) {
        const named = ts.isIdentifier(parameter.type.typeName) ? parameter.type.typeName.text : parameter.type.typeName.right.text;
        if (TRANSPORT_TYPES.has(named)) fact.transport = true;
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
    // The 1-based line of the call being read (exact grade only); the first
    // writing of a shape keeps its line.
    let callLine: number | undefined;
    const addSite = (site: CallSiteFact): void => {
      const key = siteKey(site);
      const prior = callees.get(key);
      const line = prior?.line ?? callLine;
      callees.set(key, line !== undefined ? { ...site, line } : site);
    };
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
        callLine = sf.getLineAndCharacterOfPosition(
          (ts.isPropertyAccessExpression(callee) ? callee.name : node).getStart(sf),
        ).line + 1;
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
      // The return annotation THIS body writes, as written, one entry per body
      // beside its signature: what a contract's `returns` is compared with.
      const annotatedReturn = (node as unknown as import('typescript').SignatureDeclarationBase).type;
      const returnsHere = functionReturns.get(fnName) ?? [];
      returnsHere.push(annotatedReturn ? annotatedReturn.getText(sf).replace(/\s+/g, ' ').trim() : null);
      functionReturns.set(fnName, returnsHere);
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
      // The class's members as its public surface reads them — top-level
      // named classes only, the ones a component's realization can name.
      if (node.parent && ts.isSourceFile(node.parent) && !classMembers.has(node.name.text)) {
        classMembers.set(node.name.text, node.members.flatMap((member): ClassMemberFact[] => {
          const mods = (member as { modifiers?: readonly import('typescript').ModifierLike[] }).modifiers ?? [];
          const has = (kind: import('typescript').SyntaxKind): boolean => mods.some(m => m.kind === kind);
          if (ts.isConstructorDeclaration(member)) return [{ name: 'constructor', kind: 'constructor', access: 'public' }];
          if (!member.name) return [];
          const computed = ts.isComputedPropertyName(member.name);
          const hashed = ts.isPrivateIdentifier(member.name);
          const name = hashed ? member.name.text : computed ? member.name.getText(sf) : propertyNameText(member.name);
          if (!name) return [];
          let kind: ClassMemberFact['kind'];
          if (ts.isMethodDeclaration(member)) kind = 'method';
          else if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) kind = 'accessor';
          else if (ts.isPropertyDeclaration(member)) {
            let init = member.initializer;
            while (init && (ts.isParenthesizedExpression(init) || ts.isAsExpression(init) || (typeof ts.isSatisfiesExpression === 'function' && ts.isSatisfiesExpression(init)))) init = init.expression;
            kind = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? 'method' : 'property';
          } else return [];
          const access: ClassMemberFact['access'] = hashed ? 'hash'
            : has(ts.SyntaxKind.PrivateKeyword) ? 'private'
              : has(ts.SyntaxKind.ProtectedKeyword) ? 'protected' : 'public';
          return [{
            name, kind, access,
            ...(has(ts.SyntaxKind.StaticKeyword) ? { static: true } : {}),
            ...(has(ts.SyntaxKind.OverrideKeyword) ? { override: true } : {}),
            ...(computed ? { computed: true } : {}),
          }];
        }));
      }
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
        if (node.isTypeOnly) typeOnlyStars.add(spec);
        else runtimeStars.add(spec);
      } else if (node.exportClause && ts.isNamespaceExport(node.exportClause) && spec && !node.isTypeOnly) {
        namespaceReexports.push(spec);
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
  const constants = topLevelConstants(ts, sf);
  const fileValues = fileInitializer(ts, constants);
  const routePrefixes = new Map<string, string>();
  for (const { name, node } of routeBodies) {
    const body = (node as { body?: import('typescript').Node }).body;
    const prefix = body ? strippedAnywhere(ts, body, fileValues, undefined) : undefined;
    if (prefix !== undefined) routePrefixes.set(name, prefix);
    const routes = readRoutes(ts, node as import('typescript').Node & { body?: import('typescript').Node }, fileValues);
    if (routes.size === 0) continue;
    const known = functionRoutes.get(name) ?? new Map<string, RouteFact>();
    for (const [key, route] of routes) known.set(key, route);
    functionRoutes.set(name, known);
  }
  // A route table bound to a top-level const, read in its own right: what a
  // router linkage naming the table rather than a function reads.
  for (const [name, initializer] of constants) {
    if (functionRoutes.has(name)) continue;
    const table = tableRoutes(ts, initializer, fileValues, undefined);
    if (table.length > 0) functionRoutes.set(name, new Map(table.map(route => [routeKey(route), route])));
  }
  // The tables each top-level table spreads, by the name it spells them
  // with (`[...ingestRoutes, ...statsRoutes]`): which table another one
  // dispatches as a part of itself, read whatever the parts settle on.
  const tableSpreads = new Map<string, string[]>();
  const spreadName = (expression: TsExpression): string[] => {
    const bare = bareExpression(ts, expression);
    return ts.isIdentifier(bare) ? [bare.text] : [];
  };
  for (const [name, initializer] of constants) {
    const literal = bareExpression(ts, initializer);
    const parts = ts.isArrayLiteralExpression(literal)
      ? literal.elements.flatMap(element => (ts.isSpreadElement(element) ? spreadName(element.expression) : []))
      : ts.isObjectLiteralExpression(literal)
        ? literal.properties.flatMap(property => (ts.isSpreadAssignment(property) ? spreadName(property.expression) : []))
        : [];
    if (parts.length > 0) tableSpreads.set(name, [...new Set(parts)]);
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

  // A value import binding that the file only ever uses where a type goes —
  // a constructor parameter's annotation, a variable's, an `implements`
  // clause, a `typeof` query — is a type import whatever its spelling, since
  // the compiler erases it. Exact: any reference the walk cannot place in a
  // type position (a `new`, a call, an argument, a heritage `extends`, a
  // re-export) keeps the binding a value one.
  const typePositionOnlyBindings = new Set<string>();
  if (importBindings.size > 0) {
    const used = new Map<string, { type: number; value: number }>();
    for (const [name, fact] of importBindings) if (!fact.namespace) used.set(name, { type: 0, value: 0 });
    // Under decorator metadata (`emitDecoratorMetadata`, what NestJS and
    // Angular dependency injection read), the types of a DECORATED declaration
    // are emitted as runtime values — injection tokens — so such an annotation
    // is a value use, never erased. Matched to the declaration the annotation
    // sits in: a property's type needs the property's own decorator; a
    // constructor parameter's, a decorator on the class or on any constructor
    // parameter; a method parameter's, a decorator on the method or on any of
    // its parameters. A decorator elsewhere in the class emits nothing for it.
    const hasDecorator = (node: import('typescript').Node): boolean =>
      ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0;
    const emittedAsMetadata = (ref: import('typescript').TypeReferenceNode): boolean => {
      // The project's own tsconfig turns metadata off: a decorated annotation is an ordinary type position.
      if (!decoratorMetadata) return false;
      // The annotation a reference sits in: walk up through the type to the declaration it types.
      let at: import('typescript').Node = ref;
      while (at.parent && ts.isTypeNode(at.parent)) at = at.parent;
      const owner = at.parent;
      if (!owner) return false;
      if (ts.isPropertyDeclaration(owner)) {
        return owner.type === at && ts.isClassLike(owner.parent) && hasDecorator(owner);
      }
      if (!ts.isParameter(owner) || owner.type !== at) return false;
      const fn = owner.parent;
      if (!fn || !fn.parent || !ts.isClassLike(fn.parent)) return false;
      if (ts.isConstructorDeclaration(fn)) return hasDecorator(fn.parent) || fn.parameters.some(hasDecorator);
      if (ts.isMethodDeclaration(fn) || ts.isSetAccessorDeclaration(fn)) return hasDecorator(fn) || fn.parameters.some(hasDecorator);
      return false;
    };
    const inTypePosition = (id: import('typescript').Identifier): boolean => {
      let node: import('typescript').Node = id;
      let parent = node.parent;
      // The left-most name of a qualified name (`Ns.Type`) stands for the whole.
      while (parent && ts.isQualifiedName(parent) && parent.left === node) { node = parent; parent = node.parent; }
      if (!parent) return false;
      if (ts.isTypeReferenceNode(parent)) return parent.typeName === node && !emittedAsMetadata(parent);
      if (ts.isTypeQueryNode(parent)) return parent.exprName === node;
      if (ts.isExpressionWithTypeArguments(parent)) {
        const clause = parent.parent;
        return !!clause && ts.isHeritageClause(clause) && clause.token === ts.SyntaxKind.ImplementsKeyword;
      }
      return false;
    };
    const countUses = (node: import('typescript').Node): void => {
      if (ts.isImportDeclaration(node)) return;
      if (ts.isIdentifier(node)) {
        const entry = used.get(node.text);
        if (entry) {
          const parent = node.parent;
          const isName = !!parent && ((ts.isPropertyAccessExpression(parent) && parent.name === node)
            || (ts.isPropertyAssignment(parent) && parent.name === node)
            || (ts.isQualifiedName(parent) && parent.right === node));
          if (!isName) { if (inTypePosition(node)) entry.type++; else entry.value++; }
        }
      }
      ts.forEachChild(node, countUses);
    };
    countUses(sf);
    for (const [name, entry] of used) if (entry.type > 0 && entry.value === 0) typePositionOnlyBindings.add(name);
  }

  // Only an EXPORTED object is an adapter a consumer reaches through: its
  // property aliases join the specifier aliases.
  for (const alias of propertyAliases) if (exported.has(alias.container!)) exportAliases.push(alias);

  // The top-level classes the file's own code names outside their own
  // declaration — constructed, extended, implemented, annotated with, tested
  // by instanceof, passed or returned as a value. A name inside the class's
  // own body is the class talking about itself, and an export clause is its
  // publication: neither is a use.
  const classReferences = new Set<string>();
  if (classMembers.size > 0) {
    const inOwnDeclaration = (node: import('typescript').Node, name: string): boolean => {
      for (let up: import('typescript').Node | undefined = node.parent; up; up = up.parent) {
        if (ts.isClassDeclaration(up) && up.name?.text === name && up.parent && ts.isSourceFile(up.parent)) return true;
      }
      return false;
    };
    const visitReference = (node: import('typescript').Node): void => {
      if (ts.isIdentifier(node) && classMembers.has(node.text) && !classReferences.has(node.text)) {
        const parent = node.parent;
        const publication = !!parent && (ts.isExportSpecifier(parent) || ts.isExportAssignment(parent));
        if (!publication && !inOwnDeclaration(node, node.text)) classReferences.add(node.text);
      }
      ts.forEachChild(node, visitReference);
    };
    visitReference(sf);
  }

  return { declared, anchors, exported, imports, reexports, starExports, namedReexports, namespaceReexports, typeOnlyStars, runtimeStars, exportAliases, returnTypes, complexity, calls, bodies, importBindings, typeOnlyBindings, typePositionOnlyBindings, fieldTypes, localTypes, memberTypes, aliasTargets, implementsClauses, typeShapes, functionParams, paramSites, functionRoutes, routePrefixes, tableSpreads, asyncFunctions, functionReturns, classMembers, classReferences, enumValues, aliasTypes, mutableBindings, reexportOnly };
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

/** The answer for one tsconfig.json, by its path: its modification time and whether metadata applies. */
const decoratorMetadataByConfig = new Map<string, { mtimeMs: number; applies: boolean }>();

/**
 * Whether decorator metadata (`emitDecoratorMetadata`) applies to a file
 * (source_analysis_adapter.buildCodeModel step 6): the nearest tsconfig.json
 * at or above the file's directory, up to the project root, read through the
 * compiler's own config reader — which follows `extends` — and metadata is on
 * only if the resolved option is true. No tsconfig, one that cannot be parsed
 * or whose `extends` cannot be resolved, or a solution-style one (references,
 * and no files/include of its own) keeps it ON: the rule is only relaxed by a
 * project that visibly turns it off. Remembered per config path and mtime.
 */
function decoratorMetadataApplies(ts: TsModule, file: string, projectRoot: string): boolean {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(file));
  let configFile: string | null = null;
  for (;;) {
    if (path.relative(root, dir).startsWith('..')) break;
    const candidate = path.join(dir, 'tsconfig.json');
    if (isFile(candidate)) { configFile = candidate; break; }
    if (dir === root) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  if (configFile === null) return true;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(configFile).mtimeMs; } catch { return true; }
  const cached = decoratorMetadataByConfig.get(configFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.applies;
  let applies = true;
  try {
    const read = ts.readConfigFile(configFile, ts.sys.readFile);
    if (!read.error && read.config) {
      const raw = read.config as { files?: unknown; include?: unknown; references?: unknown };
      const solutionStyle = Array.isArray(raw.references) && raw.files === undefined && raw.include === undefined;
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configFile), undefined, configFile);
      // A diagnostic about the config itself (an extends that is not found, a syntax error) leaves it unresolved; "no inputs found" (18003) is only the file list.
      const unresolved = parsed.errors.some((e) => e.code !== 18003);
      if (!solutionStyle && !unresolved) applies = parsed.options.emitDecoratorMetadata === true;
    }
  } catch {
    applies = true;
  }
  decoratorMetadataByConfig.set(configFile, { mtimeMs, applies });
  return applies;
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
  claimed: ReadonlySet<string> = new Set<string>(),
  wiring: readonly string[] = [],
): CheckerReading {
  const out = new Map<string, ResolvedCallFact[]>();
  if (files.size === 0) return { calls: out, imports: new Map(), kinds: new Map(), routes: new Map(), prefixes: new Map(), crossProjectImports: new Map() };
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
    program = ts.createProgram({ rootNames: [...files.keys(), ...wiring], options, host });
  } catch {
    return { calls: out, imports: new Map(), kinds: new Map(), routes: new Map(), prefixes: new Map(), crossProjectImports: new Map(), unbuilt: true };
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

  /**
   * The module functions realizing a shape's members through an object
   * literal: wherever the code builds a literal the checker types as the
   * shape — a composition root wiring `{ isBreach }`, a default `{ save:
   * saveRecord }` — each property whose value is a project function, a
   * declaration or a const bound to one, realizes that member, by the
   * function's own name. Read once over the project, keyed by the shape's
   * declaration, then by member.
   */
  let literalImplementors: Map<import('typescript').Node, Map<string, CallTargetFact[]>> | undefined;
  const functionTargetOf = (value: import('typescript').Symbol | undefined): CallTargetFact | undefined => {
    const decl = value?.valueDeclaration;
    if (!decl) return undefined;
    const isFunction = ts.isFunctionDeclaration(decl)
      || (ts.isVariableDeclaration(decl) && !!decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)));
    if (!isFunction) return undefined;
    // Module scope only: a function bound inside another is no name a file publishes.
    const statement = ts.isVariableDeclaration(decl) ? decl.parent?.parent : decl;
    if (!statement || !ts.isSourceFile(statement.parent)) return undefined;
    const key = ownKey(decl.getSourceFile());
    const member = nameText(ts.getNameOfDeclaration(decl));
    return key && member ? { path: key, member, via: 'implementor' } : undefined;
  };
  const literalImplementorsOf = (shape: import('typescript').Node, member: string): CallTargetFact[] => {
    if (!literalImplementors) {
      literalImplementors = new Map();
      const found = literalImplementors;
      for (const sf of program.getSourceFiles()) {
        if (!ownKey(sf) || sf.isDeclarationFile) continue;
        const visit = (node: import('typescript').Node): void => {
          if (ts.isObjectLiteralExpression(node)) {
            const wired: Array<[string, CallTargetFact]> = [];
            for (const prop of node.properties) {
              const name = nameText(prop.name);
              if (!name) continue;
              let value: import('typescript').Symbol | undefined;
              if (ts.isShorthandPropertyAssignment(prop)) value = checker.getShorthandAssignmentValueSymbol(prop);
              else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.initializer) || ts.isPropertyAccessExpression(prop.initializer))) {
                value = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(prop.initializer) ? prop.initializer.name : prop.initializer);
              }
              if (value && value.flags & ts.SymbolFlags.Alias) {
                try { value = checker.getAliasedSymbol(value); } catch { /* keep the alias */ }
              }
              const target = functionTargetOf(value);
              if (target) wired.push([name, target]);
            }
            if (wired.length > 0) {
              const contextual = checker.getContextualType(node);
              const type = contextual ? checker.getNonNullableType(contextual) : undefined;
              for (const part of type ? (type.isUnionOrIntersection() ? type.types : [type]) : []) {
                const symbol = part.aliasSymbol ?? part.getSymbol();
                for (const decl of symbol?.declarations ?? []) {
                  if (!ts.isInterfaceDeclaration(decl) && !ts.isTypeLiteralNode(decl) && !ts.isTypeAliasDeclaration(decl)) continue;
                  const shapeNode = ts.isTypeAliasDeclaration(decl) ? decl.type : decl;
                  let members = found.get(shapeNode);
                  if (!members) found.set(shapeNode, (members = new Map()));
                  for (const [name, target] of wired) {
                    const list = members.get(name) ?? [];
                    if (!list.some(t => t.path === target.path && t.member === target.member)) list.push(target);
                    members.set(name, list);
                  }
                }
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }
    }
    return literalImplementors.get(shape)?.get(member) ?? [];
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
        for (const target of literalImplementorsOf(holder, member)) add(target);
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
          for (const target of literalImplementorsOf(decl, member)) add(target);
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

  /**
   * A member read by NAME in a value position — taken, not invoked on the
   * spot — off a receiver the code made opaque (any or unknown at any link of
   * its chain, a cast to either, an untyped parameter, a function result typed
   * any), where the checker names no declaration for it: `const f = (store as
   * any).save; f(x)`. Recorded unresolved under the member's name, with the
   * classes the receiver was before any cast where the checker recorded them,
   * so a rule fails it closed against a write of that name however the value
   * is invoked later. A plain property of an identifier (`x.y` with x a
   * module or a namespace) never lands here: the receiver must be opaque.
   */
  const opaqueReferenceOf = (node: import('typescript').Node): ResolvedCallFact | undefined => {
    if (!ts.isPropertyAccessExpression(node) || !isValuePosition(node)) return undefined;
    const symbol = symbolOf(node.name);
    if (symbol?.declarations?.length) return undefined;
    const receiver = node.expression;
    if (!(isOpaque(checker.getTypeAtLocation(receiver)) || rootOpaque(receiver))) return undefined;
    const fact: ResolvedCallFact = {
      name: node.name.text,
      written: node.getText().replace(/\s+/g, ' ').slice(0, 80),
      targets: [],
      reference: true,
      unresolved: true,
    };
    const receivers = receiversOf(receiver, node.name.text);
    if (receivers.length > 0) fact.receivers = receivers;
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
          const fact = referenceOf(node)
            ?? (ts.isElementAccessExpression(node) ? computedAccessOf(node) : opaqueReferenceOf(node));
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

  // The walked files read for their wiring: their calls and references are
  // what tells a verb a test or a composition root uses from one nothing does.
  // Not followed further — what they call into is no root's code.
  for (const absolute of wiring) {
    const sf = program.getSourceFile(path.resolve(absolute));
    const key = sf && !sf.isDeclarationFile ? ownKey(sf) : undefined;
    if (!sf || key === undefined || out.has(key)) continue;
    out.set(key, resolveFile(sf));
  }

  // What every own file of the program imports — the roots and every project
  // file they pull in, a helper module no spec names included: the project
  // files each import resolves to, and the bare package specifiers it names.
  // What lets a rule read an unowned module's imports as its importer's.
  const imports = new Map<string, ModuleImports>();
  // Where an imported value is declared, through every re-export: the own
  // files the checker lands the binding on (each value a namespace's module
  // exports, for a namespace import). A type republishes no code.
  const declarationFilesOf = (local: import('typescript').Identifier, namespace: boolean): string[] => {
    const unalias = (s: import('typescript').Symbol): import('typescript').Symbol => (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);
    const bound = checker.getSymbolAtLocation(local);
    if (!bound) return [];
    const target = unalias(bound);
    const symbols = namespace ? checker.getExportsOfModule(target).map(unalias) : [target];
    const files = new Set<string>();
    for (const symbol of symbols) {
      if (!(symbol.flags & ts.SymbolFlags.Value)) continue;
      for (const declaration of symbol.declarations ?? []) {
        const sf = declaration.getSourceFile();
        const key = sf.isDeclarationFile ? undefined : ownKey(sf);
        if (key !== undefined) files.add(key);
      }
    }
    return [...files];
  };
  const cache = ts.createModuleResolutionCache(projectRoot, f => (ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase()), options);
  for (const sf of program.getSourceFiles()) {
    const key = ownKey(sf);
    if (!key || sf.isDeclarationFile) continue;
    const specifiers: string[] = [];
    /** The values each specifier's imports take: by name as the module exports them, `default`, or `*` for the namespace. */
    const named = new Map<string, Array<{ name: string; local: import('typescript').Identifier; namespace?: true }>>();
    const visit = (node: import('typescript').Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
        const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
        if (clause && !clause.isTypeOnly) {
          const list = named.get(node.moduleSpecifier.text) ?? [];
          if (clause.name) list.push({ name: 'default', local: clause.name });
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) if (!element.isTypeOnly) list.push({ name: (element.propertyName ?? element.name).text, local: element.name });
          } else if (bindings) {
            list.push({ name: '*', local: bindings.name, namespace: true });
          }
          named.set(node.moduleSpecifier.text, list);
        }
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
        for (const { name, local, namespace } of named.get(specifier) ?? []) {
          const names = (entry.names ??= []);
          let imported = names.find(n => n.name === name && n.file === resolved);
          if (!imported) names.push((imported = { name, file: resolved }));
          for (const at of declarationFilesOf(local, namespace === true)) {
            if (!(imported.declaredIn ??= []).includes(at)) imported.declaredIn.push(at);
          }
        }
      } else if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) {
        entry.packages.push(specifier);
      }
    }
    imports.set(key, entry);
  }

  // ---- what the checker settles beyond the calls, for each root file ----
  const kinds = new Map<string, Array<Array<ParameterReading>>>();
  const routes = new Map<string, Map<string, RouteFact[]>>();
  const prefixes = new Map<string, Map<string, string>>();
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
    const fileKinds: Array<Array<ParameterReading>> = [];
    const fileRoutes = new Map<string, Map<string, RouteFact>>();
    const filePrefixes = new Map<string, string>();
    const visit = (node: import('typescript').Node): void => {
      const name = namedFunctionNameOf(ts, node);
      const body = (node as { body?: import('typescript').Node }).body;
      if (name !== undefined && body) {
        fileKinds.push(((node as import('typescript').SignatureDeclarationBase).parameters ?? []).map((parameter) => {
          try {
            const type = checker.getTypeAtLocation(parameter);
            const kind = kindOf(type) ?? platformKind(parameter.type);
            const reading: ParameterReading = {};
            if (kind) reading.kind = kind;
            if (kind === 'object') {
              // The DATA properties: a method is behaviour, never a field a
              // declared record could be compared with.
              const props = checker.getPropertiesOfType(checker.getNonNullableType(type))
                .filter(p => (p.flags & ts.SymbolFlags.Method) === 0)
                .map(p => p.getName());
              if (props.length > 0) reading.fields = props.slice(0, 200);
            }
            if (opaqueType(type)) reading.opaque = true;
            // A request handle's reads again, the checker following a helper
            // it is handed into any project file no implementation claims.
            if (ts.isIdentifier(parameter.name) && REQUEST_HANDLE_NAMES.has(parameter.name.text.replace(/^_+/, '').toLowerCase())) {
              const read = handleReads(ts, body, parameter.name.text, checkerHelpers);
              if (read.size > 0) reading.reads = [...read].sort();
            }
            return reading;
          } catch {
            return {};
          }
        }));
        // Both idioms compare a request's method — a guard `<request>.method`,
        // a table entry's `method` / `verb` key matched against it — so a
        // function that never says so is no router, and is not re-read.
        if (ROUTER_TEXT.test(body.getText(sf))) try {
          const read = readRoutes(ts, node as import('typescript').Node & { body?: import('typescript').Node }, initializerOf, literalOf);
          if (read.size > 0) {
            const known = fileRoutes.get(name) ?? new Map<string, RouteFact>();
            for (const [routeKeyText, route] of read) known.set(routeKeyText, route);
            fileRoutes.set(name, known);
          }
          const prefix = strippedAnywhere(ts, body, initializerOf, literalOf);
          if (prefix !== undefined) filePrefixes.set(name, prefix);
        } catch {
          // a router the checker cannot settle keeps the syntactic reading
        }
      }
      // A route table bound to a top-level const, read in its own right: what
      // a router linkage naming the table rather than a function reads.
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && node.parent && ts.isVariableDeclarationList(node.parent) && node.parent.parent && ts.isVariableStatement(node.parent.parent)
        && node.parent.parent.parent === sf) {
        try {
          const table = tableRoutes(ts, node.initializer, initializerOf, literalOf);
          if (table.length > 0) fileRoutes.set(node.name.text, new Map(table.map(route => [routeKey(route), route])));
        } catch {
          // a table the checker cannot settle keeps the syntactic reading
        }
      }
      // A route table IMPORTED under a name, read where it is declared: a
      // Portal naming the table it imports (`router: ROUTES`) names that table.
      if (ts.isImportSpecifier(node) && !node.isTypeOnly && !fileRoutes.has(node.name.text)) {
        try {
          const declaration = symbolOf(node.name)?.valueDeclaration;
          if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer
            && (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0) {
            const table = tableRoutes(ts, declaration.initializer, initializerOf, literalOf);
            if (table.length > 0) fileRoutes.set(node.name.text, new Map(table.map(route => [routeKey(route), route])));
          }
        } catch {
          // an import the checker cannot follow is no table here
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    kinds.set(key, fileKinds);
    routes.set(key, new Map([...fileRoutes].map(([name, read]) => [name, [...read.values()]])));
    if (filePrefixes.size > 0) prefixes.set(key, filePrefixes);

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
      // What the import DOES reach, too: the module of the other project it
      // lands in, relative to that project's root, under each name it binds.
      // Whether that is the other project's published surface or its
      // internals is the rule's question, which knows what it exports.
      const module = pathKey(path.relative(home, path.resolve(resolved)));
      const reached = (name: string | undefined, typeOnly: boolean): void => {
        broken.push({ specifier, ...(name !== undefined ? { name } : {}), project, line, typeOnly, resolved: true, module });
      };
      if (clause?.name) {
        if (unresolvedName(clause.name)) broken.push({ specifier, name: 'default', project, line, typeOnly: clause.isTypeOnly });
        else reached(clause.name.text, clause.isTypeOnly);
      }
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (unresolvedName(element.name)) broken.push({ specifier, name, project, line, typeOnly: clause.isTypeOnly || element.isTypeOnly });
          else reached(name, clause.isTypeOnly || element.isTypeOnly);
        }
      } else if (clause?.namedBindings) {
        reached('*', clause.isTypeOnly);
      }
      if (!clause) reached(undefined, false);
    }
    if (broken.length > 0) crossProjectImports.set(key, broken);
  }
  return { calls: out, imports, kinds, routes, prefixes, crossProjectImports };

  /**
   * Whether a parameter's type admits any value, nullability set aside: any,
   * unknown, `object`, `{}`, or an object type of an index signature alone
   * (`Record<string, unknown>`) — a type naming no field a declared record
   * could be compared with. An unresolvable name (the checker's error type)
   * is no claim about the value at all, and is not one.
   */
  function opaqueType(type: import('typescript').Type): boolean {
    const at = checker.getNonNullableType(type);
    if ((at as unknown as { intrinsicName?: string }).intrinsicName === 'error') return false;
    if ((at.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.NonPrimitive)) !== 0) return true;
    if ((at.flags & ts.TypeFlags.Object) === 0 || at.getProperties().length > 0) return false;
    if (at.getCallSignatures().length > 0 || at.getConstructSignatures().length > 0) return false;
    const lists = checker as unknown as { isArrayType?: (t: import('typescript').Type) => boolean; isTupleType?: (t: import('typescript').Type) => boolean };
    return !(lists.isArrayType?.(at) || lists.isTupleType?.(at));
  }

  /**
   * The helper a call hands a request handle to, where the checker resolves
   * it to a function-like with a body in a project file that is this file or
   * one no implementation claims (`claimed`): another component's code is
   * that component's, and a library's is nobody's design.
   */
  function checkerHelpers(call: import('typescript').CallExpression, index: number): HelperParam | undefined {
    let declaration: import('typescript').Declaration | undefined;
    try {
      declaration = checker.getResolvedSignature(call)?.getDeclaration();
    } catch {
      return undefined;
    }
    if (!declaration || !(declaration as { body?: TsNode }).body) return undefined;
    const home = declaration.getSourceFile();
    if (home.isDeclarationFile || !ownKey(home)) return undefined;
    const absolute = path.resolve(home.fileName);
    if (absolute !== path.resolve(call.getSourceFile().fileName) && claimed.has(absolute)) return undefined;
    return helperParam(ts, declaration, index);
  }

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

/**
 * The transport classes a handler is handed — a request, a response, a
 * socket, a URL and its parts — by the names the platform and the common
 * HTTP frameworks give them: a handle, never a domain record.
 */
const TRANSPORT_TYPES = new Set([
  'URL', 'URLSearchParams', 'Request', 'Response', 'Headers', 'IncomingMessage', 'ServerResponse',
  'Http2ServerRequest', 'Http2ServerResponse', 'Socket', 'FastifyRequest', 'FastifyReply', 'NextRequest', 'NextResponse',
]);

/** What a type checker settles about one parameter: the kind of value it takes, an object's data property names, whether its type admits any value, and a request handle's reads. */
interface ParameterReading {
  kind?: ParameterKind;
  fields?: string[];
  opaque?: boolean;
  reads?: string[];
}

/** What the type checker settles over the run's files beyond their calls. */
interface CheckerReading {
  calls: Map<string, ResolvedCallFact[]>;
  imports: Map<string, ModuleImports>;
  /** Per root file, the parameter kinds of each named function-like with a body, in the order the walk meets them. */
  kinds: Map<string, Array<Array<ParameterReading>>>;
  /** Per root file, the routes each named function-like serves, read with the checker settling every value. */
  routes: Map<string, Map<string, RouteFact[]>>;
  /** Per root file, the one prefix each named function strips off a path, settled by the checker. */
  prefixes: Map<string, Map<string, string>>;
  /** Per root file, its imports from another project's source that resolve to nothing. */
  crossProjectImports: Map<string, CrossProjectImportFact[]>;
  /** Set when the compiler could not build the program: nothing was read. */
  unbuilt?: true;
}

/**
 * The one file set both buildCodeModel and fingerprintSources take: every
 * source file an implementation names (its own path, then each method's), its
 * simPath and router module, then every file a type names, then the walked
 * root files — in that order, before deduplication. `claimed` is the files
 * the implementations name.
 */
function sourceFileSet(
  implementations: ImplementationSpec[],
  types: TypeSpec[],
  projectRoot: string,
  sourceRoots: readonly string[],
  exclude: readonly string[],
): { rootFiles: string[]; declaredPaths: string[]; claimed: string[] } {
  const rootFiles = walkDeclaredRoots(sourceRoots, exclude, projectRoot);
  const declaredPaths: string[] = [];
  const claimed: string[] = [];
  for (const impl of implementations) {
    declaredPaths.push(...implementationSourceFiles(impl));
    claimed.push(...implementationSourceFiles(impl));
    if (impl.simPath) declaredPaths.push(impl.simPath);
    // A router linkage naming a module of its own (a central routes.ts) is a
    // file route coverage reads, whatever spec otherwise names it.
    const routerFile = impl.router ? routerLinkage(impl.router).file : undefined;
    if (routerFile) declaredPaths.push(routerFile);
  }
  for (const type of types) declaredPaths.push(...typeSourceFiles(type));
  declaredPaths.push(...rootFiles);
  return { rootFiles, declaredPaths, claimed };
}

/**
 * A fingerprint of the files buildCodeModel would read: the same set, each
 * file's path with its size and modification time (stat only, no content), or
 * its classification when it is missing, escaped or not a file; folded in
 * path order into one digest. Not a content hash: a change that keeps both
 * size and modification time is not seen.
 */
export function fingerprintSources(
  implementations: ImplementationSpec[],
  types: TypeSpec[],
  projectRoot: string,
  sourceRoots: readonly string[] = [],
  exclude: readonly string[] = [],
): string {
  const { declaredPaths } = sourceFileSet(implementations, types, projectRoot, sourceRoots, exclude);
  const entries = new Map<string, string>();
  for (const declared of declaredPaths) {
    const key = pathKey(declared);
    if (entries.has(key)) continue;
    if (path.isAbsolute(key) || path.normalize(key).split(path.sep)[0] === '..') {
      entries.set(key, 'escaped');
      continue;
    }
    const absolute = path.resolve(projectRoot, key);
    if (path.relative(projectRoot, absolute).startsWith('..')) {
      entries.set(key, 'escaped');
      continue;
    }
    try {
      const stat = fs.statSync(absolute);
      entries.set(key, stat.isFile() ? `${stat.size}:${stat.mtimeMs}` : 'missing');
    } catch {
      entries.set(key, 'missing');
    }
  }
  const hash = createHash('sha256');
  for (const key of [...entries.keys()].sort()) hash.update(`${key} ${entries.get(key)}
`);
  return hash.digest('hex');
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
  const { rootFiles, declaredPaths, claimed } = sourceFileSet(implementations, types, projectRoot, sourceRoots, exclude);
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
  /** Every file an implementation names, absolute: the helpers a handle's reads never follow into (another component's code is that component's). */
  const claimedFiles = new Set<string>(claimed.map(file => path.resolve(projectRoot, file)));
  /** Each Python file's router objects, folded across modules once every file is read. */
  const pythonRouting = new Map<string, PythonDeclarative['routers']>();
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
          const facts = walkExact(ts, text, absolute, decoratorMetadataApplies(ts, absolute, projectRoot));
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
              ...[...facts.runtimeStars].map((from) => ({ exported: '*', local: '*', from })),
            ],
            ...(facts.namespaceReexports.length ? { namespaceReexports: [...facts.namespaceReexports] } : {}),
            exportAliases: facts.exportAliases.map(alias => ({ ...alias })),
            returnTypes: Object.fromEntries(
              [...facts.returnTypes].filter((entry): entry is [string, string] => entry[1] !== null),
            ),
            functionComplexity: Object.fromEntries(facts.complexity),
            functionCallSites: Object.fromEntries([...facts.calls].map(([k, v]) => [k, [...v.values()]])),
            functionBodies: Object.fromEntries(facts.bodies),
            importBindings: Object.fromEntries(facts.importBindings),
            typeOnlyBindings: Object.fromEntries(facts.typeOnlyBindings),
            ...(facts.typePositionOnlyBindings.size > 0 ? { typePositionOnlyBindings: [...facts.typePositionOnlyBindings] } : {}),
            fieldTypes: Object.fromEntries([...facts.fieldTypes].map(([k, v]) => [k, [...v]])),
            localTypes: Object.fromEntries([...facts.localTypes].map(([k, v]) => [k, [...v]])),
            memberTypes: Object.fromEntries([...facts.memberTypes].map(([k, v]) => [k, [...v]])),
            aliasTargets: Object.fromEntries(facts.aliasTargets),
            ...(facts.implementsClauses.size > 0 ? { implementsClauses: Object.fromEntries(facts.implementsClauses) } : {}),
            typeShapes: Object.fromEntries(facts.typeShapes),
            functionParams: Object.fromEntries(facts.functionParams),
            functionRoutes: Object.fromEntries([...facts.functionRoutes].map(([k, v]) => [k, [...v.values()]])),
            ...(facts.routePrefixes.size > 0 ? { routePrefixes: Object.fromEntries(facts.routePrefixes) } : {}),
            ...(facts.tableSpreads.size > 0 ? { tableSpreads: Object.fromEntries(facts.tableSpreads) } : {}),
            asyncFunctions: [...facts.asyncFunctions],
            functionReturns: Object.fromEntries(facts.functionReturns),
            classMembers: Object.fromEntries(facts.classMembers),
            classReferences: [...facts.classReferences].sort(),
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
    } else if (language === 'python' && text.length <= PATTERN_ANALYSIS_MAX_BYTES) {
      // Python: the pattern tables for declared names, and the signature
      // reader for what a `def` says about itself (python-analysis.ts) — still
      // pattern grade, with what it read said in `reads`.
      const base = analyzeWithPatterns(text, LANGUAGE_PATTERNS.python);
      try {
        const { routing, ...read } = readPython(text);
        analyzed = { ...base, ...read, imports: [...new Set([...base.imports, ...read.imports])] };
        if (routing.size > 0) pythonRouting.set(sourcePath, routing);
      } catch {
        analyzed = base;
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
  foldPythonRoutes(files, pythonRouting);

  // Every call of every exact-grade file, resolved by the type checker. A
  // program that cannot be built leaves the facts without resolved calls, and
  // the rules read the shape facts as they always have.
  const outside = outsideOf(projectRoot, seen, packages);
  if (ts && checkerRoots.size > 0) {
    let resolved = new Map<string, ResolvedCallFact[]>();
    let imports = new Map<string, ModuleImports>();
    let reading: CheckerReading | undefined;
    try {
      reading = resolveCalls(ts, checkerRoots, projectRoot, claimedFiles, outside.wiring);
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
          site.params.forEach((param, at) => {
            const reading = settled[index][at];
            if (reading.kind) param.kind = reading.kind;
            if (reading.fields) param.fields = reading.fields;
            if (reading.opaque) param.opaque = true;
            if (reading.reads) param.reads = [...new Set([...(param.reads ?? []), ...reading.reads])].sort();
          });
        });
      }
      // The routes re-read with the checker settling every compared value.
      const read = reading.routes.get(facts.path);
      if (read && read.size > 0) facts.functionRoutes = { ...(facts.functionRoutes ?? {}), ...Object.fromEntries(read) };
      const stripped = reading.prefixes.get(facts.path);
      if (stripped && stripped.size > 0) facts.routePrefixes = { ...(facts.routePrefixes ?? {}), ...Object.fromEntries(stripped) };
      const broken = reading.crossProjectImports.get(facts.path);
      if (broken) facts.crossProjectImports = broken;
    }
    const reached: Record<string, ResolvedCallFact[]> = {};
    for (const [key, calls] of resolved) if (!held.has(key) && !seen.has(key)) reached[key] = calls;
    // Read by the checker, a walked script file is judged by where its uses land; unread, by every name it writes.
    const model: CodeModel = { files, projectRoot, rootFiles, packages, ...outsideFields(outside, reading !== undefined && !reading.unbuilt) };
    if (Object.keys(reached).length > 0) model.reachedCalls = reached;
    if (imports.size > 0) model.reachedImports = Object.fromEntries(imports);
    return model;
  }

  return { files, projectRoot, rootFiles, packages, ...outsideFields(outside, false) };
}

/**
 * The walk's names as the CodeModel carries them: outsideNames, every
 * identifier of the walked files, and uncheckedOutsideNames, those of the
 * files no checker read — only the other languages' files when the checker
 * read the script ones, every walked file when it did not.
 */
function outsideFields(
  outside: { names: string[]; unchecked: string[] },
  checked: boolean,
): { outsideNames?: string[]; uncheckedOutsideNames?: string[] } {
  const unchecked = checked ? outside.unchecked : outside.names;
  return {
    ...(outside.names.length > 0 ? { outsideNames: outside.names } : {}),
    ...(unchecked.length > 0 ? { uncheckedOutsideNames: unchecked } : {}),
  };
}

/** Folders the outside walk never reads: dependencies, build output, caches, virtual environments. */
const OUTSIDE_SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', '__pycache__', 'venv', 'env', 'site-packages', 'target', 'vendor']);
/** How many files the outside walk reads at most, and the largest it reads. */
const OUTSIDE_MAX_FILES = 20000;
const OUTSIDE_MAX_BYTES = 1_000_000;

/** A re-export statement — `export { a, b as c } from '…'`, `export * from '…'`, `export * as ns from '…'`. */
const REEXPORT_RE = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*['"][^'"\n]+['"]/g;

/** A module specifier of an import, an export-from or a require, as written. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"\n]+)['"]/g;

/**
 * The project's source files the run did not analyze, read in a bounded walk
 * of the project root, comments stripped: the identifiers they write
 * (CodeModel.outsideNames), those of the files in a language no checker reads
 * (uncheckedOutsideNames, once the checker read the script ones), and the
 * TypeScript and JavaScript ones that reach an analyzed file by their imports,
 * directly or through other walked files — a composition root, a test, a test
 * importing an unanalyzed barrel — whose wiring the type checker reads beside
 * the analyzed files. Never throws; an unreadable folder or file adds nothing.
 */
function outsideOf(
  projectRoot: string,
  analyzed: ReadonlySet<string>,
  packages: Readonly<Record<string, string>>,
): { names: string[]; unchecked: string[]; wiring: string[] } {
  if (!projectRoot) return { names: [], unchecked: [], wiring: [] };
  const names = new Set<string>();
  const unchecked = new Set<string>();
  const wiring: string[] = [];
  /** Each walked script file and the module specifiers it writes. */
  const scripts: Array<{ key: string; child: string; specifiers: string[] }> = [];
  /** Each renamed re-export of an unanalyzed barrel: the name it takes, and the name it publishes. */
  const aliases: Array<[string, string]> = [];
  let read = 0;
  const descend = (dir: string): void => {
    if (read >= OUTSIDE_MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (read >= OUTSIDE_MAX_FILES) return;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || OUTSIDE_SKIPPED_DIRS.has(entry.name)) continue;
        descend(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const key = pathKey(path.relative(projectRoot, child));
      const language = languageOfSourcePath(key);
      if (!language || analyzed.has(key)) continue;
      try {
        if (fs.statSync(child).size > OUTSIDE_MAX_BYTES) continue;
        const buffer = fs.readFileSync(child);
        if (looksBinary(buffer)) continue;
        read++;
        const patterns = LANGUAGE_PATTERNS[language];
        const text = patterns ? stripComments(buffer.toString('utf8'), patterns) : buffer.toString('utf8');
        // A re-export publishes a name and never uses it: an unanalyzed
        // barrel's `export … from` statements exempt nothing.
        // Renamed on the way, it is used when what the barrel publishes is.
        const script = language === 'typescript' || language === 'javascript';
        if (script) {
          for (const statement of text.matchAll(REEXPORT_RE)) {
            for (const m of statement[0].matchAll(/([\w$]+)\s+as\s+([\w$]+)/g)) aliases.push([m[1], m[2]]);
          }
        }
        const used = script ? text.replace(REEXPORT_RE, ' ') : text;
        for (const m of used.matchAll(IDENTIFIER_RE)) {
          names.add(m[0]);
          if (!script) unchecked.add(m[0]);
        }
        if (script && !key.endsWith('.d.ts')) scripts.push({ key, child, specifiers: [...text.matchAll(SPECIFIER_RE)].map(m => m[1]) });
      } catch {
        // an unreadable file adds nothing
      }
    }
  };
  descend(projectRoot);
  // A script file reaches the run when one of its imports resolves to an
  // analyzed file or to a walked file that reaches it, followed to a fixpoint.
  const candidates = new Set([...analyzed, ...scripts.map(s => s.key)]);
  const reaching = new Set(analyzed);
  for (let grew = true; grew;) {
    grew = false;
    for (const script of scripts) {
      if (reaching.has(script.key)) continue;
      if (script.specifiers.some(spec => { const to = resolveImport(script.key, spec, candidates, packages); return to !== undefined && reaching.has(to); })) {
        reaching.add(script.key);
        wiring.push(script.child);
        grew = true;
      }
    }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const [local, exported] of aliases) {
      if (names.has(exported) && !names.has(local)) { names.add(local); grew = true; }
    }
  }
  return { names: [...names].sort(), unchecked: [...unchecked].sort(), wiring };
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

// ---------------------------------------------------------------------------
// The Python signature reader — part of the source analysis adapter.
//
// Python is read below exact grade: no type checker is loaded for it, and none
// is bundled. But what a `def` says about itself is regular enough to read
// without one: its parameters and their annotations, its return annotation,
// whether it is `async`, which class it sits in, and the imports of its
// module. This reader tokenizes the file (strings, comments, brackets and
// line continuations honoured) and reads exactly those, so the checks that
// compare a signature, a public surface, an import and a call through an
// annotated collaborator can judge Python too.
//
// It also reads what a module declares in its frameworks' own forms: the
// routes of each router object (FastAPI, Flask and their kin) off its route
// decorators, and the fields of each declarative data class (a dataclass, a
// Pydantic model, a TypedDict, a NamedTuple, an attrs class).
//
// What it does NOT read it leaves unset, and the file says what it read
// (SourceFileFacts.reads), so a check never mistakes silence for a pass:
// inferred types, dynamic attribute access, a route or a prefix that does not
// settle to a string, and a class built by a call are not read here.
// ---------------------------------------------------------------------------

/** The checks this reader's facts are fuel for. */
const PYTHON_READS: CodeReading[] = ['params', 'returns', 'members', 'imports', 'calls', 'routes', 'types'];

type TokenKind = 'name' | 'op' | 'string' | 'number';

interface Token {
  kind: TokenKind;
  text: string;
}

/** One logical line: its indentation and its tokens. */
interface LogicalLine {
  indent: number;
  tokens: Token[];
}

const NAME_START = /[\p{L}_]/u;
const NAME_PART = /[\p{L}\p{N}_]/u;
const MULTI_OPS = ['**=', '//=', '>>=', '<<=', '...', '->', '**', '//', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', '<<', '>>'];
const STRING_PREFIX = /^[rRbBuUfF]{1,2}$/;

/**
 * Split a Python source into logical lines of tokens: comments dropped,
 * strings kept as one token each, newlines inside brackets or after a
 * backslash joined. Never throws: an unterminated string or bracket ends at
 * the end of the file.
 */
function pythonLogicalLines(text: string): LogicalLine[] {
  const lines: LogicalLine[] = [];
  let tokens: Token[] = [];
  let indent = 0;
  let atLineStart = true;
  let depth = 0;
  let i = 0;
  const n = text.length;
  const flush = (): void => {
    if (tokens.length > 0) lines.push({ indent, tokens });
    tokens = [];
    atLineStart = true;
  };
  while (i < n) {
    const c = text[i];
    if (atLineStart && depth === 0) {
      // Measure indentation; a blank or comment-only line does not start a logical line.
      let col = 0;
      let j = i;
      while (j < n && (text[j] === ' ' || text[j] === '\t')) { col += text[j] === '\t' ? 8 - (col % 8) : 1; j++; }
      if (j >= n) break;
      if (text[j] === '\n' || text[j] === '\r') { i = j + 1; continue; }
      if (text[j] === '#') { while (j < n && text[j] !== '\n') j++; i = j; continue; }
      indent = col;
      atLineStart = false;
      i = j;
      continue;
    }
    if (c === '\n') {
      if (depth === 0) flush();
      i++;
      continue;
    }
    if (c === '\r' || c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
      i += text[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'") {
      i = readString(text, i, '', tokens);
      continue;
    }
    if (NAME_START.test(c)) {
      let j = i + 1;
      while (j < n && NAME_PART.test(text[j])) j++;
      const word = text.slice(i, j);
      if (STRING_PREFIX.test(word) && (text[j] === '"' || text[j] === "'")) {
        i = readString(text, j, word, tokens);
        continue;
      }
      tokens.push({ kind: 'name', text: word });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      tokens.push({ kind: 'number', text: text.slice(i, j) });
      i = j;
      continue;
    }
    const op = MULTI_OPS.find(o => text.startsWith(o, i)) ?? c;
    if (op === '(' || op === '[' || op === '{') depth++;
    else if ((op === ')' || op === ']' || op === '}') && depth > 0) depth--;
    tokens.push({ kind: 'op', text: op });
    i += op.length;
  }
  flush();
  return lines;
}

/** Read one string literal starting at its opening quote; pushes it as one token and answers the index past it. */
function readString(text: string, start: number, prefix: string, tokens: Token[]): number {
  const quote = text[start];
  const triple = text.startsWith(quote.repeat(3), start);
  const close = triple ? quote.repeat(3) : quote;
  let j = start + close.length;
  while (j < text.length) {
    if (text[j] === '\\') { j += 2; continue; }
    if (text.startsWith(close, j)) { j += close.length; break; }
    if (!triple && text[j] === '\n') break;
    j++;
  }
  tokens.push({ kind: 'string', text: prefix + text.slice(start, Math.min(j, text.length)) });
  return j;
}

/** The tokens of a span joined back into readable text, whitespace-normalized: how an annotation is recorded. */
function spelled(tokens: Token[]): string {
  let out = '';
  for (const t of tokens) {
    const tight = t.kind === 'op' && ['.', '[', ']', '(', ')', ','].includes(t.text);
    const prevTight = out.endsWith('.') || out.endsWith('[') || out.endsWith('(');
    if (out && !tight && !prevTight) out += ' ';
    if (t.text === ',') { out += ', '; continue; }
    out += t.text;
  }
  return out.replace(/\s+/g, ' ').replace(/, $/, '').replace(/\s+([\])])/g, '$1').trim();
}

/** An annotation as recorded: its spelling, a quoted forward reference unquoted. */
function annotationText(tokens: Token[]): string | undefined {
  if (tokens.length === 0) return undefined;
  if (tokens.length === 1 && tokens[0].kind === 'string') {
    const inner = tokens[0].text.replace(/^[rRbBuUfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').trim();
    return inner || undefined;
  }
  return spelled(tokens);
}

/** Split a token span at top-level commas. */
function splitTopLevel(tokens: Token[], separator = ','): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'op' && (t.text === '(' || t.text === '[' || t.text === '{')) depth++;
    else if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) depth--;
    if (depth === 0 && t.kind === 'op' && t.text === separator) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** The index of the bracket closing the one opened at `open`, or -1. */
function closingIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'op') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The index of the first top-level `:` from `from`, or -1. */
function topLevelColon(tokens: Token[], from: number): number {
  let depth = 0;
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'op') continue;
    if (t.text === '(' || t.text === '[' || t.text === '{') depth++;
    else if (t.text === ')' || t.text === ']' || t.text === '}') depth--;
    else if (t.text === ':' && depth === 0) return i;
  }
  return -1;
}

/** The classes whose construction makes a module-level name a router object. */
const PYTHON_ROUTER_CLASSES = new Set(['FastAPI', 'APIRouter', 'Flask', 'Blueprint', 'Quart', 'Sanic']);
/** A route decorator's verb, by the attribute it is written as. */
const PYTHON_ROUTE_VERBS: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', patch: 'PATCH', delete: 'DELETE', head: 'HEAD', options: 'OPTIONS' };
/** The decorators taking `methods=`, GET where they state none. */
const PYTHON_ROUTE_METHODS_DECORATORS = new Set(['route', 'api_route']);
/** Calls on a router that add a route this reader cannot settle, or mount an application. */
const PYTHON_ROUTER_UNREAD_CALLS = new Set(['mount', 'add_url_rule', 'add_api_route', 'add_route']);
/** The decorators that make a class's annotated body its fields. */
const PYTHON_DATA_DECORATORS: Record<string, 'dataclass' | 'attrs'> = {
  'dataclass': 'dataclass', 'dataclasses.dataclass': 'dataclass', 'pydantic.dataclasses.dataclass': 'dataclass',
  'define': 'attrs', 'frozen': 'attrs', 'mutable': 'attrs',
  'attr.s': 'attrs', 'attr.attrs': 'attrs', 'attr.define': 'attrs', 'attr.frozen': 'attrs', 'attr.mutable': 'attrs',
  'attrs.define': 'attrs', 'attrs.frozen': 'attrs', 'attrs.mutable': 'attrs',
};
/** The bases that make a class's annotated body its fields, by their last segment. */
const PYTHON_DATA_BASES: Record<string, 'pydantic' | 'typeddict' | 'namedtuple'> = {
  BaseModel: 'pydantic', BaseSettings: 'pydantic', TypedDict: 'typeddict', NamedTuple: 'namedtuple',
};
/** The field calls whose arguments say whether a field has a default. */
const PYTHON_FIELD_CALLS = new Set(['field', 'Field', 'ib', 'attrib']);

/** One router a module includes into another: what names it, and the prefix it is included under. */
interface PythonRouteInclude {
  /** The included router as written: a name, or `module.name` through a namespace import. */
  ref: string;
  /** The include's own prefix (`prefix=`, `url_prefix=`), '' where it states none. */
  prefix: string;
  /** True for `register_blueprint`, whose `url_prefix=` replaces the blueprint's own. */
  replaces: boolean;
  /** Whether the include states a prefix at all. */
  prefixed: boolean;
}

/** One router object of a module, as its decorators and includes write it. */
interface PythonRouter {
  /** The prefix its construction states, '' where none. */
  prefix: string;
  /** Its own decorated routes, without its prefix. */
  routes: RouteFact[];
  includes: PythonRouteInclude[];
  /** True when a route, prefix or include does not settle, or it mounts an application. */
  unread: boolean;
}

/** What the declarative walk reads: each data class's shape, and each router object. */
interface PythonDeclarative {
  typeShapes: Record<string, TypeShapeFact>;
  routers: Map<string, PythonRouter>;
}

/** A string literal's value, or undefined for an f-string or bytes (which no reader settles). */
function pythonStringValue(token: Token | undefined): string | undefined {
  if (!token || token.kind !== 'string') return undefined;
  const prefix = /^[rRbBuUfF]*/.exec(token.text)![0];
  if (/[fFbB]/.test(prefix)) return undefined;
  const body = token.text.slice(prefix.length);
  const quote = body.startsWith('"""') || body.startsWith("'''") ? body.slice(0, 3) : body[0];
  if (!body.endsWith(quote) || body.length < quote.length * 2) return undefined;
  return body.slice(quote.length, body.length - quote.length);
}

/** A dotted name spelled by a run of name and `.` tokens from the start of a span, and where it ends. */
function dottedName(tokens: Token[], from = 0): { name: string; end: number } {
  let name = '';
  let i = from;
  while (i < tokens.length && (tokens[i].kind === 'name' || (tokens[i].kind === 'op' && tokens[i].text === '.'))) {
    name += tokens[i].text;
    i++;
  }
  return { name, end: i };
}

/** A path's segments as a route reads them: a parameter is `*`, and a path converter leaves the length open. */
function pythonPathSegments(pathText: string): { segments: string[]; exactLength: boolean; trailing: boolean } {
  const segments: string[] = [];
  const written = pathText.split('/').filter(Boolean);
  for (let at = 0; at < written.length; at++) {
    const segment = written[at];
    const param = /^\{([^}:]+)(?::([^}]*))?\}$/.exec(segment) ?? /^<(?:([^>:]+):)?([^>]+)>$/.exec(segment);
    const converter = param ? (segment.startsWith('{') ? param[2] : param[1]) : undefined;
    // A path converter takes the rest of the path: segments written after it are never matched as written.
    if (converter === 'path') return { segments, exactLength: false, trailing: at < written.length - 1 };
    segments.push(param || /[{<]/.test(segment) ? '*' : segment);
  }
  return { segments, exactLength: true, trailing: false };
}

/** A keyword argument of a call's parts, or undefined. */
function keywordArg(parts: Token[][], name: string): Token[] | undefined {
  const part = parts.find(p => p[0]?.kind === 'name' && p[0].text === name && p[1]?.kind === 'op' && p[1].text === '=');
  return part ? part.slice(2) : undefined;
}

/** The positional arguments of a call's parts. */
function positionalArgs(parts: Token[][]): Token[][] {
  return parts.filter(p => !(p[0]?.kind === 'name' && p[1]?.kind === 'op' && p[1].text === '=') && !(p[0]?.kind === 'op' && (p[0].text === '*' || p[0].text === '**')));
}

/** The argument parts of the call opened at `open` (a `(` token), or undefined when it does not close. */
function callArgs(tokens: Token[], open: number): Token[][] | undefined {
  if (tokens[open]?.text !== '(') return undefined;
  const close = closingIndex(tokens, open);
  if (close < 0) return undefined;
  return splitTopLevel(tokens.slice(open + 1, close)).filter(p => p.length > 0);
}

/**
 * Read a module's declarative surface: the fields of each data class a
 * dataclass or attrs decorator, or a Pydantic, TypedDict or NamedTuple base,
 * makes declarative, and the routes of each router object — its route
 * decorators, its construction's prefix and the routers it includes. A value
 * that does not settle to a string is never guessed: the router is unread.
 */
function readPythonDeclarative(lines: LogicalLine[], importBindings: Map<string, ImportBindingFact>): PythonDeclarative {
  const typeShapes: Record<string, TypeShapeFact> = {};
  const kinds = new Map<string, 'dataclass' | 'attrs' | 'pydantic' | 'typeddict' | 'namedtuple'>();
  const routers = new Map<string, PythonRouter>();
  const constants = new Map<string, string>();
  const routerOf = (name: string): PythonRouter | undefined => {
    let router = routers.get(name);
    if (!router && importBindings.has(name) && !importBindings.get(name)!.namespace) {
      router = { prefix: '', routes: [], includes: [], unread: false };
      routers.set(name, router);
    }
    return router;
  };
  /** A string a value spells: a literal, or a module-level constant bound to one. */
  const settle = (tokens: Token[] | undefined): string | undefined => {
    if (!tokens || tokens.length !== 1) return undefined;
    if (tokens[0].kind === 'name') return constants.get(tokens[0].text);
    return pythonStringValue(tokens[0]);
  };

  let decorators: Token[][] = [];
  let current: { name: string; kind: 'dataclass' | 'attrs' | 'pydantic' | 'typeddict' | 'namedtuple'; total: boolean | undefined; annotated: boolean; bodyIndent?: number; shape: TypeShapeFact } | undefined;

  for (const line of lines) {
    const t = line.tokens;
    if (line.indent === 0) current = undefined;

    // ---- a data class's direct body ----
    if (current && line.indent > 0) {
      current.bodyIndent ??= line.indent;
      if (line.indent !== current.bodyIndent) continue;
      if (t[0]?.kind === 'op' && t[0].text === '@') continue;
      const defAt = t[0]?.text === 'async' ? 1 : 0;
      if (t[defAt]?.kind === 'name' && t[defAt].text === 'def' && t[defAt + 1]?.kind === 'name') {
        const name = t[defAt + 1].text;
        if (!name.startsWith('_')) current.shape.methods.push(name);
        continue;
      }
      if (t[0]?.kind !== 'name') continue;
      const name = t[0].text;
      const eq = t.findIndex(x => x.kind === 'op' && x.text === '=');
      const value = eq >= 0 ? t.slice(eq + 1) : undefined;
      if (t[1]?.kind === 'op' && t[1].text === ':') {
        const annotation = t.slice(2, eq >= 0 ? eq : undefined);
        const head = dottedName(annotation).name.split('.').pop() ?? '';
        if (head === 'ClassVar' || head === 'InitVar' || head === 'KW_ONLY') continue;
        if (current.kind === 'pydantic' && name.startsWith('_')) continue;
        // An attrs class of the legacy form (or one that turned auto_attribs off) has only its field calls as fields.
        if (current.kind === 'attrs' && !current.annotated) {
          const call = value ? dottedName(value) : undefined;
          if (!value || !call || !PYTHON_FIELD_CALLS.has(call.name.split('.').pop() ?? '') || value[call.end]?.text !== '(') continue;
        }
        let optional: boolean | undefined;
        // A TypedDict field marked neither way follows total=; where that does not settle, its absence is not recorded.
        if (current.kind === 'typeddict') optional = head === 'NotRequired' ? true : head === 'Required' ? false : current.total === undefined ? undefined : !current.total;
        else optional = value !== undefined && hasDefault(value);
        current.shape.fields.push(optional === undefined ? { name } : { name, optional });
        continue;
      }
      // attrs without annotations: `x = attr.ib()`, `x = field()`.
      if (current.kind === 'attrs' && t[1]?.kind === 'op' && t[1].text === '=' && value) {
        const call = dottedName(value);
        if (PYTHON_FIELD_CALLS.has(call.name.split('.').pop() ?? '') && value[call.end]?.text === '(') {
          current.shape.fields.push({ name, optional: hasDefault(value) });
        }
      }
      continue;
    }
    if (line.indent > 0) continue;

    // ---- module level ----
    if (t[0]?.kind === 'op' && t[0].text === '@') {
      decorators.push(t.slice(1));
      continue;
    }
    const pending = decorators;
    decorators = [];

    if (t[0]?.kind === 'name' && t[0].text === 'class' && t[1]?.kind === 'name') {
      const name = t[1].text;
      const parts = t[2]?.text === '(' ? callArgs(t, 2) ?? [] : [];
      const bases = positionalArgs(parts).map(p => dottedName(p).name).filter(Boolean);
      const totalArg = keywordArg(parts, 'total');
      const total = totalArg === undefined ? true : settleBool(totalArg);
      let kind: 'dataclass' | 'attrs' | 'pydantic' | 'typeddict' | 'namedtuple' | undefined;
      let annotated = true;
      for (const decorator of pending) {
        const callee = dottedName(decorator);
        const found = PYTHON_DATA_DECORATORS[callee.name];
        if (found) kind = found;
        if (found === 'attrs') {
          // The legacy attr.s makes only attr.ib() fields unless auto_attribs is True; the newer APIs keep annotations unless it is False.
          const auto = settleBool(keywordArg(decorator[callee.end]?.text === '(' ? callArgs(decorator, callee.end) ?? [] : [], 'auto_attribs'));
          annotated = callee.name === 'attr.s' || callee.name === 'attr.attrs' ? auto === true : auto !== false;
        }
      }
      const roots = new Set(['Generic', 'object']);
      let inherited = false;
      if (kind) inherited = bases.some(base => !roots.has(base.split('.').pop() ?? ''));
      else {
        for (const base of bases) {
          const last = base.split('.').pop() ?? '';
          const root = PYTHON_DATA_BASES[last];
          if (root) { kind = root; roots.add(last); }
          else if (kinds.has(base)) { kind = kinds.get(base); inherited = true; }
        }
        if (kind) inherited = inherited || bases.some(base => !roots.has(base.split('.').pop() ?? ''));
      }
      if (!kind) continue;
      kinds.set(name, kind);
      const shape: TypeShapeFact = { origin: 'declared', fields: [], methods: [], ...(inherited ? { inherited: true } : {}) };
      typeShapes[name] = shape;
      current = { name, kind, total, annotated, shape };
      continue;
    }

    // A route-decorated top-level function: each decorator on a router object is a route.
    const defAt = t[0]?.text === 'async' ? 1 : 0;
    if (t[defAt]?.kind === 'name' && t[defAt].text === 'def') {
      for (const decorator of pending) readRouteDecorator(decorator);
      continue;
    }

    // `NAME = "literal"`: a constant a path or prefix may name.
    if (t[0]?.kind === 'name' && t[1]?.kind === 'op' && t[1].text === '=' && t.length === 3) {
      const value = pythonStringValue(t[2]);
      if (value !== undefined) constants.set(t[0].text, value);
    }

    // `NAME = Router(...)`: a router object, under the prefix its construction states.
    if (t[0]?.kind === 'name' && t[1]?.kind === 'op' && t[1].text === '=') {
      const call = dottedName(t, 2);
      if (PYTHON_ROUTER_CLASSES.has(call.name.split('.').pop() ?? '') && t[call.end]?.text === '(') {
        const parts = callArgs(t, call.end) ?? [];
        const stated = keywordArg(parts, 'prefix') ?? keywordArg(parts, 'url_prefix');
        const prefix = stated === undefined ? '' : settle(stated);
        routers.set(t[0].text, { prefix: prefix ?? '', routes: [], includes: [], unread: prefix === undefined });
        continue;
      }
    }

    // `router.include_router(r, prefix=…)`, `app.register_blueprint(bp, url_prefix=…)`, `app.mount(…)`.
    if (t[0]?.kind === 'name' && t[1]?.text === '.' && t[2]?.kind === 'name' && t[3]?.text === '(') {
      const router = routers.get(t[0].text) ?? (importBindings.has(t[0].text) ? routerOf(t[0].text) : undefined);
      if (!router) continue;
      const method = t[2].text;
      if (PYTHON_ROUTER_UNREAD_CALLS.has(method)) { router.unread = true; continue; }
      if (method !== 'include_router' && method !== 'register_blueprint') continue;
      const parts = callArgs(t, 3);
      const first = parts ? positionalArgs(parts)[0] : undefined;
      const ref = first ? dottedName(first) : undefined;
      if (!parts || !first || !ref || ref.end !== first.length || ref.name.split('.').length > 2) { router.unread = true; continue; }
      const stated = keywordArg(parts, method === 'include_router' ? 'prefix' : 'url_prefix');
      const prefix = stated === undefined ? '' : settle(stated);
      if (prefix === undefined) { router.unread = true; continue; }
      router.includes.push({ ref: ref.name, prefix, replaces: method === 'register_blueprint', prefixed: stated !== undefined });
    }
  }

  readPythonGuards(lines, constants, routers);
  return { typeShapes, routers };

  /** One decorator on a top-level function, read as a route of the router object it is written on. */
  function readRouteDecorator(decorator: Token[]): void {
    const callee = dottedName(decorator);
    const segments = callee.name.split('.');
    if (segments.length !== 2) return;
    const [receiver, attribute] = segments;
    const verb = PYTHON_ROUTE_VERBS[attribute];
    if (!verb && !PYTHON_ROUTE_METHODS_DECORATORS.has(attribute)) return;
    const router = routerOf(receiver);
    if (!router) return;
    const parts = callArgs(decorator, callee.end);
    if (!parts) { router.unread = true; return; }
    const pathTokens = positionalArgs(parts)[0] ?? keywordArg(parts, 'path') ?? keywordArg(parts, 'rule');
    const pathText = settle(pathTokens);
    if (pathText === undefined) { router.unread = true; return; }
    let verbs = verb ? [verb] : ['GET'];
    if (!verb) {
      const methods = keywordArg(parts, 'methods');
      if (methods) {
        const open = methods[0];
        const close = methods[methods.length - 1];
        const listed = open?.kind === 'op' && ['[', '(', '{'].includes(open.text) && close?.kind === 'op' && [']', ')', '}'].includes(close.text)
          ? splitTopLevel(methods.slice(1, -1)).filter(p => p.length > 0).map(p => settle(p))
          : [undefined];
        if (listed.length === 0 || listed.some(v => v === undefined)) { router.unread = true; return; }
        verbs = (listed as string[]).map(v => v.toUpperCase());
      }
    }
    const { segments: path, exactLength, trailing } = pythonPathSegments(pathText);
    if (trailing) { router.unread = true; return; }
    for (const v of verbs) router.routes.push({ verb: v, segments: path, exactLength, fullPath: true });
  }

  /** Whether a field's default value gives it a default: any value, but a field call only with a default or a default factory. */
  function hasDefault(value: Token[]): boolean {
    const call = dottedName(value);
    const last = call.name.split('.').pop() ?? '';
    if (!PYTHON_FIELD_CALLS.has(last) || value[call.end]?.text !== '(') return value.length > 0;
    const parts = callArgs(value, call.end) ?? [];
    const isEllipsis = (tokens: Token[] | undefined): boolean => !!tokens && tokens.length === 1 && tokens[0].text === '...';
    // Pydantic's Field takes the Ellipsis as its required marker: Field(...) and Field(default=...).
    const stated = keywordArg(parts, 'default');
    if (stated) return !(last === 'Field' && isEllipsis(stated));
    if (keywordArg(parts, 'default_factory') || keywordArg(parts, 'factory')) return true;
    // Field(x) and attr.ib(x) take the default first; Field(...) is required.
    const first = positionalArgs(parts)[0];
    return (last === 'Field' || last === 'ib' || last === 'attrib') && !!first && !(last === 'Field' && isEllipsis(first));
  }

  /** `True` or `False` as written, else undefined. */
  function settleBool(tokens: Token[] | undefined): boolean | undefined {
    if (!tokens || tokens.length !== 1 || tokens[0].kind !== 'name') return undefined;
    return tokens[0].text === 'True' ? true : tokens[0].text === 'False' ? false : undefined;
  }
}

// ---------------------------------------------------------------------------
// Guard-style routers (Python).
//
// A function whose body selects a handler by the request's method and path —
// `if`/`elif` chains, `match` statements, dicts keyed by path or by (method,
// path) — answers a route for each method comparison joined with a path
// comparison, as TypeScript's readRoutes reads it: a branch inherits the
// conditions of every enclosing `if` on the path taken, an `else` none of them,
// and a route needs both a verb and a path. Each such function is recorded as a
// router of its own (under its name, `Class.method` for a method), so folding
// and the route check treat it like a router object. A function whose path
// comparisons do not all settle is unread, never a part of its routes.
// ---------------------------------------------------------------------------

/** A request path, as a name or the last attribute of a chain (`path`, `self.path`, `urlparse(x).path`). */
const PYTHON_PATH_NAMES = new Set(['path', 'pathname', 'path_info']);

/** One condition a branch of a guard function fixes. */
type GuardConstraint =
  | { kind: 'verbs'; verbs: string[] }
  | { kind: 'patterns'; patterns: { segments: string[]; exactLength: boolean }[] }
  | { kind: 'length'; length: number }
  | { kind: 'index'; index: number; literal: string };

/** One statement of a function body and the statements nested under it. */
interface GuardNode {
  tokens: Token[];
  indent: number;
  children: GuardNode[];
}

/** One entry of a route dict: a path (and the verb its key states, when it does). */
interface GuardTableEntry {
  verb?: string;
  pattern: { segments: string[]; exactLength: boolean };
}

/** The statements of a function body as a tree, by indentation. */
function guardTree(body: LogicalLine[]): GuardNode[] {
  const root: GuardNode = { tokens: [], indent: -1, children: [] };
  const stack: GuardNode[] = [root];
  for (const line of body) {
    while (stack.length > 1 && line.indent <= stack[stack.length - 1].indent) stack.pop();
    const node: GuardNode = { tokens: line.tokens, indent: line.indent, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root.children;
}

/** The tokens of a span split at a top-level word (`and`, `or`), outside every bracket. */
function splitAtWord(tokens: Token[], word: string): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const t of tokens) {
    if (t.kind === 'op' && (t.text === '(' || t.text === '[' || t.text === '{')) depth++;
    else if (t.kind === 'op' && (t.text === ')' || t.text === ']' || t.text === '}')) depth--;
    if (depth === 0 && t.kind === 'name' && t.text === word) { parts.push(current); current = []; continue; }
    current.push(t);
  }
  parts.push(current);
  return parts;
}

/** The inside of a span that is one bracketed group `( … )`, or undefined. */
function wholeGroup(tokens: Token[], open = '('): Token[] | undefined {
  if (tokens.length < 2 || tokens[0].kind !== 'op' || tokens[0].text !== open) return undefined;
  return closingIndex(tokens, 0) === tokens.length - 1 ? tokens.slice(1, -1) : undefined;
}

/** An anchored raw regular expression of Python as a route path, through the JavaScript reading of one. */
function pythonRegexRoute(source: string, whole: boolean): { segments: string[]; exactLength: boolean } | undefined {
  let s = source.replace(/\(\?P</g, '(?<');
  if (whole) {
    if (!s.startsWith('^')) s = `^${s}`;
    if (!s.endsWith('$') || s.endsWith('\\$')) s = `${s}$`;
  } else if (!s.startsWith('^')) return undefined;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[i] + s[i + 1]; i++; continue; }
    out += s[i] === '/' ? '\\/' : s[i];
  }
  return regexRoute(`/${out}/`);
}

/** A string token's value as a regular expression: a raw string, or one with no backslash. */
function pythonRegexSource(token: Token | undefined): string | undefined {
  if (!token || token.kind !== 'string') return undefined;
  const value = pythonStringValue(token);
  if (value === undefined) return undefined;
  return /^[rR]/.test(token.text) || !value.includes('\\') ? value : undefined;
}

/**
 * Read the guard functions of a module and record each as a router in
 * `routers`: its routes where it states any, itself as unread where it
 * selects by method and path but a path comparison does not settle.
 */
function readPythonGuards(lines: LogicalLine[], constants: Map<string, string>, routers: Map<string, PythonRouter>): void {
  const settle = (tokens: Token[] | undefined): string | undefined => {
    if (!tokens || tokens.length !== 1) return undefined;
    if (tokens[0].kind === 'name') return constants.get(tokens[0].text);
    return pythonStringValue(tokens[0]);
  };
  // Module-level regular expressions (`ORDER = re.compile(r"^/orders/(\d+)$")`) and route dicts.
  const compiled = new Map<string, string>();
  const tables = new Map<string, GuardTableEntry[] | 'unsettled'>();
  // A string constant that holds a raw pattern, and a pattern held in a plain string.
  const sourceConstants = new Map<string, string>();
  for (const line of lines) {
    const t = line.tokens;
    if (line.indent !== 0 || t[0]?.kind !== 'name' || t[1]?.text !== '=') continue;
    if (t.length === 3) {
      const plain = pythonRegexSource(t[2]);
      if (plain !== undefined) sourceConstants.set(t[0].text, plain);
    }
    if (t[2]?.text === 're' && t[3]?.text === '.' && t[4]?.text === 'compile' && t[5]?.text === '(') {
      const source = pythonRegexSource(t[6]);
      if (source !== undefined) compiled.set(t[0].text, source);
      continue;
    }
    if (t[2]?.text === '{') {
      const table = routeDict(t.slice(2), settle);
      if (table) tables.set(t[0].text, table);
    }
  }

  let currentClass: { name: string; handler: boolean; bodyIndent?: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.tokens;
    if (line.indent === 0) currentClass = undefined;
    else if (currentClass && currentClass.bodyIndent === undefined) currentClass.bodyIndent = line.indent;
    if (t[0]?.kind === 'name' && t[0].text === 'class' && t[1]?.kind === 'name' && line.indent === 0) {
      const parts = t[2]?.text === '(' ? callArgs(t, 2) ?? [] : [];
      const handler = positionalArgs(parts).some(p => (dottedName(p).name.split('.').pop() ?? '').endsWith('RequestHandler'));
      currentClass = { name: t[1].text, handler };
      continue;
    }
    const defAt = t[0]?.text === 'async' ? 1 : 0;
    if (!(t[defAt]?.kind === 'name' && t[defAt].text === 'def' && t[defAt + 1]?.kind === 'name')) continue;
    const method = currentClass !== undefined && line.indent === currentClass.bodyIndent;
    if (line.indent !== 0 && !method) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].indent > line.indent) end++;
    const name = t[defAt + 1].text;
    const key = method ? `${currentClass!.name}.${name}` : name;
    const named = method && currentClass!.handler ? /^do_([A-Z]+)$/.exec(name)?.[1] : undefined;
    readGuardFunction(key, named, lines.slice(i + 1, end));
  }

  /** One function body, read for the routes its guards state. */
  function readGuardFunction(key: string, namedVerb: string | undefined, body: LogicalLine[]): void {
    if (body.length === 0 || routers.has(key)) return;
    const routes = new Map<string, RouteFact>();
    let sawVerb = namedVerb !== undefined && HTTP_VERBS.has(namedVerb);
    let unsettled = false;
    // Locals that hold the path's split segments, and a regular expression matched against the path.
    const parts = new Set<string>();
    const held = new Map<string, { segments: string[]; exactLength: boolean }>();
    const isPath = (tokens: Token[]): boolean => {
      const last = tokens[tokens.length - 1];
      return last?.kind === 'name' && PYTHON_PATH_NAMES.has(last.text) && (tokens.length === 1 || tokens[tokens.length - 2].text === '.');
    };
    const isMethod = (tokens: Token[]): boolean => {
      const last = tokens[tokens.length - 1];
      if (last?.kind !== 'name') return false;
      if (tokens.length === 1) return last.text === 'method';
      return tokens[tokens.length - 2].text === '.' && (last.text === 'method' || last.text === 'command');
    };
    const isParts = (tokens: Token[]): boolean => tokens.length === 1 && tokens[0].kind === 'name' && parts.has(tokens[0].text);
    const touchesPath = (tokens: Token[]): boolean => tokens.some(x => x.kind === 'name' && (PYTHON_PATH_NAMES.has(x.text) || parts.has(x.text) || held.has(x.text)));
    const touchesMethod = (tokens: Token[]): boolean => tokens.some((x, at) => x.kind === 'name' && (x.text === 'method' || (x.text === 'command' && tokens[at - 1]?.text === '.')));
    const verbOf = (tokens: Token[]): string | undefined => {
      const text = settle(tokens);
      return text !== undefined && HTTP_VERBS.has(text.toUpperCase()) ? text.toUpperCase() : undefined;
    };
    const exact = (text: string | undefined): { segments: string[]; exactLength: boolean } | undefined => {
      const segments = text !== undefined ? templateSegments(text) : undefined;
      return segments ? { segments, exactLength: true } : undefined;
    };
    /** The regular expression a call matches against the path: `re.match(R, path)`, `ORDER.fullmatch(path)`. */
    const regexMatch = (tokens: Token[]): { segments: string[]; exactLength: boolean } | undefined => {
      // `(m := re.match(R, path))`: what is matched is what follows the walrus.
      const walrus = tokens.findIndex(x => x.kind === 'op' && x.text === ':=');
      const at = walrus > 0 ? tokens.slice(walrus + 1) : tokens;
      let source: string | undefined;
      let subject: Token[] | undefined;
      let fn: string | undefined;
      if (at[0]?.text === 're' && at[1]?.text === '.' && at[3]?.text === '(' && (at[2]?.text === 'match' || at[2]?.text === 'fullmatch')) {
        const args = callArgs(at, 3);
        if (!args || args.length !== 2 || closingIndex(at, 3) !== at.length - 1) return undefined;
        const pattern = args[0];
        source = pattern.length !== 1 ? undefined
          : pattern[0].kind === 'name' ? compiled.get(pattern[0].text) ?? sourceConstants.get(pattern[0].text) : pythonRegexSource(pattern[0]);
        subject = args[1];
        fn = at[2].text;
      } else if (at[0]?.kind === 'name' && compiled.has(at[0].text) && at[1]?.text === '.' && at[3]?.text === '(' && (at[2]?.text === 'match' || at[2]?.text === 'fullmatch')) {
        const args = callArgs(at, 3);
        if (!args || args.length !== 1 || closingIndex(at, 3) !== at.length - 1) return undefined;
        source = compiled.get(at[0].text);
        subject = args[0];
        fn = at[2].text;
      }
      if (source === undefined || !subject || !isPath(subject)) return undefined;
      return pythonRegexRoute(source, fn === 'fullmatch');
    };
    for (const line of body) {
      const t = line.tokens;
      if (t[0]?.kind !== 'name' || t[1]?.text !== '=' || t[0].text === 'self') continue;
      const rest = t.slice(2);
      const split = rest.findIndex((x, at) => x.text === 'split' && rest[at - 1]?.text === '.' && rest[at + 1]?.text === '(' && pythonStringValue(rest[at + 2]) === '/');
      if (split > 0 && touchesPath(rest)) { parts.add(t[0].text); continue; }
      const matched = regexMatch(rest);
      if (matched) held.set(t[0].text, matched);
    }

    /** What one condition span fixes, and whether it compares the path in a way that does not settle. */
    const conditionOf = (tokens: Token[]): { constraints: GuardConstraint[]; unsettled: boolean } => {
      const inner = wholeGroup(tokens);
      if (inner) return conditionOf(inner);
      const alternatives = splitAtWord(tokens, 'or');
      if (alternatives.length > 1) {
        const each = alternatives.map(conditionOf);
        const single = each.map(x => (!x.unsettled && x.constraints.length === 1 ? x.constraints[0] : undefined));
        if (single.every(c => c?.kind === 'verbs')) {
          return { constraints: [{ kind: 'verbs', verbs: single.flatMap(c => (c as { verbs: string[] }).verbs) }], unsettled: false };
        }
        if (single.every(c => c?.kind === 'patterns')) {
          return { constraints: [{ kind: 'patterns', patterns: single.flatMap(c => (c as { patterns: { segments: string[]; exactLength: boolean }[] }).patterns) }], unsettled: false };
        }
        return { constraints: [], unsettled: touchesPath(tokens) };
      }
      const conjuncts = splitAtWord(tokens, 'and');
      if (conjuncts.length > 1) {
        const each = conjuncts.map(conditionOf);
        return { constraints: each.flatMap(x => x.constraints), unsettled: each.some(x => x.unsettled) };
      }
      return atom(tokens);
    };
    const atom = (tokens: Token[]): { constraints: GuardConstraint[]; unsettled: boolean } => {
      const none = { constraints: [] as GuardConstraint[], unsettled: false };
      const bad = { constraints: [] as GuardConstraint[], unsettled: true };
      if (tokens.length === 0) return none;
      const path = touchesPath(tokens);
      if (!path && !touchesMethod(tokens)) return none;
      const verbs = (list: string[]): { constraints: GuardConstraint[]; unsettled: boolean } => ({ constraints: [{ kind: 'verbs', verbs: list }], unsettled: false });
      const patterns = (list: { segments: string[]; exactLength: boolean }[]): { constraints: GuardConstraint[]; unsettled: boolean } => ({ constraints: [{ kind: 'patterns', patterns: list }], unsettled: false });
      // A held match tested for truth: `m`, `m is not None`.
      const bare = tokens.length === 1 ? tokens
        : tokens.length === 4 && tokens[1].text === 'is' && tokens[2].text === 'not' && tokens[3].text === 'None' ? tokens.slice(0, 1) : undefined;
      if (bare && bare[0].kind === 'name' && held.has(bare[0].text)) return patterns([held.get(bare[0].text)!]);
      const matched = regexMatch(tokens);
      if (matched) return patterns([matched]);
      // `path.startswith("/api/")`: the route is open at its end.
      const starts = tokens.findIndex((x, at) => x.text === 'startswith' && tokens[at - 1]?.text === '.' && tokens[at + 1]?.text === '(');
      if (starts > 0) {
        const args = callArgs(tokens, starts + 1);
        if (isPath(tokens.slice(0, starts - 1)) && args && args.length === 1 && closingIndex(tokens, starts + 1) === tokens.length - 1) {
          const prefix = settle(args[0]);
          const segments = prefix !== undefined && prefix.startsWith('/') ? templateSegments(prefix) : undefined;
          return segments ? patterns([{ segments, exactLength: false }]) : bad;
        }
        return path ? bad : none;
      }
      // A comparison: the first top-level `==`, `in`, or any other comparison operator.
      let depth = 0;
      let at = -1;
      for (let k = 0; k < tokens.length; k++) {
        const x = tokens[k];
        if (x.kind === 'op' && (x.text === '(' || x.text === '[' || x.text === '{')) depth++;
        else if (x.kind === 'op' && (x.text === ')' || x.text === ']' || x.text === '}')) depth--;
        else if (depth === 0 && ((x.kind === 'op' && ['==', '!=', '<', '>', '<=', '>='].includes(x.text)) || (x.kind === 'name' && (x.text === 'in' || x.text === 'is')))) { at = k; break; }
      }
      if (at < 0) return path ? bad : none;
      const op = tokens[at].text;
      const negated = tokens[at - 1]?.text === 'not';
      const left = tokens.slice(0, negated ? at - 1 : at);
      const right = tokens.slice(at + 1);
      const list = (side: Token[]): Token[][] | undefined => {
        const group = wholeGroup(side) ?? wholeGroup(side, '[') ?? wholeGroup(side, '{');
        return group ? splitTopLevel(group).filter(p => p.length > 0) : undefined;
      };
      const equal = (op === '==' && !negated);
      const member = (op === 'in' && !negated);
      const orientations: [Token[], Token[], boolean][] = [[left, right, true], [right, left, false]];
      for (const [a, b, isLeft] of orientations) {
        if (isMethod(a)) {
          if (equal) { const verb = verbOf(b); if (verb) return verbs([verb]); }
          if (member && isLeft) {
            const items = list(b)?.map(verbOf);
            if (items && items.length > 0 && items.every(v => v !== undefined)) return verbs(items as string[]);
          }
          return none;
        }
        if (isPath(a)) {
          if (equal) { const pattern = exact(settle(b)); return pattern ? patterns([pattern]) : bad; }
          if (member && isLeft) {
            const items = list(b)?.map(item => exact(settle(item)));
            return items && items.length > 0 && items.every(p => p !== undefined) ? patterns(items as { segments: string[]; exactLength: boolean }[]) : bad;
          }
          return bad;
        }
        // `len(parts) == 2`
        if (a[0]?.text === 'len' && a[1]?.text === '(' && a.length >= 4 && isParts(a.slice(2, -1)) && a[a.length - 1].text === ')') {
          if (equal && b.length === 1 && b[0].kind === 'number' && /^\d+$/.test(b[0].text)) return { constraints: [{ kind: 'length', length: Number(b[0].text) }], unsettled: false };
          return bad;
        }
        // `parts[1] == "items"`
        if (a[0]?.kind === 'name' && parts.has(a[0].text) && a[1]?.text === '[' && a[a.length - 1]?.text === ']') {
          const index = a.slice(2, -1);
          if (equal && index.length === 1 && index[0].kind === 'number' && /^\d+$/.test(index[0].text)) {
            const literal = settle(b);
            if (literal !== undefined) return { constraints: [{ kind: 'index', index: Number(index[0].text), literal }], unsettled: false };
          }
          return bad;
        }
        // `parts == ["items", "1"]`
        if (isParts(a)) {
          const items = equal ? list(b)?.map(settle) : undefined;
          if (items && items.every(v => v !== undefined && LITERAL_SEGMENT.test(v))) return patterns([{ segments: items as string[], exactLength: true }]);
          return bad;
        }
      }
      return path ? bad : none;
    };

    /** The routes a set of enclosing conditions state. */
    const emit = (constraints: GuardConstraint[], entry?: GuardTableEntry): void => {
      let verbList: string[] | undefined = namedVerb !== undefined && HTTP_VERBS.has(namedVerb) ? [namedVerb] : undefined;
      let patternList: { segments: string[]; exactLength: boolean }[] | undefined;
      let length: number | undefined;
      const fixed = new Map<number, string>();
      for (const c of constraints) {
        if (c.kind === 'verbs') verbList = c.verbs;
        else if (c.kind === 'patterns') patternList = c.patterns;
        else if (c.kind === 'length') length = c.length;
        else fixed.set(c.index, c.literal);
      }
      if (entry) {
        if (entry.verb !== undefined) verbList = [entry.verb];
        patternList = [entry.pattern];
      }
      if (!verbList) return;
      const add = (verb: string, segments: string[], exactLength: boolean): void => {
        const route: RouteFact = { verb, segments, exactLength, fullPath: true };
        routes.set(routeKey(route), route);
      };
      if (patternList) {
        for (const verb of verbList) for (const p of patternList) add(verb, p.segments, p.exactLength);
        return;
      }
      if (length === undefined && fixed.size === 0) return;
      const count = length ?? Math.max(...fixed.keys()) + 1;
      const segments: string[] = [];
      for (let index = 0; index < count; index++) segments.push(fixed.get(index) ?? '*');
      for (const verb of verbList) add(verb, segments, length !== undefined);
    };

    /** The route dicts a statement writes in place, and the module's route dicts it names. */
    const tablesIn = (tokens: Token[], enclosing: GuardConstraint[]): void => {
      for (let k = 0; k < tokens.length; k++) {
        const x = tokens[k];
        if (x.kind === 'op' && x.text === '{') {
          const close = closingIndex(tokens, k);
          if (close < 0) return;
          const table = routeDict(tokens.slice(k, close + 1), settle);
          if (table === 'unsettled') unsettled = true;
          else if (table) { sawVerb = true; for (const entry of table) emit(enclosing, entry); }
          k = close;
        } else if (x.kind === 'name' && tables.has(x.text) && tokens[k - 1]?.text !== '.') {
          const table = tables.get(x.text)!;
          if (table === 'unsettled') unsettled = true;
          else { sawVerb = true; for (const entry of table) emit(enclosing, entry); }
        }
      }
    };

    const branch = (enclosing: GuardConstraint[], condition: Token[]): GuardConstraint[] => {
      const read = conditionOf(condition);
      if (read.unsettled) unsettled = true;
      if (read.constraints.some(c => c.kind === 'verbs')) sawVerb = true;
      const next = [...enclosing, ...read.constraints];
      emit(next);
      return next;
    };

    const matchOf = (node: GuardNode, enclosing: GuardConstraint[]): void => {
      const colon = topLevelColon(node.tokens, 1);
      const subject = node.tokens.slice(1, colon < 0 ? undefined : colon);
      const group = wholeGroup(subject);
      const elements = splitTopLevel(group ?? subject).filter(p => p.length > 0);
      const kinds = elements.map(e => (isMethod(e) ? 'method' : isPath(e) ? 'path' : 'other'));
      if (!kinds.some(k => k !== 'other')) {
        if (touchesPath(subject)) unsettled = true;
        walk(node.children, enclosing);
        return;
      }
      if (kinds.includes('method')) sawVerb = true;
      for (const child of node.children) {
        if (child.tokens[0]?.text !== 'case') { walk([child], enclosing); continue; }
        const at = topLevelColon(child.tokens, 1);
        let pattern = child.tokens.slice(1, at < 0 ? undefined : at);
        const guard = pattern.findIndex(x => x.kind === 'name' && x.text === 'if');
        if (guard >= 0) { pattern = pattern.slice(0, guard); if (kinds.includes('path')) unsettled = true; }
        const alternatives = splitTopLevel(pattern, '|');
        const cases: GuardConstraint[][] = [];
        const verbAlternatives: string[] = [];
        const patternAlternatives: { segments: string[]; exactLength: boolean }[] = [];
        for (const alternative of alternatives) {
          const inside = wholeGroup(alternative);
          const cells = elements.length > 1 ? splitTopLevel(inside ?? alternative).filter(p => p.length > 0) : [alternative];
          if (cells.length !== elements.length) { if (kinds.includes('path')) unsettled = true; continue; }
          const fixedHere: GuardConstraint[] = [];
          cells.forEach((cell, index) => {
            if (cell.length === 1 && cell[0].text === '_') return;
            if (kinds[index] === 'method') {
              const verb = verbOf(cell);
              if (verb) fixedHere.push({ kind: 'verbs', verbs: [verb] });
            } else if (kinds[index] === 'path') {
              const exactPath = cell.length === 1 && cell[0].kind === 'string' ? exact(pythonStringValue(cell[0])) : undefined;
              if (exactPath) fixedHere.push({ kind: 'patterns', patterns: [exactPath] });
              else unsettled = true;
            }
          });
          if (elements.length > 1) { cases.push(fixedHere); continue; }
          for (const c of fixedHere) {
            if (c.kind === 'verbs') verbAlternatives.push(...c.verbs);
            else if (c.kind === 'patterns') patternAlternatives.push(...c.patterns);
          }
        }
        if (verbAlternatives.length > 0) cases.push([{ kind: 'verbs', verbs: verbAlternatives }]);
        if (patternAlternatives.length > 0) cases.push([{ kind: 'patterns', patterns: patternAlternatives }]);
        if (cases.length === 0) cases.push([]);
        for (const fixedCase of cases) {
          const next = [...enclosing, ...fixedCase];
          if (fixedCase.length > 0) emit(next);
          walk(child.children, next);
        }
      }
    };

    const walk = (nodes: GuardNode[], enclosing: GuardConstraint[]): void => {
      for (const node of nodes) {
        const t = node.tokens;
        const head = t[0]?.kind === 'name' ? t[0].text : '';
        if (head === 'def' || head === 'class' || (head === 'async' && t[1]?.text === 'def')) continue;
        if (head === 'if' || head === 'elif') {
          const colon = topLevelColon(t, 1);
          const next = branch(enclosing, t.slice(1, colon < 0 ? undefined : colon));
          if (colon >= 0) tablesIn(t.slice(colon + 1), next);
          walk(node.children, next);
          continue;
        }
        if (head === 'else') { walk(node.children, enclosing); continue; }
        if (head === 'match' && t[1] && t[1].text !== '=' && t[1].text !== '.' && node.children.length > 0 && topLevelColon(t, 1) > 0) { matchOf(node, enclosing); continue; }
        tablesIn(t, enclosing);
        walk(node.children, enclosing);
      }
    };
    walk(guardTree(body), []);

    if (unsettled && sawVerb) routers.set(key, { prefix: '', routes: [], includes: [], unread: true });
    else if (routes.size > 0) routers.set(key, { prefix: '', routes: [...routes.values()], includes: [], unread: false });
  }
}

/**
 * A dict written as a route table: keys that are a path (`"/orders"`) or a
 * (method, path) pair, each value a handler — a name, a dotted name or a
 * lambda. Undefined for any other dict, `unsettled` where a key reads as a
 * route but its path does not settle.
 */
function routeDict(tokens: Token[], settle: (tokens: Token[] | undefined) => string | undefined): GuardTableEntry[] | 'unsettled' | undefined {
  if (tokens[0]?.text !== '{' || closingIndex(tokens, 0) !== tokens.length - 1) return undefined;
  const entries: GuardTableEntry[] = [];
  let unsettled = false;
  let routeLike = 0;
  for (const part of splitTopLevel(tokens.slice(1, -1)).filter(p => p.length > 0)) {
    const colon = topLevelColon(part, 0);
    if (colon <= 0) return undefined;
    const key = part.slice(0, colon);
    const value = part.slice(colon + 1);
    const handler = value[0]?.text === 'lambda' || (value.length > 0 && dottedName(value).end === value.length);
    let verb: string | undefined;
    let pathTokens: Token[] = key;
    const group = wholeGroup(key);
    if (group) {
      const pair = splitTopLevel(group).filter(p => p.length > 0);
      if (pair.length !== 2) continue;
      const stated = settle(pair[0]);
      if (stated === undefined || !HTTP_VERBS.has(stated.toUpperCase())) continue;
      verb = stated.toUpperCase();
      pathTokens = pair[1];
    }
    const text = settle(pathTokens);
    if (verb === undefined && (text === undefined || !text.startsWith('/'))) continue;
    if (!handler) return undefined;
    routeLike++;
    const segments = text !== undefined && text.startsWith('/') ? templateSegments(text) : undefined;
    if (!segments) { unsettled = true; continue; }
    entries.push({ ...(verb !== undefined ? { verb } : {}), pattern: { segments, exactLength: true } });
  }
  if (routeLike === 0) return undefined;
  return unsettled ? 'unsettled' : entries;
}

/** A route under a prefix's segments. */
function underPrefix(prefix: string, route: RouteFact): RouteFact {
  const { segments } = pythonPathSegments(prefix);
  return { ...route, segments: [...segments, ...route.segments] };
}

/**
 * Fold every Python router's includes across modules, and the routes
 * decorated on an imported router object into that object in its own module:
 * each settled router's routes become its functionRoutes, under its prefix,
 * and an include that lands on no router of an analyzed module, or on an
 * unread one, leaves the including router unread (unreadRouters).
 */
function foldPythonRoutes(files: SourceFileFacts[], routing: Map<string, PythonDeclarative['routers']>): void {
  if (routing.size === 0) return;
  const byPath = new Map(files.map(f => [f.path, f]));
  // Every analyzed module: an include may land on a package's __init__ that only re-exports the router.
  const known = new Set(byPath.keys());
  /**
   * The module and router `name` is in `file`: the router the module builds, or
   * what it imports under that name, followed hop by hop through the
   * re-exports of a package's __init__. A name met twice is a cycle, which
   * settles on nothing.
   */
  const lookup = (file: string, name: string, visited: Set<string>): { file: string; name: string } | undefined => {
    const key = `${file}#${name}`;
    if (visited.has(key)) return undefined;
    visited.add(key);
    const binding = byPath.get(file)?.importBindings?.[name];
    if (!binding) return routing.get(file)?.has(name) ? { file, name } : undefined;
    if (binding.namespace) return undefined;
    const target = resolveImport(file, binding.from, known);
    return target ? lookup(target, binding.imported ?? name, visited) : undefined;
  };
  /** The module and router a reference in `file` names, through its import bindings. */
  const resolveRef = (file: string, ref: string): { file: string; name: string } | undefined => {
    const facts = byPath.get(file);
    const [head, attr] = ref.split('.');
    const binding = facts?.importBindings?.[head];
    if (attr !== undefined) {
      if (!binding?.namespace) return undefined;
      const target = resolveImport(file, binding.from, known);
      return target ? lookup(target, attr, new Set()) : undefined;
    }
    return lookup(file, head, new Set());
  };
  // The routes decorated on an imported router object join it where it lives.
  const joined = new Map<string, RouteFact[]>();
  // And what the importing module adds that does not settle leaves the object unread in its own module.
  const joinedUnread = new Set<string>();
  for (const [file, routers] of routing) {
    for (const [name, router] of routers) {
      const binding = byPath.get(file)?.importBindings?.[name];
      if (!binding || binding.namespace) continue;
      const home = resolveRef(file, name);
      if (!home || home.file === file) continue;
      const key = `${home.file}#${home.name}`;
      if (router.unread) joinedUnread.add(key);
      if (router.routes.length === 0) continue;
      joined.set(key, [...(joined.get(key) ?? []), ...router.routes]);
    }
  }
  /** Whether a prefix holds a path converter, which takes the rest of the path: the routes under it are never matched as written. */
  const open = (prefix: string): boolean => !pythonPathSegments(prefix).exactLength;
  /** A router's routes beneath its own prefix (inner) and that prefix, or undefined when it is unread or not found. */
  const memo = new Map<string, { prefix: string; inner: RouteFact[] } | null>();
  const fold = (file: string, name: string, visiting: Set<string>): { prefix: string; inner: RouteFact[] } | undefined => {
    const key = `${file}#${name}`;
    if (memo.has(key)) return memo.get(key) ?? undefined;
    const router = routing.get(file)?.get(name);
    if (!router || router.unread || joinedUnread.has(key) || visiting.has(key)) { memo.set(key, null); return undefined; }
    visiting.add(key);
    const inner: RouteFact[] = [...router.routes, ...(joined.get(key) ?? [])];
    for (const include of router.includes) {
      const target = resolveRef(file, include.ref);
      const sub = target ? fold(target.file, target.name, visiting) : undefined;
      if (!sub || (sub.inner.length > 0 && open(include.prefix))) { visiting.delete(key); memo.set(key, null); return undefined; }
      const mounted = include.replaces && include.prefixed ? include.prefix : `${include.prefix}/${sub.prefix}`;
      for (const route of sub.inner) inner.push(underPrefix(mounted, route));
    }
    visiting.delete(key);
    if (inner.length > 0 && open(router.prefix)) { memo.set(key, null); return undefined; }
    const result = { prefix: router.prefix, inner };
    memo.set(key, result);
    return result;
  };
  for (const [file, routers] of routing) {
    const facts = byPath.get(file);
    if (!facts) continue;
    const routes: Record<string, RouteFact[]> = {};
    const unread: string[] = [];
    for (const name of routers.keys()) {
      const folded = fold(file, name, new Set());
      if (!folded) { unread.push(name); continue; }
      const seen = new Map<string, RouteFact>();
      for (const route of folded.inner) {
        const full = underPrefix(folded.prefix, route);
        seen.set(routeKey(full), full);
      }
      if (seen.size > 0) routes[name] = [...seen.values()];
    }
    if (Object.keys(routes).length > 0) facts.functionRoutes = { ...(facts.functionRoutes ?? {}), ...routes };
    if (unread.length > 0) facts.unreadRouters = unread.sort();
  }
}

/** What the Python reader adds to a file's pattern facts. */
interface PythonFacts {
  functionParams: Record<string, ParameterFact[][]>;
  functionReturns: Record<string, (string | null)[]>;
  asyncFunctions: string[];
  functionBodies: Record<string, FunctionBodyFact[]>;
  functionCallSites: Record<string, CallSiteFact[]>;
  classMembers: Record<string, ClassMemberFact[]>;
  /** The top-level classes the module names outside their own `class` block. */
  classReferences: string[];
  importBindings: Record<string, ImportBindingFact>;
  fieldTypes: Record<string, string[]>;
  localTypes: Record<string, string[]>;
  imports: string[];
  /** Module-level public functions and classes: no leading underscore, and in `__all__` where the module declares one. */
  exportedNames: string[];
  /** The fields of each declarative data class. */
  typeShapes?: Record<string, TypeShapeFact>;
  /** Each router object, folded across modules once every file is read. */
  routing: PythonDeclarative['routers'];
  reads: CodeReading[];
}

/** One block the walk is inside: a class or a function, and where it was opened. */
interface Block {
  kind: 'class' | 'def';
  name: string;
  indent: number;
  /** For a def: the body record its call sites go to. */
  body?: FunctionBodyFact;
  /** For a def: its parameters' annotations by name, for `self.x = param` field typing. */
  paramTypes?: Map<string, string>;
  /** For a def: the class it is a DIRECT member of (a method), when it is one. */
  methodOf?: string;
}

/** Words a call-shaped `word(` can be that are no call. */
const PYTHON_KEYWORDS = new Set(['if', 'elif', 'while', 'for', 'return', 'not', 'and', 'or', 'in', 'is', 'await', 'lambda', 'yield', 'with', 'assert', 'del', 'raise', 'except', 'else', 'async', 'from', 'import', 'as', 'global', 'nonlocal', 'pass', 'break', 'continue', 'try', 'finally', 'match', 'case']);

/** The names a reader treats as a decorator saying "not an instance method". */
const STATIC_DECORATORS = new Set(['staticmethod', 'classmethod']);

/**
 * Read a Python file's signatures, class members, imports and the call sites
 * of each function body. Never throws: what does not parse is left unread.
 */
function readPython(text: string): PythonFacts {
  const lines = pythonLogicalLines(text);
  const functionParams = new Map<string, ParameterFact[][]>();
  const functionReturns = new Map<string, (string | null)[]>();
  const asyncFunctions: string[] = [];
  const functionBodies = new Map<string, FunctionBodyFact[]>();
  const classMembers = new Map<string, ClassMemberFact[]>();
  const importBindings = new Map<string, ImportBindingFact>();
  const fieldTypes = new Map<string, Set<string>>();
  const localTypes = new Map<string, Set<string>>();
  const imports = new Set<string>();
  const moduleNames: string[] = [];
  let declaredAll: Set<string> | undefined;
  const stack: Block[] = [];
  let decorators: string[] = [];

  const addType = (map: Map<string, Set<string>>, name: string, type: string | undefined): void => {
    const named = type ? typeHead(type) : undefined;
    if (!named) return;
    const set = map.get(name) ?? new Set<string>();
    set.add(named);
    map.set(name, set);
  };

  for (const line of lines) {
    while (stack.length > 0 && line.indent <= stack[stack.length - 1].indent) stack.pop();
    const t = line.tokens;
    const first = t[0];
    const innermost = stack[stack.length - 1];

    // ---- decorators: remembered for the def or class they decorate ----
    if (first.kind === 'op' && first.text === '@') {
      const name = t.slice(1).filter(x => x.kind === 'name' || (x.kind === 'op' && x.text === '.')).map(x => x.text).join('');
      decorators.push(name.split('(')[0]);
      continue;
    }

    // ---- imports (anywhere: a function-local import is still this module's) ----
    if (first.kind === 'name' && first.text === 'import') {
      for (const part of splitTopLevel(t.slice(1))) {
        const asAt = part.findIndex(x => x.kind === 'name' && x.text === 'as');
        const module = (asAt >= 0 ? part.slice(0, asAt) : part).map(x => x.text).join('');
        if (!module) continue;
        imports.add(module);
        const local = asAt >= 0 ? part[asAt + 1]?.text : module.split('.')[0];
        if (local) importBindings.set(local, { from: asAt >= 0 ? module : module.split('.')[0], namespace: true });
      }
      continue;
    }
    if (first.kind === 'name' && first.text === 'from') {
      const importAt = t.findIndex(x => x.kind === 'name' && x.text === 'import');
      if (importAt < 0) continue;
      const module = t.slice(1, importAt).map(x => x.text).join('');
      if (!module) continue;
      imports.add(module);
      const names = t.slice(importAt + 1).filter(x => !(x.kind === 'op' && (x.text === '(' || x.text === ')')));
      for (const part of splitTopLevel(names)) {
        const imported = part[0]?.text;
        if (!imported || imported === '*') continue;
        const asAt = part.findIndex(x => x.kind === 'name' && x.text === 'as');
        const local = asAt >= 0 ? part[asAt + 1]?.text ?? imported : imported;
        if (/^\.+$/.test(module)) {
          // `from . import sibling`: the name is most often a module of the package.
          const specifier = `${module}${imported}`;
          imports.add(specifier);
          importBindings.set(local, { from: specifier, namespace: true });
        } else {
          importBindings.set(local, { from: module, ...(local !== imported ? { imported } : {}) });
        }
      }
      continue;
    }

    // ---- class ----
    const isAsync = first.kind === 'name' && first.text === 'async' && t[1]?.text === 'def';
    const defAt = isAsync ? 1 : 0;
    if (first.kind === 'name' && first.text === 'class' && t[1]?.kind === 'name') {
      const name = t[1].text;
      if (stack.length === 0) {
        moduleNames.push(name);
        if (!classMembers.has(name)) classMembers.set(name, []);
      }
      stack.push({ kind: 'class', name, indent: line.indent });
      decorators = [];
      continue;
    }

    // ---- def ----
    if (t[defAt]?.kind === 'name' && t[defAt].text === 'def' && t[defAt + 1]?.kind === 'name') {
      const name = t[defAt + 1].text;
      const open = defAt + 2;
      const close = t[open]?.text === '(' ? closingIndex(t, open) : -1;
      const methodOf = innermost?.kind === 'class' && stack.length === 1 ? innermost.name : undefined;
      const inClass = innermost?.kind === 'class';
      const isStatic = decorators.some(d => STATIC_DECORATORS.has(d));
      const isStaticMethod = decorators.includes('staticmethod');
      const isAccessor = decorators.some(d => d === 'property' || /\.(setter|getter|deleter)$/.test(d) || d === 'cached_property' || d === 'functools.cached_property');
      decorators = [];
      if (close < 0) continue;
      // Parameters, the receiver of an instance method (self) or a class method (cls) set aside.
      let parts = splitTopLevel(t.slice(open + 1, close));
      if (inClass && !isStaticMethod) parts = parts.slice(1);
      const paramTypes = new Map<string, string>();
      const params: ParameterFact[] = [];
      for (const part of parts) {
        if (part.length === 1 && part[0].kind === 'op' && (part[0].text === '/' || part[0].text === '*')) continue;
        let star = 0;
        let at = 0;
        if (part[0]?.kind === 'op' && (part[0].text === '*' || part[0].text === '**')) { star = part[0].text.length; at = 1; }
        const pname = part[at]?.kind === 'name' ? part[at].text : undefined;
        if (!pname) continue;
        const rest = part.slice(at + 1);
        const eq = rest.findIndex(x => x.kind === 'op' && x.text === '=');
        const annotation = rest[0]?.kind === 'op' && rest[0].text === ':'
          ? annotationText(rest.slice(1, eq >= 0 ? eq : undefined))
          : undefined;
        const fact: ParameterFact = { name: pname, optional: star > 0 || eq >= 0 };
        if (annotation) {
          fact.type = annotation;
          paramTypes.set(pname, annotation);
          addType(localTypes, pname, annotation);
        }
        params.push(fact);
      }
      const colon = topLevelColon(t, close + 1);
      const arrow = t.findIndex((x, i) => i > close && x.kind === 'op' && x.text === '->');
      const returned = arrow >= 0 && colon > arrow ? annotationText(t.slice(arrow + 1, colon)) ?? null : null;
      const body: FunctionBodyFact = { sites: [], ...(methodOf !== undefined ? { container: methodOf } : stack.length === 0 ? {} : { nested: true }) };
      const signatures = functionParams.get(name) ?? [];
      signatures.push(params);
      functionParams.set(name, signatures);
      const returns = functionReturns.get(name) ?? [];
      returns.push(returned);
      functionReturns.set(name, returns);
      if (isAsync) asyncFunctions.push(name);
      const bodies = functionBodies.get(name) ?? [];
      bodies.push(body);
      functionBodies.set(name, bodies);
      if (methodOf !== undefined) {
        classMembers.get(methodOf)?.push({
          name: name === '__init__' ? 'constructor' : name,
          kind: name === '__init__' ? 'constructor' : isAccessor ? 'accessor' : 'method',
          access: name.startsWith('_') && !/^__\w+__$/.test(name) ? 'private' : 'public',
          ...(isStatic ? { static: true } : {}),
        });
      }
      if (stack.length === 0) moduleNames.push(name);
      const block: Block = { kind: 'def', name, indent: line.indent, body, paramTypes, ...(methodOf !== undefined ? { methodOf } : {}) };
      stack.push(block);
      // A one-line body (`def f(self): return self._x.g()`) is read as part of it.
      if (colon >= 0 && colon < t.length - 1) readStatement(t.slice(colon + 1), block);
      continue;
    }
    decorators = [];

    // ---- module-level `__all__` ----
    if (stack.length === 0 && first.kind === 'name' && first.text === '__all__') {
      declaredAll = new Set(t.filter(x => x.kind === 'string').map(x => x.text.replace(/^[rRbBuUfF]*["']+|["']+$/g, '')));
      continue;
    }

    // ---- class body: an annotated field (`store: BlobStore`) ----
    if (innermost?.kind === 'class' && first.kind === 'name' && t[1]?.kind === 'op' && t[1].text === ':') {
      const eq = t.findIndex(x => x.kind === 'op' && x.text === '=');
      addType(fieldTypes, first.text, annotationText(t.slice(2, eq >= 0 ? eq : undefined)));
      continue;
    }

    // ---- a statement inside a function ----
    const fn = [...stack].reverse().find(b => b.kind === 'def');
    if (fn) readStatement(t, fn);
  }

  // Each body's call sites, unioned per name.
  const functionCallSites: Record<string, CallSiteFact[]> = {};
  for (const [name, bodies] of functionBodies) {
    const seen = new Map<string, CallSiteFact>();
    for (const body of bodies) for (const site of body.sites) seen.set(JSON.stringify(site), site);
    functionCallSites[name] = [...seen.values()];
  }
  const exportedNames = moduleNames.filter(name => !name.startsWith('_') && (declaredAll ? declaredAll.has(name) : true));
  const declarative = readPythonDeclarative(lines, importBindings);

  // The top-level classes the module names outside their own `class` block:
  // a name token anywhere else — a call constructing it, a base class, an
  // annotation, an isinstance, a value passed on. A string (`__all__`, a
  // forward reference) is publication or text, not a use.
  const classReferences = new Set<string>();
  let ownClass: { name: string; indent: number } | undefined;
  for (const line of lines) {
    if (ownClass && line.indent <= ownClass.indent) ownClass = undefined;
    const t = line.tokens;
    if (t[0]?.kind === 'name' && t[0].text === 'class' && t[1]?.kind === 'name' && line.indent === 0) {
      ownClass = { name: t[1].text, indent: 0 };
      for (const tok of t.slice(2)) if (tok.kind === 'name' && classMembers.has(tok.text) && tok.text !== ownClass.name) classReferences.add(tok.text);
      continue;
    }
    for (const tok of t) {
      if (tok.kind === 'name' && classMembers.has(tok.text) && tok.text !== ownClass?.name) classReferences.add(tok.text);
    }
  }

  return {
    functionParams: Object.fromEntries(functionParams),
    functionReturns: Object.fromEntries(functionReturns),
    asyncFunctions,
    functionBodies: Object.fromEntries(functionBodies),
    functionCallSites,
    classMembers: Object.fromEntries(classMembers),
    classReferences: [...classReferences].sort(),
    importBindings: Object.fromEntries(importBindings),
    fieldTypes: Object.fromEntries([...fieldTypes].map(([k, v]) => [k, [...v]])),
    localTypes: Object.fromEntries([...localTypes].map(([k, v]) => [k, [...v]])),
    imports: [...imports],
    exportedNames: [...new Set(exportedNames)],
    ...(Object.keys(declarative.typeShapes).length > 0 ? { typeShapes: declarative.typeShapes } : {}),
    routing: declarative.routers,
    reads: PYTHON_READS,
  };

  /**
   * One statement of a function body: its call sites, written by shape, and
   * an instance field it assigns from an annotated parameter
   * (`self._store = store`, `self._store: BlobStore = store`).
   */
  function readStatement(tokens: Token[], fn: Block): void {
    // `self.<field>[: T] = <param>` inside a method: the field is what the parameter is annotated as.
    if (fn.methodOf !== undefined && tokens[0]?.text === 'self' && tokens[1]?.text === '.' && tokens[2]?.kind === 'name') {
      const field = tokens[2].text;
      const eq = tokens.findIndex(x => x.kind === 'op' && x.text === '=');
      if (tokens[3]?.kind === 'op' && tokens[3].text === ':') {
        addType(fieldTypes, field, annotationText(tokens.slice(4, eq >= 0 ? eq : undefined)));
      }
      if (eq >= 0 && tokens.length === eq + 2 && tokens[eq + 1].kind === 'name') {
        addType(fieldTypes, field, fn.paramTypes?.get(tokens[eq + 1].text));
      }
    }
    // Every call: NAME( preceded by a receiver chain of plain names, or nothing.
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.kind !== 'name' || tokens[i + 1]?.text !== '(') continue;
      const before = tokens[i - 1];
      if (before?.kind === 'name' && (before.text === 'def' || before.text === 'class')) continue;
      if (PYTHON_KEYWORDS.has(tok.text) && before?.text !== '.') continue;
      const chain: string[] = [];
      let j = i - 1;
      while (tokens[j]?.text === '.' && tokens[j - 1]?.kind === 'name') {
        chain.unshift(tokens[j - 1].text);
        j -= 2;
      }
      const name = tok.text;
      let site: CallSiteFact;
      if (tokens[j]?.text === '.') {
        // The receiver ends in a call, an index or a literal (`make().x()`): a value again.
        site = { name, member: true };
      } else if (chain.length === 0) {
        site = { name, member: false };
      } else if (chain[0] === 'self' && fn.methodOf !== undefined) {
        site = chain.length === 1 ? { name, member: true, enclosingClass: fn.methodOf }
          : chain.length === 2 ? { name, member: true, field: chain[1] }
            : { name, member: true, receiverPath: ['this', ...chain.slice(1)] };
      } else if (chain.length === 1) {
        site = { name, member: true, via: chain[0] };
      } else {
        site = { name, member: true, receiverPath: chain };
      }
      const key = JSON.stringify(site);
      if (!fn.body!.sites.some(s => JSON.stringify(s) === key)) fn.body!.sites.push(site);
    }
  }
}

/**
 * The class a type annotation names, read as a field's declared type is: the
 * plain name, a dotted one's last segment, `Optional[T]` / `T | None` taken
 * through to T. Undefined for anything else (a generic container, a union of
 * two types): a guess about a collaborator is worse than none.
 */
function typeHead(annotation: string): string | undefined {
  let text = annotation.trim();
  const optional = /^(?:typing\.)?Optional\[(.+)\]$/.exec(text);
  if (optional) text = optional[1].trim();
  const parts = text.split('|').map(p => p.trim()).filter(p => p !== 'None');
  if (parts.length !== 1) return undefined;
  const one = parts[0];
  return /^[A-Za-z_][\w.]*$/.test(one) ? one.split('.').pop() : undefined;
}
