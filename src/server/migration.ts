import * as fs from 'fs';
import * as path from 'path';
import { ensureInstanceIdentity, getInstanceIdentity } from './instance.js';
import { setAssignment, remapScope } from './permissions.js';
import { remapUnitReferences } from './users.js';
import {
  createUnit,
  deletePlacement,
  getOrganizationUnit,
  listProjectPlacements,
  placeProject,
} from './organization.js';
import { listProjectRecords } from './projects.js';
import { LEGACY_SUPERADMIN_USER_ID, LEGACY_LOCALDEV_USER_ID } from './auth.js';
import type {
  Capability,
  PrincipalSubject,
  ScopeKind,
  UnitIdRemap,
} from './types.js';

// ---------------------------------------------------------------------------
// Permission-model rollout migration (`wairon host doctor --fix`).
//
// A hosted data dir written by a PRE-permission-model wairon carries shapes the
// current server no longer produces — and in two cases actively breaks on:
//   - stored GRANTS on users / web sessions / API keys (authority now lives
//     ONLY in the assignment grid + role bindings, resolved live);
//   - master-minted keys with NO ownerSubject (they resolve to ZERO permissions
//     under the live-owner model — every agent silently loses access);
//   - organization units without a slug / qualified dot-path id;
//   - projects placed in NO unit (invisible to every unit-scoped permission);
//   - the guessable 'builtin:*' subject literals (replaced by boot-reserved
//     UUIDs seeded into <dataDir>/instance.json).
//
// This module reads those legacy shapes RAW (the typed repositories no longer
// model them), reports every finding, and — in apply mode — rewrites the data
// in place: grants become grid assignments (via the legacy capability mapping),
// ownerless keys get a synthesized service owner carrying the key's old
// authority, units get slugs + qualified ids with every reference remapped
// (placements, exposeTo, assignment scopes, user home units, role bindings),
// unplaced projects land in an 'unassigned' root unit, and legacy builtin
// sessions/tokens are revoked (their permanent replacements are the persisted
// UUID subjects). Running it again finds nothing — every step is idempotent.
// ---------------------------------------------------------------------------

export interface MigrationFinding {
  area: string;
  detail: string;
}

export interface MigrationReport {
  findings: MigrationFinding[];
  /** True when the findings were applied (--fix), false for a dry-run report. */
  applied: boolean;
}

// ── legacy shapes (raw, untyped elsewhere) ───────────────────────────────────

/** The pre-permission-model stored grant. */
interface LegacyGrant {
  projectId?: string;
  orgUnitId?: string;
  permissions?: string[];
}

/** The legacy fine-grained permission names → the five-capability model. */
const LEGACY_CAPABILITY_MAP: Record<string, Capability> = {
  'mcp:read': 'project:read',
  'operations:read': 'project:read',
  'landscape:read': 'project:read',
  'mcp:write': 'project:write',
  'lock:create': 'project:write',
  'promote:mark-ready': 'project:write',
  'landscape:manage': 'project:admin',
  'user:admin': 'project:admin',
  'audit:read': 'project:admin',
  'key:manage': 'project:admin',
  'policy:manage': 'project:admin',
  'project:destroy': 'project:admin',
  'project:create': 'project:create',
};

/** The capabilities a legacy '*' permission expands to (a delegated admin —
 *  deliberately NOT the env-anchored instance-admin bypass). */
const WILDCARD_CAPABILITIES: Capability[] = ['project:read', 'project:write', 'project:admin', 'project:create'];

function capabilitiesOf(permissions: string[] | undefined): Capability[] {
  const out = new Set<Capability>();
  for (const p of permissions ?? []) {
    if (p === '*') WILDCARD_CAPABILITIES.forEach((c) => out.add(c));
    else if (LEGACY_CAPABILITY_MAP[p]) out.add(LEGACY_CAPABILITY_MAP[p]);
  }
  return [...out];
}

/** The assignment scope a legacy grant anchored at. */
function scopeOf(grant: LegacyGrant): { scopeKind: ScopeKind; scopeId?: string } {
  if (grant.orgUnitId) return { scopeKind: 'unit', scopeId: grant.orgUnitId };
  if (!grant.projectId || grant.projectId === '*') return { scopeKind: 'instance' };
  return { scopeKind: 'project', scopeId: grant.projectId };
}

// ── raw JSON helpers ─────────────────────────────────────────────────────────

function readRaw<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null; // missing or unreadable — that store simply isn't migrated
  }
}

function writeRaw(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unit';
}

const SLUG_PATTERN = /^[a-z0-9-]+$/;

function isLegacyBuiltin(userId: string | undefined): boolean {
  return userId === LEGACY_SUPERADMIN_USER_ID || userId === LEGACY_LOCALDEV_USER_ID;
}

