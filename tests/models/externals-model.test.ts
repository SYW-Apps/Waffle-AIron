import { describe, it, expect } from 'vitest';
import {
  declaredExternals,
  contentDigest,
  memberDigest,
  ProjectConfigSchema,
  SurfaceSnapshotSchema,
  type SurfaceSnapshot,
} from '../../src/models/index.js';

// ---------------------------------------------------------------------------
// The stage-2b model behaviour: project_config.declaredExternals and the two
// snapshot digests a lock is built from.
// ---------------------------------------------------------------------------

const TS = '2026-01-01T00:00:00.000Z';

describe('project_config.declaredExternals', () => {
  it('normalizes each alias in declaration order, defaulting the producer id to the alias', () => {
    const config = ProjectConfigSchema.parse({
      name: 'FleetWorks', createdAt: TS, updatedAt: TS,
      externals: { billing: {}, crm: { project: 'crm' }, ledger: { project: 'acme.ledger', source: { path: '../ledger' } } },
    });
    expect(declaredExternals(config)).toEqual([
      { alias: 'billing', project: 'billing' },
      { alias: 'crm', project: 'crm' },
      { alias: 'ledger', project: 'acme.ledger', sourcePath: '../ledger' },
    ]);
  });

  it('records a malformed alias or producer id as the entry\'s problem rather than dropping it', () => {
    const [dotted, broken] = declaredExternals({ externals: { 'acme.ledger': {}, crm: { project: 'CRM!' } } });
    expect(dotted.problem).toMatch(/dotted producer id needs an explicit alias/);
    expect(broken.problem).toMatch(/breaks the project-id grammar/);
    expect(declaredExternals({})).toEqual([]);
  });
});

function snapshot(returns: string, paramName = 'routeId'): SurfaceSnapshot {
  return SurfaceSnapshotSchema.parse({
    projectName: 'BillingService', origin: 'generated', stateId: 'sha256:x', generatedAt: TS,
    interfaces: [{
      id: 'invoicing', name: 'Invoice Portal', component: 'invoice-portal',
      methods: [
        { name: 'issueInvoice', description: 'd', signature: `issueInvoice(${paramName}: string): ${returns}`, returns, params: [{ name: paramName, type: 'string' }] },
        { name: 'voidInvoice', description: 'd', signature: 'voidInvoice(id: string): void', returns: 'void', params: [{ name: 'id', type: 'string' }] },
      ],
    }],
    types: [{ id: 'receipt', name: 'Receipt', kind: 'value-object', fields: [{ name: 'total', type: 'number' }] }],
    exportedTypes: [{ id: 'receipt', type: 'receipt' }],
  });
}

describe('surface_snapshot digests', () => {
  it('contentDigest ignores provenance', () => {
    const a = snapshot('string');
    expect(contentDigest({ ...a, stateId: 'sha256:y', generatedAt: '2027-01-01T00:00:00.000Z', origin: 'exchanged' })).toBe(contentDigest(a));
  });

  it('memberDigest moves with the types a caller depends on, never with a parameter name or another member', () => {
    const base = memberDigest(snapshot('string'), 'invoicing', 'issueInvoice');
    expect(base).toMatch(/^sha256:/);
    expect(memberDigest(snapshot('string', 'id'), 'invoicing', 'issueInvoice')).toBe(base);
    expect(memberDigest(snapshot('number'), 'invoicing', 'issueInvoice')).not.toBe(base);
    expect(memberDigest(snapshot('string'), 'invoicing', 'noSuchMethod')).toBeNull();
    expect(memberDigest(snapshot('string'), 'no-such-name', 'issueInvoice')).toBeNull();
    expect(memberDigest(snapshot('string'), 'receipt', 'type')).toMatch(/^sha256:/);
  });
});
