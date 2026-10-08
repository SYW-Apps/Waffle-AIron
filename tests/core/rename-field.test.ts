import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSystemSpec, saveSpec, invalidateSpecCache, loadTypeSpec } from '../../src/core/specs.js';
import { renameField } from '../../src/core/provision.js';
import { exportDesign } from '../../src/core/design-export.js';
import type { SubsystemSpec, TypeSpec } from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// core_orchestrator.renameField: a field renamed by hand loses its references
// and leaves no trace, so a consumer holding the old name reads a removal and
// an addition. The tool respells every foreign key naming it and keeps the old
// name on the field (previousNames), which the design export shows as
// `formerly`.
// ---------------------------------------------------------------------------

const now = '2026-10-06T10:00:00.000Z';
let root: string;

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-rename-field-'));
  fs.mkdirSync(path.join(dir, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.wai', 'project.yaml'), JSON.stringify({
    schemaVersion: '1.0.0', name: 'billing-sys', targets: [], rules: {}, createdAt: now, updatedAt: now,
  }));
  setProjectRoot(dir);
  saveSystemSpec({ schemaVersion: '1.0.0', name: 'billing-sys', vision: 'v', boundaries: [], globalRequirements: [], createdAt: now, updatedAt: now });
  saveSpec('subsystem', { id: 'billing', name: 'billing', description: 'd', parentSystem: 'billing-sys', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now } as SubsystemSpec);
  saveSpec('type', {
    kind: 'entity', id: 'invoice', name: 'Invoice', subsystem: 'billing',
    fields: [{ name: 'id', type: 'string', optional: false, key: 'primary' }, { name: 'total', type: 'int', optional: false }],
    methods: [], createdAt: now, updatedAt: now,
  } as TypeSpec);
  saveSpec('type', {
    kind: 'entity', id: 'line', name: 'Line', subsystem: 'billing',
    fields: [{ name: 'invoice', type: 'string', optional: false, key: 'foreign', references: 'invoice.id' }],
    methods: [], createdAt: now, updatedAt: now,
  } as TypeSpec);
  invalidateSpecCache();
  setProjectRoot(dir);
  return dir;
}

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

describe('renameField', () => {
  it('moves the field, keeps its trace and respells every foreign key naming it', () => {
    root = project();
    const result = renameField('invoice', 'id', 'number');
    expect(result).toEqual({ type: 'billing::invoice', from: 'id', to: 'number', rewritten: ['line'], publishedIn: [] });
    const invoice = loadTypeSpec('invoice')!;
    expect(invoice.fields.map((f) => f.name)).toEqual(['number', 'total']);
    expect(invoice.fields[0]).toMatchObject({ type: 'string', key: 'primary', previousNames: ['id'] });
    expect(loadTypeSpec('line')!.fields[0].references).toBe('invoice.number');
  });

  it('the design export shows the trace as `formerly`, and only on a renamed field', () => {
    root = project();
    renameField('invoice', 'id', 'number');
    const types = exportDesign().types as Array<{ key: string; fields: Array<{ name: string; formerly?: string[] }> }>;
    const invoice = types.find((t) => t.key.endsWith('invoice'))!;
    expect(invoice.fields.find((f) => f.name === 'number')!.formerly).toEqual(['id']);
    expect(invoice.fields.find((f) => f.name === 'total')!.formerly).toBeUndefined();
  });

  it('refuses, writing nothing: a missing field, a taken name, a retired name, a bad name', () => {
    root = project();
    expect(() => renameField('invoice', 'nope', 'x')).toThrow(/field-missing/);
    expect(() => renameField('invoice', 'id', 'total')).toThrow(/name-taken/);
    expect(() => renameField('invoice', 'id', 'not a name')).toThrow(/invalid-name/);
    expect(() => renameField('nowhere', 'id', 'x')).toThrow(/type-missing/);
    renameField('invoice', 'id', 'number');
    expect(() => renameField('invoice', 'total', 'id')).toThrow(/name-retired/);
    expect(loadTypeSpec('invoice')!.fields.map((f) => f.name)).toEqual(['number', 'total']);
  });
});
