import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot } from '../../src/utils/fs.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { renameMethod, renameParam } from '../../src/core/provision.js';
import { waiState } from '../helpers/family-verbs.js';
import { tempDir, isolateGlobals, bareFrom, specs, system, subsystem, component, contract, projectYaml } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// All or nothing: a rename that cannot write every spec it must refuses before
// the first write. Every scenario is a real temporary project.
// ---------------------------------------------------------------------------

const cleanups: (() => void)[] = [];
beforeEach(() => { cleanups.push(isolateGlobals(cleanups)); });
afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  for (const c of cleanups.splice(0).reverse()) {
    try { c(); } catch { /* windows locks */ }
  }
});

const SPEAK = [{ name: 'announce', description: 'Announce', params: [{ name: 'volume', type: 'int' }], returns: 'void' }];

const edit = (file: string, change: (doc: any) => void): void => {
  const doc = yaml.load(fs.readFileSync(file, 'utf-8')) as any;
  change(doc);
  fs.writeFileSync(file, yaml.dump(doc));
};

/** clinic: the abstraction `slot-source` and a local implementer; a second implementer lives in a part fetched from git. */
function clinicWithGitPart(): string {
  const base = tempDir(cleanups, 'wairon-atomic-');
  const work = path.join(base, 'work');
  subsystem(work, 'Clinic', 'scheduling');
  component(work, 'scheduling', 'git-client', 'Adapter');
  contract(work, 'scheduling', 'git-client', SPEAK);
  edit(specs(work, 'scheduling', 'git-client', '.interface.yaml'), (doc) => { doc.implements = ['slot-source']; });
  fs.mkdirSync(path.join(work, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(work, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf: { project: 'clinic' } }));
  const repo = bareFrom(cleanups, work, 'scheduling');
  const root = path.join(base, 'clinic');
  projectYaml(root, { id: 'clinic', name: 'Clinic', members: { scheduling: `${repo.url}#${repo.commit}` } });
  system(root, 'Clinic');
  subsystem(root, 'Clinic', 'frontdesk');
  component(root, 'frontdesk', 'slot-source', 'Adapter', [], { abstract: true });
  contract(root, 'frontdesk', 'slot-source', SPEAK);
  component(root, 'frontdesk', 'local-client', 'Adapter');
  contract(root, 'frontdesk', 'local-client', SPEAK);
  edit(specs(root, 'frontdesk', 'local-client', '.interface.yaml'), (doc) => { doc.implements = ['slot-source']; });
  setProjectRoot(root);
  invalidateSpecCache();
  return root;
}

describe('an implementer in a part the request cannot write', () => {
  it('a method rename refuses before the first write, on a dry run as on the real rename', () => {
    const root = clinicWithGitPart();
    const before = waiState(root);
    expect(() => renameMethod('slot-source', 'announce', 'notify')).toThrow(/read-only|PartReadOnly|git part/);
    expect(waiState(root)).toEqual(before);
    expect(() => renameMethod('slot-source', 'announce', 'notify', undefined, true)).toThrow(/read-only|PartReadOnly|git part/);
  });

  it('a parameter rename refuses before the first write', () => {
    const root = clinicWithGitPart();
    const before = waiState(root);
    expect(() => renameParam('slot-source', 'announce', 'volume', 'gain')).toThrow(/read-only|PartReadOnly|git part/);
    expect(waiState(root)).toEqual(before);
  });
});
