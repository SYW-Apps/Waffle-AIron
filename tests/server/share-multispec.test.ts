import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { createLink } from '../../src/server/sharelinks.js';
import { captureSnapshot, putSnapshot } from '../../src/server/sharesnapshots.js';
import { downloadArtifact } from '../../src/server/shareaccess.js';
import { serveSharedOpenApi, serveSharedDownload } from '../../src/server/sharehttp.js';
import { exportProjectSurface } from '../../src/server/landscape.js';
import { hashToken } from '../../src/server/credentials.js';
import { mintUserToken, allow, subjectOf } from './helpers.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';
import type {
  HostConfig,
  Principal,
  ShareLink,
  ShareRequestMeta,
  ShareSnapshot,
} from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// Multi-portal OpenAPI across the hosted share + artifact path (sdd_host).
//
// A project publishes ONE OpenAPI document PER PORTAL — distinct portals are
// separate APIs with their own servers and auth and are never merged. This suite
// pins the uniform rule everywhere the host serves one: portalId selects one,
// several with no selection return an INDEX, exactly one returns that document,
// and an unknown portalId is REFUSED rather than substituted. It also pins the
// back-compat floor: a snapshot captured before per-portal capture carries only
// the single `openapi` field and must keep serving it unchanged.
// ---------------------------------------------------------------------------

const META: ShareRequestMeta = { ip: '203.0.113.9', userAgent: 'probe/1.0' };
const now = new Date().toISOString();

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** Two published HTTP portals in one project — the shape that renders MULTIPLE
 *  OpenAPI documents (the single-portal shape renders exactly one and cannot
 *  exercise any selection rule). Written into the hosted project's isolated
 *  root, so every hosted read below binds it exactly as a request would. */
function buildTwoPortals(root: string): void {
  runWithProjectRoot(root, () => {
    saveSystemSpec({
      schemaVersion: '1.0.0',
      name: 'root-system',
      vision: 'multi-portal hosted fixture',
      boundaries: [],
      globalRequirements: [],
      publicInterfaces: [
        { id: 'public-api', name: 'Public API', subsystem: 'core-sub', component: 'public-portal', type: 'REST', details: 'public', audience: 'external' },
        { id: 'internal-api', name: 'Internal API', subsystem: 'core-sub', component: 'internal-portal', type: 'REST', details: 'peer-to-peer', audience: 'external' },
      ],
      createdAt: now,
      updatedAt: now,
    });
    saveSubsystemSpec(subsystem('core-sub', {
      publicInterfaces: [
        { type: 'REST', details: 'public', component: 'public-portal' },
        { type: 'REST', details: 'peer-to-peer', component: 'internal-portal' },
      ],
    }));
    saveComponentSpec(component('public-portal', 'core-sub', { componentType: 'Portal', portalType: 'HTTP_API' } as Partial<ComponentSpec>));
    saveComponentSpec(component('internal-portal', 'core-sub', { componentType: 'Portal', portalType: 'HTTP_API' } as Partial<ComponentSpec>));
    saveInterfaceSpec(iface('ipublic-portal', 'public-portal', [
      {
        name: 'getThing', description: 'reads a thing', signature: 'getThing(): string', returns: 'string',
        endpoint: { transport: 'HTTP', method: 'GET', path: '/things' },
      },
    ]));
    saveInterfaceSpec(iface('iinternal-portal', 'internal-portal', [
      {
        name: 'syncThing', description: 'peer sync', signature: 'syncThing(): string', returns: 'string',
        endpoint: { transport: 'HTTP', method: 'POST', path: '/sync' },
      },
    ]));
    invalidateSpecCache();
  });
}

/** A minimal request carrying only what the share portal reads: the query
 *  string (the `spec` selector) and the access-log meta headers. */
function mockReq(url: string): IncomingMessage {
  return { headers: { 'user-agent': 'probe/1.0' }, socket: { remoteAddress: '203.0.113.9' }, url } as unknown as IncomingMessage;
}

