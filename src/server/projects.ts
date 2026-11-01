import { files } from '../io/index.js';
import * as path from 'path';
import { aiPathsAt } from '../config/paths.js';
import { readYamlFile } from '../utils/yaml.js';
import { runWithProjectRoot } from '../utils/fs.js';
import { resolveContainedProjectPath, loadProjectConfig, loadSubsystemSpecs } from './adapters/core.js';
import { declaredMembers, effectiveProjectId, PROJECT_ID_RE } from '../models/project.js';
import { identifierProblem } from '../models/identifiers.js';
import * as projectStore from './project-store.js';
import type {
  HostedProjectRecord,
  PlannedMemberRecord,
  Principal,
  RepositoryScope,
} from './types.js';

// ---------------------------------------------------------------------------
// Project Registry (sdd_host)
//
// File-backed I/O for hosted-project records at <dataDir>/projects.json, and
// id → root resolution for request scoping. A family root lives at
// <dataDir>/projects/<id>/ (or, for the dev server, the developer's own tree)
// with its own .wai/ tree — the isolation unit.
//
// Since stage 7 every member of a hosted family is a record of its own: it
// carries parentProjectId and memberPath, and its root is never persisted — it
// is derived on read as its parent's root joined with memberPath through the
// containment guard, so moving a family's directory moves its members with it.
// Projects nest like organization units: a narrowing entry naming a project
// covers that project and every member below it.
//
// A member-QUALIFIED selector or narrowing entry ('projectId::alias') names no
// record and binds nothing: a member is a record of its own, named by its id.
// The server start rewrites the qualified entries an older major stored.
// ---------------------------------------------------------------------------

/**
 * A hosted record id IS a project id: the one project-id grammar (PROJECT_ID_RE), never mapped or
 * narrowed. Path-safe by construction (alphanumeric ends, no separators, no device names), so a
 * crafted id can never escape projects/.
 */
export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && PROJECT_ID_RE.test(id);
}

/** Why an id is no hosted record id, in the project-id grammar's own words. */
export function invalidProjectIdProblem(id: string): string {
  return identifierProblem(id, 'project-id') ?? "a project id is lowercase letters, digits, '-', '_' and '.', starting and ending with a letter or digit, at most 64 characters, and never super or a Windows device name";
}

/** The records as stored (project_store.read): a member record carries no rootPath. */
function load(dataDir: string): HostedProjectRecord[] {
  return projectStore.load(dataDir);
}

/**
 * Read the set fresh and persist what `change` makes of it (project_store.update),
 * under the file's write lock; a member record's derived rootPath is never written.
 */
function update(dataDir: string, change: (records: HostedProjectRecord[]) => HostedProjectRecord[]): void {
  projectStore.update(dataDir, (records) => change(records).map((r) => (r.parentProjectId ? withoutRoot(r) : r)));
}

function withoutRoot(record: HostedProjectRecord): HostedProjectRecord {
  const { rootPath: _rootPath, ...rest } = record;
  return rest as HostedProjectRecord;
}

/** A member path as records hold it: forward slashes, no leading ./ and no trailing slash. */
export function normalizeMemberPath(p: string): string {
  const posix = path.posix.normalize(p.replace(/\\/g, '/'));
  return posix.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

/** The isolated root path for a project id. */
export function projectRoot(dataDir: string, id: string): string {
  return path.join(dataDir, 'projects', id);
}

// ── Derived roots ───────────────────────────────────────────────────────────

/**
 * A record's root: a family root's persisted rootPath, or a member's derived
 * one — its parent's root joined with memberPath through the containment
 * guard, recursively. Null when the chain is broken (a parent record gone, a
 * cycle, or a path that escapes its parent).
 */
function derivedRoot(records: HostedProjectRecord[], record: HostedProjectRecord, seen = new Set<string>()): string | null {
  if (!record.parentProjectId) return record.rootPath ?? null;
  if (seen.has(record.id) || record.memberPath === undefined) return null;
  seen.add(record.id);
  const parent = records.find((r) => r.id === record.parentProjectId);
  if (!parent) return null;
  const parentRoot = derivedRoot(records, parent, seen);
  if (parentRoot === null) return null;
  try {
    return resolveContainedProjectPath(parentRoot, record.memberPath);
  } catch {
    return null;
  }
}

/** The record with its rootPath derived ('' when the chain is broken). */
function withDerivedRoot(records: HostedProjectRecord[], record: HostedProjectRecord): HostedProjectRecord {
  if (!record.parentProjectId) return record;
  return { ...record, rootPath: derivedRoot(records, record) ?? '' };
}

/** The family root record a record climbs to through parentProjectId, or null for a broken chain. */
function familyRootOf(records: HostedProjectRecord[], record: HostedProjectRecord): HostedProjectRecord | null {
  let current: HostedProjectRecord | undefined = record;
  const seen = new Set<string>();
  while (current?.parentProjectId) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parentId: string = current.parentProjectId;
    current = records.find((r) => r.id === parentId);
  }
  return current ?? null;
}

