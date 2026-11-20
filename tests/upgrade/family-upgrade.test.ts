import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import * as upgrade from '../../src/upgrade/index.js';
import { read } from '../../src/upgrade/adapters/stamp.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import { readLockJson, tempRoot, writeProject, writeV6Lock } from '../helpers/v6-project.js';

// ---------------------------------------------------------------------------
// The upgrade end to end on real temp directories: a v6 family (a top with a
// member project) is planned onto a rehearsal, applied all or nothing, or
// discarded; a tree with no v6 lock form is only stamped. The running major is
// 7 for the whole file; nothing else is mocked.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

/** Every file under a folder with its digest, for byte comparison. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      // The tree write lock's generation files stay on disk by design: not content.
      if (e.name.startsWith('.spec-write.lock')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** A v6 family: the top `parent` declares the member project `kid` at packages/kid; each holds a lock record. */
function v6Family(): { root: string; kid: string } {
  const root = tempRoot('wairon-upg-fam-');
  roots.push(root);
  const kid = path.join(root, 'packages', 'kid');
  writeProject(root, 'parent', { members: { kid: 'packages/kid' } });
  writeProject(kid, 'kid');
  writeV6Lock(kid);
  writeV6Lock(root);
  return { root, kid };
}

describe('wairon upgrade — a v6 family', () => {
  it('reads an unstamped family as the oldest kept major', () => {
    const { root, kid } = v6Family();
    const top = upgrade.standing(root);
    expect(top).toMatchObject({ root, writtenMajor: 6, stamped: false, state: 'older' });
    expect(top.advice).toContain('wairon upgrade');
    expect(upgrade.standing(kid).state).toBe('older');
  });

  it('plan writes nothing live, and discard removes the rehearsal', () => {
    const { root } = v6Family();
    const before = snapshot(root);
    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.rehearsal).toBeDefined();
    expect(plan.standings.map((s) => s.state)).toEqual(['older', 'older']);
    expect(plan.steps.map((s) => s.project)).toEqual([root, path.join(root, 'packages', 'kid')]);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.whatChanged.length).toBeGreaterThan(0);
    expect(snapshot(root)).toEqual(before);
    upgrade.discard(plan);
    expect(fs.existsSync(plan.rehearsal!.directory)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it('apply rewrites each lock record, stamps every project and names no re-lock when the approvals carry', () => {
    const { root, kid } = v6Family();
    const report = upgrade.apply(upgrade.plan(root));
    expect(report.failure).toBeUndefined();
    expect(report.committed).toBe(true);
    expect(report.stamped.sort()).toEqual([root, kid].sort());
    expect(report.relock).toEqual([]);
    expect(read(root)).toBe(7);
    expect(read(kid)).toBe(7);
    expect(readLockJson(root)).toMatchObject({ format: 4, upgraded: { carried: true } });
    expect(readLockJson(kid)).toMatchObject({ format: 4, upgraded: { carried: true } });
    // No transaction journal is left behind live.
    expect(fs.existsSync(path.join(root, '.wai', 'transactions'))).toBe(false);
    expect(upgrade.standing(root).state).toBe('current');
    // A second plan finds the family current.
    const again = upgrade.plan(root);
    expect(again.rehearsal).toBeUndefined();
    expect(again.steps).toEqual([]);
    expect(upgrade.apply(again)).toMatchObject({ committed: true, stamped: [], relock: [] });
  });

  it('names the project whose approval was not carried as owing a re-lock', () => {
    const { root, kid } = v6Family();
    const file = path.join(kid, '.wai', 'specs', 'kid-core', 'kid-orch', '.index.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('the orchestrator', 'changed'));
    const report = upgrade.apply(upgrade.plan(root));
    expect(report.committed).toBe(true);
    expect(report.relock).toEqual([kid]);
    expect(readLockJson(root).upgraded).toMatchObject({ carried: true });
    expect(readLockJson(kid).upgraded).toMatchObject({ carried: false });
  });

  it('apply is all or nothing: a live file changed since the plan leaves every file as before', () => {
    const { root, kid } = v6Family();
    const plan = upgrade.plan(root);
    // Another session writes the top's project.yaml between plan and apply.
    fs.appendFileSync(path.join(root, '.wai', 'project.yaml'), '\n# edited in between\n');
    const before = snapshot(root);
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(false);
    expect(report.failure).toBeTruthy();
    expect(snapshot(root)).toEqual(before);
    expect(read(root)).toBeNull();
    expect(read(kid)).toBeNull();
  });

  it('refuses the whole family, writing nothing, when one project is newer than the running major', () => {
    const { root, kid } = v6Family();
    const file = path.join(kid, '.wai', 'project.yaml');
    fs.writeFileSync(file, `waironMajor: 99\n${fs.readFileSync(file, 'utf8')}`);
    const before = snapshot(root);
    const plan = upgrade.plan(root);
    expect(plan.refusal).toContain(kid);
    expect(plan.rehearsal).toBeUndefined();
    expect(snapshot(root)).toEqual(before);
    expect(upgrade.apply(plan)).toMatchObject({ committed: false });
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a project older than the window, naming npx wairon@6 upgrade for a wairon 5 stamp', () => {
    const { root } = v6Family();
    const file = path.join(root, '.wai', 'project.yaml');
    fs.writeFileSync(file, `waironMajor: 5\n${fs.readFileSync(file, 'utf8')}`);
    const plan = upgrade.plan(root);
    expect(plan.standings[0].state).toBe('out_of_window');
    expect(plan.refusal).toContain('npx wairon@6 upgrade');
    expect(plan.rehearsal).toBeUndefined();
  });
});

describe('wairon upgrade — a tree holding no v6 lock form', () => {
  it('plans no rewrite, only the stamp', () => {
    const root = tempRoot('wairon-upg-bare-');
    roots.push(root);
    writeProject(root, 'bare');
    expect(read(root)).toBeNull();

    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].changes).toEqual([]);
    expect(plan.steps[0].reported).toEqual([]);
    // The one file change is the project.yaml, which carries the stamp.
    expect(plan.changes.map((c) => c.path)).toEqual(['.wai/project.yaml']);
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(report.stamped).toEqual([root]);
    expect(report.relock).toEqual([]);
    expect(read(root)).toBe(7);
  });

  it('converts the externals lock a part holds, with its declaring project, and gives the part no lock record', () => {
    const root = tempRoot('wairon-upg-partlock-');
    roots.push(root);
    writeProject(root, 'host', { members: { media: 'services/media' } });
    const part = path.join(root, 'services', 'media');
    writeYamlFile(path.join(part, '.wai', 'specs', 'media', '.index.yaml'), {
      id: 'media', name: 'media', description: 'the media part', parentSystem: 'host', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    });
    writeYamlFile(path.join(part, '.wai', 'externals.lock.yaml'), {
      externals: {}, parent: { project: 'host', snapshot: '.wai/externals/host.yaml', digest: 'sha256:host', used: {}, role: 'parent' },
    });
    writeYamlFile(path.join(part, '.wai', 'externals', 'host.yaml'), { project: 'host' });

    // The family's roots are the project and its part.
    expect(upgrade.plan(root).steps.map((s) => s.project).sort()).toEqual([root, part].sort());
    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    // Each change is named relative to the root it was made under: the project's stamp, and the part's lock conversion.
    expect(plan.changes.map((c) => c.path).sort()).toEqual(['.wai/externals.lock.yaml', '.wai/inputs.lock.yaml', '.wai/project.yaml']);
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(fs.existsSync(path.join(part, '.wai', 'externals.lock.yaml'))).toBe(false);
    const inputs = fs.readFileSync(path.join(part, '.wai', 'inputs.lock.yaml'), 'utf8');
    expect(inputs).toContain('parent:');
    expect(inputs).toContain('project: host');
    // A part has no lock record of its own, and no stamp.
    expect(fs.existsSync(path.join(part, '.wai', 'lock.json'))).toBe(false);
    expect(fs.existsSync(path.join(part, '.wai', 'project.yaml'))).toBe(false);
    // Finished: the next plan finds nothing left.
    expect(upgrade.plan(root).steps).toEqual([]);
  });

  it('stamps the project and leaves a part (no project.yaml of its own) unstamped', () => {
    const root = tempRoot('wairon-upg-part-');
    roots.push(root);
    writeProject(root, 'host', { members: { media: 'services/media' } });
    const part = path.join(root, 'services', 'media');
    writeYamlFile(path.join(part, '.wai', 'specs', 'media', '.index.yaml'), {
      id: 'media', name: 'media', description: 'the media part', parentSystem: 'host', publicInterfaces: [], trustedLinks: [],
      status: 'complete', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    });

    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.standings.map((s) => s.root)).toEqual([root]);
    expect(plan.changes.map((c) => c.path)).toEqual(['.wai/project.yaml']);
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(report.stamped).toEqual([root]);
    expect(read(root)).toBe(7);
    expect(fs.existsSync(path.join(part, '.wai', 'project.yaml'))).toBe(false);

    // Upgraded once: the part stands with its current family, so nothing is planned again.
    const again = upgrade.plan(root);
    expect(again.refusal).toBeUndefined();
    expect(again.rehearsal).toBeUndefined();
    expect(again.steps).toEqual([]);
  });
});