function mockRes(): { res: ServerResponse; out: { headers: Record<string, string>; statusCode: number; body: string } } {
  const out = { headers: {} as Record<string, string>, statusCode: 0, body: '' };
  const res = {
    setHeader(name: string, value: string): void {
      out.headers[name.toLowerCase()] = value;
    },
    get statusCode(): number {
      return out.statusCode;
    },
    set statusCode(value: number) {
      out.statusCode = value;
    },
    end(chunk?: string): void {
      out.body = chunk ?? '';
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

describe('multi-portal OpenAPI across the hosted share + artifact path (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;
  let projectRoot: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-share-multispec-'));
    process.env.WAIRON_DATA_DIR = dataDir;
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    projectRoot = createProjectRecord(dataDir, 'billing').rootPath;
    buildTwoPortals(projectRoot);
  });

  afterEach(() => {
    invalidateSpecCache();
    process.env = { ...savedEnv };
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows locks */
    }
  });

  const principal = (): Principal => ({
    tokenId: 'tok-owner',
    role: 'admin',
    projects: ['billing'],
    authenticated: true,
    subject: subjectOf('owner'),
  });

  /** Seed a snapshot + an openapi-downloadable link bound to `token`. */
  function seedLink(token: string, snapshot: Partial<ShareSnapshot>, over: Partial<ShareLink> = {}): ShareLink {
    const snap = putSnapshot(dataDir, {
      id: '',
      projectId: 'billing',
      view: 'architecture',
      capturedAt: '',
      canvasModel: JSON.stringify({ system: { name: 'Billing' }, components: [] }),
      ...snapshot,
    });
    return createLink(dataDir, {
      id: '',
      tokenHash: hashToken(token),
      projectId: 'billing',
      view: 'architecture',
      snapshotId: snap.id,
      mode: 'snapshot',
      enabled: true,
      allowDownloadHtml: false,
      allowDownloadOpenapi: true,
      frameAncestors: [],
      createdBy: subjectOf('owner'),
      createdAt: '',
      ...over,
    });
  }

  const TWO_SPECS = [
    { portalId: 'public-portal', name: 'Public API', document: '{"openapi":"3.1.0","paths":{"/things":{}}}' },
    { portalId: 'internal-portal', name: 'Internal API', document: '{"openapi":"3.1.0","paths":{"/sync":{}}}' },
  ];

  // ── capture ───────────────────────────────────────────────────────────────

  it('captures EVERY per-portal document — never one merged doc, never an empty placeholder', () => {
    const snapshot = captureSnapshot(dataDir, principal(), 'billing', 'architecture', ['openapi']);

    expect(snapshot.openapiSet?.map((s) => s.portalId).sort()).toEqual(['internal-portal', 'public-portal']);
    // Each captured document holds its OWN portal's paths — the two are never merged.
    const byId = Object.fromEntries(snapshot.openapiSet!.map((s) => [s.portalId, JSON.parse(s.document)]));
    expect(byId['public-portal'].paths['/things']).toBeDefined();
    expect(byId['public-portal'].paths['/sync']).toBeUndefined();
    expect(byId['internal-portal'].paths['/sync']).toBeDefined();
    // The one-document convenience stays UNSET with two portals, and the old
    // empty-object placeholder is gone: a share must never render Swagger UI
    // over an empty spec.
    expect(snapshot.openapi).toBeUndefined();
    // The old placeholder was the literal string '{}' — assert on the actual
    // serialized form (no space after the colon) so this catches a regression.
    expect(JSON.stringify(snapshot)).not.toContain('"openapi":"{}"');
    // ...and directly: neither field may hold the empty-object placeholder.
    expect(snapshot.openapiSet?.some((s) => s.document === '{}')).toBeFalsy();
  });

  it('a project with no requested openapi artifact captures neither field', () => {
    const snapshot = captureSnapshot(dataDir, principal(), 'billing', 'architecture', ['canvas']);
    expect(snapshot.openapiSet).toBeUndefined();
    expect(snapshot.openapi).toBeUndefined();
  });

  // ── serving (share access orchestrator) ───────────────────────────────────

  it('a captured share serves each portal separately and indexes them when none is named', () => {
    const snapshot = captureSnapshot(dataDir, principal(), 'billing', 'architecture', ['openapi']);
    seedLink('CAPTURED-TOKEN', snapshot);

    const selected = downloadArtifact(cfg, 'CAPTURED-TOKEN', 'openapi', META, 'internal-portal');
    expect(selected.found).toBe(true);
    expect(JSON.parse(selected.content!).paths['/sync']).toBeDefined();
    expect(JSON.parse(selected.content!).paths['/things']).toBeUndefined();

    const index = downloadArtifact(cfg, 'CAPTURED-TOKEN', 'openapi', META);
    expect(JSON.parse(index.content!).specs.map((s: { portalId: string }) => s.portalId).sort())
      .toEqual(['internal-portal', 'public-portal']);
  });

  it('selecting a portal returns exactly that document', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });
    const result = downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META, 'public-portal');
    expect(result).toMatchObject({ found: true, outcome: 'served', kind: 'openapi' });
    expect(result.content).toBe(TWO_SPECS[0].document);
  });

  it('several captured specs with no selection return an INDEX, not a merge or an empty doc', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });
    const result = downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META);
    expect(result.found).toBe(true);
    const index = JSON.parse(result.content!);
    expect(index.openapiIndex).toBe(true);
    expect(index.specs).toEqual([
      { portalId: 'public-portal', name: 'Public API' },
      { portalId: 'internal-portal', name: 'Internal API' },
    ]);
    // The index lists the APIs; it never carries their bodies merged together.
    expect(result.content).not.toContain('/things');
  });

  it('exactly one captured spec is served directly (no index ceremony)', () => {
    seedLink('SECRET-TOKEN', { openapiSet: [TWO_SPECS[0]], openapi: TWO_SPECS[0].document });
    const result = downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META);
    expect(result.content).toBe(TWO_SPECS[0].document);
  });

  it('an unknown portalId is REFUSED, never substituted with another portal API', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });
    const result = downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META, 'ghost-portal');
    expect(result).toMatchObject({ found: false, outcome: 'not-found' });
    expect(result.content).toBeUndefined();
  });

  it('BACK-COMPAT: a snapshot captured before per-portal capture still serves its one document', () => {
    // Exactly the pre-change on-disk shape: `openapi` only, no openapiSet.
    seedLink('OLD-TOKEN', { openapi: '{"openapi":"3.1.0","info":{"title":"Legacy"}}' });

    const result = downloadArtifact(cfg, 'OLD-TOKEN', 'openapi', META);
    expect(result).toMatchObject({ found: true, outcome: 'served' });
    expect(JSON.parse(result.content!).info.title).toBe('Legacy');
    // It names no portal, so it can only answer an unqualified request.
    expect(downloadArtifact(cfg, 'OLD-TOKEN', 'openapi', META, 'public-portal')).toMatchObject({
      found: false,
      outcome: 'not-found',
    });
  });

  it('the openapi download gate is unchanged: a link that forbids it is still refused', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS }, { allowDownloadOpenapi: false });
    expect(downloadArtifact(cfg, 'SECRET-TOKEN', 'openapi', META, 'public-portal')).toMatchObject({
      found: false,
      outcome: 'denied-download',
    });
  });

  // ── the public /share portal ──────────────────────────────────────────────

  it('the viewer indexes several shared APIs, each linking to its own viewer', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });
    const { res, out } = mockRes();
    serveSharedOpenApi(cfg, 'SECRET-TOKEN', mockReq('/share/SECRET-TOKEN/openapi'), res);

    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('?spec=public-portal');
    expect(out.body).toContain('?spec=internal-portal');
    expect(out.body).toContain('Internal API');
    expect(out.body).not.toContain('SwaggerUIBundle'); // an index, not a merged viewer
    // The hardening headers are unchanged on the index page.
    expect(out.headers['referrer-policy']).toBe('no-referrer');
    expect(out.headers['content-security-policy']).toContain('frame-ancestors');
    expect(out.headers['x-robots-tag']).toContain('noindex');
  });

  it('the viewer opens the SELECTED API in Swagger UI, and 404s an unknown one', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });

    const picked = mockRes();
    serveSharedOpenApi(cfg, 'SECRET-TOKEN', mockReq('/share/SECRET-TOKEN/openapi?spec=internal-portal'), picked.res);
    expect(picked.out.statusCode).toBe(200);
    expect(picked.out.body).toContain('SwaggerUIBundle');
    expect(picked.out.body).toContain('/sync');
    expect(picked.out.body).not.toContain('/things');

    const ghost = mockRes();
    serveSharedOpenApi(cfg, 'SECRET-TOKEN', mockReq('/share/SECRET-TOKEN/openapi?spec=ghost-portal'), ghost.res);
    expect(ghost.out.statusCode).toBe(404);
  });

  it('a single-spec share opens directly in Swagger UI, exactly as before', () => {
    seedLink('OLD-TOKEN', { openapi: '{"openapi":"3.1.0","info":{"title":"Legacy"}}' });
    const { res, out } = mockRes();
    serveSharedOpenApi(cfg, 'OLD-TOKEN', mockReq('/share/OLD-TOKEN/openapi'), res);

    expect(out.statusCode).toBe(200);
    expect(out.body).toContain('SwaggerUIBundle');
    expect(out.body).toContain('Legacy');
  });

  it('a selected download carries the portal id in its filename so downloads never collide', () => {
    seedLink('SECRET-TOKEN', { openapiSet: TWO_SPECS });

    const picked = mockRes();
    serveSharedDownload(cfg, 'SECRET-TOKEN', 'openapi', mockReq('/share/SECRET-TOKEN/download/openapi?spec=public-portal'), picked.res);
    expect(picked.out.statusCode).toBe(200);
    expect(picked.out.headers['content-disposition']).toBe('attachment; filename="shared-canvas.public-portal.openapi.json"');
    expect(picked.out.body).toBe(TWO_SPECS[0].document);

    // With no selection the download is the INDEX, named for what it is rather
    // than posing as one of the documents.
    const plain = mockRes();
    serveSharedDownload(cfg, 'SECRET-TOKEN', 'openapi', mockReq('/share/SECRET-TOKEN/download/openapi'), plain.res);
    expect(plain.out.headers['content-disposition']).toBe('attachment; filename="shared-canvas.openapi.index.json"');
    expect(JSON.parse(plain.out.body).openapiIndex).toBe(true);
  });

  it('a single-document download keeps its original attachment name', () => {
    seedLink('OLD-TOKEN', { openapi: '{"openapi":"3.1.0","info":{"title":"Legacy"}}' });
    const { res, out } = mockRes();
    serveSharedDownload(cfg, 'OLD-TOKEN', 'openapi', mockReq('/share/OLD-TOKEN/download/openapi'), res);
    expect(out.headers['content-disposition']).toBe('attachment; filename="shared-canvas.openapi.json"');
    expect(JSON.parse(out.body).info.title).toBe('Legacy');
  });

  // ── the landscape surface artifact ────────────────────────────────────────

  it('the surface artifact indexes a multi-portal project instead of emitting an empty document', () => {
    allow(dataDir, 'u-admin', 'project:admin', 'instance', undefined);
    const token = mintUserToken(dataDir, { id: 'tok-admin', userId: 'u-admin' });

    const artifact = exportProjectSurface(cfg, token, 'billing', 'openapi', 'project');
    expect(artifact.body).not.toBe('{}');
    const index = JSON.parse(artifact.body);
    expect(index.openapiIndex).toBe(true);
    expect(index.specs.map((s: { portalId: string }) => s.portalId).sort()).toEqual(['internal-portal', 'public-portal']);
    expect(artifact.filename).toBe('billing-surface.openapi.index.json');
  });

  it('the surface artifact serves one selected portal (named in the filename) and refuses an unknown one', () => {
    allow(dataDir, 'u-admin', 'project:admin', 'instance', undefined);
    const token = mintUserToken(dataDir, { id: 'tok-admin', userId: 'u-admin' });

    const artifact = exportProjectSurface(cfg, token, 'billing', 'openapi', 'project', 'public-portal');
    expect(JSON.parse(artifact.body).paths['/things']).toBeDefined();
    expect(JSON.parse(artifact.body).paths['/sync']).toBeUndefined();
    expect(artifact.filename).toBe('billing-public-portal-surface.openapi.json');

    expect(() => exportProjectSurface(cfg, token, 'billing', 'openapi', 'project', 'ghost-portal'))
      .toThrow(/Unknown portal "ghost-portal"/);
  });
});
