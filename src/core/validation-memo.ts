// ---------------------------------------------------------------------------
// validation_memo + validation_memo_cache + validation_result_file (sdd_validator).
//
// The owner's gate takes tens of seconds on a large tree, and a dev page view,
// a live refresh or an agent's repeated sdd_validate_tree asks for the same run
// again and again. The memo answers an earlier run with the same options while
// nothing the gate reads has changed in content: the project's .wai/ files
// (its local-state folder .wai/.local left out), each declared member's .wai/
// files, and the source files the gate's code model reads. It looks in this
// process's memory first, then in the result file a process before it left in
// the user cache, and otherwise runs the gate and remembers the result in both.
//
// Fingerprints are of content, not modification times, so a branch switched
// away and back is recognised. Both caches are loss-safe: an absent entry only
// costs one validation run.
// ---------------------------------------------------------------------------
import * as path from 'path';
import { createHash } from 'crypto';
import type { RulesConfig } from '../models/project.js';
import {
  scanAllSpecs,
  loadProjectConfig,
  loadImplementationSpecs,
  loadTypeSpecs,
  loadProjectExtensions,
} from './adapters/validator-core.js';
import * as files from '../io/files.js';
import * as contentFingerprint from './content-fingerprint.js';
import * as codeModelLoader from './lookup/code-model-loader.js';
import { WAIRON_VERSION } from '../config/defaults.js';
import { getProjectRoot, declaredMemberDirs, userCacheDir } from '../utils/fs.js';
import { validateProjectFresh, validateAsCompleteFresh, type ValidationOptions, type ValidationResult } from './validation.js';

/** One remembered gate run: its options, the fingerprints of what it read, its result. */
export interface ValidationMemoEntry {
  optionsKey: string;
  treeFingerprint: string;
  codeFingerprint: string;
  result: ValidationResult;
}

const MEMO_ENTRIES = 8;

// ---------------------------------------------------------------------------
// validation_memo_cache — the last few entries per project root and options key.
// ---------------------------------------------------------------------------

const held = new Map<string, Map<string, ValidationMemoEntry[]>>();

/** The entry held for this project root and options with exactly these fingerprints, or none. */
export function get(root: string, optionsKey: string, treeFingerprint: string, codeFingerprint: string): ValidationMemoEntry | undefined {
  return held.get(root)?.get(optionsKey)?.find((e) => e.treeFingerprint === treeFingerprint && e.codeFingerprint === codeFingerprint);
}

/** Hold this entry under its options key, newest first, replacing an entry with the same fingerprints and dropping the oldest past eight. */
export function put(root: string, entry: ValidationMemoEntry): void {
  let byOptions = held.get(root);
  if (!byOptions) {
    byOptions = new Map();
    held.set(root, byOptions);
  }
  const kept = (byOptions.get(entry.optionsKey) ?? []).filter(
    (e) => e.treeFingerprint !== entry.treeFingerprint || e.codeFingerprint !== entry.codeFingerprint,
  );
  byOptions.set(entry.optionsKey, [entry, ...kept].slice(0, MEMO_ENTRIES));
}

// ---------------------------------------------------------------------------
// validation_result_file — one JSON file per project root in the user cache.
// ---------------------------------------------------------------------------

/** What the file holds per entry: the memo entry with the release that wrote it. */
interface ResultFileEntry extends ValidationMemoEntry {
  release: string;
}

/** The result file of one project root, named by the sha256 of the resolved root. */
function resultFilePath(root: string): string {
  const name = createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32);
  return path.join(userCacheDir(), 'validation-results', `${name}.json`);
}

/** The entries on the root file; a missing, unreadable or malformed file is none. */
function readResultFile(root: string): ResultFileEntry[] {
  try {
    const parsed = JSON.parse(files.readText(resultFilePath(root))) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is ResultFileEntry => {
      const r = e as Partial<ResultFileEntry> | null;
      return !!r && typeof r === 'object'
        && typeof r.release === 'string' && typeof r.optionsKey === 'string'
        && typeof r.treeFingerprint === 'string' && typeof r.codeFingerprint === 'string'
        && !!r.result && typeof r.result === 'object';
    });
  } catch {
    return [];
  }
}

/** The entry on disk for this root, options and fingerprints written by this wairon release, or none. */
export function fileGet(root: string, optionsKey: string, treeFingerprint: string, codeFingerprint: string): ValidationMemoEntry | undefined {
  const found = readResultFile(root).find((e) =>
    e.release === WAIRON_VERSION && e.optionsKey === optionsKey
    && e.treeFingerprint === treeFingerprint && e.codeFingerprint === codeFingerprint);
  return found && { optionsKey, treeFingerprint, codeFingerprint, result: found.result };
}

/** Hold this entry on disk for the root under this release, newest first, keeping eight. Any failure is ignored. */
export function filePut(root: string, entry: ValidationMemoEntry): void {
  try {
    const kept = readResultFile(root).filter((e) =>
      e.release === WAIRON_VERSION
      && !(e.optionsKey === entry.optionsKey && e.treeFingerprint === entry.treeFingerprint && e.codeFingerprint === entry.codeFingerprint));
    const file = resultFilePath(root);
    files.ensureDir(path.dirname(file));
    files.writeText(file, JSON.stringify([{ ...entry, release: WAIRON_VERSION }, ...kept].slice(0, MEMO_ENTRIES)));
  } catch { /* the next process validates */ }
}

