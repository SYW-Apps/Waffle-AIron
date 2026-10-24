import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerLocalDevProject } from '../../src/server/admin.js';
import { bootstrapInstance } from '../../src/server/instance-bootstrap.js';
import { discardDataDir, readVersion, resetDevDataDir, run as runUpgrade, writeVersion } from '../../src/server/upgrade.js';
import { listProjectRecords, isValidProjectId } from '../../src/server/projects.js';
import { createProjectRecord } from '../../src/server/projects.js';
import { devStatus } from '../../src/server/webproject.js';
import { startDevSession } from '../../src/server/web.js';
import { buildCanvasDataModel } from '../../src/server/adapters/core.js';
import { runWithProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { WAIRON_MAJOR } from '../../src/config/defaults.js';
import type { HostConfig } from '../../src/server/types.js';

// ---------------------------------------------------------------------------
// `wairon dev` registration (6.2.0, sdd_host): record ids are project ids, a stale development data dir is
// discarded (never backed up, never migrated), an unreadable member never stops the start and is reported
// with its reason, and a brand-new dev dir is never mistaken for a v5 directory awaiting migration.
// ---------------------------------------------------------------------------

function project(dir: string, id: string, extra = ''): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.wai', 'project.yaml'),
    `schemaVersion: 1.0.0\nid: ${id}\nwaironMajor: ${WAIRON_MAJOR}\nname: ${id}\ncreatedAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\n${extra}`,
  );
}

