import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run, upgradeTrees, readVersion, writeVersion, copyDataDir, StartRefused, StartAborted } from '../../src/server/upgrade.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { queryAuditEvents } from '../../src/server/audit.js';
import { read as readStamp } from '../../src/upgrade/adapters/stamp.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import { writeProject, buildHostedFamily } from './hosted-family.js';

// ---------------------------------------------------------------------------
// Data Dir Upgrade (sdd_host) — instance_version_store, instance_backup_adapter
// and instance_upgrade.run / upgradeTrees on real temp directories. Nothing is
// mocked: a hosted project's tree is an unstamped (v5) project.yaml and L0.
// ---------------------------------------------------------------------------

let base: string;
let dataDir: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-instupg-'));
  dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

/** The sibling backup folders a run left beside the data directory. */
const backups = (): string[] => fs.readdirSync(base).filter((n) => n.startsWith('data.backup-'));

/** Drop a project's stamp so its tree reads as written by major 5. */
function unstamp(root: string): void {
  const file = path.join(root, '.wai', 'project.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/^waironMajor:.*\r?\n/m, ''));
}

/** A hosted project whose tree an older major wrote. */
function olderProject(id: string): string {
  const root = createProjectRecord(dataDir, id).rootPath;
  writeProject(root, id);
  unstamp(root);
  return root;
}

describe('instance_version_store', () => {
  it('answers nothing when no version is recorded, and what was written once it is', () => {
    expect(readVersion(dataDir)).toBeNull();
    writeVersion(dataDir, 6);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'version.json'), 'utf-8'))).toEqual({ major: 6 });
    expect(readVersion(dataDir)).toBe(6);
    expect(fs.readdirSync(dataDir).filter((n) => n.includes('.tmp'))).toEqual([]);
  });

  it('refuses a file that does not parse, or holds no integer major, naming its path', () => {
    const file = path.join(dataDir, 'version.json');
    fs.writeFileSync(file, '{ not json');
    expect(() => readVersion(dataDir)).toThrow(file);
    fs.writeFileSync(file, JSON.stringify({ major: '6' }));
    expect(() => readVersion(dataDir)).toThrow(file);
    fs.writeFileSync(file, JSON.stringify({ major: 6.5 }));
    expect(() => readVersion(dataDir)).toThrow(file);
  });
});