/** The root of an EXISTING record (a member's derived), or null. Validates the
 *  id first, so a malformed id can never traverse out of projects/. */
export function existingProjectRoot(dataDir: string, id: string): string | null {
  if (!isValidProjectId(id)) return null;
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  return rec ? derivedRoot(records, rec) : null;
}

/**
 * project_index.declaredSubsystems — the subsystem ids a record's spec tree
 * declares now, each its local id (a part's subsystems included: they are the
 * record's own; a member's are its own record's, so they are left out), read at
 * the record's root; null for an id with no root on disk.
 */
export function declaredSubsystemIds(dataDir: string, id: string): string[] | null {
  const root = rootOnDisk(dataDir, id);
  return root ? subsystemIdsAt(root) : null;
}

/** The root of a stored record that exists on disk, or null (a malformed id never traverses out). */
function rootOnDisk(dataDir: string, id: string): string | null {
  if (!isValidProjectId(id)) return null;
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  const root = rec ? derivedRoot(records, rec) : null;
  return root && files.exists(root) ? root : null;
}

/** The local ids of the subsystems the tree at a folder declares (a member's own are its record's, so left out). */
function subsystemIdsAt(dir: string): string[] {
  return runWithProjectRoot(dir, () => loadSubsystemSpecs())
    .map((s) => s.id)
    .filter((key) => !key.includes('::'));
}

/**
 * project_index.partSubsystems — the subsystem ids a record's part (the
 * contained member declared under the alias) holds now, each its local id,
 * read in the part's folder; null when the record has no root or declares no
 * contained member under the alias.
 */
export function partSubsystemIds(dataDir: string, id: string, alias: string): string[] | null {
  const root = rootOnDisk(dataDir, id);
  const decl = root ? memberDeclarationsOn(root).find((d) => d.alias === alias && d.path && !d.hosted && !d.refused) : undefined;
  if (!root || !decl?.path) return null;
  const dir = resolveContainedProjectPath(root, decl.path);
  return files.exists(dir) ? subsystemIdsAt(dir) : null;
}

/** Allocate an isolated root, create its directory, and persist the record. */
export function createProjectRecord(dataDir: string, id: string): HostedProjectRecord {
  if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}": ${invalidProjectIdProblem(id)}.`);
  }
  const root = projectRoot(dataDir, id);
  const record: HostedProjectRecord = {
    id,
    rootPath: root,
    status: 'active',
    createdAt: new Date().toISOString(),
  };
  update(dataDir, (records) => {
    if (records.some((r) => r.id === id)) {
      throw new Error(`Project "${id}" already exists.`);
    }
    files.ensureDir(root);
    return [...records, record];
  });
  return record;
}

/**
 * Register a FAMILY ROOT record at a caller-supplied rootPath (the local dev
 * server's single project, or a hosted detach's relocated member). No
 * directory is created. Idempotent: upserts by id (a pre-existing record's
 * createdAt is preserved), and any parentProjectId / memberPath the id held are
 * cleared — the record written is a family root with its root persisted.
 */
