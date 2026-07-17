import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  upsertUnit,
  placeProject,
  refreshPublicSurface,
  upsertRelation,
  listRelations,
  removeRelation,
  generateLandscape,
  listReachableProjectsForMcp,
  listReachableProjectInterfacesForMcp,
  listVisibleSurfaces,
  getProjectSurfaceForMcp,
  buildLandscapeGraph,
} from '../../src/server/landscape.js';
import { routeAdmin } from '../../src/server/http.js';
import { createProject } from '../../src/server/admin.js';
import { mintUserToken, allow, seedUnit } from './helpers.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { hostCore } from '../../src/server/adapters.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { createCredential, hashToken } from '../../src/server/credentials.js';
import { upsertProjectRelation } from '../../src/server/relations.js';
import { getPublicSurfaceSnapshot } from '../../src/server/surfaces.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { ForbiddenError } from '../../src/server/identity.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import type {
  ApiKeyRecord,
  HostConfig,
  HostedProjectRecord,
  OrganizationUnitRecord,
  PrincipalSubject,
  ProjectGrant,
  ProjectPlacement,
  ProjectRelationRecord,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Landscape orchestrator + diagram specialist + portal (sdd_host) — Phase 4.
// Exercised through the exported orchestrator functions, the pure specialist,
// and the HTTP portal (routeAdmin) over a real <dataDir> with real minted
// credentials, mirroring policy.test.ts. Covers landscape:manage-gated writes +
// audit, redacted public-surface refresh (with and without L0 surfaces), the
// relation snapshot-validation gate, directional relations-only reachability,
// landscape graph generation, and the seven portal endpoints.
// ---------------------------------------------------------------------------

const MASTER = 'master-credential-secret-value';
const SUBJECT: PrincipalSubject = { userId: 'u-test', kind: 'human', issuer: 'local' };

function unitRec(over: Partial<OrganizationUnitRecord> = {}): OrganizationUnitRecord {
  const name = over.name ?? 'Unit';
  // The slug (the qualified-id segment) derives from the name unless supplied.
  const slug = over.slug ?? name.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  // Default to a business_entity so helper-created ROOT units satisfy the org-unit
  // hierarchy (a root must be a business_entity; business_entity also nests under
  // business_entity, so helper-created children stay valid too).
  return { id: '', name, slug, kind: 'business_entity', status: 'active', createdAt: '', createdBy: SUBJECT, ...over };
}

function placementRec(over: Partial<ProjectPlacement> = {}): ProjectPlacement {
  return { id: '', projectId: 'p', unitId: 'u', role: 'owner', createdAt: '', createdBy: SUBJECT, ...over };
}

function relationRec(over: Partial<ProjectRelationRecord> = {}): ProjectRelationRecord {
  return {
    id: '',
    sourceProjectId: 'src',
    targetProjectId: 'dst',
    kind: 'consumes',
    sourceAdapter: 'src_client_adapter',
    targetPublicInterface: { projectId: 'dst', systemInterfaceId: 'dst-api', reason: 'needs it' },
    reason: 'declared dependency',
    status: 'active',
    createdAt: '',
    createdBy: SUBJECT,
    ...over,
  };
}

describe('landscape orchestrator (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-landscape-'));
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

  /** Assignment-model token factories: each mints a fresh owner whose authority
   *  comes exclusively from the grid (legacy landscape:manage → project:admin,
   *  landscape:read → project:read). */
  let tokenSeq = 0;
  function tokenWith(capability: 'project:admin' | 'project:read' | 'project:write', scopeKind: 'instance' | 'unit' | 'project', scopeId?: string): string {
    const userId = `u-${capability.replace(':', '-')}-${tokenSeq}`;
    allow(dataDir, userId, capability, scopeKind, scopeId);
    return mintUserToken(dataDir, { id: `tok-${tokenSeq++}`, userId });
  }

  const manageToken = () => tokenWith('project:admin', 'instance');
  const readToken = () => tokenWith('project:read', 'instance');
  const plainToken = () => tokenWith('project:write', 'instance');

  /** Seed L0 publicInterfaces into a provisioned project's raw system spec. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function seedSurface(root: string, ifaces: any[]): void {
    const p = path.join(root, '.wai', 'specs', '.index.yaml');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = readYamlFile(p) as any;
    raw.publicInterfaces = ifaces;
    writeYamlFile(p, raw);
  }

  /** Create a hosted project at the REGISTRY level (no placement) and return its
   *  record — these suites build their own unit/placement topologies explicitly,
   *  and several pin the legacy no-units / unplaced-project postures the doctor
   *  migration still has to handle. */
  function project(id: string): HostedProjectRecord {
    const rec = createProjectRecord(dataDir, id);
    runWithProjectRoot(rec.rootPath, () => hostCore.provisionProject(id));
    return rec;
  }

  // ── organization-unit / placement admin gating + audit ────────────────────

  it('upsertUnit: a landscape:manage grant creates the unit and audits unit.upsert; a plain token is 403', () => {
    expect(() => upsertUnit(cfg, plainToken(), unitRec({ name: 'Team A' }))).toThrow(ForbiddenError);

    const stored = upsertUnit(cfg, manageToken(), unitRec({ name: 'Team A' }));
    expect(stored.id).toBeTruthy();
    expect(stored.name).toBe('Team A');
    expect(stored.status).toBe('active');

    const audit = queryAuditEvents(dataDir, { action: 'unit.upsert' });
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit[0].level).toBe('info');
  });

  it('placeProject: gated by landscape:manage, rejects a missing unit, and audits project.place', () => {
    const unit = upsertUnit(cfg, MASTER, unitRec({ name: 'Team B' }));

    expect(() =>
      placeProject(cfg, plainToken(), placementRec({ projectId: 'proj-x', unitId: unit.id })),
    ).toThrow(ForbiddenError);

    expect(() =>
      placeProject(cfg, manageToken(), placementRec({ projectId: 'proj-x', unitId: 'ghost-unit' })),
    ).toThrow(/does not exist/i);

    const stored = placeProject(cfg, manageToken(), placementRec({ projectId: 'proj-x', unitId: unit.id, role: 'owner' }));
    expect(stored.id).toBeTruthy();
    expect(stored.unitId).toBe(unit.id);

    expect(queryAuditEvents(dataDir, { action: 'project.place' }).length).toBeGreaterThanOrEqual(1);
  });

  // ── public-surface refresh (redaction) ────────────────────────────────────

  it('refreshPublicSurface: a project WITH L0 publicInterfaces yields a snapshot of redacted summaries', () => {
    const rec = project('surf-proj');
    seedSurface(rec.rootPath, [
      {
        id: 'pub-api',
        name: 'Public API',
        type: 'REST',
        audience: 'partners',
        version: 'v1',
        stability: 'stable',
        // References that MUST NOT leak into the redacted summary:
        subsystem: 'billing',
        interface: 'ibilling_portal',
        component: 'billing_portal',
        // Method given as an object carrying a full signature + narrative — only
        // the NAME may survive redaction:
        methods: [
          { name: 'createInvoice', signature: 'createInvoice(x): y', narrative: 'secret private steps' },
          'listInvoices',
        ],
        endpoints: ['/invoices', '/invoices/{id}'],
        publicTypes: ['Invoice', { name: 'LineItem' }],
        details: 'Billing public surface',
      },
    ]);

    const snap = refreshPublicSurface(cfg, MASTER, 'surf-proj');
    expect(snap.projectId).toBe('surf-proj');
    expect(snap.systemName).toBe('surf-proj');
    expect(snap.stateId).toMatch(/^sha256:/);
    expect(snap.interfaces).toHaveLength(1);

    const iface = snap.interfaces[0];
    expect(iface.id).toBe('pub-api');
    expect(iface.name).toBe('Public API');
    expect(iface.type).toBe('REST');
    expect(iface.audience).toBe('partners');
    expect(iface.version).toBe('v1');
    expect(iface.stability).toBe('stable');
    expect(iface.methods).toEqual(['createInvoice', 'listInvoices']);
    expect(iface.endpoints).toEqual(['/invoices', '/invoices/{id}']);
    expect(iface.publicTypes).toEqual(['Invoice', 'LineItem']);
    expect(iface.details).toBe('Billing public surface');

    // Redaction: private references / narratives / signatures never leak.
    const serialized = JSON.stringify(iface);
    expect(serialized).not.toMatch(/signature/);
    expect(serialized).not.toMatch(/narrative/);
    expect(serialized).not.toMatch(/billing_portal/);
    expect(serialized).not.toMatch(/ibilling_portal/);

    // Persisted + audited.
    expect(getPublicSurfaceSnapshot(dataDir, 'surf-proj')?.interfaces).toHaveLength(1);
    expect(queryAuditEvents(dataDir, { action: 'surface.refresh' }).length).toBeGreaterThanOrEqual(1);
  });

  it('refreshPublicSurface: a project WITHOUT L0 surfaces yields an empty snapshot (private by default)', () => {
    project('bare-proj');
    const snap = refreshPublicSurface(cfg, MASTER, 'bare-proj');
    expect(snap.interfaces).toEqual([]);
  });

  it('refreshPublicSurface: resolves type/details from the referenced subsystem public interface', () => {
    const rec = project('resolve-proj');
    const subDir = path.join(rec.rootPath, '.wai', 'specs', 'subsystems');
    fs.mkdirSync(subDir, { recursive: true });
    writeYamlFile(path.join(subDir, 'sub1.yaml'), {
      id: 'sub1',
      name: 'Sub One',
      description: 'a subsystem',
      parentSystem: 'resolve-proj',
      publicInterfaces: [{ type: 'GraphQL', details: 'from subsystem', interface: 'igql_portal', component: 'gql_portal' }],
      status: 'complete',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    seedSurface(rec.rootPath, [{ id: 'gql', name: 'GraphQL API', subsystem: 'sub1', interface: 'igql_portal' }]);

    const snap = refreshPublicSurface(cfg, MASTER, 'resolve-proj');
    expect(snap.interfaces).toHaveLength(1);
    expect(snap.interfaces[0].type).toBe('GraphQL');
    expect(snap.interfaces[0].details).toBe('from subsystem');
  });

  it('refreshPublicSurface: requires a landscape:manage grant (403 for a plain token)', () => {
    project('guard-proj');
    expect(() => refreshPublicSurface(cfg, plainToken(), 'guard-proj')).toThrow(ForbiddenError);
  });

  // ── relation snapshot-validation gate ─────────────────────────────────────

  it('upsertRelation: rejects a target with no snapshot with refresh guidance', () => {
    project('rel-src');
    project('rel-dst');
    expect(() =>
      upsertRelation(
        cfg,
        MASTER,
        relationRec({ sourceProjectId: 'rel-src', targetProjectId: 'rel-dst', targetPublicInterface: { projectId: 'rel-dst', systemInterfaceId: 'x', reason: 'r' } }),
      ),
    ).toThrow(/refresh/i);
  });

  it('upsertRelation: rejects an unknown target interface even when a snapshot exists', () => {
    const dst = project('u-dst');
    project('u-src');
    seedSurface(dst.rootPath, [{ id: 'real-api', name: 'Real', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'u-dst');

    expect(() =>
      upsertRelation(
        cfg,
        MASTER,
        relationRec({ sourceProjectId: 'u-src', targetProjectId: 'u-dst', targetPublicInterface: { projectId: 'u-dst', systemInterfaceId: 'ghost-api', reason: 'r' } }),
      ),
    ).toThrow(/unknown target public interface/i);
  });

  it('upsertRelation: happy path persists the relation and audits relation.upsert; removeRelation audits relation.remove', () => {
    const dst = project('h-dst');
    project('h-src');
    seedSurface(dst.rootPath, [{ id: 'dst-api', name: 'DST', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'h-dst');

    const stored = upsertRelation(
      cfg,
      MASTER,
      relationRec({
        sourceProjectId: 'h-src',
        targetProjectId: 'h-dst',
        targetPublicInterface: { projectId: 'h-dst', systemInterfaceId: 'dst-api', reason: 'r' },
      }),
    );
    expect(stored.id).toBeTruthy();
    expect(stored.status).toBe('active');
    expect(listRelations(cfg, MASTER, 'h-src').map((r) => r.id)).toContain(stored.id);
    expect(queryAuditEvents(dataDir, { action: 'relation.upsert' }).length).toBeGreaterThanOrEqual(1);

    removeRelation(cfg, MASTER, stored.id);
    expect(listRelations(cfg, MASTER, 'h-src')).toHaveLength(0);
    expect(queryAuditEvents(dataDir, { action: 'relation.remove' }).length).toBeGreaterThanOrEqual(1);
  });

  it('listRelations / removeRelation: gated by landscape grants', () => {
    expect(() => listRelations(cfg, plainToken())).toThrow(ForbiddenError);
    expect(listRelations(cfg, readToken())).toEqual([]);
    expect(() => removeRelation(cfg, plainToken(), 'whatever')).toThrow(ForbiddenError);
  });

  // ── directional, relations-only reachability ──────────────────────────────

  it('reachability is directional: A→B lets A discover B (with relation ids/kinds); B and C discover nothing', () => {
    const b = project('reach-b');
    project('reach-a');
    project('reach-c');
    seedSurface(b.rootPath, [{ id: 'b-api', name: 'B API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'reach-b');

    const rel = upsertRelation(
      cfg,
      MASTER,
      relationRec({
        sourceProjectId: 'reach-a',
        targetProjectId: 'reach-b',
        kind: 'consumes',
        targetPublicInterface: { projectId: 'reach-b', systemInterfaceId: 'b-api', reason: 'r' },
      }),
    );

    const fromA = listReachableProjectsForMcp(cfg, MASTER, 'reach-a');
    expect(fromA).toHaveLength(1);
    expect(fromA[0].projectId).toBe('reach-b');
    expect(fromA[0].relationIds).toContain(rel.id);
    expect(fromA[0].relationKinds).toContain('consumes');
    expect(fromA[0].publicInterfaceIds).toContain('b-api');

    // Directional: B does not reach A; C reaches nothing.
    expect(listReachableProjectsForMcp(cfg, MASTER, 'reach-b')).toEqual([]);
    expect(listReachableProjectsForMcp(cfg, MASTER, 'reach-c')).toEqual([]);
  });

  it('reachability ignores non-active relations', () => {
    upsertProjectRelation(
      dataDir,
      relationRec({ sourceProjectId: 'x', targetProjectId: 'y', status: 'retired', targetPublicInterface: { projectId: 'y', systemInterfaceId: 'y-api', reason: 'r' } }),
    );
    expect(listReachableProjectsForMcp(cfg, MASTER, 'x')).toEqual([]);
  });

  it('interface discovery: reachable+snapshot → summaries, reachable+no-snapshot → empty, unreachable → Forbidden', () => {
    const b = project('id-b');
    project('id-a');
    seedSurface(b.rootPath, [{ id: 'b-api', name: 'B API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'id-b');
    upsertRelation(
      cfg,
      MASTER,
      relationRec({ sourceProjectId: 'id-a', targetProjectId: 'id-b', targetPublicInterface: { projectId: 'id-b', systemInterfaceId: 'b-api', reason: 'r' } }),
    );

    // Reachable + snapshot → redacted summaries.
    const ifaces = listReachableProjectInterfacesForMcp(cfg, MASTER, 'id-a', 'id-b');
    expect(ifaces.map((i) => i.id)).toEqual(['b-api']);

    // Reachable + no snapshot → empty (seed the relation directly, target has no snapshot).
    upsertProjectRelation(
      dataDir,
      relationRec({ sourceProjectId: 'id-a', targetProjectId: 'id-nosnap', status: 'active', targetPublicInterface: { projectId: 'id-nosnap', systemInterfaceId: 'n', reason: 'r' } }),
    );
    expect(listReachableProjectInterfacesForMcp(cfg, MASTER, 'id-a', 'id-nosnap')).toEqual([]);

    // Unreachable → Forbidden (no existence leak; even though id-a has a snapshot).
    expect(() => listReachableProjectInterfacesForMcp(cfg, MASTER, 'id-b', 'id-a')).toThrow(ForbiddenError);
  });

  // ── landscape graph generation ────────────────────────────────────────────

  it('generateLandscape: returns nodes and edges covering units, placements, and relations', () => {
    const b = project('g-b');
    project('g-a');
    seedSurface(b.rootPath, [{ id: 'b-api', name: 'B API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'g-b');

    const unit = upsertUnit(cfg, MASTER, unitRec({ name: 'Portfolio' }));
    placeProject(cfg, MASTER, placementRec({ projectId: 'g-a', unitId: unit.id, role: 'owner' }));
    // Stage 2: once an org graph exists, a relation target must be VISIBLE to
    // the source through it — an unplaced project is exposed nowhere.
    placeProject(cfg, MASTER, placementRec({ projectId: 'g-b', unitId: unit.id, role: 'shared' }));
    const rel = upsertRelation(
      cfg,
      MASTER,
      relationRec({ sourceProjectId: 'g-a', targetProjectId: 'g-b', targetPublicInterface: { projectId: 'g-b', systemInterfaceId: 'b-api', reason: 'r' } }),
    );

    const graph = generateLandscape(cfg, MASTER, 'instance');
    expect(graph.scope).toBe('instance');

    expect(graph.nodes.some((n) => n.nodeKind === 'orgUnit' && n.unitId === unit.id)).toBe(true);
    expect(graph.nodes.some((n) => n.nodeKind === 'project' && n.projectId === 'g-a')).toBe(true);
    expect(graph.nodes.some((n) => n.nodeKind === 'project' && n.projectId === 'g-b')).toBe(true);
    expect(graph.nodes.some((n) => n.nodeKind === 'publicInterface' && n.publicInterfaceId === 'b-api')).toBe(true);

    expect(graph.edges.some((e) => e.edgeKind === 'owns' && e.label === 'owner')).toBe(true);
    expect(graph.edges.some((e) => e.relationId === rel.id)).toBe(true);
  });

  // ── Phase 7 Stage 3: consumer-path surface exchange over the data plane ─────

  it('getProjectSurfaceForMcp: legacy (no units) gates by relations; grants contract-grade origin-exchanged snapshots', () => {
    project('s3-src');
    const dst = project('s3-dst');
    seedSurface(dst.rootPath, [{ id: 'dst-api', name: 'Dst API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 's3-dst');

    // No relation yet → unreachable (legacy posture, no org units defined).
    expect(() => getProjectSurfaceForMcp(cfg, MASTER, 's3-src', 's3-dst')).toThrow(ForbiddenError);

    upsertRelation(cfg, MASTER, relationRec({
      sourceProjectId: 's3-src', targetProjectId: 's3-dst',
      targetPublicInterface: { projectId: 's3-dst', systemInterfaceId: 'dst-api', reason: 'r' },
    }));
    const snapshot = getProjectSurfaceForMcp(cfg, MASTER, 's3-src', 's3-dst');
    expect(snapshot.origin).toBe('exchanged');
    expect(typeof snapshot.projectName).toBe('string');
    expect(Array.isArray(snapshot.interfaces)).toBe(true);
  });

  it('getProjectSurfaceForMcp + listVisibleSurfaces: cross-tenant is grant-gated once units exist', () => {
    project('s3-a');
    const b = project('s3-b');
    seedSurface(b.rootPath, [{ id: 'b-api', name: 'B API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 's3-b');

    // Two tenant roots, no grant: invisible.
    const acme = upsertUnit(cfg, MASTER, unitRec({ name: 'acme' }));
    const globex = upsertUnit(cfg, MASTER, unitRec({ name: 'globex' }));
    placeProject(cfg, MASTER, placementRec({ projectId: 's3-a', unitId: acme.id }));
    placeProject(cfg, MASTER, placementRec({ projectId: 's3-b', unitId: globex.id }));
    expect(() => getProjectSurfaceForMcp(cfg, MASTER, 's3-a', 's3-b')).toThrow(ForbiddenError);
    expect(listVisibleSurfaces(cfg, MASTER, 's3-a').some((e) => e.projectId === 's3-b')).toBe(false);

    // exposeTo grant on the target's tenant root opens it at partner distance.
    upsertUnit(cfg, MASTER, { ...globex, exposeTo: [acme.id] });
    const catalog = listVisibleSurfaces(cfg, MASTER, 's3-a');
    const entry = catalog.find((e) => e.projectId === 's3-b');
    expect(entry?.distance).toBe('partner');
    // The stored summary's default audience ('public' → external) covers partner.
    expect(entry?.interfaces.some((i) => i.id === 'b-api')).toBe(true);

    const snapshot = getProjectSurfaceForMcp(cfg, MASTER, 's3-a', 's3-b');
    expect(snapshot.origin).toBe('exchanged');
  });

  it('generateLandscape / listRelations: control-plane reads accept a landscape:read grant, reject a plain token', () => {
    expect(() => generateLandscape(cfg, plainToken())).toThrow(ForbiddenError);
    const graph = generateLandscape(cfg, readToken());
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });

  // ── Phase 6 scoped model: a project-scoped grant confers SCOPED reach ─────────
  //
  // Under Phase 6 tenancy a project-scoped grant no longer merely fails every
  // instance capability — it confers authority narrowed to its own project(s).
  // (Previously such a grant was rejected outright; this is the deliberate scoped
  // replacement of that post-hardening instance-wide-only behavior.) It still
  // carries NO unit-management authority, and its reads see only its own project —
  // never the whole instance.

  const projManageToken = () => tokenWith('project:admin', 'project', 'acme');
  const projReadToken = () => tokenWith('project:read', 'project', 'acme');

  it('scoped model: a project-scoped assignment confers only its project scope — not unit management, not an instance-wide view', () => {
    // A hosted, PLACED 'acme' anchors the project-scoped assignments (an
    // unplaced project is in nobody's visible set — the resolver enumerates the
    // org tree).
    const tenant = seedUnit(dataDir, 'tenant');
    project('acme');
    project('other');
    placeProject(cfg, MASTER, placementRec({ projectId: 'acme', unitId: tenant.id }));
    placeProject(cfg, MASTER, placementRec({ projectId: 'other', unitId: tenant.id }));

    // A project-scoped admin carries no root-unit authority → never manages roots.
    expect(() => upsertUnit(cfg, projManageToken(), unitRec({ name: 'X' }))).toThrow(ForbiddenError);

    // A project-scoped project:read is NOT denied outright — it has reach — but
    // its view is narrowed to its one project, never the whole instance.
    const scopedGraph = generateLandscape(cfg, projReadToken());
    const scopedProjects = scopedGraph.nodes.filter((n) => n.nodeKind === 'project').map((n) => n.projectId);
    expect(scopedProjects).toEqual(['acme']);
    expect(listRelations(cfg, projReadToken())).toEqual([]);

    // The instance-level equivalents retain full access.
    expect(upsertUnit(cfg, manageToken(), unitRec({ name: 'X' })).id).toBeTruthy();
    const fullProjects = generateLandscape(cfg, readToken()).nodes.filter((n) => n.nodeKind === 'project');
    expect(fullProjects.length).toBe(2);
    expect(listRelations(cfg, readToken())).toEqual([]);
  });

  // ── Phase 6 unit-scoped administration ────────────────────────────────────────
  //
  // A unit-scoped grant (orgUnitId) confers landscape authority over that unit's
  // recursive subtree of units + every project placed in it. Reads FILTER to that
  // scope; writes require the target to fall inside it. A super-admin (MASTER /
  // instance-wide grant) is unaffected — the suites above already assert that.

  const unitManageToken = (unitId: string) => tokenWith('project:admin', 'unit', unitId);
  const unitReadToken = (unitId: string) => tokenWith('project:read', 'unit', unitId);

  /** Seed a two-branch org: unit A (the in-scope subtree) and sibling unit B (out
   *  of scope) under a shared root, each owning a source + dst project with a
   *  refreshed dst surface and one intra-branch relation. */
  function seedScopedOrg(): {
    root: OrganizationUnitRecord;
    unitA: OrganizationUnitRecord;
    unitB: OrganizationUnitRecord;
    relIn: ProjectRelationRecord;
    relOut: ProjectRelationRecord;
  } {
    const root = upsertUnit(cfg, MASTER, unitRec({ name: 'Root' }));
    const unitA = upsertUnit(cfg, MASTER, unitRec({ name: 'Team A', parentId: root.id }));
    const unitB = upsertUnit(cfg, MASTER, unitRec({ name: 'Team B', parentId: root.id }));

    project('a-src');
    const aDst = project('a-dst');
    project('b-src');
    const bDst = project('b-dst');
    seedSurface(aDst.rootPath, [{ id: 'a-api', name: 'A API', type: 'REST', details: 'd' }]);
    seedSurface(bDst.rootPath, [{ id: 'b-api', name: 'B API', type: 'REST', details: 'd' }]);
    refreshPublicSurface(cfg, MASTER, 'a-dst');
    refreshPublicSurface(cfg, MASTER, 'b-dst');

    placeProject(cfg, MASTER, placementRec({ projectId: 'a-src', unitId: unitA.id, role: 'owner' }));
    placeProject(cfg, MASTER, placementRec({ projectId: 'a-dst', unitId: unitA.id, role: 'owner' }));
    placeProject(cfg, MASTER, placementRec({ projectId: 'b-src', unitId: unitB.id, role: 'owner' }));
    placeProject(cfg, MASTER, placementRec({ projectId: 'b-dst', unitId: unitB.id, role: 'owner' }));

    const relIn = upsertRelation(
      cfg,
      MASTER,
      relationRec({
        sourceProjectId: 'a-src',
        targetProjectId: 'a-dst',
        targetPublicInterface: { projectId: 'a-dst', systemInterfaceId: 'a-api', reason: 'r' },
      }),
    );
    const relOut = upsertRelation(
      cfg,
      MASTER,
      relationRec({
        sourceProjectId: 'b-src',
        targetProjectId: 'b-dst',
        targetPublicInterface: { projectId: 'b-dst', systemInterfaceId: 'b-api', reason: 'r' },
      }),
    );
    return { root, unitA, unitB, relIn, relOut };
  }

  it('scoped landscape:read: a unit-scoped caller sees only their subtree relations and graph', () => {
    const { unitA, relIn, relOut } = seedScopedOrg();
    const tokenA = unitReadToken(unitA.id);

    // listRelations: only the in-subtree relation (both endpoints in scope) is visible.
    const rels = listRelations(cfg, tokenA);
    expect(rels.map((r) => r.id)).toEqual([relIn.id]);
    expect(rels.map((r) => r.id)).not.toContain(relOut.id);

    // generateLandscape: only unit A and its projects appear; unit B, its projects,
    // and the root (out of A's subtree) are filtered out.
    const graph = generateLandscape(cfg, tokenA);
    expect(graph.nodes.filter((n) => n.nodeKind === 'orgUnit').map((n) => n.unitId)).toEqual([unitA.id]);
    expect(
      graph.nodes
        .filter((n) => n.nodeKind === 'project')
        .map((n) => n.projectId)
        .sort(),
    ).toEqual(['a-dst', 'a-src']);
    expect(graph.nodes.some((n) => n.projectId === 'b-src' || n.projectId === 'b-dst')).toBe(false);

    // No edge dangles to a filtered-out node; the in-scope relation edge survives.
    const nodeIds = new Set(graph.nodes.map((n) => n.id));
    expect(graph.edges.every((e) => nodeIds.has(e.from) && nodeIds.has(e.to))).toBe(true);
    expect(graph.edges.some((e) => e.relationId === relIn.id)).toBe(true);
    expect(graph.edges.some((e) => e.relationId === relOut.id)).toBe(false);
  });

  it('scoped landscape:manage: writes are 403 outside the subtree and OK inside', () => {
    const { unitA, unitB, relIn, relOut } = seedScopedOrg();
    const tokenA = unitManageToken(unitA.id);

    // upsertUnit: a child under the in-scope unit A is allowed; under out-of-scope
    // unit B is 403; a brand-new root is 403 (only a super-admin creates roots).
    const aChild = upsertUnit(cfg, tokenA, unitRec({ name: 'A Child', parentId: unitA.id }));
    expect(aChild.id).toBeTruthy();
    expect(() => upsertUnit(cfg, tokenA, unitRec({ name: 'B Child', parentId: unitB.id }))).toThrow(ForbiddenError);
    expect(() => upsertUnit(cfg, tokenA, unitRec({ name: 'New Root' }))).toThrow(ForbiddenError);
    // Finding 2: reparenting a FOREIGN unit (B) under an in-scope unit is 403 —
    // you cannot pull another subtree into your scope.
    expect(() =>
      upsertUnit(cfg, tokenA, { ...unitB, parentId: aChild.id }),
    ).toThrow(ForbiddenError);

    // placeProject: the caller must control BOTH the project and the target unit.
    // Sharing an already-in-scope project (a-src, in unit A) into an in-scope
    // child unit is allowed.
    expect(
      placeProject(cfg, tokenA, placementRec({ projectId: 'a-src', unitId: aChild.id, role: 'shared' })).id,
    ).toBeTruthy();
    // Destination out of scope (unit B) → 403.
    expect(() =>
      placeProject(cfg, tokenA, placementRec({ projectId: 'a-src', unitId: unitB.id })),
    ).toThrow(ForbiddenError);
    // Finding 1: adopting a FOREIGN project (b-src, in unit B) into an in-scope
    // unit is 403 — you cannot pull a project you don't control into your scope.
    expect(() =>
      placeProject(cfg, tokenA, placementRec({ projectId: 'b-src', unitId: unitA.id })),
    ).toThrow(ForbiddenError);

    // upsertRelation: source in scope (a-src) OK, source out of scope (b-src) 403.
    expect(
      upsertRelation(
        cfg,
        tokenA,
        relationRec({
          sourceProjectId: 'a-src',
          targetProjectId: 'a-dst',
          targetPublicInterface: { projectId: 'a-dst', systemInterfaceId: 'a-api', reason: 'r' },
        }),
      ).id,
    ).toBeTruthy();
    expect(() =>
      upsertRelation(
        cfg,
        tokenA,
        relationRec({
          sourceProjectId: 'b-src',
          targetProjectId: 'b-dst',
          targetPublicInterface: { projectId: 'b-dst', systemInterfaceId: 'b-api', reason: 'r' },
        }),
      ),
    ).toThrow(ForbiddenError);

    // removeRelation: point-checked to the relation's source project. The
    // out-of-scope relation is 403 (fail-closed), the in-scope one removes.
    expect(() => removeRelation(cfg, tokenA, relOut.id)).toThrow(ForbiddenError);
    removeRelation(cfg, tokenA, relIn.id);
    expect(listRelations(cfg, MASTER).some((r) => r.id === relIn.id)).toBe(false);
  });
});

// ── Landscape Diagram Specialist (pure buildGraph) ───────────────────────────

describe('landscape diagram specialist (pure buildGraph)', () => {
  const subject: PrincipalSubject = { userId: 'u', kind: 'human', issuer: 'local' };

  it('projects units (hierarchy), projects, placements, snapshots, and relations into a graph', () => {
    const graph = buildLandscapeGraph(
      [
        { id: 'root', name: 'Root', kind: 'org', status: 'active', createdAt: '', createdBy: subject },
        { id: 'child', name: 'Child', kind: 'team', status: 'active', createdAt: '', createdBy: subject, parentId: 'root' },
      ],
      [
        { id: 'p1', rootPath: '/x/p1', status: 'active', createdAt: '' },
        { id: 'p2', rootPath: '/x/p2', status: 'active', createdAt: '' },
      ],
      [{ id: 'pl1', projectId: 'p1', unitId: 'child', role: 'owner', createdAt: '', createdBy: subject }],
      [{ projectId: 'p2', stateId: 's', systemName: 'P2', interfaces: [{ id: 'p2-api', name: 'P2 API', type: 'REST', audience: 'public', methods: [], details: '' }], exportedAt: '' }],
      [
        // Relation to a KNOWN interface node.
        { id: 'r1', sourceProjectId: 'p1', targetProjectId: 'p2', kind: 'consumes', sourceAdapter: 'a', targetPublicInterface: { projectId: 'p2', systemInterfaceId: 'p2-api', reason: 'r' }, reason: 'r', status: 'active', createdAt: '', createdBy: subject },
        // Relation whose target interface node is ABSENT → falls back to the project node.
        { id: 'r2', sourceProjectId: 'p1', targetProjectId: 'p2', kind: 'depends_on', sourceAdapter: 'a', targetPublicInterface: { projectId: 'p2', systemInterfaceId: 'missing', reason: 'r' }, reason: 'r', status: 'active', createdAt: '', createdBy: subject },
      ],
    );

    // Hierarchy edge parent → child.
    expect(graph.edges.some((e) => e.edgeKind === 'contains' && e.from === 'unit:root' && e.to === 'unit:child')).toBe(true);
    // Placement edge (owner → 'owns').
    expect(graph.edges.some((e) => e.edgeKind === 'owns' && e.from === 'unit:child' && e.to === 'project:p1')).toBe(true);
    // Publishes edge + interface node.
    expect(graph.nodes.some((n) => n.nodeKind === 'publicInterface' && n.id === 'iface:p2:p2-api')).toBe(true);
    expect(graph.edges.some((e) => e.edgeKind === 'publishes' && e.to === 'iface:p2:p2-api')).toBe(true);
    // Relation to a known interface node targets that node.
    expect(graph.edges.some((e) => e.relationId === 'r1' && e.to === 'iface:p2:p2-api')).toBe(true);
    // Relation to an absent interface node falls back to the project node.
    expect(graph.edges.some((e) => e.relationId === 'r2' && e.to === 'project:p2' && e.edgeKind === 'depends_on')).toBe(true);
    expect(graph.scope).toBe('instance');
    expect(Date.parse(graph.generatedAt)).toBeGreaterThan(0);
  });
});

// ── HTTP portal (routeAdmin) ─────────────────────────────────────────────────

describe('landscape portal (sdd_host http)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let server: http.Server;
  let baseUrl: string;
  const savedEnv = { ...process.env };

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-landscape-http-'));
    process.env.WAIRON_ADMIN_TOKEN = MASTER;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };

    server = http.createServer((req, res) => {
      void routeAdmin(cfg, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  async function api(
    method: string,
    pathname: string,
    opts: { cred?: string; body?: unknown } = {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.cred) headers['Authorization'] = `Bearer ${opts.cred}`;
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(baseUrl + pathname, init);
    const text = await res.text();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }

  function seedSurface(root: string, id: string): void {
    const p = path.join(root, '.wai', 'specs', '.index.yaml');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const raw = readYamlFile(p) as any;
    raw.publicInterfaces = [{ id, name: id, type: 'REST', details: 'd' }];
    writeYamlFile(p, raw);
  }

  it('the seven landscape endpoints respond with the correct statuses through routeAdmin', async () => {
    // PUT /landscape/units/{id} → 200.
    const unit = await api('PUT', '/landscape/units/team-1', { cred: MASTER, body: { name: 'Team 1', kind: 'business_entity' } });
    expect(unit.status).toBe(200);
    expect(unit.json.id).toBe('team-1');

    // PUT /landscape/projects/{id}/placements/{unitId} → 200.
    const place = await api('PUT', '/landscape/projects/proj-1/placements/team-1', { cred: MASTER, body: { role: 'owner' } });
    expect(place.status).toBe(200);
    expect(place.json.projectId).toBe('proj-1');
    expect(place.json.unitId).toBe('team-1');

    // Provision a real target project + surface for the relation (placed into
    // the unit the endpoints created — every project is placed at creation).
    const dst = createProject(cfg, MASTER, 'dst-proj', 'team-1');
    seedSurface(dst.rootPath, 'dst-api');

    // POST /landscape/projects/{id}/public-surface/refresh → 200.
    const refresh = await api('POST', '/landscape/projects/dst-proj/public-surface/refresh', { cred: MASTER });
    expect(refresh.status).toBe(200);
    expect(refresh.json.interfaces).toHaveLength(1);

    // Stage 2: once an org graph exists, the relation target must be VISIBLE
    // to the source through it — place both endpoints in the same unit.
    await api('PUT', '/landscape/projects/src-proj/placements/team-1', { cred: MASTER, body: { role: 'owner' } });
    await api('PUT', '/landscape/projects/dst-proj/placements/team-1', { cred: MASTER, body: { role: 'shared' } });

    // PUT /landscape/relations/{id} → 200.
    const rel = await api('PUT', '/landscape/relations/rel-1', {
      cred: MASTER,
      body: {
        sourceProjectId: 'src-proj',
        targetProjectId: 'dst-proj',
        kind: 'consumes',
        sourceAdapter: 'src_client_adapter',
        targetPublicInterface: { projectId: 'dst-proj', systemInterfaceId: 'dst-api', reason: 'r' },
        reason: 'r',
        status: 'active',
      },
    });
    expect(rel.status).toBe(200);
    expect(rel.json.id).toBe('rel-1');

    // GET /landscape/relations → 200.
    const list = await api('GET', '/landscape/relations', { cred: MASTER });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.json)).toBe(true);
    expect(list.json.some((r: { id: string }) => r.id === 'rel-1')).toBe(true);

    // GET /landscape/graph → 200; unauthenticated → 401.
    const graph = await api('GET', '/landscape/graph', { cred: MASTER });
    expect(graph.status).toBe(200);
    expect(Array.isArray(graph.json.nodes)).toBe(true);
    expect((await api('GET', '/landscape/graph')).status).toBe(401);

    // DELETE /landscape/relations/{id} → 200.
    const del = await api('DELETE', '/landscape/relations/rel-1', { cred: MASTER });
    expect(del.status).toBe(200);
  });

  it('does not shadow the /admin/projects surface (a bare /admin/projects list still works)', async () => {
    const res = await api('GET', '/admin/projects', { cred: MASTER });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
  });
});
