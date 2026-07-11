import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import type { ImplementationSpec } from '../models/index.js';

// ---------------------------------------------------------------------------
// Source Analysis Adapter — the validator subsystem's only source-code I/O.
//
// Resolves every distinct L4 sourcePath inside the project root, reads the
// files, and produces the pure CodeModel the structural-conformance rule
// family consumes. Analysis is tiered so wairon carries ZERO mandatory parser
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

export type AnalysisGrade = 'exact' | 'pattern' | 'generic';
export type SourceFileStatus = 'analyzed' | 'missing' | 'escaped' | 'unreadable';

export interface SourceFileFacts {
  /** Project-relative resolved source path (many implementations may share it, N:1). */
  path: string;
  status: SourceFileStatus;
  /** Effective language the file was analyzed as. */
  language?: string;
  analysisGrade?: AnalysisGrade;
  /**
   * Declaration-tier anchors: named declarations at any nesting depth,
   * destructuring bindings, object-literal keys, import bindings, and export
   * specifiers (export-* barrels chased through relative specifiers).
   */
  declaredNames: string[];
  /** Weaker anchors: exact string-literal occurrences (tool/route registrations). */
  anchoredNames: string[];
  /** Exported bindings (Level 2 dependency-conformance and UNDECLARED_EXPORT fuel). */
  exportedNames: string[];
  /**
   * Runtime import/require module specifiers (dependency-conformance fuel).
   * Type-only imports and export-from specifiers are excluded — type coupling
   * is allowed by default, and re-exporting is surface republication, not
   * collaboration.
   */
  imports: string[];
  /** Module specifiers of export-from declarations (surface republication). */
  reexports: string[];
}

export interface CodeModel {
  /** One facts entry per distinct resolved sourcePath (missing/escaped/unreadable included). */
  files: SourceFileFacts[];
  /** The root every sourcePath was resolved and containment-checked against. */
  projectRoot: string;
}

export function emptyCodeModel(): CodeModel {
  return { files: [], projectRoot: '' };
}

// ---------------------------------------------------------------------------
// Language detection + declarative pattern tables
// ---------------------------------------------------------------------------

const EXTENSION_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.rs': 'rust', '.go': 'go', '.cs': 'csharp', '.java': 'java',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift',
};

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

