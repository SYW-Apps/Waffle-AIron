import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { authenticateCredential } from './auth.js';
import { UnauthenticatedError, ForbiddenError } from './errors.js';
import { authorize, visibleScopes, actionableUnitIds, isInstanceAdmin } from './authorization.js';
import { appendAuditEvent, DEFAULT_AUDIT_POLICY } from './audit.js';
import {
  getOrganizationUnit,
  listOrganizationUnits,
  listProjectPlacements,
} from './organization.js';
import { listProjectRecords } from './projects.js';
import { resolveSecret } from '../utils/secrets.js';
import type {
  AuditEvent,
  GitBackingBinding,
  HostConfig,
  OrganizationUnitRecord,
  Principal,
  PrincipalSubject,
} from './types.js';

// ---------------------------------------------------------------------------
// Git Backing (sdd_host): container-level backup repositories, DISTINCT from
// the per-project real-repo binding (sdd_git).
//
//   - A UNIT binding mirrors every subtree project's .wai/ tree into a
//     container repo (a repo per org/department, for teams and tenants that
//     want their own).
//   - The INSTANCE binding mirrors the hosted instance structure itself — the
//     flat JSON collections in <dataDir>/ that no per-project repo covers
//     (organization, users, permissions, roles, instance identity, project
//     registry, relations, policies, approvals; credentials only as hashed
//     records) — for real backup and restore. The SECRET STORE is NEVER
//     mirrored, and live web sessions are never mirrored either (session ids
//     are bearer credentials).
//
// Composition mirrors the spec tree:
//   - GitBackingStore    : bindings collection at <dataDir>/git-backing.json.
//   - GitBackingRegistry : upsert (scope-shape validation, one binding per
//                          scope), remove, touchSync. No authorization.
//   - GitBackingIndex    : list / by-id lookups; never mutates.
//   - repository facade  : upsertBinding / removeBinding / touchSync /
//                          listBindings / getBinding — pure 1:1 forwarding.
//   - git_backing_adapter: the only block doing git + filesystem I/O for the
//                          backup working copies under <dataDir>/git-backing/.
//   - git_backing_orchestrator: resolver-gated bind/unbind/sync + the
//                          pre-authorized periodic sweep.
// ---------------------------------------------------------------------------

// ── store ────────────────────────────────────────────────────────────────────

function storePath(dataDir: string): string {
  return path.join(dataDir, 'git-backing.json');
}

class GitBackingStore {
  constructor(private readonly dataDir: string) {}

