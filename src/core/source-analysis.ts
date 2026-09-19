import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import {
  implementationSourceFiles,
  typeSourceFiles,
  pathKey,
  type CallSiteFact,
  type CodeModel,
  type ImplementationSpec,
  type ImportBindingFact,
  type SourceFileFacts,
  type TypeSpec,
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

/**
 * Per-projectRoot resolution cache. Successful resolutions are kept for the
 * process lifetime (the module is loaded either way); FAILED resolutions are
 * retried after a short TTL so a long-running MCP/hosted process picks up an
 * `npm install typescript` in the analyzed project without a restart.
 */
const tsResolutionCache = new Map<string, { ts: TsModule | null; at: number }>();
const TS_RESOLUTION_RETRY_MS = 30_000;

function resolveTypeScript(projectRoot: string): TsModule | null {
  const cached = tsResolutionCache.get(projectRoot);
  if (cached && (cached.ts !== null || Date.now() - cached.at < TS_RESOLUTION_RETRY_MS)) {
    return cached.ts;
  }
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
  tsResolutionCache.set(projectRoot, { ts, at: Date.now() });
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
  /**
   * Named re-exports (export { a as b } from './x.js'), each carrying the
   * name it is published UNDER and the name it is published FROM. A barrel
   * republishes these exactly as it republishes a star export, so the chase
   * carries their bodies too: the two forms differ in spelling, never in what
   * the barrel publishes.
   */
  namedReexports: { exported: string; local: string; from: string }[];
  /** Cyclomatic complexity per named function-like (max across same-named). */
  complexity: Map<string, number>;
  /**
   * Direct call SITES per named function-like, keyed by their shape signature
   * (union across same-named), so `save(x)` and `ledger.save(x)` stay two
   * facts. A function-like with a body always gets a map, empty when it calls
   * nothing — see SourceFileFacts.functionCallSites.
   */
  calls: Map<string, Map<string, CallSiteFact>>;
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
  const complexity = new Map<string, number>();
  const calls = new Map<string, Map<string, CallSiteFact>>();
  const importBindings = new Map<string, ImportBindingFact>();
  const typeOnlyBindings = new Map<string, string>();
  const fieldTypes = new Map<string, Set<string>>();
  const mutableBindings = new Set<string>();

  /**
   * The dedup key of a call site: its shape, not its number of occurrences.
   * The receiver is part of the shape, so `this.store.save()` and
   * `getStore().save()` stay the two different questions they are.
   */
  const siteKey = (site: CallSiteFact): string =>
    `${site.member ? 'm' : 'b'}:${site.via ?? (site.field ? `this.${site.field}` : '')}:${site.name}`;

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

  // A declared type, read only where the declaration NAMES one: a plain type
  // reference (`store: SpecStore`). A generic, a literal, a union or an
  // intersection resolves to nothing rather than to one arbitrary member of
  // itself — what a field could then be is a question this model does not ask.
  const typeReferenceName = (type: import('typescript').TypeNode | undefined): string | undefined =>
    type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? type.typeName.text : undefined;

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

  // One pass per named function's body collecting classic cyclomatic
  // complexity (decision points + 1) AND direct callee names. Nested NAMED
  // function-likes are excluded — they get their own entries — while
  // anonymous callbacks count into the enclosing function.
  const collectFunctionFacts = (fn: import('typescript').Node & { body?: import('typescript').Node }): { score: number; callees: Map<string, CallSiteFact> } => {
    let score = 1;
    const callees = new Map<string, CallSiteFact>();
    const addSite = (site: CallSiteFact): void => { callees.set(siteKey(site), site); };
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
        // binding, a member access through `this.<field>` resolves through the
        // type the class declares that field with, and a member access through
        // anything else (`getStore().x()`) resolves nowhere without a type
        // checker.
        const callee = node.expression;
        if (ts.isIdentifier(callee)) addSite({ name: callee.text, member: false });
        else if (ts.isPropertyAccessExpression(callee)) {
          const receiver = callee.expression;
          const name = callee.name.text;
          if (ts.isIdentifier(receiver)) addSite({ name, member: true, via: receiver.text });
          else if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
            addSite({ name, member: true, field: receiver.name.text });
          } else addSite({ name, member: true });
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

  const visit = (node: import('typescript').Node): void => {
    const fnName = namedFunctionName(node);
    if (fnName && (node as { body?: import('typescript').Node }).body) {
      const facts = collectFunctionFacts(node as { body?: import('typescript').Node } & import('typescript').Node);
      complexity.set(fnName, Math.max(complexity.get(fnName) ?? 0, facts.score));
      const sites = calls.get(fnName) ?? new Map<string, CallSiteFact>();
      for (const [key, site] of facts.callees) sites.set(key, site);
      calls.set(fnName, sites);
    }
    // What the code DECLARES an instance field to be: a class property's own
    // annotation, and a constructor parameter property's — the shape that
    // writes down what a constructor-injected collaborator is. Read outside
    // the chain below, which is an else-if over the same node kinds.
    if (ts.isPropertyDeclaration(node)) recordFieldType(node.name, node.type);
    else if (ts.isParameter(node) && node.parent && ts.isConstructorDeclaration(node.parent) && isParameterProperty(node)) {
      recordFieldType(node.name, node.type);
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
          if (spec && !node.isTypeOnly && !el.isTypeOnly) {
            namedReexports.push({ exported: el.name.text, local: (el.propertyName ?? el.name).text, from: spec });
          }
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

  // A pure re-export barrel, stated as what it IS: a file whose every
  // top-level statement re-exports another module. Nothing is declared here,
  // so there is nothing for a spec to claim.
  const reexportOnly = sf.statements.length > 0
    && sf.statements.every(st => ts.isExportDeclaration(st) && !!st.moduleSpecifier);

  return { declared, anchors, exported, imports, reexports, starExports, namedReexports, complexity, calls, importBindings, typeOnlyBindings, fieldTypes, mutableBindings, reexportOnly };
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
): { path: string; facts: ExactFacts } | null {
  const target = resolveRelativeModule(filePath, specifier);
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
    chaseReexports(ts, targetFacts, target, projectRoot, visited, exactCache);
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
): void {
  for (const re of facts.namedReexports) {
    const target = reexportTarget(ts, filePath, re.from, projectRoot, visited, exactCache);
    if (target) carryBody(facts, target.facts, target.path, re.local, re.exported, projectRoot);
  }
  for (const spec of facts.starExports) {
    const target = reexportTarget(ts, filePath, spec, projectRoot, visited, exactCache);
    if (!target) continue;
    for (const name of target.facts.exported) {
      facts.exported.add(name);
      facts.declared.add(name);
      carryBody(facts, target.facts, target.path, name, name, projectRoot);
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
 * Every source file under the declared source roots, as canonical
 * project-relative keys in walk order — the files no spec need name, which is
 * the unclaimed-source rule's whole subject.
 *
 * Each root is resolved and containment-checked within projectRoot (an
 * absolute or parent-escaping root is skipped, never walked), a directory is
 * walked recursively and a file stands for itself, and a file counts as source
 * when its extension names a language the analyzer knows. Directories named
 * `node_modules` and directories whose name begins with a dot are never
 * descended into, so a broad root cannot turn the walk pathological. A path
 * at, or under, any `exclude` entry is left out entirely — vendored or
 * generated code is neither analyzed nor carried as debt.
 *
 * Declaring no roots yields no files, which is what keeps the unclaimed-source
 * check opt-in.
 */
function walkSourceRoots(
  sourceRoots: readonly string[],
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
    if (!EXTENSION_LANGUAGE[path.extname(key).toLowerCase()]) return;
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

  for (const root of sourceRoots) {
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
  const rootFiles = walkSourceRoots(sourceRoots, exclude, projectRoot);

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
    const language = EXTENSION_LANGUAGE[path.extname(sourcePath).toLowerCase()];

    let analyzed: Omit<SourceFileFacts, 'path' | 'status' | 'language'>;
    if (language === 'typescript' || language === 'javascript') {
      const ts = resolveTypeScript(projectRoot);
      if (ts) {
        try {
          const facts = walkExact(ts, text, absolute);
          chaseReexports(ts, facts, absolute, projectRoot, new Set([absolute]), exactCache);
          analyzed = {
            analysisGrade: 'exact',
            declaredNames: [...facts.declared],
            anchoredNames: [...facts.anchors],
            exportedNames: [...facts.exported],
            imports: [...facts.imports],
            reexports: [...facts.reexports],
            functionComplexity: Object.fromEntries(facts.complexity),
            functionCallSites: Object.fromEntries([...facts.calls].map(([k, v]) => [k, [...v.values()]])),
            importBindings: Object.fromEntries(facts.importBindings),
            typeOnlyBindings: Object.fromEntries(facts.typeOnlyBindings),
            fieldTypes: Object.fromEntries([...facts.fieldTypes].map(([k, v]) => [k, [...v]])),
            topLevelMutableBindings: [...facts.mutableBindings],
            reexportOnly: facts.reexportOnly,
          };
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

  return { files, projectRoot, rootFiles };
}
