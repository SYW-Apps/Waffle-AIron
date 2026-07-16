import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  initializeProject,
  lockProject,
  promoteProject,
  getApprovalStatus,
  listPendingRequests,
  decideRequest,
  executeApprovedRequest,
  awaitApproval,
} from '../../src/server/projectlifecycle.js';
import { createProject } from '../../src/server/admin.js';
import { setPackPolicyRecord } from '../../src/server/policy.js';
import { upsertOrganizationUnit, placeProject as placeProjectInUnit } from '../../src/server/organization.js';
import { listProjectPacks } from '../../src/server/packs.js';
import { UnauthenticatedError, ForbiddenError } from '../../src/server/errors.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { createProjectRecord, existingProjectRoot } from '../../src/server/projects.js';
import { listApprovalRequests } from '../../src/server/approvals.js';
import { setAssignment } from '../../src/server/permissions.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { readYamlFile } from '../../src/utils/yaml.js';
import type {
  ApiKeyRecord,
  ApprovalRequest,
  Capability,
  HostConfig,
  InstancePackPolicy,
  OrganizationUnitRecord,
  PermissionValue,
  PrincipalSubject,
  ScopeKind,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Project Lifecycle Orchestrator (sdd_host) — exercised through the exported
// orchestrator functions against a real <dataDir> with real minted credentials,
// mirroring identity.test.ts. Covers EXECUTE-PRIMARY semantics: a yes-valued
// permission executes the action directly (completed outcome), an
// approval-valued permission creates a pending ApprovalRequest (pending-approval
// outcome), and a no-valued permission is 403. Also covers decide auto-execution
// (approved = done), the self-approval rejection, awaitApproval long-polling,
// lazy expiry, best-effort audit appends, and end-to-end execution that actually
// provisions on disk.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function subject(over: Partial<PrincipalSubject> = {}): PrincipalSubject {
  return { userId: 'u-x', kind: 'human', issuer: 'local', ...over };
}

/** A full InstancePackPolicy with permissive defaults, overridable per test. */
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

