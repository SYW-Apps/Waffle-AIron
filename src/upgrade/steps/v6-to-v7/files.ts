import * as nodePath from 'path';
import { files } from '../../../io/index.js';
import { parseYaml, serializeYaml } from '../../../utils/yaml.js';
import { InputsLockSchema } from '../../../models/specs.js';
import type { InputsLock } from '../../../models/specs.js';
import type { ApproverIdentity, CodeAnalysis } from '../../../models/lock.js';
import type { StateId } from '../../../core/index.js';
import type { ValidationResult } from '../../../core/validation.js';

// ---------------------------------------------------------------------------
// v6_lock_file_adapter — the v6-to-v7 step's own reader and writer for the
// lock files whose v6 forms the core no longer reads: the raw format-2/3
// .wai/lock.json, the v6 .wai/externals.lock.yaml, and the files the step
// removes. It writes the new .wai/inputs.lock.yaml in v7's form on the
// rehearsal root it is given. Only the step uses it; it goes with the step when
// the window moves on.
// ---------------------------------------------------------------------------

/** v6_lock_record — a .wai/lock.json as wairon 6 wrote it (format 2 or 3), read raw: only what the step compares or carries. */
export interface V6LockRecord {
  /** 2 or 3; absent reads as an older record, never carried. */
  format?: number;
  /** The gate identity the record certified, under wairon 6's algorithm. */
  stateId: StateId;
  /** Per-spec digests, keyed by spec path. */
  specs?: Record<string, string>;
  /** How the digests read the specs: `design` or the older content reading; only a design reading can be compared. */
  specsReading?: string;
  /** Each input of the gate identity digested on its own. */
  gateParts?: Record<string, string>;
  lockedAt: string;
  lockedBy?: ApproverIdentity;
  /** The wairon version that took the lock; kept on the format-4 record. */
  validatorVersion?: string;
  validationResult?: ValidationResult;
  code?: CodeAnalysis;
  projectId?: string;
  commitSha?: string;
  compareUrl?: string;
}

const LOCK_FILE = ['.wai', 'lock.json'];
const EXTERNALS_LOCK_FILE = ['.wai', 'externals.lock.yaml'];
const INPUTS_LOCK_FILE = ['.wai', 'inputs.lock.yaml'];

/** A v6 `lockedBy` as an identity: a bare string (an older record) is read as a legacy one. */
function approverOf(value: unknown): ApproverIdentity | undefined {
  if (value && typeof value === 'object' && typeof (value as ApproverIdentity).id === 'string') {
    const v = value as ApproverIdentity;
    const source = v.source === 'git' || v.source === 'hosted' || v.source === 'os' ? v.source : 'legacy';
    return { id: v.id, ...(v.name ? { name: v.name } : {}), source };
  }
  return typeof value === 'string' && value ? { id: value, source: 'legacy' } : undefined;
}

/** Copy a field of the raw record onto the answer when it is present. */
function pick<K extends keyof V6LockRecord>(raw: Record<string, unknown>, key: K): Partial<V6LockRecord> {
  return raw[key] === undefined ? {} : ({ [key]: raw[key] } as Partial<V6LockRecord>);
}

/** The raw JSON object of a lock record's text, or the refusal naming the file. */
function parseRecordText(text: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${file} is not valid JSON (${(e as Error).message}): the upgrade never guesses an approval`);
  }
  const stateId = (raw as { stateId?: { algorithm?: unknown; digest?: unknown } } | null)?.stateId;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || typeof stateId?.algorithm !== 'string' || typeof stateId?.digest !== 'string') {
    throw new Error(`${file} names no approval identity (stateId): the upgrade never guesses an approval`);
  }
  return raw as Record<string, unknown>;
}

/** iv6_lock_file_adapter.readRecord — parse <root>/.wai/lock.json as wairon 6 wrote it; none when absent. */
export function readRecord(root: string): V6LockRecord | null {
  // The files adapter answers whether it exists, then its text.
  const file = nodePath.join(root, ...LOCK_FILE);
  if (!files.exists(file)) return null;
  const raw = parseRecordText(files.readText(file), file);
  const lockedBy = approverOf(raw.lockedBy);
  return {
    stateId: raw.stateId as StateId,
    lockedAt: typeof raw.lockedAt === 'string' ? raw.lockedAt : '',
    ...(typeof raw.format === 'number' ? { format: raw.format } : {}),
    ...pick(raw, 'specs'), ...pick(raw, 'specsReading'), ...pick(raw, 'gateParts'),
    ...(lockedBy ? { lockedBy } : {}),
    ...pick(raw, 'validatorVersion'), ...pick(raw, 'validationResult'), ...pick(raw, 'code'),
    ...pick(raw, 'projectId'), ...pick(raw, 'commitSha'), ...pick(raw, 'compareUrl'),
  };
}

/** iv6_lock_file_adapter.readExternalsLock — parse <root>/.wai/externals.lock.yaml into the inputs lock's shape, with no packs; none when absent. */
export function readExternalsLock(root: string): InputsLock | null {
  // Exists, then text.
  const file = nodePath.join(root, ...EXTERNALS_LOCK_FILE);
  if (!files.exists(file)) return null;
  let raw: unknown;
  try {
    raw = parseYaml(files.readText(file));
  } catch (e) {
    throw new Error(`${file} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = (raw ?? {}) as { externals?: unknown; parent?: unknown };
  const parsed = InputsLockSchema.safeParse({ externals: doc.externals ?? {}, ...(doc.parent !== undefined ? { parent: doc.parent } : {}), packs: {} });
  if (!parsed.success) {
    throw new Error(`${file} does not read as a pins file: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

/** The lock with its aliases and pack names sorted, a part's parent entry kept. */
function sorted(lock: InputsLock): InputsLock {
  const externals: InputsLock['externals'] = {};
  for (const alias of Object.keys(lock.externals).sort()) externals[alias] = lock.externals[alias];
  const packs: InputsLock['packs'] = {};
  for (const name of Object.keys(lock.packs).sort()) packs[name] = lock.packs[name];
  return { externals, ...(lock.parent !== undefined ? { parent: lock.parent } : {}), packs };
}

/** iv6_lock_file_adapter.writeInputsLock — write <root>/.wai/inputs.lock.yaml in v7's form; a lock with no entry left is not written. */
export function writeInputsLock(root: string, lock: InputsLock): void {
  // Nothing to record: nothing written.
  if (Object.keys(lock.externals).length === 0 && lock.parent === undefined && Object.keys(lock.packs).length === 0) return;
  // The write goes through the files adapter.
  files.writeText(nodePath.join(root, ...INPUTS_LOCK_FILE), serializeYaml(sorted(lock)));
}

/** iv6_lock_file_adapter.removeFile — remove a root-relative file, pruning an externals directory left empty; whether the file existed. */
export function removeFile(root: string, path: string): boolean {
  // Exists, remove.
  const file = nodePath.resolve(root, path);
  const existed = files.exists(file);
  if (existed) files.remove(file);
  // The externals directory goes with its last snapshot.
  const dir = nodePath.join(root, '.wai', 'externals');
  if (files.exists(dir) && files.list(dir).length === 0) files.remove(dir);
  return existed;
}
