import * as crypto from 'node:crypto';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { setAssignment } from '../../src/server/permissions.js';
import { upsertOrganizationUnit } from '../../src/server/organization.js';
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

/** Create an organization unit (projects must be placed somewhere). */
export function seedUnit(dataDir: string, name: string, over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  return upsertOrganizationUnit(dataDir, {
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
