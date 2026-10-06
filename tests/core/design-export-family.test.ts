/**
 * The design export across project boundaries: a reference into another
 * project is written as the `alias::publicName` a consumer resolves (never the
 * loader's in-memory key), in-tree subdirectory members and legacy mounts are
 * listed as dependencies, a dependency carries the digest its lock entry pins,
 * and a component carries its transport, Portal-level entry, patterns and external links.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';
import { invalidateSpecCache, saveSystemSpec, saveSpec, saveComponentSpec } from '../../src/core/specs.js';
import { exportDesign } from '../../src/core/design-export.js';
import { DesignExportSchema, type ComponentSpec, type SubsystemSpec } from '../../src/models/index.js';
import { buildReferenceFamily, type ReferenceFamily } from '../helpers/reference-family.js';

let family: ReferenceFamily | undefined;
let roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  family?.cleanup();
  family = undefined;
  for (const r of roots) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* win locks */ } }
  roots = [];
});

/** Export the project at `root`. */
function exportAt(root: string): ReturnType<typeof exportDesign> {
  setProjectRoot(root);
  invalidateSpecCache();
  return exportDesign();
}

/** Patch one YAML file in place. */
function patch(file: string, mutate: (raw: any) => void): void {
  const raw = readYamlFile(file) as any;
  mutate(raw);
  writeYamlFile(file, raw);
}

describe('the design export across project boundaries', () => {
  it('lists in-tree subdirectory members and a legacy mount as member dependencies, with the names the project uses', () => {
    family = buildReferenceFamily();
    const d = exportAt(family.top);
    expect(DesignExportSchema.parse(d)).toBeTruthy();
    expect(d.dependencies).toEqual([
      { alias: 'core', projectId: 'core', role: 'member', uses: ['engine-portal'] },
      { alias: 'shared', projectId: 'shared', role: 'member', uses: [] },
    ]);
    // A member's specs are a dependency, never inlined.
    expect(d.components.map((c) => c.key)).toEqual(['app-shell', 'app-worker']);
  });

  it('writes a reference into a member as alias::publicName, not the bound key, when the public name differs', () => {
    family = buildReferenceFamily();
    // core publishes engine-portal under the public name `engine`, and the
    // top references it by that name; the loader binds it to the key
    // core::engine-portal.
    patch(path.join(family.core, '.wai', 'specs', '.index.yaml'), (raw) => {
      raw.publicInterfaces[0].as = 'engine';
    });
    for (const id of ['app-shell', 'app-worker']) {
      patch(path.join(family.top, '.wai', 'specs', 'app', id, '.index.yaml'), (raw) => { raw.dependsOn = ['core::engine']; });
    }
    const d = exportAt(family.top);
    expect(d.components.map((c) => c.dependsOn)).toEqual([['core::engine'], ['core::engine']]);
    expect(d.dependencies.find((x) => x.alias === 'core')?.uses).toEqual(['engine']);
    expect(JSON.stringify(d)).not.toContain('core::engine-portal');
  });

  it('carries the digest the externals lock pins for a dependency, and none for one never pinned', () => {
    family = buildReferenceFamily();
    writeYamlFile(path.join(family.core, '.wai', 'externals.lock.yaml'), {
      externals: { shared: { project: 'shared', snapshot: '.wai/externals/shared.yaml', digest: 'sha256:abc123', used: {} } },
    });
    const d = exportAt(family.core);
    expect(d.dependencies.find((x) => x.alias === 'shared')).toMatchObject({ role: 'external', digest: 'sha256:abc123' });
    expect(d.dependencies.find((x) => x.alias === 'transpiler')).not.toHaveProperty('digest');
  });

  it('leaves the digests out when the lock cannot be read', () => {
    family = buildReferenceFamily();
    fs.writeFileSync(path.join(family.core, '.wai', 'externals.lock.yaml'), 'externals: [not, a, map]\n');
    const d = exportAt(family.core);
    expect(d.dependencies.every((x) => x.digest === undefined)).toBe(true);
  });
});

describe('design_component is lossless for design content', () => {
  it('carries a Portal\'s transport, abi and entry, patterns and external links as declared, and no retired mounts', () => {
    const now = '2026-10-04T12:00:00.000Z';
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-design-comp-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
    writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
      schemaVersion: '1.0.0', name: 'web', id: 'web', targets: [], rules: {},
      extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
    });
    setProjectRoot(root);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'web', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
    saveSpec('subsystem', {
      id: 'web', name: 'web', description: 'd', parentSystem: 'web', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: now, updatedAt: now,
    } as SubsystemSpec);
    const comp = (id: string, over: Record<string, unknown>): ComponentSpec => ({
      id, name: id, description: 'd', subsystem: 'web', componentType: 'Portal', transport: 'HTTP', owns: [], dependsOn: [],
      status: 'complete', createdAt: now, updatedAt: now, ...over,
    } as ComponentSpec);
    saveComponentSpec(comp('api', {}));
    saveComponentSpec(comp('sdk', { transport: 'InProcess', abi: 'c' }));
    saveComponentSpec(comp('listener', {
      invokedBy: { kind: 'entry', caller: 'Browsers of the shop', scope: 'outside' },
      mounts: [{ portal: 'api', prefixes: ['/api'] }],
      patterns: [{ id: 'acme/retry', version: '1' }],
      externalLinks: [{ url: 'https://example.com/spec', type: 'informative', label: 'Spec' }],
    }));
    const d = exportAt(root);
    const listener = d.components.find((c) => c.key === 'listener')!;
    expect('mounts' in listener).toBe(false);
    expect(listener.transport).toBe('HTTP');
    expect(listener.invokedBy).toEqual({ kind: 'entry', caller: 'Browsers of the shop', scope: 'outside' });
    expect(d.components.find((c) => c.key === 'sdk')).toMatchObject({ transport: 'InProcess', abi: 'c' });
    expect(listener.patterns).toEqual([{ id: 'acme/retry', version: '1' }]);
    expect(listener.externalLinks).toEqual([{ url: 'https://example.com/spec', type: 'informative', label: 'Spec' }]);
    const api = d.components.find((c) => c.key === 'api')!;
    expect([api.patterns, api.externalLinks, api.invokedBy]).toEqual([[], [], undefined]);
    expect(DesignExportSchema.parse(d)).toBeTruthy();
  });
});
