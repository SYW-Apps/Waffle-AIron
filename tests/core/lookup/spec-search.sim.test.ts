import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setProjectRoot } from '../../../src/utils/fs.js';
import { invalidateSpecCache } from '../../../src/core/specs.js';
import { lookupProject } from '../../helpers/lookup-fixture.js';
// The real modules of the component and of each direct dependency: no fakes.
import { find } from '../../../src/core/lookup/spec-search.js';
import { current } from '../../../src/core/lookup/code-model-loader.js';
import * as validatorCore from '../../../src/core/adapters/validator-core.js';

// Integration sim for spec_search: runs the real search against a small real
// spec tree and real code files.
describe('sim: spec_search.find', () => {
  const fixture = lookupProject();
  beforeAll(() => { setProjectRoot(fixture.root); invalidateSpecCache(); });
  afterAll(() => fixture.cleanup());

  it('wires its real dependencies', () => {
    expect(typeof validatorCore.scanAllSpecs).toBe('function');
    expect(typeof current).toBe('function');
  });

  it('ranks an exact id above a partial name', () => {
    const r = find('ledger');
    expect(r.matches[0]).toMatchObject({ id: 'ledger', kind: 'component', evidence: 'id' });
    const later = r.matches.filter((m) => m.evidence === 'text').map((m) => m.id);
    expect(later).toContain('ledger_impl');
    expect(r.matches.findIndex((m) => m.id === 'ledger_impl')).toBeGreaterThan(0);
    expect(r.total).toBeGreaterThanOrEqual(r.matches.length);
  });

  it('finds a method by owner.member and by its endpoint-less name', () => {
    expect(find('ledger.record').matches[0]).toMatchObject({ id: 'ledger.record', kind: 'method', evidence: 'id', briefId: 'ledger' });
    expect(find('placeOrder').matches[0]).toMatchObject({ id: 'orders.placeOrder', evidence: 'id' });
  });

  it('finds the implementation whose sourcePath a code file is, with the declared evidence', () => {
    const r = find('src/orders.ts');
    expect(r.matches[0]).toMatchObject({ id: 'orders_impl', kind: 'implementation', evidence: 'declared', matchedOn: 'sourcePath src/orders.ts', sourcePath: 'src/orders.ts', planned: false });
    expect(r.matches[0].place).toMatchObject({ subsystem: 'shop', component: 'orders' });
    expect(r.matches[0].briefId).toBe('orders');
  });

  it('resolves a code declaration to the spec whose sourcePath holds it', () => {
    const m = find('audit').matches.find((x) => x.id === 'audit_impl' || x.id === 'audit');
    expect(m).toBeDefined();
    const r = find('placeOrder');
    expect(r.matches.some((x) => x.id === 'orders.placeOrder')).toBe(true);
  });

  it('answers an unclaimed file as a file match at syntactic evidence', () => {
    const r = find('src/stray.ts');
    expect(r.matches[0]).toMatchObject({ id: 'src/stray.ts', kind: 'file', evidence: 'syntactic', approval: 'not-applicable' });
    const byDeclaration = find('strayHelper');
    expect(byDeclaration.matches[0]).toMatchObject({ id: 'src/stray.ts', kind: 'file', evidence: 'syntactic' });
  });

  it('marks a sourcePath that does not exist yet as planned', () => {
    const m = find('shipping').matches.find((x) => x.id === 'shipping');
    expect(m).toMatchObject({ planned: true, sourcePath: 'src/shipping.ts' });
    expect(find('src/ledger.ts').matches[0].planned).toBe(false);
  });

  it('reports unlocked with no lock, then approved, then changed after an edit past the lock', () => {
    expect(find('ledger').matches[0].approval).toBe('unlocked');
    fixture.lock();
    invalidateSpecCache();
    expect(find('ledger').matches[0].approval).toBe('approved');
    fixture.addComponent({ id: 'ledger', subsystem: 'shop', methods: [{ name: 'record' }, { name: 'forget' }], sourcePath: 'src/ledger.ts' });
    expect(find('iledger').matches[0]).toMatchObject({ id: 'iledger', approval: 'changed' });
    expect(find('ledger').matches[0].approval).toBe('approved');
    expect(find('orders').matches[0].approval).toBe('approved');
  });

  it('honours the limit and counts every match', () => {
    const r = find('order', 2);
    expect(r.matches).toHaveLength(2);
    expect(r.total).toBeGreaterThan(2);
  });

  it('states what it read and what it did not', () => {
    const { snapshot } = find('ledger');
    expect(snapshot.codeGrade).toBe('exact');
    expect(snapshot.codeFingerprint).toMatch(/^[0-9a-f]{16,}$/);
    expect(Number.isNaN(Date.parse(snapshot.builtAt))).toBe(false);
    expect(snapshot.searched.join(' ')).toContain('source files walked');
    expect(snapshot.notSearched.join(' ')).toContain('prose outside the repository');
  });

  it('answers no matches for nothing', () => {
    const r = find('zzzqqq');
    expect(r.matches).toEqual([]);
    expect(r.total).toBe(0);
  });
});
