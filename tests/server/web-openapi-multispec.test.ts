import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getWebProjectOpenApi } from '../../src/server/web.js';
import { allow } from './helpers.js';
import { createWebSession } from '../../src/server/websessions.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { createUnit as createOrgUnit, placeProject } from '../../src/server/organization.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { provisionProject } from '../../src/core/provision.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import type { ComponentSpec, InterfaceSpec } from '../../src/models/index.js';
import type { HostConfig, PrincipalSubject, WebSession } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// The web UI's OpenAPI viewer selection (getWebProjectOpenApi, sdd_host).
//
// An OpenAPI document is ONE API. This pins the two ways the viewer could lie
// about what a project publishes: serving an EMPTY explorer when there is no
// API at all, and — worse — silently substituting a DIFFERENT portal's document
// when the requested one does not exist (the reader believes they are looking at
// the API they asked for). Neither is caught by a type checker.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const createdBy: PrincipalSubject = { userId: 'u-admin', kind: 'human', issuer: 'local' };

const component = (id: string, over: Partial<ComponentSpec> = {}): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
} as ComponentSpec);
const iface = (id: string, comp: string, methods: InterfaceSpec['methods']): InterfaceSpec => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

describe('web OpenAPI viewer — per-portal selection (sdd_host)', () => {
  let dataDir: string;
  let cfg: HostConfig;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-web-openapi-'));
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: true };
    invalidateSpecCache();
  });
  afterEach(() => {
    invalidateSpecCache();
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  /** A visible project (placed + readable) plus a session bound to it. */
  function visibleProject(projectId: string, seed: (root: string) => void): WebSession {
    const rec = createProjectRecord(dataDir, projectId);
    seed(rec.rootPath);
    const unit = createOrgUnit(dataDir, { id: '', slug: 'unit-a', name: 'A', kind: 'team', status: 'active', createdAt: now, createdBy });
    placeProject(dataDir, { id: 'pl-a', projectId, unitId: unit.id, role: 'owner', createdAt: now, createdBy });
    allow(dataDir, 'u-1', 'project:read', 'project', projectId);
    return createWebSession(dataDir, {
      id: '',
      subject: { userId: 'u-1', kind: 'human', issuer: 'local' },
      projects: [projectId],
      createdAt: '',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  /** Two published HTTP portals — the shape that renders MULTIPLE documents. */
  function seedTwoPortals(root: string): void {
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    runWithProjectRoot(root, () => {
      provisionProject('ApiSys');
      saveSystemSpec({
        schemaVersion: '1.0.0',
        name: 'ApiSys',
        vision: 'two-portal fixture',
        boundaries: [],
        globalRequirements: [],
        publicInterfaces: [
          { id: 'public-api', name: 'Public API', subsystem: 'core', component: 'public-portal', type: 'REST', details: 'public', audience: 'external' },
          { id: 'internal-api', name: 'Internal API', subsystem: 'core', component: 'internal-portal', type: 'REST', details: 'peer', audience: 'external' },
        ],
        createdAt: now,
        updatedAt: now,
      });
      saveSubsystemSpec({
        id: 'core', name: 'Core', description: 'core', parentSystem: 'ApiSys',
        publicInterfaces: [
          { type: 'REST', details: 'public', component: 'public-portal' },
          { type: 'REST', details: 'peer', component: 'internal-portal' },
        ],
        createdAt: now, updatedAt: now,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec(component('public-portal', { componentType: 'Portal', portalType: 'HTTP_API' } as Partial<ComponentSpec>) as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      saveComponentSpec(component('internal-portal', { componentType: 'Portal', portalType: 'HTTP_API' } as Partial<ComponentSpec>) as any);
      saveInterfaceSpec(iface('ipublic-portal', 'public-portal', [
        { name: 'getThing', description: 'reads', signature: 'getThing(): string', returns: 'string', endpoint: { transport: 'HTTP', method: 'GET', path: '/things' } },
      ]));
      saveInterfaceSpec(iface('iinternal-portal', 'internal-portal', [
        { name: 'syncThing', description: 'peer sync', signature: 'syncThing(): string', returns: 'string', endpoint: { transport: 'HTTP', method: 'POST', path: '/sync' } },
      ]));
    });
    invalidateSpecCache();
  }

  /** A real project that simply publishes no HTTP API. */
  function seedNoPortals(root: string): void {
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    runWithProjectRoot(root, () => provisionProject('BareSys'));
    invalidateSpecCache();
  }

  it('serves the selected portal document, not the other API', () => {
    const s = visibleProject('proj-a', seedTwoPortals);
    const page = getWebProjectOpenApi(cfg, s.id, 'proj-a', 'internal-portal');
    expect(page).toContain('/sync');
    expect(page).not.toContain('/things');
  });

  it('lists the APIs instead of merging when several exist and none is selected', () => {
    const s = visibleProject('proj-a', seedTwoPortals);
    const page = getWebProjectOpenApi(cfg, s.id, 'proj-a');
    expect(page).toContain('API specs');
    expect(page).toContain('public-portal');
    expect(page).toContain('internal-portal');
  });

  it('REFUSES to substitute a different API for an unknown spec', () => {
    const s = visibleProject('proj-a', seedTwoPortals);
    const page = getWebProjectOpenApi(cfg, s.id, 'proj-a', 'ghost-portal');
    // The reader asked for an API that does not exist: show them the real ones,
    // never another portal's document dressed up as the one they requested.
    expect(page).toContain('API specs');
    expect(page).not.toContain('/things');
    expect(page).not.toContain('/sync');
  });

  it('never serves an empty explorer for a project with no HTTP API', () => {
    const s = visibleProject('proj-bare', seedNoPortals);
    const page = getWebProjectOpenApi(cfg, s.id, 'proj-bare');
    expect(page).toContain('publishes no HTTP API');
    // The old behaviour rendered Swagger UI over a literal '{}' document.
    expect(page).not.toContain("swagger");
  });
});
