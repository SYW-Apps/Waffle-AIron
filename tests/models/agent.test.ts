import { describe, it, expect } from 'vitest';
import { AgentRecordSchema, createAgentRecord } from '../../src/models/agent.js';

describe('AgentRecordSchema', () => {
  it('parses a valid agent record', () => {
    const raw = {
      id: 'core-service-owner',
      name: 'Core Service Owner',
      description: 'Owns the core service.',
      template: 'domain-owner',
      ownedPaths: ['services/core/**'],
      readPaths: [],
      writePaths: [],
      tags: ['service', 'owner'],
      dependencies: [],
      creationReason: 'Distinct service boundary.',
      status: 'active',
      targets: ['claude'],
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = AgentRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('core-service-owner');
      expect(result.data.status).toBe('active');
      expect(result.data.targets).toEqual(['claude']);
    }
  });

  it('rejects an id with uppercase characters', () => {
    const raw = {
      id: 'Core-Service',
      name: 'x',
      description: 'x',
      template: 'domain-owner',
      creationReason: 'x',
      status: 'active',
      targets: ['claude'],
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = AgentRecordSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('rejects an invalid status', () => {
    const raw = {
      id: 'my-agent',
      name: 'x',
      description: 'x',
      template: 'domain-owner',
      creationReason: 'x',
      status: 'unknown',
      targets: ['claude'],
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = AgentRecordSchema.safeParse(raw);
    expect(result.success).toBe(false);
  });

  it('defaults arrays to empty when omitted', () => {
    const raw = {
      id: 'my-agent',
      name: 'My Agent',
      description: 'x',
      template: 'domain-owner',
      creationReason: 'x',
      createdAt: '2026-04-10T12:00:00.000Z',
      updatedAt: '2026-04-10T12:00:00.000Z',
    };

    const result = AgentRecordSchema.safeParse(raw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ownedPaths).toEqual([]);
      expect(result.data.tags).toEqual([]);
      expect(result.data.targets).toEqual(['claude']);
    }
  });
});

describe('createAgentRecord', () => {
  it('creates a valid record with required fields only', () => {
    const agent = createAgentRecord({
      id: 'test-agent',
      name: 'Test Agent',
      template: 'domain-owner',
      creationReason: 'Testing',
    });

    expect(agent.id).toBe('test-agent');
    expect(agent.status).toBe('active');
    expect(agent.ownedPaths).toEqual([]);
    expect(agent.createdAt).toBeTruthy();
  });
});
