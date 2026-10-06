import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  ComponentSpecSchema,
  DESIGN_VIEW_FIELDS,
  ImplementationSpecSchema,
  MethodImplementationSchema,
  TypeMethodSchema,
  TypeSpecSchema,
  componentDesignView,
  implementationDesignView,
  typeDesignView,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The design view (implementation_spec / type_spec / component_spec
// .designView): code linkage leaves the approval. Every schema field of the
// three kinds that carry linkage must be PLACED — in the design, or out of it
// as linkage — so a new field can never slip into (or out of) the approval
// silently. Add a field to a schema and this test fails until the table in
// src/models/specs.ts says which half it belongs to.
// ---------------------------------------------------------------------------

const SCHEMAS: Array<[keyof typeof DESIGN_VIEW_FIELDS, z.AnyZodObject]> = [
  ['implementation', ImplementationSpecSchema],
  ['implementationMethod', MethodImplementationSchema],
  ['type', TypeSpecSchema],
  ['typeMethod', TypeMethodSchema],
  ['component', ComponentSpecSchema],
];

describe('the design view classifies every schema field', () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name}: every field is design or linkage, never both, never neither`, () => {
      const fields = Object.keys(schema.shape).sort();
      const { linkage, design } = DESIGN_VIEW_FIELDS[name];
      const placed = [...linkage, ...design];
      expect(new Set(placed).size, `${name} places a field twice`).toBe(placed.length);
      expect([...placed].sort(), `${name}: a schema field is unplaced (or the table names one the schema lacks)`).toEqual(fields);
    });
  }
});

const now = '2026-10-06T10:00:00.000Z';

describe('the projections drop exactly the linkage', () => {
  it('an implementation keeps its design and loses sourcePath, simPath, router, injectedParams, tiers, symbols and timestamps', () => {
    const impl = {
      id: 'x_impl', name: 'X', description: 'd', contract: 'ix', status: 'complete',
      sourcePath: 'src/x.ts', simPath: 'tests/sim/x.ts', router: 'handleX', injectedParams: ['config'], conformance: 'anchored',
      technologies: ['postgres'], detail: 'full', previousIds: ['old_impl'], lint: { allow: [] }, ext: { 'a:b': 1 },
      methods: [{
        name: 'run', narrative: [{ stepNumber: 1, description: 'go', type: 'local' }], intent: 'i',
        sourcePath: 'src/run.ts', symbol: 'runIt', exportedVia: 'xRule', conformance: 'off', ext: { 'a:c': 2 },
      }],
      createdAt: now, updatedAt: now,
    };
    expect(implementationDesignView(impl)).toEqual({
      id: 'x_impl', name: 'X', description: 'd', contract: 'ix', status: 'complete',
      technologies: ['postgres'], detail: 'full', previousIds: ['old_impl'], lint: { allow: [] }, ext: { 'a:b': 1 },
      methods: [{ name: 'run', narrative: [{ stepNumber: 1, description: 'go', type: 'local' }], intent: 'i', ext: { 'a:c': 2 } }],
    });
    // Pure: the spec itself is untouched.
    expect(impl.sourcePath).toBe('src/x.ts');
    expect(impl.methods[0].symbol).toBe('runIt');
  });

  it('a type loses its sourcePath and symbol (its own and each method\'s), nothing else', () => {
    const type = {
      kind: 'entity', id: 't', name: 'T', sourcePath: 'src/t.ts', symbol: 'TT', fields: [{ name: 'a', type: 'string', optional: false }],
      methods: [{ name: 'm', signature: 'm(): bool', returns: 'bool', sourcePath: 'src/m.ts', symbol: 'tM' }],
      createdAt: now, updatedAt: now,
    };
    expect(typeDesignView(type)).toEqual({
      kind: 'entity', id: 't', name: 'T', fields: [{ name: 'a', type: 'string', optional: false }],
      methods: [{ name: 'm', signature: 'm(): bool', returns: 'bool' }],
    });
  });

  it('a component loses each mount\'s via and its externalLinks, keeping portal and prefixes', () => {
    const component = {
      id: 'web', name: 'Web', description: 'd', subsystem: 's', componentType: 'Portal', owns: [], dependsOn: [],
      transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers', scope: 'outside' },
      mounts: [{ portal: 'api', prefixes: ['/api'], via: 'apiRouter' }],
      externalLinks: [{ type: 'implementation', url: 'https://example.com' }],
      createdAt: now, updatedAt: now,
    };
    expect(componentDesignView(component)).toEqual({
      id: 'web', name: 'Web', description: 'd', subsystem: 's', componentType: 'Portal', owns: [], dependsOn: [],
      transport: 'HTTP', invokedBy: { kind: 'entry', caller: 'Browsers', scope: 'outside' },
      mounts: [{ portal: 'api', prefixes: ['/api'] }],
    });
  });

  it('reads a malformed stored spec without throwing (absent or non-array methods pass through)', () => {
    expect(implementationDesignView({ id: 'a', methods: 'nope', sourcePath: 'x' })).toEqual({ id: 'a', methods: 'nope' });
    expect(typeDesignView({ id: 'b' })).toEqual({ id: 'b' });
  });
});
