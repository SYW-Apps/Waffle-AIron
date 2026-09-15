import * as path from 'path';

// ---------------------------------------------------------------------------
// The source-code model the validator's code↔spec rules read: pure analysis
// facts per resolved source path, built once per validation run by the source
// analysis adapter (src/core/source-analysis.ts) and injected into the rule
// context. Keyed by resolved source path, so implementations and methods that
// legitimately share one file (N:1 realization) read the same facts.
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
  /**
   * Cyclomatic complexity per named function-like (function/method/accessor
   * declarations, and function/arrow initializers of named slots). EXACT grade
   * only — lower grades omit the map rather than guess. Same-named functions
   * in one file record their maximum. Fuel for the detail-sufficiency lint.
   */
  functionComplexity?: Record<string, number>;
  /**
   * Direct callee names per named function-like: identifiers and property
   * names invoked as calls inside the function body (nested NAMED functions
   * excluded — they carry their own entries; anonymous callbacks included).
   * EXACT grade only. Same-named functions union their sets. Fuel for the
   * call-step realization check (Level 3).
   */
  functionCalls?: Record<string, string[]>;
  /**
   * Module-scope mutable bindings (`let`/`var` at the top level of the file).
   * EXACT grade only. The static approximation of held state a logic
   * component may be hiding — fuel for the HIDDEN_STATE lint. (Mutation of
   * const-bound containers is invisible to this collection; the lint says so.)
   */
  topLevelMutableBindings?: string[];
}

export interface CodeModel {
  /** One facts entry per distinct resolved sourcePath (missing/escaped/unreadable included). */
  files: SourceFileFacts[];
  /** The root every sourcePath was resolved and containment-checked against. */
  projectRoot: string;
}

/**
 * code_model.pathKey — the canonical key form of a source path in the model:
 * forward slashes, no leading `./`. Every facts entry is stored under it, and
 * every lookup or path comparison uses it.
 */
export function pathKey(sourcePath: string): string {
  return sourcePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * code_model.factsFor — the facts entry for a source path, looked up by its
 * canonical key; undefined when the run analyzed no such path. The model holds
 * one entry per key; were it to hold two, the later one answers, as it does in
 * the keyed indexes the rules build over the same files.
 */
export function factsFor(model: CodeModel, sourcePath: string): SourceFileFacts | undefined {
  const key = pathKey(sourcePath);
  for (let i = model.files.length - 1; i >= 0; i--) {
    if (pathKey(model.files[i].path) === key) return model.files[i];
  }
  return undefined;
}

/**
 * source_file_facts.resolveImport — resolve one of a file's relative import
 * specifiers against a set of known source paths, purely (no I/O): join it with
 * the importing file's directory, then try the joined path, `.js` swapped for
 * `.ts` or `.tsx`, the `.ts`, `.tsx` and `.js` extensions, and an index file.
 * Undefined for a bare package specifier or when nothing matches.
 */
export function resolveImport(fromFile: string, specifier: string, knownPaths: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = pathKey(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier)));
  const candidates = [
    joined,
    joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx'),
    `${joined}.ts`, `${joined}.tsx`, `${joined}.js`,
    `${joined}/index.ts`, `${joined}/index.js`,
  ];
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  return undefined;
}
