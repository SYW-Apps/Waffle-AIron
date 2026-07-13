import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  requestProjectLock,
  requestProjectPromotion,
  getRequestStatus,
  decideRequest,
  executeApprovedRequest,
} from '../../src/server/selfservice.js';
import {
  evaluateProjectPolicy,
  reconcileProjectPolicy,
  setPackPolicy,
  initializeProjectWithProfile,
} from '../../src/server/policy.js';
import { revokeToken, ForbiddenError } from '../../src/server/identity.js';
import { getGraph, getProjectCanvas } from '../../src/server/web.js';
import * as webproject from '../../src/server/webproject.js';
import {
  listVisibleSurfaces,
  getProjectSurfaceForMcp,
  listReachableProjectsForMcp,
  listReachableProjectInterfacesForMcp,
} from '../../src/server/landscape.js';
import { createProject } from '../../src/server/admin.js';
import { upsertOrganizationUnit } from '../../src/server/organization.js';
import { createCredential, hashToken, findByTokenHash } from '../../src/server/credentials.js';
import { createWebSession } from '../../src/server/websessions.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import type {
  ApiKeyRecord,
  ApprovalDecision,
  ApprovalRequest,
  HostConfig,
  InstancePackPolicy,
  PrincipalSubject,
  ProjectGrant,
  WebSession,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Regression suite: a UNIT-scoped wildcard grant {projectId:'*', orgUnitId:X}
// is unit-scoped BY INTENT (the shape an operator enters for a delegated
// unit/department admin) and must NEVER be read as an instance-wide/super-admin
// grant nor satisfy a flat '*' project match cross-tenant. Two tenants (unit-a
// with proj-a, unit-b with proj-b) prove three things on every fixed surface:
//   1. the unit-a wildcard admin cannot reach tenant B,
//   2. the unit-a admin still works WITHIN unit A's subtree (where the surface
//      supports unit scoping),
//   3. a genuine instance admin {projectId:'*', permissions:['*']} (no
//      orgUnitId) still passes everywhere.
// Covers: selfservice (lock/promote request, status view, execute), policy
// (evaluate/reconcile/set-policy/init), identity (revokeToken), the web
// graph/canvas plane, and the landscape observer-identity gates.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';

function subject(userId: string): PrincipalSubject {
  return { userId, kind: 'human', issuer: 'local' };
}

/** A full InstancePackPolicy with permissive defaults (mirrors policy.test.ts). */
function samplePolicy(over: Partial<InstancePackPolicy> = {}): InstancePackPolicy {
  return {
    id: 'inst-policy',
    requiredGlobalPacks: [],
    defaultProjectPacks: [],
    allowedProfileIds: [],
    requiredProfileIds: [],
    blockedPackNames: [],
    requireProfileSelection: false,
    enforcementMode: 'warn',
    updatedAt: '',
    ...over,
  };
}

