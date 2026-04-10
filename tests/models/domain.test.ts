import { describe, it, expect } from 'vitest';
import { DomainSchema, createEmptyDomainRegistry } from '../../src/models/domain.js';

describe('DomainSchema', () => {
  it('parses a valid domain', () => {
    const raw = {
      id: 'core-service',
      name: 'Core Service',
      path: 'services/core',
      type: 'git-submodule',
      parent: 'root',
      propagation: 'flat',
      status: 'active',
      addedAt: '2026-04-10T12:00:00.000Z',
    };
    const result = DomainSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('core-service');
      expect(result.data.propagation).toBe('flat');
    }
  });

  it('rejects invalid id', () => {
    const raw = {
      id: 'Core Service',
      name: 'x',
      path: 'services/core',
      type: 'manual',
      addedAt: '2026-04-10T12:00:00.000Z',
    };
    expect(DomainSchema.safeParse(raw).success).toBe(false);
  });

  it('defaults propagation to flat', () => {
    const raw = {
      id: 'my-domain',
      name: 'My Domain',
      path: 'packages/my',
      type: 'package-root',
      addedAt: '2026-04-10T12:00:00.000Z',
    };
    const result = DomainSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.propagation).toBe('flat');
  });
});

describe('createEmptyDomainRegistry', () => {
  it('creates a valid empty registry', () => {
    const reg = createEmptyDomainRegistry();
    expect(reg.domains).toHaveLength(0);
    expect(reg.schemaVersion).toBe('1.0.0');
  });
});
