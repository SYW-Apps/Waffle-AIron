import { describe, it, expect } from 'vitest';
import { PROJECT_ID_RE, effectiveProjectId, projectIdentity } from '../../src/models/project.js';

// ---------------------------------------------------------------------------
// project_config identity (stage 2a): effectiveId() and identity(lockedId?) —
// pure behaviour of the configuration. The default is the display name
// slugified, with no invented fallback; the problems name what the
// project-identity rule reports.
// ---------------------------------------------------------------------------

describe('project_config.effectiveId', () => {
  it('answers a declared id as written', () => {
    expect(effectiveProjectId({ id: 'billing-core', name: 'Billing Platform' })).toBe('billing-core');
    expect(effectiveProjectId({ id: 'Billing_Core', name: 'Billing Platform' })).toBe('Billing_Core');
  });

  it('slugifies the name: lower-cased, runs outside the grammar collapsed to one dash, trimmed to alphanumerics', () => {
    expect(effectiveProjectId({ name: 'Waffle-AIron' })).toBe('waffle-airon');
    expect(effectiveProjectId({ name: '  Billing   Platform (EU)! ' })).toBe('billing-platform-eu');
    expect(effectiveProjectId({ name: 'acme.ledger_v2' })).toBe('acme.ledger_v2');
    expect(effectiveProjectId({ name: '--ledger--' })).toBe('ledger');
  });

  it('never invents a fallback when the name yields nothing', () => {
    expect(effectiveProjectId({ name: '請求' })).toBeNull();
    expect(effectiveProjectId({ name: '' })).toBeNull();
  });

  it('keeps every slug it makes inside the grammar', () => {
    for (const name of ['Waffle-AIron', 'a', 'x.y', 'Q3 Planning — Draft', '_leading', 'trailing.']) {
      const id = effectiveProjectId({ name });
      if (id !== null) expect(id).toMatch(PROJECT_ID_RE);
    }
  });
});

describe('project_config.identity', () => {
  it('a declared, well-formed id with no lock has no problems', () => {
    expect(projectIdentity({ id: 'billing-core', name: 'Billing' })).toEqual({
      id: 'billing-core', source: 'declared', name: 'Billing', problems: [],
    });
  });

  it('a missing id is defaulted from the name', () => {
    const identity = projectIdentity({ name: 'Billing Platform' });
    expect(identity.source).toBe('defaulted');
    expect(identity.id).toBe('billing-platform');
    expect(identity.problems.map((p) => p.kind)).toEqual(['defaulted']);
  });

  it('a name that yields no id is ambiguous, and the identity carries no id', () => {
    const identity = projectIdentity({ name: '請求' });
    expect(identity.source).toBe('none');
    expect(identity).not.toHaveProperty('id');
    expect(identity.problems.map((p) => p.kind)).toEqual(['ambiguous']);
  });

  it('a declared id that breaks the grammar is ambiguous', () => {
    for (const id of ['Billing', 'billing-', '.billing', 'bill ing', 'billing/core', '']) {
      expect(projectIdentity({ id, name: 'Billing' }).problems.map((p) => p.kind)).toEqual(['ambiguous']);
    }
  });

  it('an id that differs from the locked one has changed; the same id has not', () => {
    expect(projectIdentity({ id: 'billing-core', name: 'B' }, 'billing-platform').problems.map((p) => p.kind)).toEqual(['changed']);
    expect(projectIdentity({ id: 'billing-platform', name: 'B' }, 'billing-platform').problems).toEqual([]);
  });

  it('a defaulted id that moved with a rename is both defaulted and changed', () => {
    const identity = projectIdentity({ name: 'Invoicing Hub' }, 'billing-platform');
    expect(identity.lockedId).toBe('billing-platform');
    expect(identity.problems.map((p) => p.kind)).toEqual(['defaulted', 'changed']);
  });

  it('losing the id altogether after a lock is a change too', () => {
    expect(projectIdentity({ name: '請求' }, 'billing').problems.map((p) => p.kind)).toEqual(['ambiguous', 'changed']);
  });
});