/** Seed one migrated assignment (idempotence: skip when an identical
 *  subject×scope×capability row already sits in the grid). */
function seedAssignment(
  dataDir: string,
  existing: { subjectId?: string; scopeKind: string; scopeId?: string; capability: string }[],
  subjectId: string,
  capability: Capability,
  scope: { scopeKind: ScopeKind; scopeId?: string },
): boolean {
  const already = existing.some(
    (a) =>
      a.subjectId === subjectId &&
      a.capability === capability &&
      a.scopeKind === scope.scopeKind &&
      (a.scopeId ?? '') === (scope.scopeId ?? ''),
  );
  if (already) return false;
  setAssignment(dataDir, {
    id: '',
    subjectKind: 'user',
    subjectId,
    scopeKind: scope.scopeKind,
    ...(scope.scopeId !== undefined ? { scopeId: scope.scopeId } : {}),
    capability,
    value: 'yes',
    createdAt: '',
    createdBy: { userId: 'migration', kind: 'service', issuer: 'local' },
  });
  existing.push({ subjectId, scopeKind: scope.scopeKind, scopeId: scope.scopeId, capability });
  return true;
}

// ── the migration ────────────────────────────────────────────────────────────

/**
 * Inspect (and with `apply` rewrite) a hosted data dir for pre-permission-model
 * shapes. Ordered so later steps see earlier rewrites: instance identity →
 * unit slugs/qualified ids (+ reference remap) → user grants → API keys →
 * web sessions → unplaced projects. Idempotent throughout.
 */
