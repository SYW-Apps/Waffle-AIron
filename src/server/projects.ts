import * as fs from 'fs';
import * as path from 'path';
import { aiPathsAt } from '../config/paths.js';
import { readYamlFile } from '../utils/yaml.js';
import { listFilesRecursive } from '../utils/fs.js';
import { resolveContainedProjectPath } from './adapters/core.js';
import { declaredMembers } from '../models/project.js';
import type { HostedProjectRecord, Principal } from './types.js';

// ---------------------------------------------------------------------------
// Project Registry (sdd_host)
//
// File-backed I/O for hosted-project records at <dataDir>/projects.json, and
// id → isolated-root resolution for request scoping. Each project lives at
// <dataDir>/projects/<id>/ with its own .wai/ tree — the isolation unit.
//
// A selector or narrowing entry MAY be member-qualified — 'projectId::alias'
// (nested members compose, e.g. 'proj::a::b', one member alias per hop) —
// binding the MEMBER's root INSIDE the project's isolated tree. A hop is the
// alias the project declares the member under, the same string a legacy mount
// id was, so every qualifier minted before stage 3 binds the same root. The
// qualifier is a NARROWING only: permission capabilities keep resolving over
// the TOP project; the qualifier can never widen or refine grants.
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
 * Register a project record at a caller-supplied rootPath (the local dev
 * server's single project — admin_orchestrator.registerLocalDevProject is the
 * workflow that admits it). Unlike createProjectRecord — which FORCES the isolated
 * root under <dataDir>/projects/<id> — the dev server's one project IS the
 * developer's own tree (an arbitrary path outside dataDir), so the rootPath is
 * supplied verbatim and no directory is created. Idempotent: upserts by id (a
 * pre-existing record's createdAt is preserved), so restarting `wairon dev` over
 * the same tree reuses the record instead of churning it. resolveProjectRoot then
 * returns this rootPath for a principal scoped to the id, so the whole hosted graph
 * pipeline resolves the id → the cwd unchanged. The id must be a valid project id.
 */
export function registerProjectRecord(
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

// ── Subproject-qualified selectors / narrowing entries ──────────────────────

/** Separator joining a project id to its chained-subproject mount chain. */
export const SUBPROJECT_SEPARATOR = '::';

/** A parsed possibly-qualified selector/narrowing entry: the TOP project id and
 *  the (possibly empty) chained-subsystem mount chain, in order. */
export interface QualifiedProjectSelector {
  projectId: string;
  mounts: string[];
}

/**
 * Parse a possibly-qualified selector or narrowing entry. The first
 * `::`-segment is the project id, the remainder is the mount chain
 * ('proj::a::b' → { projectId: 'proj', mounts: ['a', 'b'] }). Returns null for
 * a non-string, an invalid project id, or an empty mount segment.
 */
export function parseQualifiedSelector(value: unknown): QualifiedProjectSelector | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const [projectId, ...mounts] = value.split(SUBPROJECT_SEPARATOR);
  if (!isValidProjectId(projectId)) return null;
  if (mounts.some((m) => m.trim() === '')) return null;
  return { projectId, mounts };
}

/**
 * The path the member `alias` is declared under at `root`, read the way the
 * spec loader reads a root's members: its project.yaml `members` entry first
 * and, for one release, a legacy L1 mount of its own spec tree (a subsystem
 * with that id carrying a projectPath). Returns null when `root` declares no
 * member under the alias — an internal subsystem included, which is not a
 * root at all — and the reason when the declaration cannot be followed.
 */
function memberPathOn(root: string, alias: string): { path: string } | { refused: string } | null {
  let config: unknown = null;
  try {
    const file = aiPathsAt(root).projectConfig();
    if (fs.existsSync(file)) config = readYamlFile(file);
  } catch {
    config = null;
  }
  const declared = config && typeof config === 'object'
    ? declaredMembers(config as Parameters<typeof declaredMembers>[0]).find((m) => m.alias === alias)
    : undefined;
  if (declared) return declared.problem ? { refused: declared.problem } : { path: declared.path };
  const externals = (config as { externals?: Record<string, unknown> } | null)?.externals;
  const specsDir = aiPathsAt(root).specsDir();
  if (!fs.existsSync(specsDir)) return null;
  for (const file of listFilesRecursive(specsDir, '.yaml')) {
    let raw: unknown;
    try {
      raw = readYamlFile(file);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== 'object' || !('parentSystem' in raw)) continue;
    if ((raw as { id?: unknown }).id !== alias) continue;
    const pp = (raw as { projectPath?: unknown }).projectPath;
    if (typeof pp !== 'string' || pp.trim() === '') return null;
    if (externals?.[alias] !== undefined) {
      return { refused: `the alias "${alias}" is also declared under \`externals\` — one alias names one project` };
    }
    return { path: pp };
  }
  return null;
}

/**
 * Resolve a member chain to the member's root INSIDE the project's isolated
 * tree. Each hop is a member alias, looked up among the current root's member
 * declarations — its project.yaml `members` and, for one release, its legacy
 * L1 mounts (the alias is the string the legacy mount id was, so a qualifier
 * minted before stage 3 names the same root) — and the member dir is resolved
 * WITHIN the current root under the containment guard (absolute and
 * ../-escaping paths are rejected). An alias that declares no member throws a
 * clear, actionable error — the resolution never silently falls back to the
 * project root, and never binds an internal subsystem.
 */
export function resolveSubprojectMounts(
  projectId: string,
  projectRoot: string,
  mounts: string[],
): string {
  let root = projectRoot;
  let at = projectId;
  for (const alias of mounts) {
    const member = memberPathOn(root, alias);
    if (!member) {
      throw new Error(
        `unknown member "${alias}" on "${at}" — it declares no member under that alias ` +
          '(in project.yaml `members`, or a legacy L1 mount); an internal subsystem is not a member and cannot be bound',
      );
    }
    if ('refused' in member) {
      throw new Error(`member "${alias}" on "${at}" cannot be bound: ${member.refused}`);
    }
    // Containment guard: the member dir must resolve strictly within the current
    // root, so a crafted declaration can never escape the project's isolated tree.
    root = resolveContainedProjectPath(root, member.path);
    at = `${at}${SUBPROJECT_SEPARATOR}${alias}`;
  }
  return root;
}

/**
 * Validate ONE possibly-qualified projects-narrowing entry at MINT time: the
 * top project must exist, and for a qualified entry each alias must declare a
 * member of the project it is looked up in (project.yaml `members`, or for one
 * release a legacy L1 mount). An unknown alias, or an internal subsystem,
 * throws with guidance so a broken narrowing is never stored. '*' (no
 * narrowing) is always valid.
 */
export function assertMintableNarrowingEntry(dataDir: string, entry: string): void {
  if (entry === '*') return;
  const parsed = parseQualifiedSelector(entry);
  if (!parsed) {
    throw new Error(
      `invalid project narrowing entry "${entry}" (expected a project id, optionally ` +
        `member-qualified as projectId::alias)`,
    );
  }
  const rec = load(dataDir).find((r) => r.id === parsed.projectId);
  if (!rec) throw new Error(`unknown project "${parsed.projectId}"`);
  if (parsed.mounts.length > 0) {
    resolveSubprojectMounts(parsed.projectId, rec.rootPath, parsed.mounts);
  }
}

/** The resolved binding of one authorized data-plane request: the root to bind
 *  (the CHILD root when subproject-qualified), the TOP project id (provenance +
 *  permission scope), and the subsystem mount chain when one applied. */
export interface ProjectBinding {
  rootPath: string;
  projectId: string;
  /** The qualifier's mount chain ('a' or 'a::b'), absent for an unqualified binding. */
  subproject?: string;
}

/** True when an authorized narrowing entry covers `target`: equal, or `target`
 *  nested strictly deeper under it ('proj' covers 'proj::a'; 'proj::a' covers
 *  'proj::a::b' but never plain 'proj' or a sibling 'proj::b'). */
function narrowingCovers(entry: string, target: string): boolean {
  return target === entry || target.startsWith(entry + SUBPROJECT_SEPARATOR);
}

/**
 * Resolve the binding of the authorized project (or chained subproject). The
 * selector is honored ONLY at or below the principal's authorized set — it can
 * never widen scope: a principal narrowed to 'proj::a' may bind 'proj::a' (or
 * deeper, e.g. 'proj::a::b') but NEVER plain 'proj' or a sibling; a principal
 * with plain 'proj' (or '*') MAY narrow via a qualified selector. A qualified
 * target resolves to the chained child's root inside the project's isolated
 * tree; an unknown or non-chained mount rejects (null) — never a silent
 * fallback to the project root. Returns null for any project outside the
 * authorized set, unknown, or disabled.
 */
export function resolveProjectBinding(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): ProjectBinding | null {
  const authorized = principal.projects;
  const wildcard = authorized.includes('*');

  let target: string | undefined;
  if (selector) {
    // The selector cannot widen scope: it must sit at or below an authorized entry.
    if (!wildcard && !authorized.some((e) => e !== '*' && narrowingCovers(e, selector))) return null;
    target = selector;
  } else if (!wildcard && authorized.length === 1) {
    target = authorized[0]; // single-entry token needs no selector (entry may be qualified)
  } else {
    return null; // wildcard/multi-project tokens must name a project
  }

  const parsed = parseQualifiedSelector(target);
  if (!parsed) return null;
  const rec = load(dataDir).find((r) => r.id === parsed.projectId);
  if (!rec || rec.status !== 'active') return null;

  let rootPath = rec.rootPath;
  if (parsed.mounts.length > 0) {
    try {
      rootPath = resolveSubprojectMounts(parsed.projectId, rec.rootPath, parsed.mounts);
    } catch {
      return null; // unknown / non-chained / escaping mount — never the project root
    }
  }
  const binding: ProjectBinding = { rootPath, projectId: parsed.projectId };
  if (parsed.mounts.length > 0) binding.subproject = parsed.mounts.join(SUBPROJECT_SEPARATOR);
  return binding;
}

/**
 * Resolve the isolated root of the authorized project (the chained child's root
 * for a subproject-qualified selector/narrowing). The selector is honored ONLY
 * within the principal's authorized set — it can never widen scope. Returns
 * null for any project outside that set, unknown, or disabled. Thin projection
 * of resolveProjectBinding for callers that need only the root path.
 */
export function resolveProjectRoot(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): string | null {
  return resolveProjectBinding(dataDir, principal, selector)?.rootPath ?? null;
}