describe('instance_backup_adapter', () => {
  it('copies the whole data directory, layout kept, beside it under a name naming the two majors', () => {
    fs.mkdirSync(path.join(dataDir, 'auth'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
    fs.writeFileSync(path.join(dataDir, 'auth', 'credentials.json'), '{"k":1}');
    const copy = copyDataDir(dataDir, 5, 6);
    expect(path.dirname(copy)).toBe(base);
    expect(path.basename(copy)).toMatch(/^data\.backup-v5-to-v6-\d{8}T\d{6}Z$/);
    expect(fs.readFileSync(path.join(copy, 'projects.json'), 'utf-8')).toBe('[]');
    expect(fs.readFileSync(path.join(copy, 'auth', 'credentials.json'), 'utf-8')).toBe('{"k":1}');
  });

  it('removes a partial copy and refuses with the cause when the copy fails', () => {
    // A data directory that does not exist cannot be copied.
    expect(() => copyDataDir(path.join(base, 'missing'), 5, 6)).toThrow(/could not back up/);
    expect(fs.readdirSync(base).filter((n) => n.startsWith('missing.backup-'))).toEqual([]);
  });
});

describe('instance_upgrade.run', () => {
  it('a current data directory takes no backup, writes nothing new, and still upgrades a tree restored from an older major', () => {
    writeVersion(dataDir, WAIRON_MAJOR);
    const root = olderProject('restored');
    const report = run({ dataDir });
    expect(report.fromMajor).toBe(WAIRON_MAJOR);
    expect(report.backup).toBeUndefined();
    expect(report.permissions).toBeUndefined();
    expect(report.members).toBeUndefined();
    expect(backups()).toEqual([]);
    expect(report.trees.map((t) => [t.project, t.failure])).toEqual([['restored', undefined]]);
    expect(readStamp(root)).toBe(WAIRON_MAJOR);
  });

  it('an older data directory is copied first, upgraded step by step, and records the running major', () => {
    // No version.json reads as major 5.
    const root = olderProject('app');
    const report = run({ dataDir });
    expect(report.fromMajor).toBe(5);
    expect(report.toMajor).toBe(WAIRON_MAJOR);
    expect(backups()).toHaveLength(1);
    expect(report.backup).toBe(path.join(base, backups()[0]));
    expect(report.permissions?.applied).toBe(true);
    expect(report.members?.plan.refusals).toEqual([]);
    expect(report.trees.map((t) => t.project)).toEqual(['app']);
    expect(readStamp(root)).toBe(WAIRON_MAJOR);
    expect(readVersion(dataDir)).toBe(WAIRON_MAJOR);
    // The pass is audited as migration.upgrade, under the operator.
    const events = queryAuditEvents(dataDir, { action: 'migration.upgrade' });
    expect(events.map((e) => e.projectId)).toEqual(['app']);
    expect(JSON.parse(events[0].metadata!)).toMatchObject({ stamped: [root] });
    // A second start finds nothing to do.
    const again = run({ dataDir });
    expect(again.backup).toBeUndefined();
    expect(again.trees).toEqual([]);
    expect(backups()).toHaveLength(1);
  });

  it('registers the members an upgraded family declares', () => {
    buildHostedFamily(dataDir);
    unstampFamily(path.join(dataDir, 'projects', 'platform'));
    const report = run({ dataDir });
    expect(report.members?.applied).toBe(true);
    expect(report.members?.plan.members.filter((m) => m.action === 'register').map((m) => m.record.id).sort()).toEqual(['billing', 'docs', 'payments']);
  });

  it('refuses to start on a data directory a newer major wrote', () => {
    writeVersion(dataDir, WAIRON_MAJOR + 1);
    expect(() => run({ dataDir })).toThrow(StartRefused);
    expect(backups()).toEqual([]);
  });

  it('refuses to start on a data directory older than the oldest major it upgrades', () => {
    writeVersion(dataDir, 4);
    expect(() => run({ dataDir })).toThrow(/install the last release of wairon 5 first/);
    expect(backups()).toEqual([]);
  });

  it('a tree that fails stops the start, naming the project and the backup; the version is not written', () => {
    const good = olderProject('good');
    const bad = olderProject('bad');
    fs.writeFileSync(path.join(bad, '.wai', 'project.yaml'), 'name: [unterminated\n');
    let thrown: unknown;
    try {
      run({ dataDir });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(StartAborted);
    const message = (thrown as Error).message;
    expect(message).toContain('bad');
    expect(message).toContain(path.join(base, backups()[0]));
    expect(readVersion(dataDir)).toBeNull();
    // Each tree already upgraded stays upgraded.
    expect(readStamp(good)).toBe(WAIRON_MAJOR);
  });
});

describe('instance_upgrade.upgradeTrees', () => {
  it('skips a record whose root holds no project yet, and a tree already current', () => {
    createProjectRecord(dataDir, 'empty');
    const current = createProjectRecord(dataDir, 'current').rootPath;
    writeProject(current, 'current');
    expect(upgradeTrees({ dataDir })).toEqual([]);
  });

  it('upgrades a family through its top once, not once per member', () => {
    buildHostedFamily(dataDir);
    unstampFamily(path.join(dataDir, 'projects', 'platform'));
    const trees = upgradeTrees({ dataDir });
    expect(trees.map((t) => t.project)).toEqual(['platform']);
    expect(trees[0].report?.stamped.length).toBeGreaterThan(1);
  });
});

/** Unstamp a hosted family's projects, the top and every member. */
function unstampFamily(top: string): void {
  for (const rel of ['', 'packages/billing', 'packages/billing/sub/payments', 'packages/docs']) {
    unstamp(path.join(top, rel));
  }
}