describe('wairon dev registration (sdd_host)', () => {
  let base: string;
  let dataDir: string;
  let root: string;
  let cfg: HostConfig;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-dev-reg-'));
    dataDir = path.join(base, 'data');
    root = path.join(base, 'family');
    fs.mkdirSync(root, { recursive: true });
    cfg = { host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0, dataDir, authEnabled: false, devMode: true };
  });
  afterEach(() => {
    invalidateSpecCache();
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* windows file locks */
    }
  });

  const backups = (): string[] => fs.readdirSync(base).filter((n) => n.startsWith('data.backup-'));

  // ── H3: one id grammar ────────────────────────────────────────────────────

  it('a record id is a project id: underscores and dots are accepted, the project grammar decides', () => {
    for (const id of ['waffler_core', 'network_http', 'a.b', 'x-1', 'billing']) expect(isValidProjectId(id)).toBe(true);
    for (const id of ['', '_a', 'a_', 'A', 'a b', 'con', 'super', 'x'.repeat(65), '../x']) expect(isValidProjectId(id)).toBe(false);
    const rec = createProjectRecord(dataDir, 'my_service.v2');
    expect(rec.id).toBe('my_service.v2');
    expect(() => createProjectRecord(dataDir, 'Bad Id')).toThrow(/Invalid project id "Bad Id": .*project id/);
  });

  // ── H4: the fresh dir ordering ────────────────────────────────────────────

  it('a brand-new dev data dir is not migrated and not backed up, though the registration writes before bootstrap', () => {
    // runDev's order: register (writes projects.json) -> startHostServer: bootstrapInstance -> instanceUpgrade.run.
    const registration = registerLocalDevProject(cfg, 'local', root);
    expect(registration.reset).toBe(false);
    // The registration already stamped the directory current: it never reads as unversioned (= v5).
    expect(readVersion(dataDir)).toBe(WAIRON_MAJOR);
    bootstrapInstance(cfg);
    const report = runUpgrade(cfg);
    expect(report.fromMajor).toBe(WAIRON_MAJOR);
    expect(report.backup).toBeUndefined();
    expect(report.permissions).toBeUndefined();
    expect(report.members).toBeUndefined();
    expect(backups()).toEqual([]);
  });

  it('an unversioned dir holding a registration (the old order) would have been migrated; the reset prevents it', () => {
    // The old defect, reproduced: data written before any version stamp reads as v5 and takes a backup.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
    const old = runUpgrade({ ...cfg, devMode: false });
    expect(old.fromMajor).toBe(5);
    expect(old.backup).toBeDefined();
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const b of backups()) fs.rmSync(path.join(base, b), { recursive: true, force: true });
    // Now the same pre-existing state through the dev registration: purged, no backup, no migration.
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'projects.json'), '[]');
    expect(registerLocalDevProject(cfg, 'local', root).reset).toBe(true);
    bootstrapInstance(cfg);
    const report = runUpgrade(cfg);
    expect(report.backup).toBeUndefined();
    expect(backups()).toEqual([]);
  });

  // ── H4: the reset ─────────────────────────────────────────────────────────

  it('resets an unversioned, other-major or unparseable-version dir with its backups; keeps one at the running major', () => {
    const seed = (): void => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'stale.json'), '{}');
      fs.mkdirSync(`${dataDir}.backup-v5-to-v6-20260101T000000Z`);
      fs.writeFileSync(path.join(`${dataDir}.backup-v5-to-v6-20260101T000000Z`, 'old.json'), '{}');
      fs.mkdirSync(path.join(base, 'unrelated'), { recursive: true });
    };
    const cases: [string, () => void][] = [
      ['unversioned', () => undefined],
      ['another major', () => writeVersion(dataDir, WAIRON_MAJOR - 1)],
      ['unparseable version.json', () => fs.writeFileSync(path.join(dataDir, 'version.json'), '{ nope')],
    ];
    for (const [label, mark] of cases) {
      seed();
      mark();
      expect(resetDevDataDir(cfg), label).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'stale.json')), label).toBe(false);
      expect(backups(), label).toEqual([]);
      expect(readVersion(dataDir), label).toBe(WAIRON_MAJOR);
      expect(fs.existsSync(path.join(base, 'unrelated')), label).toBe(true);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    // At the running major: kept as it is.
    seed();
    writeVersion(dataDir, WAIRON_MAJOR);
    expect(resetDevDataDir(cfg)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'stale.json'))).toBe(true);
    expect(fs.existsSync(`${dataDir}.backup-v5-to-v6-20260101T000000Z`)).toBe(true);
  });

  it('refuses to reset outside development mode and never deletes a hosted data dir', () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'keep.json'), '{}');
    expect(() => resetDevDataDir({ ...cfg, devMode: false })).toThrow(/development server/);
    expect(fs.existsSync(path.join(dataDir, 'keep.json'))).toBe(true);
    expect(() => registerLocalDevProject({ ...cfg, devMode: false }, 'local', root)).toThrow(/reserved for the local development server/);
    expect(discardDataDir(path.join(base, 'absent'))).toEqual([]);
  });

  // ── H4: the family ────────────────────────────────────────────────────────

  it('registers members with underscore ids and reports an unreadable one without stopping', () => {
    project(root, 'waffler', 'members:\n  core: pkgs/core\n  text: pkgs/text\n  broken: pkgs/broken\n  gone: pkgs/gone\n');
    project(path.join(root, 'pkgs', 'core'), 'waffler_core');
    project(path.join(root, 'pkgs', 'text'), 'waffler_text');
    fs.mkdirSync(path.join(root, 'pkgs', 'broken', '.wai'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkgs', 'broken', '.wai', 'project.yaml'), 'id: [unterminated\n  : :');

    const registration = registerLocalDevProject(cfg, 'local', root);
    expect(registration.project.id).toBe('local');
    const byAction = (a: string): string[] => registration.members.filter((m) => m.action === a).map((m) => m.record.id).sort();
    expect(byAction('register')).toEqual(['waffler_core', 'waffler_text']);
    const unreadable = registration.members.filter((m) => m.action === 'unreadable');
    expect(unreadable.map((m) => m.qualifier).sort()).toEqual(['local::broken', 'local::gone']);
    expect(unreadable.every((m) => (m.reason ?? '').length > 0)).toBe(true);
    // The readable ones have records; the unreadable ones register nothing.
    const ids = listProjectRecords(dataDir).map((r) => r.id).sort();
    expect(ids).toEqual(['local', 'waffler_core', 'waffler_text']);
    // Idempotent across restarts.
    expect(registerLocalDevProject(cfg, 'local', root).reset).toBe(false);
    expect(listProjectRecords(dataDir)).toHaveLength(3);

    // The web app's status is a live read of the same declarations.
    bootstrapInstance(cfg);
    const session = startDevSession(cfg);
    const status = devStatus(cfg, session);
    expect(status.devMode).toBe(true);
    expect(status.problems.map((p) => p.member).sort()).toEqual(['local::broken', 'local::gone']);
    expect(status.problems.find((p) => p.member === 'local::gone')).toMatchObject({ path: 'pkgs/gone' });
    // Fixing the member clears it without a restart.
    project(path.join(root, 'pkgs', 'gone'), 'waffler_gone');
    expect(devStatus(cfg, session).problems.map((p) => p.member)).toEqual(['local::broken']);
    // A hosted instance has no dev status to show.
    expect(devStatus({ ...cfg, devMode: false }, session)).toEqual({ devMode: false, problems: [] });
  });

  // ── H4: a tree that cannot be built still answers ─────────────────────────

  it('answers an empty canvas model with one error finding when the tree yields nothing, never throws', () => {
    const nothing = path.join(base, 'nothing');
    fs.mkdirSync(nothing, { recursive: true });
    const model = runWithProjectRoot(nothing, () => buildCanvasDataModel());
    expect(model.issues.length).toBeGreaterThanOrEqual(1);
    expect(model.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(model.subsystems).toEqual([]);
  });
});
