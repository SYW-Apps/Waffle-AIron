import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as upgrade from '../../src/upgrade/index.js';
import { read, write as stampWith } from '../../src/upgrade/adapters/stamp.js';
import { v5FormsLeft } from '../../src/upgrade/steps/v5-to-v6/files.js';
import { setProjectRoot } from '../../src/utils/fs.js';
import { getLoaderIssues, invalidateSpecCache, loadInterfaceSpecs, loadSubsystemSpecs } from '../../src/core/specs.js';
import { writeYamlFile } from '../../src/utils/yaml.js';

// ---------------------------------------------------------------------------
// `wairon upgrade` over the v5 forms it cannot decide for the author: an
// `invokedBy: { kind: sibling-subsystem }` no modelled call stands for, and an
// authored export `type` no backing Portal derives. wairon 6 cannot read a
// spec holding either, so the upgrade never keeps one: the declaration becomes
// runtime with its caller unchanged, the type is dropped, each is reported
// with what the author owes, and the tree it commits is read cleanly. A
// tree an earlier release stamped current while leaving such a form behind is
// an unfinished upgrade, and `wairon upgrade` finishes it.
// ---------------------------------------------------------------------------

const now = '2026-10-20T00:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const component = (id: string, sub: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id, name: id, description: `the ${id} component`, subsystem: sub, componentType: 'Orchestrator', owns: [], dependsOn: [],
  status: 'complete', createdAt: now, updatedAt: now, ...over,
});
const verb = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name, description: `the ${name} verb`, signature: `${name}(): void`, returns: 'void', ...over,
});
const contract = (id: string, comp: string, methods: Record<string, unknown>[]): Record<string, unknown> => ({
  id, name: id, description: 'd', component: comp, methods, status: 'complete', createdAt: now, updatedAt: now,
});

/** A project in the undecidable v5 forms; with `stamped`, as an earlier release left it: stamped 6, the forms still there. */
function project(stamped = false): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-undecidable-')));
  roots.push(root);
  const put = (rel: string, doc: Record<string, unknown>): void => writeYamlFile(path.join(root, '.wai', 'specs', ...rel.split('/')), doc);
  writeYamlFile(path.join(root, '.wai', 'project.yaml'), {
    schemaVersion: '1.0.0', id: 'tools', name: 'tools', targets: [], rules: {}, extensions: { packs: [], useGlobalPacks: false }, createdAt: now, updatedAt: now,
  });
  put('.index.yaml', { schemaVersion: '1.0.0', name: 'Tools', vision: 'builds things', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  put('compiler/.index.yaml', {
    id: 'compiler', name: 'compiler', description: 'd', parentSystem: 'Tools', trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
    // An export type no Portal backs: the entry is an Orchestrator.
    publicInterfaces: [{ type: 'Custom', details: 'the rule set', component: 'rules' }],
  });
  put('compiler/rules/.index.yaml', component('rules', 'compiler'));
  put('compiler/port/.index.yaml', component('port', 'compiler', { componentType: 'Adapter' }));
  put('compiler/port/.interface.yaml', contract('iport', 'port', [
    verb('emit', { invokedBy: { kind: 'sibling-subsystem', caller: 'The backend subsystem, through the injected port' } }),
  ]));
  put('backend/.index.yaml', {
    id: 'backend', name: 'backend', description: 'd', parentSystem: 'Tools', trustedLinks: [], status: 'complete', createdAt: now, updatedAt: now,
  });
  put('backend/general/.index.yaml', component('general', 'backend'));
  if (stamped) stampWith(root, 6);
  return root;
}

describe('wairon upgrade over the forms it cannot decide', () => {
  it('rewrites each one, reports what the author owes, and leaves a tree wairon 6 reads cleanly', () => {
    const root = project();
    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    const reported = plan.steps.flatMap((s) => s.reported);
    // The caller the old kind named, the subsystem it names, and both legal routes.
    const emit = reported.find((r) => r.startsWith('iport: caller of "emit" not modelled'))!;
    expect(emit).toContain('(naming backend)');
    expect(emit).toContain("port is not compiler's published Portal, so no other subsystem may call it directly");
    expect(emit).toContain('kind: runtime');
    expect(reported.some((r) => r.startsWith('compiler: type Custom of "rules" not derived'))).toBe(true);

    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(read(root)).toBe(6);
    expect(v5FormsLeft(root)).toEqual([]);

    // Read back OUTSIDE the v5 reading: nothing is refused.
    setProjectRoot(root);
    invalidateSpecCache();
    const interfaces = loadInterfaceSpecs();
    const subsystems = loadSubsystemSpecs();
    expect(getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
    expect(interfaces.find((i) => i.id === 'iport')!.methods[0].invokedBy).toEqual({ kind: 'runtime', caller: 'The backend subsystem, through the injected port' });
    expect(subsystems.find((s) => s.id === 'compiler')!.publicInterfaces).toEqual([{ details: 'the rule set', component: 'rules' }]);
    setProjectRoot(null);

    // A second plan finds nothing left to do.
    expect(upgrade.plan(root).steps).toEqual([]);
  });

  it('finishes an upgrade an earlier release stamped current while leaving a v5 form behind', () => {
    const root = project(true);
    expect(read(root)).toBe(6);
    expect(upgrade.standing(root).state).toBe('current');
    expect(v5FormsLeft(root).map((l) => path.basename(l.file))).toEqual(['.index.yaml', '.interface.yaml']);

    const plan = upgrade.plan(root);
    expect(plan.refusal).toBeUndefined();
    expect(plan.standings[0]).toMatchObject({ state: 'older', unfinished: true, writtenMajor: 5 });
    const report = upgrade.apply(plan);
    expect(report.committed).toBe(true);
    expect(v5FormsLeft(root)).toEqual([]);
    expect(read(root)).toBe(6);

    setProjectRoot(root);
    invalidateSpecCache();
    loadInterfaceSpecs();
    loadSubsystemSpecs();
    expect(getLoaderIssues().filter((i) => i.severity === 'error').map((i) => i.message)).toEqual([]);
  });

  it('the loader names `wairon upgrade` when it refuses a v5 form', () => {
    const root = project(true);
    setProjectRoot(root);
    invalidateSpecCache();
    loadInterfaceSpecs();
    const refused = getLoaderIssues().find((i) => i.message.includes('sibling-subsystem'));
    expect(refused?.message).toContain('`wairon upgrade` rewrites it');
  });
});
