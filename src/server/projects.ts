import * as fs from 'fs';
import * as path from 'path';
import type { HostedProjectRecord, Principal } from './types.js';

// ---------------------------------------------------------------------------
// Project Registry (sdd_host)
//
// File-backed I/O for hosted-project records at <dataDir>/projects.json, and
// id → isolated-root resolution for request scoping. Each project lives at
// <dataDir>/projects/<id>/ with its own .wai/ tree — the isolation unit.
// ---------------------------------------------------------------------------

/** Path-safe project ids only, so a crafted id can never escape projects/. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id);
}

function registryPath(dataDir: string): string {
  return path.join(dataDir, 'projects.json');
}

function load(dataDir: string): HostedProjectRecord[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath(dataDir), 'utf8')) as HostedProjectRecord[];
  } catch {
    return [];
  }
}

function save(dataDir: string, records: HostedProjectRecord[]): void {
  const p = registryPath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

/** The isolated root path for a project id. */
export function projectRoot(dataDir: string, id: string): string {
  return path.join(dataDir, 'projects', id);
}

/** The isolated root of an EXISTING project, or null. Validates the id first, so
 *  a malformed id can never traverse out of projects/, and a missing project is
 *  reported clearly instead of binding a phantom root. */
export function existingProjectRoot(dataDir: string, id: string): string | null {
  if (!isValidProjectId(id)) return null;
  const rec = load(dataDir).find((r) => r.id === id);
  return rec ? rec.rootPath : null;
}

/** Allocate an isolated root, create its directory, and persist the record. */
export function createProjectRecord(dataDir: string, id: string): HostedProjectRecord {
  if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}" (allowed: lowercase letters, digits, hyphen).`);
  }
  const records = load(dataDir);
  if (records.some((r) => r.id === id)) {
    throw new Error(`Project "${id}" already exists.`);
  }
  const root = projectRoot(dataDir, id);
  fs.mkdirSync(root, { recursive: true });
  const record: HostedProjectRecord = {
    id,
    rootPath: root,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  records.push(record);
  save(dataDir, records);
  return record;
}

/**
 * Register the current working directory as the single local dev project under a
 * caller-supplied rootPath. Unlike createProjectRecord — which FORCES the isolated
 * root under <dataDir>/projects/<id> — the dev server's one project IS the
 * developer's own tree (an arbitrary path outside dataDir), so the rootPath is
 * supplied verbatim and no directory is created. Idempotent: upserts by id (a
 * pre-existing record's createdAt is preserved), so restarting `wairon dev` over
 * the same tree reuses the record instead of churning it. resolveProjectRoot then
 * returns this rootPath for a principal scoped to the id, so the whole hosted graph
 * pipeline resolves the id → the cwd unchanged. The id must be a valid project id.
 */
export function registerLocalDevProject(
  dataDir: string,
  id: string,
  rootPath: string,
): HostedProjectRecord {
  if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}" (allowed: lowercase letters, digits, hyphen).`);
  }
  const records = load(dataDir);
  const existing = records.find((r) => r.id === id);
  const record: HostedProjectRecord = {
    id,
    rootPath,
    status: 'active',
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  const next = existing ? records.map((r) => (r.id === id ? record : r)) : [...records, record];
  save(dataDir, next);
  return record;
}

/** All hosted-project records. */
export function listProjectRecords(dataDir: string): HostedProjectRecord[] {
  return load(dataDir);
}

/** Deregister a project and remove its isolated tree (idempotent). */
export function removeProjectRecord(dataDir: string, id: string): void {
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  if (rec) {
    try {
      fs.rmSync(rec.rootPath, { recursive: true, force: true });
    } catch {
      /* best-effort tree removal */
    }
  }
  save(dataDir, records.filter((r) => r.id !== id));
}

/**
 * Resolve the isolated root of the authorized project. The selector is honored
 * ONLY within the principal's authorized set — it can never widen scope. Returns
 * null for any project outside that set, unknown, or disabled.
 */
export function resolveProjectRoot(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): string | null {
  const authorized = principal.projects;
  const wildcard = authorized.includes('*');

  let target: string | undefined;
  if (selector) {
    if (!wildcard && !authorized.includes(selector)) return null; // selector cannot widen scope
    target = selector;
  } else if (!wildcard && authorized.length === 1) {
    target = authorized[0]; // single-project token needs no selector
  } else {
    return null; // wildcard/multi-project tokens must name a project
  }

  if (!isValidProjectId(target)) return null;
  const rec = load(dataDir).find((r) => r.id === target);
  if (!rec || rec.status !== 'active') return null;
  return rec.rootPath;
}