describe('unit-scoped wildcard grants are never instance-wide (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };
  const now = new Date().toISOString();
  const createdBy = subject('u-admin');

  // Plaintext credentials minted per test run.
  let unitAdminA: string; // {projectId:'*', orgUnitId:'unit-a', permissions:['*']} — tenant A delegated admin
  let instanceAdmin: string; // {projectId:'*', permissions:['*']} — genuine super-admin
  let requesterB: string; // {projectId:'proj-b', permissions:['mcp:write']} — tenant B author
  let agentB: string; // {projectId:'proj-b', permissions:['mcp:read','mcp:write']} — tenant B agent

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-unit-wildcard-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    invalidateSpecCache();

    // Two tenants: unit-a owns proj-a, unit-b owns proj-b (auto-placed on create).
    upsertOrganizationUnit(dataDir, { id: 'unit-a', name: 'Tenant A', kind: 'team', status: 'active', createdAt: now, createdBy });
    upsertOrganizationUnit(dataDir, { id: 'unit-b', name: 'Tenant B', kind: 'team', status: 'active', createdAt: now, createdBy });
    createProject(cfg, MASTER, 'proj-a', 'unit-a');
    createProject(cfg, MASTER, 'proj-b', 'unit-b');

    unitAdminA = mintToken('tok-unit-a', [{ projectId: '*', orgUnitId: 'unit-a', permissions: ['*'] }], 'u-unit-a');
    instanceAdmin = mintToken('tok-admin', [{ projectId: '*', permissions: ['*'] }], 'u-instance-admin');
    requesterB = mintToken('tok-req-b', [{ projectId: 'proj-b', permissions: ['mcp:write'] }], 'u-req-b');
    agentB = mintToken('tok-agent-b', [{ projectId: 'proj-b', permissions: ['mcp:read', 'mcp:write'] }], 'u-agent-b');
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored bearer token. The compatibility `projects` projection is
   *  derived exactly like production mints do (the raw grant projectIds), so a
   *  unit-scoped '*' grant reproduces the flat `projects: ['*']` artifact the
   *  fixed gates must not trust. */
  function mintToken(id: string, grants: ProjectGrant[], userId: string): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id,
      keyHash: hashToken(token),
      role: 'editor',
      projects: grants.map((g) => g.projectId),
      grants,
      createdAt: new Date().toISOString(),
      ownerSubject: subject(userId),
    };
    createCredential(dataDir, record);
    return token;
  }

  /** A browser session carrying the given grants (mirrors web.test.ts). */
  function session(grants: ProjectGrant[], userId: string): WebSession {
    return createWebSession(dataDir, {
      id: '',
      subject: subject(userId),
      grants,
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  function decision(requestId: string, approved = true): ApprovalDecision {
    return {
      requestId,
      approved,
      decidedBy: subject('ignored-client-value'), // server-authoritative; overwritten
      decidedAt: '',
    };
  }

  // ── selfservice: lock/promotion requests (public data plane) ───────────────

  it('requestProjectLock/Promotion: a unit-a wildcard admin cannot request for tenant B, still can within unit A, and a genuine instance admin can everywhere', () => {
    expect(() => requestProjectLock(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);
    expect(() => requestProjectPromotion(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);

    const own = requestProjectLock(cfg, unitAdminA, 'proj-a');
    expect(own.status).toBe('pending');
    expect(own.projectId).toBe('proj-a');

    const admin = requestProjectLock(cfg, instanceAdmin, 'proj-b');
    expect(admin.status).toBe('pending');
  });

  // ── selfservice: approval status view (public data plane) ──────────────────

  it('getRequestStatus: a unit-a wildcard admin cannot view tenant B\'s request; an in-scope unit decider, the requester, and an instance admin can', () => {
    const req = requestProjectLock(cfg, requesterB, 'proj-b');

    expect(() => getRequestStatus(cfg, unitAdminA, req.id)).toThrow(ForbiddenError);

    const deciderB = mintToken('tok-dec-b', [{ projectId: '*', orgUnitId: 'unit-b', permissions: ['approval:decide'] }], 'u-dec-b');
    expect(getRequestStatus(cfg, deciderB, req.id).id).toBe(req.id);
    expect(getRequestStatus(cfg, requesterB, req.id).id).toBe(req.id);
    expect(getRequestStatus(cfg, instanceAdmin, req.id).id).toBe(req.id);
  });

  // ── selfservice: deciding (guard: the already-scoped path stays scoped) ────

  it('decideRequest: a unit-a approval:decide wildcard grant cannot decide tenant B\'s request; the unit-b decider can', () => {
    const req = requestProjectLock(cfg, requesterB, 'proj-b');

    const deciderA = mintToken('tok-dec-a', [{ projectId: '*', orgUnitId: 'unit-a', permissions: ['approval:decide'] }], 'u-dec-a');
    expect(() => decideRequest(cfg, deciderA, decision(req.id))).toThrow(ForbiddenError);

    const deciderB = mintToken('tok-dec-b', [{ projectId: '*', orgUnitId: 'unit-b', permissions: ['approval:decide'] }], 'u-dec-b');
    const decided = decideRequest(cfg, deciderB, decision(req.id));
    expect(decided.status).toBe('approved');
    expect(decided.decidedBy?.userId).toBe('u-dec-b'); // server-authoritative
  });

  // ── selfservice: executing an approval ──────────────────────────────────────

  it('executeApprovedRequest: a unit-a wildcard admin is NOT an instance admin (Forbidden before any status check); genuine admins pass the authorization gate', () => {
    const req: ApprovalRequest = requestProjectLock(cfg, requesterB, 'proj-b');

    // The authorization gate precedes the approved-status gate, so the DENIAL
    // shape distinguishes the two: the unit-a admin is refused outright, while
    // an authorized caller on this still-pending request reaches the status
    // error instead (proving the gate admitted it without executing anything).
    expect(() => executeApprovedRequest(cfg, unitAdminA, req.id)).toThrow(ForbiddenError);
    expect(() => executeApprovedRequest(cfg, instanceAdmin, req.id)).toThrow(/pending, not approved/);
    expect(() => executeApprovedRequest(cfg, requesterB, req.id)).toThrow(/pending, not approved/);
  });

  // ── policy plane (loopback admin plane; flat checks hardened) ──────────────

  it('evaluate/reconcileProjectPolicy: a unit-a wildcard admin cannot touch tenant B but IS first-class over its own subtree; a project-scoped writer and an instance admin still can', () => {
    expect(() => evaluateProjectPolicy(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);
    expect(() => reconcileProjectPolicy(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);

    // The policy plane is scope-aware: the unit-a admin's resolved mcp:write
    // scope expands to its subtree's projects, so it CAN evaluate/reconcile its
    // OWN project without needing instance-wide reach.
    expect(evaluateProjectPolicy(cfg, unitAdminA, 'proj-a').compliant).toBe(true); // permissive default policy
    expect(reconcileProjectPolicy(cfg, unitAdminA, 'proj-a').compliant).toBe(true);

    const writerB = mintToken('tok-writer-b', [{ projectId: 'proj-b', permissions: ['mcp:write'] }], 'u-writer-b');
    expect(evaluateProjectPolicy(cfg, writerB, 'proj-b').compliant).toBe(true); // permissive default policy
    expect(evaluateProjectPolicy(cfg, instanceAdmin, 'proj-b').compliant).toBe(true);
  });

  it('setPackPolicy / initializeProjectWithProfile: instance-wide capabilities refuse a unit-scoped wildcard but admit a genuine instance grant', () => {
    expect(() => setPackPolicy(cfg, unitAdminA, samplePolicy())).toThrow(ForbiddenError);
    expect(() => initializeProjectWithProfile(cfg, unitAdminA, { id: 'np-a' })).toThrow(ForbiddenError);

    expect(setPackPolicy(cfg, instanceAdmin, samplePolicy()).id).toBe('inst-policy');
    expect(initializeProjectWithProfile(cfg, instanceAdmin, { id: 'np-b' }).id).toBe('np-b');
  });

  // ── identity: token revocation (key:manage over the token's project) ───────

  it('revokeToken: a unit-a wildcard admin cannot revoke tenant B\'s token; the unit-b admin and an instance admin can', () => {
    const targetPlain1 = mintToken('victim-1', [{ projectId: 'proj-b', permissions: ['mcp:read'] }], 'u-victim');
    const targetPlain2 = mintToken('victim-2', [{ projectId: 'proj-b', permissions: ['mcp:read'] }], 'u-victim');

    expect(() => revokeToken(cfg, unitAdminA, 'victim-1')).toThrow(ForbiddenError);
    // The refused revocation left the credential in place.
    expect(findByTokenHash(dataDir, hashToken(targetPlain1))).not.toBeNull();

    const unitAdminB = mintToken('tok-unit-b', [{ projectId: '*', orgUnitId: 'unit-b', permissions: ['*'] }], 'u-unit-b');
    revokeToken(cfg, unitAdminB, 'victim-1'); // in-subtree: allowed (removes the record)
    expect(findByTokenHash(dataDir, hashToken(targetPlain1))).toBeNull();

    revokeToken(cfg, instanceAdmin, 'victim-2');
    expect(findByTokenHash(dataDir, hashToken(targetPlain2))).toBeNull();
  });

  // ── web plane: project graph + canvas (public data plane) ──────────────────

  it('web graph/canvas: a unit-a wildcard session cannot read tenant B\'s spec tree, but keeps its own tenant', () => {
    const s = session([{ projectId: '*', orgUnitId: 'unit-a', permissions: ['*'] }], 'u-unit-a');

    expect(() => getGraph(cfg, s.id, 'project', 'proj-b', 2)).toThrow(ForbiddenError);
    expect(() => getProjectCanvas(cfg, s.id, 'proj-b')).toThrow(ForbiddenError);

    // The scoped project list is exactly tenant A's subtree…
    expect(webproject.listProjects(cfg, s.id).map((r) => r.id)).toEqual(['proj-a']);
    // …and the in-tenant graph still renders.
    const graph = getGraph(cfg, s.id, 'project', 'proj-a', 1);
    expect(graph.tier).toBe('project');
    expect(graph.scope).toBe('proj-a');

    // A genuine instance-admin session reaches both tenants.
    const admin = session([{ projectId: '*', permissions: ['*'] }], 'u-instance-admin');
    expect(getGraph(cfg, admin.id, 'project', 'proj-b', 1).scope).toBe('proj-b');
  });

  // ── landscape: observer-identity gates (data plane + admin portal) ─────────

  it('landscape discovery: a unit-a wildcard credential cannot observe AS tenant B\'s project; in-tenant and project-scoped observers still work', () => {
    // Cross-tenant observer claims are refused at the gate.
    expect(() => listVisibleSurfaces(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);
    expect(() => listReachableProjectsForMcp(cfg, unitAdminA, 'proj-b')).toThrow(ForbiddenError);
    expect(() => listReachableProjectInterfacesForMcp(cfg, unitAdminA, 'proj-b', 'proj-a')).toThrow(ForbiddenError);
    expect(() => getProjectSurfaceForMcp(cfg, unitAdminA, 'proj-b', 'proj-a')).toThrow(ForbiddenError);

    // The unit admin observes as its OWN tenant's project…
    expect(Array.isArray(listVisibleSurfaces(cfg, unitAdminA, 'proj-a'))).toBe(true);
    expect(listReachableProjectsForMcp(cfg, unitAdminA, 'proj-a')).toEqual([]);
    // …a project-scoped agent observes as its own bound project…
    expect(Array.isArray(listVisibleSurfaces(cfg, agentB, 'proj-b'))).toBe(true);
    expect(listReachableProjectsForMcp(cfg, agentB, 'proj-b')).toEqual([]);
    // …and the bootstrap master (instance-wide) observes as any project.
    expect(Array.isArray(listVisibleSurfaces(cfg, MASTER, 'proj-b'))).toBe(true);
  });
});
