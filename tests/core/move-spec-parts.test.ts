import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { setProjectRoot, listFilesRecursive, removeFile } from '../../src/utils/fs.js';
import { writeSpecFile, readSpecFile } from '../../src/core/spec-files.js';
import {
  invalidateSpecCache, listProjectRoots, loadComponentSpec, loadTypeSpec, loadGroupSpec, loadSubsystemSpec, PartReadOnly,
} from '../../src/core/specs.js';
import { moveSpec } from '../../src/core/authoring.js';
import { validateProject } from '../../src/core/validation.js';
import { moveSpec as coreMoveSpec, rehearsalCopy, discardRehearsal } from '../../src/core/provision.js';
import {
  ComponentSpecSchema, GroupSpecSchema, SubsystemSpecSchema, SystemSpecSchema, TypeSpecSchema,
} from '../../src/models/index.js';
import { bareFrom, isolateGlobals, tempDir as tempDirIn } from '../helpers/stage8-family.js';

// ---------------------------------------------------------------------------
// sdd_move_spec into and out of a part. A part's subsystems are the declaring
// project's own, named by their local ids, so a component, a type or a type
// group moves between the project and a part like between any two subsystems
// - the move is rehearsed in a private copy of the tree, which must carry the
// part's folder too. A part read from a git checkout is read-only here.
// Real temp directories throughout; a git part is served by a local bare
// repository, so nothing needs a network.
// ---------------------------------------------------------------------------

// The removal of a file is observable here: a test makes the first removal of one named file fail.
vi.mock('../../src/utils/fs.js', async (original) => {
  const real = await original<typeof import('../../src/utils/fs.js')>();
  return { ...real, removeFile: vi.fn(real.removeFile) };
});

const STAMP = '2026-10-02T00:00:00.000Z';
const cleanups: (() => void)[] = [];
let restoreGlobals: () => void = () => undefined;

beforeEach(() => {
  restoreGlobals = isolateGlobals(cleanups);
});

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  restoreGlobals();
  for (const c of cleanups.splice(0)) {
    try { c(); } catch { /* windows file locks */ }
  }
});

const tempDir = (prefix: string): string => tempDirIn(cleanups, prefix);
const specs = (dir: string, ...parts: string[]): string => path.join(dir, '.wai', 'specs', ...parts);

function bind(dir: string): void {
  setProjectRoot(dir);
  invalidateSpecCache();
}

