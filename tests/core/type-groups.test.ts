/**
 * Type groups as a tree (group_spec.parent, the type-groups rule, the group
 * move and rename): the folder chain mirrors the parent chain, type ids stay
 * bare and global, a type that joins another group takes its file along, and
 * the validator judges the tree. The fixture is a small synthetic version of a
 * real shape: a shared-contracts project with many root-level types, nested
 * groups (types > runtime > vm) and no subsystem.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import {
  saveSystemSpec,
  saveSpec,
  saveGroupSpec,
  saveTypeSpec,
  loadGroupSpecs,
  loadTypeSpecs,
  getGroupPath,
  getTypePath,
  invalidateSpecCache,
  groupChain,
  groupCycles,
  renameGroup,
} from '../../src/core/specs.js';
import { validateProject } from '../../src/core/validation.js';
import { moveSpec, renameSpecId } from '../../src/core/provision.js';
import { groupPlacementProblem, misplacedGroupFiles, type GroupSpec } from '../../src/models/specs.js';

const now = '2026-01-01T00:00:00.000Z';

const group = (id: string, over: Partial<GroupSpec> = {}): GroupSpec => ({ kind: 'group', id, name: id, createdAt: now, updatedAt: now, ...over });

function type(id: string, over: Record<string, unknown> = {}): any {
  return { kind: 'value-object', id, name: id, description: 'd', fields: [{ name: 'v', type: 'string', optional: false }], methods: [], createdAt: now, updatedAt: now, ...over };
}

const rel = (proj: string, file: string): string => path.relative(proj, file).replace(/\\/g, '/');

describe('group tree primitives', () => {
  const all = [group('types'), group('runtime', { parent: 'types' }), group('vm', { parent: 'runtime' }), group('loose', { parent: 'ghost' })];

  it('chain walks parent from the top, ends at an unknown parent and cuts a cycle', () => {
    expect(groupChain(all[2], all)).toEqual(['types', 'runtime', 'vm']);
    expect(groupChain(all[3], all)).toEqual(['loose']);
    const loop = [group('a', { parent: 'b' }), group('b', { parent: 'a' })];
    expect(groupChain(loop[0], loop)).toEqual(['b', 'a']);
  });

  it('cycles is true only when the walk returns to the group', () => {
    expect(groupCycles(all[2], all)).toBe(false);
    const loop = [group('a', { parent: 'b' }), group('b', { parent: 'a' }), group('c', { parent: 'a' })];
    expect(groupCycles(loop[0], loop)).toBe(true);
    expect(groupCycles(loop[2], loop)).toBe(false);
    expect(groupCycles(group('self', { parent: 'self' }), [group('self', { parent: 'self' })])).toBe(true);
  });

  it('placement problems: unknown parent, other home, loop; none for a sound placement', () => {
    expect(groupPlacementProblem(group('x', { parent: 'ghost' }), all)?.code).toBe('GROUP_PARENT_UNKNOWN');
    expect(groupPlacementProblem(group('x', { parent: 'types', subsystem: 'billing' }), all)?.code).toBe('GROUP_PARENT_CROSS_HOME');
    expect(groupPlacementProblem(group('types', { parent: 'vm' }), all)?.code).toBe('GROUP_CYCLE');
    expect(groupPlacementProblem(group('x', { parent: 'runtime' }), all)).toBeNull();
    expect(groupPlacementProblem(group('x'), all)).toBeNull();
  });

  it('misplaced files: a child outside its parent folder, a type outside its group folder', () => {
    const groups = [group('types'), group('runtime', { parent: 'types' })];
    const groupFiles = { types: '/p/.wai/specs/types/types/.index.yaml', runtime: '/p/.wai/specs/types/runtime/.index.yaml' };
    const typeFiles = { heap: '/p/.wai/specs/types/heap.yaml' };
    const found = misplacedGroupFiles(groups, groupFiles, typeFiles, [{ id: 'heap', group: 'runtime' }]);
    expect(found.map((m) => `${m.kind}:${m.id}`)).toEqual(['group:runtime', 'type:heap']);
    expect(found[0].expectedDir).toBe('/p/.wai/specs/types/types/runtime');
    const inPlace = misplacedGroupFiles(groups, { ...groupFiles, runtime: '/p/.wai/specs/types/types/runtime/.index.yaml' }, { heap: '/p/.wai/specs/types/types/runtime/heap.yaml' }, [{ id: 'heap', group: 'runtime' }]);
    expect(inPlace).toEqual([]);
  });
});

describe('group tree on disk', () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-groups-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
    saveSystemSpec({ schemaVersion: '1', name: 'contracts', vision: 'Shared contracts', boundaries: [], globalRequirements: [], publicInterfaces: [], status: 'draft', createdAt: now, updatedAt: now } as any);
  });
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('a child group sits in its parent folder and a type beside its group', () => {
    saveGroupSpec(group('types'));
    saveGroupSpec(group('runtime', { parent: 'types' }));
    saveGroupSpec(group('vm', { parent: 'runtime' }));
    saveTypeSpec(type('heap', { group: 'vm' }));
    saveTypeSpec(type('plain'));
    expect(rel(proj, getGroupPath('vm'))).toBe('.wai/specs/types/types/runtime/vm/.index.yaml');
    expect(rel(proj, getTypePath('heap'))).toBe('.wai/specs/types/types/runtime/vm/heap.yaml');
    expect(rel(proj, getTypePath('plain'))).toBe('.wai/specs/types/plain.yaml');
    // Type ids stay bare and global whatever folder they sit in.
    expect(loadTypeSpecs().map((t) => t.id).sort()).toEqual(['heap', 'plain']);
    expect(loadGroupSpecs().find((g) => g.id === 'vm')?.parent).toBe('runtime');
  });

  it('a type updated into another group takes its file along (and prunes the folder it left)', () => {
    saveGroupSpec(group('types'));
    saveGroupSpec(group('runtime', { parent: 'types' }));
    saveGroupSpec(group('io'));
    saveTypeSpec(type('heap', { group: 'io' }));
    expect(rel(proj, getTypePath('heap'))).toBe('.wai/specs/types/io/heap.yaml');
    saveTypeSpec(type('heap', { group: 'runtime' }));
    expect(rel(proj, getTypePath('heap'))).toBe('.wai/specs/types/types/runtime/heap.yaml');
    expect(fs.existsSync(path.join(proj, '.wai/specs/types/io/heap.yaml'))).toBe(false);
    expect(loadTypeSpecs().filter((t) => t.id === 'heap')).toHaveLength(1);
  });

  it('moving a group under a parent moves its folder with its types and children; updatedAt is kept', () => {
    saveGroupSpec(group('types'));
    saveGroupSpec(group('runtime'));
    saveGroupSpec(group('vm', { parent: 'runtime' }));
    saveTypeSpec(type('heap', { group: 'vm' }));
    const before = loadGroupSpecs().find((g) => g.id === 'runtime')!.updatedAt;
    const dry = moveSpec('group', 'runtime', undefined, true, 'types');
    expect(dry.dryRun).toBe(true);
    expect(dry.moved.map((m) => `${m.kind}:${m.id}`)).toEqual(['group:runtime', 'group:vm', 'type:heap']);
    expect(fs.existsSync(path.join(proj, '.wai/specs/types/runtime/.index.yaml'))).toBe(true);
    const done = moveSpec('group', 'runtime', undefined, false, 'types');
    expect(done.files?.[0]).toContain('→');
    expect(fs.existsSync(path.join(proj, '.wai/specs/types/runtime'))).toBe(false);
    expect(rel(proj, getGroupPath('vm'))).toBe('.wai/specs/types/types/runtime/vm/.index.yaml');
    expect(rel(proj, getTypePath('heap'))).toBe('.wai/specs/types/types/runtime/vm/heap.yaml');
    const runtime = loadGroupSpecs().find((g) => g.id === 'runtime')!;
    expect(runtime.parent).toBe('types');
    expect(runtime.updatedAt).toBe(before);
    // ...and back to the top.
    moveSpec('group', 'runtime');
    expect(rel(proj, getGroupPath('runtime'))).toBe('.wai/specs/types/runtime/.index.yaml');
    expect(loadGroupSpecs().find((g) => g.id === 'runtime')!.parent).toBeUndefined();
    expect(fs.existsSync(path.join(proj, '.wai/specs/types/types'))).toBe(true);
  });

  it('a group move refuses an unknown parent, a parent beneath it and a no-op', () => {
    saveGroupSpec(group('types'));
    saveGroupSpec(group('runtime', { parent: 'types' }));
    expect(() => moveSpec('group', 'types', undefined, false, 'ghost')).toThrow(/GROUP_PARENT_UNKNOWN/);
    expect(() => moveSpec('group', 'types', undefined, false, 'runtime')).toThrow(/GROUP_CYCLE/);
    expect(() => moveSpec('group', 'types', undefined, false, 'types')).toThrow(/GROUP_CYCLE/);
    expect(() => moveSpec('group', 'runtime', undefined, false, 'types')).toThrow(/nothing to move/);
    expect(() => moveSpec('type', 'heap', undefined, false, 'types')).toThrow(/invalid-parent/);
  });

  it('renaming a group renames its folder and retargets its types and child groups; type ids do not change', () => {
    saveGroupSpec(group('runtime'));
    saveGroupSpec(group('vm', { parent: 'runtime' }));
    saveTypeSpec(type('heap', { group: 'runtime' }));
    const dry = renameSpecId('group', 'runtime', 'exec', true);
    expect(dry.dryRun).toBe(true);
    expect(dry.rewritten.sort()).toEqual(['heap', 'vm']);
    expect(loadGroupSpecs().some((g) => g.id === 'exec')).toBe(false);
    const done = renameSpecId('group', 'runtime', 'exec');
    expect(done.renamed).toEqual([{ kind: 'group', from: 'runtime', to: 'exec' }]);
    expect(loadGroupSpecs().map((g) => g.id).sort()).toEqual(['exec', 'vm']);
    expect(loadGroupSpecs().find((g) => g.id === 'vm')!.parent).toBe('exec');
    expect(loadTypeSpecs().find((t) => t.id === 'heap')!.group).toBe('exec');
    expect(rel(proj, getGroupPath('vm'))).toBe('.wai/specs/types/exec/vm/.index.yaml');
    expect(rel(proj, getTypePath('heap'))).toBe('.wai/specs/types/exec/heap.yaml');
    expect(() => renameSpecId('group', 'exec', 'vm')).toThrow(/id-taken/);
    expect(() => renameSpecId('group', 'ghost', 'x')).toThrow(/spec-missing|no group/i);
  });

  it('renameGroup keeps every other key of the rewritten documents', () => {
    saveGroupSpec(group('runtime', { description: 'the runtime' }));
    saveTypeSpec(type('heap', { group: 'runtime', description: 'kept' }));
    renameGroup('runtime', 'exec');
    expect(loadGroupSpecs()[0]).toMatchObject({ id: 'exec', description: 'the runtime' });
    expect(loadTypeSpecs()[0]).toMatchObject({ id: 'heap', description: 'kept', group: 'exec' });
  });

  describe('the type-groups rule', () => {
    const codes = (): string[] => validateProject().issues.filter((i) => /GROUP/.test(i.code)).map((i) => `${i.code}:${i.specId ?? ''}`).sort();

    it('a sound tree of nested groups is quiet', () => {
      saveGroupSpec(group('types'));
      saveGroupSpec(group('runtime', { parent: 'types' }));
      saveTypeSpec(type('heap', { group: 'runtime' }));
      expect(codes()).toEqual([]);
    });

    it('reports a type naming an undeclared group', () => {
      saveTypeSpec(type('heap', { group: 'ghost' }));
      expect(codes()).toEqual(['TYPE_GROUP_UNKNOWN:heap']);
    });

    it('reports an unknown parent, a loop (once) and a misplaced file', () => {
      saveGroupSpec(group('a'));
      saveGroupSpec(group('b', { parent: 'a' }));
      // Hand-edit the tree into a loop and an orphan, the way a merge could.
      const aFile = path.join(proj, '.wai/specs/types/a/.index.yaml');
      fs.writeFileSync(aFile, fs.readFileSync(aFile, 'utf8') + 'parent: b\n');
      saveGroupSpec(group('orphan'));
      const oFile = path.join(proj, '.wai/specs/types/orphan/.index.yaml');
      fs.writeFileSync(oFile, fs.readFileSync(oFile, 'utf8') + 'parent: ghost\n');
      invalidateSpecCache();
      expect(codes()).toEqual(['GROUP_CYCLE:a', 'GROUP_PARENT_UNKNOWN:orphan']);
    });

    it('reports a parent in another home', () => {
      saveSpec('subsystem', { id: 'billing', name: 'Billing', description: 'd', parentSystem: 'contracts', publicInterfaces: [], status: 'draft', createdAt: now, updatedAt: now } as any);
      saveGroupSpec(group('top'));
      saveGroupSpec(group('inner', { subsystem: 'billing' }));
      const f = path.join(proj, '.wai/specs/billing/types/inner/.index.yaml');
      expect(fs.existsSync(f)).toBe(true);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8') + 'parent: top\n');
      invalidateSpecCache();
      expect(codes()).toContain('GROUP_PARENT_CROSS_HOME:inner');
    });

    it('warns about a type file outside its group folder, and a moved-away folder is repaired by placement', () => {
      saveGroupSpec(group('types'));
      saveGroupSpec(group('runtime', { parent: 'types' }));
      saveTypeSpec(type('heap', { group: 'runtime' }));
      // A hand move: the child folder is lifted out to the top, the type file out of its group.
      fs.renameSync(path.join(proj, '.wai/specs/types/types/runtime'), path.join(proj, '.wai/specs/types/runtime'));
      invalidateSpecCache();
      expect(codes()).toEqual(['TYPE_GROUP_MISPLACED:runtime']);
      const issue = validateProject().issues.find((i) => i.code === 'TYPE_GROUP_MISPLACED')!;
      expect(issue.severity).toBe('warning');
      expect(issue.message).toContain('wairon doctor --fix');
    });
  });
});
