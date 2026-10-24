import { describe, it, expect } from 'vitest';
import { surfaceChanges, SurfaceSnapshotSchema, type SurfaceSnapshot } from '../../src/models/index.js';

// surface_snapshot.changesSince: an exported type whose fields keep their names
// and shapes but are declared in another order is a `changed` row (a consumer
// that encodes by position must follow) — only when nothing else moved.

const NOW = '2026-10-09T10:00:00.000Z';
const ROW = 'field order changed; a consumer that encodes by position must follow';

type Field = { name: string; type: string; formerly?: string[] };

const snap = (fields: Field[], over: { typeFormerly?: string[]; id?: string } = {}): SurfaceSnapshot => SurfaceSnapshotSchema.parse({
  projectName: 'p', origin: 'generated', generatedAt: NOW, interfaces: [],
  types: [{ id: over.id ?? 'row', name: 'Row', kind: 'value-object', fields, ...(over.typeFormerly ? { formerly: over.typeFormerly } : {}) }],
  exportedTypes: [{ id: over.id ?? 'row', type: over.id ?? 'row', audience: 'project' }],
});

const A = { name: 'a', type: 'string' };
const B = { name: 'b', type: 'int' };
const C = { name: 'c', type: 'string' };

describe('surface diff: field order', () => {
  it('fire: the same fields declared in another order is one changed row', () => {
    expect(surfaceChanges(snap([B, A, C]), snap([A, B, C]))).toEqual([{ kind: 'changed', name: 'row', detail: ROW }]);
  });

  it('control: the same order is no change', () => {
    expect(surfaceChanges(snap([A, B, C]), snap([A, B, C]))).toEqual([]);
  });

  it('control: a field renamed in the same place is its rename, not a reorder', () => {
    const rows = surfaceChanges(snap([A, { name: 'bee', type: 'int', formerly: ['b'] }, C]), snap([A, B, C]));
    expect(rows).toEqual([{ kind: 'renamed', name: 'row', member: 'bee', from: 'b', detail: 'field "b" renamed to "bee"' }]);
  });

  it('control: a rename together with a reorder says the rename only (the reorder row is the only row)', () => {
    const rows = surfaceChanges(snap([C, { name: 'bee', type: 'int', formerly: ['b'] }, A]), snap([A, B, C]));
    expect(rows.map((r) => r.detail)).toEqual(['field "b" renamed to "bee"']);
  });

  it('control: a shape change with a reorder is the shape row alone', () => {
    const rows = surfaceChanges(snap([{ name: 'b', type: 'string' }, A, C]), snap([A, B, C]));
    expect(rows).toEqual([{ kind: 'changed', name: 'row', detail: 'type shape changed (fields, values, held primitive or a type it names)' }]);
  });

  it('control: an added field is a shape change, never a reorder', () => {
    const rows = surfaceChanges(snap([B, A, C, { name: 'd', type: 'int' }]), snap([A, B, C]));
    expect(rows.map((r) => r.detail)).not.toContain(ROW);
  });
});
