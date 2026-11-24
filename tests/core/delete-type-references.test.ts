import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setProjectRoot } from '../../src/utils/fs.js';
import { saveSpec, saveTypeSpec, saveComponentSpec, saveInterfaceSpec, invalidateSpecCache } from '../../src/core/specs.js';
import { deleteSpec } from '../../src/core/authoring.js';

// A deletion refuses only for the references that RESOLVE to the deleted type: two types sharing a
// display name are told apart by the resolution the loader and the validator use.
const now = '2026-11-23T10:00:00.000Z';
let root = '';

afterEach(() => {
  setProjectRoot(null);
  invalidateSpecCache();
  try { if (root) fs.rmSync(root, { recursive: true, force: true }); } catch { /* win locks */ }
});

function project(): void {
  invalidateSpecCache();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wairon-delete-type-')));
  fs.mkdirSync(path.join(root, '.wai', 'specs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.wai', 'project.yaml'), JSON.stringify({ schemaVersion: '1.0.0', name: 'notes', targets: [], rules: {}, createdAt: now, updatedAt: now }));
  setProjectRoot(root);
  saveSpec('subsystem', { id: 'core', name: 'core', description: 'd', parentSystem: 'notes', publicInterfaces: [], trustedLinks: [], createdAt: now, updatedAt: now } as never);
  for (const id of ['note-ref-lab', 'note_ref']) {
    saveTypeSpec({ kind: 'value-object', id, name: 'NoteRef', description: 'd', subsystem: 'core', fields: [], methods: [], createdAt: now, updatedAt: now } as never);
  }
  saveComponentSpec({ id: 'notes', name: 'notes', description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [], createdAt: now, updatedAt: now } as never);
  saveInterfaceSpec({
    id: 'inotes', name: 'inotes', description: 'c', component: 'notes', createdAt: now, updatedAt: now,
    methods: [{ name: 'open', description: 'Opens.', signature: 'open(ref: NoteRef): void', returns: 'void', params: [{ name: 'ref', type: 'NoteRef', description: 'the note' }] }],
  } as never);
  invalidateSpecCache();
}

describe('deleting a type whose display name another type shares', () => {
  it('is not refused for references that bind to the other type', () => {
    project();
    const plan = deleteSpec('type', 'note-ref-lab', true);
    expect(plan.references).toEqual([]);
    const done = deleteSpec('type', 'note-ref-lab');
    expect(done.deleted).toBe(true);
  });

  it('is refused for the references that resolve to the deleted type', () => {
    project();
    expect(deleteSpec('type', 'note_ref', true).references.map((r) => r.id)).toEqual(['inotes']);
    expect(() => deleteSpec('type', 'note_ref')).toThrow(/Refusing to delete type "note_ref"/);
  });
});
