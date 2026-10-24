/**
 * The design export carries the type group tree (typeGroups, format 2.2) and
 * each grouped type's group key; a project with no groups emits neither. The
 * dependency section is its own method (design_exporter.dependencies).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveGroupSpec, saveTypeSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { exportDesign, dependencies } from '../../src/core/design-export.js';
import { DESIGN_FORMAT_VERSION, DesignExportSchema } from '../../src/models/index.js';

const now = '2026-01-01T00:00:00.000Z';
const group = (id: string, over: Record<string, unknown> = {}) => saveGroupSpec({ kind: 'group', id, name: id.toUpperCase(), createdAt: now, updatedAt: now, ...over } as any);
const put = (id: string, over: Record<string, unknown> = {}) => saveTypeSpec({ kind: 'value-object', id, name: id, description: 'd', fields: [], methods: [], createdAt: now, updatedAt: now, ...over } as any);

describe('design export of type groups', () => {
  let proj: string;
  beforeEach(() => {
    proj = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-export-groups-'));
    fs.mkdirSync(path.join(proj, '.wai', 'specs'), { recursive: true });
    setProjectRoot(proj);
    saveSystemSpec({ schemaVersion: '1.0.0', name: 'contracts', vision: 'Shared contracts', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now } as any);
  });
  afterEach(() => {
    setProjectRoot(null);
    invalidateSpecCache();
    fs.rmSync(proj, { recursive: true, force: true });
  });

  it('is format 2.2 and lists the group tree sorted by key, each type naming its group', () => {
    expect(DESIGN_FORMAT_VERSION).toBe('2.2');
    group('runtime', { parent: 'platform', description: 'The runtime' });
    group('platform');
    put('heap', { group: 'runtime' });
    put('plain');
    const design = exportDesign();
    expect(design.formatVersion).toBe('2.2');
    expect(design.typeGroups).toEqual([
      { key: 'platform', name: 'PLATFORM' },
      { key: 'runtime', name: 'RUNTIME', description: 'The runtime', parent: 'platform' },
    ]);
    expect(design.types.find((t) => t.key === 'heap')?.group).toBe('runtime');
    expect(design.types.find((t) => t.key === 'plain')?.group).toBeUndefined();
    expect(DesignExportSchema.safeParse(design).success).toBe(true);
    // Deterministic: the same tree gives the same bytes.
    expect(JSON.stringify(exportDesign())).toBe(JSON.stringify(design));
  });

  it('emits no typeGroups when the project has no groups', () => {
    put('plain');
    expect('typeGroups' in exportDesign()).toBe(false);
  });

  it('the dependency list is its own method, empty for a project with no externals or members', () => {
    expect(dependencies()).toEqual([]);
    expect(exportDesign().dependencies).toEqual([]);
  });
});
