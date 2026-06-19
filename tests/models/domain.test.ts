import { describe, it, expect } from 'vitest';
import { DomainSchema, TopologyConfigSchema, createEmptyTopologyConfig } from '../../src/models/domain.js';

describe('DomainSchema', () => {
  it('parses a free-standing domain', () => {
    const raw = {
      id: 'docs',
      name: 'Documentation',
      ownedPaths: ['docs/**', 'README.md'],
    };
    const result = DomainSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('docs');
      expect(result.data.boundTo).toBeUndefined();
      expect(result.data.ownedPaths).toEqual(['docs/**', 'README.md']);
    }
  });

  it('parses a spec-backed domain with boundTo', () => {
    const raw = { id: 'billing', boundTo: 'billing', ownedPaths: ['.wai/specs/billing/**'] };
    const result = DomainSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.boundTo).toBe('billing');
  });

  it('defaults ownedPaths to an empty array', () => {
    const result = DomainSchema.safeParse({ id: 'infra' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ownedPaths).toEqual([]);
  });

  it('rejects an invalid id', () => {
    expect(DomainSchema.safeParse({ id: 'Docs Domain' }).success).toBe(false);
  });
});

describe('TopologyConfigSchema', () => {
  it('parses a config with free-standing domains', () => {
    const raw = { schemaVersion: '1.0.0', domains: [{ id: 'docs', ownedPaths: ['docs/**'] }] };
    const result = TopologyConfigSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.domains).toHaveLength(1);
  });

  it('createEmptyTopologyConfig produces a valid empty config', () => {
    const cfg = createEmptyTopologyConfig();
    expect(cfg.domains).toHaveLength(0);
    expect(cfg.schemaVersion).toBe('1.0.0');
  });
});
