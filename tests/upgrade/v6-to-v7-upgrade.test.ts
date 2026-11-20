import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('../../src/config/defaults.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/defaults.js')>()),
  WAIRON_VERSION: '7.0.0-dev.1',
  WAIRON_MAJOR: 7,
}));

import * as upgrade from '../../src/upgrade/index.js';
import { read } from '../../src/upgrade/adapters/stamp.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { readLockRecord } from '../../src/core/lockfile.js';
import { computeApprovalId } from '../../src/core/validation.js';
import { externalsFileAdapter } from '../../src/core/externals.js';
import { parseYaml, writeYamlFile } from '../../src/utils/yaml.js';
import { readLockJson, tempRoot, writeProject, writeV6Lock } from '../helpers/v6-project.js';

// ---------------------------------------------------------------------------
// `wairon upgrade` from wairon 6 to 7 on real temp directories: the format-2/3
// lock record becomes format 4 (the approval carried only when proven
// unchanged, otherwise kept stale), .wai/externals.lock.yaml becomes
// .wai/inputs.lock.yaml (a path producer's pin dropped), a project with no lock
// gets none, and a tree still in wairon 5 forms is refused. The running major
// is 7 for the whole file; nothing else is mocked.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

function project(extra: Record<string, unknown> = {}): string {
  const root = tempRoot('wairon-v6v7-');
  roots.push(root);
  writeProject(root, 'shop', extra);
  return root;
}

/** Plan and apply, asserting the upgrade committed. */
function upgraded(root: string): upgrade.TreeUpgradeReport {
  const plan = upgrade.plan(root);
  expect(plan.refusal).toBeUndefined();
  const report = upgrade.apply(plan);
  expect(report.failure).toBeUndefined();
  expect(report.committed).toBe(true);
  return report;
}

const exists = (root: string, rel: string): boolean => fs.existsSync(path.join(root, ...rel.split('/')));

