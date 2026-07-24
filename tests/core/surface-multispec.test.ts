import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSubsystemSpec,
  saveComponentSpec,
  saveInterfaceSpec,
  invalidateSpecCache,
} from '../../src/core/specs.js';
import { exportSurface } from '../../src/core/surfaces.js';
import type { ComponentSpec, InterfaceSpec, SubsystemSpec } from '../../src/models/index.js';

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

/**
 * Two HTTP portals published at the same audience — the shape that produces
 * MULTIPLE OpenAPI documents. The single-portal fixture in surfaces.test.ts
 * cannot exercise any of this (it renders exactly one document).
 */
function buildTwoPortals(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, '.wai', 'specs'), { recursive: true });
  setProjectRoot(rootDir);
  saveSystemSpec({
    schemaVersion: '1.0.0',
    name: 'root-system',
    vision: 'multi-portal fixture',
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
  setProjectRoot(rootDir);
}

describe('multi-portal OpenAPI export — selection + one file per portal', () => {
  let rootDir: string;
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    if (rootDir) fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const build = (): void => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-multispec-'));
    buildTwoPortals(rootDir);
  };

  it('renders one document per portal and leaves the single-doc convenience unset', () => {
    build();
    const result = exportSurface('external', 'openapi');
    expect(result.renderedSet?.map(s => s.portalId).sort()).toEqual(['internal-portal', 'public-portal']);
    // `rendered` is the ONE-portal convenience; with two portals it must stay unset
    // rather than silently standing for one of them.
    expect(result.rendered).toBeUndefined();
  });

  it('narrows to a single document when a portal is selected', () => {
    build();
    const result = exportSurface('external', 'openapi', undefined, 'internal-portal');
    expect(result.renderedSet?.map(s => s.portalId)).toEqual(['internal-portal']);
    expect(result.rendered).toBeDefined();
    expect(JSON.parse(result.rendered!).paths['/sync']).toBeDefined();
  });

  it('refuses an unknown portal instead of substituting another one', () => {
    build();
    expect(() => exportSurface('external', 'openapi', undefined, 'ghost-portal'))
      .toThrow(/Unknown portal "ghost-portal"/);
    // the error names what IS available, so the caller can pick
    expect(() => exportSurface('external', 'openapi', undefined, 'ghost-portal'))
      .toThrow(/public-portal|internal-portal/);
  });

  it('writes ONE FILE PER PORTAL — never just the first — and reports every path', () => {
    build();
    const outPath = path.join(rootDir, 'out', 'surface.json');
    const result = exportSurface('external', 'openapi', outPath);

    expect(result.writtenPaths).toHaveLength(2);
    const written = result.writtenPaths!.map(p => path.basename(p)).sort();
    expect(written).toEqual(['surface.internal-portal.json', 'surface.public-portal.json']);
    for (const p of result.writtenPaths!) expect(fs.existsSync(p)).toBe(true);
    // Each file holds its OWN portal's document — the two are never merged.
    const publicDoc = JSON.parse(fs.readFileSync(result.writtenPaths!.find(p => p.includes('public-portal'))!, 'utf8'));
    expect(publicDoc.paths['/things']).toBeDefined();
    expect(publicDoc.paths['/sync']).toBeUndefined();
    // A multi-file write has no single writtenTo to report.
    expect(result.writtenTo).toBeUndefined();
  });

  it('writes exactly the requested path when a portal is selected', () => {
    build();
    const outPath = path.join(rootDir, 'out', 'surface.json');
    const result = exportSurface('external', 'openapi', outPath, 'public-portal');

    expect(result.writtenPaths).toEqual([outPath]);
    expect(result.writtenTo).toBe(outPath);
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8')).paths['/things']).toBeDefined();
  });

  it('leaves native-format export writing a single snapshot file', () => {
    build();
    const outPath = path.join(rootDir, 'out', 'surface.yaml');
    const result = exportSurface('external', 'native', outPath);

    expect(result.writtenTo).toBe(outPath);
    expect(result.renderedSet).toBeUndefined();
    expect(fs.existsSync(outPath)).toBe(true);
  });
});
