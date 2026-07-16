import * as fs from 'fs';
import * as path from 'path';
import type { Role } from './types.js';

// ---------------------------------------------------------------------------
// Role Repository (sdd_host)
//
// File-backed durable state for permission-role definitions at
// <dataDir>/roles.json, mirroring the user repository's storage convention.
//
// Internally this is the owned store / registry / index triad from the specs:
//   - store    (loadStore / replaceAll): authoritative record set, disk-backed.
//   - registry (registryCreate/…):       the write path — mutate + atomic swap.
//   - index    (indexGetRole/…):         the read path — pure projection.
// The exported functions are the role_repository facade: pure 1:1 forwarding.
//
// BUILT-IN ROLES are intrinsic code constants, NOT stored rows: the
// authorization specialist merges them into every PermissionWorld, so a binding
// to one always resolves without a seed step (no seeding to forget, no silent
// admin lockout). Role CRUD refuses to create/edit/delete a reserved id.
// ---------------------------------------------------------------------------

/**
 * The built-in reserved roles. `sso-admin` is bound automatically by the SSO
 * flows when a user's verified groups intersect the provider's adminGroupClaims.
 * It grants instance-wide project:admin + project:create — deliberately NOT the
 * instance-admin bypass, which is env-anchored to the built-in super-admin and
 * can never be conferred by a role, an assignment, or a minted token.
 */
/** The reserved id of the built-in SSO-admin role (see BUILTIN_ROLES). */
export const SSO_ADMIN_ROLE_ID = 'sso-admin';

export const BUILTIN_ROLES: Role[] = [
  {
    id: SSO_ADMIN_ROLE_ID,
    name: 'SSO Admin',
    description:
      "Built-in role bound automatically to users in an identity provider's admin groups. Grants instance-wide project administration and project creation — never the env-anchored instance-admin bypass.",
    permissions: [
      { capability: 'project:admin', value: 'yes' },
      { capability: 'project:create', value: 'yes' },
    ],
    createdAt: '1970-01-01T00:00:00.000Z',
  },
];

const BUILTIN_ROLE_IDS = new Set(BUILTIN_ROLES.map((r) => r.id));

/** True when the id names an intrinsic built-in role, which CRUD must refuse. */
export function isBuiltinRoleId(roleId: string): boolean {
  return BUILTIN_ROLE_IDS.has(roleId);
}

function storePath(dataDir: string): string {
  return path.join(dataDir, 'roles.json');
}

// ── Store ────────────────────────────────────────────────────────────────

/**
 * Load the persisted role collection as the authoritative record representation.
 * A missing file yields an empty set (first boot is not an error); an unreadable
 * file or structurally invalid JSON fails with a storage error naming the path so
 * the operator can repair it — persisted roles are never silently discarded.
 */
function loadStore(dataDir: string): Role[] {
  const p = storePath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Cannot read role store at ${p}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed role store at ${p}: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Malformed role store at ${p}: expected a JSON array of roles.`);
  }
  return parsed as Role[];
}

/**
 * Swap the authoritative set to the supplied complete role set in one atomic
 * write-temp-then-rename, so a crash never truncates the file and readers never
 * observe a half-written state. Only called by the registry after a mutation.
 */
function replaceAll(dataDir: string, roles: Role[]): void {
  const p = storePath(dataDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(roles, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// ── Registry (write path) ──────────────────────────────────────────────────

/**
 * Create one role: stamp createdAt, reject a duplicate id (never a silent
 * overwrite) and a reserved built-in id, persist the full collection atomically,
 * and return the stored role.
 */
function registryCreate(dataDir: string, role: Role): Role {
  if (isBuiltinRoleId(role.id)) {
    throw new Error(`Role "${role.id}" is a reserved built-in role and cannot be created.`);
  }
  const roles = loadStore(dataDir);
  if (roles.some((r) => r.id === role.id)) {
    throw new Error(`Role "${role.id}" already exists.`);
  }
  const stored: Role = { ...role, createdAt: new Date().toISOString() };
  roles.push(stored);
  replaceAll(dataDir, roles);
  return stored;
}

/**
 * Update one existing role by id (name, description, permissions), preserving
 * createdAt/createdBy. An unknown id fails with a not-found error; a reserved
 * built-in id is refused. Persists atomically and returns the stored role.
 */
function registryUpdate(dataDir: string, role: Role): Role {
  if (isBuiltinRoleId(role.id)) {
    throw new Error(`Role "${role.id}" is a reserved built-in role and cannot be modified.`);
  }
  const roles = loadStore(dataDir);
  const idx = roles.findIndex((r) => r.id === role.id);
  if (idx === -1) {
    throw new Error(`Role "${role.id}" not found.`);
  }
  const stored: Role = { ...role, createdAt: roles[idx].createdAt, createdBy: roles[idx].createdBy };
  roles[idx] = stored;
  replaceAll(dataDir, roles);
  return stored;
}

/**
 * Delete one role by id and persist atomically; deleting an absent role is a
 * no-op. Callers are responsible for clearing role bindings that reference it —
 * a binding to a now-unknown role simply confers nothing during resolution.
 */
function registryDelete(dataDir: string, roleId: string): void {
  if (isBuiltinRoleId(roleId)) {
    throw new Error(`Role "${roleId}" is a reserved built-in role and cannot be deleted.`);
  }
  const roles = loadStore(dataDir);
  const remaining = roles.filter((r) => r.id !== roleId);
  if (remaining.length === roles.length) return;
  replaceAll(dataDir, remaining);
}

// ── Index (read path) ──────────────────────────────────────────────────────

/** Return the stored role whose id matches exactly, or null when absent. */
function indexGetRole(dataDir: string, roleId: string): Role | null {
  return loadStore(dataDir).find((r) => r.id === roleId) ?? null;
}

/** Return every stored role, sorted by id for stable listing. */
function indexListRoles(dataDir: string): Role[] {
  return loadStore(dataDir).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ── Repository facade (1:1 forwarding) ─────────────────────────────────────

/** Create one role through the repository facade (atomic). */
export function createRole(dataDir: string, role: Role): Role {
  return registryCreate(dataDir, role);
}

/** Update one role through the repository facade (atomic). */
export function updateRole(dataDir: string, role: Role): Role {
  return registryUpdate(dataDir, role);
}

/** Delete one role through the repository facade. */
export function deleteRole(dataDir: string, roleId: string): void {
  registryDelete(dataDir, roleId);
}

/** Look up one role through the repository facade, or null when absent. */
export function getRole(dataDir: string, roleId: string): Role | null {
  return indexGetRole(dataDir, roleId);
}

/** List the stored (admin-defined) roles through the repository facade. */
export function listRoles(dataDir: string): Role[] {
  return indexListRoles(dataDir);
}