  /** Load the persisted binding collection; a missing file yields an empty set,
   *  a malformed file fails with a storage error naming the path. */
  load(): GitBackingBinding[] {
    const p = storePath(this.dataDir);
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Cannot read git-backing store at ${p}: ${(err as Error).message}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Malformed git-backing store at ${p}: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Malformed git-backing store at ${p}: expected a JSON array of bindings.`);
    }
    return parsed as GitBackingBinding[];
  }

  /** Swap the persisted collection wholesale via write-temp-then-rename. */
  replaceAll(bindings: GitBackingBinding[]): void {
    const p = storePath(this.dataDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(bindings, null, 2) + '\n');
    fs.renameSync(tmp, p);
  }
}

// ── registry (write path — no authorization here) ────────────────────────────

class GitBackingRegistry {
  constructor(private readonly store: GitBackingStore) {}

  /** Create or replace the binding for a scope: stamp id/createdAt on create,
   *  validate the scope shape, and keep at most ONE binding per scope. */
  upsertBinding(binding: GitBackingBinding): GitBackingBinding {
    if (binding.scopeKind === 'unit' && !binding.scopeId) {
      throw new Error("A 'unit' backing binding must name its scopeId (the qualified unit id).");
    }
    if (binding.scopeKind === 'instance' && binding.scopeId) {
      throw new Error("An 'instance' backing binding names no scopeId.");
    }
    const bindings = this.store.load();
    const stored: GitBackingBinding = {
      ...binding,
      id: binding.id || crypto.randomUUID(),
      createdAt: binding.createdAt || new Date().toISOString(),
    };
    // One binding per scope — a re-bind is a replacement, never a duplicate.
    const sameScope = (b: GitBackingBinding): boolean =>
      b.scopeKind === stored.scopeKind && (b.scopeId ?? '') === (stored.scopeId ?? '');
    const next = [...bindings.filter((b) => !sameScope(b) && b.id !== stored.id), stored];
    this.store.replaceAll(next);
    return stored;
  }

  /** Remove one binding by id (absent = no-op). The repo itself is untouched. */
  removeBinding(bindingId: string): void {
    const bindings = this.store.load();
    const next = bindings.filter((b) => b.id !== bindingId);
    if (next.length === bindings.length) return;
    this.store.replaceAll(next);
  }

  /** Record lastSyncAt after a successful sweep (absent id = no-op). */
  touchSync(bindingId: string, syncedAt: string): void {
    const bindings = this.store.load();
    let changed = false;
    const next = bindings.map((b) => {
      if (b.id !== bindingId) return b;
      changed = true;
      return { ...b, lastSyncAt: syncedAt };
    });
    if (!changed) return;
    this.store.replaceAll(next);
  }
}

// ── index (read path) ─────────────────────────────────────────────────────────

class GitBackingIndex {
  constructor(private readonly store: GitBackingStore) {}

  listBindings(): GitBackingBinding[] {
    return this.store.load();
  }

  getBinding(bindingId: string): GitBackingBinding | null {
    return this.store.load().find((b) => b.id === bindingId) ?? null;
  }
}

// ── repository facade (1:1 forwarding) ────────────────────────────────────────

export function upsertBinding(dataDir: string, binding: GitBackingBinding): GitBackingBinding {
  return new GitBackingRegistry(new GitBackingStore(dataDir)).upsertBinding(binding);
}

export function removeBinding(dataDir: string, bindingId: string): void {
  new GitBackingRegistry(new GitBackingStore(dataDir)).removeBinding(bindingId);
}

export function touchSync(dataDir: string, bindingId: string, syncedAt: string): void {
  new GitBackingRegistry(new GitBackingStore(dataDir)).touchSync(bindingId, syncedAt);
}

export function listBindings(dataDir: string): GitBackingBinding[] {
  return new GitBackingIndex(new GitBackingStore(dataDir)).listBindings();
}

export function getBinding(dataDir: string, bindingId: string): GitBackingBinding | null {
  return new GitBackingIndex(new GitBackingStore(dataDir)).getBinding(bindingId);
}

// ── git_backing_adapter: git + filesystem I/O on a backup working copy ────────
//
// Not bound to any project root — the container repo working copies live under
// <dataDir>/git-backing/<bindingId>/. Uses the same bot committer identity and
// token conventions as the per-project git adapter.

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function authRemote(remote: string): string {
  const token = resolveSecret('git-token');
  if (!token || !/^https:\/\//.test(remote)) return remote;
  return remote.replace(/^https:\/\//, `https://x-access-token:${token}@`);
}

/** Ensure a working copy of the backing repo exists under the workdir (clone on
 *  first use, fetch+checkout the branch afterwards) and return its path. */
export function cloneOrOpen(remote: string, branch: string, workdir: string): string {
  if (!fs.existsSync(path.join(workdir, '.git'))) {
    fs.mkdirSync(workdir, { recursive: true });
    git(['clone', '--branch', branch, authRemote(remote), '.'], workdir);
    git(['config', 'user.name', process.env['WAIRON_GIT_NAME'] || 'wairon-bot'], workdir);
    git(['config', 'user.email', process.env['WAIRON_GIT_EMAIL'] || 'wairon-bot@localhost'], workdir);
  } else {
    git(['fetch', 'origin'], workdir);
    git(['checkout', branch], workdir);
  }
  return workdir;
}

/** Mirror-export one source (directory or file) into a target path inside the
 *  working copy — replace semantics: the target reflects the source exactly,
 *  deletions included. */
export function mirrorTree(sourceDir: string, targetDir: string): void {
  fs.rmSync(targetDir, { recursive: true, force: true });
  const stat = fs.statSync(sourceDir, { throwIfNoEntry: false });
  if (!stat) return; // an absent source mirrors as an absent target
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

/** Stage the working copy's mirrored content, commit with the bot identity, and
 *  push the branch; returns false without committing when nothing changed.
 *  (Staging everything is correct HERE: this repo exists solely for wairon's
 *  mirror — it is never a shared codebase like a per-project real repo.) */
export function commitAndPush(workdir: string, message: string): boolean {
  git(['add', '-A'], workdir);
  const staged = git(['diff', '--cached', '--name-only'], workdir);
  if (!staged) return false;
  git(['commit', '-m', message], workdir);
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], workdir);
  git(['push', 'origin', branch], workdir);
  return true;
}