function projectYaml(dir: string, extra: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({
    schemaVersion: '1.0.0', id: 'clinic', name: 'Clinic', targets: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function partYaml(dir: string, partOf: Record<string, unknown>): void {
  fs.mkdirSync(path.join(dir, '.wai'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), yaml.dump({ schemaVersion: '1.0.0', partOf }));
}

function subsystem(base: string, id: string, extra: Record<string, unknown> = {}): void {
  writeSpecFile(specs(base, id, '.index.yaml'), SubsystemSpecSchema.parse({
    id, name: id, description: `The ${id} subsystem`, parentSystem: 'Clinic', publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

function component(base: string, sub: string, id: string, componentType = 'Orchestrator', dependsOn: string[] = []): void {
  writeSpecFile(specs(base, sub, id, '.index.yaml'), ComponentSpecSchema.parse({
    id, name: id, description: `The ${id} component`, subsystem: sub, componentType, owns: [], dependsOn,
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  }));
}

function typeSpec(file: string, id: string, sub: string | undefined, extra: Record<string, unknown> = {}): void {
  writeSpecFile(file, TypeSpecSchema.parse({
    kind: 'value-object', id, name: id, description: `The ${id} type`, ...(sub !== undefined ? { subsystem: sub } : {}),
    fields: [{ name: 'value', type: 'string', description: 'The value', optional: false }],
    methods: [], createdAt: STAMP, updatedAt: STAMP, ...extra,
  }));
}

/** The project's own front desk: the L0, the frontdesk subsystem, a component, a plain type and a grouped one. */
function writeFrontDesk(root: string): void {
  writeSpecFile(specs(root, '.index.yaml'), SystemSpecSchema.parse({
    schemaVersion: '1.0.0', name: 'Clinic', vision: 'A clinic that books and checks in patients',
    boundaries: [], globalRequirements: [], createdAt: STAMP, updatedAt: STAMP,
  }));
  subsystem(root, 'frontdesk', { publicInterfaces: [{ typeDef: 'patient_note' }] });
  component(root, 'frontdesk', 'patient-registry');
  component(root, 'frontdesk', 'check-in-desk');
  typeSpec(specs(root, 'frontdesk', 'types', 'patient_note.yaml'), 'patient_note', 'frontdesk');
  writeSpecFile(specs(root, 'frontdesk', 'types', 'notes', '.index.yaml'), GroupSpecSchema.parse({
    kind: 'group', id: 'notes', name: 'Notes', description: 'The notes', subsystem: 'frontdesk', createdAt: STAMP, updatedAt: STAMP,
  }));
  typeSpec(specs(root, 'frontdesk', 'types', 'notes', 'visit_note.yaml'), 'visit_note', undefined, { group: 'notes' });
}

/** The scheduling subsystem, written under `base` (a part's folder): one component and one type of its own. */
function writeScheduling(base: string): void {
  subsystem(base, 'scheduling');
  component(base, 'scheduling', 'appointment-planner');
  typeSpec(specs(base, 'scheduling', 'types', 'slot.yaml'), 'slot', 'scheduling');
}

type Storage = 'contained' | 'sibling' | 'git';

/** The clinic with the scheduling subsystem stored as a part as asked; answers the clinic's root and the part's. */
function clinic(storage: Storage): { root: string; part: string } {
  const base = tempDir('wairon-clinic-');
  const root = path.join(base, 'clinic');
  writeFrontDesk(root);
  if (storage === 'contained') {
    projectYaml(root, { members: { scheduling: 'services/scheduling' } });
    writeScheduling(path.join(root, 'services', 'scheduling'));
    return { root, part: path.join(root, 'services', 'scheduling') };
  }
  if (storage === 'sibling') {
    projectYaml(root, { members: { scheduling: '../scheduling' } });
    writeScheduling(path.join(base, 'scheduling'));
    partYaml(path.join(base, 'scheduling'), { project: 'clinic', path: '../clinic' });
    return { root, part: path.join(base, 'scheduling') };
  }
  const work = tempDir('wairon-part-work-');
  writeScheduling(work);
  partYaml(work, { project: 'clinic' });
  const repo = bareFrom(cleanups, work, 'scheduling');
  projectYaml(root, { members: { scheduling: `${repo.url}#${repo.commit}` } });
  return { root, part: '' };
}

const treeOf = (dir: string): string[] => (fs.existsSync(dir)
  ? listFilesRecursive(dir, '.yaml').map((f) => path.relative(dir, f).replace(/\\/g, '/')).sort()
  : []);

const stored = (file: string): Record<string, any> => readSpecFile(file) as Record<string, any>;

describe.each(['contained', 'sibling'] as const)('moving into and out of a %s part', (storage) => {
  it('moves a component into the part and back, its file following the subsystem home', () => {
    const { root, part } = clinic(storage);
    bind(root);
    const planned = moveSpec('component', 'check-in-desk', 'scheduling', true);
    expect(planned.dryRun).toBe(true);
    expect(planned.moved.map((m) => m.id)).toContain('check-in-desk');
    // A dry run writes nothing.
    expect(fs.existsSync(specs(root, 'frontdesk', 'check-in-desk', '.index.yaml'))).toBe(true);

    moveSpec('component', 'check-in-desk', 'scheduling');
    expect(fs.existsSync(specs(part, 'scheduling', 'check-in-desk', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(specs(root, 'frontdesk', 'check-in-desk'))).toBe(false);
    invalidateSpecCache();
    expect(loadComponentSpec('check-in-desk')).toMatchObject({ subsystem: 'scheduling', dependsOn: [] });
    // The part's own subsystem file is still the part's: nothing leaked into the project.
    expect(fs.existsSync(specs(root, 'scheduling'))).toBe(false);

    moveSpec('component', 'check-in-desk', 'frontdesk');
    expect(fs.existsSync(specs(root, 'frontdesk', 'check-in-desk', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(specs(part, 'scheduling', 'check-in-desk'))).toBe(false);
    invalidateSpecCache();
    expect(loadComponentSpec('check-in-desk')?.subsystem).toBe('frontdesk');
  });

  it('moves a component out of the part into the project', () => {
    const { root, part } = clinic(storage);
    bind(root);
    moveSpec('component', 'appointment-planner', 'frontdesk');
    expect(fs.existsSync(specs(root, 'frontdesk', 'appointment-planner', '.index.yaml'))).toBe(true);
    expect(fs.existsSync(specs(part, 'scheduling', 'appointment-planner'))).toBe(false);
  });

  it('moves a type into the part and back, its export entry and references following', () => {
    const { root, part } = clinic(storage);
    bind(root);
    moveSpec('type', 'patient_note', 'scheduling');
    expect(fs.existsSync(specs(part, 'scheduling', 'types', 'patient_note.yaml'))).toBe(true);
    expect(fs.existsSync(specs(root, 'frontdesk', 'types', 'patient_note.yaml'))).toBe(false);
    // The export entry moved from the old subsystem to the one the type now lives in.
    expect(stored(specs(root, 'frontdesk', '.index.yaml')).publicInterfaces ?? []).toEqual([]);
    expect(stored(specs(part, 'scheduling', '.index.yaml')).publicInterfaces).toEqual([{ typeDef: 'patient_note' }]);
    invalidateSpecCache();
    expect(loadTypeSpec('patient_note')?.subsystem).toBe('scheduling');

    moveSpec('type', 'patient_note', 'frontdesk');
    expect(fs.existsSync(specs(root, 'frontdesk', 'types', 'patient_note.yaml'))).toBe(true);
    expect(fs.existsSync(specs(part, 'scheduling', 'types', 'patient_note.yaml'))).toBe(false);
    expect(stored(specs(root, 'frontdesk', '.index.yaml')).publicInterfaces).toEqual([{ typeDef: 'patient_note' }]);
  });

  it('moves a type out of the part', () => {
    const { root, part } = clinic(storage);
    bind(root);
    moveSpec('type', 'slot', 'frontdesk');
    expect(fs.existsSync(specs(root, 'frontdesk', 'types', 'slot.yaml'))).toBe(true);
    expect(fs.existsSync(specs(part, 'scheduling', 'types', 'slot.yaml'))).toBe(false);
  });

  it('moves a type group with its types into the part and back', () => {
    const { root, part } = clinic(storage);
    bind(root);
    moveSpec('group', 'notes', 'scheduling');
    expect(treeOf(specs(part, 'scheduling', 'types'))).toEqual(expect.arrayContaining(['notes/.index.yaml', 'notes/visit_note.yaml']));
    expect(fs.existsSync(specs(root, 'frontdesk', 'types', 'notes'))).toBe(false);
    invalidateSpecCache();
    expect(loadGroupSpec('notes')?.subsystem).toBe('scheduling');
    expect(loadTypeSpec('visit_note')?.group).toBe('notes');

    moveSpec('group', 'notes', 'frontdesk');
    expect(treeOf(specs(root, 'frontdesk', 'types'))).toEqual(expect.arrayContaining(['notes/.index.yaml', 'notes/visit_note.yaml']));
    expect(fs.existsSync(specs(part, 'scheduling', 'types', 'notes'))).toBe(false);
  });

  it('copies the part\'s folder into the rehearsal, so the declared source still finds it', () => {
    const { root } = clinic(storage);
    bind(root);
    const copy = rehearsalCopy();
    try {
      setProjectRoot(copy);
      invalidateSpecCache();
      const part = listProjectRoots()[0].parts[0];
      expect(part).toMatchObject({ alias: 'scheduling', availability: 'live', subsystems: ['scheduling'] });
      expect(loadSubsystemSpec('scheduling')).not.toBeNull();
    } finally {
      setProjectRoot(root);
      discardRehearsal(copy);
    }
  });
});

describe('a git part is read-only', () => {
  it('refuses a move into the part before anything is written, a dry run included', () => {
    const { root } = clinic('git');
    bind(root);
    const part = listProjectRoots()[0].parts[0];
    const before = fs.readdirSync(part.directory!, { recursive: true }).sort();
    const own = treeOf(specs(root));
    for (const dryRun of [true, false]) {
      expect(() => moveSpec('component', 'check-in-desk', 'scheduling', dryRun)).toThrow(/member update scheduling|read-only/);
      expect(() => coreMoveSpec('component', 'check-in-desk', 'scheduling', dryRun)).toThrow(PartReadOnly);
      expect(() => coreMoveSpec('type', 'patient_note', 'scheduling', dryRun)).toThrow(PartReadOnly);
      expect(() => coreMoveSpec('group', 'notes', 'scheduling', dryRun)).toThrow(PartReadOnly);
    }
    expect(treeOf(specs(root))).toEqual(own);
    expect(fs.readdirSync(part.directory!, { recursive: true }).sort()).toEqual(before);
  });

  it('refuses a move out of the part before anything is written, a dry run included', () => {
    const { root } = clinic('git');
    bind(root);
    const part = listProjectRoots()[0].parts[0];
    const before = fs.readdirSync(part.directory!, { recursive: true }).sort();
    for (const dryRun of [true, false]) {
      expect(() => moveSpec('component', 'appointment-planner', 'frontdesk', dryRun)).toThrow(/read-only|member update scheduling/);
      expect(() => coreMoveSpec('type', 'slot', 'frontdesk', dryRun)).toThrow(PartReadOnly);
    }
    expect(treeOf(specs(root))).toEqual(treeOf(specs(root)));
    expect(fs.existsSync(specs(root, 'frontdesk', 'appointment-planner'))).toBe(false);
    expect(fs.readdirSync(part.directory!, { recursive: true }).sort()).toEqual(before);
  });
});

describe('the alias::subsystem spelling', () => {
  it('is refused as naming another project, and names the local id when the alias is a part', () => {
    const { root } = clinic('contained');
    bind(root);
    let message = '';
    try {
      moveSpec('component', 'check-in-desk', 'scheduling::scheduling');
    } catch (e) {
      message = String((e as Error).message);
    }
    expect(message).toContain('subsystem-missing');
    expect(message).toContain('a part');
    expect(message).toContain('"scheduling"');
    expect(message).toMatch(/local id/);
    expect(fs.existsSync(specs(root, 'frontdesk', 'check-in-desk', '.index.yaml'))).toBe(true);
  });
});

describe('a move between two homes writes the destination before removing the source', () => {
  it('leaves the type in both homes, never in neither, when the removal of the source is interrupted - and re-running settles it', () => {
    const { root, part } = clinic('contained');
    bind(root);
    const source = specs(root, 'frontdesk', 'types', 'patient_note.yaml');
    const destination = specs(part, 'scheduling', 'types', 'patient_note.yaml');
    const real = vi.mocked(removeFile).getMockImplementation()!;
    vi.mocked(removeFile).mockImplementation((file: string) => {
      if (path.resolve(file) === path.resolve(source)) throw new Error('interrupted');
      real(file);
    });
    try {
      expect(() => coreMoveSpec('type', 'patient_note', 'scheduling', false)).toThrow(/interrupted/);
    } finally {
      vi.mocked(removeFile).mockImplementation(real);
    }
    // The destination was written first, and the source was still there when the removal failed.
    expect(fs.existsSync(destination)).toBe(true);
    expect(fs.existsSync(source)).toBe(true);
    expect(stored(destination).subsystem).toBe('scheduling');
    // Validation names the duplicate id.
    invalidateSpecCache();
    expect(validateProject({}).issues.some((i) => i.code === 'DUPLICATE_SPEC_ID' && i.specId === 'patient_note')).toBe(true);
    // The move re-run (the source addressed by its subsystem) removes the source and settles.
    coreMoveSpec('type', 'frontdesk::patient_note', 'scheduling', false);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.existsSync(destination)).toBe(true);
    invalidateSpecCache();
    expect(loadTypeSpec('patient_note')?.subsystem).toBe('scheduling');
  });

  it('never leaves the copy behind when the rehearsal ends: the temporary folder is removed whole', () => {
    const { root } = clinic('sibling');
    bind(root);
    const copy = rehearsalCopy();
    const holder = path.dirname(copy);
    expect(path.basename(holder)).toBe('up');
    expect(fs.existsSync(path.join(path.dirname(holder), 'up', 'scheduling', '.wai'))).toBe(true);
    discardRehearsal(copy);
    expect(fs.existsSync(path.dirname(holder))).toBe(false);
  });
});