// ---------------------------------------------------------------------------
// validation_memo — answer the remembered run, or run the gate and remember it.
// ---------------------------------------------------------------------------

/**
 * The owner gate, answered from an earlier run with the same options while
 * nothing it reads has changed. Takes the same arguments as the gate.
 */
export function validateProject(
  options?: RulesConfig | ValidationOptions,
  projectType: string = 'backend',
): ValidationResult {
  return remembered('owner', normalizeOptions(options, projectType), () => validateProjectFresh(options, projectType));
}

/**
 * The as-complete gate, answered from an earlier as-complete run with the same
 * options while nothing it reads has changed; remembered apart from the owner gate.
 */
export function validateAsComplete(options?: ValidationOptions): ValidationResult {
  return remembered('as-complete', { ...(options ?? {}) }, () => validateAsCompleteFresh(options));
}

/** Either gate: fingerprint what it reads, answer the remembered run (memory, then disk) or run it. */
function remembered(gate: string, normalized: ValidationOptions, run: () => ValidationResult): ValidationResult {
  // Step 1: scan the specs, so the loader issues are this tree issues whether or not the gate runs.
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
  // Steps 4-5: every file under .wai/ (local state left out) and each declared member, by content.
  const treeFingerprint = fingerprintTree(root);
  // Steps 6-8: the source files the gate code model reads, with the implementation claims.
  const implementations = loadImplementationSpecs();
  const types = loadTypeSpecs();
  const conformance = (normalized.rules ?? config?.rules)?.conformance;
  const modelFingerprint = codeModelLoader.fingerprint(
    implementations,
    types,
    getProjectRoot(),
    conformance?.sourceRoots ?? [],
    conformance?.exclude ?? [],
  );
  // Steps 9-11: what the gate reads outside the tree and the code model — the
  // binding modules and the loaded packs — folded into the code fingerprint.
  const codeFingerprint = createHash('sha256')
    .update(JSON.stringify([modelFingerprint, outsideFingerprint(root, implementations, normalized)]))
    .digest('hex');
  // Steps 12-14: this process memory.
  const inMemory = get(root, optionsKey, treeFingerprint, codeFingerprint);
  if (inMemory) return structuredClone(inMemory.result);
  // Steps 15-18: the result file a process before this one left.
  const onDisk = fileGet(root, optionsKey, treeFingerprint, codeFingerprint);
  if (onDisk) {
    put(root, onDisk);
    return structuredClone(onDisk.result);
  }
  // Steps 19-22: run the gate, remember it in memory and on disk.
  const result = run();
  const fresh: ValidationMemoEntry = { optionsKey, treeFingerprint, codeFingerprint, result: structuredClone(result) };
  put(root, fresh);
  filePut(root, fresh);
  return result;
}

/**
 * Steps 9-11: the binding modules the implementations name and each loaded
 * pack's files inside the project root, by content; a pack outside the root
 * (a global or installed pack) by its name, version and location.
 */
function outsideFingerprint(root: string, implementations: ReturnType<typeof loadImplementationSpecs>, options: ValidationOptions): string {
  let packs: { name: string; ref: string; version?: string }[] = [];
  try {
    packs = (options.extensions ?? loadProjectExtensions()).packs ?? [];
  } catch {
    packs = [];
  }
  const inside: string[] = [];
  const outside: string[] = [];
  for (const impl of implementations) {
    if (impl.id.includes('::')) continue;
    for (const binding of impl.bindings ?? []) inside.push(binding.replace(/\\/g, '/'));
  }
  for (const pack of packs) {
    const ref = path.resolve(root, pack.ref);
    const rel = path.relative(root, ref);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) packFiles(root, rel, inside);
    else outside.push(`${pack.name}@${pack.version ?? ''}:${ref}`);
  }
  inside.sort();
  outside.sort();
  return `${contentFingerprint.digest(root, inside)}|${outside.join(',')}`;
}

/** A pack's files under the project root: the file itself, or every file of its folder (dependencies and git data left out). */
function packFiles(root: string, relative: string, found: string[]): void {
  const stat = files.statOrNull(path.join(root, relative));
  if (!stat) {
    found.push(relative);
    return;
  }
  if (!stat.isDirectory()) {
    found.push(relative);
    return;
  }
  let entries: files.DirEntry[];
  try {
    entries = files.listEntries(path.join(root, relative));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) packFiles(root, child, found);
    else found.push(child);
  }
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

/** The .wai/ files of the root and of every member folder it declares (members' members too), by content. */
function fingerprintTree(root: string): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const visit = (projectRoot: string): void => {
    const key = path.resolve(projectRoot);
    if (seen.has(key)) return;
    seen.add(key);
    const found: string[] = [];
    walk(key, '.wai', found);
    parts.push(`${path.relative(root, key) || '.'} ${contentFingerprint.digest(key, found)}`);
    for (const member of declaredMemberDirs(key)) visit(member);
  };
  visit(root);
  parts.sort();
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

/** The files under a project .wai/ folder, relative to the project, leaving out the local-state folder. */
function walk(projectRoot: string, relative: string, found: string[]): void {
  let entries: files.DirEntry[];
  try {
    entries = files.listEntries(path.join(projectRoot, relative));
  } catch {
    found.push(`${relative}/(absent)`);
    return;
  }
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (relative === '.wai' && entry.name === '.local') continue;
      walk(projectRoot, child, found);
    } else {
      found.push(child);
    }
  }
}
