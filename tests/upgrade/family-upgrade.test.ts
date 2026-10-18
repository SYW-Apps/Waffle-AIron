import { describe, it, expect, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as upgrade from '../../src/upgrade/index.js';
import { read } from '../../src/upgrade/adapters/stamp.js';
import { runInV5Reading, setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, saveComponentSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { writeLegacyMount } from '../helpers/legacy-mount.js';
import { writeYamlFile } from '../../src/utils/yaml.js';
import type { ComponentSpec, SubsystemSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The upgrade end to end on real temp directories: a v5 family (a top with a
// legacy L1 mount carrying projectPath) is planned onto a rehearsal, applied
// all or nothing, or discarded; a tree already in v6 forms but never stamped is
// only stamped. Nothing is mocked.
// ---------------------------------------------------------------------------

const now = new Date().toISOString();
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const subsystem = (id: string, over: Partial<SubsystemSpec> = {}): SubsystemSpec => ({
  id, name: id, description: `subsystem ${id}`, parentSystem: 'root-system',
  publicInterfaces: [], trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const component = (id: string, sub: string): ComponentSpec => ({
  id, name: id, description: 'd', subsystem: sub, componentType: 'Orchestrator',
  owns: [], dependsOn: [], status: 'complete', createdAt: now, updatedAt: now,
} as ComponentSpec);

/** Every file under a folder with its digest, for byte comparison. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

/** Drop the stamp a scaffold wrote, so the tree reads as unstamped. */
function unstamp(root: string): void {
  const file = path.join(root, '.wai', 'project.yaml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/^waironMajor:.*\r?\n/m, ''));
}

function projectYaml(root: string): void {
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'parent', name: 'parent',
    targets: [{ type: 'claude', outputDir: '.claude/agents', enabled: true }],
    rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
}

function system(name: string): void {
  saveSystemSpec({ schemaVersion: '1.0.0', name, vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
}

/** A v5 family: the top mounts child `kid` through an L1 subsystem carrying projectPath (written in the v5 reading). */
function v5Family(): { root: string; kid: string } {
  return runInV5Reading(writeV5Family);
}

function writeV5Family(): { root: string; kid: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-upg-fam-')));
  roots.push(root);
  projectYaml(root);
  setProjectRoot(root);
  system('root-system');
  saveSpec('subsystem', subsystem('parent-sub'));
  saveComponentSpec(component('parent-orch', 'parent-sub'));
  writeLegacyMount(subsystem('kid', { projectPath: 'packages/kid' }), 'kid');
  const kid = path.join(root, 'packages', 'kid');
  invalidateSpecCache();
  setProjectRoot(kid);
  system('kid-system');
  saveSpec('subsystem', subsystem('k-core', { parentSystem: 'kid-system' }));
  saveComponentSpec(component('k-orch', 'k-core'));
  invalidateSpecCache();
  setProjectRoot(null);
  unstamp(kid);
  return { root, kid };
}

describe('wairon upgrade — a v5 family', () => {
  it('reads an unstamped family as the oldest kept major', () => {
    const { root, kid } = v5Family();
    const top = upgrade.standing(root);
    expect(top).toMatchObject({ root, writtenMajor: 5, stamped: false, state: 'older' });
    expect(top.advice).toContain('wairon upgrade');
    expect(upgrade.standing(kid).state).toBe('older');
  });

  it('plan writes nothing live, and discard removes the rehearsal', () => {
    const { root } = v5Family();
    const before = snapshot(root);
    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.rehearsal).toBeDefined();
    expect(plan.standings.map((s) => s.state)).toEqual(['older', 'older']);
    expect(plan.steps.length).toBe(2);
    // The mount's move into members is a design change of the top.
    const top = plan.steps.find((s) => s.project === root)!;
    expect(top.changes.some((c) => c.design)).toBe(true);
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(plan.whatChanged.length).toBeGreaterThan(0);
    expect(snapshot(root)).toEqual(before);
    upgrade.discard(plan);
    expect(fs.existsSync(plan.rehearsal!.directory)).toBe(false);
    expect(snapshot(root)).toEqual(before);
  });

  it('apply moves the mount into members, stamps every project and names the re-lock', () => {
    const { root, kid } = v5Family();
    const plan = upgrade.plan(root);
    const report = upgrade.apply(plan);
    expect(report.failure).toBeUndefined();
    expect(report.committed).toBe(true);
    expect(report.stamped.sort()).toEqual([root, kid].sort());
    expect(report.relock).toContain(root);
    // The nested chaining migration committed into the rehearsal, and from there into the live family.
    const topYaml = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf-8');
    expect(topYaml).toMatch(/members:/);
    expect(topYaml).toContain('packages/kid');
    expect(topYaml).toMatch(/waironMajor: 6/);
    expect(read(root)).toBe(6);
    expect(read(kid)).toBe(6);
    // The legacy mount's projectPath is gone from every spec.
    const specFiles = Object.keys(snapshot(path.join(root, '.wai', 'specs')));
    for (const f of specFiles) {
      expect(fs.readFileSync(path.join(root, '.wai', 'specs', f), 'utf-8')).not.toContain('projectPath');
    }
    // No transaction journal is left behind live.
    expect(fs.existsSync(path.join(root, '.wai', 'transactions'))).toBe(false);
    expect(upgrade.standing(root).state).toBe('current');
    // A second plan finds the family current.
    const again = upgrade.plan(root);
    expect(again.rehearsal).toBeUndefined();
    expect(again.steps).toEqual([]);
    expect(upgrade.apply(again)).toMatchObject({ committed: true, stamped: [], relock: [] });
  });

  it('apply is all or nothing: a live file changed since the plan leaves every file as before', () => {
    const { root, kid } = v5Family();
    const plan = upgrade.plan(root);
    // Another session writes the top's project.yaml between plan and apply.
    const file = path.join(root, '.wai', 'project.yaml');
    fs.appendFileSync(file, '\n# edited in between\n');
    const before = snapshot(root);
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(false);
    expect(report.failure).toBeTruthy();
    expect(snapshot(root)).toEqual(before);
    expect(read(root)).toBeNull();
    expect(read(kid)).toBeNull();
  });

  it('refuses the whole family, writing nothing, when one project is newer than the running major', () => {
    const { root, kid } = v5Family();
    const file = path.join(kid, '.wai', 'project.yaml');
    fs.writeFileSync(file, `waironMajor: 99\n${fs.readFileSync(file, 'utf-8')}`);
    const before = snapshot(root);
    const plan = upgrade.plan(root);
    expect(plan.refusal).toContain(kid);
    expect(plan.rehearsal).toBeUndefined();
    expect(snapshot(root)).toEqual(before);
    expect(upgrade.apply(plan)).toMatchObject({ committed: false });
    expect(snapshot(root)).toEqual(before);
  });

  it('refuses a project older than the window', () => {
    const { root } = v5Family();
    const file = path.join(root, '.wai', 'project.yaml');
    fs.writeFileSync(file, `waironMajor: 3\n${fs.readFileSync(file, 'utf-8')}`);
    const plan = upgrade.plan(root);
    expect(plan.standings[0].state).toBe('out_of_window');
    expect(plan.refusal).toBeTruthy();
    expect(plan.rehearsal).toBeUndefined();
  });

  it('moves a legacy .wairon folder to .wai on the rehearsal and commits the move', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-upg-legacy-')));
    roots.push(root);
    projectYaml(root);
    setProjectRoot(root);
    system('root-system');
    saveSpec('subsystem', subsystem('only-sub'));
    saveComponentSpec(component('only-orch', 'only-sub'));
    unstamp(root);
    invalidateSpecCache();
    setProjectRoot(null);
    fs.renameSync(path.join(root, '.wai'), path.join(root, '.wairon'));

    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.steps[0].changes.some((c) => c.description.includes('.wairon') && !c.design)).toBe(true);
    expect(fs.existsSync(path.join(root, '.wairon'))).toBe(true);
    expect(upgrade.apply(plan).committed).toBe(true);
    expect(fs.existsSync(path.join(root, '.wai', 'project.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.wairon'))).toBe(false);
    expect(read(root)).toBe(6);
  });
});

describe('wairon upgrade — a tree already in v6 forms but never stamped', () => {
  it('plans no rewrite, only the stamp', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-upg-v6-')));
    roots.push(root);
    projectYaml(root);
    setProjectRoot(root);
    system('root-system');
    saveSpec('subsystem', subsystem('only-sub'));
    saveComponentSpec(component('only-orch', 'only-sub'));
    invalidateSpecCache();
    setProjectRoot(null);
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
    expect(read(root)).toBe(6);
  });
});