const JS_PATTERNS: LanguagePatterns = {
  ...C_FAMILY_COMMENTS,
  declarations: [
    /\b(?:function|class|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var|type)\s+([A-Za-z_$][\w$]*)/g,
    // property/arrow style: `name: (…) =>`, `name = function`, `name(…) {` members
    /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?(?:function\b|\()/g,
    /(?:^|\s)(?:public|private|protected|static|async|get|set)\s+([A-Za-z_$][\w$]*)\s*\(/g,
    // named import bindings realize forwarding adapters
    /\bimport\s*\{([^}]*)\}/g,
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
      /\b(?:public|private|protected|internal|static|async|override|virtual)\s+[\w<>,[\]?\s]*?\b([A-Za-z_]\w*)\s*\(/g,
    ],
    imports: [/\busing\s+([\w.]+)\s*;/g],
    exportMarkers: [/^\s*public\b/],
  },
  java: {
    ...C_FAMILY_COMMENTS,
    declarations: [
      /\b(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/g,
      /\b(?:public|private|protected|static|final|synchronized)\s+[\w<>,[\]?\s]*?\b([A-Za-z_]\w*)\s*\(/g,
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
      for (const piece of captured.split(',')) {
        const name = (piece.includes(' as ') ? piece.split(' as ')[1] : piece).trim();
        if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
      }
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

const tsResolutionCache = new Map<string, TsModule | null>();

function resolveTypeScript(projectRoot: string): TsModule | null {
  const cached = tsResolutionCache.get(projectRoot);
  if (cached !== undefined) return cached;
  let ts: TsModule | null = null;
  // The analyzed project's own compiler first, wairon's installation second.
  const bases = [path.join(projectRoot, 'package.json'), __filename];
  for (const base of bases) {
    try {
      const req = createRequire(base);
      ts = req('typescript') as TsModule;
      break;
    } catch {
      // keep trying — absence is a supported state, not an error
    }
  }
  tsResolutionCache.set(projectRoot, ts);
  return ts;
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
}

function walkExact(ts: TsModule, sourceText: string, fileName: string): ExactFacts {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const declared = new Set<string>();
  const anchors = new Set<string>();
  const exported = new Set<string>();
  const imports = new Set<string>();
  const reexports = new Set<string>();
  const starExports: string[] = [];

  const addBindingNames = (name: import('typescript').BindingName): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingNames(el.name);
      }
    }
  };

  const propertyNameText = (name: import('typescript').PropertyName): string | undefined => {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    if (ts.isPrivateIdentifier(name)) return name.text;
    return undefined;
  };

  const hasExportModifier = (node: import('typescript').Node): boolean => {
    const mods = (node as { modifiers?: readonly import('typescript').ModifierLike[] }).modifiers;
    return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
  };

  const visit = (node: import('typescript').Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)
      || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) {
      const name = node.name && ts.isIdentifier(node.name) ? node.name.text : undefined;
      if (name) {
        declared.add(name);
        if (hasExportModifier(node)) exported.add(name);
      }
    } else if (ts.isVariableStatement(node)) {
      const isExported = hasExportModifier(node);
      for (const decl of node.declarationList.declarations) {
        addBindingNames(decl.name);
        if (isExported && ts.isIdentifier(decl.name)) exported.add(decl.name.text);
      }
    } else if (ts.isVariableDeclaration(node)) {
      // nested declarations (inside functions) — parameters are deliberately excluded
      addBindingNames(node.name);
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
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      if (clause?.name) declared.add(clause.name.text);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) declared.add(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) declared.add(el.name.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (spec) reexports.add(spec);
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const el of node.exportClause.elements) {
          declared.add(el.name.text);
          exported.add(el.name.text);
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

  return { declared, anchors, exported, imports, reexports, starExports };
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
 * Chase `export *` barrels: merge the (transitive) exported names of every
 * relative star-export target into the facts, so a pure re-export barrel like
 * core_portal's index.ts realizes the names it publishes.
 */
function chaseStarExports(
  ts: TsModule,
  facts: ExactFacts,
  filePath: string,
  projectRoot: string,
  visited: Set<string>,
  exactCache: Map<string, ExactFacts | null>,
): void {
  for (const spec of facts.starExports) {
    const target = resolveRelativeModule(filePath, spec);
    if (!target || visited.has(target)) continue;
    // containment: never chase outside the analyzed project
    if (path.relative(projectRoot, target).startsWith('..')) continue;
    visited.add(target);

    let targetFacts = exactCache.get(target);
    if (targetFacts === undefined) {
      try {
        targetFacts = walkExact(ts, fs.readFileSync(target, 'utf8'), target);
      } catch {
        targetFacts = null;
      }
      exactCache.set(target, targetFacts);
    }
    if (!targetFacts) continue;
    chaseStarExports(ts, targetFacts, target, projectRoot, visited, exactCache);
    for (const name of targetFacts.exported) {
      facts.exported.add(name);
      facts.declared.add(name);
    }
  }
}

// ---------------------------------------------------------------------------
// The adapter entry point
// ---------------------------------------------------------------------------

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, Math.min(buffer.length, 4096));
  return probe.includes(0);
}

/**
 * Build the pure source-code model for a validation run: one SourceFileFacts
 * per distinct sourcePath across the given implementations, resolved and
 * containment-checked within projectRoot, analyzed at the best available
 * grade. Deterministic over file contents; a single file's analysis failure
 * degrades that file to the generic scan, never aborts the run.
 */
export function buildCodeModel(implementations: ImplementationSpec[], projectRoot: string): CodeModel {
  const files: SourceFileFacts[] = [];
  const seen = new Set<string>();
  const exactCache = new Map<string, ExactFacts | null>();

  for (const impl of implementations) {
    const sourcePath = impl.sourcePath;
    if (!sourcePath || seen.has(sourcePath)) continue;
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
    const language = EXTENSION_LANGUAGE[path.extname(sourcePath).toLowerCase()];

    let analyzed: Omit<SourceFileFacts, 'path' | 'status' | 'language'>;
    if (language === 'typescript' || language === 'javascript') {
      const ts = resolveTypeScript(projectRoot);
      if (ts) {
        try {
          const facts = walkExact(ts, text, absolute);
          chaseStarExports(ts, facts, absolute, projectRoot, new Set([absolute]), exactCache);
          analyzed = {
            analysisGrade: 'exact',
            declaredNames: [...facts.declared],
            anchoredNames: [...facts.anchors],
            exportedNames: [...facts.exported],
            imports: [...facts.imports],
            reexports: [...facts.reexports],
          };
        } catch {
          analyzed = analyzeGeneric(text);
        }
      } else {
        analyzed = analyzeWithPatterns(text, LANGUAGE_PATTERNS[language]);
      }
    } else if (language && LANGUAGE_PATTERNS[language]) {
      analyzed = analyzeWithPatterns(text, LANGUAGE_PATTERNS[language]);
    } else {
      analyzed = analyzeGeneric(text);
    }

    files.push({ path: sourcePath, status: 'analyzed', language, ...analyzed });
  }

  return { files, projectRoot };
}
