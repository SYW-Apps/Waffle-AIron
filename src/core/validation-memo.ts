// ---------------------------------------------------------------------------
// validation_memo + validation_memo_cache (sdd_validator).
//
// The owner's gate takes tens of seconds on a large tree, and a dev page view,
// a live refresh or an agent's repeated sdd_validate_tree asks for the same run
// again and again. The memo answers the last run with the same options while
// nothing the gate reads has changed: the project's .wai/ files, each declared
// member's .wai/ files, and the source files the gate's code model reads, all
// compared by path, size and modification time. Otherwise it runs the gate and
// remembers the result.
//
// The cache is process-local and never written to disk: a restart starts
// empty, and an absent entry only costs one validation run.
// ---------------------------------------------------------------------------
import * as path from 'path';
import { createHash } from 'crypto';
import type { RulesConfig } from '../models/project.js';
import {
  scanAllSpecs,
  loadProjectConfig,
  loadImplementationSpecs,
  loadTypeSpecs,
} from './adapters/validator-core.js';
import * as files from '../io/files.js';
import { fingerprintSources } from './source-analysis.js';
import { getProjectRoot, declaredMemberDirs } from '../utils/fs.js';
import { validateProjectFresh, validateAsCompleteFresh, type ValidationOptions, type ValidationResult } from './validation.js';

/** One remembered owner's-gate run: its options, the fingerprints of what it read, its result. */
export interface ValidationMemoEntry {
  optionsKey: string;
  treeFingerprint: string;
  codeFingerprint: string;
  result: ValidationResult;
}

// ---------------------------------------------------------------------------
// validation_memo_cache — one entry per project root and options key.
// ---------------------------------------------------------------------------

const held = new Map<string, Map<string, ValidationMemoEntry>>();

/** The entry held for this project root and options, or none. */
export function get(root: string, optionsKey: string): ValidationMemoEntry | undefined {
  return held.get(root)?.get(optionsKey);
}

/** Hold this entry for the project root under its options key, replacing any earlier one. */
export function put(root: string, entry: ValidationMemoEntry): void {
  let byOptions = held.get(root);
  if (!byOptions) {
    byOptions = new Map();
    held.set(root, byOptions);
  }
  byOptions.set(entry.optionsKey, entry);
}

// ---------------------------------------------------------------------------
// validation_memo — answer the remembered run, or run the gate and remember it.
// ---------------------------------------------------------------------------

/**
 * The owner's gate, answered from the last run with the same options while
 * nothing it reads has changed. Takes the same arguments as the gate.
 */
export function validateProject(
  options?: RulesConfig | ValidationOptions,
  projectType: string = 'backend',
): ValidationResult {
  return remembered('owner', normalizeOptions(options, projectType), () => validateProjectFresh(options, projectType));
}

/**
 * The as-complete gate, answered from the last as-complete run with the same
 * options while nothing it reads has changed; remembered apart from the owner's gate.
 */
export function validateAsComplete(options?: ValidationOptions): ValidationResult {
  return remembered('as-complete', { ...(options ?? {}) }, () => validateAsCompleteFresh(options));
}

/** Steps 1-14 of either gate: fingerprint what it reads, answer the remembered run or run it. */
function remembered(gate: string, normalized: ValidationOptions, run: () => ValidationResult): ValidationResult {
  // Step 1: scan the specs, so the loader's issues are this tree's whether or not the gate runs.
  scanAllSpecs();
  // Step 2: the project configuration, for its source roots and exclusions. A configuration the
  // loader refuses leaves them unset: the gate reports it, the memo never fails where the gate would not.
  let config: ReturnType<typeof loadProjectConfig> = null;
  try {
    config = loadProjectConfig();
  } catch {
    config = null;
  }
  // Step 3: the options as a stable key, marked with the gate it answers.
  const optionsKey = `${gate}:${keyOf(normalized)}`;
  const root = path.resolve(getProjectRoot());
  // Steps 4-5: every file under .wai/ and each declared member's .wai/, folded by path, size and mtime.
  const treeFingerprint = fingerprintTree(root);
  // Steps 6-7: the implementation and type specs, whose source paths the code model reads.
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  // Step 8: the source files the gate's code model reads.
  const conformance = (normalized.rules ?? config?.rules)?.conformance;
  const codeFingerprint = fingerprintSources(
    implementations,
    types,
    getProjectRoot(),
    conformance?.sourceRoots ?? [],
    conformance?.exclude ?? [],
  );
  // Step 9: the remembered run for this root and options.
  const entry = get(root, optionsKey);
  // Step 10: is it a run of the same files?
  if (entry && entry.treeFingerprint === treeFingerprint && entry.codeFingerprint === codeFingerprint) {
    // Step 11: a copy of the remembered result.
    return structuredClone(entry.result);
  }
  // Step 12: run the gate.
  const result = run();
  // Step 13: remember it with the options key and both fingerprints.
  put(root, { optionsKey, treeFingerprint, codeFingerprint, result: structuredClone(result) });
  // Step 14: a copy of the result.
  return result;
}

/** The two argument forms the gate takes, read as one options object (as the gate reads them). */
function normalizeOptions(options: RulesConfig | ValidationOptions | undefined, projectType: string): ValidationOptions {
  const keys = ['scopeSubsystem', 'memberDepth', 'rules', 'projectType', 'extensions', 'treatAllAsComplete', 'family', 'packSelections'];
  if (options && keys.some((k) => k in options)) {
    const opts = options as ValidationOptions;
    return { ...opts, projectType: opts.projectType ?? projectType };
  }
  return { rules: options as RulesConfig | undefined, projectType };
}

// Loaded extensions are an in-memory object: a run passed the same object keys
// the same, a different object never matches an earlier run.
const extensionIds = new WeakMap<object, number>();
let nextExtensionId = 1;

/** The options in a stable spelling: rules, project type, scope, strictness, member depth, family, packs. */
function keyOf(options: ValidationOptions): string {
  let extensions: number | null = null;
  if (options.extensions) {
    extensions = extensionIds.get(options.extensions) ?? nextExtensionId++;
    extensionIds.set(options.extensions, extensions);
  }
  return stableJson({
    rules: options.rules ?? null,
    projectType: options.projectType ?? null,
    scopeSubsystem: options.scopeSubsystem ?? null,
    memberDepth: options.memberDepth ?? null,
    treatAllAsComplete: options.treatAllAsComplete ?? false,
    family: options.family ?? false,
    packSelections: options.packSelections ?? null,
    extensions,
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The .wai/ files of the root and of every member folder it declares (members' members too). */
function fingerprintTree(root: string): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const visit = (projectRoot: string): void => {
    const key = path.resolve(projectRoot);
    if (seen.has(key)) return;
    seen.add(key);
    walk(path.join(key, '.wai'), path.relative(root, key) || '.', lines);
    for (const member of declaredMemberDirs(key)) visit(member);
  };
  visit(root);
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function walk(dir: string, label: string, lines: string[]): void {
  let entries: files.DirEntry[];
  try {
    entries = files.listEntries(dir);
  } catch {
    lines.push(`${label}:absent`);
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, `${label}/${entry.name}`, lines);
      continue;
    }
    const stat = files.statOrNull(full);
    lines.push(`${label}/${entry.name}:${stat ? `${stat.size}:${stat.mtimeMs}` : 'missing'}`);
  }
}