describe('project lifecycle orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let approvalsPath: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-lifecycle-'));
    fs.mkdirSync(dataDir, { recursive: true });
    approvalsPath = path.join(dataDir, 'approvals.json');
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** Mint a stored grants-free token owned by `userId`; returns the plaintext.
   *  Permissions come exclusively from the assignment grid (see allow()). */
  function mintToken(id: string, userId: string, projects: string[] = ['*']): string {
    const token = 'wk_' + crypto.randomBytes(8).toString('hex');
    const record: ApiKeyRecord = {
      id,
      keyHash: hashToken(token),
      projects,
      createdAt: new Date().toISOString(),
      ownerSubject: subject({ userId }),
    };
    createCredential(dataDir, record);
    return token;
  }

  /** Seed one assignment in the permission grid: the ONLY way a non-admin
   *  subject gains authority under the resolver model. */
  function allow(
    userId: string,
    capability: Capability,
    scopeKind: ScopeKind,
    scopeId: string | undefined,
    value: PermissionValue,
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
  function seedUnit(name: string): OrganizationUnitRecord {
    return upsertOrganizationUnit(dataDir, {
      id: '',
      name,
      kind: 'team',
      status: 'active',
      createdAt: '',
      createdBy: subject(),
    });
  }

  /** Create a project through the admin plane (MASTER) placed in a fresh unit. */
  function seedProject(projectId: string): OrganizationUnitRecord {
    const unit = seedUnit(`unit-${projectId}`);
    createProject(cfg, MASTER, projectId, unit.id);
    return unit;
  }

  function seedApprovals(records: ApprovalRequest[]): void {
    fs.writeFileSync(approvalsPath, JSON.stringify(records));
  }

  const nowIso = () => new Date().toISOString();
  const decision = (requestId: string, approved: boolean, reason?: string) => ({
    requestId,
    approved,
    ...(reason !== undefined ? { reason } : {}),
    decidedBy: subject({ userId: 'CLIENT-SUPPLIED' }),
    decidedAt: nowIso(),
  });

  // ── initializeProject: execute-primary ──────────────────────────────────────

  it('yes → executes directly: the project is provisioned and placed, outcome completed, no approval is created', () => {
    const unit = seedUnit('makers');
    const creator = mintToken('cr', 'u-creator');
    allow('u-creator', 'project:create', 'unit', unit.id, 'yes');

    const outcome = initializeProject(cfg, creator, { id: 'alpha', displayName: 'Alpha', ownerUnitId: unit.id });

    expect(outcome.status).toBe('completed');
    expect(outcome.action).toBe('project:init');
    expect(outcome.summary).toContain('Initialized project "alpha"');
    expect(outcome.approval).toBeUndefined();

    // Really provisioned on disk and placed in the unit.
    const root = existingProjectRoot(dataDir, 'alpha');
    expect(root).toBeTruthy();
    expect(fs.existsSync(path.join(root!, '.wai', 'project.yaml'))).toBe(true);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(queryAuditEvents(dataDir, { action: 'lifecycle.completed' }).length).toBeGreaterThanOrEqual(1);
  });

  it('approval → creates a pending project:init with a redacted summary, default 7-day expiry, and an info audit event; the project is NOT created', () => {
    const unit = seedUnit('requesters');
    const requester = mintToken('hp', 'u-hp');
    allow('u-hp', 'project:create', 'unit', unit.id, 'approval');
    const before = Date.now();

    const outcome = initializeProject(cfg, requester, { id: 'alpha', displayName: 'Alpha Project', ownerUnitId: unit.id });

    expect(outcome.status).toBe('pending-approval');
    expect(outcome.action).toBe('project:init');
    const req = outcome.approval!;
    expect(req.status).toBe('pending');
    expect(req.kind).toBe('project:init');
    expect(req.summary).toBe('Initialize project alpha (Alpha Project)');
    expect(req.payloadType).toBe('ProjectInitRequest');
    expect(JSON.parse(req.payload!).id).toBe('alpha');
    expect(req.projectId).toBe('alpha');
    expect(req.requestedBy.userId).toBe('u-hp');
    expect(req.requestedTokenId).toBe('hp');

    const ttl = Date.parse(req.expiresAt!) - before;
    expect(ttl).toBeGreaterThan(SEVEN_DAYS_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(SEVEN_DAYS_MS + 60_000);

    const ev = queryAuditEvents(dataDir, { action: 'approval.request.created' });
    expect(ev).toHaveLength(1);
    expect(ev[0].level).toBe('info');
    expect(ev[0].target).toBe(req.id);

    // The project itself is NOT created by a pending request.
    expect(existingProjectRoot(dataDir, 'alpha')).toBeNull();
  });

  it('no → 403: a subject with no project:create reach may not initialize (instance default is no)', () => {
    const unit = seedUnit('closed');
    const stranger = mintToken('st', 'u-stranger');
    expect(() => initializeProject(cfg, stranger, { id: 'nope', ownerUnitId: unit.id })).toThrow(ForbiddenError);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  });

  it('rejects a missing ownerUnitId — every project is placed at creation', () => {
    const requester = mintToken('nu', 'u-nu');
    expect(() =>
      initializeProject(cfg, requester, { id: 'unplaced' } as unknown as Parameters<typeof initializeProject>[2]),
    ).toThrow(/ownerUnitId is required/i);
  });

  it('rejects an id that already exists as a project', () => {
    const unit = seedUnit('dup-unit');
    createProjectRecord(dataDir, 'dup');
    const requester = mintToken('d', 'u-d');
    expect(() => initializeProject(cfg, requester, { id: 'dup', ownerUnitId: unit.id })).toThrow(/already exists/i);
  });

  it('rejects a structurally invalid project id', () => {
    const unit = seedUnit('iv-unit');
    const requester = mintToken('iv', 'u-iv');
    expect(() => initializeProject(cfg, requester, { id: 'Bad Id!', ownerUnitId: unit.id })).toThrow(/invalid project id/i);
  });

  // ── initializeProject × pack policy ─────────────────────────────────────────

  it('an enforcing (block) policy rejects a non-compliant request BEFORE the permission resolves, creating nothing', () => {
    const unit = seedUnit('blocked');
    setPackPolicyRecord(dataDir, samplePolicy({ enforcementMode: 'block', requireProfileSelection: true }));
    const requester = mintToken('bp', 'u-bp');
    allow('u-bp', 'project:create', 'unit', unit.id, 'yes');

    let caught: unknown;
    try {
      initializeProject(cfg, requester, { id: 'blocked-init', ownerUnitId: unit.id });
    } catch (e) {
      caught = e;
    }
    // Rejected with an actionable, findings-bearing message so the agent learns WHY.
    expect(caught).toBeInstanceOf(ForbiddenError);
    expect((caught as Error).message).toMatch(/policy violation/i);
    expect((caught as Error).message).toMatch(/profile selection is required/i);

    expect(listApprovalRequests(dataDir)).toHaveLength(0);
    expect(existingProjectRoot(dataDir, 'blocked-init')).toBeNull();
  });

  it('a warn-mode non-compliant request still proceeds on the approval path, with the findings appended to the summary', () => {
    const unit = seedUnit('warned');
    setPackPolicyRecord(dataDir, samplePolicy({ enforcementMode: 'warn', requireProfileSelection: true }));
    const requester = mintToken('wp', 'u-wp');
    allow('u-wp', 'project:create', 'unit', unit.id, 'approval');

    const outcome = initializeProject(cfg, requester, { id: 'warned-init', displayName: 'Warned', ownerUnitId: unit.id });
    expect(outcome.status).toBe('pending-approval');
    const req = outcome.approval!;
    expect(req.kind).toBe('project:init');
    // The base summary is preserved and the policy findings are appended for the approver.
    expect(req.summary).toContain('Initialize project warned-init (Warned)');
    expect(req.summary).toMatch(/policy findings:/i);
    expect(req.summary).toMatch(/profile selection is required/i);
    expect(listApprovalRequests(dataDir)).toHaveLength(1);
  });

  // ── lockProject / promoteProject: execute-primary ───────────────────────────

  it('MASTER (instance-admin) locks directly: completed outcome carrying the lock record — the original 403 deadlock is gone', () => {
    seedProject('lock-now');

    const outcome = lockProject(cfg, MASTER, 'lock-now');

    expect(outcome.status).toBe('completed');
    expect(outcome.action).toBe('project:lock');
    expect(outcome.lock?.status).toBe('ready');
    expect(outcome.summary).toContain('Locked project "lock-now"');
    // Executed directly — no approval request was ever created.
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  });

  it('a yes-valued project:write executes promote directly (not-locked on an unlocked project)', () => {
    seedProject('promo-direct');
    const writer = mintToken('pw', 'u-pw');
    allow('u-pw', 'project:write', 'project', 'promo-direct', 'yes');

    const outcome = promoteProject(cfg, writer, 'promo-direct');
    expect(outcome.status).toBe('completed');
    expect(outcome.action).toBe('project:promote');
    expect(outcome.promote?.status).toBe('not-locked'); // reached executeApprovedPromote
  });

  it('an approval-valued project:write creates a pending request instead of executing', () => {
    seedProject('lock-later');
    const requester = mintToken('lr', 'u-lr');
    allow('u-lr', 'project:write', 'project', 'lock-later', 'approval');

    const outcome = lockProject(cfg, requester, 'lock-later');
    expect(outcome.status).toBe('pending-approval');
    const req = outcome.approval!;
    expect(req.kind).toBe('project:lock');
    expect(req.projectId).toBe('lock-later');
    expect(req.summary).toBe('Lock project lock-later');
    expect(queryAuditEvents(dataDir, { action: 'approval.request.created' })).toHaveLength(1);
  });

  it('a no-valued (or unreachable) project:write is 403 for lock and promote', () => {
    seedProject('proj-a');
    const reader = mintToken('ro', 'u-ro');
    allow('u-ro', 'project:read', 'project', 'proj-a', 'yes'); // read reach only

    expect(() => lockProject(cfg, reader, 'proj-a')).toThrow(ForbiddenError);
    expect(() => promoteProject(cfg, reader, 'proj-a')).toThrow(ForbiddenError);
  });

  it('rejects an unknown project (after authorization resolves yes)', () => {
    // MASTER is instance-admin, so authorization passes and the failure is existence.
    expect(() => lockProject(cfg, MASTER, 'ghost')).toThrow(/unknown project/i);
    expect(() => promoteProject(cfg, MASTER, 'ghost')).toThrow(/unknown project/i);
  });

  it('rejects an unknown project on the approval path too (no dangling requests)', () => {
    const requester = mintToken('gh', 'u-gh');
    allow('u-gh', 'project:write', 'project', 'ghost', 'approval');
    expect(() => lockProject(cfg, requester, 'ghost')).toThrow(/unknown project/i);
    expect(listApprovalRequests(dataDir)).toHaveLength(0);
  });

  // ── getApprovalStatus visibility ─────────────────────────────────────────────

  it('visible to the original requester and to an admin, denied to an unrelated non-admin', () => {
    seedProject('proj-a');
    const requester = mintToken('vr', 'u-vr');
    allow('u-vr', 'project:write', 'project', 'proj-a', 'approval');
    const req = lockProject(cfg, requester, 'proj-a').approval!;

    expect(getApprovalStatus(cfg, requester, req.id).id).toBe(req.id); // own
    expect(getApprovalStatus(cfg, MASTER, req.id).id).toBe(req.id); // admin sees all

    const stranger = mintToken('vs', 'u-vs');
    allow('u-vs', 'project:write', 'project', 'proj-b', 'yes');
    expect(() => getApprovalStatus(cfg, stranger, req.id)).toThrow(ForbiddenError);
  });

  it('lazily expires an overdue pending request before returning it', () => {
    seedApprovals([
      {
        id: 'od-1',
        kind: 'project:lock',
        status: 'pending',
        requestedBy: subject({ userId: 'u-od' }),
        projectId: 'proj-a',
        summary: 'Lock project proj-a',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
    ]);
    const got = getApprovalStatus(cfg, MASTER, 'od-1');
    expect(got.status).toBe('expired');
  });

  it('not-found for an unknown id', () => {
    expect(() => getApprovalStatus(cfg, MASTER, 'nope')).toThrow(/not found/i);
  });

  // ── listPendingRequests ─────────────────────────────────────────────────────

  it('gated to approval:decide or admin, and filterable by project', () => {
    seedProject('p1');
    seedProject('p2');
    const requester = mintToken('lpr', 'u-lpr');
    allow('u-lpr', 'project:write', 'instance', undefined, 'approval');
    lockProject(cfg, requester, 'p1');
    lockProject(cfg, requester, 'p2');

    // The requester holds project:write reach but not approval:decide → denied.
    expect(() => listPendingRequests(cfg, requester)).toThrow(ForbiddenError);

    // Admin lists all pending.
    expect(listPendingRequests(cfg, MASTER)).toHaveLength(2);
    // Project filter narrows.
    expect(listPendingRequests(cfg, MASTER, 'p1').map((r) => r.projectId)).toEqual(['p1']);

    // An instance-wide approval:decide assignment is authorized.
    const decider = mintToken('lpd', 'u-lpd');
    allow('u-lpd', 'approval:decide', 'instance', undefined, 'yes');
    expect(listPendingRequests(cfg, decider)).toHaveLength(2);
  });

  it('a project-scoped approval:decide lists/decides only its own project; a unit-scoped one only its subtree', () => {
    const unitA = seedUnit('A');
    const unitB = seedUnit('B');
    createProject(cfg, MASTER, 'in-proj', unitA.id);
    createProject(cfg, MASTER, 'out-proj', unitB.id);

    const reqIn = (() => {
      const t = mintToken('ri', 'u-ri');
      allow('u-ri', 'project:write', 'project', 'in-proj', 'approval');
      return lockProject(cfg, t, 'in-proj').approval!;
    })();
    const reqOut = (() => {
      const t = mintToken('ro2', 'u-ro2');
      allow('u-ro2', 'project:write', 'project', 'out-proj', 'approval');
      return lockProject(cfg, t, 'out-proj').approval!;
    })();

    // Project-scoped decider: only in-proj.
    const projDecider = mintToken('pd', 'u-pd');
    allow('u-pd', 'approval:decide', 'project', 'in-proj', 'yes');
    expect(listPendingRequests(cfg, projDecider).map((r) => r.projectId)).toEqual(['in-proj']);
    expect(() => decideRequest(cfg, projDecider, decision(reqOut.id, true))).toThrow(ForbiddenError);

    // Unit-scoped decider: only its subtree.
    const unitDecider = mintToken('ud', 'u-ud');
    allow('u-ud', 'approval:decide', 'unit', unitA.id, 'yes');
    expect(listPendingRequests(cfg, unitDecider).map((r) => r.projectId)).toEqual(['in-proj']);
    expect(() => decideRequest(cfg, unitDecider, decision(reqOut.id, true))).toThrow(ForbiddenError);

    // The in-scope decision succeeds — and AUTO-EXECUTES (approved = done).
    const decided = decideRequest(cfg, unitDecider, decision(reqIn.id, true));
    expect(decided.status).toBe('completed');
  });

  // ── decideRequest: auto-execution ────────────────────────────────────────────

  it('approving AUTO-EXECUTES: a decided project:lock completes and the project is actually locked', () => {
    seedProject('auto-lock');
    const requester = mintToken('al', 'u-al');
    allow('u-al', 'project:write', 'project', 'auto-lock', 'approval');
    const req = lockProject(cfg, requester, 'auto-lock').approval!;

    const decider = mintToken('ad', 'u-ad');
    allow('u-ad', 'approval:decide', 'instance', undefined, 'yes');

    const decided = decideRequest(cfg, decider, decision(req.id, true));

    // Approved = done: the returned request is already completed …
    expect(decided.status).toBe('completed');
    // … the decidedBy is caller-derived (never the client-supplied value) …
    expect(decided.decidedBy?.userId).toBe('u-ad');
    // … and the lock actually happened: a promote now finds a matching lock.
    expect(promoteProject(cfg, MASTER, 'auto-lock').promote?.status).toBe('ready');
    expect(queryAuditEvents(dataDir, { action: 'approval.decided' })[0].level).toBe('security');
  });

  it('denying records the denial and never executes', () => {
    seedProject('deny-proj');
    const requester = mintToken('dr', 'u-dr');
    allow('u-dr', 'project:write', 'project', 'deny-proj', 'approval');
    const req = lockProject(cfg, requester, 'deny-proj').approval!;

    const decider = mintToken('dd', 'u-dd');
    allow('u-dd', 'approval:decide', 'instance', undefined, 'yes');

    const denied = decideRequest(cfg, decider, decision(req.id, false, 'not now'));
    expect(denied.status).toBe('denied');
    expect(denied.decisionReason).toBe('not now');
  });

  it('rejects self-approval even when the requester holds approval:decide', () => {
    seedProject('self-proj');
    const selfTok = mintToken('self-tok', 'u-self');
    allow('u-self', 'project:write', 'project', 'self-proj', 'approval');
    allow('u-self', 'approval:decide', 'instance', undefined, 'yes');
    const req = lockProject(cfg, selfTok, 'self-proj').approval!;

    expect(() => decideRequest(cfg, selfTok, decision(req.id, true))).toThrow(ForbiddenError);
  });

  it('a non-decider cannot decide at all', () => {
    seedProject('plain-proj');
    const requester = mintToken('pr', 'u-pr');
    allow('u-pr', 'project:write', 'project', 'plain-proj', 'approval');
    const req = lockProject(cfg, requester, 'plain-proj').approval!;

    const plain = mintToken('pl', 'u-pl');
    allow('u-pl', 'project:read', 'project', 'plain-proj', 'yes');
    expect(() => decideRequest(cfg, plain, decision(req.id, true))).toThrow(ForbiddenError);
  });

  it('a project:init request for a not-yet-created project is decidable only by an instance-admin (fail closed for scoped deciders)', () => {
    const unit = seedUnit('nc');
    const requester = mintToken('nc-req', 'u-nc-req');
    allow('u-nc-req', 'project:create', 'unit', unit.id, 'approval');
    const pending = initializeProject(cfg, requester, { id: 'ghost-init', ownerUnitId: unit.id }).approval!;

    // A unit-scoped decider cannot cover a not-yet-created (unplaced) project → 403.
    const scopedDecider = mintToken('nc-sd', 'u-nc-sd');
    allow('u-nc-sd', 'approval:decide', 'unit', unit.id, 'yes');
    expect(() => decideRequest(cfg, scopedDecider, decision(pending.id, true))).toThrow(ForbiddenError);

    // MASTER (instance-admin) decides it — and the auto-execution provisions it.
    const decided = decideRequest(cfg, MASTER, decision(pending.id, true));
    expect(decided.status).toBe('completed');
    expect(existingProjectRoot(dataDir, 'ghost-init')).toBeTruthy();
  });

  it('an execution failure at decide leaves the approval APPROVED (not completed), retryable via executeApprovedRequest', () => {
    const unit = seedUnit('flip');
    const requester = mintToken('flr', 'u-flr');
    allow('u-flr', 'project:create', 'unit', unit.id, 'approval');
    const pending = initializeProject(cfg, requester, { id: 'flip-init', ownerUnitId: unit.id }).approval!;

    // Policy flips to enforcing with a rule the request now violates.
    setPackPolicyRecord(dataDir, samplePolicy({ enforcementMode: 'block', requireProfileSelection: true }));

    // The decision records, then the auto-execution re-evaluates and rejects.
    expect(() => decideRequest(cfg, MASTER, decision(pending.id, true))).toThrow(/policy violation/i);
    expect(existingProjectRoot(dataDir, 'flip-init')).toBeNull();
    // The approval remains APPROVED — not completed by a failed execution.
    expect(getApprovalStatus(cfg, MASTER, pending.id).status).toBe('approved');

    // Relax the policy and retry through the manual path.
    setPackPolicyRecord(dataDir, samplePolicy());
    const outcome = executeApprovedRequest(cfg, requester, pending.id);
    expect(outcome).toContain('Initialized project "flip-init"');
    expect(getApprovalStatus(cfg, MASTER, pending.id).status).toBe('completed');
  });

  // ── executeApprovedRequest (manual retry path) ───────────────────────────────

  it('project:init executes end-to-end applying policy default packs and recording the profile selection', () => {
    // Isolate the server-global pack set and seed one declarative pack.
    const packsDir = path.join(dataDir, 'global-packs');
    fs.mkdirSync(packsDir, { recursive: true });
    fs.writeFileSync(path.join(packsDir, 'bar.yaml'), 'name: bar\nprofiles: {}\nlanguages: {}\n');
    process.env.WAIRON_PACKS_DIR = packsDir;

    // A warn policy whose default pack the init must vendor.
    setPackPolicyRecord(dataDir, samplePolicy({ defaultProjectPacks: ['bar'] }));
    const unit = seedUnit('packs');
    const requester = mintToken('pir', 'u-pir');
    allow('u-pir', 'project:create', 'unit', unit.id, 'yes');

    const outcome = initializeProject(cfg, requester, { id: 'policy-init', ownerUnitId: unit.id });
    expect(outcome.status).toBe('completed');

    // The policy's default pack was vendored into the new project.
    expect(listProjectPacks(cfg, MASTER, 'policy-init').map((d) => d.name)).toContain('bar');

    // The resolved profile selection was recorded into the project's config.
    const root = existingProjectRoot(dataDir, 'policy-init');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = readYamlFile(path.join(root!, '.wai', 'project.yaml')) as any;
    expect(raw.profileSelection.defaultPackNames).toContain('bar');
  });

  it('rejects a request that is not approved, an expired approval, and an unrelated caller', () => {
    seedProject('proj-a');
    const requester = mintToken('nar', 'u-nar');
    allow('u-nar', 'project:write', 'project', 'proj-a', 'approval');
    const req = lockProject(cfg, requester, 'proj-a').approval!; // still pending
    expect(() => executeApprovedRequest(cfg, MASTER, req.id)).toThrow(/not approved/i);

    seedApprovals([
      {
        id: 'exp-1',
        kind: 'project:lock',
        status: 'approved',
        requestedBy: subject({ userId: 'u-e' }),
        projectId: 'proj-a',
        summary: 'Lock project proj-a',
        createdAt: '2020-01-01T00:00:00.000Z',
        expiresAt: '2020-01-02T00:00:00.000Z',
      },
      {
        id: 'ok-1',
        kind: 'project:lock',
        status: 'approved',
        requestedBy: subject({ userId: 'u-owner' }),
        projectId: 'proj-a',
        summary: 'Lock project proj-a',
        createdAt: nowIso(),
      },
    ]);
    // Admin passes the requester/admin gate; the failure is expiry.
    expect(() => executeApprovedRequest(cfg, MASTER, 'exp-1')).toThrow(/expired/i);

    // A caller who is neither the original requester nor an admin is denied.
    const strangerTok = mintToken('str', 'u-str');
    expect(() => executeApprovedRequest(cfg, strangerTok, 'ok-1')).toThrow(ForbiddenError);
  });

  // ── awaitApproval ────────────────────────────────────────────────────────────

  it('returns the current state immediately on a zero timeout, and only to the original requester', async () => {
    seedProject('aw-proj');
    const requester = mintToken('aw', 'u-aw');
    allow('u-aw', 'project:write', 'project', 'aw-proj', 'approval');
    const req = lockProject(cfg, requester, 'aw-proj').approval!;

    const still = await awaitApproval(cfg, requester, req.id, 0);
    expect(still.status).toBe('pending');

    const stranger = mintToken('aw-s', 'u-aw-s');
    await expect(awaitApproval(cfg, stranger, req.id, 0)).rejects.toThrow(ForbiddenError);
    await expect(awaitApproval(cfg, requester, 'nope', 0)).rejects.toThrow(/not found/i);
  });

  it('resolves once the request is decided (auto-executed → completed)', async () => {
    seedProject('aw-live');
    const requester = mintToken('awl', 'u-awl');
    allow('u-awl', 'project:write', 'project', 'aw-live', 'approval');
    const req = lockProject(cfg, requester, 'aw-live').approval!;

    const decider = mintToken('awd', 'u-awd');
    allow('u-awd', 'approval:decide', 'instance', undefined, 'yes');

    // Decide shortly after the await begins.
    const deciding = new Promise<void>((resolve) =>
      setTimeout(() => {
        decideRequest(cfg, decider, decision(req.id, true));
        resolve();
      }, 300),
    );

    const awaited = await awaitApproval(cfg, requester, req.id, 10);
    await deciding;
    expect(awaited.status).toBe('completed'); // approved = done
  }, 15_000);

  // ── best-effort audit + authentication ───────────────────────────────────────

  it('does not fail the action when the audit append fails', () => {
    const unit = seedUnit('af');
    const requester = mintToken('af', 'u-af');
    allow('u-af', 'project:create', 'unit', unit.id, 'approval');
    // Make the audit store unwritable/unreadable: a directory where the file goes.
    fs.mkdirSync(path.join(dataDir, 'audit-events.json'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const outcome = initializeProject(cfg, requester, { id: 'af-proj', ownerUnitId: unit.id });
    expect(outcome.status).toBe('pending-approval'); // the approval was still created
    expect(errSpy).toHaveBeenCalled(); // failure recorded as a diagnostic
  });

  it('throws an unauthenticated error for a bogus token and for no credential', () => {
    expect(() => initializeProject(cfg, null, { id: 'x', ownerUnitId: 'u' })).toThrow(UnauthenticatedError);
    expect(() => listPendingRequests(cfg, 'not-a-real-token')).toThrow(UnauthenticatedError);
    expect(() => getApprovalStatus(cfg, null, 'r')).toThrow(UnauthenticatedError);
  });

  // ── admin.ts createProject guard ─────────────────────────────────────────────

  it('gated admin createProject places the project and rejects a missing or unknown unit', () => {
    const unit = seedUnit('smoke');
    const rec = createProject(cfg, MASTER, 'smoke-proj', unit.id);
    expect(rec.id).toBe('smoke-proj');
    expect(existingProjectRoot(dataDir, 'smoke-proj')).toBeTruthy();
    expect(fs.existsSync(path.join(rec.rootPath, '.wai', 'project.yaml'))).toBe(true);

    expect(() => createProject(cfg, MASTER, 'no-unit', '')).toThrow(/required/i);
    expect(() => createProject(cfg, MASTER, 'bad-unit', 'ghost-unit')).toThrow(/unknown organization unit/i);
    expect(() => createProject(cfg, 'bad-credential', 'nope', unit.id)).toThrow();
  });
});