export function registerProjectRecord(
  dataDir: string,
  id: string,
  rootPath: string,
): HostedProjectRecord {
  if (!isValidProjectId(id)) {
    throw new Error(`Invalid project id "${id}": ${invalidProjectIdProblem(id)}.`);
  }
  let record!: HostedProjectRecord;
  update(dataDir, (records) => {
    const existing = records.find((r) => r.id === id);
    record = {
      id,
      rootPath,
      status: 'active',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    return existing ? records.map((r) => (r.id === id ? record : r)) : [...records, record];
  });
  return record;
}

/**
 * Upsert a MEMBER record by id: parentProjectId and memberPath are required and
 * replace the stored ones (a moved member is relocated, never duplicated); an
 * existing record's createdAt is kept. A family root record is CONVERTED into a
 * member (its persisted root dropped). No directory is created or copied and a
 * member's rootPath is never persisted. Refuses a malformed id, a parent no
 * record holds, a parent that is the record itself or one of its own members,
 * and a memberPath that is absolute or escapes its parent.
 */
export function registerMemberRecord(dataDir: string, record: HostedProjectRecord): HostedProjectRecord {
  const memberPath = validMemberShape(record);
  let next!: HostedProjectRecord[];
  let member!: HostedProjectRecord;
  update(dataDir, (records) => {
    refuseParent(records, record);
    const existing = records.find((r) => r.id === record.id);
    member = {
      id: record.id,
      rootPath: '',
      status: record.status === 'disabled' ? 'disabled' : existing?.status ?? 'active',
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      parentProjectId: record.parentProjectId,
      memberPath,
    };
    next = existing ? records.map((r) => (r.id === record.id ? member : r)) : [...records, member];
    return next;
  });
  return withDerivedRoot(next, member);
}

/** A member record's id and path shape: a valid id, a parent, and a relative path within it. Answers the normalized path. */
function validMemberShape(record: HostedProjectRecord): string {
  if (!isValidProjectId(record.id)) {
    throw new Error(`Invalid project id "${record.id}": ${invalidProjectIdProblem(record.id)}.`);
  }
  if (!record.parentProjectId || record.memberPath === undefined) {
    throw new Error(`Member record "${record.id}" needs a parentProjectId and a memberPath.`);
  }
  const memberPath = normalizeMemberPath(record.memberPath);
  if (escapesParent(memberPath)) {
    throw new Error(`Member record "${record.id}": the member path "${record.memberPath}" must be relative and stay within its parent.`);
  }
  return memberPath;
}

/** Whether a normalized member path is empty, absolute, or climbs out of its parent. */
function escapesParent(memberPath: string): boolean {
  if (memberPath === '' || memberPath === '.' || memberPath === '..') return true;
  return path.posix.isAbsolute(memberPath) || /^[A-Za-z]:/.test(memberPath) || memberPath.startsWith('../');
}

/** Refuse a parent no record holds, and a parent that is the record itself or one of its members. */
function refuseParent(records: HostedProjectRecord[], record: HostedProjectRecord): void {
  const parent = records.find((r) => r.id === record.parentProjectId);
  if (!parent) throw new Error(`Member record "${record.id}": no record holds its parent "${record.parentProjectId}".`);
  if (record.parentProjectId === record.id || descendsFrom(records, parent, record.id)) {
    throw new Error(`Member record "${record.id}": its parent "${record.parentProjectId}" is the record itself or one of its own members.`);
  }
}

/** True when `record` has `ancestorId` somewhere up its parent chain. */
function descendsFrom(records: HostedProjectRecord[], record: HostedProjectRecord, ancestorId: string): boolean {
  let current: HostedProjectRecord | undefined = record;
  const seen = new Set<string>();
  while (current?.parentProjectId && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.parentProjectId === ancestorId) return true;
    const parentId: string = current.parentProjectId;
    current = records.find((r) => r.id === parentId);
  }
  return false;
}