export function migratePermissionModel(dataDir: string, apply: boolean): MigrationReport {
  const findings: MigrationFinding[] = [];
  const found = (area: string, detail: string): void => {
    findings.push({ area, detail });
  };

  // The assignment rows already in the grid — the idempotence guard for every
  // grant translation below (read raw; absent file = empty grid).
  const grid =
    readRaw<{ subjectId?: string; scopeKind: string; scopeId?: string; capability: string }[]>(
      path.join(dataDir, 'permissions.json'),
    ) ?? [];

  // 1. Instance identity: the boot-reserved built-in subject UUIDs.
  if (!getInstanceIdentity(dataDir)) {
    found('instance', 'instance identity is not seeded — the built-in admin/dev subjects have no persisted UUIDs');
    if (apply) ensureInstanceIdentity(dataDir);
  }

  // 2. Organization units: slug backfill + qualified dot-path ids, with every
  //    reference (placements, exposeTo, assignment scopes, users) remapped.
  const orgPath = path.join(dataDir, 'organization.json');
  const org = readRaw<{
    units?: ({ id: string; name?: string; slug?: string; parentId?: string; exposeTo?: string[] } & Record<string, unknown>)[];
    placements?: ({ unitId: string } & Record<string, unknown>)[];
  }>(orgPath);
  if (org?.units?.length) {
    const units = org.units;
    const byId = new Map(units.map((u) => [u.id, u]));
    const depth = (u: { parentId?: string }): number => {
      let d = 0;
      let cur = u.parentId !== undefined ? byId.get(u.parentId) : undefined;
      while (cur && d < units.length) {
        d++;
        cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined;
      }
      return d;
    };

    const remap: UnitIdRemap[] = [];
    const newIds = new Map<string, string>(); // old id → new qualified id
    const taken = new Set<string>();
    for (const unit of [...units].sort((a, b) => depth(a) - depth(b))) {
      // Prefer a stored slug; else a flat id that is already slug-shaped (keeps
      // the id stable — fewest remapped references); else slugify the name.
      let slug =
        unit.slug && SLUG_PATTERN.test(unit.slug)
          ? unit.slug
          : SLUG_PATTERN.test(unit.id)
            ? unit.id
            : slugify(unit.name ?? unit.id);
      const parentNewId = unit.parentId !== undefined ? newIds.get(unit.parentId) : undefined;
      const qualified = (s: string): string => (parentNewId !== undefined ? `${parentNewId}.${s}` : s);
      // Sibling-unique: suffix until the qualified id is free.
      let candidate = qualified(slug);
      for (let n = 2; taken.has(candidate); n++) candidate = qualified(`${slug}-${n}`);
      if (candidate !== qualified(slug)) slug = candidate.slice(candidate.lastIndexOf('.') + 1);
      taken.add(candidate);
      newIds.set(unit.id, candidate);

      if (!unit.slug || unit.slug !== slug) {
        found('units', `unit "${unit.id}" gets slug "${slug}"`);
        if (apply) unit.slug = slug;
      }
      if (candidate !== unit.id) {
        found('units', `unit id "${unit.id}" becomes the qualified path "${candidate}"`);
        remap.push({ oldId: unit.id, newId: candidate });
      }
    }

    if (apply) {
      const lookup = new Map(remap.map((r) => [r.oldId, r.newId]));
      for (const unit of units) {
        unit.id = lookup.get(unit.id) ?? unit.id;
        if (unit.parentId !== undefined) unit.parentId = lookup.get(unit.parentId) ?? unit.parentId;
        if (unit.exposeTo) unit.exposeTo = unit.exposeTo.map((e) => lookup.get(e) ?? e);
      }
      for (const placement of org.placements ?? []) {
        placement.unitId = lookup.get(placement.unitId) ?? placement.unitId;
      }
      writeRaw(orgPath, { units, placements: org.placements ?? [] });
      if (remap.length > 0) {
        remapScope(dataDir, remap); // assignment scopes follow the rename
        remapUnitReferences(dataDir, remap, []); // user home units + binding scopes
      }
    } else if (remap.length > 0) {
      found('units', `${remap.length} unit id(s) would be remapped across placements, exposeTo, assignments, and users`);
    }
  }

  // 3. Users: stored grants become grid assignments; the grants field goes away.
  const usersPath = path.join(dataDir, 'users.json');
  const users = readRaw<({ id: string; subject?: PrincipalSubject; grants?: LegacyGrant[] } & Record<string, unknown>)[]>(usersPath);
  if (users) {
    let changed = false;
    for (const user of users) {
      if (!user.grants?.length) {
        if (user.grants) {
          delete user.grants;
          changed = true;
        }
        continue;
      }
      const subjectId = user.subject?.userId ?? user.id;
      found('users', `user "${user.id}": ${user.grants.length} stored grant(s) become assignments for subject "${subjectId}"`);
      if (apply) {
        for (const grant of user.grants) {
          const scope = scopeOf(grant);
          for (const capability of capabilitiesOf(grant.permissions)) {
            seedAssignment(dataDir, grid, subjectId, capability, scope);
          }
        }
        delete user.grants;
        changed = true;
      }
    }
    if (apply && changed) writeRaw(usersPath, users);
  }

  // 4. API keys: grants → projects narrowing; ownerless keys get a synthesized
  //    service owner CARRYING the key's old authority; legacy-builtin-owned
  //    keys are revoked (the UUID subjects replace those identities).
  const keysPath = path.join(dataDir, 'auth', 'credentials.json');
  const keys = readRaw<({
    id: string;
    role?: string;
    projects?: string[];
    grants?: LegacyGrant[];
    ownerSubject?: PrincipalSubject;
    revokedAt?: string;
  } & Record<string, unknown>)[]>(keysPath);
  if (keys) {
    let changed = false;
    for (const key of keys) {
      if (key.revokedAt) continue;

      if (isLegacyBuiltin(key.ownerSubject?.userId)) {
        found('keys', `key "${key.id}" is owned by the retired literal "${key.ownerSubject?.userId}" — revoked; re-mint for the seeded UUID subject`);
        if (apply) {
          key.revokedAt = new Date().toISOString();
          changed = true;
        }
        continue;
      }

      // grants → the projects narrowing (a unit grant narrows to nothing
      // specific — '*', with the authority coming from the unit assignment).
      const legacyGrants = key.grants;
      if (legacyGrants?.length) {
        const projects = [...new Set(legacyGrants.map((g) => (g.orgUnitId || !g.projectId ? '*' : g.projectId)))];
        found('keys', `key "${key.id}": stored grants become the projects narrowing [${projects.join(', ')}]`);
        if (apply) {
          key.projects = projects.includes('*') ? ['*'] : projects;
          delete key.grants;
          changed = true;
        }
      }

      if (!key.ownerSubject) {
        // The defect this migration exists for: an ownerless key resolves to
        // ZERO permissions. Synthesize a service owner and hand it the key's
        // old authority through the grid.
        const ownerId = `svc-key-${key.id}`;
        found('keys', `key "${key.id}" has no owner — bound to the synthesized service subject "${ownerId}" carrying its legacy authority`);
        if (apply) {
          key.ownerSubject = { userId: ownerId, kind: 'service', issuer: 'local' };
          const caps: { capability: Capability; scope: { scopeKind: ScopeKind; scopeId?: string } }[] = [];
          if (legacyGrants?.length) {
            for (const grant of legacyGrants) {
              for (const capability of capabilitiesOf(grant.permissions)) {
                caps.push({ capability, scope: scopeOf(grant) });
              }
            }
          } else {
            // No grants stored: the legacy display role over the key's
            // projects narrowing is the only authority signal left.
            const roleCaps: Capability[] =
              key.role === 'admin' ? WILDCARD_CAPABILITIES : ['project:read', 'project:write'];
            for (const project of key.projects ?? ['*']) {
              const scope: { scopeKind: ScopeKind; scopeId?: string } =
                project === '*' ? { scopeKind: 'instance' } : { scopeKind: 'project', scopeId: project };
              for (const capability of roleCaps) caps.push({ capability, scope });
            }
          }
          for (const c of caps) seedAssignment(dataDir, grid, ownerId, c.capability, c.scope);
          changed = true;
        }
      }
    }
    if (apply && changed) writeRaw(keysPath, keys);
  }

  // 5. Web sessions: grants → projects narrowing; legacy-builtin sessions are
  //    dropped (their humans re-login as the seeded UUID subjects).
  const sessionsPath = path.join(dataDir, 'web-sessions.json');
  const sessions = readRaw<({
    id: string;
    subject?: PrincipalSubject;
    projects?: string[];
    grants?: LegacyGrant[];
  } & Record<string, unknown>)[]>(sessionsPath);
  if (sessions) {
    let changed = false;
    const kept = sessions.filter((s) => {
      if (isLegacyBuiltin(s.subject?.userId)) {
        found('sessions', `session "${s.id}" belongs to the retired literal "${s.subject?.userId}" — dropped (re-login mints the UUID subject)`);
        changed = true;
        return !apply;
      }
      return true;
    });
    for (const s of kept) {
      if (!s.grants) continue;
      const projects = [...new Set(s.grants.map((g) => (g.orgUnitId || !g.projectId ? '*' : g.projectId)))];
      found('sessions', `session "${s.id}": stored grants become the projects narrowing [${projects.join(', ')}]`);
      if (apply) {
        s.projects = projects.length === 0 || projects.includes('*') ? ['*'] : projects;
        delete s.grants;
        changed = true;
      }
    }
    if (apply && changed) writeRaw(sessionsPath, kept);
  }

  // 6. Unplaced projects: every project is placed — the resolver enumerates
  //    units + PLACED projects, so an unplaced one is in NOBODY's view.
  const placedIds = new Set(listProjectPlacements(dataDir).map((p) => p.projectId));
  const unplaced = listProjectRecords(dataDir).filter((r) => !placedIds.has(r.id));
  if (unplaced.length > 0) {
    found('projects', `${unplaced.length} project(s) are placed in no organization unit: ${unplaced.map((r) => r.id).join(', ')} — placed into the 'unassigned' root unit`);
    if (apply) {
      const system: PrincipalSubject = { userId: 'migration', kind: 'service', issuer: 'local' };
      if (!getOrganizationUnit(dataDir, 'unassigned')) {
        createUnit(dataDir, {
          id: '',
          name: 'Unassigned',
          slug: 'unassigned',
          kind: 'group',
          status: 'active',
          createdAt: '',
          createdBy: system,
        });
      }
      for (const rec of unplaced) {
        placeProject(dataDir, {
          id: '',
          projectId: rec.id,
          unitId: 'unassigned',
          role: 'owner',
          createdAt: '',
          createdBy: system,
        });
      }
    }
  }

  // 7. Duplicate OWNER placements: a project has exactly one owner unit
  //    (cross-unit sharing rides exposeTo), but the pre-move-semantics web
  //    re-place path accumulated a new owner row per move. Keep the NEWEST
  //    owner placement per project (the latest placement intent) and drop the
  //    stale rows — each one draws a phantom empty owner frame on the
  //    environment canvas.
  const ownersByProject = new Map<string, ReturnType<typeof listProjectPlacements>>();
  for (const p of listProjectPlacements(dataDir)) {
    if (p.role !== 'owner') continue;
    const rows = ownersByProject.get(p.projectId) ?? [];
    rows.push(p);
    ownersByProject.set(p.projectId, rows);
  }
  for (const [projectId, rows] of ownersByProject) {
    if (rows.length <= 1) continue;
    // Newest createdAt wins; on a timestamp tie (the registry stamps createdAt
    // itself, so rapid re-places can collide) the LATER stored row wins — later
    // insertion is the later placement intent.
    const sorted = rows
      .map((p, i) => ({ p, i }))
      .sort((a, b) =>
        a.p.createdAt === b.p.createdAt ? b.i - a.i : a.p.createdAt < b.p.createdAt ? 1 : -1,
      )
      .map((x) => x.p);
    const stale = sorted.slice(1);
    found(
      'placements',
      `project "${projectId}" carries ${rows.length} owner placements — keeping the newest (${sorted[0].unitId}), removing ${stale.map((p) => p.unitId).join(', ')}`,
    );
    if (apply) {
      for (const p of stale) deletePlacement(dataDir, p.id);
    }
  }

  return { findings, applied: apply };
}
