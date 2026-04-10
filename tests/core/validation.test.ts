import { describe, it, expect } from 'vitest';
import { validateRegistry, validateProjectConfig } from '../../src/core/validation.js';
import { createEmptyRegistry } from '../../src/models/registry.js';
import { createAgentRecord } from '../../src/models/agent.js';
import { RulesConfig } from '../../src/models/project.js';

const defaultRules: RulesConfig = {
  noOverlappingOwnership: true,
  requireOwnedPaths: true,
  metaAgentTags: ['meta', 'guardian', 'architect'],
  enforceReproducibility: true,
};

describe('validateRegistry', () => {
  it('passes for an empty registry', () => {
    const registry = createEmptyRegistry();
    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects duplicate agent ids', () => {
    const registry = createEmptyRegistry();
    const agent = createAgentRecord({
      id: 'my-agent',
      name: 'My Agent',
      template: 'domain-owner',
      creationReason: 'test',
      ownedPaths: ['src/**'],
    });
    registry.agents.push(agent, { ...agent });

    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'DUPLICATE_AGENT_ID')).toBe(true);
  });

  it('warns when a non-meta agent has no ownedPaths', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'orphan-agent',
        name: 'Orphan',
        template: 'implementer',
        creationReason: 'test',
        ownedPaths: [],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.issues.some((i) => i.code === 'NO_OWNED_PATHS')).toBe(true);
  });

  it('does not warn about missing ownedPaths for meta-tagged agents', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'my-architect',
        name: 'Architect',
        template: 'architect',
        creationReason: 'test',
        ownedPaths: [],
        tags: ['meta', 'architect'],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.issues.filter((i) => i.code === 'NO_OWNED_PATHS')).toHaveLength(0);
  });

  it('detects overlapping ownedPaths', () => {
    const registry = createEmptyRegistry();
    registry.agents.push(
      createAgentRecord({
        id: 'agent-a',
        name: 'Agent A',
        template: 'domain-owner',
        creationReason: 'test',
        ownedPaths: ['services/core/**'],
      }),
      createAgentRecord({
        id: 'agent-b',
        name: 'Agent B',
        template: 'domain-owner',
        creationReason: 'test',
        ownedPaths: ['services/core/**'],
      }),
    );

    const result = validateRegistry(registry, defaultRules);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'OVERLAPPING_OWNERSHIP')).toBe(true);
  });
});

describe('validateProjectConfig', () => {
  it('fails when no targets are configured', () => {
    const config = {
      schemaVersion: '1.0.0',
      name: 'test',
      targets: [],
      rules: defaultRules,
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = validateProjectConfig(config);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.code === 'NO_TARGETS')).toBe(true);
  });

  it('passes when a valid target is configured', () => {
    const config = {
      schemaVersion: '1.0.0',
      name: 'test',
      targets: [{ type: 'claude' as const, outputDir: '.claude/agents', enabled: true }],
      rules: defaultRules,
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = validateProjectConfig(config);
    expect(result.valid).toBe(true);
  });
});