// ── git_backing_orchestrator ──────────────────────────────────────────────────

/** The instance-structure JSON collections mirrored by an 'instance' binding.
 *  The secret store is NEVER in this list, and neither are live web sessions
 *  (session ids are bearer credentials); credentials appear as hashed records. */
const INSTANCE_STRUCTURE_FILES = [
  'organization.json',
  'users.json',
  'permissions.json',
  'roles.json',
  'instance.json',
  'projects.json',
  'relations.json',
  'pack-policy.json',
  'identity-providers.json',
  'exposure-policy.json',
  'approvals.json',
  'auth/credentials.json',
];

function requirePrincipal(cfg: HostConfig, credential: string | null): Principal {
  const principal = authenticateCredential(cfg.dataDir, credential);
  if (!principal.authenticated) throw new UnauthenticatedError();
  return principal;
}

function principalSubject(principal: Principal): PrincipalSubject {
  return (
    principal.subject ?? { userId: 'token:' + principal.tokenId, kind: 'service', issuer: 'local' }
  );
}

function tryAppendAudit(cfg: HostConfig, event: AuditEvent): void {
  try {
    appendAuditEvent(cfg.dataDir, event, DEFAULT_AUDIT_POLICY);
  } catch (err) {
    console.error(
      `[git-backing] audit append failed for "${event.action}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

function buildAuditEvent(principal: Principal, action: string, level: string, target: string): AuditEvent {
  const event: AuditEvent = {
    id: '',
    timestamp: '',
    level,
    category: 'admin',
    action,
    outcome: 'success',
    actor: principalSubject(principal),
    target,
  };
  if (principal.tokenId) event.tokenId = principal.tokenId;
  return event;
}

/** Require project:admin over a binding's scope (the named unit, or instance
 *  scope for an 'instance' binding). */
function requireScopeAdmin(cfg: HostConfig, principal: Principal, binding: GitBackingBinding, denial: string): void {
  const scopeKind = binding.scopeKind === 'unit' ? 'unit' : 'instance';
  const scopeId = binding.scopeKind === 'unit' ? binding.scopeId! : '';
  if (authorize(cfg.dataDir, principal, 'project:admin', scopeKind, scopeId).value !== 'yes') {
    throw new ForbiddenError(denial);
  }
}

/** All unit ids in the subtree rooted at rootId (root included), by parentId links. */
function subtreeUnitIds(units: OrganizationUnitRecord[], rootId: string): Set<string> {
  const subtree = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const u of units) {
      if (u.parentId !== undefined && subtree.has(u.parentId) && !subtree.has(u.id)) {
        subtree.add(u.id);
        grew = true;
      }
    }
  }
  return subtree;
}

/**
 * Authenticate and return the bindings whose scope the caller holds
 * project:admin over: an instance admin sees all; a unit binding requires its
 * unit among the caller's actionable project:admin units; the instance binding
 * requires instance-level project:admin. A read; not audited.
 */
export function listBackingBindings(cfg: HostConfig, credential: string | null): GitBackingBinding[] {
  const principal = requirePrincipal(cfg, credential);
  const bindings = listBindings(cfg.dataDir);
  if (isInstanceAdmin(principal)) return bindings;
  const units = new Set(actionableUnitIds(visibleScopes(cfg.dataDir, principal, 'project:admin')));
  const instanceWide = authorize(cfg.dataDir, principal, 'project:admin', 'instance', '').value === 'yes';
  return bindings.filter((b) =>
    b.scopeKind === 'instance' ? instanceWide : b.scopeId !== undefined && units.has(b.scopeId),
  );
}

/**
 * Authenticate, require project:admin over the binding's scope, validate a
 * 'unit' scope resolves to an existing organization unit, upsert the binding
 * (one per scope), and audit at security level.
 */
export function bindScope(cfg: HostConfig, credential: string | null, binding: GitBackingBinding): GitBackingBinding {
  const principal = requirePrincipal(cfg, credential);
  // The shape check precedes the unit lookup so a scope-less 'unit' binding
  // reports its actual defect (the registry re-validates on write).
  if (binding.scopeKind === 'unit' && !binding.scopeId) {
    throw new Error("A 'unit' backing binding must name its scopeId (the qualified unit id).");
  }
  requireScopeAdmin(cfg, principal, binding, 'binding a backup repository requires project:admin over its scope');
  if (binding.scopeKind === 'unit' && !getOrganizationUnit(cfg.dataDir, binding.scopeId ?? '')) {
    throw new Error(`Unknown organization unit "${binding.scopeId}".`);
  }
  const stored = upsertBinding(cfg.dataDir, { ...binding, createdBy: principalSubject(principal) });
  tryAppendAudit(cfg, buildAuditEvent(principal, 'git.backing.bind', 'security', stored.id));
  return stored;
}

/**
 * Authenticate, look up the binding (not-found when absent), require
 * project:admin over ITS scope, remove it, and audit at security level. The
 * backing repository itself is untouched.
 */
export function unbindScope(cfg: HostConfig, credential: string | null, bindingId: string): void {
  const principal = requirePrincipal(cfg, credential);
  const binding = getBinding(cfg.dataDir, bindingId);
  if (!binding) throw new Error(`Backing binding "${bindingId}" not found.`);
  requireScopeAdmin(cfg, principal, binding, 'unbinding a backup repository requires project:admin over its scope');
  removeBinding(cfg.dataDir, bindingId);
  tryAppendAudit(cfg, buildAuditEvent(principal, 'git.backing.unbind', 'security', bindingId));
}

/** Run one binding's mirror sync (pre-authorized — callers gate). Returns
 *  whether anything was published. */
function runMirrorSync(cfg: HostConfig, binding: GitBackingBinding): boolean {
  const workdir = path.join(cfg.dataDir, 'git-backing', binding.id);
  cloneOrOpen(binding.remote, binding.branch, workdir);

  if (binding.scopeKind === 'unit') {
    // Every project placed in the unit's subtree mirrors as projects/<id>/.wai/.
    const units = listOrganizationUnits(cfg.dataDir);
    const subtree = subtreeUnitIds(units, binding.scopeId!);
    const placedIds = new Set(
      listProjectPlacements(cfg.dataDir)
        .filter((p) => subtree.has(p.unitId))
        .map((p) => p.projectId),
    );
    const projectsDir = path.join(workdir, 'projects');
    fs.rmSync(projectsDir, { recursive: true, force: true });
    for (const rec of listProjectRecords(cfg.dataDir)) {
      if (!placedIds.has(rec.id)) continue;
      mirrorTree(path.join(rec.rootPath, '.wai'), path.join(projectsDir, rec.id, '.wai'));
    }
  } else {
    // The instance structure: the flat JSON collections, never the secret store.
    for (const rel of INSTANCE_STRUCTURE_FILES) {
      mirrorTree(path.join(cfg.dataDir, rel), path.join(workdir, 'instance', rel));
    }
  }

  const published = commitAndPush(
    workdir,
    `wairon backing sync: ${binding.scopeKind === 'unit' ? binding.scopeId : 'instance'} @ ${new Date().toISOString()}`,
  );
  if (published) touchSync(cfg.dataDir, binding.id, new Date().toISOString());
  return published;
}

/**
 * Authenticate, require project:admin over the binding's own scope, and run the
 * mirror sync now (commit+push skip-if-clean). Audited at info level. Returns
 * whether anything was published.
 */
export function syncBackingScope(cfg: HostConfig, credential: string | null, bindingId: string): boolean {
  const principal = requirePrincipal(cfg, credential);
  const binding = getBinding(cfg.dataDir, bindingId);
  if (!binding) throw new Error(`Backing binding "${bindingId}" not found.`);
  requireScopeAdmin(cfg, principal, binding, 'syncing a backup repository requires project:admin over its scope');
  const published = runMirrorSync(cfg, binding);
  tryAppendAudit(cfg, buildAuditEvent(principal, 'git.backing.sync', 'info', bindingId));
  return published;
}

/**
 * Pre-authorized sweep for the host supervisor's periodic backup timer — NO
 * authentication; never exposed on any portal. Syncs the bindings whose
 * periodicSyncMinutes has elapsed since lastSyncAt; per-binding failures are
 * recorded and never abort the sweep.
 */
export function runPeriodicBackingSync(cfg: HostConfig): void {
  for (const binding of listBindings(cfg.dataDir)) {
    if (binding.periodicSyncMinutes === undefined) continue;
    const due =
      binding.lastSyncAt === undefined ||
      Date.now() - Date.parse(binding.lastSyncAt) >= binding.periodicSyncMinutes * 60_000;
    if (!due) continue;
    try {
      runMirrorSync(cfg, binding);
    } catch (err) {
      console.error(
        `[git-backing] periodic sync failed for "${binding.id}": ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
