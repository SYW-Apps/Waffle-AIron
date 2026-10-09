import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { writeSpecFile, readSpecFile } from '../../src/core/spec-files.js';
import { invalidateSpecCache } from '../../src/core/specs.js';
import { moveSpec } from '../../src/core/authoring.js';
import { validateProject } from '../../src/core/validation.js';
import { createMember } from '../../src/core/provision.js';

// ---------------------------------------------------------------------------
// Round 10 (authoring). Decided behaviour:
//  1. a type move re-points the L0 export table: an entry publishing a
//     project-level type (no `from`) moved into a subsystem re-exports it
//     `from` that subsystem, whose L1 gains the type's export; moving back
//     undoes both — no EXPORT_INVALID, ever;
//  2. every move is rehearsed: its dry run names the files and references it
//     writes and the findings the result will have;
//  3. moving back leaves no empty types/ folder and no updatedAt-only diff;
//  4. `member add` creates a member inside the project or one level up only,
//     and --report plans it without writing.
// ---------------------------------------------------------------------------

const STAMP = '2026-10-09T00:00:00.000Z';
let root = '';

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(path.dirname(root), { recursive: true, force: true }); } catch { /* windows locks */ }
  root = '';
});

/** A nested-layout project: an L0 publishing two project-level types, a `tiles` subsystem. */
function nested(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-r10-move-'));
  const dir = path.join(base, 'geo');
  const specs = (...p: string[]): string => path.join(dir, '.wai', 'specs', ...p);
  fs.mkdirSync(specs(), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), `schemaVersion: 1.0.0\nid: geo\nname: geo\ntargets: []\ncreatedAt: '${STAMP}'\nupdatedAt: '${STAMP}'\n`);
  writeSpecFile(specs('.index.yaml'), {
    schemaVersion: '1.0.0', name: 'geo', vision: 'Geo maths.', boundaries: [], globalRequirements: [],
    publicInterfaces: [{ typeDef: 'tile_coord', as: 'tile_coord' }, { typeDef: 'zoom', as: 'zoom' }], createdAt: STAMP, updatedAt: STAMP,
  });
  writeSpecFile(specs('tiles', '.index.yaml'), {
    id: 'tiles', name: 'tiles', description: 'Tile maths.', parentSystem: 'geo', publicInterfaces: [], trustedLinks: [],
    status: 'complete', createdAt: STAMP, updatedAt: STAMP,
  });
  writeSpecFile(specs('types', 'tile_coord.yaml'), {
    kind: 'value-object', id: 'tile_coord', name: 'TileCoord', description: 'A tile.',
    fields: [{ name: 'x', type: 'int', description: 'x', optional: false }, { name: 'z', type: 'zoom', description: 'its zoom', optional: false }],
    methods: [], createdAt: STAMP, updatedAt: STAMP,
  });
  writeSpecFile(specs('types', 'zoom.yaml'), {
    kind: 'value-object', id: 'zoom', name: 'Zoom', description: 'A zoom level.',
    fields: [{ name: 'level', type: 'int', description: 'the level', optional: false }], methods: [], createdAt: STAMP, updatedAt: STAMP,
  });
  setProjectRoot(dir);
  invalidateSpecCache();
  return dir;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string): void => {
    for (const e of fs.readdirSync(at, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[`${r}/`] = 'dir'; walk(path.join(at, e.name), r); } else out[r] = fs.readFileSync(path.join(at, e.name), 'utf8');
    }
  };
  walk(path.join(dir, '.wai', 'specs'), '');
  return out;
}

const exportErrors = (): string[] => validateProject().issues.filter((i) => i.code === 'EXPORT_INVALID').map((i) => i.message);

describe('1-3 — a type cluster moved into a subsystem and back (lib-and-app-r10 top-3)', () => {
  it('re-points the L0 export table, names what it writes, and round-trips byte for byte', () => {
    root = nested();
    const before = tree(root);
    const plan = moveSpec('type', 'tile_coord', 'tiles', true, ['zoom']);
    expect(plan.dryRun).toBe(true);
    expect(plan.files).toEqual(expect.arrayContaining([
      '.wai/specs/types/tile_coord.yaml → .wai/specs/tiles/types/tile_coord.yaml',
      '.wai/specs/types/zoom.yaml → .wai/specs/tiles/types/zoom.yaml',
      '.wai/specs/.index.yaml', '.wai/specs/tiles/.index.yaml',
    ]));
    expect(plan.references).toEqual(expect.arrayContaining(['system: L0 export tile_coord from (none) → tiles', 'tiles: L1 export of type zoom added']));
    expect(plan.findings).toEqual([]);
    expect(tree(root)).toEqual(before);

    moveSpec('type', 'tile_coord', 'tiles', false, ['zoom']);
    invalidateSpecCache();
    expect(exportErrors()).toEqual([]);
    const l0 = readSpecFile(path.join(root, '.wai', 'specs', '.index.yaml')) as { publicInterfaces: Record<string, unknown>[]; updatedAt: string };
    expect(l0.publicInterfaces).toEqual([{ typeDef: 'tile_coord', as: 'tile_coord', from: 'tiles' }, { typeDef: 'zoom', as: 'zoom', from: 'tiles' }]);
    expect(l0.updatedAt).toBe(STAMP);

    moveSpec('type', 'tile_coord', undefined, false, ['zoom']);
    invalidateSpecCache();
    expect(exportErrors()).toEqual([]);
    expect(fs.existsSync(path.join(root, '.wai', 'specs', 'tiles', 'types'))).toBe(false);
    expect(tree(root)).toEqual(before);
  });
});

describe('4 — member add only where a member belongs (platform-r10)', () => {
  it('refuses a path climbing past a sibling, and plans a sibling under report without writing', () => {
    root = nested();
    const parent = path.dirname(root);
    expect(() => createMember('evil', '../../../toolchain')).toThrow(/climbs 3 folders out of the project.*Nothing was written/s);
    expect(() => createMember('self', '../geo')).toThrow(/this project's own folder/);
    const config = fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8');
    const plan = createMember('sib', '../sib', undefined, undefined, true);
    expect(plan).toMatchObject({ written: false, as: 'part', storage: 'path' });
    expect(plan.creates).toEqual(expect.arrayContaining(['../sib/.wai/specs/ — the part\'s specs folder', '.wai/project.yaml — members: sib: ../sib']));
    expect(fs.existsSync(path.join(parent, 'sib'))).toBe(false);
    expect(fs.readFileSync(path.join(root, '.wai', 'project.yaml'), 'utf8')).toBe(config);
  });
});
