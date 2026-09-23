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
  type MethodImplementation,
  type ShapeMemberFact,
  type SourceFileFacts,
  type TypeShapeFact,
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
  /**
   * The type names each locally BOUND name is declared with — a parameter's
   * annotation, and an annotated variable declaration's. Same-named bindings
   * union, because the file cannot say which function a call site sits in,
   * and a receiver is as often a parameter of an ENCLOSING function as of the
   * one that calls it.
   */
  localTypes: Map<string, Set<string>>;
  /**
   * The members of each named shape the file declares, by declaration name
   * — an interface's, a class's, a type literal alias's, and a derived
   * alias's after the one hop to the schema value it names.
   */
  typeShapes: Map<string, TypeShapeFact>;
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
  const localTypes = new Map<string, Set<string>>();
  const typeShapes = new Map<string, TypeShapeFact>();
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
    site.via ?? (site.field ? `this.${site.field}` : site.constructed ? `new ${site.constructed}` : '');
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
    for (const member of members) {
      // A constructor, an index signature and a call signature name no member.
      const memberName = member.name ? propertyNameText(member.name) : undefined;
      if (!memberName) continue;
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member)) {
        methods.push(memberName);
      } else if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
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

  // The BASE `.object({…})` call of a chained schema expression. Walking to
  // the base is the whole of it: `z.object({…}).refine(fn, { message })` hands
  // the REFINE OPTIONS to whoever takes the first object literal it meets, and
  // the shape then reads as one field called `message`.
  const baseObjectLiteral = (
    expression: import('typescript').Expression,
  ): import('typescript').ObjectLiteralExpression | undefined => {
    let node: import('typescript').Node | undefined = expression;
    const walked = new Set<import('typescript').Node>();
    while (node && !walked.has(node)) {
      walked.add(node);
      if (ts.isCallExpression(node)) {
        const callee: import('typescript').Expression = node.expression;
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'object') {
          const literal = node.arguments.find(argument => ts.isObjectLiteralExpression(argument));
          if (literal) return literal as import('typescript').ObjectLiteralExpression;
        }
        node = callee;
      } else if (ts.isPropertyAccessExpression(node)) {
        node = node.expression;
      } else break;
    }
    return undefined;
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
        // binding, or else through the type the file annotates that name
        // with, a member access through `this.<field>` resolves through the
        // type the class declares that field with, a member access on a
        // freshly CONSTRUCTED value resolves through the class name the code
        // names right there, and a member access through anything else
        // (`getStore().x()`) resolves nowhere without a type checker.
        const callee = node.expression;
        if (ts.isIdentifier(callee)) addSite({ name: callee.text, member: false });
        else if (ts.isPropertyAccessExpression(callee)) {
          const receiver = callee.expression;
          const name = callee.name.text;
          if (ts.isIdentifier(receiver)) addSite({ name, member: true, via: receiver.text });
          else if (ts.isPropertyAccessExpression(receiver) && receiver.expression.kind === ts.SyntaxKind.ThisKeyword) {
            addSite({ name, member: true, field: receiver.name.text });
          } else if (ts.isNewExpression(receiver) && ts.isIdentifier(receiver.expression)) {
            // `new ApprovalRegistry(store).create()` — only a plainly named
            // class, since `new ns.Registry()` is a property of a value again.
            addSite({ name, member: true, constructed: receiver.expression.text });
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
      recordDeclaredShape(node.name.text, node.members, (node.heritageClauses?.length ?? 0) > 0);
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (ts.isTypeLiteralNode(node.type)) recordDeclaredShape(node.name.text, node.type.members, false);
      else {
        const constant = inferredSchemaConstant(node.type);
        if (constant) derivedAliases.push({ name: node.name.text, constant });
      }
    }
    // The value half of that hop, kept as the walk meets it. First binding
    // wins: a name rebound later is a different value, and the shape a spec
    // claims is the one the file introduces under the name.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && !schemaConstants.has(node.name.text)) {
      schemaConstants.set(node.name.text, node.initializer);
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

  // The derived hop, now that both halves have been seen. ONE hop and no
  // more: an alias whose schema const this file does not declare, or whose
  // chain never reaches an object literal, records NO shape. Silence is the
  // honest answer — the type still has to be DECLARED somewhere, which is
  // `typeRealization`'s question, and a guessed member list would be read as
  // measurement by everything downstream.
  for (const alias of derivedAliases) {
    if (typeShapes.has(alias.name)) continue;
    const initializer = schemaConstants.get(alias.constant);
    if (!initializer) continue;
    const literal = baseObjectLiteral(initializer);
    if (!literal) continue;
    typeShapes.set(alias.name, { origin: 'derived', fields: schemaMembers(literal), methods: [] });
  }

  // A pure re-export barrel, stated as what it IS: a file whose every
  // top-level statement re-exports another module. Nothing is declared here,
  // so there is nothing for a spec to claim.
  const reexportOnly = sf.statements.length > 0
    && sf.statements.every(st => ts.isExportDeclaration(st) && !!st.moduleSpecifier);

  return { declared, anchors, exported, imports, reexports, starExports, namedReexports, complexity, calls, importBindings, typeOnlyBindings, fieldTypes, localTypes, typeShapes, mutableBindings, reexportOnly };
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
  const rootFiles = walkDeclaredRoots(sourceRoots, exclude, projectRoot);

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
            localTypes: Object.fromEntries([...facts.localTypes].map(([k, v]) => [k, [...v]])),
            typeShapes: Object.fromEntries(facts.typeShapes),
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
  /** Test files that IMPORT that symbol. The high-confidence list. */
  imported: string[];
  /**
   * Test files that name the symbol without importing it — usually a test
   * driving the method through a portal or a helper. Empty when
   * `indiscriminate` is true.
   */
  mentioned: string[];
  /**
   * True when the bare name matched more than a tenth of the walked test files,
   * so mentioning it carries no signal and `mentioned` was withheld.
   */
  indiscriminate: boolean;
}