/** Set a record's status (active | disabled). Touches no directory. */
export function setProjectRecordStatus(dataDir: string, id: string, status: string, reason?: string): HostedProjectRecord {
  if (status !== 'active' && status !== 'disabled') {
    throw new Error(`Invalid project status "${status}" (allowed: active, disabled).`);
  }
  let next!: HostedProjectRecord[];
  let record!: HostedProjectRecord;
  update(dataDir, (records) => {
    const existing = records.find((r) => r.id === id);
    if (!existing) throw new Error(`Unknown project "${id}".`);
    // The reason a disabled record is disabled (stage 8); active again clears it.
    const { disabledReason: _was, ...rest } = existing;
    record = { ...rest, status, ...(status === 'disabled' && reason ? { disabledReason: reason } : {}) };
    next = records.map((r) => (r.id === id ? record : r));
    return next;
  });
  return withDerivedRoot(next, record);
}

/** All hosted-project records, each member with its derived rootPath. */
export function listProjectRecords(dataDir: string): HostedProjectRecord[] {
  const records = load(dataDir);
  return records.map((r) => withDerivedRoot(records, r));
}

/**
 * Deregister a project. A family root's isolated tree is removed with it, and
 * it is refused while a member record still names it as parent; a member
 * record's directory lies inside its parent's tree and is NEVER removed.
 * Idempotent for a missing id.
 */
export function removeProjectRecord(dataDir: string, id: string): void {
  if (!load(dataDir).some((r) => r.id === id)) return;
  let tree: string | undefined;
  update(dataDir, (records) => {
    const rec = records.find((r) => r.id === id);
    if (!rec) return records;
    if (!rec.parentProjectId) {
      const members = records.filter((r) => r.parentProjectId === id).map((r) => r.id);
      if (members.length > 0) {
        throw new Error(`Project "${id}" still has member record(s) ${members.join(', ')} — remove or detach them first.`);
      }
      tree = rec.rootPath;
    }
    return records.filter((r) => r.id !== id);
  });
  // The tree goes once the record is gone, outside the lock: a large tree takes
  // longer than any lock is held, and a failed write keeps both.
  if (tree) {
    try {
      files.remove(tree);
    } catch {
      /* best-effort tree removal */
    }
  }
}

// ── Families ────────────────────────────────────────────────────────────────

/**
 * The hosted family a record belongs to: its family root record first, then
 * every record whose parent chain reaches it, depth-first in stored order,
 * each member with its derived rootPath. [] for an unknown id. Reads no
 * project file.
 */
export function listFamilyRecords(dataDir: string, id: string): HostedProjectRecord[] {
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  if (!rec) return [];
  const root = familyRootOf(records, rec);
  if (!root) return [];
  const out: HostedProjectRecord[] = [];
  const visit = (r: HostedProjectRecord): void => {
    if (out.some((o) => o.id === r.id)) return;
    out.push(withDerivedRoot(records, r));
    for (const child of records.filter((c) => c.parentProjectId === r.id)) visit(child);
  };
  visit(root);
  return out;
}

/**
 * Where a record commits: its family root's isolated root (the family's one
 * repository) and its own .wai/ pathspec relative to it — '.wai/' for a family
 * root, '<memberPath chain>/.wai/' for a member. Null for an unknown id or a
 * broken parent chain.
 */
export function projectRepositoryScope(dataDir: string, id: string): RepositoryScope | null {
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  if (!rec) return null;
  const segments: string[] = [];
  let current: HostedProjectRecord | undefined = rec;
  const seen = new Set<string>();
  while (current?.parentProjectId) {
    if (seen.has(current.id) || current.memberPath === undefined) return null;
    seen.add(current.id);
    segments.unshift(current.memberPath);
    const parentId: string = current.parentProjectId;
    current = records.find((r) => r.id === parentId);
  }
  if (!current) return null;
  const prefix = segments.length > 0 ? `${segments.join('/')}/` : '';
  return { familyRootId: current.id, repositoryRoot: current.rootPath, pathspecs: [`${prefix}.wai/`] };
}

// ── Member declarations on disk ─────────────────────────────────────────────

/**
 * Separator joining a project id to its member alias chain: the form an older
 * major stored in tokens, which only member registration builds and matches (its
 * start upgrade rewrites the stored form).
 */
export const SUBPROJECT_SEPARATOR = '::';

/** One member a root declares: its alias and path, or why the declaration cannot be followed. */
interface MemberDeclaration {
  alias: string;
  path?: string;
  refused?: string;
  /** A `hosted:` source (stage 8): its own top-level record, related to the declarer but not contained by it. */
  hosted?: boolean;
}

