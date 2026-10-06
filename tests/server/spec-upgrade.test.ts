import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateReachability } from '../../src/server/spec-upgrade.js';
import { migrateReachability as localAdminMigrate } from '../../src/server/local-admin.js';
import { registerProjectRecord } from '../../src/server/projects.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { readYamlFile, writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// hosted_spec_upgrade.migrateReachability — `wairon host doctor [--fix]` runs
// the reachability migration at every hosted project's root: a dry run writes
// nothing, --fix writes the plan and audits it as migration.reachability, and
// a second run finds nothing. It is operator-invoked, never at bind.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const dirs: string[] = [];
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const d of dirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* windows file locks */ }
  }
});

/** A project root whose one Portal still states the retired portalType. Answers the component file. */
function oldProject(root: string): string {
  const specs = path.join(root, '.wai', 'specs');
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', name: 'shop', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(specs, '.index.yaml'), {
    schemaVersion: '1.0.0', name: 'Shop', vision: 'sells things', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(specs, 'shop', '.index.yaml'), {
    id: 'shop', name: 'Shop', description: 'd', parentSystem: 'Shop', trustedLinks: [], createdAt: now, updatedAt: now,
  });
  const file = path.join(specs, 'shop', 'web', '.index.yaml');
  writeYamlFile(file, {
    id: 'web', name: 'web', description: 'the web portal', subsystem: 'shop', componentType: 'Portal', portalType: 'HTTP_API',
    owns: [], dependsOn: [], createdAt: now, updatedAt: now,
  });
  writeYamlFile(path.join(specs, 'shop', 'web', '.interface.yaml'), {
    id: 'iweb', name: 'iweb', description: 'd', component: 'web', createdAt: now, updatedAt: now,
    methods: [{ name: 'browse', description: 'browse', signature: 'browse(): void', returns: 'void', endpoint: { transport: 'HTTP', method: 'GET', path: '/items' } }],
  });
  return file;
}

describe('hosted spec upgrade: the reachability migration (sdd_host)', () => {
  it('plans without --fix, writes and audits with it, and finds nothing the second time', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-host-reach-'));
    dirs.push(dataDir);
    const root = path.join(dataDir, 'projects', 'shop');
    const component = oldProject(root);
    registerProjectRecord(dataDir, 'shop', root);
    const cfg = { dataDir };
    const before = fs.readFileSync(component, 'utf8');

    // Dry run: the plan names the rewrite, nothing is written, nothing audited.
    const planned = migrateReachability(cfg, false);
    expect(planned).toHaveLength(1);
    expect(planned[0].projectId).toBe('shop');
    expect(planned[0].failure).toBeUndefined();
    expect(planned[0].plan?.applied).toBe(false);
    expect(planned[0].plan?.rewrites.some((r) => r.form === 'portal-type')).toBe(true);
    expect(fs.readFileSync(component, 'utf8')).toBe(before);
    expect(queryAuditEvents(dataDir, { action: 'migration.reachability' })).toHaveLength(0);

    // --fix (through the local admin portal the CLI reaches): written and audited.
    const applied = localAdminMigrate(cfg, true);
    expect(applied[0].plan?.applied).toBe(true);
    const stored = readYamlFile<Record<string, unknown>>(component)!;
    expect(stored.transport).toBe('HTTP');
    expect(stored.portalType).toBeUndefined();
    const events = queryAuditEvents(dataDir, { action: 'migration.reachability' });
    expect(events).toHaveLength(1);
    expect(events[0].projectId).toBe('shop');
    expect(JSON.parse(events[0].metadata ?? '{}').rewrites['portal-type']).toBeGreaterThan(0);

    // Idempotent: nothing left to rewrite, nothing more audited.
    invalidateSpecCache();
    const again = migrateReachability(cfg, true);
    expect(again[0].plan?.rewrites).toHaveLength(0);
    expect(queryAuditEvents(dataDir, { action: 'migration.reachability' })).toHaveLength(1);
  });

  it('answers a project whose tree cannot be read with why, and the next project continues', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-host-reach-'));
    dirs.push(dataDir);
    const good = path.join(dataDir, 'projects', 'good');
    oldProject(good);
    const broken = path.join(dataDir, 'projects', 'broken');
    fs.mkdirSync(path.join(broken, '.wai', 'specs'), { recursive: true });
    fs.writeFileSync(path.join(broken, '.wai', 'specs', '.index.yaml'), 'name: [unclosed');
    registerProjectRecord(dataDir, 'broken', broken);
    registerProjectRecord(dataDir, 'good', good);
    const result = migrateReachability({ dataDir }, false);
    const byId = new Map(result.map((m) => [m.projectId, m]));
    expect(byId.get('good')?.plan?.rewrites.length).toBeGreaterThan(0);
    // A tree the loader cannot read either fails here or plans nothing; it never stops the run.
    const brokenRun = byId.get('broken');
    expect(brokenRun).toBeDefined();
    expect(brokenRun!.failure !== undefined || brokenRun!.plan?.rewrites.length === 0).toBe(true);
  });
});