/** What one walked test file says about the names a search is looking for. */
interface TestFileNames {
  /** Canonical project-relative path, as the answer names it. */
  path: string;
  /** Names bound by a named-import clause — both sides of a rename. */
  imports: Set<string>;
  /** Every word-boundary identifier in the file: the universal floor, exactly as the generic grade reads one. */
  words: Set<string>;
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
    const words = new Set<string>();
    for (const m of text.matchAll(IDENTIFIER_RE)) words.add(m[0]);
    scanned.push({ path: key, imports, words });
  }
  return scanned;
}

/**
 * Find the tests that encode a given set of methods.
 *
 * Walks the declared test roots on the SOURCE walk's own containment terms —
 * an absolute or parent-escaping root is refused rather than walked,
 * node_modules and dot-directories are skipped — and searches each method's
 * `symbol`, or its name when it declares none. A file that imports that name
 * is `imported`; one that merely names it is `mentioned`, unless the name
 * matched more than a tenth of the walked files, in which case the mention
 * list is withheld and `indiscriminate` says why.
 *
 * Declaring no test roots walks nothing and answers empty, which is what keeps
 * this opt-in. A method nothing references contributes no entry: the answer is
 * the tests to revisit, and an entry naming none is not one.
 */
export function findTestsReferencing(
  methods: ReadonlyArray<Pick<MethodImplementation, 'name' | 'symbol'>>,
  projectRoot: string,
  testRoots: readonly string[] = [],
): TestsToRevisit[] {
  // Steps 1-2: resolve and walk the declared roots, and read what they hold.
  const scanned = readTestFiles(testRoots, projectRoot);
  if (scanned.length === 0) return [];

  // A tenth of the WALKED suite, so the threshold scales with the project
  // rather than with a number somebody once picked for theirs.
  const indiscriminateAbove = scanned.length / 10;

  const found: TestsToRevisit[] = [];
  for (const method of methods) {
    // Step 3: the name to search for.
    const symbol = method.symbol ?? method.name;
    // Step 4: the binding and the bare mention, kept apart.
    const imported = scanned.filter(f => f.imports.has(symbol)).map(f => f.path);
    const mentioned = scanned.filter(f => !f.imports.has(symbol) && f.words.has(symbol)).map(f => f.path);
    // Steps 5-6: a name like `project` or `status` matches most of the suite,
    // and a list that long is not an answer.
    const indiscriminate = mentioned.length > indiscriminateAbove;
    if (imported.length === 0 && mentioned.length === 0) continue;
    // Step 7.
    found.push({
      method: method.name,
      symbol,
      imported,
      mentioned: indiscriminate ? [] : mentioned,
      indiscriminate,
    });
  }
  return found;
}