/** A root's project.yaml, read raw; null when it has none or it cannot be read. */
function rawConfigAt(root: string): Record<string, unknown> | null {
  try {
    const file = aiPathsAt(root).projectConfig();
    if (!files.exists(file)) return null;
    const raw = readYamlFile(file);
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Every member a root declares in its project.yaml `members`, read the way the spec loader reads them. */
function memberDeclarationsOn(root: string): MemberDeclaration[] {
  const config = rawConfigAt(root);
  const out: MemberDeclaration[] = config
    ? declaredMembers(config as Parameters<typeof declaredMembers>[0]).map((m): MemberDeclaration => {
        if (m.problem) return { alias: m.alias, refused: m.problem };
        if (m.storage === 'hosted') return { alias: m.alias, hosted: true };
        // A hosted instance reads no `../` or git source: its roots are isolated (stage 8).
        if (m.storage !== 'contained') return { alias: m.alias, refused: `its ${m.storage === 'git' ? 'git' : '`../` sibling'} source is not read on a hosted instance — a hosted project reaches another root only by a \`hosted:\` source` };
        return { alias: m.alias, path: m.path };
      })
    : [];
  return out;
}

/** The project id a member's own project.yaml declares, read through the host core adapter; null when unreadable. */
function projectIdAt(root: string): string | null {
  try {
    if (!files.exists(root)) return null;
    const config = runWithProjectRoot(root, () => loadProjectConfig());
    return config ? effectiveProjectId(config) : null;
  } catch {
    return null;
  }
}

/** A member directory's own project id, or why none can be read — in words a person acts on. */
function memberIdAt(dir: string): { id: string } | { reason: string } {
  if (!files.exists(dir)) return { reason: `its directory ${dir} does not exist` };
  if (!files.exists(aiPathsAt(dir).projectConfig())) return { reason: `${dir} holds no .wai/project.yaml` };
  let id: string | null;
  try {
    const config = runWithProjectRoot(dir, () => loadProjectConfig());
    id = config ? effectiveProjectId(config) : null;
  } catch (e) {
    return { reason: `its .wai/project.yaml cannot be read or fails its schema: ${(e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()}` };
  }
  if (id === null) return { reason: 'its .wai/project.yaml declares no project id, and its name yields none' };
  if (!isValidProjectId(id)) return { reason: `its project id "${id}" is not a valid hosted record id: ${invalidProjectIdProblem(id)}` };
  return { id };
}

/**
 * The members the family rooted at a record declares ON DISK, members of
 * members included, each answered as the record it should hold — id (its own
 * project id), parentProjectId (the declaring project's record id), memberPath
 * as declared — with the pre-stage-7 qualifier that bound it and its action
 * against the stored records: register, relocate, rename, unchanged, or
 * unreadable (never skipped). Writes nothing.
 */
export function planMemberRecords(dataDir: string, id: string): PlannedMemberRecord[] {
  const records = load(dataDir);
  const rec = records.find((r) => r.id === id);
  if (!rec) return [];
  const root = familyRootOf(records, rec);
  const rootDir = root ? derivedRoot(records, root) : null;
  if (!root || rootDir === null) return [];
  const out: PlannedMemberRecord[] = [];
  const walk = (parentId: string, dir: string, qualifier: string, depth: number): void => {
    if (depth > 32) return;
    for (const decl of memberDeclarationsOn(dir)) {
      // A `hosted:` project member is its own top-level record (stage 8): not contained, never registered here.
      if (decl.hosted) continue;
      const planned = planOne(records, root.id, parentId, dir, qualifier, decl);
      // A part is part of its parent's record and never one of its own: only a record it left behind is retired.
      if (planned === null) continue;
      out.push(planned);
      if (planned.action !== 'unreadable' && planned.action !== 'retire') {
        walk(planned.record.id, resolveContainedProjectPath(dir, decl.path as string), planned.qualifier, depth + 1);
      }
    }
  };
  walk(root.id, rootDir, root.id, 0);
  return out;
}

/** Whether a member root holds a project's content — an id, an L0 or a lock — or is a part (stage 8). */
function holdsProjectContent(dir: string): boolean {
  const paths = aiPathsAt(dir);
  if (files.exists(paths.specsSystem()) || files.exists(path.join(paths.root(), 'lock.json'))) return true;
  return rawConfigAt(dir)?.id !== undefined;
}

/**
 * Whether a member record was retired as a part (stage 8): disabled, and its
 * folder holding no project content any more — reached through its parent's
 * record from now on.
 */
export function isRetiredPart(record: HostedProjectRecord): boolean {
  return record.status === 'disabled' && record.parentProjectId !== undefined && !!record.rootPath
    && files.exists(record.rootPath) && !holdsProjectContent(record.rootPath);
}

/**
 * One declared member as the record it should hold, and its action against
 * the stored records; null for a part that holds no record (stage 8), and
 * `retire` for a record whose member's content is now a part's.
 */
function planOne(
  records: HostedProjectRecord[],
  familyRootId: string,
  parentId: string,
  parentDir: string,
  parentQualifier: string,
  decl: MemberDeclaration,
): PlannedMemberRecord | null {
  const qualifier = `${parentQualifier}${SUBPROJECT_SEPARATOR}${decl.alias}`;
  const unreadable = (reason: string): PlannedMemberRecord => ({
    record: { id: decl.alias, rootPath: '', status: 'active', createdAt: '', parentProjectId: parentId, memberPath: decl.path ?? '' },
    familyRootId, qualifier, action: 'unreadable', reason,
  });
  if (decl.refused !== undefined || decl.path === undefined) return unreadable(`its declaration cannot be followed: ${decl.refused ?? 'it names no path'}`);
  let dir: string;
  try {
    dir = resolveContainedProjectPath(parentDir, decl.path);
  } catch (e) {
    return unreadable(`its path "${decl.path}" does not stay within its parent: ${e instanceof Error ? e.message : String(e)}`);
  }
  // A project.yaml that cannot be parsed at all is a member nobody can read, never a part: say why.
  if (files.exists(aiPathsAt(dir).projectConfig()) && rawConfigAt(dir) === null) {
    const unparsed = memberIdAt(dir);
    return unreadable('reason' in unparsed ? unparsed.reason : 'its .wai/project.yaml cannot be read');
  }
  // A part is part of its parent's record (stage 8): a record its member held as a project is retired.
  if (files.exists(dir) && !holdsProjectContent(dir)) {
    const memberPath = normalizeMemberPath(decl.path);
    const held = records.find((r) => r.parentProjectId === parentId && r.memberPath === memberPath && r.status === 'active');
    return held ? { record: held, familyRootId, qualifier, action: 'retire', reason: `part of ${parentId}` } : null;
  }
  const read = memberIdAt(dir);
  if ('reason' in read) return unreadable(read.reason);
  const memberId = read.id;
  const memberPath = normalizeMemberPath(decl.path);
  const record: HostedProjectRecord = { id: memberId, rootPath: dir, status: 'active', createdAt: '', parentProjectId: parentId, memberPath };
  const holder = records.find((r) => r.id === memberId);
  if (holder) {
    const agrees = holder.parentProjectId === parentId && holder.memberPath === memberPath;
    // A record disabled when its member left the family returns when the family declares it again.
    const action = !agrees ? 'relocate' : holder.status === 'disabled' ? 'return' : 'unchanged';
    return { record: { ...record, createdAt: holder.createdAt, status: holder.status }, familyRootId, qualifier, action };
  }
  const previous = records.find((r) => r.parentProjectId === parentId && r.memberPath === memberPath);
  return previous
    ? { record, familyRootId, qualifier, action: 'rename', previousId: previous.id }
    : { record, familyRootId, qualifier, action: 'register' };
}

/**
 * Validate ONE projects-narrowing entry at MINT time and answer what is stored:
 * '*' and a record id as they are. A member-qualified entry ('projectId::alias')
 * is refused, naming the member's record id as the form to use, and so is an
 * entry that is no project id or names a project no record holds - a broken
 * narrowing is never stored.
 */
export function assertMintableNarrowingEntry(dataDir: string, entry: string): string {
  if (entry === '*') return entry;
  if (entry.includes(SUBPROJECT_SEPARATOR)) {
    // Name the forms that work: each member record of the named project, and the grant that confines to a subsystem.
    const parent = entry.slice(0, entry.indexOf(SUBPROJECT_SEPARATOR));
    const members = isValidProjectId(parent)
      ? load(dataDir).filter((r) => r.parentProjectId === parent && r.status === 'active').map((r) => r.id).sort()
      : [];
    throw new Error(
      `invalid project narrowing entry "${entry}": a member is a record of its own - name it by its project record id`
      + (members.length > 0 ? ` (the member records of "${parent}": ${members.map((m) => `"${m}"`).join(', ')})` : '')
      + '. A key narrows to whole projects, never to a subsystem: to confine a person to one subsystem, grant it with '
      + '`wairon host permission set --user <id> --capability project:write --project <id> --subsystem <id>`.',
    );
  }
  if (!isValidProjectId(entry)) {
    throw new Error(`invalid project narrowing entry "${entry}" (expected '*' or a project id)`);
  }
  if (!load(dataDir).some((r) => r.id === entry)) throw new Error(`unknown project "${entry}"`);
  return entry;
}

// ── Binding ─────────────────────────────────────────────────────────────────

/** The resolved binding of one authorized data-plane request: the bound
 *  record, its root and its family root. */
export interface ProjectBinding {
  rootPath: string;
  projectId: string;
  familyRootId: string;
}

/** True when an entry covers the target record: equal to it, or naming a record it descends from. */
function entryCovers(records: HostedProjectRecord[], entryId: string, target: HostedProjectRecord): boolean {
  return entryId === target.id || descendsFrom(records, target, entryId);
}

/**
 * Resolve the binding of an authorized target to a hosted RECORD. Coverage
 * follows the project chain as permissions do: an entry covers a target iff it
 * is '*', equal to it, or names a project the target descends from. A
 * member-qualified selector names no record and resolves to null. A member record is bound only while its derived directory still
 * holds a project whose id is the record's. Returns null — with no existence
 * leak — for anything outside the authorized set, unknown or inactive.
 */
function indexResolveBinding(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): ProjectBinding | null {
  // Step 1: fix the target.
  const authorized = principal.projects;
  const wildcard = authorized.includes('*');
  let target: string;
  if (selector) target = selector;
  else if (!wildcard && authorized.length === 1) target = authorized[0];
  else return null;
  // A member-qualified form names no record and resolves to null.
  if (target.includes(SUBPROJECT_SEPARATOR)) return null;
  // Steps 2-4: authorize by the project chain, then load the record.
  const records = load(dataDir);
  const rec = records.find((r) => r.id === target);
  if (!rec || !isValidProjectId(rec.id)) return null;
  if (!wildcard && !authorized.some((e) => entryCovers(records, e, rec))) return null;
  if (rec.status !== 'active') return null;
  // Steps 5-6: a member's root is derived, and must still hold the record's project.
  const rootPath = derivedRoot(records, rec);
  if (rootPath === null) return null;
  if (rec.parentProjectId && projectIdAt(rootPath) !== rec.id) return null;
  const familyRoot = familyRootOf(records, rec);
  if (!familyRoot) return null;
  // Step 7.
  return { rootPath, projectId: rec.id, familyRootId: familyRoot.id };
}

/**
 * Resolve the root of the authorized record — the rootPath projection of
 * the index's binding resolution, for callers that need only the root.
 */
function indexResolveRoot(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): string | null {
  return indexResolveBinding(dataDir, principal, selector)?.rootPath ?? null;
}

/** project_repository.resolveBinding — forwarded 1:1 to the project index. */
export function resolveProjectBinding(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): ProjectBinding | null {
  return indexResolveBinding(dataDir, principal, selector);
}

/** project_repository.resolveRoot — forwarded 1:1 to the project index. */
export function resolveProjectRoot(
  dataDir: string,
  principal: Principal,
  selector?: string | null,
): string | null {
  return indexResolveRoot(dataDir, principal, selector);
}
