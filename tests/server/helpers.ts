import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { setAssignment } from '../../src/server/permissions.js';
import { createUnit } from '../../src/server/organization.js';
import { createProject } from '../../src/server/admin.js';
import type {
  ApiKeyRecord,
  Capability,
  HostConfig,
  OrganizationUnitRecord,
  PermissionValue,
  PrincipalSubject,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Shared assignment-model test helpers (sdd_host).
//
// The grant model is gone: a credential record carries NO permissions — a token
// is a narrowing over its OWNER's live permission, and authority comes from the
// assignment grid (setAssignment) + role bindings, resolved per request. These
// helpers give every suite the same three primitives: a grants-free token, a
// grid assignment, and a placed project (every project is placed at creation).
// ---------------------------------------------------------------------------

export function subjectOf(userId: string, over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId, kind: 'human', issuer: 'local', ...over };
}

/** Mint a stored grants-free token owned by `userId`; returns the plaintext.
 *  Authority comes exclusively from the assignment grid (see allow()). */
export function mintUserToken(
  dataDir: string,
  opts: { id: string; userId: string; projects?: string[]; subject?: Partial<PrincipalSubject> },
): string {
  const token = 'wk_' + crypto.randomBytes(8).toString('hex');
  const record: ApiKeyRecord = {
    id: opts.id,
    keyHash: hashToken(token),
    projects: opts.projects ?? ['*'],
    createdAt: new Date().toISOString(),
    ownerSubject: subjectOf(opts.userId, opts.subject),
  };
  createCredential(dataDir, record);
  return token;
}

/** Seed one assignment in the permission grid: the ONLY way a non-admin subject
 *  gains authority under the resolver model. */
export function allow(
  dataDir: string,
  userId: string,
  capability: Capability,
  scopeKind: ScopeKind,
  scopeId: string | undefined,
  value: PermissionValue = 'yes',
): void {
  setAssignment(dataDir, {
    id: '',
    subjectKind: 'user',
    subjectId: userId,
    scopeKind,
    ...(scopeId !== undefined ? { scopeId } : {}),
    capability,
    value,
    createdAt: '',
  });
}

/** Create an organization unit (projects must be placed somewhere). The name
 *  doubles as the slug, so the qualified id is parentId + '.' + name (or the
 *  name itself for a root unit). */
export function seedUnit(dataDir: string, name: string, over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  return createUnit(dataDir, {
    id: '',
    name,
    slug: name,
    kind: 'team',
    status: 'active',
    createdAt: '',
    createdBy: subjectOf('u-seeder'),
    ...over,
  });
}

/** Seed a subsystem spec into the spec tree at `root` — a CHAINED mount when
 *  projectPath is given (the shape `wairon subsystem add` produces), an
 *  ordinary in-tree subsystem otherwise. */
export function seedSubsystem(root: string, subsystemId: string, projectPath?: string): void {
  const dir = path.join(root, '.wai', 'specs', 'subsystems');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${subsystemId}.yaml`),
    [
      `id: ${subsystemId}`,
      `name: ${subsystemId}`,
      `description: subsystem ${subsystemId}`,
      'parentSystem: root-system',
      ...(projectPath ? [`projectPath: ${projectPath}`] : []),
      "createdAt: '2026-01-01T00:00:00.000Z'",
      "updatedAt: '2026-01-01T00:00:00.000Z'",
      '',
    ].join('\n'),
  );
}

/** Seed a chained-subproject fixture: the subsystem spec carrying projectPath
 *  in the tree at `root`, plus the real child dir (with its own .wai/specs)
 *  inside the root. Returns the resolved child dir. */
export function seedChainedMount(root: string, subsystemId: string, projectPath: string): string {
  seedSubsystem(root, subsystemId, projectPath);
  const childDir = path.resolve(root, projectPath);
  fs.mkdirSync(path.join(childDir, '.wai', 'specs'), { recursive: true });
  return childDir;
}

/** Create a project through the admin plane (master credential) placed into a
 *  fresh unit; returns the unit so tests can scope assignments to it. */
export function createPlacedProject(
  cfg: HostConfig,
  master: string,
  projectId: string,
  unit?: OrganizationUnitRecord,
): OrganizationUnitRecord {
  const target = unit ?? seedUnit(cfg.dataDir, `unit-${projectId}`);
  createProject(cfg, master, projectId, target.id);
  return target;
}