describe('the lock record, v6 to v7', () => {
  it('carries an approval the per-spec digests and the shared parts prove unchanged', () => {
    const root = project();
    const old = writeV6Lock(root);
    const plan = upgrade.plan(root);
    try {
      const described = plan.steps[0].changes.map((c) => c.description).join('\n');
      expect(described).toContain('the approval carried');
      expect(plan.steps[0].changes.every((c) => !c.design)).toBe(true);
    } finally {
      upgrade.discard(plan);
    }
    const report = upgraded(root);
    expect(report.relock).toEqual([]);
    expect(read(root)).toBe(7);

    const lock = readLockJson(root);
    expect(lock.format).toBe(4);
    expect(lock.status).toBe('ready');
    expect(lock.lockedAt).toBe(old.lockedAt);
    expect(lock.lockedBy).toEqual({ id: 'approver', source: 'git' });
    expect(lock.validatorVersion).toBe('6.7.4');
    expect(lock.specs).toEqual(old.specs);
    expect(lock).not.toHaveProperty('members');
    expect(lock).not.toHaveProperty('gateParts');
    expect(lock).not.toHaveProperty('specsReading');
    expect(lock).not.toHaveProperty('reexpressed');
    expect(lock.upgraded).toMatchObject({ fromFormat: 3, carried: true, compared: ['specs', 'design', 'rules', 'composition', 'network'] });

    // The v7 core reads it and finds the identity it computes now.
    setProjectRoot(root);
    invalidateSpecCache();
    const read7 = readLockRecord()!;
    const now = computeApprovalId();
    expect(read7.stateId).toEqual({ algorithm: now.algorithm, digest: now.digest });
    expect(now.algorithm).toBe('sha256+design+policy');
    expect(read7.parts).toEqual(now.parts);
  });

  it('keeps the old identity with no parts, so it reads stale, when a spec moved since the lock', () => {
    const root = project();
    const old = writeV6Lock(root);
    const file = path.join(root, '.wai', 'specs', 'shop-core', 'shop-orch', '.index.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('the orchestrator', 'the orchestrator, changed'));

    const plan = upgrade.plan(root);
    expect(plan.steps[0].changes.some((c) => c.design && c.description.includes('reads stale'))).toBe(true);
    expect(plan.steps[0].reported.join('\n')).toContain('spec changed: .wai/specs/shop-core/shop-orch/.index.yaml');
    expect(plan.steps[0].reported.join('\n')).toContain('wairon lock');
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(report.relock).toEqual([root]);

    const lock = readLockJson(root);
    expect(lock.format).toBe(4);
    expect(lock.stateId).toEqual(old.stateId);
    expect(lock.parts).toEqual({});
    expect(lock.specs).toEqual(old.specs);
    expect(lock.upgraded).toMatchObject({ fromFormat: 3, carried: false, compared: ['specs', 'design'] });
    expect(lock.lockedBy).toEqual({ id: 'approver', source: 'git' });

    // Stale for the v7 core: the identity it computes now is not the recorded one.
    setProjectRoot(root);
    invalidateSpecCache();
    expect(readLockRecord()!.stateId.digest).not.toBe(computeApprovalId().digest);
  });

  it('does not carry an approval whose rules part differs, naming the part', () => {
    const root = project();
    writeV6Lock(root, { tamperPart: { name: 'rules', digest: 'f'.repeat(64) } });
    upgraded(root);
    const lock = readLockJson(root);
    expect(lock.parts).toEqual({});
    expect(lock.upgraded).toMatchObject({ carried: false, compared: ['rules'] });
  });

  it('does not carry an approval of an older content reading or without gate parts', () => {
    const content = project();
    writeV6Lock(content, { specsReading: 'content' });
    const plan = upgrade.plan(content);
    expect(plan.steps[0].reported.join('\n')).toContain('predates what wairon 6 recorded');
    upgrade.discard(plan);
    upgraded(content);
    expect(readLockJson(content)).toMatchObject({ format: 4, parts: {}, upgraded: { carried: false } });

    const bare = project();
    writeV6Lock(bare, { noGateParts: true, format: 2 });
    upgraded(bare);
    expect(readLockJson(bare)).toMatchObject({ format: 4, parts: {}, upgraded: { fromFormat: 2, carried: false } });
  });

  it('reads a bare-string approver as a legacy identity and keeps the code results', () => {
    const root = project();
    writeV6Lock(root, { lockedBy: 'qa-fixture' });
    upgraded(root);
    expect(readLockJson(root).lockedBy).toEqual({ id: 'qa-fixture', source: 'legacy' });
  });

  it('plans and writes nothing for a project with no lock record', () => {
    const root = project();
    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.steps[0].changes).toEqual([]);
    expect(upgrade.apply(plan).committed).toBe(true);
    expect(exists(root, '.wai/lock.json')).toBe(false);
    expect(exists(root, '.wai/inputs.lock.yaml')).toBe(false);
    expect(read(root)).toBe(7);
  });

  it('refuses a lock record it cannot read, naming the file, and writes nothing', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.wai', 'lock.json'), '{ not json');
    expect(() => upgrade.plan(root)).toThrow(/lock\.json is not valid JSON/);
    expect(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).toBe('{ not json');
    expect(read(root)).toBeNull();
  });

  it('leaves a record that is already format 4 as it is', () => {
    const root = project();
    writeV6Lock(root);
    upgraded(root);
    const first = fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8');
    // Stamped current and nothing left of the v6 forms: a second plan finds nothing to do.
    const again = upgrade.plan(root);
    expect(again.steps).toEqual([]);
    expect(upgrade.apply(again)).toMatchObject({ committed: true, stamped: [], relock: [] });
    expect(fs.readFileSync(path.join(root, '.wai', 'lock.json'), 'utf8')).toBe(first);
  });
});

