import { describe, it, expect } from 'vitest';
import { specIndexRetiredBy, type SpecIndex } from '../../src/core/specs.js';
import { DESIGN_APPROVALS, DesignApprovalSchema } from '../../src/models/design-export.js';
import { ComponentSpecSchema, InterfaceSpecSchema, TypeSpecSchema } from '../../src/models/specs.js';

// spec_index.retiredBy — the holder whose rename trace lists an id. The writer
// and the rename tools ask it before giving an id to a new spec (id-retired).

const now = new Date().toISOString();

function index(parts: Partial<SpecIndex>): SpecIndex {
  return {
    subsystems: [], components: [], interfaces: [], implementations: [], types: [], groups: [],
    paths: { subsystem: {}, component: {}, interface: {}, implementation: {}, type: {}, group: {} },
    signatures: { sources: [], staleTexts: [] },
    typeSpellings: { aliases: [], invalid: [] },
    ...parts,
  } as unknown as SpecIndex;
}

const component = (id: string, previousIds?: string[]): any => ({
  id, name: id, description: 'd', subsystem: 'core', componentType: 'Orchestrator', owns: [], dependsOn: [],
  ...(previousIds ? { previousIds } : {}), status: 'complete', createdAt: now, updatedAt: now,
});

describe('spec_index.retiredBy', () => {
  it('names the component whose trace lists the id, and nothing for an id never held', () => {
    const idx = index({ components: [component('ledger', ['books', 'journal']), component('clock')] });
    expect(specIndexRetiredBy(idx, 'component', 'books')).toBe('ledger');
    expect(specIndexRetiredBy(idx, 'component', 'journal')).toBe('ledger');
    expect(specIndexRetiredBy(idx, 'component', 'ledger')).toBeUndefined();
    expect(specIndexRetiredBy(idx, 'component', 'ticker')).toBeUndefined();
  });

  it('answers only within the kind asked about', () => {
    const idx = index({
      components: [component('ledger', ['books'])],
      interfaces: [{ id: 'iledger', component: 'ledger', previousIds: ['ibooks'], methods: [] } as any],
      implementations: [{ id: 'ledger_impl', contract: 'iledger', previousIds: ['books_impl'], methods: [] } as any],
    });
    expect(specIndexRetiredBy(idx, 'interface', 'ibooks')).toBe('iledger');
    expect(specIndexRetiredBy(idx, 'implementation', 'books_impl')).toBe('ledger_impl');
    expect(specIndexRetiredBy(idx, 'interface', 'books')).toBeUndefined();
    expect(specIndexRetiredBy(idx, 'subsystem', 'books')).toBeUndefined();
  });

  it('matches a type within its owner: qualified for a subsystem-owned type, bare for a system-level one', () => {
    const idx = index({
      types: [
        { kind: 'entity', id: 'invoice', name: 'Invoice', subsystem: 'billing', fields: [], methods: [], previousIds: ['bill'] } as any,
        { kind: 'value-object', id: 'money', name: 'Money', fields: [], methods: [], previousIds: ['amount'] } as any,
      ],
    });
    expect(specIndexRetiredBy(idx, 'type', 'billing::bill')).toBe('billing::invoice');
    expect(specIndexRetiredBy(idx, 'type', 'shipping::bill')).toBeUndefined();
    expect(specIndexRetiredBy(idx, 'type', 'bill')).toBeUndefined();
    expect(specIndexRetiredBy(idx, 'type', 'amount')).toBe('money');
  });

  it("reads a member's bare trace entry in the member's own namespace", () => {
    const idx = index({ components: [component('pay::ledger', ['books'])] });
    expect(specIndexRetiredBy(idx, 'component', 'pay::books')).toBe('pay::ledger');
    expect(specIndexRetiredBy(idx, 'component', 'books')).toBeUndefined();
  });
});

describe('the rename trace fields', () => {
  it('parse on component, interface (spec and method) and type specs, and stay optional', () => {
    const c = ComponentSpecSchema.parse(component('ledger', ['books']));
    expect(c.previousIds).toEqual(['books']);
    expect(ComponentSpecSchema.parse(component('clock')).previousIds).toBeUndefined();
    const i = InterfaceSpecSchema.parse({
      id: 'iledger', name: 'ILedger', description: 'd', component: 'ledger', previousIds: ['ibooks'],
      methods: [{ name: 'post', description: 'd', signature: 'post(): void', returns: 'void', previousNames: ['ibooks.record'] }],
      createdAt: now, updatedAt: now,
    });
    expect(i.previousIds).toEqual(['ibooks']);
    expect(i.methods[0].previousNames).toEqual(['ibooks.record']);
    const t = TypeSpecSchema.parse({ kind: 'value-object', id: 'money', name: 'Money', previousIds: ['amount'], createdAt: now, updatedAt: now });
    expect(t.previousIds).toEqual(['amount']);
  });

  it('refuses an empty trace entry', () => {
    expect(() => ComponentSpecSchema.parse(component('ledger', ['']))).toThrow();
  });
});

describe('design_approval', () => {
  it('is the closed set locked | stale | unlocked | unjudged, in declared order', () => {
    expect([...DESIGN_APPROVALS]).toEqual(['locked', 'stale', 'unlocked', 'unjudged']);
    expect(DesignApprovalSchema.parse('stale')).toBe('stale');
    expect(() => DesignApprovalSchema.parse('no-tree')).toThrow();
  });
});