describe('the pins, v6 to v7', () => {
  const GIT = 'git@example.com:acme/sdk.git#' + 'a'.repeat(40);
  const entry = (name: string, role?: string): Record<string, unknown> => ({
    project: name, snapshot: `.wai/externals/${name}.yaml`, digest: `sha256:${name}`, used: {}, ...(role ? { role } : {}),
  });

  function pinned(): string {
    const root = project({
      externals: { geo: { source: 'hosted:geo' }, sdk: { source: GIT }, ledger: { source: '../ledger' } },
    });
    writeYamlFile(path.join(root, '.wai', 'externals.lock.yaml'), {
      externals: { geo: entry('geo'), sdk: entry('sdk'), ledger: entry('ledger') },
    });
    for (const name of ['geo', 'sdk', 'ledger']) writeYamlFile(path.join(root, '.wai', 'externals', `${name}.yaml`), { project: name });
    return root;
  }

  it('plans the conversion, naming each path pin it drops', () => {
    const root = pinned();
    const plan = upgrade.plan(root);
    try {
      const described = plan.steps[0].changes.map((c) => c.description);
      expect(described).toContain('.wai/externals.lock.yaml becomes .wai/inputs.lock.yaml');
      expect(described.some((d) => d.startsWith('ledger: a path producer is read live and never pinned'))).toBe(true);
      expect(described.some((d) => d.startsWith('geo:') || d.startsWith('sdk:'))).toBe(false);
      expect(plan.steps[0].changes.every((c) => !c.design)).toBe(true);
    } finally {
      upgrade.discard(plan);
    }
  });

  it('keeps the hosted and git pins, drops the path pin with its snapshot, and removes the v6 file', () => {
    const root = pinned();
    upgraded(root);
    expect(exists(root, '.wai/externals.lock.yaml')).toBe(false);
    expect(exists(root, '.wai/externals/ledger.yaml')).toBe(false);
    expect(exists(root, '.wai/externals/geo.yaml')).toBe(true);
    expect(exists(root, '.wai/externals/sdk.yaml')).toBe(true);
    const inputs = parseYaml(fs.readFileSync(path.join(root, '.wai', 'inputs.lock.yaml'), 'utf8')) as { externals: Record<string, unknown>; packs: Record<string, unknown> };
    expect(Object.keys(inputs.externals)).toEqual(['geo', 'sdk']);
    expect(inputs.packs).toEqual({});

    // The v7 core reads the inputs lock; the v6 refusal no longer fires.
    setProjectRoot(root);
    invalidateSpecCache();
    expect(Object.keys(externalsFileAdapter.readLock()!.externals)).toEqual(['geo', 'sdk']);
  });

  it('removes the externals directory when every pin was a path pin', () => {
    const root = project({ externals: { ledger: { source: '../ledger' } } });
    writeYamlFile(path.join(root, '.wai', 'externals.lock.yaml'), { externals: { ledger: entry('ledger') } });
    writeYamlFile(path.join(root, '.wai', 'externals', 'ledger.yaml'), { project: 'ledger' });
    upgraded(root);
    expect(exists(root, '.wai/externals')).toBe(false);
    expect(exists(root, '.wai/externals.lock.yaml')).toBe(false);
    expect(exists(root, '.wai/inputs.lock.yaml')).toBe(false);
  });

  it('keeps a part parent entry', () => {
    const root = project();
    writeYamlFile(path.join(root, '.wai', 'externals.lock.yaml'), { externals: {}, parent: { ...entry('shop-parent', 'parent') } });
    upgraded(root);
    const inputs = parseYaml(fs.readFileSync(path.join(root, '.wai', 'inputs.lock.yaml'), 'utf8')) as { parent: { project: string } };
    expect(inputs.parent.project).toBe('shop-parent');
  });

  it('refuses a pins file it cannot read, naming it', () => {
    const root = project();
    fs.writeFileSync(path.join(root, '.wai', 'externals.lock.yaml'), 'externals: [unclosed');
    expect(() => upgrade.plan(root)).toThrow(/externals\.lock\.yaml is not valid YAML/);
  });
});

describe('an unfinished upgrade and a wairon 5 tree', () => {
  it('runs again on a tree stamped current that still holds a v6 lock form', () => {
    const root = project();
    writeV6Lock(root);
    const config = path.join(root, '.wai', 'project.yaml');
    fs.writeFileSync(config, `waironMajor: 7\n${fs.readFileSync(config, 'utf8')}`);
    expect(upgrade.standing(root).state).toBe('current');
    const plan = upgrade.plan(root);
    expect(plan.standings[0]).toMatchObject({ state: 'older', unfinished: true });
    expect(upgrade.apply(plan).committed).toBe(true);
    expect(readLockJson(root).format).toBe(4);
    expect(upgrade.plan(root).steps).toEqual([]);
  });

  it('refuses a tree still holding a wairon 5 form, naming npx wairon@6 upgrade, and writes nothing', () => {
    const root = project();
    // A Gateway is a wairon 5 form the running release refuses.
    const gateway = path.join(root, '.wai', 'specs', 'shop-core', 'shop-gate', '.index.yaml');
    writeYamlFile(gateway, {
      id: 'shop-gate', name: 'shop-gate', description: 'a gateway', subsystem: 'shop-core', componentType: 'Gateway',
      owns: [], dependsOn: [], status: 'complete', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    });
    const plan = upgrade.plan(root);
    expect(plan.rehearsal).toBeUndefined();
    expect(plan.refusal).toContain('npx wairon@6 upgrade');
    expect(plan.refusal).toContain('written by wairon 5');
    expect(upgrade.apply(plan)).toMatchObject({ committed: false });
    expect(read(root)).toBeNull();
  });
});
